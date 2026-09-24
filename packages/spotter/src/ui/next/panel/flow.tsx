"use client";
/**
 * `<Spotter />`'s report flow.
 *
 * Capture (started by the trigger, before this renders) → Annotate →
 * Describe (+ Contact when not identified) → optional Review → optional
 * "Others reported something similar" → Submit → Confirmation.
 *
 * Wide screens show annotate and describe side by side (the reporter sees
 * what they're describing); below 720px they're two full-screen steps. Text,
 * feature-request and recording flows use the compact panel.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { FEATURE_ANNOTATE, FEATURE_RECORDING, FEATURE_SCREENSHOT } from "../../../core/features.ts";
import { CATEGORIES, SEVERITIES, type Category, type FieldValue, type Severity, type SimilarIssue } from "../../../core/schema.ts";
import type { AttachmentSummary, WidgetCapture } from "../../../core/types.ts";
import { commit, createHistory, DEFAULT_COLOR, exportShapes, type History, type Shape, type Tool } from "../annotate/model.ts";
import * as bridge from "../internal/bridge.ts";
import * as flow from "../internal/bridge-flow.ts";
import { closeFlow, takeCapture } from "../internal/controller.ts";
import { isValidEmail, validateFields, visibleValues, isFieldVisible, type FieldIssue } from "../internal/fields.ts";
import { peekUiRoot } from "../internal/host.ts";
import {
  AlertIcon,
  BackIcon,
  CameraIcon,
  ChevronRight,
  CloseIcon,
  CursorIcon,
  RecordIcon,
  ShieldIcon,
  TrashIcon,
} from "../internal/icons.tsx";
import { update, type UiSnapshot } from "../internal/store.ts";
import type { MessageKey } from "../locales/index.ts";
import { loadRenderer } from "../primitives/annotation.tsx";
import { Panel as Dialog } from "../primitives/dialog.tsx";
import { Field } from "../primitives/field.tsx";
import { LiveRegion, Submit } from "../primitives/misc.tsx";
import { loadImage, Screenshot, type LoadedImage } from "../primitives/screenshot.tsx";
import { usePanel } from "./context.ts";
import { Picker } from "./picker.tsx";
import { Stage } from "./stage.tsx";
import { DevDetailsDrawer, RecordingPill, RecordingSetup, ReviewList, SentView, SimilarList } from "./views.tsx";

type View = "describe" | "review" | "similar" | "sent" | "recording-setup";
type Overlay = null | "picker" | "recording";

const CATEGORY_KEYS: Record<Category, MessageKey> = {
  bug: "category.bug",
  ux: "category.ux",
  content: "category.content",
  performance: "category.performance",
  question: "category.question",
  feature: "category.feature",
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function projectRef(project: string | undefined): string {
  if (project) return project.slice(0, 16);
  return typeof location !== "undefined" ? location.host : "";
}

export function Flow({ snap, teamSignIn }: { snap: UiSnapshot; teamSignIn: boolean }) {
  const { t, config, part } = usePanel();
  const client = bridge.peekClient();
  const mode = snap.mode === "picker" ? "report" : snap.mode;
  const annotateOn = FEATURE_ANNOTATE && (client ? client.enabled("annotate") : true);
  const shotExpected = mode === "report" && FEATURE_SCREENSHOT && (client ? client.enabled("screenshot") : true);
  const team = snap.reporter === "team";
  const remote = bridge.remoteConfig();

  // -- capture
  const [capture, setCapture] = useState<WidgetCapture | null>(null);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [shotFailed, setShotFailed] = useState(false);
  const [capturing, setCapturing] = useState(shotExpected);
  const [includeShot, setIncludeShot] = useState(true);

  // -- annotate
  const [history, setHistory] = useState<History>(createHistory());
  const [tool, setTool] = useState<Tool>("rect");
  const [color, setColor] = useState<string>(DEFAULT_COLOR);

  // -- describe
  const prefill = snap.prefill;
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [showExpected, setShowExpected] = useState(!!prefill?.expected);
  const [expected, setExpected] = useState(prefill?.expected ?? "");
  const [category, setCategory] = useState<Category | null>(prefill?.category ?? (mode === "feature" ? "feature" : null));
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [assignee, setAssignee] = useState("");
  const [labels, setLabels] = useState("");
  const [values, setValues] = useState<Record<string, FieldValue | undefined>>({ ...(prefill?.fields ?? {}) });
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, FieldIssue | "email">>({});
  const [element, setElement] = useState<Element | null>(snap.element);
  const [recording, setRecording] = useState<{ blob: Blob; contentType: string; startedAt: string; endedAt: string } | null>(null);
  const [include, setInclude] = useState<Partial<Record<AttachmentSummary["kind"], boolean>>>({});

  // -- flow
  const [view, setView] = useState<View>(mode === "recording" ? "recording-setup" : "describe");
  const [step, setStep] = useState<"annotate" | "describe">(shotExpected && annotateOn ? "annotate" : "describe");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [similar, setSimilar] = useState<SimilarIssue[] | null>(null);
  const [announce, setAnnounce] = useState("");
  const [alert, setAlert] = useState("");
  const descRef = useRef<HTMLTextAreaElement>(null);

  const identity = bridge.identity();
  const identified = !!identity;
  const fields = useMemo(() => config.fields ?? remote?.fields ?? [], [config.fields, remote]);
  const scope = { category: category ?? undefined, severity: severity ?? undefined, values };
  const duplicates = { public: false, team: true, guest: true, ...remote?.duplicates, ...config.duplicates };
  const similarOn = duplicates[snap.reporter] === true;
  const poweredBy = remote?.poweredBy !== false;
  const testMode = capture?.test ?? config.environment === "development";

  // Take the capture the trigger started.
  useEffect(() => {
    let alive = true;
    const pending = takeCapture();
    if (shotExpected) setAnnounce(t("capture.capturing"));
    if (!pending) {
      setCapturing(false);
      return;
    }
    pending
      .then(async (c) => {
        if (!alive) return;
        setCapture(c);
        if (c.screenshot) {
          const img = await loadImage(c.screenshot.blob);
          if (!alive) return;
          setImage(img);
          if (snap.element) outlineElement(snap.element, img);
          setAnnounce(t("capture.captured"));
        } else if (shotExpected) {
          setShotFailed(true);
          setStep("describe");
          setAnnounce(t("capture.failed"));
        }
      })
      .catch(() => {
        if (!alive) return;
        if (shotExpected) {
          setShotFailed(true);
          setStep("describe");
          setAnnounce(t("capture.failed"));
        }
      })
      .finally(() => {
        if (!alive) return;
        setCapturing(false);
        update({ state: "annotating" });
        bridge.setState("annotating");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Element reports start with the element already outlined on the screenshot. */
  function outlineElement(el: Element, img: LoadedImage) {
    const r = el.getBoundingClientRect();
    const sx = img.width / window.innerWidth;
    const sy = img.height / window.innerHeight;
    const pad = 6;
    const shape: Shape = {
      id: -1,
      tool: "rect",
      color: DEFAULT_COLOR,
      points: [
        { x: Math.max(0, (r.left - pad) * sx), y: Math.max(0, (r.top - pad) * sy) },
        { x: Math.min(img.width, (r.right + pad) * sx), y: Math.min(img.height, (r.bottom + pad) * sy) },
      ],
    };
    setHistory((h) => commit(h, [...h.present, shape]));
  }

  const hasShot = !!image && includeShot;
  const split = shotExpected && !shotFailed && includeShot && (view === "describe" || view === "review" || view === "similar");
  const close = () => closeFlow();

  // -- recapture / picker / recording ---------------------------------------------------------

  async function recapture(el: Element | null) {
    const host = peekUiRoot()?.host;
    setCapturing(true);
    setShotFailed(false);
    setIncludeShot(true);
    try {
      const c = await bridge.capture({ screenshot: FEATURE_SCREENSHOT, element: el, exclude: host ? [host] : [] });
      bridge.discardCapture(capture?.id);
      setCapture(c);
      if (c.screenshot) {
        const img = await loadImage(c.screenshot.blob);
        setImage(img);
        setHistory(createHistory());
        if (el) outlineElement(el, img);
      }
    } catch {
      setShotFailed(true);
    } finally {
      setCapturing(false);
    }
  }

  async function startRecording(mic: boolean) {
    setOverlay("recording");
    try {
      const session = await flow.startRecording({ mic, maxMs: 120_000 });
      return session;
    } catch {
      setOverlay(null);
      setView("describe");
      setAlert(t("recording.failed"));
      return null;
    }
  }

  // -- submit ------------------------------------------------------------------------------

  function validate(): boolean {
    const next: Record<string, FieldIssue | "email"> = {};
    if (!description.trim()) next.description = { code: "required" };
    Object.assign(next, validateFields(fields, scope));
    if (!identified && email.trim() && !isValidEmail(email)) next.email = "email";
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) {
      setAlert(t("validation.required"));
      const target = first === "description" ? descRef.current : peekUiRoot()?.container.querySelector<HTMLElement>(`[data-field="${first}"] :is(select,textarea,input,button)`);
      target?.focus();
      if (first === "description" && step === "annotate") setStep("describe");
      return false;
    }
    return true;
  }

  async function onSend(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    if (view === "describe" && !validate()) return;
    if (view === "describe" && config.privacy?.reviewBeforeSend) {
      setView("review");
      return;
    }
    if (similarOn && similar === null && view !== "similar") {
      setBusy(true);
      const found = await Promise.race([
        flow.similar({ url: location.href, selector: capture?.page?.selector }),
        new Promise<SimilarIssue[]>((r) => setTimeout(() => r([]), 1500)),
      ]);
      setBusy(false);
      setSimilar(found);
      if (found.length > 0) {
        setView("similar");
        return;
      }
    }
    await submit();
  }

  async function submit() {
    setBusy(true);
    setSubmitError(false);
    update({ state: "submitting", error: null });
    bridge.setState("submitting");
    setAnnounce(t("submit.sending"));
    try {
      const shapes = history.present;
      const renderer = hasShot && shapes.length > 0 && include.screenshot !== false ? loadRenderer() : null;
      const annotated = renderer ? await (await renderer).flattenToPng(image!.source, shapes, image!) : undefined;
      const fileList = Object.values(files).flat();
      const receipt = await flow.submit({
        captureId: capture?.id,
        mode,
        title: prefill?.title,
        description: description.trim(),
        expected: showExpected && expected.trim() ? expected.trim() : undefined,
        category: category ?? (mode === "feature" ? "feature" : "bug"),
        severity: team ? (severity ?? undefined) : undefined,
        fields: visibleValues(fields, scope),
        annotations: hasShot ? exportShapes(shapes) : [],
        annotatedScreenshot: annotated,
        include: { ...include, ...(hasShot ? {} : { screenshot: false }) },
        email: !identified && email.trim() ? email.trim() : undefined,
        recording: recording ?? undefined,
        files: fileList.length ? fileList : undefined,
        assignee: team && assignee.trim() ? assignee.trim() : undefined,
        labels: team ? labels.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      update({ state: "sent", receipt });
      bridge.setState("sent");
      setView("sent");
      setAnnounce(`${t("sent.title")}. ${t("sent.bodyNoContact", { ref: receipt.ref })}`);
    } catch (error) {
      update({ state: "error", error });
      bridge.setState("error");
      setSubmitError(true);
      setAlert(t("error.submit"));
    } finally {
      setBusy(false);
    }
  }

  // -- render --------------------------------------------------------------------------------

  if (overlay === "picker") {
    return (
      <Picker
        onCancel={() => setOverlay(null)}
        onPick={(el) => {
          setOverlay(null);
          setElement(el);
          void recapture(el);
        }}
      />
    );
  }

  const title =
    view === "review"
      ? t("review.title")
      : view === "similar"
        ? t("similar.title")
        : mode === "feature"
          ? t("panel.title.feature")
          : mode === "recording" && view === "recording-setup"
            ? t("panel.title.recording")
            : t("panel.title.report");
  const back =
    view === "review" || view === "similar"
      ? () => setView("describe")
      : split && step === "describe" && annotateOn
        ? () => setStep("annotate")
        : null;
  const layout = split ? "split" : "compact";
  const position = config.appearance?.layout?.position ?? "bottom-right";
  const primaryLabel =
    view === "describe" && config.privacy?.reviewBeforeSend ? t("submit.review") : mode === "feature" ? t("submit.sendIdea") : t("submit.send");

  const attachments = (
    <AttachmentRows
      image={hasShot && (!split || step === "describe") ? image : null}
      showThumb={!split}
      history={history}
      element={element}
      recording={recording}
      canAddShot={FEATURE_SCREENSHOT && mode !== "feature" && !hasShot && !capturing}
      canPick={mode !== "feature"}
      canRecord={FEATURE_RECORDING && mode !== "feature" && !recording && (client ? client.enabled("recording") : false)}
      capturing={capturing && !split}
      onAnnotate={() => setStep("annotate")}
      onRemoveShot={() => {
        setIncludeShot(false);
        setInclude((i) => ({ ...i, screenshot: false }));
      }}
      onAddShot={() => void recapture(element)}
      onPick={() => setOverlay("picker")}
      onRecord={() => setView("recording-setup")}
      onRemoveRecording={() => setRecording(null)}
      onRemoveElement={() => setElement(null)}
    />
  );

  const describe = (
    <form {...part("form", "sp-side")} onSubmit={onSend} noValidate aria-labelledby="sp-title">
      <div className="sp-scroll">
        {snap.origin === "boundary" ? (
          <div className="sp-notice" data-tone="info">
            <AlertIcon />
            <span>{t("error.boundary")}</span>
          </div>
        ) : null}
        {submitError ? (
          <div className="sp-notice" data-tone="danger" role="alert">
            <AlertIcon />
            <span>{t("error.submit")}</span>
          </div>
        ) : null}
        <div className="sp-field" data-field="description">
          <label htmlFor="sp-desc" className="sp-label" {...part("label", "sp-label")}>
            {mode === "feature" ? t("describe.featureWhat") : t("describe.what")}
          </label>
          <textarea
            id="sp-desc"
            ref={descRef}
            {...part("textarea", "sp-textarea")}
            data-autofocus={!split || step === "describe" ? "" : undefined}
            required
            aria-required="true"
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={errors.description ? "sp-desc-err" : undefined}
            placeholder={
              snap.origin === "boundary"
                ? t("error.boundaryPrefill")
                : mode === "feature"
                  ? t("describe.featurePlaceholder")
                  : t("describe.whatPlaceholder")
            }
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              if (errors.description) setErrors(({ description: _, ...rest }) => rest);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void onSend();
            }}
          />
          {errors.description ? (
            <p id="sp-desc-err" className="sp-error" {...part("error", "sp-error")}>
              {t("validation.required")}
            </p>
          ) : null}
        </div>

        {mode !== "feature" ? (
          <div className="sp-field">
            <div className="sp-label-row">
              <span id="sp-cat" className="sp-label">
                {t("describe.category")}
              </span>
              <span className="sp-optional">{t("contact.optional")}</span>
            </div>
            <div className="sp-chips" role="radiogroup" aria-labelledby="sp-cat">
              {CATEGORIES.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  {...part("chip", "sp-chip")}
                  aria-checked={category === c}
                  tabIndex={category === c || (category === null && i === 0) ? 0 : -1}
                  onClick={() => setCategory(category === c ? null : c)}
                  onKeyDown={(e) => {
                    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                    if (!d) return;
                    e.preventDefault();
                    const rtl = (e.currentTarget.closest("[dir]") as HTMLElement | null)?.dir === "rtl" && (e.key === "ArrowRight" || e.key === "ArrowLeft");
                    const n = (i + (rtl ? -d : d) + CATEGORIES.length) % CATEGORIES.length;
                    setCategory(CATEGORIES[n]!);
                    (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
                  }}
                >
                  {t(CATEGORY_KEYS[c])}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {showExpected ? (
          <div className="sp-field">
            <div className="sp-label-row">
              <label htmlFor="sp-exp" className="sp-label">
                {t("describe.expected")}
              </label>
              <span className="sp-optional">{t("contact.optional")}</span>
            </div>
            <textarea
              id="sp-exp"
              {...part("textarea", "sp-textarea")}
              data-size="sm"
              placeholder={t("describe.expectedPlaceholder")}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </div>
        ) : mode !== "feature" ? (
          <button type="button" className="sp-disclose" onClick={() => setShowExpected(true)}>
            <ChevronRight />
            {t("describe.addExpected")}
          </button>
        ) : null}

        {fields
          .filter((f) => isFieldVisible(f, scope, fields))
          .map((f) => (
            <div key={f.id} data-field={f.id}>
              <Field
                field={f}
                value={values[f.id]}
                issue={(errors[f.id] as FieldIssue | undefined) ?? null}
                labels={{
                  optional: t("contact.optional"),
                  select: t("field.select"),
                  file: t("field.file"),
                  fileNone: t("field.fileNone"),
                  rating: (v, m) => t("field.rating", { value: v, max: m }),
                  error: (issue) => issue.message ?? t(`validation.${issue.code === "email" ? "email" : issue.code}` as MessageKey),
                }}
                onChange={(v, fl) => {
                  setValues((prev) => ({ ...prev, [f.id]: v }));
                  if (fl) setFiles((prev) => ({ ...prev, [f.id]: fl }));
                  if (errors[f.id]) setErrors(({ [f.id]: _, ...rest }) => rest);
                }}
              />
            </div>
          ))}

        {team ? (
          <>
            <div className="sp-field">
              <span id="sp-sev" className="sp-label">
                {t("team.severity")}
              </span>
              <div className="sp-chips" role="radiogroup" aria-labelledby="sp-sev">
                {SEVERITIES.map((s) => (
                  <button key={s} type="button" role="radio" className="sp-chip" aria-checked={severity === s} onClick={() => setSeverity(severity === s ? null : s)}>
                    {t(`severity.${s}` as MessageKey)}
                  </button>
                ))}
              </div>
            </div>
            <div className="sp-grid2">
              <div className="sp-field">
                <label htmlFor="sp-assignee" className="sp-label">
                  {t("team.assignee")}
                </label>
                <input id="sp-assignee" className="sp-input" placeholder={t("team.assigneePlaceholder")} value={assignee} onChange={(e) => setAssignee(e.target.value)} />
              </div>
              <div className="sp-field">
                <label htmlFor="sp-labels" className="sp-label">
                  {t("team.labels")}
                </label>
                <input id="sp-labels" className="sp-input" placeholder={t("team.labelsPlaceholder")} value={labels} onChange={(e) => setLabels(e.target.value)} />
              </div>
            </div>
          </>
        ) : null}

        {!identified ? (
          <div className="sp-field" data-field="email">
            <div className="sp-label-row">
              <label htmlFor="sp-email" className="sp-label">
                {t("contact.email")}
              </label>
              <span className="sp-optional">{t("contact.optional")}</span>
            </div>
            <input
              id="sp-email"
              type="email"
              autoComplete="email"
              inputMode="email"
              {...part("input", "sp-input")}
              placeholder={t("contact.emailPlaceholder")}
              value={email}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? "sp-email-err" : "sp-email-hint"}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errors.email) setErrors(({ email: _, ...rest }) => rest);
              }}
            />
            {errors.email ? (
              <p id="sp-email-err" className="sp-error">
                {t("validation.email")}
              </p>
            ) : (
              <p id="sp-email-hint" className="sp-hint">
                {t("contact.emailHint")}
              </p>
            )}
          </div>
        ) : null}

        {attachments}
        {team ? <DevDetailsDrawer captureId={capture?.id} /> : null}
      </div>
      <div {...part("actions", "sp-actions")}>
        <p className="sp-summary" {...part("summary", "sp-summary")}>
          <ShieldIcon />
          <span>{hasShot ? t("attach.summary") : t("attach.summaryText")}</span>
        </p>
        <div className="sp-actions-row">
          <Submit {...part("buttonPrimary", "sp-btn sp-btn-primary")} busy={busy} busyLabel={t("submit.sending")} disabled={capturing && hasShot}>
            {primaryLabel}
          </Submit>
        </div>
      </div>
    </form>
  );

  let body;
  if (view === "sent" && snap.receipt) {
    body = <SentView receipt={snap.receipt} team={team} hasContact={identified || !!email.trim()} onDone={close} />;
  } else if (view === "recording-setup") {
    body = (
      <RecordingSetup
        onStart={async (mic) => {
          const session = await startRecording(mic);
          return session;
        }}
        onSkip={() => setView("describe")}
      />
    );
  } else if (view === "review") {
    body = (
      <ReviewList
        capture={capture}
        hasShot={hasShot}
        annotated={history.present.length > 0}
        element={!!element}
        recording={!!recording}
        include={include}
        onToggle={(kind, on) => setInclude((i) => ({ ...i, [kind]: on }))}
        busy={busy}
        error={submitError}
        onSend={() => void (similarOn && similar === null ? onSend() : submit())}
      />
    );
  } else if (view === "similar" && similar) {
    body = <SimilarList items={similar} busy={busy} onContinue={() => void submit()} onDone={close} />;
  } else {
    body = split ? (
      <div className="sp-body">
        <Stage
          image={image}
          failed={shotFailed}
          annotate={annotateOn}
          history={history}
          onHistory={setHistory}
          tool={tool}
          onTool={setTool}
          color={color}
          onColor={setColor}
          onAnnounce={setAnnounce}
          footer={
            <div className="sp-actions sp-mobile-only">
              <div className="sp-actions-row">
                <button type="button" className="sp-btn sp-btn-primary" onClick={() => setStep("describe")}>
                  {t("annotate.continue")}
                </button>
              </div>
            </div>
          }
        />
        {describe}
      </div>
    ) : (
      describe
    );
  }

  const header = (
    <header {...part("header", "sp-header")} data-back={back ? "" : undefined}>
      {back ? (
        <button type="button" className="sp-icon-btn" aria-label={t("panel.back")} onClick={back}>
          <BackIcon />
        </button>
      ) : null}
      <h2 id="sp-title" {...part("title", "sp-title")}>
        {title}
      </h2>
      {team ? <span className="sp-badge">{t("team.badge")}</span> : null}
      <button type="button" {...part("close", "sp-icon-btn")} aria-label={t("panel.close")} onClick={close}>
        <CloseIcon />
      </button>
    </header>
  );

  const footer =
    poweredBy || (teamSignIn && !team) ? (
      <footer {...part("footer", "sp-footer")}>
        <span className="sp-footer-start">
          {poweredBy && (view !== "describe" || !split || true) ? (
            <a {...part("poweredBy")} href={`https://trusplex.com/spotter?ref=${encodeURIComponent(projectRef(config.project))}`} target="_blank" rel="noopener">
              {t("panel.poweredBy")}
            </a>
          ) : null}
        </span>
        {teamSignIn && !team && view !== "sent" ? (
          <button
            type="button"
            onClick={async () => {
              const m = await flow.connectTeam().catch(() => null);
              if (m) update({ reporter: m.type, reporterName: m.name });
            }}
          >
            {t("team.signIn")}
          </button>
        ) : null}
      </footer>
    ) : null;

  return (
    <>
      <div className="sp-backdrop" data-layout={layout} onClick={close} aria-hidden="true" hidden={overlay === "recording"} />
      <Dialog
        {...part("dialog", "sp-dialog")}
        onClose={close}
        labelledBy="sp-title"
        data-layout={layout}
        data-position={position}
        data-step={split ? step : undefined}
        data-view={view}
        hidden={overlay === "recording"}
      >
        {testMode ? (
          <div className="sp-ribbon" {...part("ribbon", "sp-ribbon")}>
            <strong>{t("panel.testMode")}</strong>
            <span aria-hidden="true">·</span>
            <span>{t("panel.testModeHint")}</span>
          </div>
        ) : null}
        {header}
        {body}
        {footer}
      </Dialog>
      {overlay === "recording" ? (
        <RecordingPill
          onStop={(result) => {
            setOverlay(null);
            if (result) {
              setRecording(result);
              setAnnounce(t("attach.recording", { duration: fmtDuration(Date.parse(result.endedAt) - Date.parse(result.startedAt)) }));
            }
            setView("describe");
          }}
        />
      ) : null}
      <LiveRegion message={announce} />
      <LiveRegion message={alert} assertive />
    </>
  );
}

