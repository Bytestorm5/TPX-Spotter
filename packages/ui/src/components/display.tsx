/**
 * Display components: `Badge`, `Card` (+ `CardHeader`, `CardFooter`),
 * `Notice`, `List`/`ListItem`, `Details`, `KeyValue`, `Avatar`,
 * `Skeleton`, `Stat`, `EmptyState` and the `Table` parts. No state, so
 * they render on the server as they are.
 *
 * `tone` props take the kit's tones or any string: an app styles its own
 * with one rule, e.g. `.tui-badge[data-tone="taupe"] { --_bg: …; --_fg: … }`.
 */
import type {
  CSSProperties,
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn, flag } from "../cn.ts";
import { AlertIcon, ChevronRightIcon, InfoIcon, SuccessIcon } from "./icons.tsx";
import { Slot } from "./slot.tsx";

// Kit tones, plus any string an app styles itself.
// eslint-disable-next-line @typescript-eslint/ban-types
type Open<T extends string> = T | (string & {});

export type Tone = Open<"neutral" | "accent" | "success" | "warning" | "danger" | "info" | "solid">;

// -- Badge -------------------------------------------------------------------------------------

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** A leading status dot in the badge's colour. */
  dot?: boolean;
  size?: "sm" | "md";
}

export function Badge({ tone = "neutral", dot, size = "sm", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn("tui-badge", className)}
      data-tone={tone === "neutral" ? undefined : tone}
      data-dot={flag(dot)}
      data-size={size === "sm" ? undefined : size}
      {...rest}
    />
  );
}

// -- Card --------------------------------------------------------------------------------------

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: Open<"default" | "soft" | "flat">;
  padding?: "none" | "sm" | "md" | "lg";
  /** Hover lift, for a card that is itself a link or button. */
  interactive?: boolean;
  asChild?: boolean;
}

export function Card({
  variant = "default",
  padding = "md",
  interactive,
  asChild,
  className,
  children,
  ...rest
}: CardProps) {
  const props = {
    className: cn("tui-card", className),
    "data-variant": variant === "default" ? undefined : variant,
    "data-padding": padding === "md" ? undefined : padding,
    "data-interactive": flag(interactive),
    ...rest,
  };
  if (asChild) return <Slot {...props}>{children}</Slot>;
  return <div {...props}>{children}</div>;
}

export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Heading level for the title. Default 3. */
  level?: 2 | 3 | 4;
}

export function CardHeader({ title, description, actions, level = 3, className, ...rest }: CardHeaderProps) {
  const H = `h${level}` as "h3";
  return (
    <div className={cn("tui-card-header", className)} {...rest}>
      <div className="tui-card-heading">
        <H className="tui-card-title">{title}</H>
        {description ? <p className="tui-card-description">{description}</p> : null}
      </div>
      {actions ? <div className="tui-card-actions">{actions}</div> : null}
    </div>
  );
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("tui-card-footer", className)} {...rest} />;
}

// -- Notice ------------------------------------------------------------------------------------

export interface NoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: Open<"neutral" | "info" | "success" | "warning" | "danger">;
  title?: ReactNode;
  /** Replace the tone's icon; `null` for none. */
  icon?: ReactNode | null;
}

