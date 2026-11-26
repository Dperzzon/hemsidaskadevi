/* Skadevi Bokningsportal — progressiv förbättring.
   Alla skrivningar går mot /api/admin/* med CSRF-token och ETag. Inga
   hemligheter eller bokningsdata lagras i webbläsaren. */
(() => {
  'use strict';

  const body = document.body;
  const menuButton = document.querySelector('.menu-button');
  const sidebar = document.getElementById('sidebar');
  const toast = document.getElementById('toast');
  let csrf = body.dataset.csrf || '';
  const roles = String(body.dataset.roles || '').split(',').filter(Boolean);
  let toastTimer = null;
  const RECHECK_RESULT_KEY = 'skadeviAdminRecheckResult';

  function setNav(open) {
    body.classList.toggle('nav-open', open);
    if (menuButton) menuButton.setAttribute('aria-expanded', String(open));
  }

  if (menuButton && sidebar) {
    menuButton.addEventListener('click', () => setNav(!body.classList.contains('nav-open')));
    document.addEventListener('click', (event) => {
      if (!body.classList.contains('nav-open')) return;
      if (sidebar.contains(event.target) || menuButton.contains(event.target)) return;
      setNav(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setNav(false);
    });
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 6200);
  }

  async function refreshCsrfToken() {
    try {
      const response = await fetch('/api/admin/session', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return false;
      const data = await response.json().catch(() => null);
      if (!data || typeof data.csrfToken !== 'string' || !data.csrfToken) return false;
      csrf = data.csrfToken;
      body.dataset.csrf = csrf;
      return true;
    } catch {
      return false;
    }
  }

  async function api(path, options = {}, allowTokenRetry = true) {
    const headers = {
      'X-CSRF-Token': csrf,
      ...(options.headers || {})
    };
    let requestBody;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(options.body);
    }
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs ?? 25000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        // Easy Auth kräver same-origin Referer för skrivande anrop.
        referrerPolicy: 'same-origin',
        headers,
        body: requestBody,
        signal: controller.signal
      });
    } catch (cause) {
      if (cause && cause.name === 'AbortError') {
        const error = new Error(
          'Kontrollen tog för lång tid. Servern svarade inte inom rimlig tid. Försök igen om en stund.'
        );
        error.code = 'TIMEOUT';
        throw error;
      }
      const error = new Error('Kunde inte nå servern. Kontrollera anslutningen och försök igen.');
      error.code = 'NETWORK';
      throw error;
    } finally {
      clearTimeout(timer);
    }

    // En token kan bli ogiltig efter omstart eller vid utskalning. Hämta en
    // färsk token från sessionen och försök exakt en gång till – CSRF är
    // fortfarande påslaget och något skydd sänks aldrig.
    if (response.status === 403 && allowTokenRetry) {
      const refreshed = await refreshCsrfToken();
      if (refreshed) return api(path, options, false);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const error = new Error(
        'Servern svarade inte med API-data. Inloggningen kan ha gått ut – ladda om sidan och försök igen.'
      );
      error.status = response.status;
      error.code = 'NON_JSON';
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      let message = data.error;
      if (!message) {
        if (response.status === 401) {
          message = 'Inloggningen har gått ut. Ladda om sidan och logga in igen.';
        } else if (response.status === 403) {
          message = 'Du saknar behörighet, eller så har säkerhetssessionen gått ut. Ladda om sidan och logga in igen.';
        } else if (response.status >= 500) {
          message = 'Servern kunde inte slutföra åtgärden. Försök igen om en stund.';
        } else {
          message = `Servern svarade ${response.status}.`;
        }
      }
      if (data.referenceId) message += ` Felreferens: ${data.referenceId}.`;
      const error = new Error(message);
      error.status = response.status;
      error.code = data.code;
      error.referenceId = data.referenceId;
      error.fields = data.fields;
      error.blockedNights = data.blockedNights;
      error.requiresConfirmation = data.requiresConfirmation;
      error.requiresOverrideOption = data.requiresOverrideOption;
      throw error;
    }
    return data;
  }

  function setBusy(form, busy) {
    form.querySelectorAll('button, input, select, textarea').forEach((element) => {
      if (element.dataset.alwaysEnabled === 'true') return;
      element.disabled = busy;
    });
  }

  function errorText(error) {
    const fieldMessages = error.fields && typeof error.fields === 'object'
      ? Object.values(error.fields).filter(Boolean)
      : [];
    return [error.message, ...fieldMessages].filter(Boolean).join(' ');
  }

  function showFormError(form, message) {
    const target = form.querySelector('[data-form-error]');
    if (target) {
      target.textContent = message;
      target.hidden = false;
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      showToast(message);
    }
  }

  function blockedNightsText(error) {
    const nights = Array.isArray(error.blockedNights) ? error.blockedNights : [];
    return nights.length ? ` Upptagna nätter: ${nights.join(', ')}.` : '';
  }

  document.querySelectorAll('[data-prepared-action]').forEach((button) => {
    button.addEventListener('click', () => {
      showToast(`"${button.textContent.trim()}" är inte aktiv i denna version.`);
    });
  });

  document.querySelectorAll('[data-booking-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const requiredRole = button.dataset.requiresRole;
      if (requiredRole && !roles.includes(requiredRole)) {
        showToast('Åtgärden kräver ägarbehörighet.');
        return;
      }
      const action = button.dataset.bookingAction;
      let reason = '';
      if (button.dataset.prompt) {
        const answer = window.prompt(button.dataset.prompt);
        if (answer === null) return;
        reason = answer.trim();
        if (button.dataset.requiresReason === 'true' && !reason) {
          showToast('En orsak krävs.');
          return;
        }
      }
      if (action === 'confirm' && !window.confirm('Bekräfta bokningen? Datumen låses i den interna kalendern.')) {
        return;
      }
      button.disabled = true;
      const submit = async (extra = {}) => {
        const data = await api(
          `/api/admin/bookings/${encodeURIComponent(button.dataset.reference)}/status`,
          {
            body: {
              action,
              reason,
              sendGuestEmail: action === 'confirm' &&
                document.getElementById('send-confirmation-email')?.checked === true,
              expectedEtag: button.dataset.etag || undefined,
              ...extra
            }
          }
        );
        if (data?.emailWarning) window.alert(data.emailWarning);
        return data;
      };
      try {
        try {
          await submit();
        } catch (error) {
          if (action !== 'confirm' || error.code !== 'AIRBNB_CONFLICT') throw error;
          if (!error.requiresConfirmation) {
            showToast(`${error.message}${blockedNightsText(error)}`);
            button.disabled = false;
            return;
          }
          const approved = window.confirm(
            `Airbnb visar upptagna datum.${blockedNightsText(error)}\n\n` +
            'Bekräfta att du själv blockerat datumen i Airbnb och vill åsidosätta endast Airbnb-konflikten. ' +
            'Interna kalenderlås påverkas inte.'
          );
          if (!approved) {
            showToast('Bokningen bekräftades inte.');
            button.disabled = false;
            return;
          }
          const overrideReason = window.prompt('Kort motivering till Airbnb-åsidosättningen:');
          if (!overrideReason || !overrideReason.trim()) {
            showToast('En motivering krävs för att åsidosätta Airbnb.');
            button.disabled = false;
            return;
          }
          await submit({
            airbnbOverrideIntent: true,
            airbnbOverride: true,
            airbnbOverrideConfirmed: true,
            airbnbOverrideReason: overrideReason.trim()
          });
        }
        window.location.reload();
      } catch (error) {
        showToast(errorText(error));
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-block-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Ta bort blockeringen och frigöra datumen?')) return;
      button.disabled = true;
      try {
        await api(`/api/admin/calendar/blocks/${encodeURIComponent(button.dataset.blockRemove)}`, {
          method: 'DELETE',
          headers: button.dataset.etag ? { 'If-Match': button.dataset.etag } : {}
        });
        window.location.href = '/admin/calendar';
      } catch (error) {
        showToast(error.message);
        button.disabled = false;
      }
    });
  });

  function recheckResultBox(warningId) {
    return document.querySelector(`[data-check-result="${String(warningId).replace(/"/g, '\\"')}"]`);
  }

  function setRecheckBusy(button, busy) {
    if (busy) {
      if (button.dataset.busy === 'true') return false;
      button.dataset.busy = 'true';
      button.dataset.originalLabel = button.textContent.trim();
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.innerHTML = '<span class="spinner" aria-hidden="true"></span>Kontrollerar…';
      return true;
    }
    button.dataset.busy = 'false';
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = button.dataset.originalLabel || 'Kontrollera igen';
    return true;
  }

  function showRecheckBanner(result) {
    const main = document.querySelector('.main-content');
    if (!main) return;
    const existing = document.getElementById('recheck-result-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = 'recheck-result-banner';
    banner.className = `notice recheck-result recheck-result-${result.ok ? 'ok' : 'warning'}`;
    const heading = document.createElement('strong');
    heading.textContent = result.type === 'MAIL' ? 'Resultat av mejlkontroll' : 'Resultat av Airbnb-kontroll';
    const text = document.createElement('p');
    text.textContent = result.message;
    const when = document.createElement('p');
    when.className = 'warning-meta';
    when.textContent = result.checkedAt
      ? `Kontrollen utfördes ${new Date(result.checkedAt).toLocaleString('sv-SE')}.`
      : '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-ghost btn-small';
    close.textContent = 'Stäng';
    close.addEventListener('click', () => banner.remove());
    banner.append(heading, text);
    if (when.textContent) banner.append(when);
    banner.append(close);
    main.prepend(banner);
    banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderStoredRecheckResult() {
    let stored = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(RECHECK_RESULT_KEY) || 'null');
      sessionStorage.removeItem(RECHECK_RESULT_KEY);
    } catch {
      stored = null;
    }
    if (!stored || !stored.message) return;
    showToast(stored.message);
    showRecheckBanner(stored);
    const box = recheckResultBox(stored.warningId);
    if (box) {
      box.hidden = false;
      box.textContent = stored.message;
    }
  }

  document.querySelectorAll('[data-warning-recheck]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!setRecheckBusy(button, true)) return;
      const warningId = button.dataset.warningRecheck;
      const box = recheckResultBox(warningId);
      if (box) {
        box.hidden = false;
        box.textContent = 'Kontrollerar mot servern…';
      }
      try {
        const data = await api(
          `/api/admin/bookings/${encodeURIComponent(button.dataset.reference)}/warnings/recheck`,
          {
            body: {
              warningId,
              expectedEtag: button.dataset.etag || undefined
            },
            timeoutMs: 25000
          }
        );
        const result = data?.result ?? {};
        const message = result.message || 'Kontrollen genomfördes.';
        const stored = {
          reference: button.dataset.reference,
          warningId,
          type: result.type || '',
          message,
          checkedAt: result.checkedAt || new Date().toISOString(),
          ok: ['blocked', 'delivered'].includes(result.status)
        };
        try { sessionStorage.setItem(RECHECK_RESULT_KEY, JSON.stringify(stored)); } catch { /* ignoreras */ }
        if (box) box.textContent = message;
        showToast(message);
        setTimeout(() => window.location.reload(), 900);
      } catch (error) {
        const message = errorText(error);
        if (box) {
          box.hidden = false;
          box.className = 'warning-check-result warning-check-result-error';
          box.textContent = message;
        }
        showToast(message);
        setRecheckBusy(button, false);
      }
    });
  });

  renderStoredRecheckResult();

  document.querySelectorAll('[data-warning-ack]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = window.prompt('Kort motivering till varför varningen är hanterad:');
      if (reason === null) return;
      if (!reason.trim()) {
        showToast('En motivering krävs.');
        return;
      }
      button.disabled = true;
      try {
        await api(`/api/admin/bookings/${encodeURIComponent(button.dataset.reference)}/warnings/acknowledge`, {
          body: {
            warningId: button.dataset.warningAck,
            reason: reason.trim(),
            expectedEtag: button.dataset.etag || undefined
          }
        });
        window.location.reload();
      } catch (error) {
        showToast(errorText(error));
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-payment-correct]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = window.prompt('Obligatorisk motivering till rättelsen:');
      if (reason === null) return;
      if (!reason.trim()) {
        showToast('En motivering krävs för att rätta betalningen.');
        return;
      }
      if (!window.confirm('Rätta betalningen? En negativ rättelsepost läggs till i historiken. Originalposten raderas aldrig.')) {
        return;
      }
      button.disabled = true;
      try {
        await api(`/api/admin/bookings/${encodeURIComponent(button.dataset.reference)}/payments/${encodeURIComponent(button.dataset.paymentCorrect)}/corrections`, {
          headers: { 'Idempotency-Key': `correction-${button.dataset.paymentCorrect}` },
          body: {
            reason: reason.trim(),
            expectedEtag: button.dataset.etag || undefined
          }
        });
        window.location.reload();
      } catch (error) {
        showToast(errorText(error));
        button.disabled = false;
      }
    });
  });

  function copyPaymentLink(url, button) {
    if (!url) return;
    if (!navigator.clipboard?.writeText) {
      window.prompt('Kopiera betalningslänken:', url);
      if (button) button.disabled = false;
      return;
    }
    navigator.clipboard.writeText(url)
      .then(() => showToast('Betalningslänken är kopierad.'))
      .catch(() => window.prompt('Kopiera betalningslänken:', url));
    if (button) button.disabled = false;
  }

  function showPaymentLinkResult(url, anchor) {
    const panel = document.createElement('div');
    panel.className = 'notice';
    const heading = document.createElement('strong');
    heading.textContent = 'Betalningssida skapad';
    const text = document.createElement('p');
    text.textContent = 'Kopiera länken nu. Av säkerhetsskäl visas den inte igen efter att sidan laddats om.';
    const row = document.createElement('p');
    row.className = 'payment-link-row';
    const code = document.createElement('code');
    code.textContent = url;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-secondary btn-small';
    copy.textContent = 'Kopiera länk';
    copy.addEventListener('click', () => copyPaymentLink(url, copy));
    row.append(code, copy);
    panel.append(heading, text, row);
    const section = anchor?.closest('section');
    if (section) section.prepend(panel);
    else document.body.prepend(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  document.querySelectorAll('[data-copy-payment-link]').forEach((button) => {
    button.addEventListener('click', () => copyPaymentLink(button.dataset.url || '', button));
  });

  document.querySelectorAll('[data-stripe-payment-link]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Skapa en ny betalningssida? En befintlig länk blir då ogiltig.')) {
        return;
      }
      button.disabled = true;
      try {
        const data = await api(
          `/api/admin/bookings/${encodeURIComponent(button.dataset.reference)}/payment-link`,
          {
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: { expectedEtag: button.dataset.etag || undefined }
          }
        );
        showToast(data.emailQueued
          ? 'Betalningssidan är skapad och mejlet ligger i utkorgen.'
          : 'Betalningssidan är skapad.');
        document.querySelectorAll('[data-stripe-payment-link], [data-revoke-payment-link]')
          .forEach((element) => { element.dataset.etag = ''; });
        showPaymentLinkResult(data.paymentLink.url, button);
      } catch (error) {
        showToast(errorText(error));
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-revoke-payment-link]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Återkalla betalningslänken? Gästen kan inte längre betala via den.')) {
        return;
      }
      button.disabled = true;
      try {
        await api(
          `/api/admin/bookings/${encodeURIComponent(button.dataset.reference)}/payment-link/revoke`,
          {
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: {
              expectedEtag: button.dataset.etag || undefined,
              reason: 'Återkallad av Owner i adminportalen'
            }
          }
        );
        window.location.reload();
      } catch (error) {
        showToast(errorText(error));
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-retry-notifications]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const data = await api(
          `/api/admin/bookings/${encodeURIComponent(button.dataset.retryNotifications)}/notifications/retry`,
          { body: { reason: 'Manuell omkörning i adminportalen' } }
        );
        showToast(data.message || 'Bekräftelsemejlen ligger i utkorgen.');
        window.location.reload();
      } catch (error) {
        showToast(errorText(error));
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-sync-refunds]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const data = await api(
          `/api/admin/bookings/${encodeURIComponent(button.dataset.syncRefunds)}/refunds/sync`,
          { body: {} }
        );
        showToast(data.message || 'Synk mot Stripe är begärd.');
        button.disabled = false;
      } catch (error) {
        showToast(errorText(error));
        button.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-request-reconciliation]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const data = await api(
          `/api/admin/bookings/${encodeURIComponent(button.dataset.requestReconciliation)}/reconcile`,
          { body: {} }
        );
        showToast(data.message || 'Avstämning är begärd.');
        button.disabled = false;
      } catch (error) {
        showToast(errorText(error));
        button.disabled = false;
      }
    });
  });

  function formValue(form, name) {
    const element = form.elements[name];
    return element ? element.value : '';
  }

  function checked(form, name) {
    const element = form.elements[name];
    return Boolean(element && element.checked);
  }

  document.querySelectorAll('form[data-admin-form]').forEach((form) => {
    const type = form.dataset.adminForm;
    let manualIdempotencyKey = '';
    let blockIdempotencyKey = '';
    let paymentIdempotencyKey = '';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setBusy(form, true);
      try {
        if (type === 'note') {
          await api(`/api/admin/bookings/${encodeURIComponent(form.dataset.reference)}/notes`, {
            body: {
              note: formValue(form, 'note'),
              expectedEtag: form.dataset.etag || undefined
            }
          });
          window.location.reload();
          return;
        }
        if (type === 'payment-record') {
          if (!paymentIdempotencyKey) paymentIdempotencyKey = crypto.randomUUID();
          await api(`/api/admin/bookings/${encodeURIComponent(form.dataset.reference)}/payments`, {
            headers: { 'Idempotency-Key': paymentIdempotencyKey },
            body: {
              amount: formValue(form, 'amount'),
              paymentDate: formValue(form, 'paymentDate'),
              method: formValue(form, 'method'),
              reference: formValue(form, 'reference'),
              expectedEtag: form.dataset.etag || undefined
            }
          });
          window.location.reload();
          return;
        }
        if (type === 'payment') {
          await api(`/api/admin/bookings/${encodeURIComponent(form.dataset.reference)}/payment`, {
            method: 'PATCH',
            body: {
              paymentStatus: formValue(form, 'paymentStatus'),
              amountPaid: Number(formValue(form, 'amountPaid') || 0),
              reason: formValue(form, 'reason'),
              expectedEtag: form.dataset.etag || undefined
            }
          });
          window.location.reload();
          return;
        }
        if (type === 'addons') {
          const patch = (extra = {}) => api(
            `/api/admin/bookings/${encodeURIComponent(form.dataset.reference)}/addons`,
            {
              method: 'PATCH',
              body: {
                addons: {
                  slutstad: checked(form, 'slutstad'),
                  extrahus: checked(form, 'extrahus'),
                  extrahusNights: Number(formValue(form, 'extrahusNights') || 0),
                  extrahusGuests: Number(formValue(form, 'extrahusGuests') || 0),
                  lakan: checked(form, 'lakan'),
                  linenCount: Number(formValue(form, 'linenCount') || 0),
                  ved: checked(form, 'ved'),
                  tidigIncheckning: checked(form, 'tidigIncheckning'),
                  senUtcheckning: checked(form, 'senUtcheckning')
                },
                enableAutomaticBufferNights: checked(form, 'enableAutomaticBufferNights'),
                reason: formValue(form, 'reason'),
                expectedEtag: form.dataset.etag || undefined,
                ...extra
              }
            }
          );
          try {
            await patch();
          } catch (error) {
            if (
              error.code !== 'AIRBNB_CONFLICT' ||
              (!error.requiresOverrideOption && !error.requiresConfirmation)
            ) {
              throw error;
            }
            const approved = window.confirm(
              `Airbnb visar upptagna buffertdatum.${blockedNightsText(error)}\n\n` +
              'Bekräfta att du själv har blockerat datumen i Airbnb innan de ersätts ' +
              'med automatiska buffertnätter. Interna kalenderlås påverkas inte.'
            );
            if (!approved) {
              showFormError(form, 'Tillvalet ändrades inte. Datumen är fortsatt blockerade i Airbnb.');
              setBusy(form, false);
              return;
            }
            const overrideReason = window.prompt('Kort motivering till varför Airbnb-blockeringen åsidosätts:');
            if (!overrideReason || !overrideReason.trim()) {
              showFormError(form, 'En motivering krävs för att åsidosätta Airbnb-blockeringen.');
              setBusy(form, false);
              return;
            }
            await patch({
              airbnbOverrideIntent: true,
              airbnbOverride: true,
              airbnbOverrideConfirmed: true,
              airbnbOverrideReason: overrideReason.trim()
            });
          }
          window.location.reload();
          return;
        }
        if (type === 'refund-record') {
          let idempotencyKey = formValue(form, 'idempotencyKey');
          if (!idempotencyKey) {
            idempotencyKey = crypto.randomUUID();
            form.elements.idempotencyKey.value = idempotencyKey;
          }
          const amount = Number(formValue(form, 'amount'));
          await api(`/api/admin/bookings/${encodeURIComponent(form.dataset.reference)}/refunds`, {
            headers: { 'Idempotency-Key': idempotencyKey },
            body: {
              status: formValue(form, 'status'),
              amountOre: Math.round(amount * 100),
              stripeRefundId: formValue(form, 'stripeRefundId'),
              reason: formValue(form, 'reason'),
              note: formValue(form, 'note'),
              confirm: checked(form, 'confirm'),
              expectedEtag: form.dataset.etag || undefined
            }
          });
          window.location.reload();
          return;
        }
        if (type === 'invoice-status') {
          await api(
            `/api/admin/bookings/${encodeURIComponent(form.dataset.reference)}/invoice-requests/${encodeURIComponent(form.dataset.requestId)}`,
            {
              method: 'PATCH',
              body: {
                status: formValue(form, 'status'),
                reason: formValue(form, 'reason'),
                expectedEtag: form.dataset.etag || undefined
              }
            }
          );
          window.location.reload();
          return;
        }
        if (type === 'direct-booking-toggle') {
          await api('/api/admin/direct-booking/toggle', {
            body: {
              enabled: formValue(form, 'enabled') === '1',
              note: formValue(form, 'note')
            }
          });
          window.location.reload();
          return;
        }
        if (type === 'calendar-safety-approve') {
          await api('/api/admin/direct-booking/calendar/approve', {
            body: {
              note: formValue(form, 'note'),
              confirmEmpty: checked(form, 'confirmEmpty')
            }
          });
          window.location.reload();
          return;
        }
        if (type === 'direct-booking-open') {
          await api('/api/admin/direct-booking/open', {
            body: {
              from: formValue(form, 'from'),
              to: formValue(form, 'to'),
              note: formValue(form, 'note'),
              confirmAirbnbBlocked: checked(form, 'confirmAirbnbBlocked'),
              confirmNoAirbnbGuest: checked(form, 'confirmNoAirbnbGuest'),
              confirmNoExternal: checked(form, 'confirmNoExternal'),
              confirmMayOffer: checked(form, 'confirmMayOffer')
            }
          });
          window.location.reload();
          return;
        }
        if (type === 'direct-booking-close') {
          await api('/api/admin/direct-booking/close', {
            body: {
              approvalId: form.dataset.approvalId,
              note: formValue(form, 'note')
            }
          });
          window.location.reload();
          return;
        }
        if (type === 'block') {
          if (!blockIdempotencyKey) blockIdempotencyKey = crypto.randomUUID();
          await api('/api/admin/calendar/blocks', {
            headers: { 'Idempotency-Key': blockIdempotencyKey },
            body: {
              arrival: formValue(form, 'arrival'),
              departure: formValue(form, 'departure'),
              latestNote: formValue(form, 'latestNote')
            }
          });
          window.location.href = '/admin/calendar';
          return;
        }
        if (type === 'manual-booking') {
          const modeElement = form.querySelector('input[name="mode"]:checked');
          const mode = modeElement ? modeElement.value : 'booking';
          if (mode === 'block') {
            if (!blockIdempotencyKey) blockIdempotencyKey = crypto.randomUUID();
            await api('/api/admin/calendar/blocks', {
              headers: { 'Idempotency-Key': blockIdempotencyKey },
              body: {
                arrival: formValue(form, 'arrival'),
                departure: formValue(form, 'departure'),
                latestNote: formValue(form, 'latestNote')
              }
            });
            window.location.href = '/admin/calendar';
            return;
          }

          // Behåll samma nyckel genom Airbnb-override och omförsök. Servern
          // återanvänder då en redan sparad bokning i stället för att skapa
          // en dubblett om ett tidigare svar var osäkert.
          if (!manualIdempotencyKey) manualIdempotencyKey = crypto.randomUUID();
          const payload = {
            mode: 'booking',
            firstName: formValue(form, 'firstName'),
            lastName: formValue(form, 'lastName'),
            email: formValue(form, 'email'),
            phone: formValue(form, 'phone'),
            company: formValue(form, 'company'),
            arrival: formValue(form, 'arrival'),
            departure: formValue(form, 'departure'),
            guests: Number(formValue(form, 'guests') || 0),
            bookingSource: formValue(form, 'bookingSource'),
            statusCode: formValue(form, 'statusCode'),
            airbnbOverrideIntent: checked(form, 'airbnbOverrideIntent'),
            addons: {
              slutstad: checked(form, 'slutstad'),
              extrahus: checked(form, 'extrahus'),
              extrahusNights: Number(formValue(form, 'extrahusNights') || 0),
              extrahusGuests: Number(formValue(form, 'extrahusGuests') || 0),
              lakan: checked(form, 'lakan'),
              linenCount: Number(formValue(form, 'linenCount') || 0),
              ved: checked(form, 'ved'),
              tidigIncheckning: checked(form, 'tidigIncheckning'),
              senUtcheckning: checked(form, 'senUtcheckning')
            },
            agreedTotal: formValue(form, 'agreedTotal') === '' ? null : Number(formValue(form, 'agreedTotal')),
            priceAdjustmentReason: formValue(form, 'priceAdjustmentReason'),
            paymentStatus: formValue(form, 'paymentStatus'),
            amountPaid: Number(formValue(form, 'amountPaid') || 0),
            sendGuestEmail: checked(form, 'sendGuestEmail'),
            latestNote: formValue(form, 'latestNote')
          };
          const post = (extra = {}) => api('/api/admin/bookings', {
            headers: { 'Idempotency-Key': manualIdempotencyKey },
            body: { ...payload, ...extra }
          });

          let data;
          try {
            data = await post();
          } catch (error) {
            if (error.code !== 'AIRBNB_CONFLICT' || !error.requiresConfirmation) throw error;
            const approved = window.confirm(
              `Varning: Airbnb visar upptagna datum.${blockedNightsText(error)}\n\n` +
              'Bekräfta att du själv har blockerat datumen i Airbnb för denna bokning. ' +
              'Endast Airbnb-konflikten åsidosätts. Interna kalenderlås och andra bokningar påverkas inte.'
            );
            if (!approved) {
              showFormError(form, 'Bokningen skapades inte. Datumen är fortsatt blockerade i Airbnb.');
              setBusy(form, false);
              return;
            }
            const overrideReason = window.prompt('Kort motivering till varför Airbnb-blockeringen åsidosätts:');
            if (!overrideReason || !overrideReason.trim()) {
              showFormError(form, 'En motivering krävs för att åsidosätta Airbnb-blockeringen.');
              setBusy(form, false);
              return;
            }
            data = await post({
              airbnbOverride: true,
              airbnbOverrideConfirmed: true,
              airbnbOverrideReason: overrideReason.trim()
            });
          }
          if (data?.emailWarning) window.alert(data.emailWarning);
          window.location.href = `/admin/bookings/${encodeURIComponent(data.reference)}`;
        }
      } catch (error) {
        showFormError(form, errorText(error));
        setBusy(form, false);
      }
    });
  });

  const manualForm = document.querySelector('form[data-admin-form="manual-booking"]');
  if (manualForm) {
    const updateMode = () => {
      const modeElement = manualForm.querySelector('input[name="mode"]:checked');
      const isBlock = (modeElement ? modeElement.value : 'booking') === 'block';
      manualForm.querySelectorAll('[data-booking-only]').forEach((element) => {
        element.hidden = isBlock;
      });
    };
    manualForm.querySelectorAll('input[name="mode"]').forEach((input) => {
      input.addEventListener('change', updateMode);
    });
    updateMode();
  }
})();
