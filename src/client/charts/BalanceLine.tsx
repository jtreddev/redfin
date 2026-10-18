import type { ISODate } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import type { ProjectionEvent, ProjectionPoint } from '../../shared/projection';
import { useMoneyText } from '../amounts';
import { money as plainMoney, shortDate, weekdayDate } from '../format';
import { useActiveMonth, useWidth } from './frame';
import { dollarsShort, rangeTicks } from './scale';
import { Tooltip, type TooltipRow } from './Tooltip';

/** Plot geometry (px). The SVG's height includes the date band. */
const LINE = { top: 16, plot: 132, axis: 26, left: 44, right: 12 } as const;
const svgHeight = LINE.top + LINE.plot + LINE.axis;
/** Under this width, only the first and last dates are labeled. */
const NARROW = 420;

/** "Today", or "Wed, Oct 21". */
export function dayTitle(date: ISODate, today: ISODate): string {
  return date === today ? `Today, ${shortDate(date)}` : weekdayDate(date);
}

/**
 * Cash day by day, one series in the accent ink (no legend: the card's title names it). A dashed line marks the
 * low-balance cushion, a dot marks the lowest day, and hover, tap or the arrow keys read out one day: its
 * balance and what comes out that day.
 */
export function BalanceLine({
  points,
  events,
  cushionCents,
  today,
  label,
}: {
  points: readonly ProjectionPoint[];
  events: readonly ProjectionEvent[];
  cushionCents: Cents;
  today: ISODate;
  label: string;
}) {
  const money = useMoneyText();
  const [ref, width] = useWidth<HTMLDivElement>();
  const count = points.length;
  const focus = useActiveMonth(count, 0);
  const { active } = focus;

  const values = points.map((p) => p.balanceCents);
  const cushion = cushionCents > 0 ? cushionCents : null;
  const tickValues = rangeTicks(Math.min(...values, cushion ?? 0), Math.max(...values, cushion ?? 0));
  const lo = tickValues[0]!;
  const hi = tickValues.at(-1)!;
  const plotWidth = Math.max(0, width - LINE.left - LINE.right);
  const xOf = (i: number) => LINE.left + (count > 1 ? (plotWidth * i) / (count - 1) : plotWidth / 2);
  const yOf = (v: number) => LINE.top + (LINE.plot * (hi - v)) / (hi - lo || 1);
  const indexAt = (x: number) => (count > 1 ? Math.max(0, Math.min(count - 1, Math.round(((x - LINE.left) / (plotWidth || 1)) * (count - 1)))) : 0);

  let lowest = 0;
  values.forEach((v, i) => {
    if (v < values[lowest]!) lowest = i;
  });
  const lowestPoint = points[lowest];
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.balanceCents).toFixed(1)}`).join('');
  const narrow = width < NARROW;
  const dateTicks = count > 1 ? (narrow || count < 7 ? [0, count - 1] : [0, Math.round((count - 1) / 2), count - 1]) : [0];
  const baseline = LINE.top + LINE.plot;

  const eventsOn = (date: ISODate) => events.filter((e) => e.date === date);
  const last = points[count - 1];
  const summary =
    last && lowestPoint
      ? `${label}. ${money(points[0]!.balanceCents, { whole: true })} today, ${money(last.balanceCents, { whole: true })} on ${shortDate(last.date)}. ` +
        `Lowest ${money(lowestPoint.balanceCents, { whole: true })} on ${shortDate(lowestPoint.date)}.` +
        (cushion !== null ? ` Your cushion is ${money(cushion, { whole: true })}.` : '')
      : label;

  const activePoint = active === null ? null : points[active];
  const rows: TooltipRow[] = activePoint
    ? [
        { key: 'balance', name: 'Cash at the end of the day', value: activePoint.balanceCents },
        ...eventsOn(activePoint.date).map((e) => ({ key: e.id, name: e.name, value: -e.amountCents })),
      ]
    : [];

  // The lowest-point label sits above the dot, nudged inside the chart at either end.
  const lowX = xOf(lowest);
  const lowAnchor = lowX < LINE.left + 40 ? 'start' : lowX > width - LINE.right - 40 ? 'end' : 'middle';

  return (
    <div className="chart balance-line" ref={ref}>
      <div className="chart-frame" role="group" aria-label={`${label}. Arrow keys move between days.`} {...focus.wrapperProps}>
        {width > 0 && count > 0 && (
          <svg
            width={width}
            height={svgHeight}
            role="img"
            aria-label={summary}
            onPointerMove={(e) => {
              if (e.pointerType !== 'mouse') return;
              focus.hover(indexAt(e.clientX - e.currentTarget.getBoundingClientRect().left));
            }}
            onPointerUp={(e) => {
              if (e.pointerType === 'mouse') return;
              focus.pin(indexAt(e.clientX - e.currentTarget.getBoundingClientRect().left));
            }}
          >
            <g aria-hidden="true">
              {tickValues.map((t) => (
                <g key={t}>
                  <line className={t === 0 ? 'chart-baseline' : 'chart-grid'} x1={LINE.left} x2={width - LINE.right} y1={yOf(t)} y2={yOf(t)} />
                  <text className="chart-tick chart-amount" x={LINE.left - 6} y={yOf(t)} dy="0.32em" textAnchor="end">
                    {dollarsShort(t)}
                  </text>
                </g>
              ))}
              {dateTicks.map((i) => (
                <text
                  key={i}
                  className={`chart-tick ${i === active ? 'active' : ''}`}
                  x={xOf(i)}
                  y={baseline + 18}
                  textAnchor={count === 1 ? 'middle' : i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}
                >
                  {i === 0 ? 'Today' : shortDate(points[i]!.date)}
                </text>
              ))}
              {cushion !== null && (
                <>
                  <line className="chart-reference chart-cushion" x1={LINE.left} x2={width - LINE.right} y1={yOf(cushion)} y2={yOf(cushion)} />
                  <text className="chart-label chart-label-quiet chart-amount" x={width - LINE.right} y={yOf(cushion) - 5} textAnchor="end">
                    Cushion {dollarsShort(cushion)}
                  </text>
                </>
              )}
              {activePoint && <line className="chart-crosshair" x1={xOf(active!)} x2={xOf(active!)} y1={LINE.top} y2={baseline} />}
              {count > 1 && <path className="balance-path" d={path} />}
              {lowestPoint && (
                <>
                  <circle className="balance-dot" cx={lowX} cy={yOf(lowestPoint.balanceCents)} r={4} />
                  <text className="chart-label chart-amount" x={lowX} y={yOf(lowestPoint.balanceCents) + (yOf(lowestPoint.balanceCents) > baseline - 20 ? -10 : 18)} textAnchor={lowAnchor}>
                    {/* The number itself: .chart-amount blurs it, and a tap reveals it (aria comes from the label). */}
                    {count > 1 ? `Lowest ${plainMoney(lowestPoint.balanceCents, { whole: true })}` : plainMoney(lowestPoint.balanceCents, { whole: true })}
                  </text>
                </>
              )}
              {activePoint && active !== lowest && <circle className="balance-dot" cx={xOf(active!)} cy={yOf(activePoint.balanceCents)} r={4} />}
            </g>
          </svg>
        )}
        {activePoint && width > 0 && (
          <Tooltip
            x={xOf(active!)}
            containerWidth={width}
            title={dayTitle(activePoint.date, today)}
            interactive={focus.pinned}
            rows={rows}
            note={cushion !== null && activePoint.balanceCents < cushion ? 'Under your cushion' : undefined}
          />
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {activePoint &&
          `${dayTitle(activePoint.date, today)}: ${money(activePoint.balanceCents, { whole: true })}` +
            eventsOn(activePoint.date)
              .map((e) => `, ${e.name} ${money(e.amountCents, { whole: true })}`)
              .join('')}
      </div>
    </div>
  );
}
