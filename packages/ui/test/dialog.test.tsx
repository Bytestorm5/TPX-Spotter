// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ChipGroup, Dialog } from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Edit staff"
        subtitle="Changes apply at once."
        footer={<Button id="save">Save</Button>}
      >
        <input id="name" />
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("is a labelled modal in a portal that takes focus, locks scroll, and gives focus back", async () => {
    mount(<Harness />);
    const opener = document.getElementById("opener")!;
    opener.focus();
    await act(async () => {
      opener.click();
      await frame();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(dialog.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Edit staff");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toBe(
      "Changes apply at once.",
    );
    expect(document.activeElement?.id).toBe("name");
    expect(document.body.style.overflow).toBe("hidden");

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a backdrop press but not on a press inside, and only the topmost of stacked dialogs reacts", async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    mount(
      <>
        <Dialog open onClose={outer} title="Outer">
          <p id="inside">x</p>
        </Dialog>
        <Dialog open onClose={inner} title="Inner">
          y
        </Dialog>
      </>,
    );
    await act(frame);
    const overlays = document.querySelectorAll<HTMLElement>(".tui-overlay");
    await act(async () => {
      document.getElementById("inside")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      overlays[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(outer).not.toHaveBeenCalled();
    await act(async () => {
      overlays[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      overlays[1]!
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(inner).toHaveBeenCalledTimes(2);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("ChipGroup", () => {
  it("single-select is a radio group that toggles and deselects", async () => {
    const onChange = vi.fn();
    const { host } = mount(
      <ChipGroup
        label="Category"
        value="bug"
        onChange={onChange}
        options={[
          { value: "bug", label: "Bug" },
          { value: "idea", label: "Idea" },
        ]}
      />,
    );
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Category");
    const [bug, idea] = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    expect(bug!.getAttribute("aria-checked")).toBe("true");
    expect(bug!.tabIndex).toBe(0);
    expect(idea!.tabIndex).toBe(-1);
    await act(async () => idea!.click());
    expect(onChange).toHaveBeenLastCalledWith("idea");
    await act(async () => bug!.click());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("multi-select toggles membership", async () => {
    const onChange = vi.fn();
    const { host } = mount(
      <ChipGroup
        multiple
        label="Tags"
        value={["a"]}
        onChange={onChange}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    const chips = host.querySelectorAll<HTMLButtonElement>("button");
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => chips[1]!.click());
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);
    await act(async () => chips[0]!.click());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

describe("Dialog container", () => {
  it("portals into the given element (a themed subtree)", async () => {
    const themed = document.createElement("div");
    themed.className = "brand";
    document.body.append(themed);
    mount(
      <Dialog open onClose={() => {}} title="Scoped" container={themed}>
        x
      </Dialog>,
    );
    await act(frame);
    expect(themed.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
