// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomFieldDeclaration } from "../../src/core/schema.ts";
import { Panel } from "../../src/ui/next/primitives/dialog.tsx";
import { Field } from "../../src/ui/next/primitives/field.tsx";
import { Submit } from "../../src/ui/next/primitives/misc.tsx";
import { resetStore, getSnapshot } from "../../src/ui/next/internal/store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function render(ui: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetStore();
});

const flush = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(null)))));
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));

describe("Panel (dialog primitive)", () => {
  function Harness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button id="opener" onClick={() => setOpen(true)}>
          open
        </button>
        <Panel
          open={open}
          labelledBy="t"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <h2 id="t">Title</h2>
          <button id="first">first</button>
          <textarea id="auto" data-autofocus="" />
          <button id="last">last</button>
        </Panel>
      </>
    );
  }

  it("is a labelled modal dialog that focuses [data-autofocus], traps Tab, closes on Escape and restores focus", async () => {
    const onClose = vi.fn();
    const el = render(<Harness onClose={onClose} />);
    const opener = el.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus();
    act(() => opener.click());
    await flush();
    const dialog = el.querySelector("[role=dialog]")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("t");
    expect(document.activeElement?.id).toBe("auto");

    el.querySelector<HTMLButtonElement>("#last")!.focus();
    key(dialog, "Tab");
    expect(document.activeElement?.id).toBe("first");
    key(dialog, "Tab", { shiftKey: true });
    expect(document.activeElement?.id).toBe("last");

    key(dialog, "Escape");
    expect(onClose).toHaveBeenCalledOnce();
    expect(el.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("Field primitive", () => {
  it("wires label, required and error for assistive tech", () => {
    const field: CustomFieldDeclaration = { id: "order", label: "Order number", type: "text", required: true };
    const el = render(<Field field={field} value="12" onChange={() => {}} issue={{ code: "pattern", message: "Use ORD-1234" }} />);
    const input = el.querySelector("input")!;
    const label = el.querySelector("label")!;
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    const err = el.querySelector(`#${CSS.escape(input.getAttribute("aria-describedby")!)}`)!;
    expect(err.textContent).toBe("Use ORD-1234");
    expect(el.textContent).not.toContain("Optional");
  });

  it("renders every field type", () => {
    const types = ["text", "textarea", "select", "multiselect", "checkbox", "rating", "file"] as const;
    for (const type of types) {
      const onChange = vi.fn();
      const el = render(
        <Field
          field={{ id: `f-${type}`, label: `L ${type}`, type, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], validation: { max: 3 } }}
          value={undefined}
          onChange={onChange}
        />,
      );
      expect(el.textContent).toContain(`L ${type}`);
      if (type === "multiselect") {
        act(() => el.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
        expect(onChange).toHaveBeenCalledWith(["b"]);
      }
      if (type === "rating") {
        const stars = el.querySelectorAll<HTMLButtonElement>("[role=radio]");
        expect(stars.length).toBe(3);
        act(() => stars[1]!.click());
        expect(onChange).toHaveBeenCalledWith(2);
      }
      act(() => root!.unmount());
      host!.remove();
      root = null;
    }
  });
});

describe("Submit primitive", () => {
  it("stays focusable but inert while busy", () => {
    const onClick = vi.fn();
    const el = render(
      <Submit type="button" busy busyLabel="Sending…" onClick={onClick}>
        Send
      </Submit>,
    );
    const b = el.querySelector("button")!;
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-busy")).toBe("true");
    act(() => b.click());
    expect(onClick).not.toHaveBeenCalled();
    expect(b.textContent).toContain("Sending…");
  });
});

describe("SpotterTrigger asChild", () => {
  it("merges handlers into the child, keeps its own, and opens the widget without navigating", async () => {
    // A provider-less render is fine: the trigger only needs the controller.
    const { SpotterTrigger } = await import("../../src/ui/next/triggers.tsx");
    const theirs = vi.fn();
    const el = render(
      <SpotterTrigger asChild mode="text">
        <a href="#report" onClick={theirs}>
          Report a problem
        </a>
      </SpotterTrigger>,
    );
    const a = el.querySelector("a")!;
    expect(a.getAttribute("aria-haspopup")).toBe("dialog");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => void a.dispatchEvent(ev));
    expect(theirs).toHaveBeenCalledOnce();
    expect(ev.defaultPrevented).toBe(true);
    expect(getSnapshot()).toMatchObject({ open: true, mode: "text" });
  });
});
