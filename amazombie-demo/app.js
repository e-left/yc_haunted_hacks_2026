import { createCheckout } from './checkout.js';
import { createSupabaseClient } from './supabase.js';

const app = document.querySelector('#app');
const searchInput = document.querySelector('#search-input');
const searchForm = document.querySelector('#search-form');
const notice = document.querySelector('#delivery-popover');

let products = [];
let checkout;
let selectedAsin = null;
let searchQuery = '';
let colorFilter = '';
let sizeFilter = '';
let sortBy = 'featured';
let galleryView = 'main';
const selectedSizes = new Map();
const colorOptions = [
  { name: 'Black', value: '#202124' },
  { name: 'White', value: '#ffffff' },
  { name: 'Grey', value: '#8b8d8e' },
  { name: 'Navy', value: '#243e64' },
  { name: 'Green', value: '#79a55c' },
  { name: 'Burgundy', value: '#71363d' }
];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const activeProduct = () => products.find((product) => product.asin === selectedAsin);

function formatPrice(value) {
  const [whole, cents] = Number(value).toFixed(2).split('.');
  return `<span class="price-symbol">$</span><span class="price-whole">${whole}</span><sup>${cents}</sup>`;
}

const compactPrice = (product) => product.priceUsd == null ? 'View price' : `$${product.priceUsd.toFixed(2)}`;

function currentHomeUrl() {
  return searchQuery.trim() ? `?q=${encodeURIComponent(searchQuery.trim())}` : location.pathname;
}

function matchingProducts(query) {
  const q = query.trim().toLowerCase();
  return products.filter((product) => {
    const matchesText = !q || [product.name, product.shortName, product.brand, product.color, product.fabric, product.asin, ...product.highlights]
      .some((value) => String(value).toLowerCase().includes(q));
    const normalizedColor = product.color.toLowerCase().replace(/gray/g, 'grey');
    return matchesText && (!colorFilter || normalizedColor.includes(colorFilter.toLowerCase())) && (!sizeFilter || product.sizes.includes(sizeFilter));
  }).sort((a, b) => {
    if (sortBy === 'price') return (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity);
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return 0;
  });
}

