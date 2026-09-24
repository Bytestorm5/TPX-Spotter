"use client";
/**
 * Secondary views of the flow: confirmation, review-before-send, similar
 * issues, screen recording, and the team-mode developer drawer.
 */
import { useEffect, useRef, useState } from "react";
import type { PublicStatus, ReportReceipt, SimilarIssue } from "../../../core/schema.ts";
import type { AttachmentSummary, RecordingSession, WidgetCapture } from "../../../core/types.ts";
import * as flow from "../internal/bridge-flow.ts";
import {
  AlertIcon,
  CheckIcon,
  ChevronRight,
  ClickIcon,
  CopyIcon,
  CursorIcon,
  GlobeIcon,
  ImageIcon,
  MicIcon,
  MonitorIcon,
  PlayIcon,
  RecordIcon,
  TerminalIcon,
  ThumbIcon,
} from "../internal/icons.tsx";
import type { MessageKey } from "../locales/index.ts";
import { Status, Submit } from "../primitives/misc.tsx";
import { usePanel } from "./context.ts";

// -- confirmation -------------------------------------------------------------------------------

export function SentView({ receipt, team, hasContact, onDone }: { receipt: ReportReceipt; team: boolean; hasContact: boolean; onDone: () => void }) {
  const { t, part } = usePanel();
  const [copied, setCopied] = useState(false);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <div {...part("confirmation", "sp-done")}>
      <div className="sp-done-icon" aria-hidden="true">
        <CheckIcon />
      </div>
      <h2>{t("sent.title")}</h2>
      <p>{hasContact ? t("sent.body", { ref: receipt.ref }) : t("sent.bodyNoContact", { ref: receipt.ref })}</p>
      <div {...part("reference", "sp-ref")}>
        <span data-testid="spotter-ref">{receipt.ref}</span>
        <button
          type="button"
          className="sp-icon-btn"
          aria-label={copied ? t("sent.copied") : t("sent.copy")}
          title={copied ? t("sent.copied") : t("sent.copy")}
          onClick={() => {
            void navigator.clipboard?.writeText(receipt.ref).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      {offline ? <p className="sp-queued">{t("sent.queued")}</p> : null}
      <div className="sp-done-actions">
        {team && receipt.url ? (
          <a className="sp-btn sp-btn-secondary" href={receipt.url} target="_blank" rel="noopener">
            {t("team.openTicket")}
          </a>
        ) : receipt.statusUrl ? (
          <a className="sp-btn sp-btn-secondary" href={receipt.statusUrl} target="_blank" rel="noopener">
            {t("sent.track")}
          </a>
        ) : null}
        <button type="button" className="sp-btn sp-btn-primary" onClick={onDone} data-autofocus="">
          {t("sent.done")}
        </button>
      </div>
    </div>
  );
}

// -- review before send ----------------------------------------------------------------------------

const REVIEW_ICONS: Record<string, () => React.ReactNode> = {
  screenshot: ImageIcon,
  replay: PlayIcon,
  console: TerminalIcon,
  errors: AlertIcon,
  network: GlobeIcon,
  environment: MonitorIcon,
  dom: CursorIcon,
  storage: TerminalIcon,
  attachment: ImageIcon,
  breadcrumbs: ClickIcon,
  recording: RecordIcon,
};

const REVIEW_LABELS: Partial<Record<AttachmentSummary["kind"] | "breadcrumbs" | "recording" | "annotated", MessageKey>> = {
  screenshot: "review.item.screenshot",
  replay: "review.item.replay",
  console: "review.item.console",
  network: "review.item.network",
  environment: "review.item.environment",
  dom: "review.item.element",
  storage: "review.item.storage",
  errors: "review.item.errors",
  recording: "review.item.recording",
  annotated: "review.item.annotated",
};

export function ReviewList(props: {
  capture: WidgetCapture | null;
  hasShot: boolean;
  annotated: boolean;
  element: boolean;
  recording: boolean;
  include: Partial<Record<AttachmentSummary["kind"], boolean>>;
  onToggle: (kind: AttachmentSummary["kind"], on: boolean) => void;
  busy: boolean;
  error: boolean;
  onSend: () => void;
}) {
  const { t, part } = usePanel();
  type Row = { kind: AttachmentSummary["kind"]; label: string; icon: string; removable: boolean };
  const rows: Row[] = [];
  const seen = new Set<string>();
  const push = (r: Row) => {
    if (seen.has(r.label)) return;
    seen.add(r.label);
    rows.push(r);
  };
  if (props.hasShot)
    push({ kind: "screenshot", label: t(props.annotated ? "review.item.annotated" : "review.item.screenshot"), icon: "screenshot", removable: true });
  if (props.recording) push({ kind: "attachment", label: t("review.item.recording"), icon: "recording", removable: false });
  for (const a of props.capture?.attachments ?? []) {
    if (a.kind === "screenshot") continue;
    const key = REVIEW_LABELS[a.kind];
    const label = key ? t(key, { count: a.count ?? 0 }) : a.label;
    push({ kind: a.kind, label, icon: a.kind, removable: a.kind !== "environment" });
  }
  if (!props.capture?.attachments?.length) {
    // Older clients don't summarise: show what is always collected.
    push({ kind: "console", label: t("review.item.console", { count: "…" }), icon: "console", removable: true });
    push({ kind: "network", label: t("review.item.network", { count: "…" }), icon: "network", removable: true });
    push({ kind: "environment", label: t("review.item.environment"), icon: "environment", removable: false });
  }
  if (props.element) push({ kind: "dom", label: t("review.item.element"), icon: "dom", removable: true });
  return (
    <div className="sp-side">
      <div className="sp-scroll">
        <p className="sp-hint" style={{ fontSize: 13 }}>
          {t("review.intro")}
        </p>
        {props.error ? (
          <div className="sp-notice" data-tone="danger" role="alert">
            <AlertIcon />
            <span>{t("error.submit")}</span>
          </div>
        ) : null}
        <ul {...part("reviewList", "sp-list")}>
          {rows.map((r) => {
            const removed = props.include[r.kind] === false;
            const Icon = REVIEW_ICONS[r.icon] ?? ImageIcon;
            return (
              <li key={r.label} data-removed={removed ? "" : undefined}>
                <span className="sp-list-icon" aria-hidden="true">
                  <Icon />
                </span>
                <span className="sp-list-text">
                  <span className="sp-list-title">{r.label}</span>
                  {removed ? <span className="sp-list-meta">{t("review.removed")}</span> : null}
                </span>
                {r.removable ? (
                  <button
                    type="button"
                    className="sp-btn sp-btn-ghost sp-btn-sm"
                    aria-label={removed ? `${t("review.restore")}: ${r.label}` : t("attach.remove", { item: r.label })}
                    onClick={() => props.onToggle(r.kind, removed)}
                  >
                    {removed ? t("review.restore") : t("review.remove")}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="sp-actions">
        <p className="sp-summary">
          <span>{props.hasShot && props.include.screenshot !== false ? t("attach.summary") : t("attach.summaryText")}</span>
        </p>
        <div className="sp-actions-row">
          <Submit className="sp-btn sp-btn-primary" busy={props.busy} busyLabel={t("submit.sending")} data-autofocus="" onClick={props.onSend} type="button">
            {t("submit.send")}
          </Submit>
        </div>
      </div>
    </div>
  );
}

// -- similar issues ---------------------------------------------------------------------------------

const STATUS_KEYS: Record<PublicStatus, MessageKey> = {
  received: "status.received",
  in_progress: "status.in_progress",
  needs_info: "status.needs_info",
  resolved: "status.resolved",
  wont_fix: "status.wont_fix",
};
export { STATUS_KEYS };

export function SimilarList({ items, busy, onContinue, onDone }: { items: SimilarIssue[]; busy: boolean; onContinue: () => void; onDone: () => void }) {
  const { t, part } = usePanel();
  const [voted, setVoted] = useState<Record<string, number | "pending">>({});
  const any = Object.values(voted).some((v) => v !== "pending");
  return (
    <div className="sp-side">
      <div className="sp-scroll">
        <ul {...part("similarList", "sp-list")}>
          {items.map((it) => {
            const v = voted[it.id];
            const done = typeof v === "number";
            return (
              <li key={it.id}>
                <span className="sp-list-text">
                  <span className="sp-list-title">{it.title}</span>
                  <span className="sp-list-meta" aria-label={`${it.ref}, ${t("similar.count", { count: done ? v : it.count })}`}>
                    {it.ref}
                    <span className="sp-votes" aria-hidden="true">
                      <ThumbIcon />
                      {done ? v : it.count}
                    </span>
                  </span>
                </span>
                <Status status={it.status} label={t(STATUS_KEYS[it.status])} />
                <button
                  type="button"
                  className="sp-btn sp-btn-secondary sp-btn-sm"
                  aria-pressed={done}
                  disabled={v === "pending"}
                  onClick={async () => {
                    if (done) return;
                    setVoted((s) => ({ ...s, [it.id]: "pending" }));
                    const n = await flow.plusOne(it.id);
                    setVoted((s) => ({ ...s, [it.id]: n ?? it.count + 1 }));
                  }}
                >
                  {done ? <CheckIcon /> : <ThumbIcon />}
                  {done ? t("similar.plusOned") : t("similar.plusOne")}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="sp-actions">
        <div className="sp-actions-row">
          {any ? (
            <button type="button" className="sp-btn sp-btn-secondary" onClick={onDone}>
              {t("sent.done")}
            </button>
          ) : null}
          <Submit className="sp-btn sp-btn-primary" type="button" busy={busy} busyLabel={t("submit.sending")} onClick={onContinue}>
            {t("similar.continue")}
          </Submit>
        </div>
      </div>
    </div>
  );
}

// -- recording ------------------------------------------------------------------------------------

let activeSession: RecordingSession | null = null;

export function RecordingSetup({ onStart, onSkip }: { onStart: (mic: boolean) => Promise<RecordingSession | null>; onSkip: () => void }) {
  const { t } = usePanel();
  const [mic, setMic] = useState(false);
  return (
    <div className="sp-side">
      <div className="sp-scroll">
        <p style={{ color: "var(--sp-text-muted)" }}>{t("recording.body")}</p>
        <label className="sp-check">
          <input type="checkbox" checked={mic} onChange={(e) => setMic(e.target.checked)} />
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <MicIcon />
            {t("recording.mic")}
          </span>
        </label>
      </div>
      <div className="sp-actions">
        <div className="sp-actions-row">
          <button type="button" className="sp-btn sp-btn-ghost" onClick={onSkip}>
            {t("annotate.skip")}
          </button>
          <button
            type="button"
            className="sp-btn sp-btn-primary"
            data-autofocus=""
            onClick={async () => {
              activeSession = await onStart(mic);
            }}
          >
            <RecordIcon />
            {t("recording.start")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The minimised "Recording 0:12 · Stop" pill shown while the panel is hidden. */
export function RecordingPill({ onStop }: { onStop: (r: { blob: Blob; contentType: string; startedAt: string; endedAt: string } | null) => void }) {
  const { t } = usePanel();
  const [ms, setMs] = useState(0);
  const started = useRef(Date.now());
  const stopRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const i = setInterval(() => setMs(Date.now() - started.current), 500);
    stopRef.current?.focus();
    return () => clearInterval(i);
  }, []);
  const s = Math.floor(ms / 1000);
  const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const stop = async () => {
    const session = activeSession;
    activeSession = null;
    try {
      onStop(session ? await session.stop() : null);
    } catch {
      onStop(null);
    }
  };
  useEffect(() => {
    if (ms >= 120_000) void stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms >= 120_000]);
  return (
    <div className="sp-float" data-at="bottom" role="region" aria-label={t("recording.title")}>
      <span className="sp-rec-dot" aria-hidden="true" />
      <span aria-live="off">{t("recording.active", { time })}</span>
      <button ref={stopRef} type="button" className="sp-btn sp-btn-primary sp-btn-sm" onClick={() => void stop()}>
        {t("recording.stop")}
      </button>
    </div>
  );
}

// -- team: developer details -------------------------------------------------------------------------

export function DevDetailsDrawer({ captureId }: { captureId: string | undefined }) {
  const { t, part } = usePanel();
  const d = flow.devDetails(captureId);
  return (
    <details {...part("devDetails", "sp-details")}>
      <summary>
        <ChevronRight />
        {t("team.devDetails")}
      </summary>
      <div className="sp-details-body">
        <section>
          <h3 className="sp-subhead">
            {t("team.consoleErrors")} ({d.consoleErrors.length})
          </h3>
          {d.consoleErrors.length ? (
            d.consoleErrors.slice(-5).map((e, i) => (
              <p key={i} className="sp-code" style={{ marginTop: 6 }}>
                {e.message}
              </p>
            ))
          ) : (
            <p className="sp-hint">{t("team.none")}</p>
          )}
        </section>
        <section>
          <h3 className="sp-subhead">
            {t("team.failedRequests")} ({d.failedRequests.length})
          </h3>
          {d.failedRequests.length ? (
            d.failedRequests.slice(-5).map((r, i) => (
              <p key={i} className="sp-code" style={{ marginTop: 6 }}>
                {r.status} {r.method} {r.url}
              </p>
            ))
          ) : (
            <p className="sp-hint">{t("team.none")}</p>
          )}
        </section>
        <section>
          <h3 className="sp-subhead">{t("team.environment")}</h3>
          <dl className="sp-kv" style={{ marginTop: 6 }}>
            {Object.entries(d.environment).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </details>
  );
}
