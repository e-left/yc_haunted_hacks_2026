import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const products = [
  { name: "Everyday essentials", description: "Refresh your daily routine", image: "https://images.unsplash.com/photo-1556229010-6c3f2c9ca5f8?auto=format&fit=crop&w=700&q=80", label: "Shop essentials" },
  { name: "Find your new favorites", description: "Styles for every day", image: "https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=700&q=80", label: "Explore fashion" },
  { name: "Make yourself at home", description: "Little updates, big difference", image: "https://images.unsplash.com/photo-1493663284031-b7e3aefcae8e?auto=format&fit=crop&w=700&q=80", label: "Shop home" },
  { name: "Discover your next read", description: "Stories worth staying in for", image: "https://images.unsplash.com/photo-1507842217343-583bb7270b66?auto=format&fit=crop&w=700&q=80", label: "Explore books" },
  { name: "Tech for your everyday", description: "Upgrade your setup", image: "https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=700&q=80", label: "Shop electronics" },
  { name: "A little more room to play", description: "For the whole family", image: "https://images.unsplash.com/photo-1558060370-d644479cb6f7?auto=format&fit=crop&w=700&q=80", label: "Discover toys" },
  { name: "Get outside", description: "Make the most of the outdoors", image: "https://images.unsplash.com/photo-1472396961693-142e6e269027?auto=format&fit=crop&w=700&q=80", label: "Explore outdoors" },
  { name: "Kitchen favorites", description: "Inspiration for your kitchen", image: "https://images.unsplash.com/photo-1556911220-bff31c812dba?auto=format&fit=crop&w=700&q=80", label: "Shop kitchen" },
];

function App() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const matches = products.filter((product) => `${product.name} ${product.description} ${product.label}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <header>
        <div className="topbar">
          <a className="logo" href="/" aria-label="Amazon demo home">amazon<span>.demo</span><i /></a>
          <div className="delivery"><span>Deliver to</span><strong>⌖ United States</strong></div>
          <form className="search" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }}>
            <span className="search-category">All <span>▾</span></span>
            <input aria-label="Search products" placeholder="Search Amazon demo" value={query} onChange={(event) => setQuery(event.target.value)} />
            <button aria-label="Search" type="submit">⌕</button>
          </form>
          <div className="account"><span>Hello, shopper</span><strong>Account &amp; Lists ▾</strong></div>
          <div className="account"><span>Returns</span><strong>&amp; Orders</strong></div>
          <div className="cart"><span>🛒</span><strong>Cart</strong></div>
        </div>
        <div className="nav"><strong>☰ &nbsp;All</strong><span>Today's Deals</span><span>Customer Service</span><span>Registry</span><span>Gift Cards</span><span>Sell</span><b>Discover something new</b></div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy"><p>FIND YOUR NEXT FAVORITE</p><h1>Little things.<br />Big possibilities.</h1><span>Discover something for every day.</span></div>
        </section>
        <div className="content">
          <div className="notice">You are viewing a demo storefront. Products and account features are for demonstration only.</div>
          {search && <div className="results">Showing results for “{search}” <button onClick={() => { setSearch(""); setQuery(""); }}>Clear search</button></div>}
          <section className="grid" aria-label="Shopping categories">
            {matches.map((product) => <article className="card" key={product.name}><h2>{product.name}</h2><div className="card-image" style={{ backgroundImage: `url('${product.image}')` }} role="img" aria-label={product.description} /><p>{product.description}</p><span className="card-label">{product.label}</span></article>)}
          </section>
          {matches.length === 0 && <div className="empty">No categories found. Try another search.</div>}
        </div>
      </main>
      <footer><a href="#top" onClick={(event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Back to top</a><p>Amazon-style demo storefront · No purchases or accounts available</p></footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
