import type { ReactNode } from "react";

/** Line icons drawn on a 24 px grid. They inherit the text colour. */
const SHAPES = {
  assistant: <path d="M4 5.5h16v10.5H9.8L5.5 19.5V16H4z" />,
  account: <path d="M5.5 4.5h13v15h-13zM9 9h6M9 12.5h6M9 16h3.5" />,
  wallet: <path d="M4 7.5 16.5 4v3.5M4 7.5h16v12H5a1 1 0 0 1-1-1zM20 12h-5.5v3.5H20" />,
  activity: <path d="M3 12.5h4l2.5-7 4.5 13 2.5-6H21" />,
  settings: (
    <>
      <path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20" />
      <circle cx="15" cy="7" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  refresh: <path d="M19.5 8a8 8 0 1 0 .9 6M20.5 3.5V8H16" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: <path d="M12 4 21 19.5H3zM12 10v4.5M12 17v.2" />,
  trade: <path d="M4 8.5h15m-4-4 4 4-4 4M20 15.5H5m4 4-4-4 4-4" />,
  chart: <path d="M4 19.5h16M7.5 16V9.5M12 16V5M16.5 16v-4.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15.5" r="3.5" />
      <path d="M10.5 13 19 4.5M15.5 8l2.5 2.5" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="5" width="16" height="6" rx="1.5" />
      <rect x="4" y="13" width="16" height="6" rx="1.5" />
      <path d="M7.5 8h.2M7.5 16h.2" />
    </>
  ),
  compose: (
    <path d="M12 5H6a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 6 19h11a1.5 1.5 0 0 0 1.5-1.5V12M17.5 4.5l2 2L12 14l-2.8.8.8-2.8z" />
  ),
  external: <path d="M10 5H5.5v13.5H19V14M14 4.5h5.5V10M19.5 4.5 11 13" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M5.5 15.5h-1v-11h11v1" />
    </>
  ),
  model: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10 4v3M14 4v3M17 10h3M17 14h3M14 17v3M10 17v3M4 10h3M4 14h3" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M9.5 5v14" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M14.5 5v14" />
    </>
  ),
  dots: (
    <g fill="currentColor" stroke="none">
      <circle cx="6" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="18" cy="12" r="1.5" />
    </g>
  ),
  trash: <path d="M5 7h14M10 7V4.5h4V7M7 7l.8 12.5h8.4L17 7M10.5 11v5M13.5 11v5" />,
  star: <path d="m12 4 2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.7-5 2.7.9-5.6-4-3.9 5.6-.8z" />,
  starFilled: <path d="m12 4 2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.7-5 2.7.9-5.6-4-3.9 5.6-.8z" fill="currentColor" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  back: <path d="m15 6-6 6 6 6" />,
  news: <path d="M4.5 5.5h11.5v13H6.5a2 2 0 0 1-2-2zM16 9.5h3.5v7a2 2 0 0 1-2 2H6.5M7.5 9h5.5M7.5 12.5h5.5M7.5 16h3" />,
  plug: <path d="M9 4v4M15 4v4M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V20" />,
  appearance: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11.2v5M12 7.8v.2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof SHAPES;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SHAPES[name]}
    </svg>
  );
}
