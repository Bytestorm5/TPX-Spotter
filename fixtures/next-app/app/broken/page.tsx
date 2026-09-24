import { GiftCards } from "./gift-cards";

export const metadata = { title: "Gift cards — Acme Outfitters" };

export default function Broken() {
  return (
    <>
      <h1>Gift cards</h1>
      <p className="lede">Check a gift card balance. (This page has a bug: checking a balance crashes the component.)</p>
      <GiftCards />
    </>
  );
}
