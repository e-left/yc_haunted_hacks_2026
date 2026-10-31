import type { Product } from "../lib/product";

export type CatalogFilters = { color: string; size: string; sort: "featured" | "price" | "name" };

const colors = [
  { name: "Black", value: "#202124" },
  { name: "White", value: "#ffffff" },
  { name: "Grey", value: "#8b8d8e" },
  { name: "Navy", value: "#243e64" },
  { name: "Green", value: "#79a55c" },
  { name: "Burgundy", value: "#71363d" },
];

export function CatalogHome({ products, search, filters, onFiltersChange, onClear, onChoose }: {
  products: Product[];
  search: string;
  filters: CatalogFilters;
  onFiltersChange: (filters: CatalogFilters) => void;
  onClear: () => void;
  onChoose: (asin: string) => void;
}) {
  const query = search.trim().toLowerCase();
  const matches = products.filter((product) => {
    const matchesText = !query || [product.name, product.shortName, product.brand, product.color, product.fabric, product.asin, ...product.highlights].some((value) => value.toLowerCase().includes(query));
    const color = product.color.toLowerCase().replace(/gray/g, "grey");
    return matchesText && (!filters.color || color.includes(filters.color.toLowerCase())) && (!filters.size || product.sizes.includes(filters.size));
  }).sort((a, b) => {
    if (filters.sort === "price") return (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity);
    if (filters.sort === "name") return a.name.localeCompare(b.name);
    return 0;
  });

  return <>
    <section className="home-hero" aria-label="Amazombie introduction"><div><span className="hero-eyebrow">THE BASICS ARE ALIVE</span><h1>Dead simple tees.<br /><em>Seriously good finds.</em></h1><p>Everyday T-shirts, unearthed in one place.</p></div><div className="hero-stamp"><span>✦</span><strong>{products.length}</strong><small>tees in the crypt</small></div></section>
    <div className="home-context"><span>Clothing <b>›</b> Men&apos;s T-Shirts</span><span>Sample prices · original listing links on every product page</span></div>
    <div className="results-layout" id="results">
      <aside className="filters" aria-label="Filter T-shirts"><div className="filters-top"><h2>Filters</h2><button type="button" onClick={onClear}>Clear</button></div>
        <section className="filter-group"><h3>Colour</h3><div className="swatches">{colors.map((color) => <button type="button" key={color.name} className={`swatch ${filters.color === color.name ? "active" : ""}`} title={color.name} aria-label={`Filter ${color.name} T-shirts`} aria-pressed={filters.color === color.name} onClick={() => onFiltersChange({ ...filters, color: filters.color === color.name ? "" : color.name })}><span style={{ background: color.value }} /></button>)}</div><p className="filter-hint">Colours are filtered from captured listing text.</p></section>
        <section className="filter-group"><h3>Men&apos;s Size</h3><div className="filter-sizes">{["S", "M", "L", "XL", "XXL", "3XL"].map((size) => <button type="button" key={size} className={`filter-size ${filters.size === size ? "active" : ""}`} aria-pressed={filters.size === size} onClick={() => onFiltersChange({ ...filters, size: filters.size === size ? "" : size })}>{size}</button>)}</div><p className="filter-hint">Size choices are illustrative.</p></section>
        <div className="filter-note"><span>✦</span><strong>Shop the living basics</strong><p>Pick a shirt to see colors, sizes, fabric details, and its original listing.</p></div>
      </aside>
      <section className="results-main" aria-label="T-shirt results"><div className="results-heading"><div><span className="results-kicker">AMAZOMBIE FINDS</span><h2>{search.trim() ? `Results for “${search.trim()}”` : "T-shirts worth resurrecting"}</h2><p>{matches.length} {matches.length === 1 ? "result" : "results"}{filters.color && ` · ${filters.color}`}{filters.size && ` · Size ${filters.size}`}</p></div><label className="sort-control">Sort by <select value={filters.sort} onChange={(event) => onFiltersChange({ ...filters, sort: event.target.value as CatalogFilters["sort"] })}><option value="featured">Featured</option><option value="price">Price: low to high</option><option value="name">Name</option></select></label></div>
        {matches.length ? <div className="result-grid">{matches.map((product) => <article className="result-card" key={product.asin}><button className="result-image" type="button" aria-label={`View ${product.shortName}`} onClick={() => onChoose(product.asin)}>{product.badge && <span className="result-badge">{product.badge.replace(/^#1 /, "")}</span>}<img src={`/${product.image}`} alt={product.shortName} loading="lazy" /></button><div className="result-info"><span className="result-brand">{product.brand}</span><button className="result-title" type="button" onClick={() => onChoose(product.asin)}>{product.name}</button>{product.rating != null ? <div className="result-rating"><span>{product.rating.toFixed(1)}</span><span className="stars" aria-label={`${product.rating} out of 5 stars`}>★★★★★</span><span className="review-count">({product.reviewCount})</span></div> : <div className="result-rating result-rating-empty">Details from the source listing</div>}<div className="result-price">{product.priceUsd == null ? <span className="price-prompt">See price on listing</span> : <><strong><span className="price-symbol">$</span><span className="price-whole">{product.priceUsd.toFixed(2).split(".")[0]}</span><sup>{product.priceUsd.toFixed(2).split(".")[1]}</sup></strong><small>Sample price</small></>}</div><p className="result-color">{product.color}</p><button className="result-action" type="button" onClick={() => onChoose(product.asin)}>View details</button></div></article>)}</div> : <div className="empty-results"><strong>No tees in this corner of the crypt.</strong><p>Try another search or clear the filters.</p><button type="button" onClick={onClear}>Clear filters</button></div>}
      </section>
    </div>
  </>;
}
