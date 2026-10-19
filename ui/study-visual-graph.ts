/**
 * Spaceforge Study — the graph: series plotted, and a curve the reader reads.
 *
 * A graph teaches one shape — a curve against its axis — and this draws it as
 * SVG with no chart library: axes with their own ticks, one polyline per series
 * in its series colour, one small circle per datum, and a label per point that
 * appears on hover and on keyboard focus. On top of the drawing the reader gets
 * an *instrument*: a marker they drag along the plot, with a readout that
 * answers with the curve's own value wherever it sits — the interpolated y
 * between the two readings either side, named by the nearest reading. Arrow
 * keys step the marker from reading to reading.
 *
 * Five decisions are load-bearing:
 *
 *  - **The plot is drawn at the width the host measured**, re-measured through
 *    a guarded `ResizeObserver`. Too narrow a host does not squeeze the axes
 *    into illegibility: the drawing has a floor width and the box around it
 *    scrolls, so the graph never widens the panel it was given.
 *  - **The scale comes from the asset's bounds when it declares them**, and
 *    from the points when it does not. A point outside the declared window is
 *    drawn at the edge of the plot rather than escaping the drawing, and its
 *    label still reports its true value.
 *  - **A point is reachable without a mouse.** Every point is a focusable
 *    element with its own `aria-label`, and focus reveals the same tooltip a
 *    hover does; the marker is a focusable slider whose arrows walk the
 *    readings, so the curve can be read from the keyboard alone.
 *  - **One point is not a crash.** A series that carries a single datum draws
 *    its dot and skips the degenerate polyline.
 *  - **Movement is opt-in.** The curve draws itself in only where the host
 *    allows motion (`motionAllowed()`), which is false under
 *    `prefers-reduced-motion: reduce` and false for a host with no `matchMedia`
 *    at all; the class that starts the draw-in is added on the mounting draw
 *    only, because a re-measure is not an arrival.
 *
 * The geometry is a pure function (`plotGeometry`) so what the axes mean can be
 * pinned in a test without laying anything out, and so can everything the marker
 * answers with (`interpolateSeriesY`, `nearestReading`, `markerReading`).
 */

import { StudyGraph, StudyGraphPoint, StudyGraphSeries } from '../models/study-visuals';
import { formatNumber } from '../utils/expr';

/** Padding inside the drawing: room for the tick labels and the axis names. */
export const GRAPH_PADDING = { left: 44, right: 16, top: 16, bottom: 34 };
/** The narrowest drawing worth having; a narrower host scrolls this box instead. */
export const GRAPH_MIN_WIDTH = 260;
/** What is assumed before the host has been measured — roughly a sidebar. */
export const GRAPH_FALLBACK_WIDTH = 320;
/** Past this the drawing stops growing: a graph is not a poster. */
export const GRAPH_MAX_WIDTH = 960;
/** The height band the drawing keeps, whatever its width. */
export const GRAPH_MIN_HEIGHT = 150;
export const GRAPH_MAX_HEIGHT = 320;
/** Roughly how many marks an axis carries before the step is coarsened. */
export const TARGET_TICKS = 5;
/** The drawn dot, and the larger invisible target around it. */
const POINT_RADIUS = 4;
const HIT_RADIUS = 11;
/** The room a tooltip (or the marker's readout) needs above a point before it has to hang below it instead. */
const TIP_ROOM = 48;
/** The marker's own dot, and the line it hangs on. */
const MARKER_RADIUS = 5;
/** The tag on the line the reader should leave with. */
const PEARL_TAG = 'Pearl';

export type GraphTone = 'primary' | 'accent' | 'muted';

/** One datum, at its value and at its place in the drawing. */
export interface PlotPoint {
    x: number;
    y: number;
    label?: string;
    cx: number;
    cy: number;
}

/** One series, ready to draw. */
export interface PlotSeries {
    id: string;
    label: string;
    tone: GraphTone;
    points: PlotPoint[];
}

/** One mark on an axis: the value, where it sits in the drawing, and how it reads. */
export interface PlotTick {
    value: number;
    at: number;
    label: string;
}

/** Everything the drawing needs, worked out from the asset. */
export interface PlotGeometry {
    width: number;
    height: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    /** The plot's own edges inside the drawing, in px. */
    left: number;
    right: number;
    top: number;
    bottom: number;
    series: PlotSeries[];
    xTicks: PlotTick[];
    yTicks: PlotTick[];
    xLabel: string | null;
    yLabel: string | null;
}

/** The three names a point can answer with. */
export interface PointText {
    /** The most specific name for what the reader is pointing at. */
    title: string;
    /** The line under it: the coordinates, and the series when the title is a point's own name. */
    value: string;
    /** One line for a screen reader, which never sees the tooltip. */
    label: string;
}

