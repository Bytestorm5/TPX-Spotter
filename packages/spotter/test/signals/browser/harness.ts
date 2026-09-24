/**
 * Browser harness for the lazy chunks that need a real engine (modern-screenshot,
 * rrweb). Bundled by run.mjs with esbuild and driven by Playwright.
 */
import { captureScreenshot } from "../../../src/core/screenshot/index.ts";
import { startReplay } from "../../../src/core/replay/index.ts";
import { deriveSignals } from "../../../src/core/replay/signals.ts";
import { lastCompressionPath } from "../../../src/core/replay/compress.ts";
import { domSnapshot } from "../../../src/core/capture/page.ts";
import { testRuntime } from "../helpers.ts";

const rt = testRuntime({ privacy: { maskText: "inputs" } });

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const segments: { seq: number; data: number[] }[] = [];

(window as unknown as Record<string, unknown>).__spotter = {
  async screenshot(scope: "viewport" | "full" | "element", maskText: "none" | "inputs" | "all" = "inputs", selector?: string) {
    const t0 = performance.now();
    const element = selector ? (document.querySelector(selector) ?? undefined) : undefined;
    const res = await captureScreenshot({
      scope,
      element,
      maskText,
      maskSelectors: [".pii"],
      blockSelectors: [".ad"],
      exclude: [],
      method: "dom",
    });
    return { ms: Math.round(performance.now() - t0), width: res.width, height: res.height, method: res.method, png: await blobToBase64(res.blob) };
  },
  async replay(mode: "buffer" | "sampled") {
    const ctl = await startReplay(rt, {
      mode,
      windowSeconds: 15,
      maskText: "inputs",
      maskSelectors: [".pii"],
      blockSelectors: [".ad"],
      uploadSegment: async (seq, data) => {
        segments.push({ seq, data: Array.from(data) });
      },
    });
    (window as unknown as Record<string, unknown>).__ctl = ctl;
    return true;
  },
  async flush() {
    const ctl = (window as unknown as { __ctl: Awaited<ReturnType<typeof startReplay>> }).__ctl;
    const out = await ctl.flush();
    const recent = ctl.recentEvents();
    const seq = await ctl.uploadSegment("test");
    return out
      ? { data: Array.from(out.data), events: out.events, startedAt: out.startedAt, endedAt: out.endedAt, signals: deriveSignals(recent), seq, segments: segments.length }
      : null;
  },
  snapshot: () => domSnapshot(rt),
  compressionPath: () => lastCompressionPath(),
  async sampledSegment() {
    const ctl = (window as unknown as { __ctl: Awaited<ReturnType<typeof startReplay>> }).__ctl;
    const seq = await ctl.uploadSegment("flag");
    return { seq, segments: segments.map((s) => ({ seq: s.seq, bytes: s.data.length, data: s.data })) };
  },
};
