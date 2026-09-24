/**
 * Inline SVG icons (24px grid, 1.75 stroke, `currentColor`) — no icon font,
 * no external requests, nothing a CSP would block. Decorative: callers give
 * the button its accessible name.
 */
import type { ReactElement } from "react";

const S = (d: ReactElement | ReactElement[]) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {d}
  </svg>
);

export const CloseIcon = () => S(<path d="M6 6l12 12M18 6L6 18" />);
export const BackIcon = () => S(<path d="M15 18l-6-6 6-6" />);
export const CheckIcon = () => S(<path d="M5 12.5l4.5 4.5L19 7.5" strokeWidth={2.25} />);
export const ChevronRight = () => S(<path d="M9 6l6 6-6 6" />);
export const ChevronDown = () => S(<path d="M6 9l6 6 6-6" />);
export const CopyIcon = () =>
  S([<rect key="a" x="8" y="8" width="12" height="12" rx="2.5" />, <path key="b" d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />]);
export const ShieldIcon = () => S([<path key="a" d="M12 3l7 3v5.5c0 4.3-3 7.9-7 9.5-4-1.6-7-5.2-7-9.5V6z" />, <path key="b" d="M9 12l2 2 4-4" />]);
export const AlertIcon = () => S([<circle key="a" cx="12" cy="12" r="9" />, <path key="b" d="M12 7.5v5" />, <path key="c" d="M12 16h.01" strokeWidth={2.2} />]);
export const RectIcon = () => S(<rect x="4" y="5.5" width="16" height="13" rx="2" />);
export const ArrowIcon = () => S([<path key="a" d="M5 19L19 5" />, <path key="b" d="M9 5h10v10" />]);
export const PenIcon = () => S(<path d="M4 20c2.5-.3 4-1.5 5.5-3.5S13 11 15 9s4-2.5 5-1.5-1 3-3 4.5-5 3-7.5 4.5" />);
export const TextIcon = () => S([<path key="a" d="M5 6.5V5h14v1.5" />, <path key="b" d="M12 5v14" />, <path key="c" d="M9 19h6" />]);
export const PinIcon = () =>
  S([<circle key="a" cx="12" cy="12" r="8.5" />, <path key="b" d="M11 9.5l1.5-1v7" />, <path key="c" d="M10.5 15.5h3.5" />]);
export const BlurIcon = () =>
  S([
    <rect key="a" x="4" y="4" width="16" height="16" rx="2.5" />,
    <path key="b" d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16" strokeWidth={1.25} />,
  ]);
export const UndoIcon = () => S([<path key="a" d="M9 14L4 9l5-5" />, <path key="b" d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />]);
export const RedoIcon = () => S([<path key="a" d="M15 14l5-5-5-5" />, <path key="b" d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />]);
export const TrashIcon = () => S([<path key="a" d="M4 7h16" />, <path key="b" d="M10 11v6M14 11v6" />, <path key="c" d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5h6V7" />]);
export const CameraIcon = () =>
  S([<path key="a" d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />, <circle key="b" cx="12" cy="12.5" r="3.5" />]);
export const CursorIcon = () => S([<path key="a" d="M5 4l5.5 15 2.2-6.3L19 10.5z" />, <path key="b" d="M13 13l5 5" />]);
export const RecordIcon = () => S([<rect key="a" x="3" y="6" width="13" height="12" rx="2.5" />, <path key="b" d="M16 10.5l5-3v9l-5-3" />]);
export const ImageIcon = () =>
  S([<rect key="a" x="3.5" y="4.5" width="17" height="15" rx="2.5" />, <circle key="b" cx="9" cy="10" r="1.8" />, <path key="c" d="M20.5 15.5l-5-5-9 9" />]);
export const TerminalIcon = () => S([<rect key="a" x="3" y="4.5" width="18" height="15" rx="2.5" />, <path key="b" d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4" />]);
export const GlobeIcon = () =>
  S([<circle key="a" cx="12" cy="12" r="9" />, <path key="b" d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />]);
export const ClickIcon = () => S([<path key="a" d="M9 9l11 4-4.5 1.5L14 19z" />, <path key="b" d="M5 3.5l1 2.5M3.5 7l2.5.8M10 2.5l-.6 2.6" />]);
export const MonitorIcon = () => S([<rect key="a" x="3" y="4" width="18" height="12.5" rx="2" />, <path key="b" d="M8.5 20h7M12 16.5V20" />]);
export const PlayIcon = () => S([<circle key="a" cx="12" cy="12" r="9" />, <path key="b" d="M10 8.8v6.4l5.2-3.2z" />]);
export const StarIcon = () =>
  S(<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor" stroke="none" />);
export const ThumbIcon = () => S([<path key="a" d="M7 10.5V20H4.5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1z" />, <path key="b" d="M7 10.5l4-7a2 2 0 0 1 2.7 2.4L12.8 9.5h5.7a2 2 0 0 1 2 2.3l-1.2 6.5a2 2 0 0 1-2 1.7H7" />]);
export const InboxIcon = () => S([<path key="a" d="M3.5 13.5l2.6-7.2A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.3l2.6 7.2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />, <path key="b" d="M3.5 13.5h4.5l1.5 2.5h5l1.5-2.5h4.5" />]);
export const UserIcon = () => S([<circle key="a" cx="12" cy="8.5" r="3.5" />, <path key="b" d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5" />]);
export const MicIcon = () => S([<rect key="a" x="9" y="3" width="6" height="11" rx="3" />, <path key="b" d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />]);
