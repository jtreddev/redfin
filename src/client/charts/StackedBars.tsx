import type { MonthKey } from '../../shared/dates';
import type { Cents } from '../../shared/money';
import { useMoneyText } from '../amounts';
import { Money } from '../ui';
import { Axes, bands, LAYOUT, monthTitle, plotY, svgHeight, useActiveMonth, useHatch, useWidth } from './frame';
import { barPath, dollarsShort, labelsFit, niceMax, stackLayout, ticks } from './scale';
import { Tooltip } from './Tooltip';

export interface Series {
  key: string;
  name: string;
  /** A CSS custom property holding the series color, e.g. "--series-1". */
  colorVar: string;
  values: Cents[];
}

/** A value per month drawn as a short ink tick across the bar, on the same axis (e.g. money in). */
export interface Marker {
  name: string;
  values: Cents[];
}

/**
 * One stacked bar per month, segments in the series' order from the baseline up. The current month
 * (`partialIndex`) is hatched and labelled "so far" (or `partialLabel`). Negative values (refund months) draw
 * as 0; the tooltip and legend show the true amounts. An optional `marker` adds a tick per month and a legend
 * entry; `titleOf` replaces the default month titles.
 */
export function StackedBars({
  months,
  series,
  partialIndex,
  partialLabel,
  onSelect,
  label,
  marker,
  titleOf,
}: {
  months: MonthKey[];
  series: Series[];
  partialIndex?: number;
  partialLabel?: string;
  onSelect?: (monthIndex: number, seriesKey: string) => void;
  label: string;
  marker?: Marker;
  titleOf?: (i: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const count = months.length;
  /** The latest full month: it carries the direct labels. */
  const latest = partialIndex === count - 1 ? count - 2 : count - 1;
  const focus = useActiveMonth(count, Math.max(0, latest));
  const { active } = focus;
  const hatch = useHatch();
  const money = useMoneyText();
  const title = titleOf ?? ((i: number) => monthTitle(months[i]!, i === partialIndex));

  const totals = months.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const tallest = Math.max(
    0,
    ...months.map((_, i) => series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0)),
    ...(marker?.values ?? []),
  );
  const tickValues = ticks(tallest);
  const max = niceMax(tallest);
  const { center, barWidth, band } = bands(width, count);

  const summary =
    count > 0
      ? `${label}, ${title(0)} to ${title(count - 1)}.` +
        (latest >= 0
          ? ` ${title(latest)}: ${series.map((s) => `${s.name} ${money(s.values[latest] ?? 0, { whole: true })}`).join(', ')}` +
            (marker ? `; ${marker.name} ${money(marker.values[latest] ?? 0, { whole: true })}.` : '.')
          : '')
      : label;

  const select = (i: number, key: string | null) => {
    if (key && onSelect && (!focus.isTouch() || (focus.pinned && active === i))) onSelect(i, key);
    else focus.pin(i);
  };

  const tip =
    active !== null && width > 0 ? (
      <Tooltip
        x={center(active)}
        containerWidth={width}
        title={title(active)}
        total={totals[active]}
        interactive={focus.pinned}
        rows={[
          ...series.map((s) => ({
            key: s.key,
            name: s.name,
            colorVar: s.colorVar,
            value: s.values[active] ?? 0,
            onClick: onSelect ? () => onSelect(active, s.key) : undefined,
          })),
          ...(marker ? [{ key: 'marker', name: marker.name, colorVar: '--ink', value: marker.values[active] ?? 0 }] : []),
        ]}
      />
    ) : null;

  const latestTotal = latest >= 0 ? totals[latest]! : 0;
  const totalLabel = dollarsShort(latestTotal);
  /** Top of the latest full month's stack (px within the plot). */
  const latestTop =
    latest >= 0
      ? Math.min(LAYOUT.plot, ...stackLayout(series.map((s) => s.values[latest] ?? 0), LAYOUT.plot, max).filter((s) => s.height > 0).map((s) => s.y))
      : LAYOUT.plot;

  return (
    <div className={`chart ${onSelect ? 'chart-selectable' : ''}`} ref={ref}>
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
            // Touch and pen act on pointerup (a scroll cancels it); the mouse on click.
            onPointerUp={(e) => {
              if (e.pointerType === 'mouse') return;
              const i = bands(width, count).indexAt(e.clientX - e.currentTarget.getBoundingClientRect().left);
              select(i, (e.target as Element).getAttribute('data-series'));
            }}
            onClick={(e) => {
              if (focus.isTouch()) return;
              const i = bands(width, count).indexAt(e.clientX - e.currentTarget.getBoundingClientRect().left);
              select(i, (e.target as Element).getAttribute('data-series'));
            }}
          >
            {hatch.def}
            <Axes width={width} months={months} tickValues={tickValues} max={max} partialIndex={partialIndex} partialLabel={partialLabel} active={active} />
            {months.map((month, i) => {
              const segments = stackLayout(
                series.map((s) => s.values[i] ?? 0),
                LAYOUT.plot,
                max,
              );
              const x = center(i) - barWidth / 2;
              return (
                <g key={month}>
                  {segments.map((seg, k) => {
                    const d = barPath(x, LAYOUT.top + seg.y, barWidth, seg.height, seg.top);
                    return (
                      <g key={series[k]!.key}>
                        <path data-series={series[k]!.key} className="chart-mark" d={d} style={{ fill: `var(${series[k]!.colorVar})` }} />
                        {i === partialIndex && <path data-series={series[k]!.key} className="chart-mark chart-hatch" d={d} fill={hatch.fill} />}
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {marker?.values.map((v, i) => (
              <line
                key={months[i]}
                className="chart-marker"
                x1={center(i) - barWidth / 2 - 4}
                x2={center(i) + barWidth / 2 + 4}
                y1={plotY(Math.max(0, v), max)}
                y2={plotY(Math.max(0, v), max)}
                aria-hidden="true"
              />
            ))}
            {!marker && latest >= 0 && latestTotal > 0 && labelsFit({ width: band, height: LAYOUT.top + latestTop }, totalLabel) && (
              <text className="chart-label chart-amount" x={center(latest)} y={LAYOUT.top + latestTop - 6} textAnchor="middle" aria-hidden="true">
                {totalLabel}
              </text>
            )}
          </svg>
        )}
        {tip}
      </div>
      <div className="sr-only" aria-live="polite">
        {active !== null &&
          `${title(active)}: total ${money(totals[active]!, { whole: true })}. ` +
            series.map((s) => `${s.name} ${money(s.values[active] ?? 0, { whole: true })}`).join(', ') +
            (marker ? `. ${marker.name} ${money(marker.values[active] ?? 0, { whole: true })}` : '')}
      </div>
      {latest >= 0 && (
        <div className="chart-legend">
          <span className="chart-legend-title muted">{titleOf ? title(latest) : monthTitle(months[latest]!, false)}</span>
          {series.map((s) => (
            <span key={s.key} className="chart-legend-item">
              <span className="chart-swatch" style={{ background: `var(${s.colorVar})` }} aria-hidden="true" />
              <span>{s.name}</span>
              <Money cents={s.values[latest] ?? 0} whole className="muted" />
            </span>
          ))}
          {marker && (
            <span className="chart-legend-item">
              <span className="chart-markkey" aria-hidden="true" />
              <span>{marker.name}</span>
              <Money cents={marker.values[latest] ?? 0} whole className="muted" />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
