/**
 * The floating trigger's icon, on its own so the loader doesn't pull in the
 * panel's icon set. Decorative: the button carries the accessible name.
 *
 * The trigger: a speech bubble with an exclamation mark — "something to say", unbranded. */
export const TriggerIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6a.5.5 0 0 1-.8-.4V16h0A1.5 1.5 0 0 1 4 14.5z" />
    <path d="M12 6.8v4.2" />
    <path d="M12 13.4h.01" strokeWidth={2.2} />
  </svg>
);