/** What the marker is pointing at: where it is, and what the curve reads there. */
export interface MarkerReading {
    /** The x the marker holds, in the axes' own numbers. */
    x: number;
    /** The curve's value there: a reading's own y, or the interpolation between two of them. */
    y: number;
    /** The nearest reading's own name, or the series' when it has none. */
    title: string;
    /** The y in its axis' own words: `mmHg 138.5`, or `y 3` with no axis name. */
    value: string;
    /** One line for a screen reader, which never sees the readout. */
    label: string;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Float dust removed: `i * 0.1` reads as `0.3`, not `0.30000000000000004`. */
function roundTick(value: number): number {
    return Number(value.toPrecision(12));
}

/** The width the host actually offers, from whichever measurement it answers. */
function readWidth(element: HTMLElement): number {
    const client = typeof element.clientWidth === 'number' && Number.isFinite(element.clientWidth) ? element.clientWidth : 0;
    if (client > 0) return client;
    if (typeof element.getBoundingClientRect === 'function') {
        const width = element.getBoundingClientRect().width;
        if (Number.isFinite(width) && width > 0) return width;
    }
    const offset = typeof element.offsetWidth === 'number' && Number.isFinite(element.offsetWidth) ? element.offsetWidth : 0;
    return offset > 0 ? offset : 0;
}

/**
 * Whether the host lets things move.
 *
 * Two cases are a plain no: `prefers-reduced-motion: reduce`, and a host with no
 * `matchMedia` at all (the tests' own world, and any host that never answers).
 * The second must be a return, never a throw — the guard is the only thing
 * standing between a missing browser API and a drawing that never appears.
 */
export function motionAllowed(): boolean {
    try {
        if (typeof matchMedia !== 'function') return false;
        const query = matchMedia('(prefers-reduced-motion: reduce)');
        return !!query && query.matches !== true;
    } catch {
        return false;
    }
}

/** The tone as a class, so the stylesheet decides what a colour means. */
export function toneClass(tone: GraphTone | undefined): string {
    if (tone === 'accent') return 'is-accent';
    if (tone === 'muted') return 'is-muted';
    return 'is-primary';
}

/**
 * The window the plot shows: the asset's declared bounds where it gave them,
 * computed from the points where it did not, and never a zero-width window
 * (a single value gets a unit of room either side, so its dot sits in the
 * middle of the axis rather than on a division by zero).
 */
export function graphBounds(graph: StudyGraph): { xMin: number; xMax: number; yMin: number; yMax: number } {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const series of graph.series) {
        for (const point of series.points) {
            if (Number.isFinite(point.x)) xs.push(point.x);
            if (Number.isFinite(point.y)) ys.push(point.y);
        }
    }
    const declared = (value: number | undefined, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;

    const window = (min: number, max: number): { min: number; max: number } => {
        let low = min;
        let high = max;
        if (high < low) {
            const swap = low;
            low = high;
            high = swap;
        }
        if (high === low) {
            low -= 1;
            high += 1;
        }
        return { min: low, max: high };
    };

    const xWindow = window(declared(graph.xMin, xs.length > 0 ? Math.min(...xs) : 0), declared(graph.xMax, xs.length > 0 ? Math.max(...xs) : 1));
    const yWindow = window(declared(graph.yMin, ys.length > 0 ? Math.min(...ys) : 0), declared(graph.yMax, ys.length > 0 ? Math.max(...ys) : 1));
    return { xMin: xWindow.min, xMax: xWindow.max, yMin: yWindow.min, yMax: yWindow.max };
}

/** The height the drawing takes at this width. */
export function plotHeight(width: number): number {
    return clamp(Math.round(width * 0.55), GRAPH_MIN_HEIGHT, GRAPH_MAX_HEIGHT);
}

/** A step a reader can divide by eye: 1, 2 or 5 times a power of ten. */
export function niceStep(span: number, count = TARGET_TICKS): number {
    if (!Number.isFinite(span) || span <= 0) return 0;
    const rough = span / Math.max(1, count);
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    if (!Number.isFinite(power) || power <= 0) return 0;
    // The comparisons carry a hair of tolerance: floating-point dust in
    // `rough / power` must not turn a step of 2 into a step of 5.
    const fraction = rough / power;
    const nice = fraction <= 1.000000001 ? 1 : fraction <= 2.000000001 ? 2 : fraction <= 5.000000001 ? 5 : 10;
    return nice * power;
}

/** How a tick reads, given the step between ticks. */
export function formatAxisTick(value: number, step: number): string {
    const places = step >= 1 || step <= 0 ? 0 : Math.min(4, Math.ceil(Math.abs(Math.log10(step))));
    return formatNumber(value, places);
}

/**
 * The marks on an axis: both ends of the window always, plus the whole steps
 * between them. A step that would ask for an unreasonable number of marks is
 * dropped and the axis keeps its ends.
 */
export function tickValues(min: number, max: number, count = TARGET_TICKS): number[] {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
    const step = niceStep(max - min, count);
    const ticks: number[] = [min];
    if (step > 0) {
        const first = Math.ceil(min / step);
        const last = Math.floor(max / step);
        if (Number.isFinite(first) && Number.isFinite(last) && last - first <= 64) {
            for (let index = first; index <= last; index += 1) {
                const value = roundTick(index * step);
                if (value > min && value < max) ticks.push(value);
            }
        }
    }
    ticks.push(max);
    return ticks
        .filter(value => Number.isFinite(value))
        .sort((left, right) => left - right)
        .filter((value, index, all) => index === 0 || value !== all[index - 1]);
}

/**
 * The whole drawing, worked out from the asset: the window, the plot's edges,
 * every datum at its place, and the marks on both axes.
 */
export function plotGeometry(graph: StudyGraph, width: number): PlotGeometry {
    const drawingWidth = Math.round(clamp(Number.isFinite(width) && width > 0 ? width : GRAPH_FALLBACK_WIDTH, GRAPH_MIN_WIDTH, GRAPH_MAX_WIDTH));
    const height = plotHeight(drawingWidth);
    const bounds = graphBounds(graph);

    const left = GRAPH_PADDING.left;
    const right = drawingWidth - GRAPH_PADDING.right;
    const top = GRAPH_PADDING.top;
    const bottom = height - GRAPH_PADDING.bottom;
    const plotWidth = Math.max(1, right - left);
    const plotHeightPx = Math.max(1, bottom - top);

    const xSpan = bounds.xMax - bounds.xMin;
    const ySpan = bounds.yMax - bounds.yMin;
    const placeX = (x: number): number => left + ((clamp(x, bounds.xMin, bounds.xMax) - bounds.xMin) / xSpan) * plotWidth;
    const placeY = (y: number): number => bottom - ((clamp(y, bounds.yMin, bounds.yMax) - bounds.yMin) / ySpan) * plotHeightPx;

    const series: PlotSeries[] = graph.series.map(source => ({
        id: source.id,
        label: source.label,
        tone: source.tone ?? 'primary',
        points: source.points.map(point => {
            const placed: PlotPoint = { x: point.x, y: point.y, cx: round2(placeX(point.x)), cy: round2(placeY(point.y)) };
            if (point.label) placed.label = point.label;
            return placed;
        }),
    }));

    const xStep = niceStep(xSpan);
    const yStep = niceStep(ySpan);
    const xTicks = tickValues(bounds.xMin, bounds.xMax).map(value => ({ value, at: round2(placeX(value)), label: formatAxisTick(value, xStep) }));
    const yTicks = tickValues(bounds.yMin, bounds.yMax).map(value => ({ value, at: round2(placeY(value)), label: formatAxisTick(value, yStep) }));

    return {
        width: drawingWidth,
        height,
        xMin: bounds.xMin,
        xMax: bounds.xMax,
        yMin: bounds.yMin,
        yMax: bounds.yMax,
        left,
        right,
        top,
        bottom,
        series,
        xTicks,
        yTicks,
        xLabel: graph.xLabel ?? null,
        yLabel: graph.yLabel ?? null,
    };
}

/**
 * Where any value sits in a drawn plot — the same mapping the geometry used for
 * the readings, so a marker placed by it can never disagree with the dots.
 */
export function placeInPlot(geometry: PlotGeometry, x: number, y: number): { cx: number; cy: number } {
    const xSpan = Math.max(Number.EPSILON, geometry.xMax - geometry.xMin);
    const ySpan = Math.max(Number.EPSILON, geometry.yMax - geometry.yMin);
    const plotWidth = Math.max(1, geometry.right - geometry.left);
    const plotHeightPx = Math.max(1, geometry.bottom - geometry.top);
    return {
        cx: round2(geometry.left + ((clamp(x, geometry.xMin, geometry.xMax) - geometry.xMin) / xSpan) * plotWidth),
        cy: round2(geometry.bottom - ((clamp(y, geometry.yMin, geometry.yMax) - geometry.yMin) / ySpan) * plotHeightPx),
    };
}

/** The readings in the order they are read: left to right. */
export function orderedReadings<T extends { x: number }>(points: T[]): T[] {
    return [...points].sort((left, right) => left.x - right.x);
}

/**
 * What a series is worth at any x: linear between the readings either side of
 * it, and the end value beyond them. `null` only when the series has nothing to
 * read at all.
 */
export function interpolateSeriesY(points: { x: number; y: number }[], x: number): number | null {
    if (points.length === 0) return null;
    if (!Number.isFinite(x)) return null;
    const readings = orderedReadings(points);
    const first = readings[0];
    const last = readings[readings.length - 1];
    if (x <= first.x) return first.y;
    if (x >= last.x) return last.y;
    for (let index = 1; index < readings.length; index += 1) {
        const before = readings[index - 1];
        const after = readings[index];
        if (x <= after.x) {
            const span = after.x - before.x;
            if (span <= 0) return after.y;
            return before.y + ((x - before.x) / span) * (after.y - before.y);
        }
    }
    return last.y;
}

/** The reading closest to an x; the earlier one wins a tie, so the answer is stable. */
export function nearestReading<T extends { x: number }>(points: T[], x: number): T | null {
    if (points.length === 0 || !Number.isFinite(x)) return null;
    let best = points[0];
    let bestDistance = Math.abs(best.x - x);
    for (const point of points) {
        const distance = Math.abs(point.x - x);
        if (distance < bestDistance) {
            best = point;
            bestDistance = distance;
        }
    }
    return best;
}

/** The x of the reading closest to an x: what the marker snaps to. */
export function snapToReading(points: { x: number }[], x: number): number {
    const nearest = nearestReading(points, x);
    return nearest ? nearest.x : x;
}

/** How long a polyline is, so the stylesheet can draw it in: the sum of its segments. */
export function polylineLength(points: PlotPoint[]): number {
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
        total += Math.hypot(points[index].cx - points[index - 1].cx, points[index].cy - points[index - 1].cy);
    }
    return Math.ceil(total);
}

