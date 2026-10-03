export const dynamic = "force-dynamic";

/** A server component that fails while rendering: `onRequestError` reports it, the browser sees a 500. */
export default async function ServerCrash() {
  const inventory = (await Promise.resolve(null)) as unknown as { count: number } | null;
  if (!inventory) throw new Error("Inventory service returned no data");
  return <p>{inventory.count} in stock</p>;
}