function homeCard(product) {
  return `<article class="result-card">
    <button class="result-image" type="button" data-asin="${product.asin}" aria-label="View ${escapeHtml(product.shortName)}">
      ${product.badge ? `<span class="result-badge">${escapeHtml(product.badge.replace(/^#1 /, ''))}</span>` : ''}
      <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.shortName)}" loading="lazy" />
    </button>
    <div class="result-info">
      <span class="result-brand">${escapeHtml(product.brand)}</span>
      <button class="result-title" type="button" data-asin="${product.asin}">${escapeHtml(product.name)}</button>
      ${product.rating ? `<div class="result-rating"><span>${product.rating.toFixed(1)}</span><span class="stars" aria-label="${product.rating} out of 5 stars">★★★★★</span><span class="review-count">(${escapeHtml(product.reviewCount)})</span></div>` : '<div class="result-rating result-rating-empty">Details from the source listing</div>'}
      <div class="result-price">${product.priceUsd == null ? '<span class="price-prompt">See price on listing</span>' : `<strong>${formatPrice(product.priceUsd)}</strong><small>Sample price</small>`}</div>
      <p class="result-color">${escapeHtml(product.color)}</p>
      <button class="result-action" type="button" data-asin="${product.asin}">View details</button>
    </div>
  </article>`;
}

function renderHome() {
  selectedAsin = null;
  const matches = matchingProducts(searchQuery);
  document.title = 'Amazombie | T-shirts for the living';
  app.innerHTML = `
    <section class="home-hero" aria-label="Amazombie introduction">
      <div><span class="hero-eyebrow">THE BASICS ARE ALIVE</span><h1>Dead simple tees.<br /><em>Seriously good finds.</em></h1><p>Everyday T-shirts, unearthed in one place.</p></div>
      <div class="hero-stamp"><span>✦</span><strong>${products.length}</strong><small>tees in the crypt</small></div>
    </section>
    <div class="home-context"><span>Clothing <b>›</b> Men's T-Shirts</span><span>Sample prices · original listing links on every product page</span></div>
    <div class="results-layout" id="results">
      <aside class="filters" aria-label="Filter T-shirts">
        <div class="filters-top"><h2>Filters</h2><button type="button" data-clear-filters>Clear</button></div>
        <section class="filter-group"><h3>Colour</h3><div class="swatches">
          ${colorOptions.map((color) => `<button type="button" class="swatch ${colorFilter === color.name ? 'active' : ''}" data-color="${color.name}" title="${color.name}" aria-label="Filter ${color.name} T-shirts" aria-pressed="${colorFilter === color.name}" style="--swatch:${color.value}"><span></span></button>`).join('')}
        </div><p class="filter-hint">Colours are filtered from captured listing text.</p></section>
        <section class="filter-group"><h3>Men's Size</h3><div class="filter-sizes">
          ${['S', 'M', 'L', 'XL', 'XXL', '3XL'].map((size) => `<button type="button" class="filter-size ${sizeFilter === size ? 'active' : ''}" data-filter-size="${size}" aria-pressed="${sizeFilter === size}">${size}</button>`).join('')}
        </div><p class="filter-hint">Size choices are illustrative.</p></section>
        <div class="filter-note"><span>✦</span><strong>Shop the living basics</strong><p>Pick a shirt to see colors, sizes, fabric details, and its original listing.</p></div>
      </aside>
      <section class="results-main" aria-label="T-shirt results">
        <div class="results-heading"><div><span class="results-kicker">AMAZOMBIE FINDS</span><h2>${searchQuery.trim() ? `Results for “${escapeHtml(searchQuery.trim())}”` : 'T-shirts worth resurrecting'}</h2><p>${matches.length} ${matches.length === 1 ? 'result' : 'results'}${colorFilter ? ` · ${escapeHtml(colorFilter)}` : ''}${sizeFilter ? ` · Size ${escapeHtml(sizeFilter)}` : ''}</p></div><label class="sort-control">Sort by <select id="sort-select"><option value="featured" ${sortBy === 'featured' ? 'selected' : ''}>Featured</option><option value="price" ${sortBy === 'price' ? 'selected' : ''}>Price: low to high</option><option value="name" ${sortBy === 'name' ? 'selected' : ''}>Name</option></select></label></div>
        ${matches.length ? `<div class="result-grid">${matches.map(homeCard).join('')}</div>` : '<div class="empty-results"><strong>No tees in this corner of the crypt.</strong><p>Try another search or clear the filters.</p><button type="button" data-clear-filters>Clear filters</button></div>'}
      </section>
    </div>`;
  app.querySelectorAll('[data-asin]').forEach((button) => button.addEventListener('click', () => chooseProduct(button.dataset.asin)));
  app.querySelectorAll('[data-color]').forEach((button) => button.addEventListener('click', () => { colorFilter = colorFilter === button.dataset.color ? '' : button.dataset.color; renderHome(); }));
  app.querySelectorAll('[data-filter-size]').forEach((button) => button.addEventListener('click', () => { sizeFilter = sizeFilter === button.dataset.filterSize ? '' : button.dataset.filterSize; renderHome(); }));
  app.querySelectorAll('[data-clear-filters]').forEach((button) => button.addEventListener('click', () => { colorFilter = ''; sizeFilter = ''; searchQuery = ''; searchInput.value = ''; history.replaceState({}, '', location.pathname); renderHome(); }));
  app.querySelector('#sort-select').addEventListener('change', (event) => { sortBy = event.target.value; renderHome(); });
}

function galleryContent(product) {
  if (galleryView === 'fabric') {
    return `<div class="gallery-fact"><span class="fact-icon">✦</span><small>FABRIC</small><strong>${escapeHtml(product.fabric)}</strong><p>See the source listing for complete variant details.</p></div>`;
  }
  if (galleryView === 'fit') {
    return `<div class="gallery-fact"><span class="fact-icon">↔</span><small>FIT &amp; FEEL</small><strong>${escapeHtml(product.fit)}</strong><p>Plain basics made for everyday wear.</p></div>`;
  }
  return `<img class="hero-image ${galleryView === 'zoom' ? 'is-zoomed' : ''}" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.shortName)}" />`;
}

