function byId(id) {
  return document.getElementById(id);
}

function money(ore) {
  if (typeof ore !== 'number' || !Number.isFinite(ore)) return '';
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0
  }).format(ore / 100);
}

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id') ?? '';
  const sub = byId('addon-result-sub');
  const title = byId('addon-result-title');
  const message = byId('addon-result-message');
  const facts = byId('addon-result-facts');
  if (!sessionId) {
    if (sub) sub.textContent = 'Betalningssession saknas';
    if (title) title.textContent = 'Vi kunde inte kontrollera betalningen';
    if (message) message.textContent = 'Öppna sidan via länken från betalningen eller kontakta Skadevi Herrgård.';
    return;
  }
  try {
    const response = await fetch(`/api/addons/checkout-result?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json) {
      throw new Error(json?.error ?? 'unknown');
    }
    const paid = json.status === 'PAID';
    if (sub) sub.textContent = paid ? 'Betalningen är mottagen' : 'Betalningen är inte genomförd';
    if (title) title.textContent = paid ? 'Tack! Vi har tagit emot betalningen' : 'Ingen betalning har genomförts';
    if (message) message.textContent = json.message ?? '';
    if (facts && paid) {
      facts.replaceChildren();
      for (const [label, value] of [
        ['Bokningsnummer', json.reference ?? ''],
        ['Summa för tillvalsköpet', money(Number(json.totalOre))],
        ['Status', 'Betald']
      ]) {
        if (!value) continue;
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        row.append(dt, dd);
        facts.append(row);
      }
      facts.hidden = false;
    }
  } catch {
    if (sub) sub.textContent = 'Status kunde inte kontrolleras';
    if (title) title.textContent = 'Vi kunde inte bekräfta betalningen';
    if (message) {
      message.textContent = 'Vi kunde inte kontrollera betalningens status just nu. Kontrollera din bokning eller kontakta oss innan du försöker betala igen.';
    }
  }
});
