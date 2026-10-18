import type { MonthKey } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import { useMoneyText } from '../amounts';
import { Money } from '../ui';
import { Axes, bands, LAYOUT, monthTitle, svgHeight, useActiveMonth, useHatch, useWidth } from './frame';
import { barPath, dollarsShort, labelsFit, niceMax, ticks } from './scale';
import { Tooltip } from './Tooltip';

/**
 * One series of monthly bars with an optional thin reference line (e.g. the usual amount). The current
 * month (`partialIndex`) is hatched. Negative months draw as 0; the tooltip shows the true amount.
 */
export function Bars({
  months,
  values,
  reference,
  colorVar,
  label,
  partialIndex,
}: {
  months: MonthKey[];
  values: Cents[];
  reference?: Cents;
  colorVar: string;
  label: string;
  partialIndex?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const count = months.length;
  const latest = partialIndex === count - 1 ? count - 2 : count - 1;
  const focus = useActiveMonth(count, Math.max(0, latest));
  const { active } = focus;
  const hatch = useHatch();
  const money = useMoneyText();

  const tallest = Math.max(0, reference ?? 0, ...values);
  const tickValues = ticks(tallest);
  const max = niceMax(tallest);
  const { center, barWidth, band } = bands(width, count);
  const yOf = (v: number) => LAYOUT.top + LAYOUT.plot - (Math.max(0, v) / max) * LAYOUT.plot;

  const summary =
    count > 0
      ? `${label}, ${monthTitle(months[0]!, false)} to ${monthTitle(months[count - 1]!, partialIndex === count - 1)}.` +
        (latest >= 0 ? ` ${monthTitle(months[latest]!, false)}: ${money(values[latest] ?? 0, { whole: true })}.` : '') +
        (reference !== undefined ? ` Usually ${money(reference, { whole: true })} a month.` : '')
      : label;

  const latestValue = latest >= 0 ? (values[latest] ?? 0) : 0;
  const latestLabel = dollarsShort(latestValue);

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
            <Axes width={width} months={months} tickValues={tickValues} max={max} partialIndex={partialIndex} active={active} />
            {values.map((v, i) => {
              const y = yOf(v);
              const d = barPath(center(i) - barWidth / 2, y, barWidth, LAYOUT.top + LAYOUT.plot - y, true);
              return (
                <g key={months[i]}>
                  <path className="chart-mark" d={d} style={{ fill: `var(${colorVar})` }} />
                  {i === partialIndex && <path className="chart-hatch" d={d} fill={hatch.fill} />}
                </g>
              );
            })}
            {reference !== undefined && reference > 0 && (
              <line className="chart-reference" x1={LAYOUT.left} x2={width - LAYOUT.right} y1={yOf(reference)} y2={yOf(reference)} aria-hidden="true" />
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
            title={monthTitle(months[active]!, active === partialIndex)}
            interactive={focus.pinned}
            rows={[{ key: 'value', name: label, colorVar, value: values[active] ?? 0 }]}
            note={reference !== undefined ? `Usually ${money(reference, { whole: true })} a month` : undefined}
          />
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {active !== null && `${monthTitle(months[active]!, active === partialIndex)}: ${money(values[active] ?? 0, { whole: true })}`}
      </div>
      {reference !== undefined && (
        <div className="chart-legend">
          <span className="chart-legend-item">
            <span className="chart-refkey" aria-hidden="true" />
            <span>
              Usual: <Money cents={reference} whole /> a month (last 3 full months)
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
