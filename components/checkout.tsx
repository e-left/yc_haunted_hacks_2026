"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import type { Product } from "../lib/product";

const CART_KEY = "amazombie.cart.v1";
type CartItem = { asin: string; size: string; quantity: number };
type View = "basket" | "checkout" | "confirmation";
type Order = { id: string; totalCents: number; placedAt: string };

export type CheckoutHandle = {
  add: (asin: string, size: string, quantity: number, buyNow?: boolean) => void;
  openBasket: () => void;
};

function readCart(products: Product[]): CartItem[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CART_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    const byAsin = new Map(products.map((product) => [product.asin, product]));
    const seen = new Set<string>();
    return stored.filter((item): item is CartItem => {
      if (!item || typeof item !== "object" ||
          typeof item.asin !== "string" || typeof item.size !== "string" ||
          !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) return false;
      const product = byAsin.get(item.asin);
      const key = `${item.asin}:${item.size}`;
      if (!product?.sizes.includes(item.size) || !Number.isFinite(product.priceUsd) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return [];
  }
}

export const Checkout = forwardRef<CheckoutHandle, {
  products: Product[];
  onSelectProduct: (asin: string) => void;
  onCountChange: (count: number) => void;
}>(function Checkout({ products, onSelectProduct, onCountChange }, ref) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("basket");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [customerName, setCustomerName] = useState("");
  const byAsin = new Map(products.map((product) => [product.asin, product]));
  const itemCount = cart.reduce((count, item) => count + item.quantity, 0);
  const totalCents = cart.reduce((total, item) => total + Math.round((byAsin.get(item.asin)?.priceUsd ?? 0) * 100) * item.quantity, 0);
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  useEffect(() => {
    setCart(readCart(products));
    setReady(true);
  }, [products]);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* Basket still works for this visit. */ }
    onCountChange(itemCount);
  }, [cart, itemCount, onCountChange, ready]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function openBasket() {
    setError("");
    setView("basket");
    setOpen(true);
  }

  useImperativeHandle(ref, () => ({
    openBasket,
    add(asin, size, quantity, buyNow = false) {
      const product = byAsin.get(asin);
      if (!product?.sizes.includes(size) || !Number.isFinite(product.priceUsd) || submitting) return;
      const amount = Math.min(10, Math.max(1, Math.trunc(quantity)));
      setCart((previous) => {
        const existing = previous.find((item) => item.asin === asin && item.size === size);
        return existing
          ? previous.map((item) => item === existing ? { ...item, quantity: Math.min(10, item.quantity + amount) } : item)
          : [...previous, { asin, size, quantity: amount }];
      });
      setError("");
      setView(buyNow ? "checkout" : "basket");
      setOpen(true);
    },
  }), [byAsin, submitting]);

  function updateItem(asin: string, size: string, action: "increase" | "decrease" | "remove") {
    setCart((previous) => previous.flatMap((item) => {
      if (item.asin !== asin || item.size !== size) return [item];
      if (action === "remove" || (action === "decrease" && item.quantity === 1)) return [];
      return [{ ...item, quantity: Math.min(10, item.quantity + (action === "increase" ? 1 : -1)) }];
    }));
  }

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !cart.length) return;
    const name = String(new FormData(event.currentTarget).get("fullName") ?? "").trim();
    if (!name) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: cart }),
      });
      const result: Order & { error?: string } = await response.json();
      if (!response.ok || typeof result.id !== "string" || !Number.isInteger(result.totalCents)) {
        throw new Error(result.error ?? "The order could not be saved.");
      }
      setOrder(result);
      setCustomerName(name.split(/\s+/)[0]);
      setCart([]);
      setView("confirmation");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The order could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  const totals = <div className="order-totals"><div><span>Items ({itemCount})</span><strong>{money(totalCents)}</strong></div><div><span>Demo shipping</span><strong>Free</strong></div><div className="order-total"><span>Total</span><strong>{money(totalCents)}</strong></div></div>;

  return <dialog ref={dialogRef} className="cart-dialog" aria-labelledby="cart-title" onClose={() => setOpen(false)} onClick={(event) => { if (event.target === dialogRef.current && !submitting) setOpen(false); }}>
    <div className="checkout-shell">
      <header className="checkout-header"><div><small>AMAZOMBIE</small><h2 id="cart-title">{view === "basket" ? "Your basket" : view === "checkout" ? "Checkout" : "Order placed"}</h2></div><button type="button" className="checkout-close" aria-label="Close" onClick={() => setOpen(false)}>×</button></header>
      {view === "basket" && (cart.length ? <div className="checkout-content">
        <ul className="cart-lines">{cart.map((item) => {
          const product = byAsin.get(item.asin)!;
          return <li className="cart-line" key={`${item.asin}:${item.size}`}><button type="button" className="cart-line-image" aria-label={`View ${product.shortName}`} onClick={() => { setOpen(false); onSelectProduct(item.asin); }}><img src={`/${product.image}`} alt="" /></button><div className="cart-line-main"><button type="button" className="cart-line-title" onClick={() => { setOpen(false); onSelectProduct(item.asin); }}>{product.shortName}</button><span>Size {item.size} · {money(Math.round(product.priceUsd! * 100))} each</span><div className="cart-line-controls"><button type="button" aria-label={`Remove one ${product.shortName}`} onClick={() => updateItem(item.asin, item.size, "decrease")}>−</button><strong>{item.quantity}</strong><button type="button" aria-label={`Add one ${product.shortName}`} disabled={item.quantity >= 10} onClick={() => updateItem(item.asin, item.size, "increase")}>+</button><button type="button" className="cart-remove" onClick={() => updateItem(item.asin, item.size, "remove")}>Remove</button></div></div><strong className="cart-line-price">{money(Math.round(product.priceUsd! * 100) * item.quantity)}</strong></li>;
        })}</ul>{totals}<p className="checkout-disclaimer">Sample prices. This checkout places a demo order and does not charge a payment method.</p><button type="button" className="checkout-primary" onClick={() => setView("checkout")}>Continue to checkout</button><button type="button" className="checkout-secondary" onClick={() => setOpen(false)}>Continue shopping</button>
      </div> : <div className="checkout-content cart-empty"><span aria-hidden="true">✦</span><h3>Your basket is empty</h3><p>Pick a T-shirt and size to get started.</p><button type="button" className="checkout-primary" onClick={() => setOpen(false)}>Browse T-shirts</button></div>)}
      {view === "checkout" && <div className="checkout-content"><button type="button" className="checkout-back" onClick={() => setView("basket")}>← Back to basket</button><form onSubmit={(event) => void submitOrder(event)}><p className="checkout-disclaimer">Demo checkout · no payment is collected. Delivery details are used only for this confirmation and are not saved. Only the selected items and sample total are saved in Supabase.</p><h3>Delivery details</h3><div className="checkout-fields"><label className="field-wide">Full name<input name="fullName" autoComplete="name" required maxLength={80} placeholder="Alex Shopper" /></label><label className="field-wide">Email<input name="email" type="email" autoComplete="email" required maxLength={120} placeholder="alex@example.com" /></label><label className="field-wide">Street address<input name="street" autoComplete="street-address" required maxLength={120} placeholder="123 Main Street" /></label><label>City<input name="city" autoComplete="address-level2" required maxLength={80} /></label><label>State / region<input name="region" autoComplete="address-level1" required maxLength={80} /></label><label>Postal code<input name="postal" autoComplete="postal-code" required maxLength={20} /></label><label>Country<input name="country" autoComplete="country-name" required maxLength={80} defaultValue="United States" /></label></div><h3>Order summary</h3><ul className="checkout-summary">{cart.map((item) => <li key={`${item.asin}:${item.size}`}><span>{byAsin.get(item.asin)?.shortName} · {item.size} × {item.quantity}</span><strong>{money(Math.round((byAsin.get(item.asin)?.priceUsd ?? 0) * 100) * item.quantity)}</strong></li>)}</ul>{totals}{error && <p className="checkout-error" role="alert">{error}</p>}<button type="submit" className="checkout-primary" disabled={submitting}>{submitting ? "Placing order…" : "Place demo order"}</button></form></div>}
      {view === "confirmation" && order && <div className="checkout-content order-confirmation"><span className="confirmation-icon" aria-hidden="true">✓</span><h3>You&apos;re all set, {customerName}.</h3><p>Your demo order <strong>AZ-{order.id.slice(0, 8).toUpperCase()}</strong> is confirmed.</p><div className="confirmation-total"><span>Order total</span><strong>{money(order.totalCents)}</strong></div><p>This demo order is saved in Supabase. No payment was charged and no delivery request was sent.</p><button type="button" className="checkout-primary" onClick={() => setOpen(false)}>Continue shopping</button></div>}
    </div>
  </dialog>;
});
