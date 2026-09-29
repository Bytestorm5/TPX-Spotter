# @trusplex/ui

The Trusplex component kit: the Spotter widget's design system, for any app.
It includes contrast-checked theme tokens, one stylesheet, and accessible
React components that render on the server.

```sh
npm install @trusplex/ui
```

```tsx
// app/layout.tsx
import "@trusplex/ui/styles.css";
import { Button, Card, CardHeader, Field, Input } from "@trusplex/ui";

<body className="tui tui-canvas">
  <Card>
    <CardHeader title="Invite someone" />
    <Field label="Email" hint="They get a sign-in link.">
      <Input type="email" />
    </Field>
    <Button>Send invite</Button>
  </Card>
</body>;
```

## Theming

Every token is a CSS custom property, `--tui-*`. The defaults are neutral:
zinc greys and a near-black primary that suit any brand, in light and dark.
They ship at zero specificity, so any value you set wins.

**In CSS**, point the tokens at your own design system:

```css
:root {
  --tui-primary: var(--brand);
  --tui-font: var(--font-body);
  --tui-radius-button: 999px;
}
```

**Or generate a theme.** A primary colour gets readable text, a hover
shade, a soft tint and, when it stands out enough, the focus ring:

```ts
import { createTheme, themeCss } from "@trusplex/ui/theme";

const css = themeCss(createTheme({ primary: "#8B4447", preset: "rounded", light: { canvas: "#F9F3ED" } }));
// → :root { … } plus the dark scheme under prefers-color-scheme and [data-theme="dark"]
```

`data-theme="dark"` or `data-theme="light"` on the root, or on any element,
switches that subtree's scheme. The presets are `default`, `minimal`,
`rounded` and `sharp`. `dark: false` gives you a light-only theme.

**Add your own variants.** Variants and tones are data attributes over
local variables, so a new one is a single rule:

```css
.tui-badge[data-tone="taupe"] {
  --_bg: #f3ece6;
  --_fg: #6b5446;
}
```

```tsx
<Badge tone="taupe">Draft</Badge>
```

## Components

|                                                                   |                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `IconButton`, `Spinner`                                 | Variants `primary` · `secondary` · `soft` · `ghost` · `danger` · `danger-solid`, sizes `sm` · `md` · `lg`, `busy`, `block`. `asChild` renders a router `<Link>` with the button's look.                  |
| `Field`                                                           | Label, hint, error and required marker, wired to the control inside it (`id`, `aria-describedby`, `aria-invalid`).                                                                                       |
| `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`                | Form controls. `Input` takes a leading `icon`.                                                                                                                                                           |
| `Chip`, `ChipGroup`                                               | Pill toggles. `ChipGroup` handles single choice (a radio group) or multiple choice, with arrow-key navigation.                                                                                           |
| `Badge`                                                           | Tones `neutral` · `accent` · `success` · `warning` · `danger` · `info` · `solid`, or your own. Optional `dot`.                                                                                           |
| `Card`, `CardHeader`, `CardFooter`                                | Variants `default` · `soft` · `flat`, `padding`, `interactive`.                                                                                                                                          |
| `Dialog`                                                          | A modal in a portal. It takes focus and gives it back, traps Tab, closes on Escape or a backdrop press (only the topmost of stacked dialogs reacts), locks scroll, and becomes a bottom sheet on phones. |
| `Notice`, `List`, `ListItem`, `Details`, `KeyValue`, `EmptyState` | Messages, rows, disclosures, facts, empty screens.                                                                                                                                                       |
| `Tabs`, `Tab`                                                     | Underline tabs. `Tab asChild active` for router links (`aria-current="page"`).                                                                                                                           |
| `Avatar`, `Stat`, `Skeleton`, `Table`, `TH`, `TD`                 |                                                                                                                                                                                                          |

Every component forwards its HTML attributes and `className`. The class
names (`tui-btn`, `tui-input`, …) are public too. Plain HTML styled with
them looks the same.

## Gallery

`pnpm --filter @trusplex/ui gallery` builds `gallery/dist/index.html`,
which shows every component in the default light and dark themes and in a
branded theme.
