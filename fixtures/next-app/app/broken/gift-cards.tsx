"use client";
import { useState } from "react";
import { SpotterErrorBoundary } from "@trusplex/spotter/ui/next";

function Balance({ code }: { code: string | null }) {
  if (code !== null) {
    // The bug: the API shape changed and `card.balance` is undefined.
    const card = JSON.parse('{"id":"gc_1"}') as { balance: { amount: number } };
    return <p>Balance: ${card.balance.amount.toFixed(2)}</p>;
  }
  return null;
}

export function GiftCards() {
  const [code, setCode] = useState<string | null>(null);
  return (
    <SpotterErrorBoundary
      fallback={({ report, reset }) => (
        <div className="error-box" role="alert" data-testid="boundary">
          <strong>Something went wrong checking that card.</strong>
          <span>We&apos;ve been notified. You can also tell us what happened.</span>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" onClick={report} data-testid="boundary-report">
              Tell us what you were doing
            </button>
            <button className="btn secondary" onClick={() => { setCode(null); reset(); }}>
              Try again
            </button>
          </div>
        </div>
      )}
    >
      <form className="form card" onSubmit={(e) => { e.preventDefault(); setCode("GIFT-1234"); }}>
        <label>
          Gift card code
          <input name="code" placeholder="GIFT-XXXX" />
        </label>
        <button className="btn" type="submit" data-testid="check-balance">
          Check balance
        </button>
      </form>
      <Balance code={code} />
    </SpotterErrorBoundary>
  );
}