/**
 * What the marker says where it is: the curve's value at its x (interpolated
 * between the two nearest readings), named by the reading it is nearest, in the
 * y axis' own words. `null` for a series with nothing to read.
 */
export function markerReading(series: PlotSeries, x: number, yLabel?: string | null): MarkerReading | null {
    const y = interpolateSeriesY(series.points, x);
    if (y === null) return null;
    const nearest = nearestReading(series.points, x);
    const title = nearest && nearest.label ? nearest.label : series.label;
    const value = yLabel ? `${yLabel} ${formatNumber(y)}` : `y ${formatNumber(y)}`;
    const label = title === series.label ? `${series.label}: ${value}` : `${series.label}: ${title} · ${value}`;
    return { x, y, title, value, label };
}

/**
 * What one point says: its own name when the asset gave it one, otherwise the
 * series it belongs to, over a line of coordinates read in the axes' own words.
 */
export function describePoint(graph: StudyGraph, series: StudyGraphSeries | PlotSeries, point: StudyGraphPoint | PlotPoint): PointText {
    const x = graph.xLabel ? `${graph.xLabel} ${formatNumber(point.x)}` : `x ${formatNumber(point.x)}`;
    const y = graph.yLabel ? `${graph.yLabel} ${formatNumber(point.y)}` : `y ${formatNumber(point.y)}`;
    const coordinates = `${x}, ${y}`;
    // A point's own name is the most specific answer; the series names it otherwise.
    const own = point.label;
    if (own) return { title: own, value: `${series.label} · ${coordinates}`, label: `${series.label}: ${own} · ${coordinates}` };
    return { title: series.label, value: coordinates, label: `${series.label}: ${coordinates}` };
}

