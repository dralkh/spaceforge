/**
 * The statistics screen's drawings: a contribution-style heatmap, a stacked
 * forecast with a cumulative line, and a value histogram.
 *
 * Each is a small SVG built from plain numbers, in the same hand-rolled style
 * as the study visuals — no chart library. The arithmetic (levels, axis tops,
 * binning, label placement) lives in exported pure helpers so it can be tested
 * without a DOM. Colours are classes, never literals: the stylesheet decides
 * what a review, a deck card or a median line looks like.
 *
 * Two rules learned from the live app are baked in here:
 *
 * - `createSvg` / `addClass` hand their string straight to `classList.add` and
 *   reject a token containing a space, so classes go on one token at a time;
 * - native `<title>` tooltips are slow and unstyled, so hover text travels in
 *   `data-tip` and {@link attachChartTips} draws one shared tooltip layer.
 */
import { DAY_MS, histogram, median, percentile } from '../models/stats';
import { niceStep, tickValues } from './study-visual-graph';

/** One calendar day of the activity heatmap. */
export interface HeatmapDay {
    key: string;
    timestamp: number;
    notes: number;
    decks: number;
}

export interface HeatmapOptions {
    /** Every calendar day of the span, oldest first (gaps included). */
    days: HeatmapDay[];
    width: number;
    /** The day key currently picked, drawn with a stronger border. */
    selectedKey?: string | null;
    /** Today's key, outlined so the reader can find themselves. */
    todayKey?: string | null;
    onSelect?: (day: HeatmapDay) => void;
}

export interface ForecastOptions {
    days: Array<{ timestamp: number; notes: number; decks: number }>;
    width: number;
}

export interface HistogramOptions {
    values: number[];
    width: number;
    /** How a value reads on the axis (e.g. `3d`, `245%`). */
    format?: (value: number) => string;
    /** A hard top for the axis; values above it pool into the last bin. */
    cap?: number;
}

/* ------------------------------------------------------------ measuring */

/** The width the host actually offers, from whichever measurement it answers. */
export function measureWidth(host: HTMLElement, fallback = 360): number {
    const client = typeof host.clientWidth === 'number' && Number.isFinite(host.clientWidth) ? host.clientWidth : 0;
    if (client > 0) return Math.round(client);
    if (typeof host.getBoundingClientRect === 'function') {
        const width = host.getBoundingClientRect().width;
        if (Number.isFinite(width) && width > 0) return Math.round(width);
    }
    const offset = typeof host.offsetWidth === 'number' && Number.isFinite(host.offsetWidth) ? host.offsetWidth : 0;
    return offset > 0 ? Math.round(offset) : fallback;
}

/* -------------------------------------------------------------- svg aid */

/**
 * One svg element, with its class and attributes, on the element it belongs to.
 *
 * Classes are added one token at a time on purpose: Obsidian's `createSvg`
 * (and its `addClass`) hands the string straight to `classList.add`, which
 * rejects a token containing a space — the miniature DOM the tests use is more
 * forgiving, so this is a bug the live app catches and the suite does not.
 */
function shape<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, cls: string, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
    const stringAttrs: Record<string, string> = {};
    for (const [name, value] of Object.entries(attrs)) stringAttrs[name] = String(value);
    const element = parent.createSvg(tag, { attr: stringAttrs });
    for (const token of cls.split(/\s+/).filter(Boolean)) element.classList.add(token);
    return element;
}

function svgText(parent: Element, cls: string, text: string, x: number, y: number, anchor = 'middle'): SVGTextElement {
    const element = shape(parent, 'text', cls, { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, 'text-anchor': anchor });
    element.textContent = text;
    return element;
}

/** The hover text a chart shape carries, read by the shared tooltip layer. */
function tip(element: Element, text: string): void {
    element.setAttribute('data-tip', text);
}