export function Notice({ tone = "neutral", title, icon, className, children, role, ...rest }: NoticeProps) {
  const glyph =
    icon !== undefined ? (
      icon
    ) : tone === "success" ? (
      <SuccessIcon />
    ) : tone === "danger" || tone === "warning" ? (
      <AlertIcon />
    ) : (
      <InfoIcon />
    );
  return (
    <div
      className={cn("tui-notice", className)}
      data-tone={tone === "neutral" ? undefined : tone}
      role={role ?? (tone === "danger" ? "alert" : "status")}
      {...rest}
    >
      {glyph}
      <div className="tui-notice-body">
        {title ? <p className="tui-notice-title">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}

// -- List --------------------------------------------------------------------------------------

export function List({ className, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn("tui-list", className)} {...rest} />;
}

export interface ListItemProps extends Omit<HTMLAttributes<HTMLLIElement>, "title"> {
  icon?: ReactNode;
  title?: ReactNode;
  meta?: ReactNode;
  /** Trailing content: a badge, a button. */
  end?: ReactNode;
  interactive?: boolean;
}

export function ListItem({ icon, title, meta, end, interactive, className, children, ...rest }: ListItemProps) {
  return (
    <li className={cn("tui-list-item", className)} data-interactive={flag(interactive)} {...rest}>
      {icon ? <span className="tui-list-icon">{icon}</span> : null}
      {title !== undefined || meta !== undefined ? (
        <span className="tui-list-text">
          {title !== undefined ? <span className="tui-list-title">{title}</span> : null}
          {meta !== undefined ? <span className="tui-list-meta">{meta}</span> : null}
        </span>
      ) : null}
      {children}
      {end}
    </li>
  );
}

// -- Details -----------------------------------------------------------------------------------

export interface DetailsProps extends Omit<HTMLAttributes<HTMLDetailsElement>, "title"> {
  summary: ReactNode;
  defaultOpen?: boolean;
}

export function Details({ summary, defaultOpen, className, children, ...rest }: DetailsProps) {
  return (
    <details className={cn("tui-details", className)} open={defaultOpen} {...rest}>
      <summary>
        <ChevronRightIcon />
        {summary}
      </summary>
      <div className="tui-details-body">{children}</div>
    </details>
  );
}

// -- KeyValue ----------------------------------------------------------------------------------

export interface KeyValueProps extends HTMLAttributes<HTMLDListElement> {
  items: [ReactNode, ReactNode][];
  /** Monospace values (ids, versions, hashes). */
  mono?: boolean;
}

export function KeyValue({ items, mono, className, ...rest }: KeyValueProps) {
  return (
    <dl className={cn("tui-kv", className)} data-mono={flag(mono)} {...rest}>
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// -- Avatar ------------------------------------------------------------------------------------

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  src?: string;
  size?: "sm" | "md" | "lg";
  tone?: Open<"accent" | "neutral">;
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => Array.from(p)[0]?.toUpperCase() ?? "")
    .join("");
}

/** Decorative by default (the name is usually beside it); pass `aria-label` to make it speak. */
export function Avatar({ name, src, size = "md", tone = "accent", className, ...rest }: AvatarProps) {
  return (
    <span
      className={cn("tui-avatar", className)}
      data-size={size === "md" ? undefined : size}
      data-tone={tone === "accent" ? undefined : tone}
      aria-hidden={rest["aria-label"] ? undefined : true}
      {...rest}
    >
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

// -- Skeleton ----------------------------------------------------------------------------------

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  radius?: CSSProperties["borderRadius"];
  circle?: boolean;
}

export function Skeleton({ width, height, radius, circle, className, style, ...rest }: SkeletonProps) {
  return (
    <span
      className={cn("tui-skeleton", className)}
      style={{ width, height, borderRadius: circle ? "50%" : radius, ...style }}
      aria-hidden="true"
      {...rest}
    />
  );
}

// -- Stat --------------------------------------------------------------------------------------

export interface StatProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode;
  value: ReactNode;
  label: ReactNode;
  tone?: Open<"accent" | "success" | "neutral">;
  delta?: ReactNode;
  deltaDown?: boolean;
}

export function Stat({ icon, value, label, tone = "accent", delta, deltaDown, className, ...rest }: StatProps) {
  return (
    <div className={cn("tui-stat", className)} {...rest}>
      {icon ? (
        <span className="tui-stat-icon" data-tone={tone === "accent" ? undefined : tone}>
          {icon}
        </span>
      ) : null}
      <span className="tui-stat-text">
        <span className="tui-stat-value">
          {value}
          {delta ? (
            <span className="tui-stat-delta" data-down={flag(deltaDown)}>
              {delta}
            </span>
          ) : null}
        </span>
        <span className="tui-stat-label">{label}</span>
      </span>
    </div>
  );
}

// -- EmptyState --------------------------------------------------------------------------------

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ icon, title, description, actions, className, ...rest }: EmptyStateProps) {
  return (
    <div className={cn("tui-empty", className)} {...rest}>
      {icon ? <span className="tui-empty-icon">{icon}</span> : null}
      <p className="tui-empty-title">{title}</p>
      {description ? <p className="tui-empty-description">{description}</p> : null}
      {actions ? <div className="tui-empty-actions">{actions}</div> : null}
    </div>
  );
}

// -- Table -------------------------------------------------------------------------------------

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Class for the scrolling wrapper. */
  wrapperClassName?: string;
}

export function Table({ className, wrapperClassName, ...rest }: TableProps) {
  return (
    <div className={cn("tui-table-wrap", wrapperClassName)}>
      <table className={cn("tui-table", className)} {...rest} />
    </div>
  );
}

export function TH({ numeric, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th scope="col" data-numeric={flag(numeric)} {...rest} />;
}

export function TD({ numeric, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td data-numeric={flag(numeric)} {...rest} />;
}

// -- Tabs --------------------------------------------------------------------------------------

export function Tabs({ className, "aria-label": label, ...rest }: HTMLAttributes<HTMLElement>) {
  return <nav className={cn("tui-tabs", className)} aria-label={label ?? "Tabs"} {...rest} />;
}

export interface TabProps extends HTMLAttributes<HTMLElement> {
  active?: boolean;
  /** Render the child (a router link) as the tab. Without it, a `<button>`. */
  asChild?: boolean;
}

/** One tab. `active` marks the current page (`aria-current="page"`). */
export function Tab({ active, asChild, className, children, ...rest }: TabProps) {
  const props = {
    className: cn("tui-tab", className),
    "aria-current": active ? ("page" as const) : undefined,
    ...rest,
  };
  if (asChild) return <Slot {...props}>{children}</Slot>;
  return (
    <button type="button" {...props}>
      {children}
    </button>
  );
}
