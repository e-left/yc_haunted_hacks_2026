"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Product } from "../lib/product";
import { CatalogHome, type CatalogFilters } from "./catalog-home";
import { Checkout, type CheckoutHandle } from "./checkout";

type GalleryView = "main" | "zoom" | "fabric" | "fit";
const questions = ["What colors does it come in?", "Is it machine washable?", "Does it have a slim fit?"];
const price = (product: Product) => product.priceUsd == null ? "View price" : `$${product.priceUsd.toFixed(2)}`;
const imageUrl = (product: Product) => `/${product.image}`;

export function Storefront({ products, initialAsin, initialSearch }: { products: Product[]; initialAsin?: string; initialSearch?: string }) {
  const [selectedAsin, setSelectedAsin] = useState<string | null>(products.find((item) => item.asin === initialAsin)?.asin ?? null);
  const [galleryView, setGalleryView] = useState<GalleryView>("main");
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const [search, setSearch] = useState(initialSearch ?? "");
  const [filters, setFilters] = useState<CatalogFilters>({ color: "", size: "", sort: "featured" });
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);
  const [toast, setToast] = useState("");
  const [cartCount, setCartCount] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const checkoutRef = useRef<CheckoutHandle>(null);
  const browseRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const product = products.find((item) => item.asin === selectedAsin);
  const selectedSize = product ? sizes[product.asin] ?? product.defaultSize : "";
  const quickPicks = product ? [product, ...products.filter((item) => item.asin !== product.asin).slice(0, 3)] : [];

  useEffect(() => {
    document.title = product ? `${product.shortName} | Amazombie` : "Amazombie | T-shirts for the living";
  }, [product]);
  useEffect(() => {
    const restoreLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const asin = params.get("asin");
      requestRef.current++;
      setSelectedAsin(products.find((item) => item.asin === asin)?.asin ?? null);
      setSearch(params.get("q") ?? "");
      setGalleryView("main");
      setAnswer("");
      setAsking(false);
    };
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [products]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function chooseProduct(asin: string) {
    if (!products.some((item) => item.asin === asin)) return;
    requestRef.current++;
    setSelectedAsin(asin);
    setGalleryView("main");
    setQuantity(1);
    setAnswer("");
    setAsking(false);
    window.history.pushState({}, "", `/?asin=${encodeURIComponent(asin)}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goHome(clearSearch = false) {
    requestRef.current++;
    setSelectedAsin(null);
    setAnswer("");
    setAsking(false);
    const query = clearSearch ? "" : search.trim();
    if (clearSearch) setSearch("");
    window.history.pushState({}, "", query ? `/?q=${encodeURIComponent(query)}` : "/");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function clearFilters() {
    setFilters({ ...filters, color: "", size: "" });
    setSearch("");
    window.history.replaceState({}, "", "/");
  }

  async function ask(value: string) {
    const trimmed = value.trim();
    if (!trimmed || !product) return;
    const requestId = ++requestRef.current;
    setAsking(true);
    setAnswer("");
    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, asin: product.asin }),
      });
      const result: { answer?: string; error?: string } = await response.json();
      if (!response.ok || !result.answer) throw new Error(result.error ?? "Unable to answer right now.");
      if (requestId === requestRef.current) setAnswer(result.answer);
    } catch {
      if (requestId === requestRef.current) setAnswer("Unable to answer right now. Please try again.");
    } finally {
      if (requestId === requestRef.current) setAsking(false);
    }
  }

  async function share() {
    if (!product) return;
    const url = `${location.origin}${location.pathname}?asin=${product.asin}`;
    try {
      await navigator.clipboard.writeText(url);
      setToast("Product link copied");
    } catch {
      setToast(`Product ASIN: ${product.asin}`);
    }
  }

  function toggleSaved() {
    if (!product) return;
    const isSaved = saved.includes(product.asin);
    setSaved(isSaved ? saved.filter((asin) => asin !== product.asin) : [...saved, product.asin]);
    setToast(isSaved ? "Removed from saved items" : "Saved for this visit");
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  const galleryTabs: { view: GalleryView; label: string }[] = [
    { view: "main", label: "Main product image" },
    { view: "zoom", label: "Zoomed product image" },
    { view: "fabric", label: "Fabric details" },
    { view: "fit", label: "Fit details" },
  ];

  return <>
    <header className="site-header">
      <div className="header-main">
        <a className="brand" href="/" aria-label="Amazombie home" onClick={(event) => { event.preventDefault(); goHome(true); }}><img src="/assets/amazombie-logo.png" alt="Amazombie" /></a>
        <button className="delivery header-link" type="button" onClick={() => setNoticeOpen(!noticeOpen)}><span className="delivery-spark" aria-hidden="true">✦</span><span><small>Haunted Hacks demo</small><strong>Dead simple shopping</strong></span></button>
        <form className="search" role="search" onSubmit={(event) => { event.preventDefault(); goHome(); window.requestAnimationFrame(() => document.getElementById("results")?.scrollIntoView({ behavior: "smooth" })); }}>
          <label className="search-category" htmlFor="search-input">All tees</label>
          <input id="search-input" name="q" type="search" value={search} autoComplete="off" placeholder="Search T-shirts, brands, colors..." aria-label="Search Amazombie T-shirts" onChange={(event) => { const value = event.target.value; setSearch(value); if (!product) window.history.replaceState({}, "", value.trim() ? `/?q=${encodeURIComponent(value.trim())}` : "/"); }} />
          <button className="search-submit" type="submit" aria-label="Search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="7.2" fill="none" stroke="currentColor" strokeWidth="2.7" /><path d="m16.3 16.3 5.2 5.2" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" /></svg></button>
        </form>
        <button className="cart header-link" type="button" aria-label={`Open basket, ${cartCount} ${cartCount === 1 ? "item" : "items"}`} onClick={() => checkoutRef.current?.openBasket()}><span className="cart-icon" aria-hidden="true">🛒</span><strong>Basket</strong>{cartCount > 0 && <span className="cart-count">{cartCount}</span>}</button>
      </div>
      <nav className="header-nav" aria-label="Main navigation"><a href="/" onClick={(event) => { event.preventDefault(); goHome(true); }}>☰ <strong>All T-shirts</strong></a><a href="#results" onClick={(event) => { event.preventDefault(); goHome(); window.requestAnimationFrame(() => document.getElementById("results")?.scrollIntoView({ behavior: "smooth" })); }}>Shop the catalog</a><span className="nav-pill">✦ Amazombie finds</span><a className="dashboard-link" href="/dashboard"><span className="dashboard-label-full">Merchant dashboard</span><span className="dashboard-label-short">Dashboard</span></a><span className="nav-right">BASICS BACK FROM THE DEAD ✦ YC HAUNTED HACKS</span></nav>
    </header>

    {noticeOpen && <aside className="delivery-popover" aria-label="Demo notice"><p>Welcome to Amazombie. The catalog uses linked T-shirt listings with sample prices and size choices. Availability is not live.</p><div className="popover-actions"><button className="button-outline" type="button" onClick={() => setNoticeOpen(false)}>Dismiss</button><button className="button-yellow" type="button" onClick={() => { setNoticeOpen(false); goHome(); window.requestAnimationFrame(() => document.getElementById("results")?.scrollIntoView({ behavior: "smooth" })); }}>Explore shirts</button></div></aside>}

    <main id="app">
      {!product ? <CatalogHome products={products} search={search} filters={filters} onFiltersChange={setFilters} onClear={clearFilters} onChoose={chooseProduct} /> : <>
      <div className="catalog-strip"><span>AMAZOMBIE FINDS</span><strong>{products.length} T-shirts in the catalog</strong><button type="button" onClick={() => goHome()}>← All T-shirts</button></div>
      <div className="breadcrumbs"><button type="button" onClick={() => goHome()}>All T-shirts</button><span>›</span><strong>{product.brand}</strong></div>
      <div className="product-layout">
        <section className="media-column" aria-label="Product media">
          <div className="gallery"><div className="gallery-rail" aria-label="Image and product views">{galleryTabs.map(({ view, label }) => <button className={`gallery-thumb ${galleryView === view ? "selected" : ""}`} type="button" key={view} aria-label={label} aria-pressed={galleryView === view} onClick={() => setGalleryView(view)}>{view === "main" || view === "zoom" ? <img className={view === "zoom" ? "thumb-zoom" : undefined} src={imageUrl(product)} alt="" /> : <span className="thumb-text">{view.toUpperCase()}<br /><b>{view === "fabric" ? "✦" : "↔"}</b></span>}</button>)}</div>
            <div className="hero-stage">{galleryView === "fabric" || galleryView === "fit" ? <div className="gallery-fact"><span className="fact-icon">{galleryView === "fabric" ? "✦" : "↔"}</span><small>{galleryView === "fabric" ? "FABRIC" : "FIT & FEEL"}</small><strong>{galleryView === "fabric" ? product.fabric : product.fit}</strong><p>See the source listing for complete variant details.</p></div> : <img className={`hero-image ${galleryView === "zoom" ? "is-zoomed" : ""}`} src={imageUrl(product)} alt={product.shortName} />}
              <div className="hero-actions"><button type="button" aria-label="Copy product link" onClick={() => void share()}>↥</button><button type="button" aria-label="Save product" aria-pressed={saved.includes(product.asin)} className={saved.includes(product.asin) ? "saved" : ""} onClick={toggleSaved}>{saved.includes(product.asin) ? "♥" : "♡"}</button></div>
            </div>
          </div>
          <section className="ask-panel" aria-label="Ask Amazombie demo"><h2><span className="ask-spark">✦</span> Ask Amazombie <span className="ask-label">local demo</span></h2><div className="ask-chips">{questions.map((item) => <button type="button" key={item} onClick={() => void ask(item)}>{item}</button>)}<button className="ask-more" type="button" onClick={() => setAskOpen(!askOpen)}>Ask something else</button></div>{askOpen && <form className="ask-form" onSubmit={submitQuestion}><label htmlFor="ask-input">Ask about this item or the catalog</label><div><input id="ask-input" type="text" maxLength={300} placeholder="e.g. Which shirts are black?" value={question} onChange={(event) => setQuestion(event.target.value)} /><button type="submit">Ask</button></div></form>}{(answer || asking) && <p className="ask-answer" role="status">{asking ? "Checking the demo catalog…" : answer}</p>}</section>
        </section>
        <section className="details-column" aria-label="Product details">
          <a className="store-link" href={product.sourceUrl} target="_blank" rel="noopener noreferrer">Visit the {product.brand} listing</a><h1>{product.name}</h1>
          {product.rating != null && <div className="rating"><span>{product.rating.toFixed(1)}</span><span className="stars" aria-label={`${product.rating} out of 5 stars`}>★★★★★</span><span className="rating-chevron">⌄</span><a href="#product-details">({product.reviewCount})</a><span className="rating-divider">|</span><a href="#product-details">Search this page</a></div>}
          <div className="safety-note"><span>♧</span><u>Everyday essentials</u></div>{product.badge && <div className="ranking"><strong>{product.badge}</strong><a href="#catalog">in Men&apos;s T-Shirts</a></div>}<div className="purchase-count">Product details captured for this demo</div><div className="rule" />
          <div className="price-line">{product.priceUsd == null ? <a className="price-unavailable" href={product.sourceUrl} target="_blank" rel="noopener noreferrer">See price on source listing ›</a> : <><span className="price-symbol">$</span><span className="price-whole">{product.priceUsd.toFixed(2).split(".")[0]}</span><sup>{product.priceUsd.toFixed(2).split(".")[1]}</sup></>}<span className="unit-price">{product.priceUsd == null ? "Price not captured" : "Sample price"}</span></div>
          <p className="price-disclaimer">Prices may vary by seller, size, and color. <span title="This is a demo catalog, not a live price feed">ⓘ</span></p><div className="savings"><strong>Demo</strong><span>Sample inventory and size choices</span><a href={product.sourceUrl} target="_blank" rel="noopener noreferrer">View original listing ›</a></div>
          <section className="catalog-choices" id="catalog"><h2><span>Color:</span> {product.color}</h2><p className="choices-caption">Quick picks · <a href="#browse">browse all {products.length}</a></p><div className="choice-grid">{quickPicks.map((item) => <button type="button" key={item.asin} className={`choice-card ${item.asin === product.asin ? "selected" : ""}`} aria-pressed={item.asin === product.asin} onClick={() => chooseProduct(item.asin)}><img src={imageUrl(item)} alt="" /><span className="choice-info"><strong>{price(item)}</strong><small>{item.shortName}</small></span></button>)}</div></section>
          <section className="size-section"><h2><span>Size:</span> {selectedSize}</h2><div className="size-grid">{product.sizes.map((size) => <button type="button" key={size} className={`size-button ${size === selectedSize ? "selected" : ""}`} aria-pressed={size === selectedSize} onClick={() => setSizes({ ...sizes, [product.asin]: size })}>{size}</button>)}</div><details className="size-chart"><summary>Size chart</summary><p>Size options are illustrative. Some source listings show measurements in images; this demo does not transcribe garment lengths into text.</p></details></section>
          <section className="purchase-panel" aria-label="Demo purchase"><div><strong>{price(product)}</strong><span>Sample price</span></div><label>Quantity <select value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => <option value={index + 1} key={index + 1}>{index + 1}</option>)}</select></label><div className="purchase-actions"><button type="button" disabled={product.priceUsd == null} onClick={() => checkoutRef.current?.add(product.asin, selectedSize, quantity)}>Add to basket</button><button type="button" disabled={product.priceUsd == null} onClick={() => checkoutRef.current?.add(product.asin, selectedSize, quantity, true)}>Buy now</button></div><p>Demo checkout · no payment is collected.</p></section>
          <section className="product-details" id="product-details"><h2>Product details</h2><div className="rule" /><h3>Top highlights</h3><ul>{product.highlights.map((item) => <li key={item}>{item}</li>)}</ul><dl>{[["Brand", product.brand], ["Color", product.color], ["Fabric", product.fabric], ["Fit", product.fit], ["ASIN", product.asin]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="source-note">{product.priceBasis}. Stock is not live; checkout creates a demo order.</p></section>
        </section>
      </div>
      <section className="browse-section" id="browse" aria-label="Scrollable T-shirt catalog"><div className="browse-heading"><div><small>MORE TO DISCOVER</small><h2>Browse all {products.length} T-shirts</h2><p>Scroll through the catalog or use the arrows to explore.</p></div><div className="browse-controls">{[-1, 1].map((direction) => <button type="button" key={direction} aria-label={`Scroll catalog ${direction < 0 ? "left" : "right"}`} onClick={() => browseRef.current?.scrollBy({ left: direction * Math.max((browseRef.current?.clientWidth ?? 0) * 0.8, 250), behavior: "smooth" })}>{direction < 0 ? "‹" : "›"}</button>)}</div></div>
        <div className="browse-track" ref={browseRef} tabIndex={0}>{products.map((item) => <button className={`browse-card ${item.asin === product.asin ? "selected" : ""}`} type="button" key={item.asin} onClick={() => chooseProduct(item.asin)}><span className="browse-photo"><img src={imageUrl(item)} alt="" loading="lazy" /></span><span className="browse-name">{item.shortName}</span><span className="browse-brand">{item.brand}</span><strong>{price(item)}</strong></button>)}</div>
      </section>
      </>}
    </main>
    <Checkout ref={checkoutRef} products={products} onSelectProduct={chooseProduct} onCountChange={setCartCount} />
    <footer className="site-footer"><span>amazombie <b>✦</b> dead simple shopping</span><span>Images and source links come from the original product listings. Checkout places demo orders; no payment is collected.</span></footer>
    {toast && <div className="toast" role="status">{toast}</div>}
  </>;
}
