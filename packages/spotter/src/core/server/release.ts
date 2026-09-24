/**
 * Build-time release declaration and source-map upload (`withSpotter()` calls
 * this after `next build`). Source maps are stored privately by the ingest
 * and used to symbolicate stacks; they are never served publicly.
 */
import { HOSTED_ENDPOINT, readEnv } from "../config.ts";
import type { ReleaseDeclaration } from "../schema.ts";
import { HttpError, withRetry } from "../transport/retry.ts";

export interface UploadReleaseOptions {
  endpoint?: string;
  secretKey?: string;
  release: ReleaseDeclaration;
  files: { name: string; content: string | Uint8Array }[];
  fetch?: typeof fetch;
  /** Parallel uploads. Default 4. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface UploadReleaseResult {
  release: string;
  uploaded: string[];
  failed: { name: string; error: string }[];
}

export async function uploadRelease(options: UploadReleaseOptions): Promise<UploadReleaseResult> {
  const endpoint = (options.endpoint ?? readEnv("SPOTTER_ENDPOINT") ?? HOSTED_ENDPOINT).replace(/\/+$/, "");
  const secretKey = options.secretKey ?? readEnv("SPOTTER_SECRET_KEY");
  if (!secretKey) throw new Error("uploadRelease(): a secret key is required (SPOTTER_SECRET_KEY).");
  const doFetch: typeof fetch = (i, init) => (options.fetch ?? globalThis.fetch)(i, init);
  const auth = { authorization: `Bearer ${secretKey}` };

  const declared = await withRetry(async () => {
    const res = await doFetch(`${endpoint}/v1/releases`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ ...options.release, files: options.release.files ?? options.files.map((f) => f.name) }),
    });
    if (!res.ok) throw new HttpError(res.status, `POST /v1/releases → ${res.status}`);
    return (await res.json()) as { release?: string };
  });
  const release = declared.release ?? options.release.version;

  const uploaded: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const queue = [...options.files];
  let done = 0;
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const file = f;
      try {
        await withRetry(async () => {
          const res = await doFetch(
            `${endpoint}/v1/releases/${encodeURIComponent(release)}/sourcemaps?file=${encodeURIComponent(file.name)}`,
            {
              method: "PUT",
              headers: { ...auth, "content-type": "application/json" },
              body: file.content as BodyInit,
            },
          );
          if (!res.ok) throw new HttpError(res.status, `PUT sourcemap ${file.name} → ${res.status}`);
        });
        uploaded.push(file.name);
      } catch (e) {
        failed.push({ name: file.name, error: (e as Error).message });
      }
      options.onProgress?.(++done, options.files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  return { release, uploaded, failed };
}
