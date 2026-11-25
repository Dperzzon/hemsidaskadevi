const TOKEN_KEY = 'skadeviAddonToken';
const IDEMPOTENCY_KEY = 'skadeviAddonOrderKey';
const MODE_KEY = 'skadeviBookingMode';

function byId(id) {
  return document.getElementById(id);
}

function show(element, visible = true) {
  if (element) element.hidden = !visible;
}

function setNotice(element, message, tone = 'info') {
  if (!element) return;
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = !message;
}

function randomKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `addon-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function money(ore) {
  if (typeof ore !== 'number' || !Number.isFinite(ore)) return '';
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0
  }).format(ore / 100);
}

function formatDate(value) {
  if (!value) return '–';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

async function api(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {})
  };
  const token = options.token ?? sessionStorage.getItem(TOKEN_KEY);
  if (token) headers['X-Addon-Token'] = token;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json };
}

function initAddonFlow() {
  const section = byId('addon-section');
  if (!section) return;

  const modeSection = document.querySelector('.booking-mode-section');
  const modeButtons = [...document.querySelectorAll('[data-booking-mode]')];
  const addonModeButton = byId('addons-mode-button');
  const calendarSection = document.querySelector('.calendar-section');
  const bookingSection = byId('booking-section');

  const identifyForm = byId('addon-identify-form');
  const codeForm = byId('addon-code-form');
  const sessionPanel = byId('addon-session');
  const successPanel = byId('addon-success');
  const identifySubmit = byId('addon-identify-submit');
  const codeSubmit = byId('addon-code-submit');
  const purchaseForm = byId('addon-purchase-form');
  const purchaseSubmit = byId('addon-purchase-submit');
  const terms = byId('addon-terms');
  const optionsEl = byId('addon-options');
  const totalEl = byId('addon-total');
  const summaryEl = byId('addon-booking-summary');
  const existingEl = byId('addon-existing');
  const requestForm = byId('addon-request-form');
  const requestSubmit = byId('addon-request-submit');

  let enabled = false;
  let session = null;

  function setStep(step) {
    document.querySelectorAll('[data-addon-step-indicator]').forEach((item) => {
      item.classList.toggle('is-active', Number(item.dataset.addonStepIndicator) <= step);
      item.classList.toggle('is-current', Number(item.dataset.addonStepIndicator) === step);
    });
  }

  function setMode(next) {
    if (next === 'addons' && !enabled) next = 'new';
    modeButtons.forEach((button) => {
      const active = button.dataset.bookingMode === next;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (calendarSection) calendarSection.hidden = next === 'addons';
    if (bookingSection) bookingSection.hidden = next === 'addons' ? true : bookingSection.hidden;
    show(section, next === 'addons');
    try {
      sessionStorage.setItem(MODE_KEY, next);
    } catch {
      // Session storage kan vara blockerat; flödet fungerar ändå.
    }
    if (next === 'addons') {
      window.setTimeout(() => byId('addon-title')?.focus(), 50);
    }
  }

  function clearToken() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(IDEMPOTENCY_KEY);
    } catch {
      // Ignorera.
    }
  }

  function resetFlow() {
    clearToken();
    session = null;
    identifyForm.reset();
    codeForm.reset();
    setNotice(byId('addon-identify-notice'), '');
    setNotice(byId('addon-code-notice'), '');
    setNotice(byId('addon-purchase-notice'), '');
    setNotice(byId('addon-request-notice'), '');
    show(identifyForm, true);
    show(codeForm, false);
    show(sessionPanel, false);
    show(successPanel, false);
    setStep(1);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = label ?? 'Arbetar …';
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalLabel ?? button.textContent;
      button.disabled = false;
    }
  }

  async function loadSession() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) return false;
    const { status, json } = await api('/api/addons/session', { token });
    if (status === 401 || status === 403) {
      clearToken();
      resetFlow();
      setNotice(byId('addon-identify-notice'),
        'Sessionen har gått ut. Ange bokningsnummer och e-post igen.', 'warning');
      return false;
    }
    if (status !== 200 || !json) {
      setNotice(byId('addon-identify-notice'),
        'Bokningen kunde inte läsas just nu. Försök igen om en stund.', 'warning');
      return false;
    }
    session = json;
    show(identifyForm, false);
    show(codeForm, false);
    show(sessionPanel, true);
    show(successPanel, false);
    renderSession(json);
    setStep(3);
    return true;
  }

  function renderSummary(data) {
    summaryEl.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = 'Er befintliga bokning';
    summaryEl.append(title);
    const list = document.createElement('dl');
    list.className = 'addon-summary-list';
    for (const [label, value] of [
      ['Bokningsnummer', data.reference],
      ['Ankomst', formatDate(data.arrival)],
      ['Avresa', formatDate(data.departure)],
      ['Antal nätter', String(data.nights ?? '')],
      ['Antal gäster', String(data.guests ?? '')]
    ]) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value ?? '–';
      row.append(dt, dd);
      list.append(row);
    }
    summaryEl.append(list);
    const note = document.createElement('p');
    note.className = 'addon-summary-note';
    note.textContent = 'Ni kompletterar denna bokning. Inga nya boendedatum skapas.';
    summaryEl.append(note);
  }

  function renderExisting(lines) {
    existingEl.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = 'Redan bokade tillval: ';
    if (!Array.isArray(lines) || !lines.length) {
      existingEl.append(title, document.createTextNode('Inga ännu.'));
      return;
    }
    existingEl.append(title, document.createTextNode(
      lines.map((line) => `${line.label}${line.quantity > 1 ? ` × ${line.quantity}` : ''}`).join(', ')
    ));
  }

  function renderOptions(data) {
    optionsEl.replaceChildren();
    if (!Array.isArray(data.available) || !data.available.length) {
      const empty = document.createElement('p');
      empty.className = 'addon-empty';
      empty.textContent = 'Det finns inga fler tillval som kan köpas direkt till denna bokning.';
      optionsEl.append(empty);
    }
    for (const option of data.available ?? []) {
      const card = document.createElement('div');
      card.className = 'addon-option';
      const label = document.createElement('label');
      label.className = 'addon-option-label';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = `addon-${option.id}`;
      input.value = option.id;
      input.dataset.addonId = option.id;
      input.dataset.priceOre = String(option.priceOre ?? 0);
      input.dataset.type = option.type ?? 'boolean';
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = option.label;
      const description = document.createElement('span');
      description.className = 'addon-option-description';
      description.textContent = option.description ?? '';
      const price = document.createElement('span');
      price.className = 'addon-option-price';
      price.textContent = option.priceLabel ?? money(option.priceOre);
      text.append(name, description, price);
      label.append(input, text);
      card.append(label);
      if (option.type === 'quantity') {
        const quantityWrap = document.createElement('div');
        quantityWrap.className = 'addon-quantity';
        const quantityLabel = document.createElement('label');
        quantityLabel.textContent = 'Antal';
        quantityLabel.htmlFor = `addon-quantity-${option.id}`;
        const quantity = document.createElement('input');
        quantity.type = 'number';
        quantity.id = `addon-quantity-${option.id}`;
        quantity.name = `addon-quantity-${option.id}`;
        quantity.min = '1';
        quantity.max = String(option.max ?? 1);
        quantity.value = '1';
        quantity.inputMode = 'numeric';
        quantity.dataset.addonQuantityFor = option.id;
        quantity.disabled = true;
        quantityWrap.append(quantityLabel, quantity);
        card.append(quantityWrap);
        input.addEventListener('change', () => {
          quantity.disabled = !input.checked;
        });
      }
      input.addEventListener('change', updateTotal);
      optionsEl.append(card);
    }
    if (Array.isArray(data.requestOnly) && data.requestOnly.length) {
      const text = byId('addon-request-only-text');
      if (text) {
        text.textContent = `Följande kan endast efterfrågas: ${data.requestOnly.map((item) => item.label).join(', ')}. Vi bekräftar tillgänglighet och pris manuellt innan något debiteras.`;
      }
    }
    updateTotal();
  }

  function collectItems() {
    const items = {};
    for (const input of optionsEl.querySelectorAll('input[type="checkbox"][data-addon-id]')) {
      if (!input.checked) continue;
      const id = input.dataset.addonId;
      if (input.dataset.type === 'quantity') {
        const quantity = optionsEl.querySelector(`[data-addon-quantity-for="${id}"]`);
        items[id] = true;
        items.linenCount = Math.max(1, Number(quantity?.value ?? 1));
      } else {
        items[id] = true;
      }
    }
    return items;
  }

  function calculateTotal() {
    let total = 0;
    for (const input of optionsEl.querySelectorAll('input[type="checkbox"][data-addon-id]')) {
      if (!input.checked) continue;
      const unit = Number(input.dataset.priceOre ?? 0);
      if (input.dataset.type === 'quantity') {
        const quantity = optionsEl.querySelector(`[data-addon-quantity-for="${input.dataset.addonId}"]`);
        const count = Math.max(1, Number(quantity?.value ?? 1));
        total += unit * count;
      } else {
        total += unit;
      }
    }
    return total;
  }

  function updateTotal() {
    const total = calculateTotal();
    totalEl.replaceChildren();
    const label = document.createElement('span');
    label.textContent = 'Summa för detta köp';
    const amount = document.createElement('strong');
    amount.textContent = money(total);
    totalEl.append(label, amount);
    if (purchaseSubmit) purchaseSubmit.disabled = total <= 0 || !terms?.checked;
  }

  function renderSession(data) {
    renderSummary(data);
    renderExisting(data.existingAddons);
    renderOptions(data);
  }

  identifyForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const reference = byId('addon-reference')?.value.trim() ?? '';
    const email = byId('addon-email')?.value.trim() ?? '';
    if (!reference || !email) {
      setNotice(byId('addon-identify-notice'), 'Fyll i bokningsnummer och e-postadress.', 'warning');
      return;
    }
    setBusy(identifySubmit, true, 'Skickar …');
    setNotice(byId('addon-identify-notice'), '');
    try {
      const { status, json } = await api('/api/addons/verify/start', {
        method: 'POST',
        body: { reference, email }
      });
      if (status === 429) {
        setNotice(byId('addon-identify-notice'),
          json?.message ?? 'För många försök. Försök igen om en stund.', 'warning');
        return;
      }
      if (status >= 500) {
        setNotice(byId('addon-identify-notice'),
          'Verifieringen kan inte tas emot just nu. Försök igen senare.', 'warning');
        return;
      }
      setNotice(byId('addon-identify-notice'),
        json?.message ?? 'Om uppgifterna stämmer har vi skickat en verifieringskod.', 'info');
      show(codeForm, true);
      setStep(2);
      byId('addon-code')?.focus();
    } catch {
      setNotice(byId('addon-identify-notice'),
        'Verifieringen kan inte tas emot just nu. Försök igen senare.', 'warning');
    } finally {
      setBusy(identifySubmit, false);
    }
  });

  codeForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const reference = byId('addon-reference')?.value.trim() ?? '';
    const email = byId('addon-email')?.value.trim() ?? '';
    const code = byId('addon-code')?.value.trim() ?? '';
    if (!/^\d{6}$/.test(code)) {
      setNotice(byId('addon-code-notice'), 'Ange den sexsiffriga koden från mejlet.', 'warning');
      return;
    }
    setBusy(codeSubmit, true, 'Verifierar …');
    setNotice(byId('addon-code-notice'), '');
    try {
      const { status, json } = await api('/api/addons/verify/confirm', {
        method: 'POST',
        body: { reference, email, code }
      });
      if (status !== 200 || !json?.token) {
        setNotice(byId('addon-code-notice'),
          json?.error ?? 'Verifieringen kunde inte genomföras. Kontrollera uppgifterna och försök igen.', 'warning');
        return;
      }
      sessionStorage.setItem(TOKEN_KEY, json.token);
      sessionStorage.setItem(IDEMPOTENCY_KEY, randomKey());
      const loaded = await loadSession();
      if (!loaded) {
        setNotice(byId('addon-code-notice'), 'Bokningen kunde inte läsas. Försök igen.', 'warning');
      }
    } catch {
      setNotice(byId('addon-code-notice'),
        'Verifieringen kan inte genomföras just nu. Försök igen senare.', 'warning');
    } finally {
      setBusy(codeSubmit, false);
    }
  });

  byId('addon-resend')?.addEventListener('click', async () => {
    const reference = byId('addon-reference')?.value.trim() ?? '';
    const email = byId('addon-email')?.value.trim() ?? '';
    const { status, json } = await api('/api/addons/verify/start', {
      method: 'POST',
      body: { reference, email }
    }).catch(() => ({ status: 503, json: null }));
    setNotice(byId('addon-code-notice'),
      status >= 500
        ? 'Ett nytt kodutskick kan inte göras just nu.'
        : json?.message ?? 'Om uppgifterna stämmer har vi skickat en ny kod.',
      status >= 500 ? 'warning' : 'info');
  });

  byId('addon-start-over')?.addEventListener('click', () => {
    resetFlow();
    setMode('addons');
  });

  purchaseForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!session) return;
    const items = collectItems();
    if (!Object.keys(items).length) {
      setNotice(byId('addon-purchase-notice'), 'Välj minst ett tillval.', 'warning');
      return;
    }
    if (!terms?.checked) {
      setNotice(byId('addon-purchase-notice'), 'Godkänn villkoren för tillvalsköpet.', 'warning');
      return;
    }
    setBusy(purchaseSubmit, true, 'Öppnar betalning …');
    setNotice(byId('addon-purchase-notice'), '');
    let idempotencyKey = sessionStorage.getItem(IDEMPOTENCY_KEY);
    if (!idempotencyKey) {
      idempotencyKey = randomKey();
      sessionStorage.setItem(IDEMPOTENCY_KEY, idempotencyKey);
    }
    try {
      const { status, json } = await api('/api/addons/checkout', {
        method: 'POST',
        idempotencyKey,
        body: {
          items,
          acceptTerms: true,
          termsVersion: session.termsVersion
        }
      });
      if ((status === 201 || status === 200) && json?.checkoutUrl) {
        window.location.assign(json.checkoutUrl);
        return;
      }
      if (status === 200 && json?.alreadyPaid) {
        setNotice(byId('addon-purchase-notice'),
          'Tillvalen är redan betalda och registrerade på bokningen.', 'success');
        return;
      }
      if (status === 401) {
        clearToken();
        resetFlow();
        setNotice(byId('addon-identify-notice'),
          'Sessionen har gått ut. Ange bokningsnummer och e-post igen.', 'warning');
        return;
      }
      setNotice(byId('addon-purchase-notice'),
        json?.error ?? 'Betalningen kunde inte startas. Försök igen.', 'warning');
    } catch {
      setNotice(byId('addon-purchase-notice'),
        'Betalningen kunde inte startas just nu. Inget har debiterats.', 'warning');
    } finally {
      setBusy(purchaseSubmit, false);
    }
  });

  terms?.addEventListener('change', updateTotal);
  optionsEl?.addEventListener('input', (event) => {
    if (event.target.matches('[data-addon-quantity-for]')) updateTotal();
  });

  byId('addon-open-rules')?.addEventListener('click', () => {
    const dialog = byId('booking-rules-dialog');
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  });

  requestForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const extrahus = byId('addon-request-extrahus')?.value.trim() ?? '';
    const other = byId('addon-request-other')?.value.trim() ?? '';
    if (!extrahus && !other) {
      setNotice(byId('addon-request-notice'), 'Beskriv vilket tillval ni vill efterfråga.', 'warning');
      return;
    }
    const parts = [];
    if (extrahus) parts.push(`Extrahus: ${extrahus}`);
    if (other) parts.push(`Annat: ${other}`);
    setBusy(requestSubmit, true, 'Skickar …');
    setNotice(byId('addon-request-notice'), '');
    try {
      const { status, json } = await api('/api/addons/request', {
        method: 'POST',
        body: { items: { otherText: parts.join('. ') } }
      });
      if (status === 201) {
        show(sessionPanel, false);
        show(successPanel, true);
        const text = byId('addon-success-text');
        if (text) text.textContent = json?.message ?? 'Vi har tagit emot er förfrågan. Inget har debiterats.';
        byId('addon-success')?.focus();
        return;
      }
      if (status === 401) {
        clearToken();
        resetFlow();
        setNotice(byId('addon-identify-notice'),
          'Sessionen har gått ut. Ange bokningsnummer och e-post igen.', 'warning');
        return;
      }
      setNotice(byId('addon-request-notice'),
        json?.error ?? 'Förfrågan kunde inte skickas. Försök igen.', 'warning');
    } catch {
      setNotice(byId('addon-request-notice'),
        'Förfrågan kunde inte skickas just nu. Försök igen senare.', 'warning');
    } finally {
      setBusy(requestSubmit, false);
    }
  });

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setMode(button.dataset.bookingMode);
      if (button.dataset.bookingMode === 'new') {
        show(bookingSection, false);
      }
    });
  });

  (async () => {
    try {
      const { status, json } = await api('/api/booking-config');
      enabled = status === 200 && json?.existingBookingAddonsEnabled === true;
    } catch {
      enabled = false;
    }
    if (enabled) {
      show(addonModeButton, true);
      if (modeSection) modeSection.classList.add('is-enabled');
    } else {
      show(addonModeButton, false);
    }
    const params = new URLSearchParams(window.location.search);
    const cancelled = params.get('tillval') === 'avbruten';
    let storedMode = 'new';
    let hasToken = false;
    try {
      storedMode = sessionStorage.getItem(MODE_KEY) ?? 'new';
      hasToken = Boolean(sessionStorage.getItem(TOKEN_KEY));
    } catch {
      storedMode = 'new';
    }
    if (enabled && (cancelled || storedMode === 'addons' || hasToken)) {
      setMode('addons');
      if (cancelled && hasToken) {
        const orderId = params.get('order');
        if (orderId) {
          await api('/api/addons/abandon', {
            method: 'POST',
            body: { orderId }
          }).catch(() => null);
        }
        clearToken();
        resetFlow();
      }
      const loaded = cancelled ? false : await loadSession();
      if (cancelled) {
        setNotice(byId('addon-identify-notice'),
          'Betalningen avbröts och inga tillval har lagts till. Du kan försöka igen när du vill.', 'info');
      } else if (!loaded) {
        setNotice(byId('addon-identify-notice'),
          'Bokningen kunde inte läsas. Ange bokningsnummer och e-post igen.', 'warning');
      }
    }
  })();
}

document.addEventListener('DOMContentLoaded', initAddonFlow);
