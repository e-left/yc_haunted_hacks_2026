const app = document.querySelector('#app');
const searchInput = document.querySelector('#search-input');
const searchResults = document.querySelector('#search-results');
const searchForm = document.querySelector('#search-form');
const notice = document.querySelector('#delivery-popover');

let products = [];
let selectedAsin = 'B0DK3XH9HH';
let galleryView = 'main';
const selectedSizes = new Map();

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

const activeProduct = () => products.find((product) => product.asin === selectedAsin) ?? products[0];

function formatPrice(value) {
  const [whole, cents] = Number(value).toFixed(2).split('.');
  return `<span class="price-symbol">€</span><span class="price-whole">${whole}</span><sup>${cents}</sup>`;
}

function galleryContent(product) {
  if (galleryView === 'fabric') {
    return `<div class="gallery-fact"><span class="fact-icon">✦</span><small>FABRIC</small><strong>${escapeHtml(product.fabric)}</strong><p>From the linked listing information. Verify exact variant details before purchase.</p></div>`;
  }
  if (galleryView === 'fit') {
    return `<div class="gallery-fact"><span class="fact-icon">↔</span><small>FIT &amp; FEEL</small><strong>${escapeHtml(product.fit)}</strong><p>Plain basics made for everyday wear.</p></div>`;
  }
  return `<img class="hero-image ${galleryView === 'zoom' ? 'is-zoomed' : ''}" src="${escapeHtml(product.image)}" alt="${escapeHtml(product.shortName)}" />`;
}

function galleryThumb(product, view, label, content) {
  return `<button class="gallery-thumb ${galleryView === view ? 'selected' : ''}" type="button" data-view="${view}" aria-label="${escapeHtml(label)}" aria-pressed="${galleryView === view}">${content}</button>`;
}

