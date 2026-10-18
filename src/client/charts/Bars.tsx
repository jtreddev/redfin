import type { ReactNode } from 'react';
import type { MonthKey } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import { useMoneyText } from '../amounts';
import { money as plainMoney } from '../format';
import { Money } from '../ui';
import { Axes, bands, LAYOUT, monthTitle, plotY, svgHeight, useActiveMonth, useHatch, useWidth } from './frame';
import { barPath, dollarsShort, labelsFit, niceMax, rangeTicks, ticks } from './scale';
import { Tooltip, type TooltipRow } from './Tooltip';

/** What a month's readout shows, when it's more than the one value. */
export interface BarDetails {
  rows: TooltipRow[];
  /** Words only (it's read out as is): amounts go in rows, where they blur when amounts are hidden. */
  note?: string;
}

/**
 * One series of monthly bars with an optional thin reference line (e.g. the usual amount). The current
 * month (`partialIndex`) is hatched. Negative months draw as 0 and the tooltip shows the true amount, unless
 * `signed`: then they hang below a zero baseline (cash that goes under).
 *
 * A `cushion` reference is dashed and its legend names it; `titleOf` and `details` replace the default
 * month titles and readout.
 */
export function Bars({
  months,
  values,
  reference,
  referenceKind = 'usual',
  colorVar,
  label,
  partialIndex,
  partialLabel,
  signed = false,
  titleOf,
  details,
}: {
  months: MonthKey[];
  values: Cents[];
  reference?: Cents;
  referenceKind?: 'usual' | 'cushion';
  colorVar: string;
  label: string;
  partialIndex?: number;
  partialLabel?: string;
  signed?: boolean;
  titleOf?: (i: number) => string;
  details?: (i: number) => BarDetails;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const count = months.length;
  const latest = partialIndex === count - 1 ? count - 2 : count - 1;
  const focus = useActiveMonth(count, Math.max(0, latest));
  const { active } = focus;
  const hatch = useHatch();
  const money = useMoneyText();
  const title = titleOf ?? ((i: number) => monthTitle(months[i]!, i === partialIndex));
  const cushion = referenceKind === 'cushion';

  const tallest = Math.max(0, reference ?? 0, ...values);
  const lowest = signed ? Math.min(0, ...values) : 0;
  const tickValues = signed ? rangeTicks(lowest, tallest) : ticks(tallest);
  const max = signed ? tickValues.at(-1)! : niceMax(tallest);
  const min = signed ? tickValues[0]! : 0;
  const { center, barWidth, band } = bands(width, count);
  const yOf = (v: number) => plotY(signed ? v : Math.max(0, v), max, min);
  const zero = yOf(0);

  const referenceText = (cents: Cents) => (cushion ? `Your cushion is ${money(cents, { whole: true })}.` : `Usually ${money(cents, { whole: true })} a month.`);
  const summary =
    count > 0
      ? `${label}, ${title(0)} to ${title(count - 1)}.` +
        (latest >= 0 ? ` ${title(latest)}: ${money(values[latest] ?? 0, { whole: true })}.` : '') +
        (reference !== undefined ? ` ${referenceText(reference)}` : '')
      : label;

  const latestValue = latest >= 0 ? (values[latest] ?? 0) : 0;
  const latestLabel = dollarsShort(latestValue);
  const shown = active === null ? null : (details?.(active) ?? null);
  const defaultNote = (i: number) =>
    reference === undefined
      ? undefined
      : cushion
        ? (values[i] ?? 0) < reference
          ? 'Under your cushion'
          : undefined
        : `Usually ${plainMoney(reference, { whole: true })} a month`;

  let legend: ReactNode = null;
  if (reference !== undefined) {
    legend = (
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className={`chart-refkey ${cushion ? 'chart-refkey-dashed' : ''}`} aria-hidden="true" />
          <span>
            {cushion ? (
              <>
                Cushion: <Money cents={reference} whole />
              </>
            ) : (
              <>
                Usual: <Money cents={reference} whole /> a month (last 3 full months)
              </>
            )}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="chart" ref={ref}>
      <div className="chart-frame" role="group" aria-label={`${label}. Arrow keys move between months.`} {...focus.wrapperProps}>
        {width > 0 && (
          <svg
            width={width}
            height={svgHeight}
            role="img"
            aria-label={summary}
            onPointerMove={(e) => {
              if (e.pointerType !== 'mouse') return;
              focus.hover(bands(width, count).indexAt(e.clientX - e.currentTarget.getBoundingClientRect().left));
            }}
            // Touch and pen pin the readout; the mouse already shows it on hover, so its clicks do nothing.
            onPointerUp={(e) => {
              if (e.pointerType === 'mouse') return;
              focus.pin(bands(width, count).indexAt(e.clientX - e.currentTarget.getBoundingClientRect().left));
            }}
          >
            {hatch.def}
            <Axes
              width={width}
              months={months}
              tickValues={tickValues}
              max={max}
              min={min}
              partialIndex={partialIndex}
              partialLabel={partialLabel}
              active={active}
            />
            {values.map((v, i) => {
              const y = yOf(v);
              // A negative bar hangs from the zero line: drawn upside down, so its rounded end is at the bottom.
              const d =
                v < 0 && signed
                  ? barPath(center(i) - barWidth / 2, zero, barWidth, y - zero, false)
                  : barPath(center(i) - barWidth / 2, y, barWidth, zero - y, true);
              return (
                <g key={months[i]}>
                  <path className="chart-mark" d={d} style={{ fill: `var(${colorVar})` }} />
                  {i === partialIndex && <path className="chart-hatch" d={d} fill={hatch.fill} />}
                </g>
              );
            })}
            {reference !== undefined && reference > 0 && (
              <line
                className={`chart-reference ${cushion ? 'chart-cushion' : ''}`}
                x1={LAYOUT.left}
                x2={width - LAYOUT.right}
                y1={yOf(reference)}
                y2={yOf(reference)}
                aria-hidden="true"
              />
            )}
            {latest >= 0 && latestValue > 0 && labelsFit({ width: band, height: yOf(latestValue) }, latestLabel) && (
              <text className="chart-label chart-amount" x={center(latest)} y={yOf(latestValue) - 6} textAnchor="middle" aria-hidden="true">
                {latestLabel}
              </text>
            )}
          </svg>
        )}
        {active !== null && width > 0 && (
          <Tooltip
            x={center(active)}
            containerWidth={width}
            title={title(active)}
            interactive={focus.pinned}
            rows={shown?.rows ?? [{ key: 'value', name: label, colorVar, value: values[active] ?? 0 }]}
            note={shown ? shown.note : defaultNote(active)}
          />
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {active !== null &&
          (shown
            ? `${title(active)}: ${shown.rows.map((r) => `${r.name} ${money(r.value, { whole: true })}`).join(', ')}.${shown.note ? ` ${shown.note}.` : ''}`
            : `${title(active)}: ${money(values[active] ?? 0, { whole: true })}`)}
      </div>
      {legend}
    </div>
  );
}
