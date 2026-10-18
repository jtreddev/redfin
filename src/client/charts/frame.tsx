import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { MonthKey } from '../../shared/dates';
import { monthShortLabel } from '../format';
import { dollarsShort, monthTick } from './scale';

/** Plot geometry shared by the bar charts (px). The SVG's height includes the x-axis band. */
export const LAYOUT = { top: 20, plot: 168, axis: 34, left: 40, right: 4, maxBar: 24 } as const;
/** Under this chart width, months show as single letters. */
export const NARROW = 480;

export const svgHeight = LAYOUT.top + LAYOUT.plot + LAYOUT.axis;

/** Width of an element, kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Horizontal geometry: one band per month, bars thin and centred in their band. */
export function bands(width: number, count: number) {
  const plotWidth = Math.max(0, width - LAYOUT.left - LAYOUT.right);
  const band = count > 0 ? plotWidth / count : 0;
  const barWidth = Math.max(4, Math.min(LAYOUT.maxBar, band * 0.6));
  return {
    plotWidth,
    band,
    barWidth,
    center: (i: number) => LAYOUT.left + band * i + band / 2,
    indexAt: (x: number) => Math.max(0, Math.min(count - 1, Math.floor((x - LAYOUT.left) / (band || 1)))),
  };
}

/**
 * Which month the chart is showing details for, from hover, tap or keyboard. A tap or keyboard focus pins
 * the readout (its rows can then be pressed); a tap outside, Escape or leaving the chart clears it.
 */
export function useActiveMonth(count: number, initial: number) {
  const wrapper = useRef<HTMLDivElement>(null);
  const pointer = useRef('mouse');
  const [active, setActive] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) {
        setPinned(false);
        setActive(null);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pinned]);

  const clear = () => {
    setActive(null);
    setPinned(false);
  };
  const pin = (i: number) => {
    setActive(i);
    setPinned(true);
  };

  const wrapperProps = {
    ref: wrapper,
    tabIndex: 0,
    onPointerDown: (e: ReactPointerEvent) => {
      pointer.current = e.pointerType;
    },
    onPointerLeave: (e: ReactPointerEvent) => {
      if (e.pointerType === 'mouse' && !pinned) setActive(null);
    },
    onFocus: (e: React.FocusEvent<HTMLDivElement>) => {
      if (e.target === wrapper.current && active === null && wrapper.current.matches(':focus-visible')) pin(initial);
    },
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (!wrapper.current?.contains(e.relatedTarget as Node | null)) clear();
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const from = active ?? initial;
      const to =
        e.key === 'ArrowLeft' ? from - 1 : e.key === 'ArrowRight' ? from + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : null;
      if (e.key === 'Escape') {
        // From a tooltip row: hand focus back to the chart before the row disappears, so it isn't lost.
        if (wrapper.current && document.activeElement !== wrapper.current) wrapper.current.focus();
        clear();
        return;
      }
      if (to === null) return;
      e.preventDefault();
      pin(Math.max(0, Math.min(count - 1, active === null ? from : to)));
    },
  };

  return {
    active,
    pinned,
    wrapperProps,
    /** Mouse hover moves the readout unless it's pinned. */
    hover: (i: number | null) => {
      if (!pinned) setActive(i);
    },
    pin,
    /** The last pointer was a finger or pen: taps show details before they navigate. */
    isTouch: () => pointer.current !== 'mouse',
  };
}

/** Recessive grid, y ticks in whole dollars, month labels (single letters on narrow charts). */
export function Axes({
  width,
  months,
  tickValues,
  max,
  partialIndex,
  active,
}: {
  width: number;
  months: readonly MonthKey[];
  tickValues: number[];
  max: number;
  partialIndex?: number;
  active: number | null;
}) {
  const { center, band } = bands(width, months.length);
  const narrow = width < NARROW;
  const yOf = (v: number) => LAYOUT.top + LAYOUT.plot - (v / max) * LAYOUT.plot;
  const baseline = LAYOUT.top + LAYOUT.plot;
  return (
    <g aria-hidden="true">
      {active !== null && (
        <rect className="chart-hover" x={LAYOUT.left + band * active} y={LAYOUT.top - 4} width={band} height={LAYOUT.plot + 4} rx={4} />
      )}
      {tickValues.map((t) => (
        <g key={t}>
          {t > 0 && <line className="chart-grid" x1={LAYOUT.left} x2={width - LAYOUT.right} y1={yOf(t)} y2={yOf(t)} />}
          <text className="chart-tick" x={LAYOUT.left - 6} y={yOf(t)} dy="0.32em" textAnchor="end">
            {dollarsShort(t)}
          </text>
        </g>
      ))}
      <line className="chart-baseline" x1={LAYOUT.left} x2={width - LAYOUT.right} y1={baseline} y2={baseline} />
      {months.map((m, i) => (
        <text key={m} className={`chart-tick ${i === active ? 'active' : ''}`} x={center(i)} y={baseline + 16} textAnchor="middle">
          {monthTick(m, narrow)}
          {i === partialIndex && (
            <tspan x={center(i)} dy="1.2em" className="chart-sofar">
              so far
            </tspan>
          )}
        </text>
      ))}
    </g>
  );
}

/**
 * Diagonal stripes in the page color, laid over the current month's bars: "so far" is shown by texture,
 * not by fading the color (a faded yellow or aqua bar would fall under 3:1 against the page).
 */
export function useHatch() {
  const id = `hatch-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const def = (
    <defs>
      <pattern id={id} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
        <line className="chart-hatch-line" x1="0" y1="0" x2="0" y2="6" />
      </pattern>
    </defs>
  );
  return { fill: `url(#${id})`, def };
}

/** "Sep 2026", or "Oct 2026 so far" for the current month. */
export function monthTitle(month: MonthKey, partial: boolean): string {
  return `${monthShortLabel(month)}${partial ? ' so far' : ''}`;
}
