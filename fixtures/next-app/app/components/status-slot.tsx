"use client";
import { SpotterStatus } from "@trusplex/spotter/ui/next";

/** The in-app status badge lives in the nav, like an inbox icon would. */
export function StatusSlot() {
  return (
    <div className="status-slot">
      <SpotterStatus pollSeconds={15} />
    </div>
  );
}