function galleryThumb(product, view, label, content) {
  return `<button class="gallery-thumb ${galleryView === view ? 'selected' : ''}" type="button" data-view="${view}" aria-label="${escapeHtml(label)}" aria-pressed="${galleryView === view}">${content}</button>`;
}

function renderProduct() {
  const product = activeProduct();
  if (!product) return;
  document.title = `${product.shortName} | Amazombie`;
  const selectedSize = selectedSizes.get(product.asin) ?? product.defaultSize;
  const quickPicks = [product, ...products.filter((item) => item.asin !== product.asin).slice(0, 3)];
  const rating = product.rating ? `<div class="rating"><span>${product.rating.toFixed(1)}</span><span class="stars" aria-label="${product.rating} out of 5 stars">★★★★★</span><span class="rating-chevron">⌄</span><a href="#product-details">(${escapeHtml(product.reviewCount)})</a><span class="rating-divider">|</span><a href="#product-details">Search this page</a></div>` : '';
  const badge = product.badge ? `<div class="ranking"><strong>${escapeHtml(product.badge)}</strong><a href="#catalog">in Men's T-Shirts</a></div>` : '';
  const priceLabel = product.priceUsd == null ? 'Price not captured' : 'Sample price';
  const priceDisplay = product.priceUsd == null ? `<a class="price-unavailable" href="${escapeHtml(product.sourceUrl)}" target="_blank" rel="noopener noreferrer">See price on source listing ›</a>` : formatPrice(product.priceUsd);

  app.innerHTML = `
    <div class="catalog-strip"><span>AMAZOMBIE FINDS</span><strong>${products.length} T-shirts in the catalog</strong><button type="button" data-go-home>← All T-shirts</button></div>
    <div class="breadcrumbs"><button type="button" data-go-home>All T-shirts</button><span>›</span><strong>${escapeHtml(product.brand)}</strong></div>
    <div class="product-layout">
      <section class="media-column" aria-label="Product media">
        <div class="gallery">
          <div class="gallery-rail" aria-label="Image and product views">
            ${galleryThumb(product, 'main', 'Main product image', `<img src="${escapeHtml(product.image)}" alt="" />`)}
            ${galleryThumb(product, 'zoom', 'Zoomed product image', `<img class="thumb-zoom" src="${escapeHtml(product.image)}" alt="" />`)}
            ${galleryThumb(product, 'fabric', 'Fabric details', `<span class="thumb-text">FABRIC<br /><b>✦</b></span>`)}
            ${galleryThumb(product, 'fit', 'Fit details', `<span class="thumb-text">FIT<br /><b>↔</b></span>`)}
          </div>
          <div class="hero-stage" id="hero-stage">
            ${galleryContent(product)}
            <div class="hero-actions"><button id="share-button" type="button" aria-label="Copy product link">↥</button><button id="favorite-button" type="button" aria-label="Save product">♡</button></div>
          </div>
        </div>

        <section class="ask-panel" aria-label="Ask Amazombie demo">
          <h2><span class="ask-spark">✦</span> Ask Amazombie <span class="ask-label">local demo</span></h2>
          <div class="ask-chips">
            <button type="button" data-question="What colors does it come in?">What colors does it come in?</button>
            <button type="button" data-question="Is it machine washable?">Is it machine washable?</button>
            <button type="button" data-question="Does it have a slim fit?">Does it have a slim fit?</button>
            <button class="ask-more" type="button" id="ask-more">Ask something else</button>
          </div>
          <form class="ask-form" id="ask-form" hidden><label for="ask-input">Ask about this item or the catalog</label><div><input id="ask-input" type="text" placeholder="e.g. Which shirts are black?" /><button type="submit">Ask</button></div></form>
          <p class="ask-answer" id="ask-answer" role="status" hidden></p>
        </section>
      </section>

      <section class="details-column" aria-label="Product details">
        <a class="store-link" href="${escapeHtml(product.sourceUrl)}" target="_blank" rel="noopener noreferrer">Visit the ${escapeHtml(product.brand)} listing</a>
        <h1>${escapeHtml(product.name)}</h1>
        ${rating}
        <div class="safety-note"><span>♧</span><u>Everyday essentials</u></div>
        ${badge}
        <div class="purchase-count">Product details captured for this demo</div>
        <div class="rule"></div>
        <div class="price-line">${priceDisplay}<span class="unit-price">${priceLabel}</span></div>
        <p class="price-disclaimer">Prices may vary by seller, size, and color. <span title="This is a demo catalog, not a live price feed">ⓘ</span></p>
        <div class="savings"><strong>Demo</strong><span>Sample inventory and size choices</span><a href="${escapeHtml(product.sourceUrl)}" target="_blank" rel="noopener noreferrer">View original listing ›</a></div>

        <section class="catalog-choices" id="catalog">
          <h2><span>Color:</span> ${escapeHtml(product.color)}</h2>
          <p class="choices-caption">Quick picks · <a href="#browse">browse all ${products.length}</a></p>
          <div class="choice-grid">
            ${quickPicks.map((item) => `<button type="button" class="choice-card ${item.asin === product.asin ? 'selected' : ''}" data-asin="${item.asin}" aria-pressed="${item.asin === product.asin}"><img src="${escapeHtml(item.image)}" alt="" /><span class="choice-info"><strong>${compactPrice(item)}</strong><small>${escapeHtml(item.shortName)}</small></span></button>`).join('')}
          </div>
        </section>

        <section class="size-section">
          <h2><span>Size:</span> ${escapeHtml(selectedSize)}</h2>
          <div class="size-grid">${product.sizes.map((size) => `<button type="button" class="size-button ${size === selectedSize ? 'selected' : ''}" data-size="${escapeHtml(size)}" aria-pressed="${size === selectedSize}">${escapeHtml(size)}</button>`).join('')}</div>
          <details class="size-chart"><summary>Size chart</summary><p>Size options are illustrative. Some source listings show measurements in images; this demo does not transcribe garment lengths into text.</p></details>
        </section>

        <section class="purchase-panel" id="purchase" aria-label="Buy this T-shirt">
          <div><strong>${compactPrice(product)}</strong><span>Sample price · Size ${escapeHtml(selectedSize)}</span></div>
          <label for="product-quantity">Quantity<select id="product-quantity">${[1, 2, 3, 4, 5].map((amount) => `<option value="${amount}">${amount}</option>`).join('')}</select></label>
          <div class="purchase-actions"><button type="button" id="add-to-basket">Add to basket</button><button type="button" id="buy-now">Buy now</button></div>
          <p>Demo checkout · no payment is collected.</p>
        </section>

        <section class="product-details" id="product-details"><h2>Product details</h2><div class="rule"></div><h3>Top highlights</h3><ul>${product.highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><dl><div><dt>Brand</dt><dd>${escapeHtml(product.brand)}</dd></div><div><dt>Color</dt><dd>${escapeHtml(product.color)}</dd></div><div><dt>Fabric</dt><dd>${escapeHtml(product.fabric)}</dd></div><div><dt>Fit</dt><dd>${escapeHtml(product.fit)}</dd></div><div><dt>ASIN</dt><dd>${escapeHtml(product.asin)}</dd></div></dl><p class="source-note">${escapeHtml(product.priceBasis)}. Stock is not live; checkout creates a demo order.</p></section>
      </section>
    </div>
    <section class="browse-section" id="browse" aria-label="Scrollable T-shirt catalog">
      <div class="browse-heading"><div><small>MORE TO DISCOVER</small><h2>Browse all ${products.length} T-shirts</h2><p>Scroll through the catalog or use the arrows to explore.</p></div><div class="browse-controls"><button type="button" data-scroll="-1" aria-label="Scroll catalog left">‹</button><button type="button" data-scroll="1" aria-label="Scroll catalog right">›</button></div></div>
      <div class="browse-track" id="browse-track" tabindex="0">
        ${products.map((item) => `<button class="browse-card ${item.asin === product.asin ? 'selected' : ''}" type="button" data-asin="${item.asin}"><span class="browse-photo"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" /></span><span class="browse-name">${escapeHtml(item.shortName)}</span><span class="browse-brand">${escapeHtml(item.brand)}</span><strong>${compactPrice(item)}</strong></button>`).join('')}
      </div>
    </section>`;

  bindProductEvents();
}

function chooseProduct(asin) {
  if (!products.some((product) => product.asin === asin)) return;
  selectedAsin = asin;
  galleryView = 'main';
  history.pushState({}, '', `?asin=${encodeURIComponent(asin)}`);
  renderProduct();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goHome(clearSearch = false) {
  selectedAsin = null;
  if (clearSearch) {
    searchQuery = '';
    searchInput.value = '';
  }
  history.pushState({}, '', currentHomeUrl());
  renderHome();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function answerQuestion(question, product) {
  const q = question.toLowerCase();
  if (/supplier|wholesale|cost price|private/.test(q)) return 'Supplier costs are private and are not part of this customer-facing catalog.';
  if (/length|long|inch|measurement|under 30/.test(q)) return 'Body length is not present in the imported listing data. I cannot verify a length limit for these shirts.';
  if (/wash|care|dryer/.test(q)) return 'Care instructions were not verified for this selected listing. Please check the original product page before washing.';
  if (/colour|color|black|white/.test(q) && /which|all|catalog/.test(q)) {
    const matches = products.filter((item) => q.includes('black') ? item.color.toLowerCase().includes('black') : q.includes('white') ? item.color.toLowerCase().includes('white') : true);
    return matches.length ? `Among the ${products.length} listed shirts with verified color text: ${matches.map((item) => item.shortName).join('; ')}.` : 'No verified color match is in this catalog. Some listings only show color in their images.';
  }
  if (/colour|color/.test(q)) return product.color === 'As pictured' ? 'The color is shown in the product image but was not captured as text. Check the source listing for the exact variant name.' : `The linked variant shown here is ${product.color}.`;
  if (/slim|fit|tailor/.test(q)) return product.fit === 'Not verified' ? 'Fit was not verified in the imported listing data.' : `The listed fit is ${product.fit}. Exact measurements are not available in the imported data.`;
  if (/cotton|fabric|material/.test(q)) return product.fabric === 'Not verified' ? 'Fabric composition was not verified in the imported listing data.' : `Fabric information for this item: ${product.fabric}.`;
  if (/size/.test(q)) return `The demo size selector shows ${product.sizes.join(', ')}. Availability by size is not live.`;
  if (/price|cheap|cost/.test(q)) return product.priceUsd == null ? 'A current price was not captured for this listing. Check the source product page.' : `The displayed sample price is $${product.priceUsd.toFixed(2)}. ${product.priceBasis}.`;
  if (/pack|how many/.test(q)) return product.packSize == null ? 'The pack size was not verified in the imported listing data.' : `This listing shows a pack of ${product.packSize}.`;
  return `I can answer from these ${products.length} imported listings about verified color, fabric, fit, and pack details. I cannot verify missing measurements or live availability.`;
}

function bindProductEvents() {
  app.querySelectorAll('[data-asin]').forEach((button) => button.addEventListener('click', () => chooseProduct(button.dataset.asin)));
  app.querySelectorAll('[data-go-home]').forEach((button) => button.addEventListener('click', () => goHome()));
  app.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => {
    const track = app.querySelector('#browse-track');
    track.scrollBy({ left: Number(button.dataset.scroll) * Math.max(track.clientWidth * 0.8, 250), behavior: 'smooth' });
  }));
  app.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { galleryView = button.dataset.view; renderProduct(); }));
  app.querySelectorAll('[data-size]').forEach((button) => button.addEventListener('click', () => { selectedSizes.set(activeProduct().asin, button.dataset.size); renderProduct(); }));
  app.querySelector('#add-to-basket').addEventListener('click', () => checkout.add(activeProduct().asin, selectedSizes.get(activeProduct().asin) ?? activeProduct().defaultSize, Number(app.querySelector('#product-quantity').value)));
  app.querySelector('#buy-now').addEventListener('click', () => checkout.add(activeProduct().asin, selectedSizes.get(activeProduct().asin) ?? activeProduct().defaultSize, Number(app.querySelector('#product-quantity').value), true));
  app.querySelectorAll('[data-question]').forEach((button) => button.addEventListener('click', () => {
    const answer = app.querySelector('#ask-answer');
    answer.textContent = answerQuestion(button.dataset.question, activeProduct());
    answer.hidden = false;
  }));
  app.querySelector('#ask-more').addEventListener('click', () => {
    const form = app.querySelector('#ask-form');
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input').focus();
  });
  app.querySelector('#ask-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = app.querySelector('#ask-answer');
    const question = app.querySelector('#ask-input').value.trim();
    if (!question) return;
    answer.textContent = answerQuestion(question, activeProduct());
    answer.hidden = false;
  });
  app.querySelector('#share-button').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?asin=${activeProduct().asin}`;
    try { await navigator.clipboard.writeText(url); showToast('Product link copied'); }
    catch { showToast(`Product ASIN: ${activeProduct().asin}`); }
  });
  app.querySelector('#favorite-button').addEventListener('click', (event) => {
    const saved = event.currentTarget.classList.toggle('saved');
    event.currentTarget.textContent = saved ? '♥' : '♡';
    showToast(saved ? 'Saved for this visit' : 'Removed from saved items');
  });
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2800);
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  searchQuery = searchInput.value.trim();
  goHome();
  document.querySelector('#results')?.scrollIntoView({ behavior: 'smooth' });
});
searchInput.addEventListener('input', () => {
  if (selectedAsin || !products.length) return;
  searchQuery = searchInput.value;
  history.replaceState({}, '', currentHomeUrl());
  renderHome();
});
document.querySelectorAll('[data-home], .brand').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); goHome(true); }));
document.querySelector('[data-browse-home]').addEventListener('click', (event) => { event.preventDefault(); goHome(); document.querySelector('#results')?.scrollIntoView({ behavior: 'smooth' }); });
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(location.search);
  selectedAsin = products.some((product) => product.asin === params.get('asin')) ? params.get('asin') : null;
  searchQuery = params.get('q') ?? '';
  searchInput.value = searchQuery;
  if (selectedAsin) renderProduct(); else renderHome();
});
document.querySelector('#delivery-button').addEventListener('click', () => { notice.hidden = !notice.hidden; });
document.querySelector('#dismiss-notice').addEventListener('click', () => { notice.hidden = true; });
document.querySelector('#explore-catalog').addEventListener('click', () => { notice.hidden = true; goHome(); document.querySelector('#results')?.scrollIntoView({ behavior: 'smooth' }); });

