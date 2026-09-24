/**
 * App Router route patterns (`/blog/[slug]`) from what the router exposes to
 * client components.
 *
 * Next has no public "current route pattern" API. `useParams()` gives the
 * dynamic values for the current URL, so the pattern is recovered by walking
 * the pathname's segments and replacing each one that equals a param's value
 * with that param's bracketed name. Catch-alls (`[...slug]`, optional
 * `[[...slug]]`) are arrays and replace the run of segments they cover.
 * Route groups `(marketing)` and parallel routes never appear in the URL, so
 * they need no handling. When two params share a value the first match wins,
 * which is the rare case this approach can't disambiguate.
 */

export type RouteParams = Record<string, string | string[] | undefined>;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function deriveRoutePattern(pathname: string, params: RouteParams | null | undefined): string {
  const clean = pathname.split(/[?#]/)[0] || "/";
  if (!params || Object.keys(params).length === 0) return clean;
  const segments = clean.split("/").filter(Boolean);
  const out: string[] = [];
  const used = new Set<string>();
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | string[]][];

  for (let i = 0; i < segments.length; i++) {
    const seg = decode(segments[i] as string);
    let replaced = false;
    for (const [name, value] of entries) {
      if (used.has(name)) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        const run = segments.slice(i, i + value.length).map(decode);
        if (run.length === value.length && run.every((s, j) => s === value[j])) {
          // A catch-all is always last in its route, so the remaining length tells optional from required only by convention; report the required form.
          out.push(`[...${name}]`);
          used.add(name);
          i += value.length - 1;
          replaced = true;
          break;
        }
      } else if (seg === value) {
        out.push(`[${name}]`);
        used.add(name);
        replaced = true;
        break;
      }
    }
    if (!replaced) out.push(seg);
  }
  return "/" + out.join("/");
}

// -- build-time route manifest ------------------------------------------------------------

/**
 * Turn an `app/` directory path (`(shop)/blog/[slug]`) into its URL pattern
 * (`/blog/[slug]`): route groups and parallel-route slots vanish,
 * intercepting-route folders (`(.)photo`) are skipped entirely (they never
 * own a URL of their own). Returns null for folders that aren't routable.
 */
export function appDirToPattern(relDir: string): string | null {
  const out: string[] = [];
  for (const seg of relDir.split(/[\\/]/).filter(Boolean)) {
    if (/^\(\.{1,3}\)/.test(seg) || seg.startsWith("_")) return null; // intercepting / private folder
    if (/^\(.*\)$/.test(seg) || seg.startsWith("@")) continue; // group / slot
    out.push(seg);
  }
  return "/" + out.join("/");
}

const isDynamic = (seg: string) => seg.startsWith("[");

/**
 * Match a pathname against dynamic route patterns the way the App Router
 * prioritises them: static segments beat `[param]`, which beats
 * `[...catchAll]`, which beats `[[...optional]]`. Returns the pattern, or
 * undefined when none matches (the path is then its own pattern).
 */
export function matchRoutePattern(pathname: string, patterns: readonly string[]): string | undefined {
  const parts = pathname.split(/[?#]/)[0]!.split("/").filter(Boolean);
  let best: { pattern: string; score: number[] } | undefined;
  for (const pattern of patterns) {
    const segs = pattern.split("/").filter(Boolean);
    const score: number[] = [];
    let ok = true;
    let i = 0;
    for (let s = 0; s < segs.length && ok; s++) {
      const seg = segs[s]!;
      if (seg.startsWith("[[...")) {
        score.push(0);
        i = parts.length;
        break;
      }
      if (seg.startsWith("[...")) {
        if (i >= parts.length) ok = false;
        score.push(1);
        i = parts.length;
        break;
      }
      if (i >= parts.length) {
        ok = false;
        break;
      }
      if (isDynamic(seg)) score.push(2);
      else if (seg === parts[i]) score.push(3);
      else ok = false;
      i++;
    }
    if (!ok || i !== parts.length) continue;
    if (!best || compareScore(score, best.score) > 0) best = { pattern, score };
  }
  return best?.pattern;
}

function compareScore(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}