function render() {
  const product = activeProduct();
  if (!product) return;
  document.title = `${product.shortName} | Amazombie`;
  const selectedSize = selectedSizes.get(product.asin) ?? product.defaultSize;
  const rating = product.rating ? `<div class="rating"><span>${product.rating.toFixed(1)}</span><span class="stars" aria-label="${product.rating} out of 5 stars">★★★★★</span><span class="rating-chevron">⌄</span><a href="#product-details">(${escapeHtml(product.reviewCount)})</a><span class="rating-divider">|</span><a href="#product-details">Search this page</a></div>` : '';
  const badge = product.badge ? `<div class="ranking"><strong>${escapeHtml(product.badge)}</strong><a href="#catalog">in Men's T-Shirts</a></div>` : '';
  const priceLabel = product.priceBasis.startsWith('Captured') ? 'Screenshot price' : 'Sample price';

  app.innerHTML = `
    <div class="catalog-strip"><span>Halloween hackathon demo</span><strong>Only the four products you linked are in this catalog.</strong><span>Prices and availability are not live.</span></div>
    <div class="breadcrumbs"><span>Fashion</span><span>›</span><span>Men</span><span>›</span><span>Clothing</span><span>›</span><span>T-Shirts</span><span>›</span><strong>${escapeHtml(product.brand)}</strong></div>
    <div class="product-layout">
      <section class="media-column" aria-label="Product media">
        <div class="gallery">
          <div class="gallery-rail" aria-label="Image and product views">
            ${galleryThumb(product, 'main', 'Main product image', `<img src="${escapeHtml(product.image)}" alt="" />`)}
            ${galleryThumb(product, 'zoom', 'Zoomed product image', `<img class="thumb-zoom" src="${escapeHtml(product.image)}" alt="" />`)}
            ${galleryThumb(product, 'fabric', 'Fabric details', `<span class="thumb-text">FABRIC<br /><b>100%</b></span>`)}
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
            <button type="button" data-question="What colours does it come in?">What colours does it come in?</button>
            <button type="button" data-question="Is it machine washable?">Is it machine washable?</button>
            <button type="button" data-question="Does it have a slim fit?">Does it have a slim fit?</button>
            <button class="ask-more" type="button" id="ask-more">Ask something else</button>
          </div>
          <form class="ask-form" id="ask-form" hidden><label for="ask-input">Ask about this item or the four-product catalog</label><div><input id="ask-input" type="text" placeholder="e.g. Which shirts are black?" /><button type="submit">Ask</button></div></form>
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
        <div class="price-line">${formatPrice(product.priceEur)}<span class="unit-price">${priceLabel}</span></div>
        <p class="vat">Prices include VAT. <span title="Product prices can change on the source listing">ⓘ</span></p>
        <div class="savings"><strong>Demo</strong><span>Sample inventory and size choices</span><a href="${escapeHtml(product.sourceUrl)}" target="_blank" rel="noopener noreferrer">View original listing ›</a></div>

        <section class="catalog-choices" id="catalog">
          <h2><span>Colour:</span> ${escapeHtml(product.color)}</h2>
          <p class="choices-caption">The four linked listings</p>
          <div class="choice-grid">
            ${products.map((item) => `<button type="button" class="choice-card ${item.asin === product.asin ? 'selected' : ''}" data-asin="${item.asin}" aria-pressed="${item.asin === product.asin}"><img src="${escapeHtml(item.image)}" alt="" /><span class="choice-info"><strong>€${item.priceEur.toFixed(2)}</strong><small>${escapeHtml(item.shortName)}</small></span></button>`).join('')}
          </div>
        </section>

        <section class="size-section">
          <h2><span>Size:</span> ${escapeHtml(selectedSize)}</h2>
          <div class="size-grid">${product.sizes.map((size) => `<button type="button" class="size-button ${size === selectedSize ? 'selected' : ''}" data-size="${escapeHtml(size)}" aria-pressed="${size === selectedSize}">${escapeHtml(size)}</button>`).join('')}</div>
          <details class="size-chart"><summary>Size chart</summary><p>Size options are for the demo interface. Exact garment measurements were not supplied, so length-based questions cannot be answered yet.</p></details>
        </section>

        <section class="product-details" id="product-details"><h2>Product details</h2><div class="rule"></div><h3>Top highlights</h3><ul>${product.highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><dl><div><dt>Brand</dt><dd>${escapeHtml(product.brand)}</dd></div><div><dt>Colour</dt><dd>${escapeHtml(product.color)}</dd></div><div><dt>Fabric</dt><dd>${escapeHtml(product.fabric)}</dd></div><div><dt>Fit</dt><dd>${escapeHtml(product.fit)}</dd></div><div><dt>ASIN</dt><dd>${escapeHtml(product.asin)}</dd></div></dl><p class="source-note">${escapeHtml(product.priceBasis)}. This catalog is a UI demo with no checkout or live stock feed.</p></section>
      </section>
    </div>`;

  bindProductEvents();
}

