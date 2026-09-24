// The first-party ingest route. A catch-all, because the protocol has sub-paths (/v1/reports/:id/artifacts/:name, …).
import { spotterHandler } from "@/lib/spotter-server";

export const { GET, POST, PUT, HEAD, OPTIONS } = spotterHandler;
