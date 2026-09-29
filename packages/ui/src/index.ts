/**
 * `@trusplex/ui` — the Trusplex component kit.
 *
 * The Spotter widget's design system, for any app: import
 * `@trusplex/ui/styles.css` once, theme it (`createTheme` + `themeCss`, or
 * `--tui-*` variables in your own CSS), and use the components. Everything
 * is accessible by default and renders on the server; the interactive
 * pieces (`Field` and its controls, `ChipGroup`, `Dialog`) are client
 * components.
 */
export { cn } from "./cn.ts";
export { Slot } from "./components/slot.tsx";
export {
  Button,
  IconButton,
  Spinner,
  type ButtonProps,
  type ButtonVariant,
  type ControlSize,
  type IconButtonProps,
} from "./components/button.tsx";
export { Field, useFieldControl, type FieldProps } from "./components/field.tsx";
export {
  Input,
  Textarea,
  Select,
  Checkbox,
  Radio,
  type InputProps,
  type SelectProps,
  type CheckboxProps,
} from "./components/input.tsx";
export { Chip, ChipGroup, type ChipProps, type ChipGroupProps, type ChipOption } from "./components/chips.tsx";
export {
  Badge,
  Card,
  CardHeader,
  CardFooter,
  Notice,
  List,
  ListItem,
  Details,
  KeyValue,
  Avatar,
  initials,
  Skeleton,
  Stat,
  EmptyState,
  Table,
  TH,
  TD,
  Tabs,
  Tab,
  type Tone,
  type BadgeProps,
  type CardProps,
  type CardHeaderProps,
  type NoticeProps,
  type ListItemProps,
  type DetailsProps,
  type KeyValueProps,
  type AvatarProps,
  type SkeletonProps,
  type StatProps,
  type EmptyStateProps,
  type TableProps,
  type TabProps,
} from "./components/display.tsx";
export { Dialog, focusables, deepActiveElement, type DialogProps } from "./components/dialog.tsx";
export {
  CloseIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  AlertIcon,
  InfoIcon,
  SuccessIcon,
} from "./components/icons.tsx";
export { createTheme, defaultTheme, themeCss, themeStyle, type Theme, type ThemeOptions } from "./theme/tokens.ts";
