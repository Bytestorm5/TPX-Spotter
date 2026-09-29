/**
 * `@trusplex/ui/theme` — tokens and theme resolution, with no React: usable
 * from a build script, a server, or a CSS generator.
 */
export {
  SCHEMES,
  PRESETS,
  TYPE,
  DEFAULT_FONT,
  createTheme,
  defaultTheme,
  applyPrimary,
  themeCss,
  themeStyle,
  toVars,
  type ColorTokens,
  type ShapeTokens,
  type TypeTokens,
  type Preset,
  type Scheme,
  type Theme,
  type ThemeOptions,
  type ThemeCssOptions,
} from "./tokens.ts";
export { contrastRatio, parseColor, readableOn, isDark, cssColor, luminance, type Rgba } from "./color.ts";
