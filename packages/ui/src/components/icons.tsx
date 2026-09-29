/**
 * Inline SVG icons (24px grid, 1.75 stroke, `currentColor`) — the Spotter
 * widget's set, so the kit needs no icon library. Decorative: the control
 * that holds one carries the accessible name.
 */
import type { ReactElement } from "react";

const S = (d: ReactElement | ReactElement[]) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {d}
  </svg>
);

export const CloseIcon = () => S(<path d="M6 6l12 12M18 6L6 18" />);
export const CheckIcon = () => S(<path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth={2.25} />);
export const ChevronRightIcon = () => S(<path d="M9 6l6 6-6 6" />);
export const ChevronDownIcon = () => S(<path d="M6 9l6 6 6-6" />);
export const AlertIcon = () =>
  S([
    <circle key="a" cx="12" cy="12" r="9" />,
    <path key="b" d="M12 7.5v5" />,
    <path key="c" d="M12 16h.01" strokeWidth={2.2} />,
  ]);
export const InfoIcon = () =>
  S([
    <circle key="a" cx="12" cy="12" r="9" />,
    <path key="b" d="M12 11v5.5" />,
    <path key="c" d="M12 7.5h.01" strokeWidth={2.2} />,
  ]);
export const SuccessIcon = () =>
  S([<circle key="a" cx="12" cy="12" r="9" />, <path key="b" d="M8.5 12.5l2.5 2.5 4.5-5" />]);
