import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { SpotterTrigger } from "@trusplex/spotter/ui/next";
import { SpotterSetup, type Variant } from "./spotter-client";
import { StatusSlot } from "./components/status-slot";
import "./globals.css";

export const metadata: Metadata = { title: "Acme Outfitters", description: "Spotter fixture app" };

/** Test variants come from cookies so Playwright can switch them per test without rebuilding. */
async function readVariant(): Promise<Variant> {
  const c = await cookies();
  const get = (k: string) => c.get(k)?.value;
  return {
    locale: get("sp_locale"),
    theme: get("sp_theme") === "dark" ? "dark" : undefined,
    mode: get("sp_mode") === "unstyled" ? "unstyled" : undefined,
    preset: (get("sp_preset") as Variant["preset"]) || undefined,
    review: get("sp_review") === "1",
    identify: get("sp_identify") === "1",
    fields: get("sp_fields") === "1",
    shortcut: get("sp_shortcut") !== "0",
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const variant = await readVariant();
  return (
    <html lang="en" className={variant.theme === "dark" ? "dark" : undefined}>
      <body>
        <SpotterSetup variant={variant}>
          <header className="nav">
            <Link href="/" className="brand">
              <span className="logo" aria-hidden="true" />
              Acme Outfitters
            </Link>
            <nav>
              <Link href="/checkout">Checkout</Link>
              <Link href="/blog/winter-layering-guide">Journal</Link>
              <Link href="/account">Account</Link>
              <Link href="/broken">Gift cards</Link>
            </nav>
            <StatusSlot />
          </header>
          <main className="main">{children}</main>
          <footer className="footer">
            <span>© 2026 Acme Outfitters</span>
            <SpotterTrigger asChild mode="text">
              <a id="report-link" href="#report">
                Report a problem
              </a>
            </SpotterTrigger>
          </footer>
        </SpotterSetup>
      </body>
    </html>
  );
}
