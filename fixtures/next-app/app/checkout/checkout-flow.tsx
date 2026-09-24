"use client";
/**
 * A realistic flow with a deliberate bug: paying POSTs /api/charge, which
 * answers 502; the page logs an error and shows a toast. The total also
 * silently disagrees with the line items (a flag-worthy state).
 */
import { useEffect, useState } from "react";
import { spotter } from "@trusplex/spotter/core";

const ITEMS = [
  { name: "Alpine Shell Jacket", price: 248 },
  { name: "Merino Base Layer", price: 89 },
];

export function CheckoutFlow() {
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const subtotal = ITEMS.reduce((s, i) => s + i.price, 0);
  const total = subtotal + 12; // shipping… but the UI shows 15 below: the bug the flag catches.

  useEffect(() => {
    spotter.setContext("cart", { items: ITEMS.length, total });
    spotter.track("checkout_started", { items: ITEMS.length });
    console.info("checkout: cart loaded", { items: ITEMS.length });
  }, [total]);

  async function pay() {
    setBusy(true);
    setError(null);
    spotter.addBreadcrumb({ category: "custom", message: "Clicked Pay", level: "info" });
    try {
      const res = await fetch("/api/charge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: total }) });
      if (!res.ok) {
        const body = (await res.json()) as { error: string };
        console.error("Payment failed:", res.status, body.error);
        setError("Payment failed. Please try again.");
        spotter.track("checkout_failed", { status: res.status });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="checkout">
      <section className="card">
        <div className="steps">
          <span className={step === 1 ? "" : ""}>
            <b>{step === 1 ? "1. Shipping" : "✓ Shipping"}</b>
          </span>
          <span>→</span>
          <span>{step === 2 ? <b>2. Payment</b> : "2. Payment"}</span>
        </div>
        {step === 1 ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              setStep(2);
            }}
          >
            <label>
              Full name
              <input name="name" defaultValue="" placeholder="Ada Lovelace" data-testid="name" />
            </label>
            <label>
              Email
              <input name="email" type="email" placeholder="ada@example.com" data-testid="email" />
            </label>
            <label>
              Address
              <input name="address" placeholder="12 Analytical Row" />
            </label>
            <button className="btn" type="submit" data-testid="continue">
              Continue to payment
            </button>
          </form>
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void pay();
            }}
          >
            <label>
              Card number
              <input name="card" inputMode="numeric" placeholder="4242 4242 4242 4242" data-testid="card" />
            </label>
            <label>
              Password (to confirm)
              <input name="password" type="password" placeholder="••••••••" data-testid="password" />
            </label>
            <button className="btn" type="submit" disabled={busy} data-testid="pay">
              {busy ? "Paying…" : `Pay $${total}`}
            </button>
          </form>
        )}
      </section>
      <aside className="card summary">
        <h2>Order summary</h2>
        {ITEMS.map((i) => (
          <div className="line" key={i.name}>
            <span>{i.name}</span>
            <span>${i.price}</span>
          </div>
        ))}
        <div className="line">
          <span>Shipping</span>
          <span>$15</span>
        </div>
        <div className="line total">
          <span>Total</span>
          <span data-testid="total">${total}</span>
        </div>
      </aside>
      {error ? (
        <div role="alert" className="toast" data-testid="toast">
          {error}
        </div>
      ) : null}
    </div>
  );
}
