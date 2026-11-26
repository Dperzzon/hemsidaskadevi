'use strict';

// Säker, frivillig leveransuppslagning mot Resend.
//
// Adminportalens Resend-nyckel har normalt bara Sending access. Att läsa
// leveransstatus kräver ett API-anrop som nyckeln kan sakna behörighet till.
// Därför görs inget anrop alls förrän funktionen uttryckligen aktiverats med
// RESEND_DELIVERY_READ_ENABLED=1 och en API-nyckel finns. Ett 401/403 tolkas
// som "behörighet saknas" och upprepas inte i onödan.

const DEFAULT_BASE_URL = 'https://api.resend.com';
const DEFAULT_TIMEOUT_MS = 8000;

function deliveryConfig(options = {}) {
  const apiKey = String(options.apiKey ?? process.env.RESEND_API_KEY ?? '');
  const enabled = options.enabled ?? process.env.RESEND_DELIVERY_READ_ENABLED === '1';
  return {
    enabled: enabled === true && Boolean(apiKey),
    apiKey,
    baseUrl: String(options.baseUrl ?? process.env.RESEND_API_BASE_URL ?? DEFAULT_BASE_URL),
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  };
}

function mapLastEvent(lastEvent) {
  const value = String(lastEvent ?? '').toLowerCase();
  if (value === 'delivered') return 'delivered';
  if (value === 'bounced') return 'bounced';
  if (value === 'complained') return 'complained';
  if (value === 'failed') return 'failed';
  if (value === 'delivery_delayed') return 'delayed';
  if (['sent', 'queued', 'scheduled', 'opened', 'clicked'].includes(value)) return 'accepted';
  return 'unavailable';
}

// Returnerar alltid ett strukturerat resultat och kastar aldrig. Statusvärden:
// delivered | bounced | complained | failed | delayed | accepted | unavailable |
// permission_denied | not_configured | missing_id
async function checkResendDelivery(options = {}) {
  const config = deliveryConfig(options);
  const resendId = String(options.resendId ?? '');
  const checkedAt = new Date().toISOString();
  if (!resendId) {
    return { status: 'missing_id', checkedAt, resendId, error: 'resend_id_missing', source: 'resend_api' };
  }
  if (!config.enabled) {
    return {
      status: 'not_configured',
      checkedAt,
      resendId,
      error: config.apiKey ? 'delivery_read_disabled' : 'api_key_missing',
      source: 'resend_api'
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, config.timeoutMs));
  try {
    const response = await config.fetchImpl(
      `${config.baseUrl.replace(/\/+$/, '')}/emails/${encodeURIComponent(resendId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json'
        },
        cache: 'no-store',
        signal: controller.signal
      }
    );
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'permission_denied',
        checkedAt,
        resendId,
        httpStatus: response.status,
        error: 'resend_access_denied',
        source: 'resend_api'
      };
    }
    if (!response.ok) {
      return {
        status: 'unavailable',
        checkedAt,
        resendId,
        httpStatus: response.status,
        error: `resend_http_${response.status}`,
        source: 'resend_api'
      };
    }
    const data = await response.json().catch(() => null);
    const lastEvent = String(data?.last_event ?? data?.status ?? '');
    return {
      status: mapLastEvent(lastEvent),
      checkedAt,
      resendId,
      lastEvent,
      httpStatus: response.status,
      error: '',
      source: 'resend_api'
    };
  } catch {
    return {
      status: 'unavailable',
      checkedAt,
      resendId,
      error: timedOut ? 'resend_timeout' : 'resend_fetch_failed',
      source: 'resend_api'
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  deliveryConfig,
  mapLastEvent,
  checkResendDelivery
};
