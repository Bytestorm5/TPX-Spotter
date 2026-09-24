import type { NextConfig } from "next";
import { withSpotter } from "@trusplex/spotter/ui/next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default withSpotter(nextConfig, {
  project: "pk_test_fixture",
  features: {
    widget: true,
    screenshot: true,
    annotate: true,
    replay: true,
    analytics: true,
    flags: true,
    recording: true,
  },
  types: {
    events: ["checkout_started", "checkout_failed", "signup_completed"],
    fields: { order_number: "text", plan: { type: "select", options: ["free", "pro"] } },
    contexts: ["cart"],
  },
});