try {
  let supabase = createSupabaseClient();
  const response = await fetch('data/products.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const catalog = await response.json();
  products = catalog.products;
  if (!Array.isArray(products) || products.length === 0) throw new Error('No demo products found');
  if (supabase) {
    try {
      const remoteRows = await supabase.catalog();
      if (!remoteRows.length || remoteRows.some((product) =>
        !product.asin || !product.name || !product.image ||
        !Array.isArray(product.sizes) || !product.sizes.length ||
        !Array.isArray(product.highlights) || !Number.isFinite(product.priceUsd)
      )) throw new Error('Supabase returned an incomplete Amazombie catalog');
      products = remoteRows;
    } catch (error) {
      console.error('Supabase catalog unavailable:', error);
      supabase = null;
      notice.querySelector('p').textContent = 'Supabase is unavailable, so Amazombie is using its local demo catalog and checkout. Check the project key and database migration.';
      notice.hidden = false;
    }
  }
  checkout = createCheckout(products, chooseProduct, supabase);
  const params = new URLSearchParams(location.search);
  const requestedAsin = params.get('asin');
  selectedAsin = products.some((product) => product.asin === requestedAsin) ? requestedAsin : null;
  searchQuery = params.get('q') ?? '';
  searchInput.value = searchQuery;
  if (selectedAsin) renderProduct(); else renderHome();
} catch (error) {
  console.error(error);
  app.innerHTML = '<div class="loading error">The product catalog could not be loaded. Serve this folder with a local web server and reload.</div>';
  notice.hidden = true;
}