interface Binding {
    el: Element;
    type: string;
    handler: EventListener;
}

/**
 * The graph, mounted into a host of any width.
 *
 * The view owns one element of its own and everything inside it, so a teardown
 * takes the drawing, the tooltip, the marker and every listener with it and
 * leaves the host exactly as it was found.
 */
export class StudyVisualGraphView {
    private root: HTMLElement | null = null;
    private box: HTMLElement | null = null;
    private plot: HTMLElement | null = null;
    private svg: SVGSVGElement | null = null;
    private tip: HTMLElement | null = null;
    private tipTitle: HTMLElement | null = null;
    private tipValue: HTMLElement | null = null;
    private readout: HTMLElement | null = null;
    private readoutTitle: HTMLElement | null = null;
    private readoutValue: HTMLElement | null = null;
    private marker: SVGGElement | null = null;
    private markerLine: SVGLineElement | null = null;
    private markerDot: SVGCircleElement | null = null;
    private graph: StudyGraph | null = null;
    /** The geometry the current drawing was made with, so the marker reads the same axes. */
    private geometry: PlotGeometry | null = null;
    /** Where the marker's x sits in the data: the one thing it remembers across a redraw. */
    private markerX: number | null = null;
    private dragging = false;
    /** The width the current drawing was made for, so a resize only redraws when it matters. */
    private width = 0;
    private activePoint: SVGGElement | null = null;
    private bindings: Binding[] = [];
    private observer: ResizeObserver | null = null;

