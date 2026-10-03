"use client";
/**
 * The app's error page. It renders inside the root layout, so Spotter is on
 * it: with `autoReport`, the failed page load is reported from the browser
 * (and `instrumentation.ts` reports the server side of it).
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="error-box" role="alert" data-testid="error-page">
      <strong>Something went wrong on our side.</strong>
      <span>We&apos;ve been notified{error.digest ? ` (reference ${error.digest})` : ""}.</span>
      <button className="btn secondary" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
