import Link from "next/link";
import { SpotterTrigger } from "@trusplex/spotter/ui/next";

const PRODUCTS = [
  { id: 1, name: "Alpine Shell Jacket", price: "$248", color: "linear-gradient(135deg,#1e3a8a,#60a5fa)" },
  { id: 2, name: "Merino Base Layer", price: "$89", color: "linear-gradient(135deg,#7c2d12,#fb923c)" },
  { id: 3, name: "Trail Runner 3", price: "$139", color: "linear-gradient(135deg,#14532d,#4ade80)" },
  { id: 4, name: "Summit Pack 28L", price: "$176", color: "linear-gradient(135deg,#4c1d95,#c084fc)" },
];

export default function Home() {
  return (
    <>
      <h1>Gear for the long way round.</h1>
      <p className="lede">Technical outerwear and layers, tested on real mountains. Free returns for 60 days.</p>
      <div className="grid">
        {PRODUCTS.map((p) => (
          <article key={p.id} id={`product-${p.id}`} className="card product" data-testid={`product-${p.id}`}>
            <div className="swatch" style={{ background: p.color }} />
            <h3>{p.name}</h3>
            <div className="price">{p.price}</div>
            <div className="row">
              <Link className="btn" href="/checkout">
                Buy now
              </Link>
              <SpotterTrigger asChild element={`#product-${p.id}`}>
                <button type="button" className="linkish" data-testid={`report-${p.id}`}>
                  Report this
                </button>
              </SpotterTrigger>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
