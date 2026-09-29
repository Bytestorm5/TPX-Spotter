import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Chip,
  Field,
  IconButton,
  Input,
  KeyValue,
  Notice,
  Select,
  Stat,
  Tab,
  TD,
  Textarea,
  initials,
} from "../src/index.ts";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("components render on the server", () => {
  it("Button: variants and sizes are data attributes, the default is a type=button", () => {
    expect(html(<Button>Save</Button>)).toBe('<button type="button" class="tui-btn">Save</button>');
    const out = html(
      <Button variant="secondary" size="sm" block className="x">
        Go
      </Button>,
    );
    expect(out).toContain('class="tui-btn x"');
    expect(out).toContain('data-variant="secondary"');
    expect(out).toContain('data-size="sm"');
    expect(out).toContain('data-block=""');
  });

  it("Button busy: a spinner, aria-busy, and it stays focusable (not disabled)", () => {
    const out = html(<Button busy>Sending</Button>);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("tui-spinner");
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toMatch(/\sdisabled=""/);
  });

  it("asChild renders the child with the kit's look, merging classes", () => {
    const out = html(
      <Button asChild variant="ghost">
        <a href="/x" className="mine">
          Link
        </a>
      </Button>,
    );
    expect(out).toMatch(/^<a [^>]*>Link<\/a>$/);
    expect(out).toContain('class="tui-btn mine"');
    expect(out).toContain('data-variant="ghost"');
    expect(out).toContain('href="/x"');
    const tab = html(
      <Tab asChild active>
        {<a href="/a">A</a>}
      </Tab>,
    );
    expect(tab).toMatch(/^<a [^>]*class="tui-tab"[^>]*>A<\/a>$/);
    expect(tab).toContain('aria-current="page"');
    expect(html(<Chip asChild>{<a href="/f">F</a>}</Chip>)).toContain('class="tui-chip"');
  });

  it("IconButton requires and uses its label as the accessible name", () => {
    expect(html(<IconButton label="Close">×</IconButton>)).toContain('aria-label="Close"');
  });

  it("Field wires the label, hint and error to its control", () => {
    const out = html(
      <Field label="Email" hint="We reply here." error="Required" required>
        <Input />
      </Field>,
    );
    const id = /<label class="tui-label" for="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`id="${id}"`);
    expect(out).toContain(`aria-describedby="${id}-hint ${id}-error"`);
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('required=""');
    expect(out).toContain('role="alert"');
  });

  it("controls outside a Field keep their own props", () => {
    expect(html(<Textarea id="t" />)).toBe('<textarea class="tui-textarea" id="t"></textarea>');
    expect(
      html(
        <Select aria-label="S">
          <option>a</option>
        </Select>,
      ),
    ).toContain("tui-select-wrap");
    expect(html(<Checkbox label="Remember" />)).toContain('<input type="checkbox"/>');
  });

  it("tones are open: kit tones and app-defined ones are just data attributes", () => {
    expect(html(<Badge>New</Badge>)).toBe('<span class="tui-badge">New</span>');
    expect(
      html(
        <Badge tone="taupe" dot>
          Draft
        </Badge>,
      ),
    ).toBe('<span class="tui-badge" data-tone="taupe" data-dot="">Draft</span>');
    expect(html(<Notice tone="danger">Nope</Notice>)).toContain('role="alert"');
    expect(html(<Stat value="12" label="Open" tone="rose" icon={<i />} />)).toContain('data-tone="rose"');
  });

  it("Card and CardHeader", () => {
    const out = html(
      <Card padding="lg">
        <CardHeader title="Roster" description="Everyone" actions={<Button>Add</Button>} level={2} />
      </Card>,
    );
    expect(out).toContain('data-padding="lg"');
    expect(out).toContain('<h2 class="tui-card-title">Roster</h2>');
  });

  it("Avatar initials and KeyValue", () => {
    expect(initials("ada  lovelace byron")).toBe("AL");
    expect(initials("Élodie")).toBe("É");
    expect(html(<Avatar name="Ada Lovelace" />)).toContain(">AL<");
    expect(html(<KeyValue items={[["SDK", "0.1.0"]]} mono />)).toContain("<dt>SDK</dt><dd>0.1.0</dd>");
    expect(
      html(
        <table>
          <tbody>
            <tr>
              <TD numeric>3</TD>
            </tr>
          </tbody>
        </table>,
      ),
    ).toContain('data-numeric=""');
  });
});