    mount(container: HTMLElement, graph: StudyGraph): () => void {
        this.unmount();
        this.graph = graph;

        const root = container.createDiv('sf-graph');
        this.root = root;
        // Movement is opt-in: a reader who asked for reduced motion gets the
        // curve already drawn, without it travelling there.
        if (motionAllowed()) root.addClass('is-motion');
        // The one thing the graph should make the reader see, as the lead-in.
        if (graph.teach) root.createDiv({ cls: 'sf-graph-teach', text: graph.teach });

        // The box is what scrolls when the host is very narrow; the plot inside
        // it is exactly as wide as the drawing, so the host is never widened.
        const box = root.createDiv('sf-graph-box');
        this.box = box;
        const plot = box.createDiv('sf-graph-plot');
        this.plot = plot;

        // The marker's answer is built first and kept across redraws: it belongs
        // to the plot, not to the drawing that happens to be in it.
        this.buildReadout(plot);
        this.draw(true);
        this.buildTip(plot);
        this.renderLegend(root, graph);
        if (graph.pearl) this.renderPearl(root, graph.pearl);
        this.watch();

        return () => this.unmount();
    }

    unmount(): void {
        this.observer?.disconnect();
        this.observer = null;
        this.clearBindings();
        this.hideTip();
        this.svg = null;
        this.plot = null;
        this.box = null;
        this.tip = null;
        this.tipTitle = null;
        this.tipValue = null;
        this.readout = null;
        this.readoutTitle = null;
        this.readoutValue = null;
        this.marker = null;
        this.markerLine = null;
        this.markerDot = null;
        this.geometry = null;
        this.markerX = null;
        this.dragging = false;
        this.graph = null;
        this.width = 0;
        this.root?.remove();
        this.root = null;
    }

    // ---------------------------------------------------------------- drawing

    private measure(): number {
        const box = this.box;
        const measured = box ? readWidth(box) : 0;
        const wanted = measured > 0 ? measured : GRAPH_FALLBACK_WIDTH;
        return Math.round(clamp(wanted, GRAPH_MIN_WIDTH, GRAPH_MAX_WIDTH));
    }

    /**
     * (Re)build the drawing at the current width. The tooltip and the readout
     * are kept; the marker comes back where the reader left it. `animate` is the
     * mounting draw's own request: only then does the curve draw itself in.
     */
    private draw(animate = false): void {
        const graph = this.graph;
        const plot = this.plot;
        if (!graph || !plot) return;

        this.clearBindings();
        this.hideTip();
        this.svg?.remove();
        this.svg = null;

        const width = this.measure();
        this.width = width;
        const geometry = plotGeometry(graph, width);
        this.geometry = geometry;

        const svg = plot.createSvg('svg', {
            cls: 'sf-graph-svg',
            attr: {
                viewBox: `0 0 ${geometry.width} ${geometry.height}`,
                width: String(geometry.width),
                height: String(geometry.height),
                role: 'group',
                'aria-label': graph.title,
            },
        });
        this.svg = svg;

        // The grid first, then the axes over it, then the data over both.
        for (const tick of geometry.yTicks) {
            this.shape(svg, 'line', 'sf-graph-grid', {
                x1: String(geometry.left),
                y1: String(tick.at),
                x2: String(geometry.right),
                y2: String(tick.at),
            });
        }
        this.shape(svg, 'line', 'sf-graph-axis', {
            x1: String(geometry.left),
            y1: String(geometry.top),
            x2: String(geometry.left),
            y2: String(geometry.bottom),
        });
        this.shape(svg, 'line', 'sf-graph-axis', {
            x1: String(geometry.left),
            y1: String(geometry.bottom),
            x2: String(geometry.right),
            y2: String(geometry.bottom),
        });

        for (const tick of geometry.xTicks) {
            this.shape(svg, 'line', 'sf-graph-tick', {
                x1: String(tick.at),
                y1: String(geometry.bottom),
                x2: String(tick.at),
                y2: String(geometry.bottom + 4),
            });
            this.tickLabel(svg, 'sf-graph-tick-label', tick.label, tick.at, geometry.bottom + 16, 'middle');
        }
        for (const tick of geometry.yTicks) {
            this.shape(svg, 'line', 'sf-graph-tick', {
                x1: String(geometry.left - 4),
                y1: String(tick.at),
                x2: String(geometry.left),
                y2: String(tick.at),
            });
            this.tickLabel(svg, 'sf-graph-tick-label', tick.label, geometry.left - 8, tick.at + 4, 'end');
        }

        if (geometry.xLabel) this.tickLabel(svg, 'sf-graph-axis-label', geometry.xLabel, (geometry.left + geometry.right) / 2, geometry.height - 6, 'middle');
        if (geometry.yLabel) {
            const middle = (geometry.top + geometry.bottom) / 2;
            const label = this.tickLabel(svg, 'sf-graph-axis-label', geometry.yLabel, 12, middle, 'middle');
            label.setAttribute('transform', `rotate(-90 12 ${round2(middle)})`);
        }

        for (const series of geometry.series) {
            const group = this.shape(svg, 'g', `sf-graph-series ${toneClass(series.tone)}`, {
                'data-series-id': series.id,
                'data-tone': series.tone,
            });
            // One datum is a dot, not a line: a polyline of one coordinate draws nothing.
            if (series.points.length >= 2) {
                const line = this.shape(group, 'polyline', 'sf-graph-line', {
                    points: series.points.map(point => `${point.cx},${point.cy}`).join(' '),
                    fill: 'none',
                });
                this.dressLine(line, series, animate);
            }
            for (const point of series.points) this.renderPoint(group, graph, series, point);
        }

        this.renderMarker(svg, geometry);
        this.bindDrag(plot);
    }

