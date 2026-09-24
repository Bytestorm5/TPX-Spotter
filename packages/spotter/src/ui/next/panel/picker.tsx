"use client";
/**
 * "Report this" element picker: hover highlights, click picks. Events are
 * intercepted in the capture phase so the host's own handlers never see the
 * pick click (no accidental "Buy now"). Esc or Cancel backs out.
 */
import { useEffect, useRef, useState } from "react";
import { peekUiRoot } from "../internal/host.ts";
import { usePanel } from "./context.ts";

function label(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = Array.from(el.classList)
    .filter((c) => !/^(css|sc|jsx|tw)-|[[\]:]/.test(c))
    .slice(0, 2);
  return cls.length ? `${tag}.${cls.join(".")}` : tag;
}

export function Picker({ onPick, onCancel }: { onPick: (el: Element) => void; onCancel: () => void }) {
  const { t, part } = usePanel();
  const [box, setBox] = useState<{ rect: DOMRect; label: string } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const current = useRef<Element | null>(null);
  const cb = useRef({ onPick, onCancel });
  cb.current = { onPick, onCancel };

  useEffect(() => {
    const host = peekUiRoot()?.host;
    const hit = (x: number, y: number): Element | null => {
      const el = document.elementFromPoint(x, y);
      if (!el || el === host || host?.contains(el) || el === document.documentElement || el === document.body) return null;
      return el;
    };
    const move = (e: PointerEvent) => {
      const el = hit(e.clientX, e.clientY);
      current.current = el;
      setBox(el ? { rect: el.getBoundingClientRect(), label: label(el) } : null);
    };
    const swallow = (e: Event) => {
      const path = e.composedPath();
      if (host && path.includes(host)) return; // our own Cancel button
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const click = (e: MouseEvent) => {
      const path = e.composedPath();
      if (host && path.includes(host)) return;
      swallow(e);
      const el = hit(e.clientX, e.clientY) ?? current.current;
      if (el) cb.current.onPick(el);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cb.current.onCancel();
      }
    };
    const root = document.documentElement;
    const prevCursor = root.style.cursor;
    root.style.cursor = "crosshair";
    window.addEventListener("pointermove", move, true);
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart", "touchend"]) window.addEventListener(t, swallow, true);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", key, true);
    cancelRef.current?.focus();
    return () => {
      root.style.cursor = prevCursor;
      window.removeEventListener("pointermove", move, true);
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart", "touchend"]) window.removeEventListener(t, swallow, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  return (
    <>
      {box ? (
        <div
          {...part("pickerBox", "sp-picker-box")}
          aria-hidden="true"
          style={{ left: box.rect.left, top: box.rect.top, width: box.rect.width, height: box.rect.height }}
        >
          <span className="sp-picker-tag">{box.label}</span>
        </div>
      ) : null}
      <div {...part("picker", "sp-float")} data-at="top" role="dialog" aria-label={t("attach.pickElement")}>
        <span role="status">{t("picker.hint")}</span>
        <button ref={cancelRef} type="button" className="sp-btn sp-btn-secondary sp-btn-sm" onClick={onCancel}>
          {t("picker.cancel")}
        </button>
      </div>
    </>
  );
}
