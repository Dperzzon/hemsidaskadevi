/* Skadevi Bokningsportal — minimal progressiv förbättring.
   Inga nätverksanrop och inga skrivningar. Förberedda knappar visar bara
   information tills statusflödet aktiveras i nästa etapp. */
(() => {
  'use strict';

  const body = document.body;
  const menuButton = document.querySelector('.menu-button');
  const sidebar = document.getElementById('sidebar');
  const toast = document.getElementById('toast');
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
    }, 5200);
  }

  const roles = String(body.dataset.roles || '').split(',').filter(Boolean);

  document.querySelectorAll('[data-prepared-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const requiredRole = button.dataset.requiresRole;
      if (requiredRole && !roles.includes(requiredRole)) {
        showToast('Åtgärden kräver ägarbehörighet.');
        return;
      }
      const label = button.textContent.trim();
      showToast(`"${label}" är förberedd. Inga statusändringar eller mejl skickas i denna version.`);
    });
  });
})();
