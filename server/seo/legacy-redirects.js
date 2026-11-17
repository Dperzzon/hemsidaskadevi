'use strict';

// Gamla Wix-adresser från den tidigare webbplatsen. Listan bygger på den
// dokumenterade URL-mappningen i docs/archive/strategy-audit.md samt de
// adresser som efterfrågats i SEO-arbetet (historia, event, firande, team-4).
//
// 301 används när det finns en verklig ersättningssida. Okända Wix-malladresser
// (/service-page/..., /product-page/...) svarar 410 Gone i stället för att
// skickas till startsidan, så att de inte skapar dubbletter eller felaktiga
// signaler i Google.

const LEGACY_REDIRECTS = new Map([
  ['/about-1', '/brollop'],
  ['/team-4', '/aktiviteter'],
  ['/services-7', '/vanliga-fragor'],
  ['/dopochbabyshower', '/fest'],
  ['/copy-of-dop-babyshower', '/fest'],
  ['/firande', '/fest'],
  ['/event', '/fest'],
  ['/historia', '/om-oss'],
  ['/faciliteter', '/boende'],
  ['/matochdryck', '/mat-dryck'],
  ['/the-suite', '/boende'],
  ['/kopia-på-hem', '/'],
  ['/kopia-på-utrustning-service', '/digital-visning']
]);

// Wix-templatestrukturer utan känd motsvarighet. Slugs som innehåller ett
// igenkännbart ämne mappas till rätt sida; övriga svarar 410.
const LEGACY_TEMPLATE_PREFIXES = ['/service-page', '/product-page'];

const LEGACY_KEYWORDS = [
  ['brollop', '/brollop'],
  ['bröllop', '/brollop'],
  ['wedding', '/brollop'],
  ['brud', '/brollop'],
  ['konferens', '/foretag'],
  ['foretag', '/foretag'],
  ['kickoff', '/foretag'],
  ['ledningsgrupp', '/foretag'],
  ['mote', '/foretag'],
  ['möte', '/foretag'],
  ['fest', '/fest'],
  ['firande', '/fest'],
  ['mohippa', '/fest'],
  ['möhippa', '/fest'],
  ['svensexa', '/fest'],
  ['dop', '/fest'],
  ['jubileum', '/fest'],
  ['event', '/fest'],
  ['boende', '/boende'],
  ['sovrum', '/boende'],
  ['rum', '/boende'],
  ['mat', '/mat-dryck'],
  ['dryck', '/mat-dryck'],
  ['catering', '/mat-dryck'],
  ['aktivitet', '/aktiviteter'],
  ['tennis', '/aktiviteter'],
  ['pris', '/priser'],
  ['kontakt', '/boka'],
  ['boka', '/boka'],
  ['bokning', '/boka'],
  ['historia', '/om-oss'],
  ['om-oss', '/om-oss'],
  ['faq', '/vanliga-fragor'],
  ['fragor', '/vanliga-fragor'],
  ['frågor', '/vanliga-fragor'],
  ['visning', '/digital-visning']
];

function normalizeLegacyPath(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return pathname.toLowerCase();
  }
  let path = decoded.toLowerCase().replace(/\/+$/, '');
  path = path.replace(/\.html$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  return path || '/';
}

function keywordTarget(path) {
  for (const [keyword, target] of LEGACY_KEYWORDS) {
    if (path.includes(keyword)) return target;
  }
  return null;
}

function legacyRedirect(pathname) {
  const path = normalizeLegacyPath(pathname);

  const target = LEGACY_REDIRECTS.get(path);
  if (target) return { status: 301, location: target };

  // Endast Wix-malladresser får matchas på nyckelord. Övriga okända sökvägar
  // ska falla igenom till 404 så att trasiga länkar inte döljs.
  for (const prefix of LEGACY_TEMPLATE_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      const matched = keywordTarget(path);
      if (matched) return { status: 301, location: matched };
      return { status: 410 };
    }
  }

  return null;
}

module.exports = {
  LEGACY_REDIRECTS,
  LEGACY_TEMPLATE_PREFIXES,
  LEGACY_KEYWORDS,
  legacyRedirect,
  normalizeLegacyPath
};
