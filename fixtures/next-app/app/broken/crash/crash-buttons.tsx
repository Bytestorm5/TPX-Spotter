"use client";
import { useState } from "react";

/** Deliberate failures for the automatic-report e2e tests. */
export function CrashButtons() {
  const [status, setStatus] = useState("");
  return (
    <div className="form card" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <button
        className="btn"
        data-testid="throw"
        onClick={() => {
          const order = JSON.parse('{"id":"ord_1"}') as { lines: { sku: string }[] };
          setStatus(order.lines[0]!.sku); // TypeError: order.lines is undefined
        }}
      >
        Throw an error
      </button>
      <button
        className="btn"
        data-testid="fail-request"
        onClick={async () => {
          const res = await fetch("/api/charge", { method: "POST", body: JSON.stringify({ amount: 42 }) });
          setStatus(`charge: ${res.status}`);
        }}
      >
        Call a failing API (502)
      </button>
      <button
        className="btn secondary"
        data-testid="missing-request"
        onClick={async () => {
          const res = await fetch("/api/no-such-endpoint");
          setStatus(`missing: ${res.status}`);
        }}
      >
        Call a missing API (404)
      </button>
      <button
        className="btn secondary"
        data-testid="server-error"
        onClick={async () => {
          const res = await fetch("/api/explode", { method: "POST" });
          setStatus(`explode: ${res.status}`);
        }}
      >
        Call an API that throws (500)
      </button>
      <output data-testid="crash-status">{status}</output>
    </div>
  );
}
