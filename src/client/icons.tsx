/**
 * The app's icon set: 24px line icons drawn in currentColor (1.75px strokes, round ends), so they take the
 * color of the text beside them. Always decorative: the label next to an icon carries the meaning.
 */
const PATHS = {
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z',
  activity: 'M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01',
  trends: 'M4 20h16M6.5 20v-6M11 20V9M15.5 20v-8M20 20V5',
  plan: 'M4.5 6.5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1zM4.5 10h15M8.5 3.5v4M15.5 3.5v4M8 13.5h3M8 16.5h6',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  accounts: 'M3.5 9 12 4.5 20.5 9M5 9.5v7.5M9.5 9.5v7.5M14.5 9.5v7.5M19 9.5v7.5M3.5 19.5h17',
  income: 'M4 7.5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM12 9.5v5M9.75 12 12 14.5 14.25 12M7 10h.01M17 14h.01',
  rules: 'M4 4.5h7l8.5 8.5-7 7L4 11.5zM8 8.5h.01',
  kids: 'M12 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6.5 20.5v-1.5a5.5 5.5 0 0 1 11 0v1.5',
  fun: 'M12 15.5c3 0 5.5-2.8 5.5-6.25S15 3.5 12 3.5 6.5 5.8 6.5 9.25 9 15.5 12 15.5zM11 15.5l-.75 1.75h3.5L13 15.5M12 17.25c0 1.5-1.5 2-1.5 3.25',
  checkin: 'M4.5 6.5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H10l-4 3.5V16h-.5a1 1 0 0 1-1-1zM8.5 11l2.25 2.25L15.5 8.5',
  import: 'M12 15V4.5M8 8.5l4-4 4 4M4.5 14.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-4.5',
  export: 'M12 4.5V15M8 11l4 4 4-4M4.5 14.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-4.5',
  settings: 'M5 7h9M18 7h1M5 17h1M10 17h9M16 5v4M8 15v4M5 12h4M13 12h6M11 10v4',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M14.5 6 8.5 12l6 6',
  forward: 'M9.5 6l6 6-6 6',
  check: 'M5 12.5 10 17.5 19 7',
  lock: 'M6.5 11h11v8.5h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  table: 'M4.5 5.5h15v13h-15zM4.5 10h15M4.5 14.5h15M10 10v8.5',
  alert: 'M12 4 20.5 19h-17zM12 10v4M12 16.5h.01',
  gauge: 'M4.5 16a7.5 7.5 0 1 1 15 0M12 16l3.5-4M4.5 16h1.5M18 16h1.5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
