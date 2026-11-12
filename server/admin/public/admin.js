/* Skadevi Bokningsportal — progressiv förbättring.
   Alla skrivningar går mot /api/admin/* med CSRF-token och ETag. Inga
   hemligheter eller bokningsdata lagras i webbläsaren. */
(() => {
  'use strict';

  const body = document.body;
  const menuButton = document.querySelector('.menu-button');
  const sidebar = document.getElementById('sidebar');
  const toast = document.getElementById('toast');
  const csrf = body.dataset.csrf || '';
  const roles = String(body.dataset.roles || '').split(',').filter(Boolean);
  let toastTimer = null;

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

  async function api(path, options = {}) {
    const headers = {
      'X-CSRF-Token': csrf,
      ...(options.headers || {})
    };
    let requestBody;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(options.body);
    }
    const response = await fetch(path, {
      method: options.method || 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      // Easy Auth kräver same-origin Referer för skrivande anrop.
      referrerPolicy: 'same-origin',
      headers,
      body: requestBody
    });
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
      const submit = (extra = {}) => api(
        `/api/admin/bookings/${encodeURIComponent(button.dataset.reference)}/status`,
        {
          body: {
            action,
            reason,
            expectedEtag: button.dataset.etag || undefined,
            ...extra
          }
        }
      );
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
          await api(`/api/admin/bookings/${encodeURIComponent(form.dataset.reference)}/addons`, {
            method: 'PATCH',
            body: {
              addons: {
                slutstad: checked(form, 'slutstad'),
                lakan: checked(form, 'lakan'),
                linenCount: Number(formValue(form, 'linenCount') || 0),
                ved: checked(form, 'ved'),
                tidigIncheckning: checked(form, 'tidigIncheckning'),
                senUtcheckning: checked(form, 'senUtcheckning')
              },
              reason: formValue(form, 'reason'),
              expectedEtag: form.dataset.etag || undefined
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
