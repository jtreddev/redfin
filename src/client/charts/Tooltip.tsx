import { money } from '../format';

export interface TooltipRow {
  key: string;
  name: string;
  /** The series color as a CSS custom property, e.g. "--series-1"; drawn as a short line key. */
  colorVar?: string;
  value: number;
  /** Makes the row a button (e.g. "open these transactions"). */
  onClick?: () => void;
}

const WIDTH = 212;
const OFFSET = 14;

/**
 * The readout for one month: values lead, names follow, each keyed by a short stroke of its series color.
 * Placed beside the bar at `x` (px within the chart) and kept inside the chart's width, so it never makes the
 * page scroll sideways. Text is set as React text, never as HTML.
 */
export function Tooltip({
  x,
  containerWidth,
  title,
  total,
  rows,
  note,
  interactive,
}: {
  x: number;
  containerWidth: number;
  title: string;
  total?: number;
  rows: TooltipRow[];
  note?: string;
  /** Pinned by a tap or reached by keyboard: rows can be pressed. */
  interactive: boolean;
}) {
  const width = Math.min(WIDTH, containerWidth);
  const preferred = x < containerWidth / 2 ? x + OFFSET : x - OFFSET - width;
  const left = Math.max(0, Math.min(containerWidth - width, preferred));
  return (
    <div className={`chart-tooltip ${interactive ? 'interactive' : ''}`} style={{ left, width }}>
      <div className="tt-title">{title}</div>
      {total !== undefined && (
        <div className="tt-total">
          <strong className="money">{money(total, { whole: true })}</strong> <span className="muted">total</span>
        </div>
      )}
      {rows.map((row) => {
        const body = (
          <>
            {row.colorVar && <span className="tt-key" style={{ background: `var(${row.colorVar})` }} aria-hidden="true" />}
            <strong className="tt-value money">{money(row.value, { whole: true })}</strong>
            <span className="tt-name">{row.name}</span>
          </>
        );
        return row.onClick ? (
          <button key={row.key} type="button" className="tt-row tt-link" onClick={row.onClick} tabIndex={interactive ? 0 : -1}>
            {body}
            <span className="tt-go" aria-hidden="true">
              ›
            </span>
          </button>
        ) : (
          <div key={row.key} className="tt-row">
            {body}
          </div>
        );
      })}
      {note && <div className="tt-note muted">{note}</div>}
    </div>
  );
}
