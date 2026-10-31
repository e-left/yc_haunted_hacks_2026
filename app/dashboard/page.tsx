import type { Metadata } from "next";
import { getProducts } from "../../lib/catalog";
import "./dashboard.css";

export const metadata: Metadata = { title: "Merchant dashboard | Amazombie" };

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const products = await getProducts();
  return <main className="dashboard">
    <header className="dashboard-header"><div><p className="eyebrow">AMAZOMBIE</p><h1>Merchant dashboard</h1><p className="intro">Manage the data and temporary APIs available to customer agents.</p></div><a href="/">← View storefront</a></header>
    <div className="notice" role="status"><strong>Demo dashboard</strong><p>The product list below is shared with the storefront. Authentication, classifications, review, and temporary APIs are not connected yet.</p></div>
    <section aria-labelledby="catalog-heading"><div className="dashboard-section-heading"><div><h2 id="catalog-heading">Product catalog</h2><p>{products.length} products in the Supabase catalog</p></div><a href="/api/products">View catalog API</a></div>
      <div className="dashboard-catalog">{products.map((product) => <a className="dashboard-product" href={`/?asin=${encodeURIComponent(product.asin)}`} key={product.asin}><img src={`/${product.image}`} alt="" /><span><strong>{product.shortName}</strong><small>{product.brand} · {product.asin}</small></span><span>{product.priceUsd == null ? "Price not captured" : `$${product.priceUsd.toFixed(2)} sample`}</span></a>)}</div>
    </section>
    <section aria-labelledby="planned-heading" className="planned"><h2 id="planned-heading">Coming to the demo</h2><div className="feature-grid"><article><h3>Data classifications</h3><p>Configure which merchant data is private, custodial, or eligible for review.</p></article><article><h3>Requests and reviews</h3><p>Inspect customer requests and review decisions.</p></article><article><h3>API catalog</h3><p>View temporary APIs, their lifecycle, and recorded interactions.</p></article></div></section>
  </main>;
}
