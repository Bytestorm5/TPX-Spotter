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
  ClickIcon,
  CopyIcon,
  CursorIcon,
  ExternalIcon,
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
import { Badge, Button, Checkbox, Details, IconButton, KeyValue, List, ListItem, Notice, type Tone } from "@trusplex/ui";
import { usePanel } from "./context.ts";

// -- confirmation -------------------------------------------------------------------------------

export function SentView({ receipt, team, hasContact, onDone }: { receipt: ReportReceipt; team: boolean; hasContact: boolean; onDone: () => void }) {
  const { t, part } = usePanel();
  const [copied, setCopied] = useState(false);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  // Team members go to the ticket in Console; everyone else to the public tracking page.
  const follow = team && receipt.url ? { href: receipt.url, label: t("team.openTicket") } : receipt.statusUrl ? { href: receipt.statusUrl, label: t("sent.track") } : null;
  return (
    <div {...part("confirmation", "sp-done")}>
      <div className="sp-done-icon" aria-hidden="true">
        <CheckIcon />
      </div>
      <h2>{t("sent.title")}</h2>
      <p>{hasContact ? t("sent.body", { ref: receipt.ref }) : t("sent.bodyNoContact", { ref: receipt.ref })}</p>
      <div {...part("reference", "sp-ref")}>
        <span data-testid="spotter-ref">{receipt.ref}</span>
        <IconButton
          size="sm"
          label={copied ? t("sent.copied") : t("sent.copy")}
          onClick={() => {
            void navigator.clipboard?.writeText(receipt.ref).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </IconButton>
      </div>
      {offline ? <p className="sp-queued">{t("sent.queued")}</p> : null}
      <div className="sp-done-actions">
        {follow ? (
          <Button asChild variant="secondary" {...part("track")}>
            <a href={follow.href} target="_blank" rel="noopener">
              {follow.label}
              <ExternalIcon />
            </a>
          </Button>
        ) : null}
        <Button {...part("buttonPrimary")} onClick={onDone} data-autofocus="">
          {t("sent.done")}
        </Button>
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
        <p className="tui-hint" style={{ fontSize: 13 }}>
          {t("review.intro")}
        </p>
        {props.error ? (
          <Notice tone="danger" icon={<AlertIcon />}>
            {t("error.submit")}
          </Notice>
        ) : null}
        <List {...part("reviewList")}>
          {rows.map((r) => {
            const removed = props.include[r.kind] === false;
            const Icon = REVIEW_ICONS[r.icon] ?? ImageIcon;
            return (
              <ListItem
                key={r.label}
                data-removed={removed ? "" : undefined}
                icon={<Icon />}
                title={r.label}
                meta={removed ? t("review.removed") : undefined}
                end={
                  r.removable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={removed ? `${t("review.restore")}: ${r.label}` : t("attach.remove", { item: r.label })}
                      onClick={() => props.onToggle(r.kind, removed)}
                    >
                      {removed ? t("review.restore") : t("review.remove")}
                    </Button>
                  ) : null
                }
              />
            );
          })}
        </List>
      </div>
      <div className="sp-actions">
        <p className="sp-summary">
          <span>{props.hasShot && props.include.screenshot !== false ? t("attach.summary") : t("attach.summaryText")}</span>
        </p>
        <div className="sp-actions-row">
          <Button {...part("buttonPrimary")} busy={props.busy} data-autofocus="" onClick={props.onSend}>
            {props.busy ? t("submit.sending") : t("submit.send")}
          </Button>
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

/** A report's public status as a kit badge. */
const STATUS_TONES: Record<PublicStatus, Tone> = {
  received: "neutral",
  in_progress: "info",
  needs_info: "warning",
  resolved: "success",
  wont_fix: "neutral",
};

export function StatusBadge({ status, label }: { status: PublicStatus; label: string }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot data-status={status} data-spotter-part="status">
      {label}
    </Badge>
  );
}

export function SimilarList({ items, busy, onContinue, onDone }: { items: SimilarIssue[]; busy: boolean; onContinue: () => void; onDone: () => void }) {
  const { t, part } = usePanel();
  const [voted, setVoted] = useState<Record<string, number | "pending">>({});
  const any = Object.values(voted).some((v) => v !== "pending");
  return (
    <div className="sp-side">
      <div className="sp-scroll">
        <List {...part("similarList")}>
          {items.map((it) => {
            const v = voted[it.id];
            const done = typeof v === "number";
            return (
              <ListItem
                key={it.id}
                title={it.title}
                meta={
                  <span aria-label={`${it.ref}, ${t("similar.count", { count: done ? v : it.count })}`}>
                    {it.ref}
                    <span className="sp-votes" aria-hidden="true">
                      <ThumbIcon />
                      {done ? v : it.count}
                    </span>
                  </span>
                }
                end={
                  <>
                    <StatusBadge status={it.status} label={t(STATUS_KEYS[it.status])} />
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-pressed={done}
                      disabled={v === "pending"}
                      iconStart={done ? <CheckIcon /> : <ThumbIcon />}
                      onClick={async () => {
                        if (done) return;
                        setVoted((s) => ({ ...s, [it.id]: "pending" }));
                        const n = await flow.plusOne(it.id);
                        setVoted((s) => ({ ...s, [it.id]: n ?? it.count + 1 }));
                      }}
                    >
                      {done ? t("similar.plusOned") : t("similar.plusOne")}
                    </Button>
                  </>
                }
              />
            );
          })}
        </List>
      </div>
      <div className="sp-actions">
        <div className="sp-actions-row">
          {any ? (
            <Button variant="secondary" onClick={onDone}>
              {t("sent.done")}
            </Button>
          ) : null}
          <Button {...part("buttonPrimary")} busy={busy} onClick={onContinue}>
            {busy ? t("submit.sending") : t("similar.continue")}
          </Button>
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
        <Checkbox
          checked={mic}
          onChange={(e) => setMic(e.target.checked)}
          label={
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <MicIcon />
              {t("recording.mic")}
            </span>
          }
        />
      </div>
      <div className="sp-actions">
        <div className="sp-actions-row">
          <Button variant="ghost" onClick={onSkip}>
            {t("annotate.skip")}
          </Button>
          <Button
            data-autofocus=""
            iconStart={<RecordIcon />}
            onClick={async () => {
              activeSession = await onStart(mic);
            }}
          >
            {t("recording.start")}
          </Button>
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
      <Button ref={stopRef} size="sm" onClick={() => void stop()}>
        {t("recording.stop")}
      </Button>
    </div>
  );
}

// -- team: developer details -------------------------------------------------------------------------

export function DevDetailsDrawer({ captureId }: { captureId: string | undefined }) {
  const { t, part } = usePanel();
  const d = flow.devDetails(captureId);
  return (
    <Details {...part("devDetails", "sp-details")} summary={t("team.devDetails")}>
      <section>
        <h3 className="tui-subhead">
          {t("team.consoleErrors")} ({d.consoleErrors.length})
        </h3>
        {d.consoleErrors.length ? (
          d.consoleErrors.slice(-5).map((e, i) => (
            <p key={i} className="tui-code sp-code" style={{ marginTop: 6 }}>
              {e.message}
            </p>
          ))
        ) : (
          <p className="tui-hint">{t("team.none")}</p>
        )}
      </section>
      <section>
        <h3 className="tui-subhead">
          {t("team.failedRequests")} ({d.failedRequests.length})
        </h3>
        {d.failedRequests.length ? (
          d.failedRequests.slice(-5).map((r, i) => (
            <p key={i} className="tui-code sp-code" style={{ marginTop: 6 }}>
              {r.status} {r.method} {r.url}
            </p>
          ))
        ) : (
          <p className="tui-hint">{t("team.none")}</p>
        )}
      </section>
      <section>
        <h3 className="tui-subhead">{t("team.environment")}</h3>
        <KeyValue mono style={{ marginTop: 6 }} items={Object.entries(d.environment).map(([k, v]) => [k, v])} />
      </section>
    </Details>
  );
}
