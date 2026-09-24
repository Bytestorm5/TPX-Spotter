"use client";
/**
 * The annotate step: toolbar (tools, colours, undo/redo) over the canvas.
 * While the screenshot is still being captured it shows a skeleton, so the
 * panel is on screen immediately.
 */
import type { ReactNode } from "react";
import { canRedo, canUndo, COLORS, redo, undo, type History, type Tool } from "../annotate/model.ts";
import { ArrowIcon, BlurIcon, PenIcon, PinIcon, RectIcon, RedoIcon, TextIcon, UndoIcon } from "../internal/icons.tsx";
import type { MessageKey } from "../locales/index.ts";
import { AnnotationCanvas } from "../primitives/annotation.tsx";
import type { LoadedImage } from "../primitives/screenshot.tsx";
import { usePanel } from "./context.ts";

const TOOL_META: { tool: Tool; key: string; label: MessageKey; icon: () => ReactNode }[] = [
  { tool: "rect", key: "R", label: "annotate.tool.rect", icon: RectIcon },
  { tool: "arrow", key: "A", label: "annotate.tool.arrow", icon: ArrowIcon },
  { tool: "freehand", key: "D", label: "annotate.tool.freehand", icon: PenIcon },
  { tool: "text", key: "T", label: "annotate.tool.text", icon: TextIcon },
  { tool: "pin", key: "P", label: "annotate.tool.pin", icon: PinIcon },
  { tool: "blur", key: "B", label: "annotate.tool.blur", icon: BlurIcon },
];

const COLOR_NAMES: Record<string, string> = {
  "#e5484d": "Red",
  "#f5a524": "Amber",
  "#30a46c": "Green",
  "#0090ff": "Blue",
  "#18181b": "Black",
  "#ffffff": "White",
};

export interface StageProps {
  image: LoadedImage | null;
  failed: boolean;
  annotate: boolean;
  history: History;
  onHistory: (h: History) => void;
  tool: Tool;
  onTool: (t: Tool) => void;
  color: string;
  onColor: (c: string) => void;
  onAnnounce: (message: string) => void;
  /** The reporter removed the screenshot in review: show it dimmed. */
  removed?: boolean;
  /** Mobile only: the step's own actions. */
  footer?: ReactNode;
}

export function Stage(props: StageProps) {
  const { t, part } = usePanel();
  const { image, history } = props;
  return (
    <section {...part("stage", "sp-stage")} aria-label={t("annotate.title")} data-removed={props.removed ? "" : undefined}>
      {props.annotate && image ? (
        <div {...part("toolbar", "sp-toolbar")} role="toolbar" aria-label={t("annotate.tools")}>
          <div className="sp-toolgroup">
            {TOOL_META.map((m) => (
              <button
                key={m.tool}
                type="button"
                {...part("tool", "sp-tool")}
                aria-pressed={props.tool === m.tool}
                aria-label={t(m.label)}
                aria-keyshortcuts={m.key}
                title={`${t(m.label)} (${m.key})`}
                onClick={() => props.onTool(m.tool)}
              >
                <m.icon />
              </button>
            ))}
          </div>
          <div className="sp-toolgroup" role="radiogroup" aria-label={t("annotate.color")}>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                className="sp-swatch"
                aria-checked={props.color === c}
                aria-label={COLOR_NAMES[c] ?? c}
                title={COLOR_NAMES[c]}
                disabled={props.tool === "blur"}
                onClick={() => props.onColor(c)}
              >
                <span style={{ background: c }} />
              </button>
            ))}
          </div>
          <div className="sp-toolgroup">
            <button
              type="button"
              className="sp-tool"
              aria-label={t("annotate.undo")}
              aria-keyshortcuts="Control+Z Meta+Z"
              title={`${t("annotate.undo")} (⌘Z)`}
              disabled={!canUndo(history)}
              onClick={() => props.onHistory(undo(history))}
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              className="sp-tool"
              aria-label={t("annotate.redo")}
              aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
              title={`${t("annotate.redo")} (⇧⌘Z)`}
              disabled={!canRedo(history)}
              onClick={() => props.onHistory(redo(history))}
            >
              <RedoIcon />
            </button>
          </div>
        </div>
      ) : null}
      <div className="sp-canvas-wrap">
        {image ? (
          props.annotate ? (
            <AnnotationCanvas
              image={image}
              history={history}
              onHistory={props.onHistory}
              tool={props.tool}
              onToolChange={props.onTool}
              color={props.color}
              label={t("annotate.canvas")}
              keyboardHint={t("annotate.keyboardHint")}
              textLabel={t("annotate.textPrompt")}
              announce={(tool) => props.onAnnounce(t("annotate.added", { tool: t(TOOL_META.find((m) => m.tool === tool)!.label) }))}
              fallback={<StaticShot image={image} alt={t("attach.screenshot")} />}
            />
          ) : (
            <StaticShot image={image} alt={t("attach.screenshot")} />
          )
        ) : props.failed ? (
          <p className="sp-notice" data-tone="info">
            {t("capture.failed")}
          </p>
        ) : (
          <div className="sp-skeleton" aria-busy="true">
            <span className="sp-spinner" aria-hidden="true" />
            <span>{t("capture.capturing")}</span>
          </div>
        )}
      </div>
      {props.annotate && image ? <p className="sp-stage-hint">{t("annotate.hint")}</p> : null}
      {props.footer}
    </section>
  );
}

function StaticShot({ image, alt }: { image: LoadedImage; alt: string }) {
  return (
    <div className="sp-canvas-frame">
      <canvas
        className="sp-canvas"
        role="img"
        aria-label={alt}
        ref={(c) => {
          if (!c) return;
          c.width = image.width;
          c.height = image.height;
          c.getContext("2d")?.drawImage(image.source, 0, 0);
        }}
        style={{ maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", cursor: "default" }}
      />
    </div>
  );
}