function chooseProduct(asin) {
  if (!products.some((product) => product.asin === asin)) return;
  selectedAsin = asin;
  galleryView = 'main';
  searchResults.hidden = true;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function answerQuestion(question, product) {
  const q = question.toLowerCase();
  if (/supplier|wholesale|cost price|private/.test(q)) return 'Supplier costs are private and are not part of this customer-facing catalog.';
  if (/length|long|inch|measurement|under 30/.test(q)) return 'Body length is not present in the imported listing data. I cannot verify a length limit for these shirts.';
  if (/wash|care|dryer/.test(q)) return 'Care instructions were not verified for this selected listing. Please check the original product page before washing.';
  if (/colour|color|black|white/.test(q) && /which|all|catalog/.test(q)) {
    const matches = products.filter((item) => q.includes('black') ? item.color.toLowerCase().includes('black') : q.includes('white') ? item.color.toLowerCase().includes('white') : true);
    return matches.length ? `In this four-product catalog: ${matches.map((item) => item.shortName).join('; ')}.` : 'No matching product is in this four-product catalog.';
  }
  if (/colour|color/.test(q)) return `The linked variant shown here is ${product.color}. Other variants are outside this four-product demo.`;
  if (/slim|fit|tailor/.test(q)) return `The listed fit is ${product.fit}. Exact measurements are not available in the imported data.`;
  if (/cotton|fabric|material/.test(q)) return `Fabric information for this item: ${product.fabric}.`;
  if (/size/.test(q)) return `The demo size selector shows ${product.sizes.join(', ')}. Availability by size is not live.`;
  if (/price|cheap|cost/.test(q)) return `The displayed price is €${product.priceEur.toFixed(2)}. ${product.priceBasis}.`;
  if (/pack|how many/.test(q)) return `This listing shows a pack of ${product.packSize}.`;
  return 'I can answer from these four imported listings about color, fabric, fit, pack size, and the displayed sample price. I cannot verify missing measurements or live availability.';
}

function bindProductEvents() {
  app.querySelectorAll('[data-asin]').forEach((button) => button.addEventListener('click', () => chooseProduct(button.dataset.asin)));
  app.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => { galleryView = button.dataset.view; render(); }));
  app.querySelectorAll('[data-size]').forEach((button) => button.addEventListener('click', () => { selectedSizes.set(activeProduct().asin, button.dataset.size); render(); }));
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

function matchingProducts(query) {
  const q = query.trim().toLowerCase();
  if (!q) return products;
  return products.filter((product) => [product.name, product.shortName, product.brand, product.color, product.fabric, product.asin, ...product.highlights].some((value) => value.toLowerCase().includes(q)));
}

function showSearchResults() {
  const matches = matchingProducts(searchInput.value);
  searchResults.innerHTML = `<p class="results-heading">${matches.length} of 4 products</p>${matches.length ? matches.map((product) => `<button type="button" data-search-asin="${product.asin}"><img src="${escapeHtml(product.image)}" alt="" /><span><strong>${escapeHtml(product.shortName)}</strong><small>${escapeHtml(product.color)}</small></span><b>€${product.priceEur.toFixed(2)}</b></button>`).join('') : '<p class="no-results">No matching products. This demo contains only the four linked T-shirts.</p>'}`;
  searchResults.hidden = false;
  searchResults.querySelectorAll('[data-search-asin]').forEach((button) => button.addEventListener('click', () => chooseProduct(button.dataset.searchAsin)));
}

searchForm.addEventListener('submit', (event) => { event.preventDefault(); showSearchResults(); });
searchInput.addEventListener('focus', showSearchResults);
searchInput.addEventListener('input', showSearchResults);
searchInput.addEventListener('keydown', (event) => { if (event.key === 'Escape') searchResults.hidden = true; });
document.addEventListener('click', (event) => { if (!searchForm.contains(event.target)) searchResults.hidden = true; });
document.querySelector('#delivery-button').addEventListener('click', () => { notice.hidden = !notice.hidden; });
document.querySelector('#dismiss-notice').addEventListener('click', () => { notice.hidden = true; });
document.querySelector('#explore-catalog').addEventListener('click', () => { notice.hidden = true; searchInput.focus(); });
document.querySelector('#cart-button').addEventListener('click', () => showToast('Checkout is outside this demo.'));

try {
  const response = await fetch('data/products.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const catalog = await response.json();
  products = catalog.products;
  if (!Array.isArray(products) || products.length !== 4) throw new Error('Expected exactly four demo products');
  const requestedAsin = new URLSearchParams(location.search).get('asin');
  if (products.some((product) => product.asin === requestedAsin)) selectedAsin = requestedAsin;
  render();
} catch (error) {
  console.error(error);
  app.innerHTML = '<div class="loading error">The product catalog could not be loaded. Serve this folder with a local web server and reload.</div>';
  notice.hidden = true;
}