    /**
     * The polyline's own dressing: its length, handed to the stylesheet as a
     * custom property so the stylesheet can draw it in, and — on the mounting
     * draw only — the class that starts that draw-in. A re-measure is not a
     * fresh arrival, so a resize redraws the curve without replaying it.
     */
    private dressLine(line: SVGPolylineElement, series: PlotSeries, animate: boolean): void {
        line.setCssProps({ '--sf-graph-line-length': String(polylineLength(series.points)) });
        if (animate) line.addClass('is-draw-in');
    }

    /** One svg element, with its class and attributes, on the element it belongs to. */
    private shape<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, cls: string, attrs: Record<string, string>): SVGElementTagNameMap[K] {
        return parent.createSvg(tag, { cls, attr: attrs });
    }

    private tickLabel(parent: Element, cls: string, text: string, x: number, y: number, anchor: string): SVGTextElement {
        const element = this.shape(parent, 'text', cls, { x: String(round2(x)), y: String(round2(y)), 'text-anchor': anchor });
        element.textContent = text;
        return element;
    }

    /** One datum: a visible dot, a generous target, and its own words. */
    private renderPoint(parent: Element, graph: StudyGraph, series: PlotSeries, point: PlotPoint): void {
        const text = describePoint(graph, series, point);
        const group = this.shape(parent, 'g', 'sf-graph-point', {
            tabindex: '0',
            role: 'img',
            'aria-label': text.label,
            'data-x': String(point.x),
            'data-y': String(point.y),
        });
        this.shape(group, 'circle', 'sf-graph-point-hit', {
            cx: String(point.cx),
            cy: String(point.cy),
            r: String(HIT_RADIUS),
            fill: 'transparent',
        });
        this.shape(group, 'circle', 'sf-graph-point-dot', {
            cx: String(point.cx),
            cy: String(point.cy),
            r: String(POINT_RADIUS),
        });

        // Hover and focus say the same thing, so a reader without a mouse gets
        // the same answer; a tap on a touch screen counts as asking too.
        const show = (): void => this.showTip(text, group, point);
        const hide = (): void => this.hideTip();
        this.bind(group, 'mouseenter', show);
        this.bind(group, 'mouseleave', hide);
        this.bind(group, 'focus', show);
        this.bind(group, 'blur', hide);
        this.bind(group, 'click', show);
    }

    // --------------------------------------------------------------- marker

    /**
     * The marker: a line at its x, a dot on the curve, and a readout that
     * answers wherever it is. It starts on the first reading of the series the
     * graph leads with, and keeps its x across a redraw.
     */
    private renderMarker(svg: SVGSVGElement, geometry: PlotGeometry): void {
        const series = geometry.series[0];
        if (!series || series.points.length === 0) return;
        // The marker starts on the first reading of the series the graph leads
        // with, and a redraw puts it back where the reader left it.
        if (this.markerX === null) this.markerX = series.points[0].x;
        const group = this.shape(svg, 'g', 'sf-graph-marker', {
            tabindex: '0',
            role: 'slider',
            'aria-label': `Read a value from ${series.label}`,
            'aria-valuemin': formatNumber(geometry.xMin),
            'aria-valuemax': formatNumber(geometry.xMax),
        });
        this.marker = group;
        this.markerLine = this.shape(group, 'line', 'sf-graph-marker-line', {
            x1: '0',
            y1: String(geometry.top),
            x2: '0',
            y2: String(geometry.bottom),
        });
        this.markerDot = this.shape(group, 'circle', 'sf-graph-marker-dot', {
            cx: '0',
            cy: String(geometry.bottom),
            r: String(MARKER_RADIUS),
        });
        // The keyboard path is bound to the marker itself, so it walks the
        // readings from wherever the reader's focus already is.
        this.bind(group, 'keydown', event => this.onMarkerKey(event));
        this.placeMarker();
    }

    /**
     * Put the marker where its x says, and read the curve there: the dot on the
     * curve's own value, the backdrop line at its x, and a readout with the
     * value, its axis' unit and the nearest reading's name.
     */
    private placeMarker(): void {
        const geometry = this.geometry;
        const graph = this.graph;
        const series = geometry ? geometry.series[0] : null;
        if (!geometry || !graph || !series || !this.marker || this.markerX === null) return;
        const reading = markerReading(series, this.markerX, graph.yLabel);
        if (!reading) return;
        const at = placeInPlot(geometry, reading.x, reading.y);
        this.markerLine?.setAttribute('x1', String(at.cx));
        this.markerLine?.setAttribute('x2', String(at.cx));
        this.markerDot?.setAttribute('cx', String(at.cx));
        this.markerDot?.setAttribute('cy', String(at.cy));
        this.marker.setAttribute('aria-valuenow', formatNumber(reading.x));
        this.marker.setAttribute('aria-valuetext', reading.label);
        this.showReadout(reading, at);
    }

    private buildReadout(plot: HTMLElement): void {
        const readout = plot.createDiv('sf-graph-marker-readout is-hidden');
        this.readout = readout;
        this.readoutTitle = readout.createDiv('sf-graph-marker-title');
        this.readoutValue = readout.createDiv('sf-graph-marker-value');
    }

    private showReadout(reading: MarkerReading, at: { cx: number; cy: number }): void {
        const readout = this.readout;
        if (!readout) return;
        this.readoutTitle?.setText(reading.title);
        this.readoutValue?.setText(reading.value);
        readout.removeClass('is-hidden');
        // A marker near the top of the drawing has no room for its readout
        // above it, so that one hangs below instead of being clipped.
        readout.toggleClass('is-below', at.cy < TIP_ROOM);
        // Positioned through custom properties, so the stylesheet owns the look.
        readout.setCssProps({ '--sf-graph-marker-x': `${at.cx}px`, '--sf-graph-marker-y': `${at.cy}px` });
    }

    /**
     * Put the marker at a data x.
     *
     * The x is held inside the series' own extent, so the marker stops at the
     * first and last readings rather than leaving the curve. By default it is
     * also snapped to the nearest reading — a reader asking for a value gets one
     * the graph really carries — while `snap: false` keeps the exact x, and the
     * readout then answers with the interpolation between the readings either
     * side. That is what the drag does: the marker follows the pointer, and the
     * numbers it reports are read off the curve between the dots.
     */
    moveMarkerTo(x: number, snap = true): void {
        const geometry = this.geometry;
        const series = geometry ? geometry.series[0] : null;
        if (!geometry || !series || series.points.length === 0 || !Number.isFinite(x)) return;
        const readings = orderedReadings(series.points);
        const held = clamp(x, readings[0].x, readings[readings.length - 1].x);
        this.markerX = snap ? snapToReading(readings, held) : held;
        this.placeMarker();
    }

    /**
     * Move the marker one reading along the curve — the arrow keys' own step.
     * At either end it stays where it is: there is nothing further to read.
     */
    stepMarker(direction: number): void {
        const geometry = this.geometry;
        const series = geometry ? geometry.series[0] : null;
        if (!series || series.points.length === 0 || this.markerX === null) return;
        const readings = orderedReadings(series.points);
        const current = nearestReading(readings, this.markerX);
        if (!current) return;
        const next = readings[readings.indexOf(current) + (direction < 0 ? -1 : 1)];
        if (!next) return;
        this.moveMarkerTo(next.x);
    }

    /** The keyboard path: the arrows walk the readings, and Home and End take the ends. */
    private onMarkerKey(event: Event): void {
        const key = (event as KeyboardEvent).key;
        const geometry = this.geometry;
        const series = geometry ? geometry.series[0] : null;
        if (!series || series.points.length === 0) return;
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            event.preventDefault();
            this.stepMarker(key === 'ArrowLeft' ? -1 : 1);
            return;
        }
        if (key === 'Home' || key === 'End') {
            event.preventDefault();
            const readings = orderedReadings(series.points);
            const end = key === 'Home' ? readings[0] : readings[readings.length - 1];
            this.moveMarkerTo(end.x);
        }
    }

    // ---------------------------------------------------------------- drag

    /** The data x under a pointer: the plot's own rectangle, mapped to the axes. */
    private xFromPointer(clientX: number): number | null {
        const plot = this.plot;
        const geometry = this.geometry;
        if (!plot || !geometry || !Number.isFinite(clientX)) return null;
        let origin = 0;
        let width = geometry.width;
        if (typeof plot.getBoundingClientRect === 'function') {
            const rect = plot.getBoundingClientRect();
            if (rect && Number.isFinite(rect.left) && Number.isFinite(rect.width) && rect.width > 0) {
                origin = rect.left;
                width = rect.width;
            }
        }
        const svgX = ((clientX - origin) / width) * geometry.width;
        const plotWidth = Math.max(1, geometry.right - geometry.left);
        return geometry.xMin + ((svgX - geometry.left) / plotWidth) * (geometry.xMax - geometry.xMin);
    }

    /** The plot is the drag surface: anywhere in it puts the marker under the pointer. */
    private bindDrag(plot: HTMLElement): void {
        this.bind(plot, 'pointerdown', event => this.beginDrag(event));
        this.bind(plot, 'pointermove', event => this.dragTo(event));
        this.bind(plot, 'pointerup', () => this.endDrag());
        this.bind(plot, 'pointercancel', () => this.endDrag());
    }

    private beginDrag(event: Event): void {
        const x = this.xFromPointer((event as PointerEvent).clientX);
        if (x === null) return;
        event.preventDefault();
        this.dragging = true;
        this.root?.addClass('is-dragging');
        const plot = this.plot;
        const pointerId = (event as PointerEvent).pointerId;
        if (plot && typeof pointerId === 'number' && typeof plot.setPointerCapture === 'function') {
            try {
                // Capture keeps the drag alive past the plot's own edge; a host
                // that has no pointer capture still drags while inside it.
                plot.setPointerCapture(pointerId);
            } catch {
                /* nothing to release then */
            }
        }
        this.moveMarkerTo(x, false);
    }

    private dragTo(event: Event): void {
        if (!this.dragging) return;
        const x = this.xFromPointer((event as PointerEvent).clientX);
        if (x === null) return;
        event.preventDefault();
        this.moveMarkerTo(x, false);
    }

    private endDrag(): void {
        this.dragging = false;
        this.root?.removeClass('is-dragging');
    }

    private buildTip(plot: HTMLElement): void {
        const tip = plot.createDiv('sf-graph-tip is-hidden');
        this.tip = tip;
        this.tipTitle = tip.createDiv('sf-graph-tip-title');
        this.tipValue = tip.createDiv('sf-graph-tip-value');
    }

    // --------------------------------------------------------------- tooltip

    private showTip(text: PointText, group: SVGGElement, point: PlotPoint): void {
        const tip = this.tip;
        if (!tip) return;
        this.tipTitle?.setText(text.title);
        this.tipValue?.setText(text.value);
        tip.removeClass('is-hidden');
        // A point near the top of the drawing has no room for a tooltip above
        // it, so the tip hangs below that one instead of being clipped.
        tip.toggleClass('is-below', point.cy < TIP_ROOM);
        // Positioned through custom properties, so the stylesheet owns the look.
        tip.setCssProps({ '--sf-graph-tip-x': `${point.cx}px`, '--sf-graph-tip-y': `${point.cy}px` });
        this.activePoint?.removeClass('is-active');
        this.activePoint = group;
        group.addClass('is-active');
    }

    private hideTip(): void {
        this.tip?.addClass('is-hidden');
        this.activePoint?.removeClass('is-active');
        this.activePoint = null;
    }

    // ---------------------------------------------------------------- legend

    private renderLegend(root: HTMLElement, graph: StudyGraph): void {
        const legend = root.createDiv('sf-graph-legend');
        for (const series of graph.series) {
            const item = legend.createDiv('sf-graph-legend-item');
            item.addClass(toneClass(series.tone));
            item.createSpan('sf-graph-legend-swatch');
            item.createSpan({ cls: 'sf-graph-legend-label', text: series.label });
        }
    }

    private renderPearl(parent: HTMLElement, pearl: string): void {
        const line = parent.createDiv('sf-graph-pearl');
        line.createSpan({ cls: 'sf-graph-pearl-tag', text: PEARL_TAG });
        line.createSpan({ cls: 'sf-graph-pearl-text', text: pearl });
    }

    // -------------------------------------------------------------- bindings

    private bind(el: Element, type: string, handler: (event: Event) => void): void {
        const listener = handler;
        el.addEventListener(type, listener);
        this.bindings.push({ el, type, handler: listener });
    }

    private clearBindings(): void {
        for (const binding of this.bindings) binding.el.removeEventListener(binding.type, binding.handler);
        this.bindings = [];
    }

    /** Re-measure on a host resize, redrawing only when the width really moved. */
    private watch(): void {
        const box = this.box;
        if (!box || typeof ResizeObserver === 'undefined') return;
        this.observer = new ResizeObserver(() => {
            if (!this.box) return;
            if (this.measure() !== this.width) this.draw();
        });
        this.observer.observe(box);
    }
}
