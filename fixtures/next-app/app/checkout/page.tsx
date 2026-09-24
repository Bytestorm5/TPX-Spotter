import { CheckoutFlow } from "./checkout-flow";

export const metadata = { title: "Checkout — Acme Outfitters" };

export default function CheckoutPage() {
  return (
    <>
      <h1>Checkout</h1>
      <p className="lede">Two steps and you&apos;re done.</p>
      <CheckoutFlow />
    </>
  );
}
