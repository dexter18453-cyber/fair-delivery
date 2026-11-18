'use strict';
/* The cart badge is visual-only; checkout totals and validation remain in customer.js. */
(() => {
  if (document.body?.dataset.appRole !== 'customer') return;
  const tab = document.querySelector('.app-tabs [data-tab="cart"]');
  const cart = document.getElementById('cart');
  if (!tab || !cart) return;

  const badge = document.createElement('span');
  badge.className = 'cart-count';
  badge.setAttribute('aria-hidden', 'true');
  badge.hidden = true;
  tab.appendChild(badge);

  function update() {
    const quantity = Array.from(cart.querySelectorAll('.qty > b'))
      .reduce((sum, element) => {
        const value = Number.parseInt(element.textContent || '0', 10);
        return sum + (Number.isFinite(value) && value > 0 ? value : 0);
      }, 0);
    badge.hidden = quantity === 0;
    badge.textContent = quantity > 99 ? '99+' : String(quantity);
    tab.setAttribute('aria-label', quantity
      ? 'Καλάθι, ' + quantity + ' προϊόντα'
      : 'Καλάθι, άδειο');
  }

  new MutationObserver(update).observe(cart, {
    childList: true,
    subtree: true,
    characterData: true
  });
  update();
})();
