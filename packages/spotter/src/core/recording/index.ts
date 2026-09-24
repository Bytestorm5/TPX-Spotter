/**
 * Screen recording (lazy chunk, behind FEATURE_RECORDING): `getDisplayMedia`
 * + `MediaRecorder`, with optional microphone narration mixed in. Stops by
 * itself at `maxMs` (default 2 minutes) or when the user ends sharing from
 * the browser's own UI; every track is stopped when it ends.
 */

export interface RecordingResult {
  blob: Blob;
  durationMs: number;
  contentType: string;
}

export interface RecordingHandle {
  stop(): Promise<RecordingResult>;
  cancel(): void;
}

export interface StartRecordingOptions {
  mic?: boolean;
  maxMs?: number;
  onTick?: (ms: number) => void;
}

const CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm", "video/mp4"];

/** The best container/codec this browser's MediaRecorder supports. */
export function pickMimeType(isSupported: (t: string) => boolean = (t) => MediaRecorder.isTypeSupported(t)): string | undefined {
  for (const t of CANDIDATES) {
    try {
      if (isSupported(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export async function startRecording(opts: StartRecordingOptions = {}): Promise<RecordingHandle> {
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!media?.getDisplayMedia || typeof MediaRecorder === "undefined") throw new Error("screen recording is not supported in this browser");
  const maxMs = Math.max(1000, opts.maxMs ?? 120_000);

  const display = await media.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  const tracks: MediaStreamTrack[] = [...display.getTracks()];

  let stream = display;
  if (opts.mic) {
    try {
      const mic = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      tracks.push(...mic.getTracks());
      stream = new MediaStream([...display.getVideoTracks(), ...mic.getAudioTracks()]);
    } catch {
      /* mic refused: record without narration */
    }
  }

  const stopTracks = () => {
    for (const t of tracks) {
      try {
        t.stop();
      } catch {
        /* already stopped */
      }
    }
  };

  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 1_500_000 } : undefined);
  } catch (error) {
    stopTracks();
    throw error;
  }
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let ended = false;
  let cancelled = false;
  let resolveDone: (r: RecordingResult) => void = () => {};
  let rejectDone: (e: unknown) => void = () => {};
  const done = new Promise<RecordingResult>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  done.catch(() => {}); // cancel() rejects; nobody may be listening

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    clearInterval(tick);
    clearTimeout(limit);
    stopTracks();
    if (cancelled) return rejectDone(new Error("recording cancelled"));
    const contentType = (recorder.mimeType || mimeType || "video/webm").split(";")[0] ?? "video/webm";
    resolveDone({ blob: new Blob(chunks, { type: contentType }), durationMs: Date.now() - startedAt, contentType });
  };
  recorder.onerror = (e) => {
    stopTracks();
    rejectDone((e as ErrorEvent).error ?? new Error("recording failed"));
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    try {
      if (recorder.state !== "inactive") recorder.stop();
      else stopTracks();
    } catch {
      stopTracks();
    }
  };

  // The user can stop sharing from the browser bar.
  for (const t of display.getVideoTracks()) t.addEventListener("ended", finish);
  const limit = setTimeout(finish, maxMs);
  const tick = setInterval(() => {
    try {
      opts.onTick?.(Date.now() - startedAt);
    } catch {
      /* caller's fault */
    }
  }, 250);
  recorder.start(1000);

  return {
    stop() {
      finish();
      return done;
    },
    cancel() {
      cancelled = true;
      chunks.length = 0;
      finish();
    },
  };
}
