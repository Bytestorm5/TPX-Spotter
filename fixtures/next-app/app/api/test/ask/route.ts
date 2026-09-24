import { spotterHandler } from "@/lib/spotter-server";

export const dynamic = "force-dynamic";

/** Test-only: move a report to needs_info with a question, or set its status. */
export async function POST(request: Request) {
  const body = (await request.json()) as { id: string; question?: string; status?: "in_progress" | "resolved"; message?: string };
  const issue = body.question
    ? await spotterHandler.ingest.ask(body.id, body.question)
    : await spotterHandler.ingest.setStatus(body.id, body.status ?? "in_progress", { message: body.message });
  return Response.json({ ok: !!issue });
}
