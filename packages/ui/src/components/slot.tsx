/**
 * `asChild` support: render the single child element instead of the kit's
 * own tag, merging the kit's props onto it — a router `<Link>` styled as a
 * button, a tab or a chip. Class names are joined, handlers chained (the
 * child's first), everything else the child sets wins.
 */
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cn } from "../cn.ts";

type AnyProps = Record<string, unknown>;

export function Slot({ children, ...props }: AnyProps & { children?: ReactNode }): ReactElement | null {
  const child = Children.only(children);
  if (!isValidElement<AnyProps>(child)) return null;
  const own = child.props;
  const merged: AnyProps = { ...props, ...own };
  for (const key of Object.keys(props)) {
    const mine = props[key];
    const theirs = own[key];
    if (key === "className") merged.className = cn(mine as string, theirs as string);
    else if (key === "style") merged.style = { ...(mine as object), ...(theirs as object) };
    else if (/^on[A-Z]/.test(key) && typeof mine === "function" && typeof theirs === "function") {
      merged[key] = (...args: unknown[]) => {
        (theirs as (...a: unknown[]) => void)(...args);
        (mine as (...a: unknown[]) => void)(...args);
      };
    }
  }
  return cloneElement(child, merged);
}
