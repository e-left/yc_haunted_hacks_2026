const CART_KEY = 'amazombie.cart.v1';
const ORDERS_KEY = 'amazombie.demo-orders.v1';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function writeStored(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* The checkout still works when browser storage is unavailable. */ }
}

export function createCheckout(products, onSelectProduct, supabase = null) {
  const dialog = document.querySelector('#cart-dialog');
  const basketButton = document.querySelector('#cart-button');
  const basketCount = document.querySelector('#cart-count');
  const byAsin = new Map(products.map((product) => [product.asin, product]));
  const storedCart = readStored(CART_KEY, []);
  let cart = (Array.isArray(storedCart) ? storedCart : []).filter((item) => {
    const product = byAsin.get(item.asin);
    return product && product.sizes.includes(item.size) && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10 && Number.isFinite(product.priceUsd);
  });
  let submitting = false;

  const itemCount = () => cart.reduce((count, item) => count + item.quantity, 0);
  const totalCents = () => cart.reduce((total, item) => total + Math.round(byAsin.get(item.asin).priceUsd * 100) * item.quantity, 0);
  const productFor = (item) => byAsin.get(item.asin);

  function saveCart() {
    writeStored(CART_KEY, cart);
    const count = itemCount();
    basketCount.textContent = count;
    basketCount.hidden = count === 0;
    basketButton.setAttribute('aria-label', `Open basket, ${count} ${count === 1 ? 'item' : 'items'}`);
  }

  function shell(title, body) {
    dialog.innerHTML = `<div class="checkout-shell"><header class="checkout-header"><div><small>AMAZOMBIE</small><h2 id="cart-title">${title}</h2></div><button type="button" class="checkout-close" data-cart-action="close" aria-label="Close">×</button></header>${body}</div>`;
    if (!dialog.open) dialog.showModal();
  }

  function cartLine(item) {
    const product = productFor(item);
    const lineTotal = Math.round(product.priceUsd * 100) * item.quantity;
    return `<li class="cart-line"><button type="button" class="cart-line-image" data-cart-action="product" data-asin="${item.asin}" aria-label="View ${escapeHtml(product.shortName)}"><img src="${escapeHtml(product.image)}" alt="" /></button><div class="cart-line-main"><button type="button" class="cart-line-title" data-cart-action="product" data-asin="${item.asin}">${escapeHtml(product.shortName)}</button><span>Size ${escapeHtml(item.size)} · ${money(Math.round(product.priceUsd * 100))} each</span><div class="cart-line-controls"><button type="button" data-cart-action="decrease" data-asin="${item.asin}" data-size="${escapeHtml(item.size)}" aria-label="Remove one ${escapeHtml(product.shortName)}">−</button><strong>${item.quantity}</strong><button type="button" data-cart-action="increase" data-asin="${item.asin}" data-size="${escapeHtml(item.size)}" aria-label="Add one ${escapeHtml(product.shortName)}" ${item.quantity >= 10 ? 'disabled' : ''}>+</button><button type="button" class="cart-remove" data-cart-action="remove" data-asin="${item.asin}" data-size="${escapeHtml(item.size)}">Remove</button></div></div><strong class="cart-line-price">${money(lineTotal)}</strong></li>`;
  }

  function orderTotals() {
    return `<div class="order-totals"><div><span>Items (${itemCount()})</span><strong>${money(totalCents())}</strong></div><div><span>Demo shipping</span><strong>Free</strong></div><div class="order-total"><span>Total</span><strong>${money(totalCents())}</strong></div></div>`;
  }

  function openCart() {
    const body = cart.length
      ? `<div class="checkout-content"><ul class="cart-lines">${cart.map(cartLine).join('')}</ul>${orderTotals()}<p class="checkout-disclaimer">Sample prices. This checkout places a demo order and does not charge a payment method.</p><button class="checkout-primary" type="button" data-cart-action="checkout">Continue to checkout</button><button class="checkout-secondary" type="button" data-cart-action="close">Continue shopping</button></div>`
      : `<div class="checkout-content cart-empty"><span aria-hidden="true">✦</span><h3>Your basket is empty</h3><p>Pick a T-shirt and size to get started.</p><button class="checkout-primary" type="button" data-cart-action="close">Browse T-shirts</button></div>`;
    shell('Your basket', body);
  }

  function openCheckout() {
    if (!cart.length) { openCart(); return; }
    shell('Checkout', `<div class="checkout-content"><button class="checkout-back" type="button" data-cart-action="cart">← Back to basket</button><form id="checkout-form"><p class="checkout-disclaimer">Demo checkout · no payment is collected. Delivery details are used only for this confirmation and are not saved. ${supabase ? 'Only the selected items and sample total are saved in Supabase.' : 'The order is saved in this browser.'}</p><h3>Delivery details</h3><div class="checkout-fields"><label class="field-wide">Full name<input name="fullName" autocomplete="name" required maxlength="80" placeholder="Alex Shopper" /></label><label class="field-wide">Email<input name="email" type="email" autocomplete="email" required maxlength="120" placeholder="alex@example.com" /></label><label class="field-wide">Street address<input name="street" autocomplete="street-address" required maxlength="120" placeholder="123 Main Street" /></label><label>City<input name="city" autocomplete="address-level2" required maxlength="80" /></label><label>State / region<input name="region" autocomplete="address-level1" required maxlength="80" /></label><label>Postal code<input name="postal" autocomplete="postal-code" required maxlength="20" /></label><label>Country<input name="country" autocomplete="country-name" required maxlength="80" value="United States" /></label></div><h3>Order summary</h3><ul class="checkout-summary">${cart.map((item) => `<li><span>${escapeHtml(productFor(item).shortName)} · ${escapeHtml(item.size)} × ${item.quantity}</span><strong>${money(Math.round(productFor(item).priceUsd * 100) * item.quantity)}</strong></li>`).join('')}</ul>${orderTotals()}<p class="checkout-error" role="alert" hidden></p><button class="checkout-primary" type="submit">Place demo order</button></form></div>`);
  }

  function completeOrder(name, remoteOrder = null) {
    const order = remoteOrder ? {
      id: `AZ-${remoteOrder.id.slice(0, 8).toUpperCase()}`,
      placedAt: remoteOrder.placedAt,
      items: cart.map(({ asin, size, quantity }) => ({ asin, size, quantity })),
      totalCents: remoteOrder.totalCents
    } : {
      id: `AZ-${Date.now().toString(36).toUpperCase()}`,
      placedAt: new Date().toISOString(),
      items: cart.map(({ asin, size, quantity }) => ({ asin, size, quantity })),
      totalCents: totalCents()
    };
    if (!remoteOrder) {
      const storedOrders = readStored(ORDERS_KEY, []);
      writeStored(ORDERS_KEY, [...(Array.isArray(storedOrders) ? storedOrders : []).slice(-19), order]);
    }
    cart = [];
    saveCart();
    const quantity = order.items.reduce((count, item) => count + item.quantity, 0);
    shell('Order placed', `<div class="checkout-content order-confirmation"><span class="confirmation-icon" aria-hidden="true">✓</span><h3>You're all set, ${escapeHtml(name.split(/\s+/)[0])}.</h3><p>Your demo order <strong>${order.id}</strong> is confirmed.</p><div class="confirmation-total"><span>${quantity} ${quantity === 1 ? 'item' : 'items'}</span><strong>${money(order.totalCents)}</strong></div><p class="checkout-disclaimer">${remoteOrder ? 'This demo order is saved in Supabase.' : 'This order is saved only in this browser.'} No payment was charged and no delivery request was sent.</p><button class="checkout-primary" type="button" data-cart-action="close">Continue shopping</button></div>`);
  }

  function add(asin, size, quantity = 1, goToCheckout = false) {
    if (submitting) return;
    const product = byAsin.get(asin);
    if (!product || !product.sizes.includes(size) || !Number.isFinite(product.priceUsd)) return;
    const amount = Math.min(10, Math.max(1, Number(quantity) || 1));
    const existing = cart.find((item) => item.asin === asin && item.size === size);
    if (existing) existing.quantity = Math.min(10, existing.quantity + amount);
    else cart.push({ asin, size, quantity: amount });
    saveCart();
    if (goToCheckout) openCheckout(); else openCart();
  }

  dialog.addEventListener('click', (event) => {
    if (submitting) return;
    if (event.target === dialog) { dialog.close(); return; }
    const button = event.target.closest('[data-cart-action]');
    if (!button) return;
    const action = button.dataset.cartAction;
    if (action === 'close') { dialog.close(); return; }
    if (action === 'cart') { openCart(); return; }
    if (action === 'checkout') { openCheckout(); return; }
    if (action === 'product') { dialog.close(); onSelectProduct(button.dataset.asin); return; }
    const item = cart.find((entry) => entry.asin === button.dataset.asin && entry.size === button.dataset.size);
    if (!item) return;
    if (action === 'increase') item.quantity = Math.min(10, item.quantity + 1);
    if (action === 'decrease') item.quantity -= 1;
    if (action === 'remove' || item.quantity < 1) cart = cart.filter((entry) => entry !== item);
    saveCart();
    openCart();
  });

  dialog.addEventListener('submit', async (event) => {
    if (event.target.id !== 'checkout-form') return;
    event.preventDefault();
    if (submitting) return;
    if (!cart.length) { openCart(); return; }
    const name = String(new FormData(event.target).get('fullName') ?? '').trim();
    if (!name) return;
    if (!supabase) { completeOrder(name); return; }
    submitting = true;
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Placing order…';
    try {
      const items = cart.map(({ asin, size, quantity }) => ({ asin, size, quantity }));
      const order = await supabase.placeOrder(items);
      completeOrder(name, order);
    } catch (error) {
      console.error(error);
      const message = event.target.querySelector('.checkout-error');
      message.textContent = `The order could not be saved. ${error.message}`;
      message.hidden = false;
    } finally {
      submitting = false;
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'Place demo order';
      }
    }
  });

  basketButton.addEventListener('click', openCart);
  saveCart();
  return { add, openCart, openCheckout };
}
