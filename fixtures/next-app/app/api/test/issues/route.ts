import { store } from "@/spotter.hooks";

export const dynamic = "force-dynamic";

/** Test-only: the issues the recorder hook received. */
export function GET() {
  return Response.json(store.issues);
}

export function DELETE() {
  store.issues.length = 0;
  return Response.json({ ok: true });
}
