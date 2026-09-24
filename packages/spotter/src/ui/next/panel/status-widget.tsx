"use client";
/**
 * The lazy half of `<SpotterStatus />`: polling, unread tracking and the
 * reports popover with inline replies to "needs info" questions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReportStatusView } from "../../../core/schema.ts";
import type { StoredReport } from "../../../core/types.ts";
import * as flow from "../internal/bridge-flow.ts";
import { ensureClient } from "../internal/controller.ts";
import { InboxIcon } from "../internal/icons.tsx";
import { PANEL_CSS } from "../theme/panel-css.ts";
import { themeStylesheet, watchScheme, detectScheme } from "../theme/runtime.ts";
import { ensureRuntime, type TriggerRuntime } from "../theme/trigger-runtime.ts";
import type { StatusWidgetProps } from "../status.tsx";
import { Status, Submit } from "../primitives/misc.tsx";
import { STATUS_KEYS } from "./views.tsx";

const SEEN_KEY = "spotter:seen";
const LOCAL_CSS = ":host{all:initial!important;display:inline-block!important;position:relative!important}.sp-root{display:inline-block;position:relative}";

function readSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function writeSeen(v: Record<string, string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(v));
  } catch {
    /* storage blocked: unread state lasts for the page */
  }
}

function adopt(shadow: ShadowRoot, css: string[], nonce?: string): void {
  try {
    if ("adoptedStyleSheets" in shadow) {
      shadow.adoptedStyleSheets = css.map((c) => {
        const s = new CSSStyleSheet();
        s.replaceSync(c);
        return s;
      });
      return;
    }
  } catch {
    /* fall back to <style> */
  }
  shadow.querySelectorAll("style[data-spotter-style]").forEach((n) => n.remove());
  for (const c of css) {
    const el = document.createElement("style");
    el.setAttribute("data-spotter-style", "");
    if (nonce) el.nonce = nonce;
    el.textContent = c;
    shadow.insertBefore(el, shadow.firstChild);
  }
}

interface Row {
  stored: StoredReport;
  view: ReportStatusView | null;
}

export function StatusWidget({ shadow, container, pollSeconds, limit, config, nonce }: StatusWidgetProps) {
  const [rt, setRt] = useState<TriggerRuntime | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [seen, setSeen] = useState<Record<string, string>>(readSeen);
  const [open, setOpen] = useState(false);
  const unstyled = config.appearance?.mode === "unstyled";

  useEffect(() => {
    if (unstyled) return;
    const apply = () => {
      const { css } = themeStylesheet(config.appearance);
      adopt(shadow, [LOCAL_CSS, css, PANEL_CSS], nonce);
      container.setAttribute("data-scheme", detectScheme(config.appearance?.theme));
    };
    apply();
    return watchScheme(apply);
  }, [shadow, container, config.appearance, nonce, unstyled]);

  useEffect(() => {
    void ensureRuntime({ appearance: config.appearance, locale: config.locale, localization: config.localization, nonce }).then((r) => {
      container.setAttribute("dir", r.dir);
      container.setAttribute("lang", r.locale);
      setRt(r);
    });
  }, [config.appearance, config.locale, config.localization, nonce, container]);

  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    await ensureClient();
    const mine = flow.myReports().slice(0, limit);
    const views = await Promise.all(mine.map((r) => flow.status(r.id)));
    setRows(mine.map((stored, i) => ({ stored, view: views[i] ?? null })));
  }, [limit]);

  useEffect(() => {
    void poll();
    const i = setInterval(() => void poll(), Math.max(15, pollSeconds) * 1000);
    const vis = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(i);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [poll, pollSeconds]);

  const unread = useMemo(
    () => rows.filter((r) => r.view && r.view.status !== "received" && seen[r.stored.id] !== r.view.updatedAt).length,
    [rows, seen],
  );

  const markSeen = () => {
    const next = { ...seen };
    for (const r of rows) if (r.view) next[r.stored.id] = r.view.updatedAt;
    setSeen(next);
    writeSeen(next);
  };

  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>("button,textarea,a")?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!e.composedPath().includes(shadow.host)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open, shadow]);

  if (!rt || rows.length === 0) return null;
  const { t } = rt;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="sp-status-pill"
        data-spotter-part="statusBadge"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unread > 0 ? `${t("status.title")} — ${t("status.badge", { count: unread })}` : t("status.title")}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) markSeen();
        }}
      >
        <InboxIcon />
        <span>{t("status.title")}</span>
        {unread > 0 ? (
          <span className="sp-count" aria-hidden="true">
            {unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={popRef}
          className="sp-popover"
          role="dialog"
          aria-label={t("status.title")}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              btnRef.current?.focus();
            }
          }}
        >
          <div className="sp-header">
            <h2 className="sp-title">{t("status.title")}</h2>
          </div>
          <div style={{ overflowY: "auto" }}>
            {rows.map((r) => (
              <ReportRow key={r.stored.id} row={r} rt={rt} unread={!!r.view && r.view.status !== "received" && seen[r.stored.id] !== r.view.updatedAt} onChange={poll} />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function ReportRow({ row, rt, unread, onChange }: { row: Row; rt: TriggerRuntime; unread: boolean; onChange: () => void }) {
  const { t } = rt;
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const v = row.view;
  const status = v?.status ?? row.stored.lastStatus ?? "received";
  const lastTeam = v?.messages.filter((m) => m.from === "team").at(-1);
  const lastChange = v?.history.at(-1);
  return (
    <article className="sp-report">
      <div className="sp-report-head">
        {unread ? <span className="sp-unread" aria-hidden="true" /> : null}
        <span className="sp-report-title">{v?.title ?? row.stored.title}</span>
        <Status status={status} label={t(STATUS_KEYS[status])} />
      </div>
      <span className="sp-list-meta">
        {row.stored.ref}
        {lastChange?.message && status !== "needs_info" ? ` · ${lastChange.message}` : ""}
      </span>
      {status === "needs_info" && lastTeam ? (
        <div className="sp-thread">
          <span className="sp-thread-from">{t("status.question")}</span>
          <p>{lastTeam.body}</p>
          {sent ? (
            <p className="sp-hint" role="status">
              {t("status.sent")}
            </p>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!reply.trim()) return;
                setBusy(true);
                try {
                  await flow.reply(row.stored.id, reply.trim());
                  setSent(true);
                  setReply("");
                  onChange();
                } finally {
                  setBusy(false);
                }
              }}
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              <label className="sp-sr" htmlFor={`sp-reply-${row.stored.id}`}>
                {t("status.reply")}
              </label>
              <textarea
                id={`sp-reply-${row.stored.id}`}
                className="sp-textarea"
                data-size="sm"
                placeholder={t("status.replyPlaceholder")}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
              <Submit className="sp-btn sp-btn-primary sp-btn-sm" busy={busy} busyLabel={t("submit.sending")}>
                {t("status.send")}
              </Submit>
            </form>
          )}
        </div>
      ) : null}
    </article>
  );
}
