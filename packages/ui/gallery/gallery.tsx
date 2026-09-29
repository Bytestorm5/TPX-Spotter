/**
 * The kit's gallery: every component, in the default theme (light and
 * dark) and a branded one, on one page. `pnpm gallery` builds it to
 * gallery/dist/index.html; open that file to look, or screenshot it.
 */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Checkbox,
  Chip,
  ChipGroup,
  Details,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
  Notice,
  Radio,
  Select,
  Skeleton,
  Stat,
  Tab,
  Table,
  Tabs,
  TD,
  TH,
  Textarea,
  createTheme,
  themeCss,
  CloseIcon,
  InfoIcon,
  CheckIcon,
} from "../src/index.ts";

const brand = createTheme({
  preset: "rounded",
  primary: "#8B4447",
  light: {
    canvas: "#F9F3ED",
    border: "#E6D9CB",
    borderStrong: "#D4C3B2",
    primarySoft: "#EFC7B7",
    primarySoftText: "#5F2E31",
  },
  dark: false,
  type: { font: "Georgia, serif" },
});
const style = document.createElement("style");
style.textContent = themeCss(brand, { selector: ".brand" });
document.head.append(style);

const Search = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </svg>
);

function Showcase({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const here = useRef<HTMLElement>(null);
  const [category, setCategory] = useState<string | null>("bug");
  const [tags, setTags] = useState<string[]>(["web"]);
  return (
    <section ref={here} style={{ display: "grid", gap: 20 }}>
      <h2 className="tui-subhead">{name}</h2>
      <Card>
        <CardHeader title="Buttons" description="Variants and sizes." />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="soft">Soft</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="danger-solid">Delete</Button>
          <Button size="sm" iconStart={<CheckIcon />}>
            Small
          </Button>
          <Button size="lg">Large</Button>
          <Button busy>Saving</Button>
          <Button disabled>Disabled</Button>
          <IconButton label="Close">
            <CloseIcon />
          </IconButton>
          <Button asChild variant="secondary">
            <a href="#x">Link as button</a>
          </Button>
        </div>
      </Card>
      <Card>
        <CardHeader title="Form" description="Fields wire labels, hints and errors." />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          <Field label="Name" hint="As it appears on the roster.">
            <Input placeholder="Ada Lovelace" />
          </Field>
          <Field label="Email" error="Enter a valid email." required>
            <Input defaultValue="ada@" />
          </Field>
          <Field label="Search" hideLabel>
            <Input icon={<Search />} placeholder="Search staff…" />
          </Field>
          <Field label="Role" optional>
            <Select defaultValue="t">
              <option value="t">Teacher</option>
              <option value="a">Administrator</option>
            </Select>
          </Field>
          <Field label="Notes" style={{ gridColumn: "1 / -1" }}>
            <Textarea placeholder="Anything the team should know" />
          </Field>
          <div style={{ display: "grid", gap: 8 }}>
            <Checkbox label="Send a welcome email" defaultChecked />
            <Checkbox label="Grant access now" description="They can sign in straight away." />
            <Radio name={`r-${name}`} label="Monthly" defaultChecked />
            <Radio name={`r-${name}`} label="Yearly" />
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            <ChipGroup
              label="Category"
              value={category}
              onChange={setCategory}
              options={[
                { value: "bug", label: "Bug" },
                { value: "idea", label: "Idea" },
                { value: "question", label: "Question" },
              ]}
            />
            <ChipGroup
              multiple
              label="Tags"
              value={tags}
              onChange={setTags}
              options={[
                { value: "web", label: "Web" },
                { value: "ios", label: "iOS" },
                { value: "android", label: "Android" },
              ]}
            />
            <div className="tui-chips">
              <Chip pressed>Pressed</Chip>
              <Chip>Plain</Chip>
            </div>
          </div>
        </div>
        <CardFooter>
          <Button variant="ghost">Cancel</Button>
          <Button onClick={() => setOpen(true)}>Open dialog</Button>
        </CardFooter>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
        <Card>
          <CardHeader title="Badges & avatars" />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            <Badge>Neutral</Badge>
            <Badge tone="accent">Accent</Badge>
            <Badge tone="success" dot>
              Resolved
            </Badge>
            <Badge tone="warning" dot>
              Needs info
            </Badge>
            <Badge tone="danger">Failed</Badge>
            <Badge tone="info">Info</Badge>
            <Badge tone="solid">Solid</Badge>
            <Badge size="md" tone="accent">
              Medium
            </Badge>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Avatar name="Ada Lovelace" size="sm" />
            <Avatar name="Grace Hopper" />
            <Avatar name="Alan Turing" size="lg" tone="neutral" />
          </div>
        </Card>
        <Card>
          <CardHeader title="Stats" />
          <div style={{ display: "grid", gap: 14 }}>
            <Stat icon={<InfoIcon />} value="128" label="Open reports" delta="+12%" />
            <Stat icon={<CheckIcon />} value="96%" label="Resolved in a week" tone="success" delta="-2%" deltaDown />
          </div>
        </Card>
        <Card variant="soft">
          <CardHeader title="Soft card" description="For secondary panels." />
          <div style={{ display: "grid", gap: 8 }}>
            <Skeleton height={12} width="70%" />
            <Skeleton height={12} />
            <Skeleton height={32} width={32} circle />
          </div>
        </Card>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
        <div style={{ display: "grid", gap: 10 }}>
          <Notice>Reports are kept for 90 days.</Notice>
          <Notice tone="info" title="Heads up">
            A new version is available.
          </Notice>
          <Notice tone="success">Saved.</Notice>
          <Notice tone="warning">Your key expires tomorrow.</Notice>
          <Notice tone="danger">The upload failed.</Notice>
        </div>
        <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
          <List>
            <ListItem
              icon={<InfoIcon />}
              title="Pay button does nothing"
              meta="SPT-12 · 2 hours ago"
              end={<Badge tone="warning">In progress</Badge>}
              interactive
            />
            <ListItem
              icon={<CheckIcon />}
              title="Typo on pricing page"
              meta="SPT-9 · yesterday"
              end={<Badge tone="success">Resolved</Badge>}
            />
          </List>
          <Details summary="Technical details">
            <KeyValue
              mono
              items={[
                ["Browser", "Chrome 128"],
                ["SDK", "0.1.0"],
                ["Session", "ses_01J9Z…"],
              ]}
            />
          </Details>
        </div>
      </div>
      <Card padding="none">
        <Tabs aria-label="Sections" style={{ padding: "0 12px" }}>
          <Tab active>Staff</Tab>
          <Tab>Roles</Tab>
          <Tab>Groups</Tab>
        </Tabs>
        <Table>
          <thead>
            <tr>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH numeric>Courses</TH>
            </tr>
          </thead>
          <tbody>
            <tr>
              <TD>Ada Lovelace</TD>
              <TD>
                <Badge tone="accent">Teacher</Badge>
              </TD>
              <TD numeric>4</TD>
            </tr>
            <tr>
              <TD>Grace Hopper</TD>
              <TD>
                <Badge>Admin</Badge>
              </TD>
              <TD numeric>12</TD>
            </tr>
          </tbody>
        </Table>
      </Card>
      <Card>
        <EmptyState
          icon={<InfoIcon />}
          title="No reports yet"
          description="Reports filed from your site show up here."
          actions={<Button variant="secondary">Install the widget</Button>}
        />
      </Card>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        container={here.current}
        title="Revoke access"
        subtitle="Ada will be signed out everywhere."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger-solid">Revoke</Button>
          </>
        }
      >
        <Field label="Reason" hint="Kept in the audit log.">
          <Textarea />
        </Field>
      </Dialog>
    </section>
  );
}

function Gallery() {
  return (
    <div style={{ display: "grid", gap: 0 }}>
      <div className="tui tui-canvas" data-theme="light" style={{ padding: 32 }}>
        <Showcase name="Default · light" />
      </div>
      <div className="tui tui-canvas" data-theme="dark" style={{ padding: 32 }}>
        <Showcase name="Default · dark" />
      </div>
      <div className="tui tui-canvas brand" style={{ padding: 32 }}>
        <Showcase name="Branded (createTheme)" />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Gallery />);
