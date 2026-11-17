'use strict';

// Autentisering och CSRF för bokningsportalen.
//
// Produktion: App Service Authentication (Easy Auth) sätter
// X-MS-CLIENT-PRINCIPAL efter Entra ID-inloggning. Portalen litar bara på
// denna header när Easy Auth uttryckligen är verifierad och tvingande.
// App Service tar bort klientens egna X-MS-*-rubriker innan appen nås.
// Ingen egen lösenordsdatabas finns.
//
// Lokal demo: --dev-auth ger en syntetisk Owner. Detta är uttryckligen
// förbjudet när NODE_ENV=production.

const crypto = require('node:crypto');

const ADMIN_ROLES = new Set(['Owner', 'Staff']);
const ROLE_CLAIMS = new Set([
  'roles',
  'role',
  'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'
]);

function easyAuthEnforced(options = {}) {
  if (typeof options.trustEasyAuth === 'boolean') return options.trustEasyAuth;
  const explicitTrust = process.env.ADMIN_TRUST_EASY_AUTH === '1';
  const platformAuth = String(process.env.WEBSITE_AUTH_ENABLED).toLowerCase() === 'true';
  const provider = String(process.env.WEBSITE_AUTH_DEFAULT_PROVIDER || '').toLowerCase();
  const providerOk = provider === 'azureactivedirectory' || provider === 'aad';
  return explicitTrust && platformAuth && providerOk;
}

class AuthError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.redirect = options.redirect;
  }
}

function asRoleList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

function decodeClientPrincipal(req) {
  const header = req.headers['x-ms-client-principal'];
  if (!header || typeof header !== 'string') return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const claims = Array.isArray(decoded.claims) ? decoded.claims : [];
  const claimValues = (names) => claims
    .filter((claim) => names.includes(claim.typ))
    .flatMap((claim) => asRoleList(claim.val));
  const roles = [
    ...asRoleList(decoded.roles),
    ...asRoleList(decoded.userRoles),
    ...claimValues([...ROLE_CLAIMS])
  ];
  const id = claimValues(['oid', 'http://schemas.microsoft.com/identity/claims/objectidentifier'])[0] ||
    decoded.userId || decoded.sub || '';
  const name = decoded.name ||
    claimValues(['name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'])[0] ||
    decoded.userDetails || '';
  const email = claimValues([
    'preferred_username',
    'email',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
  ])[0] || decoded.userDetails || '';
  if (!id && !name) return null;
  return {
    id: id || email || name,
    name: name || email || 'Administratör',
    email,
    roles: [...new Set(roles)],
    isDemo: false
  };
}

function createAuth(options = {}) {
  const demo = options.demo === true;
  if (demo && process.env.NODE_ENV === 'production') {
    throw new Error('Demoauth får aldrig användas i produktion');
  }
  const trustEasyAuth = !demo && easyAuthEnforced(options);
  if (!demo && !trustEasyAuth) {
    throw new Error(
      'Easy Auth är inte verifierad. Aktivera App Service Authentication, ' +
      'sätt ADMIN_TRUST_EASY_AUTH=1 och starta om appen.'
    );
  }
  const demoPrincipal = Object.freeze({
    id: 'demo-owner',
    name: 'Anna Skadevi (demo)',
    email: 'demo@skadevi.local',
    roles: ['Owner'],
    isDemo: true
  });
  const csrfTokens = new Map();

  function principalFor(req) {
    if (demo) return demoPrincipal;
    if (!trustEasyAuth) return null;
    return decodeClientPrincipal(req);
  }

  function requirePrincipal(req, context = {}) {
    const principal = principalFor(req);
    if (!principal) {
      if (context.api) throw new AuthError(401, 'Autentisering krävs.');
      const target = context.returnTo || '/admin';
      throw new AuthError(302, 'Inloggning krävs.', {
        redirect: `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(target)}`
      });
    }
    if (!principal.roles.some((role) => ADMIN_ROLES.has(role))) {
      throw new AuthError(403, 'Du har inte behörighet till bokningsportalen.');
    }
    return principal;
  }

  function requireRole(principal, role) {
    if (!principal?.roles?.includes(role)) {
      throw new AuthError(403, 'Åtgärden kräver ägarbehörighet.');
    }
    return principal;
  }

  function getCsrfToken(principal) {
    if (!principal?.id) throw new AuthError(401, 'Autentisering krävs.');
    if (!csrfTokens.has(principal.id)) {
      csrfTokens.set(principal.id, crypto.randomBytes(32).toString('hex'));
    }
    return csrfTokens.get(principal.id);
  }

  function verifyCsrf(req, principal) {
    const provided = req.headers['x-csrf-token'];
    const expected = getCsrfToken(principal);
    if (typeof provided !== 'string' || provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  }

  return {
    demo,
    trustEasyAuth,
    principalFor,
    requirePrincipal,
    requireRole,
    getCsrfToken,
    verifyCsrf,
    writesEnabled: options.writesEnabled ?? process.env.ADMIN_WRITES_ENABLED === '1'
  };
}

module.exports = {
  createAuth,
  decodeClientPrincipal,
  easyAuthEnforced,
  AuthError,
  ADMIN_ROLES
};