/* -------------------------------------------------------------- labels */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `Aug 14`, in UTC, the way every day is bucketed. */
export function formatDayShort(timestamp: number): string {
    const date = new Date(timestamp);
    return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** `2026-08-14`, as the date itself reads. */
export function formatDayKey(key: string): string {
    const [year, month, day] = key.split('-').map(Number);
    return `${MONTHS[(month ?? 1) - 1]} ${day}, ${year}`;
}

/* ------------------------------------------------------------- tooltip */

/**
 * The shared hover tooltip for every chart inside `host`.
 *
 * One layer per chart, positioned from the pointer and driven by delegation:
 * any shape carrying `data-tip` shows it, and leaving the chart hides it. The
 * layer never takes the pointer, so hovering it cannot end the hover.
 */
export function attachChartTips(host: HTMLElement): void {
    const layer = host.createDiv('sf-stats-tip');
    const move = (event: MouseEvent): void => {
        const target = (event.target as Element | null)?.closest?.('[data-tip]') ?? null;
        const text = target?.getAttribute('data-tip') ?? '';
        if (!text) {
            layer.removeClass('is-visible');
            return;
        }
        layer.setText(text);
        layer.addClass('is-visible');
        const bounds = typeof host.getBoundingClientRect === 'function'
            ? host.getBoundingClientRect()
            : { left: 0, top: 0 };
        const x = (event.clientX ?? 0) - bounds.left;
        const y = (event.clientY ?? 0) - bounds.top;
        layer.setCssProps({ '--sf-stats-tip-x': `${Math.round(x)}px`, '--sf-stats-tip-y': `${Math.round(y)}px` });
    };
    host.addEventListener('mousemove', move);
    host.addEventListener('mouseleave', () => layer.removeClass('is-visible'));
}

/* ------------------------------------------------------------ heatmap */

/**
 * The four count thresholds the heatmap's levels turn on, read from the data
 * itself (the 20/40/60/80th percentiles of the days that saw anything). A
 * fixed linear scale makes a busy day sit next to a quiet one in the same
 * colour; a data-driven one keeps the grid expressive at every volume, which
 * is what the Review Heatmap add-on does with its dynamic legend.
 */
export function heatmapThresholds(counts: number[]): [number, number, number, number] {
    const nonzero = counts.filter(count => count > 0).sort((a, b) => a - b);
    if (nonzero.length === 0) return [1, 2, 3, 4];
    const at = (fraction: number): number =>
        nonzero[Math.min(nonzero.length - 1, Math.max(0, Math.ceil(fraction * nonzero.length) - 1))];
    const thresholds: [number, number, number, number] = [at(0.2), at(0.4), at(0.6), at(0.8)];
    // Levels must be reachable in order and never below 1: a busy day has to
    // be able to look busier than the day before it.
    for (let index = 0; index < thresholds.length; index++) {
        thresholds[index] = Math.max(thresholds[index], index + 1);
        if (index > 0) thresholds[index] = Math.max(thresholds[index], thresholds[index - 1]);
    }
    return thresholds;
}

/** How dark a day's cell is, from 0 (nothing) to 4 (the busiest band). */
export function heatmapLevel(count: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 {
    if (!(count > 0)) return 0;
    if (count >= (thresholds[3] ?? 4)) return 4;
    if (count >= (thresholds[2] ?? 3)) return 3;
    if (count >= (thresholds[1] ?? 2)) return 2;
    return 1;
}

/**
 * The calendar heatmap: one cell per day, weeks as columns, Sunday at the top.
 *
 * The span is whatever the caller passes; the cell size grows to fill a wide
 * card (up to 20px) and shrinks to fit a narrow one (down to 8px). Month names
 * ride along the top, but only where there is room, so they can never collide.
 */
export function renderHeatmap(host: HTMLElement, options: HeatmapOptions): void {
    const { days, width, selectedKey, todayKey, onSelect } = options;
    host.empty();
    if (days.length === 0) {
        host.createDiv({ cls: 'sf-stats-empty', text: 'Nothing recorded in this period yet.' });
        return;
    }

    const first = new Date(days[0].timestamp);
    const offset = first.getUTCDay(); // pad so weeks start on Sunday
    const columns = Math.ceil((days.length + offset) / 7);
    const labelWidth = 32;
    const topPad = 16;
    const available = Math.max(120, width - labelWidth - 4);
    const step = Math.max(10, Math.min(22, Math.floor(available / Math.max(columns, 1))));
    const cell = step - 2;
    const height = topPad + 7 * step + 6;
    const svg = shape(host, 'svg', 'sf-stats-svg sf-stats-heatmap-svg', {
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': `Review activity for the last ${days.length} days`,
    });

    const counts = days.map(day => day.notes + day.decks);
    const thresholds = heatmapThresholds(counts);
    const max = Math.max(...counts, 1);

    // Month names only where a label cannot touch the one before it. If a
    // month turns in a cramped column, the name waits for the next column that
    // has room (so a short month is not silently lost).
    let lastLabelColumn = -99;
    let lastMonth = -1;
    let pendingMonth: number | null = null;
    for (let index = 0; index < days.length; index++) {
        const day = days[index];
        const column = Math.floor((index + offset) / 7);
        const row = (index + offset) % 7;
        const x = labelWidth + column * step;
        const y = topPad + row * step;

        const month = new Date(day.timestamp).getUTCMonth();
        if (month !== lastMonth) {
            lastMonth = month;
            pendingMonth = month;
        }
        if (pendingMonth !== null && column >= lastLabelColumn + 3 && (width - x) >= 26) {
            svgText(svg, 'sf-stats-heatmap-month', MONTHS[pendingMonth], x, 10, 'start');
            lastLabelColumn = column;
            pendingMonth = null;
        }

        const count = day.notes + day.decks;
        const level = heatmapLevel(count, thresholds);
        const selected = selectedKey === day.key;
        const classes = ['sf-stats-cell', `is-l${level}`, selected ? 'is-selected' : '', todayKey === day.key ? 'is-today' : '']
            .filter(Boolean)
            .join(' ');
        const rect = shape(svg, 'rect', classes, {
            x, y, width: cell, height: cell, rx: 3,
            'data-day': day.key,
            tabindex: onSelect ? 0 : -1,
            'aria-label': describeDay(day, count),
        });
        tip(rect, describeDay(day, count));
        if (onSelect) {
            rect.addClass('is-clickable');
            rect.addEventListener('click', () => onSelect(day));
            rect.addEventListener('keydown', event => {
                const key = (event as KeyboardEvent).key;
                if (key === 'Enter' || key === ' ') {
                    event.preventDefault();
                    onSelect(day);
                }
            });
        }
    }

    // Row labels: three is enough to orient, and it keeps the margin small.
    for (const row of [1, 3, 5]) {
        svgText(svg, 'sf-stats-heatmap-weekday', WEEKDAYS[row], labelWidth - 6, topPad + row * step + cell - 1, 'end');
    }

    // The legend: what the four shades mean, in one line.
    const legend = host.createDiv('sf-stats-heat-legend');
    legend.createSpan({ cls: 'sf-stats-heat-legend-label', text: 'Less' });
    for (let level = 0; level <= 4; level++) legend.createSpan({ cls: `sf-stats-heat-swatch is-l${level}` });
    legend.createSpan({ cls: 'sf-stats-heat-legend-label', text: 'More' });
    void max;
}

/** The hover/aria text for one heatmap day. */
function describeDay(day: HeatmapDay, count: number): string {
    if (count === 0) return `No reviews on ${formatDayKey(day.key)}`;
    const parts = [`${count} review${count === 1 ? '' : 's'} on ${formatDayKey(day.key)}`];
    if (day.notes > 0) parts.push(`${day.notes} note${day.notes === 1 ? '' : 's'}`);
    if (day.decks > 0) parts.push(`${day.decks} deck card${day.decks === 1 ? '' : 's'}`);
    return parts.join(' · ');
}

/* ------------------------------------------------------ forecast bars */

/** The top of an axis: the data's max rounded up to the next nice step. */
export function niceAxisTop(maxValue: number, tickCount = 4): number {
    if (!(maxValue > 0)) return 1;
    const step = niceStep(maxValue, tickCount);
    return step > 0 ? Math.ceil(maxValue / step) * step : Math.max(1, Math.ceil(maxValue));
}

/**
 * Which days get x labels, so text never collides: the first day, the last
 * day, and as many in between as fit with a minimum pixel gap.
 */
export function forecastLabelIndices(count: number, slot: number, minGap = 92): number[] {
    if (count <= 0) return [];
    if (count === 1) return [0];
    const stride = Math.max(1, Math.ceil(minGap / Math.max(slot, 1)));
    const indices = [0];
    for (let index = stride; index < count - 1; index += stride) {
        if ((count - 1 - index) * slot < minGap * 0.8) break;
        indices.push(index);
    }
    indices.push(count - 1);
    return indices;
}

/**
 * Due cards per day as stacked bars — notes under, decks over — with a
 * cumulative line, the two readings Anki's Future Due graph offers.
 */
export function renderForecastBars(host: HTMLElement, options: ForecastOptions): void {
    const { days, width } = options;
    host.empty();
    if (days.length === 0) {
        host.createDiv({ cls: 'sf-stats-empty', text: 'Nothing scheduled yet.' });
        return;
    }

    const padding = { left: 30, right: 12, top: 14, bottom: 24 };
    const height = 156;
    const plotLeft = padding.left;
    const plotRight = width - padding.right;
    const plotTop = padding.top;
    const plotBottom = height - padding.bottom;
    const plotWidth = Math.max(40, plotRight - plotLeft);
    const plotHeight = plotBottom - plotTop;

    const totals = days.map(day => day.notes + day.decks);
    const axisTop = niceAxisTop(Math.max(...totals), 4);
    const ticks = tickValues(0, axisTop, 4);

    const slot = plotWidth / days.length;
    const barWidth = Math.max(2, Math.min(26, slot - 1.5));

    const svg = shape(host, 'svg', 'sf-stats-svg sf-stats-forecast-svg', {
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': 'Cards due over the next days',
    });

    // Today first, a quiet band behind its column.
    shape(svg, 'rect', 'sf-stats-forecast-today', {
        x: plotLeft, y: plotTop, width: Math.max(slot, 2), height: plotHeight, rx: 4,
    });

    for (const tick of ticks) {
        const y = plotBottom - (tick / axisTop) * plotHeight;
        shape(svg, 'line', 'sf-stats-gridline', { x1: plotLeft, y1: y, x2: plotRight, y2: y });
        svgText(svg, 'sf-stats-tick-label', String(tick), plotLeft - 6, y + 3, 'end');
    }

    let cumulative = 0;
    const linePoints: string[] = [];
    const totalDue = Math.max(1, totals.reduce((sum, total) => sum + total, 0));
    days.forEach((day, index) => {
        const x = plotLeft + index * slot + slot / 2;
        const total = totals[index];
        const barX = x - barWidth / 2;
        const notesHeight = (day.notes / axisTop) * plotHeight;
        const decksHeight = (day.decks / axisTop) * plotHeight;
        const label = `${formatDayShort(day.timestamp)}: ${total} due (${day.notes} note${day.notes === 1 ? '' : 's'}, ${day.decks} deck card${day.decks === 1 ? '' : 's'})`;

        if (day.notes > 0) {
            const rect = shape(svg, 'rect', 'sf-stats-bar is-notes', {
                x: barX, y: plotBottom - notesHeight, width: barWidth, height: Math.max(notesHeight, 2), rx: 2,
            });
            tip(rect, label);
        }
        if (day.decks > 0) {
            const rect = shape(svg, 'rect', 'sf-stats-bar is-decks', {
                x: barX, y: plotBottom - notesHeight - decksHeight, width: barWidth, height: Math.max(decksHeight, 2), rx: 2,
            });
            tip(rect, label);
        }
        if (total === 0) {
            shape(svg, 'rect', 'sf-stats-bar is-empty', {
                x: barX, y: plotBottom - 1, width: barWidth, height: 1,
            });
        }

        cumulative += total;
        linePoints.push(`${x},${plotBottom - (cumulative / totalDue) * (plotHeight - 8)}`);
    });

    // The cumulative line is its own scale; it starts under the first bar.
    if (days.length > 1) {
        shape(svg, 'polyline', 'sf-stats-cumulative-line', { points: linePoints.join(' '), fill: 'none' });
    }

    // X labels: first and last anchored to the edges, the rest centred, and
    // only where {@link forecastLabelIndices} says there is room.
    const labels = forecastLabelIndices(days.length, slot);
    labels.forEach((index, at) => {
        const x = plotLeft + index * slot + slot / 2;
        const label = index === 0 ? 'Today' : formatDayShort(days[index].timestamp);
        const anchor = at === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle';
        const anchorX = at === 0 ? plotLeft : index === days.length - 1 ? plotRight : x;
        svgText(svg, 'sf-stats-tick-label', label, anchorX, height - 8, anchor);
    });
}

/* ---------------------------------------------------------- histogram */

export interface HistogramBins {
    edges: number[];
    /** Raw counts per bin, with the overflow pooled into the last bin. */
    bins: number[];
    /** How many values sit at or above the last edge. */
    overflow: number;
    median: number | null;
}

/**
 * Bins for a value histogram, with edges a reader can divide by eye.
 *
 * The top is the 95th percentile so one far-out interval cannot flatten the
 * shape; values above it pool into the last bin, which the caller labels with
 * a `+`. When the data starts well above zero (ease factors, say) the axis
 * starts near the data instead of at an empty zero.
 */
export function histogramBins(values: number[], targetBins = 7, capPercentile = 95, capLimit?: number): HistogramBins {
    if (values.length === 0) return { edges: [0, 1], bins: [0], overflow: 0, median: null };
    const cap = Math.max(
        capLimit !== undefined ? Math.min(capLimit, Math.max(...values)) : percentile(values, capPercentile) ?? Math.max(...values),
        Number.EPSILON
    );
    const min = Math.min(...values);
    let step = niceStep(cap / targetBins, 1) || 1;
    if (!(step > 0)) step = 1;
    const floored = min > 0 && min > cap * 0.3;
    const start = floored ? Math.max(0, Math.floor(min / step) * step) : 0;
    if ((cap - start) / step > targetBins + 2) step = niceStep((cap - start) / targetBins, 1) || step;
    const edges: number[] = [start];
    while (edges[edges.length - 1] < cap && edges.length < 24) edges.push(edges[edges.length - 1] + step);
    // A single edge makes no bin at all (every value equal, say); one more
    // edge gives the histogram somewhere to put them.
    if (edges.length < 2) edges.push(edges[0] + step);
    const bins = histogram(values, edges);
    const overflow = values.filter(value => value >= edges[edges.length - 1]).length;
    if (overflow > 0) bins[bins.length - 1] += overflow;
    return { edges, bins, overflow, median: median(values) };
}

/**
 * A sensible top for a day-based histogram: the data's own maximum, but never
 * shorter than two months and never longer than the 75th percentile when a
 * long tail would otherwise flatten everything into one bar. (One 246-day
 * interval should not push every young card into a single column.)
 */
export function dayHistogramCap(values: number[], floor = 60, p75 = 75): number {
    if (values.length === 0) return floor;
    const max = Math.max(...values);
    return Math.max(1, Math.min(max, Math.max(floor, percentile(values, p75) ?? max)));
}

/**
 * A value histogram with the median marked, the shape Anki's interval, ease,
 * stability and difficulty graphs share.
 */
export function renderHistogram(host: HTMLElement, options: HistogramOptions): void {
    const { values, width, format = value => String(Math.round(value * 10) / 10), cap: capLimit } = options;
    host.empty();
    if (values.length === 0) {
        host.createDiv({ cls: 'sf-stats-empty', text: 'Nothing to plot yet.' });
        return;
    }

    const { edges, bins, overflow, median: medianValue } = histogramBins(values, 7, 95, capLimit);
    const top = Math.max(...bins, 1);

    const padding = { left: 26, right: 12, top: 18, bottom: 22 };
    const height = 150;
    const plotLeft = padding.left;
    const plotRight = width - padding.right;
    const plotTop = padding.top;
    const plotBottom = height - padding.bottom;
    const plotHeight = plotBottom - plotTop;
    const plotWidth = Math.max(40, plotRight - plotLeft);

    const svg = shape(host, 'svg', 'sf-stats-svg sf-stats-histogram-svg', {
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': 'Distribution of card values',
    });

    for (const tick of tickValues(0, top, 2)) {
        const y = plotBottom - (tick / top) * plotHeight;
        shape(svg, 'line', 'sf-stats-gridline', { x1: plotLeft, y1: y, x2: plotRight, y2: y });
        svgText(svg, 'sf-stats-tick-label', String(tick), plotLeft - 6, y + 3, 'end');
    }

    const span = Math.max(edges[edges.length - 1] - edges[0], 1);
    const slot = plotWidth / bins.length;
    const barWidth = Math.max(3, Math.min(38, slot - 3));
    bins.forEach((count, index) => {
        const from = edges[index];
        const to = index === bins.length - 1 && overflow > 0
            ? Math.max(edges[index + 1] ?? from, ...values)
            : edges[index + 1] ?? from;
        const x = plotLeft + ((from - edges[0]) / span) * plotWidth;
        const barX = plotLeft + ((from - edges[0]) / span) * plotWidth + (slot - barWidth) / 2;
        const h = (count / top) * plotHeight;
        const rect = shape(svg, 'rect', 'sf-stats-histogram-bar', {
            x: Math.min(barX, plotRight - barWidth), y: plotBottom - h, width: barWidth, height: Math.max(h, count > 0 ? 2 : 0), rx: 2,
        });
        tip(rect, index === bins.length - 1 && overflow > 0
            ? `${format(from)}+: ${count} item${count === 1 ? '' : 's'}`
            : `${format(from)}–${format(to)}: ${count} item${count === 1 ? '' : 's'}`);
        void x;
    });

    if (medianValue !== null) {
        const clamped = Math.min(Math.max(medianValue, edges[0]), edges[edges.length - 1]);
        const x = plotLeft + ((clamped - edges[0]) / span) * plotWidth;
        shape(svg, 'line', 'sf-stats-median-line', { x1: x, y1: plotTop - 6, x2: x, y2: plotBottom });
        svgText(svg, 'sf-stats-median-label', `med ${format(medianValue)}`, Math.min(Math.max(x, plotLeft + 22), plotRight - 22), plotTop - 8, 'middle');
    }

    svgText(svg, 'sf-stats-tick-label', format(edges[0]), plotLeft, height - 8, 'start');
    const lastEdge = edges[edges.length - 1];
    svgText(svg, 'sf-stats-tick-label', overflow > 0 ? `${format(lastEdge)}+` : format(lastEdge), plotRight, height - 8, 'end');
}

/* -------------------------------------------------------------- misc */

/** A short label like "3w" for a streak of days. */
export function formatStreak(days: number): string {
    if (days <= 0) return '0';
    if (days < 14) return `${days}d`;
    if (days < 60) return `${Math.round(days / 7)}w`;
    return `${Math.round(days / 30)}mo`;
}

/** The days of a span, oldest first, including the empty ones. */
export function eachDay(fromTimestamp: number, toTimestamp: number): Array<{ key: string; timestamp: number }> {
    const days: Array<{ key: string; timestamp: number }> = [];
    for (let timestamp = fromTimestamp; timestamp <= toTimestamp; timestamp += DAY_MS) {
        days.push({ key: new Date(timestamp).toISOString().slice(0, 10), timestamp });
    }
    return days;
}
