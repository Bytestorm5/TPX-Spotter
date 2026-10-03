/** A route handler that throws: `onRequestError` reports it, the browser sees a 500. */
export async function POST() {
  const rates = (await Promise.resolve(undefined)) as unknown as Record<string, number>;
  return Response.json({ total: 42 * rates.EUR! });
}