// -- attachments --------------------------------------------------------------------------------

function AttachmentRows(props: {
  image: LoadedImage | null;
  showThumb: boolean;
  history: History;
  element: Element | null;
  recording: { blob: Blob; startedAt: string; endedAt: string } | null;
  canAddShot: boolean;
  canPick: boolean;
  canRecord: boolean;
  capturing: boolean;
  onAnnotate: () => void;
  onRemoveShot: () => void;
  onAddShot: () => void;
  onPick: () => void;
  onRecord: () => void;
  onRemoveRecording: () => void;
  onRemoveElement: () => void;
}) {
  const { t, part } = usePanel();
  const rows = [];
  if (props.image) {
    rows.push(
      <div key="shot" {...part("attachment", "sp-attach")} data-mobile={!props.showThumb ? "" : undefined} className={props.showThumb ? "sp-attach" : "sp-attach sp-mobile-only"}>
        <button type="button" className="sp-thumb" onClick={props.onAnnotate} aria-label={t("attach.annotate")}>
          <Thumb image={props.image} history={props.history} />
        </button>
        <div className="sp-attach-text">
          <span className="sp-attach-title">{t("attach.screenshot")}</span>
          <span className="sp-attach-meta">
            <button type="button" className="sp-link" onClick={props.onAnnotate}>
              {t("attach.annotate")}
            </button>
          </span>
        </div>
        <button type="button" className="sp-icon-btn" aria-label={t("attach.remove", { item: t("attach.screenshot") })} onClick={props.onRemoveShot}>
          <TrashIcon />
        </button>
      </div>,
    );
  }
  if (props.capturing) {
    rows.push(
      <div key="cap" className="sp-attach" aria-busy="true">
        <span className="sp-thumb" style={{ display: "grid", placeItems: "center" }}>
          <span className="sp-spinner" aria-hidden="true" />
        </span>
        <span className="sp-attach-title">{t("capture.capturing")}</span>
      </div>,
    );
  }
  if (props.element) {
    const label = describeElement(props.element);
    rows.push(
      <div key="el" className="sp-attach">
        <span className="sp-list-icon">
          <CursorIcon />
        </span>
        <div className="sp-attach-text">
          <span className="sp-attach-title">{t("attach.element", { selector: label })}</span>
        </div>
        <button type="button" className="sp-icon-btn" aria-label={t("attach.remove", { item: label })} onClick={props.onRemoveElement}>
          <TrashIcon />
        </button>
      </div>,
    );
  }
  if (props.recording) {
    const ms = Date.parse(props.recording.endedAt) - Date.parse(props.recording.startedAt);
    const s = Math.round(ms / 1000);
    const label = t("attach.recording", { duration: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` });
    rows.push(
      <div key="rec" className="sp-attach">
        <span className="sp-list-icon">
          <RecordIcon />
        </span>
        <div className="sp-attach-text">
          <span className="sp-attach-title">{label}</span>
        </div>
        <button type="button" className="sp-icon-btn" aria-label={t("attach.remove", { item: label })} onClick={props.onRemoveRecording}>
          <TrashIcon />
        </button>
      </div>,
    );
  }
  const tools = [];
  if (props.canAddShot)
    tools.push(
      <button key="add" type="button" className="sp-btn sp-btn-secondary sp-btn-sm" onClick={props.onAddShot}>
        <CameraIcon />
        {t("attach.addScreenshot")}
      </button>,
    );
  if (props.canPick && !props.element)
    tools.push(
      <button key="pick" type="button" className="sp-btn sp-btn-secondary sp-btn-sm" onClick={props.onPick}>
        <CursorIcon />
        {t("attach.pickElement")}
      </button>,
    );
  if (props.canRecord)
    tools.push(
      <button key="rec" type="button" className="sp-btn sp-btn-secondary sp-btn-sm" onClick={props.onRecord}>
        <RecordIcon />
        {t("attach.record")}
      </button>,
    );
  if (rows.length === 0 && tools.length === 0) return null;
  return (
    <div className="sp-field">
      {rows}
      {tools.length ? <div className="sp-attach-tools">{tools}</div> : null}
    </div>
  );
}

/** Thumbnail of the screenshot with the current annotations (blur included). */
function Thumb({ image, history }: { image: LoadedImage; history: History }) {
  const [flat, setFlat] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = document.createElement("canvas");
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const renderer = history.present.length > 0 ? loadRenderer() : null;
    if (!renderer) return setFlat(null);
    void renderer.then((m) => {
      m.renderAnnotated(ctx, image.source, history.present, image, false);
      setFlat(c);
    });
  }, [image, history]);
  return <Screenshot image={flat ?? image} alt="" maxWidth={76} />;
}

export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = Array.from(el.classList).slice(0, 2).join(".");
  const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  return cls ? `${tag}.${cls}` : text ? `${tag} “${text}”` : tag;
}
