/** The deliberate bug: the payment provider "returns" a 502. */
export async function POST() {
  await new Promise((r) => setTimeout(r, 120));
  return Response.json({ error: "Bad gateway from payment provider", code: "upstream_502" }, { status: 502 });
}
