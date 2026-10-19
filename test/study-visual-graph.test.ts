/**
 * The graph, driven against the repo's mini-dom.
 *
 * What is pinned here is that the drawing is a drawing: one polyline per series
 * with one coordinate pair per datum, one dot per datum, axes that carry the
 * window the asset declared with marks at its ends, and a legend that names
 * each series in its own colour. The scale is checked as arithmetic
 * (`plotGeometry`) as well as through the DOM, so "the bounds were respected"
 * is a number and not an impression. Then the parts a reader operates: a point
 * answers on hover *and* on focus, is reachable by keyboard, and lets go on the
 * way out; a host too narrow for the plot scrolls its own box instead of
 * squeezing the axes or widening the panel; a resize redraws at the measured
 * width; and a teardown takes the drawing and every listener with it.
 *
 * Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { StudyGraph } from '../models/study-visuals';
import {
    GRAPH_MAX_WIDTH,
    GRAPH_MIN_WIDTH,
    GRAPH_PADDING,
    StudyVisualGraphView,
    describePoint,
    graphBounds,
    interpolateSeriesY,
    markerReading,
    motionAllowed,
    nearestReading,
    niceStep,
    orderedReadings,
    placeInPlot,
    plotGeometry,
    plotHeight,
    polylineLength,
    snapToReading,
    tickValues,
    toneClass,
} from '../ui/study-visual-graph';

const repoRoot = process.cwd();
const CSS_PATH = 'styles/study-visual-graph.css';
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

// The graph reaches for no document of its own, but every mini-dom suite
// installs the element and document globals the UI code works against.
installMiniDocument();

/** The width an unmeasured host falls back to, which the fixtures are drawn at. */
const DRAWN_WIDTH = 320;

/** The rule body for a selector, so the stylesheet can be asserted where it lands. */
function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at) + 1);
}

function close(actual: number, expected: number, what: string): void {
    assert.ok(Math.abs(actual - expected) < 0.01, `${what}: expected about ${expected}, got ${actual}`);
}

// ------------------------------------------------------------------- fixtures

function graphFixture(): StudyGraph {
    return {
        kind: 'graph',
        title: 'Pressure against time',
        teach: 'Every reading is one point; the line is the trend between them.',
        xLabel: 'hours',
        yLabel: 'mmHg',
        xMin: 0,
        xMax: 12,
        yMin: 0,
        yMax: 200,
        series: [
            {
                id: 'systolic',
                label: 'Systolic',
                tone: 'primary',
                points: [
                    { x: 0, y: 200, label: 'Crisis' },
                    { x: 4, y: 150 },
                    { x: 8, y: 130 },
                    { x: 12, y: 110 },
                ],
            },
            {
                id: 'diastolic',
                label: 'Diastolic',
                tone: 'accent',
                points: [
                    { x: 0, y: 80 },
                    { x: 4, y: 95 },
                    { x: 12, y: 70 },
                ],
            },
        ],
        pearl: 'Pressure falls as the drop takes hold.',
    };
}

/** A graph that declares its window and carries a reading outside it. */
function clampedFixture(): StudyGraph {
    return {
        kind: 'graph',
        title: 'Beyond the window',
        teach: '',
        xMin: 0,
        xMax: 10,
        yMin: 0,
        yMax: 10,
        series: [{ id: 'run', label: 'Run', points: [{ x: 2, y: 2 }, { x: 14, y: 12, label: 'Off the chart' }] }],
    };
}

// --------------------------------------------------------------------- setup

function host(): MiniElement {
    return new MiniElement('div');
}

function mountGraph(graph: StudyGraph, into: MiniElement = host()) {
    const view = new StudyVisualGraphView();
    const teardown = view.mount(into as unknown as HTMLElement, graph);
    return { view, into, teardown };
}

/** Give the box the width a host would, the way a laid-out box answers. */
function setBoxWidth(into: MiniElement, width: number): void {
    const box = into.byClass('sf-graph-box')[0];
    assert.ok(box, 'the graph has a scroll box');
    (box as unknown as { clientWidth: number }).clientWidth = width;
}

/**
 * A stand-in for the browser's `ResizeObserver`, so the graph's own re-measure
 * can be driven: the suite fires the callback the way a resize would.
 */
class FakeResizeObserver {
    static created: FakeResizeObserver[] = [];
    callback: () => void;
    observed: unknown[] = [];
    disconnected = false;

    constructor(callback: () => void) {
        this.callback = callback;
        FakeResizeObserver.created.push(this);
    }

    observe(target: unknown): void {
        this.observed.push(target);
    }

    unobserve(): void {
        /* the graph never unobserves individually */
    }

    disconnect(): void {
        this.disconnected = true;
        this.observed = [];
    }
}

function withResizeObserver<T>(run: () => T): T {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals.ResizeObserver;
    FakeResizeObserver.created = [];
    globals.ResizeObserver = FakeResizeObserver;
    try {
        return run();
    } finally {
        if (previous === undefined) delete globals.ResizeObserver;
        else globals.ResizeObserver = previous;
    }
}

// ================================================================ the geometry

test('the window is the asset’s own bounds when it declares them', () => {
    const graph = graphFixture();
    const bounds = graphBounds(graph);
    assert.deepEqual(bounds, { xMin: 0, xMax: 12, yMin: 0, yMax: 200 });

    const geometry = plotGeometry(graph, DRAWN_WIDTH);
    assert.equal(geometry.width, DRAWN_WIDTH);
    assert.equal(geometry.height, plotHeight(DRAWN_WIDTH));
    assert.equal(geometry.left, GRAPH_PADDING.left);
    assert.equal(geometry.right, DRAWN_WIDTH - GRAPH_PADDING.right);
    assert.equal(geometry.top, GRAPH_PADDING.top);
    assert.equal(geometry.bottom, geometry.height - GRAPH_PADDING.bottom);

    // The extremes land on the axes: x=0 on the y axis, x=12 on the right edge.
    const systolic = geometry.series[0];
    assert.equal(systolic.points[0].cx, geometry.left);
    assert.equal(systolic.points[3].cx, geometry.right);
    // y=200, the declared maximum, on the top edge.
    assert.equal(systolic.points[0].cy, geometry.top);
    // A datum in the middle is where its value says it is.
    close(systolic.points[1].cx, geometry.left + (1 / 3) * (geometry.right - geometry.left), 'x=4 at a third across');
    close(geometry.series[1].points[1].cy, geometry.bottom - (95 / 200) * (geometry.bottom - geometry.top), 'y=95 is 95/200 up');
});

test('without declared bounds the window is the points’ own extent', () => {
    const graph: StudyGraph = {
        kind: 'graph',
        title: 'Free scale',
        teach: '',
        series: [{ id: 'a', label: 'A', points: [{ x: 2, y: -3 }, { x: 8, y: 5 }] }],
    };
    assert.deepEqual(graphBounds(graph), { xMin: 2, xMax: 8, yMin: -3, yMax: 5 });
    const geometry = plotGeometry(graph, DRAWN_WIDTH);
    assert.equal(geometry.series[0].points[0].cx, geometry.left);
    assert.equal(geometry.series[0].points[1].cx, geometry.right);
    assert.equal(geometry.series[0].points[0].cy, geometry.bottom);
    assert.equal(geometry.series[0].points[1].cy, geometry.top);
    // No axis labels were declared, so none are invented.
    assert.equal(geometry.xLabel, null);
    assert.equal(geometry.yLabel, null);
});

test('a window with no width of its own opens up rather than dividing by zero', () => {
    const flat: StudyGraph = {
        kind: 'graph',
        title: 'One value',
        teach: '',
        series: [{ id: 'a', label: 'A', points: [{ x: 5, y: 0 }] }],
    };
    const bounds = graphBounds(flat);
    assert.deepEqual(bounds, { xMin: 4, xMax: 6, yMin: -1, yMax: 1 });
    const geometry = plotGeometry(flat, DRAWN_WIDTH);
    const only = geometry.series[0].points[0];
    assert.ok(Number.isFinite(only.cx) && Number.isFinite(only.cy), 'a single datum is drawn, not NaN');
    close(only.cx, (geometry.left + geometry.right) / 2, 'the lone point sits in the middle of the axis');
    close(only.cy, (geometry.top + geometry.bottom) / 2, 'and in the middle of the other one');
});

test('a mark is never invented outside the window: a point beyond it is drawn at the edge', () => {
    const graph = clampedFixture();
    const geometry = plotGeometry(graph, DRAWN_WIDTH);
    const outside = geometry.series[0].points[1];
    assert.equal(outside.cx, geometry.right, 'x=14 of a 0–10 window is drawn at the right edge');
    assert.equal(outside.cy, geometry.top);
    assert.equal(outside.x, 14, 'and its value is untouched, because the label has to tell the truth');
    assert.equal(outside.y, 12);
});

test('the marks on an axis are its ends plus whole steps a reader can divide by eye', () => {
    const geometry = plotGeometry(graphFixture(), DRAWN_WIDTH);
    assert.deepEqual(geometry.xTicks.map(tick => tick.value), [0, 5, 10, 12]);
    assert.deepEqual(geometry.yTicks.map(tick => tick.value), [0, 50, 100, 150, 200]);
    assert.deepEqual(geometry.xTicks.map(tick => tick.label), ['0', '5', '10', '12']);
    assert.deepEqual(geometry.yTicks.map(tick => tick.label), ['0', '50', '100', '150', '200']);
    // The window's ends are on the axes.
    assert.equal(geometry.xTicks[0].at, geometry.left);
    assert.equal(geometry.xTicks[geometry.xTicks.length - 1].at, geometry.right);
    assert.equal(geometry.yTicks[0].at, geometry.bottom);
    assert.equal(geometry.yTicks[geometry.yTicks.length - 1].at, geometry.top);

    // The step arithmetic on its own: 1, 2 or 5 times a power of ten.
    assert.equal(niceStep(10, 5), 2);
    assert.equal(niceStep(12, 5), 5);
    assert.equal(niceStep(1, 5), 0.2);
    assert.equal(niceStep(0, 5), 0, 'no span, no step');
    assert.deepEqual(tickValues(0, 1), [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1].map(value => Number(value.toPrecision(12))));
    assert.deepEqual(tickValues(5, 5), [], 'a window with no width has no marks');
});

test('a point is described in the axes’ own words, and named by its own label first', () => {
    const graph = graphFixture();
    assert.deepEqual(describePoint(graph, graph.series[0], graph.series[0].points[0]), {
        title: 'Crisis',
        value: 'Systolic · hours 0, mmHg 200',
        label: 'Systolic: Crisis · hours 0, mmHg 200',
    });
    assert.deepEqual(describePoint(graph, graph.series[0], graph.series[0].points[1]), {
        title: 'Systolic',
        value: 'hours 4, mmHg 150',
        label: 'Systolic: hours 4, mmHg 150',
    });

    // No axis labels: the fallback names the coordinates plainly.
    const bare = clampedFixture();
    assert.deepEqual(describePoint(bare, bare.series[0], { x: 2, y: 3 }), {
        title: 'Run',
        value: 'x 2, y 3',
        label: 'Run: x 2, y 3',
    });

    assert.equal(toneClass('accent'), 'is-accent');
    assert.equal(toneClass('muted'), 'is-muted');
    assert.equal(toneClass('primary'), 'is-primary');
    assert.equal(toneClass(undefined), 'is-primary', 'a series with no tone is the primary one');
});

// ============================================================ the drawing itself

test('the graph draws one polyline per series, one dot per datum, and a legend to name them', () => {
    const graph = graphFixture();
    const { into } = mountGraph(graph);
    const geometry = plotGeometry(graph, DRAWN_WIDTH);

    assert.equal(into.textOf('sf-graph-teach'), graph.teach);
    assert.equal(into.textOf('sf-graph-pearl-text'), graph.pearl);
    assert.equal(into.textOf('sf-graph-pearl-tag'), 'Pearl');

    const svg = into.byClass('sf-graph-svg')[0];
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.attrs.width, String(geometry.width));
    assert.equal(svg.attrs.height, String(geometry.height));
    assert.equal(svg.attrs.viewBox, `0 0 ${geometry.width} ${geometry.height}`);

    const series = into.byClass('sf-graph-series');
    assert.equal(series.length, graph.series.length, 'one group per series');
    assert.deepEqual(series.map(group => group.attrs['data-series-id']), ['systolic', 'diastolic']);
    assert.deepEqual(series.map(group => group.attrs['data-tone']), ['primary', 'accent']);
    assert.ok(series[0].hasClass('is-primary') && series[1].hasClass('is-accent'), 'each series carries its own tone');

    const lines = into.byClass('sf-graph-line');
    assert.equal(lines.length, 2, 'one line per series');
    assert.ok(lines.every(line => line.tag === 'polyline'));
    const coordinates = lines.map(line => line.attrs.points.split(' ').map(pair => pair.split(',')));
    assert.deepEqual(coordinates[0].length, graph.series[0].points.length, 'one coordinate pair per datum');
    assert.deepEqual(coordinates[1].length, graph.series[1].points.length);
    assert.deepEqual(coordinates[0][0], [String(geometry.series[0].points[0].cx), String(geometry.series[0].points[0].cy)]);
    assert.ok(coordinates.every(pairs => pairs.every(pair => pair.every(value => Number.isFinite(Number(value))))), 'every coordinate is a number');

    // One dot per datum, each with a target a finger can hit.
    assert.equal(into.byClass('sf-graph-point').length, 7);
    assert.equal(into.byClass('sf-graph-point-dot').length, 7);
    assert.equal(into.byClass('sf-graph-point-hit').length, 7);
    assert.deepEqual(into.byClass('sf-graph-point-dot')[0].attrs, {
        cx: String(geometry.series[0].points[0].cx),
        cy: String(geometry.series[0].points[0].cy),
        r: '4',
    });

    // The axes: two of them, plus a mark and a label per tick.
    assert.equal(into.byClass('sf-graph-axis').length, 2);
    assert.equal(into.byClass('sf-graph-tick').length, geometry.xTicks.length + geometry.yTicks.length);
    assert.deepEqual(
        into.byClass('sf-graph-tick-label').map(label => label.textContent),
        [...geometry.xTicks.map(tick => tick.label), ...geometry.yTicks.map(tick => tick.label)]
    );
    assert.equal(into.byClass('sf-graph-grid').length, geometry.yTicks.length, 'a grid line per y mark');

    // The axis names, with the y one turned to run up the side.
    const axisLabels = into.byClass('sf-graph-axis-label');
    assert.deepEqual(axisLabels.map(label => label.textContent), ['hours', 'mmHg']);
    assert.match(axisLabels[1].attrs.transform, /^rotate\(-90 /, 'the y axis name runs up the axis');

    const legend = into.byClass('sf-graph-legend-item');
    assert.equal(legend.length, 2);
    assert.deepEqual(legend.map(item => item.textOf('sf-graph-legend-label')), ['Systolic', 'Diastolic']);
    assert.equal(into.byClass('sf-graph-legend-swatch').length, 2);
    assert.ok(legend[1].hasClass('is-accent'), 'the legend swatch takes the series’ own colour');
});

test('a series with a single point is a dot, not a crash', () => {
    const solo: StudyGraph = {
        kind: 'graph',
        title: 'One reading',
        teach: '',
        series: [{ id: 'solo', label: 'Solo', points: [{ x: 4, y: 9, label: 'Only point' }] }],
    };
    const { into } = mountGraph(solo);

    assert.equal(into.byClass('sf-graph-series').length, 1);
    assert.equal(into.byClass('sf-graph-line').length, 0, 'one coordinate is not a line');
    assert.equal(into.byClass('sf-graph-point').length, 1);
    assert.equal(into.byClass('sf-graph-axis').length, 2, 'the axes are still drawn');
    assert.equal(into.byClass('sf-graph-legend-item').length, 1);
    assert.equal(into.byClass('sf-graph-pearl').length, 0, 'no pearl was declared, so none is invented');

    // The lone point answers like any other.
    const point = into.byClass('sf-graph-point')[0];
    point.dispatch('focus');
    assert.equal(into.byClass('sf-graph-tip')[0].hasClass('is-hidden'), false);
    assert.equal(into.textOf('sf-graph-tip-title'), 'Only point');
    assert.equal(into.textOf('sf-graph-tip-value'), 'Solo · x 4, y 9');
});

// ================================================================ the points

test('a point answers on hover and on focus, and lets go on the way out', () => {
    const graph = graphFixture();
    const { into } = mountGraph(graph);
    const geometry = plotGeometry(graph, DRAWN_WIDTH);
    const tip = into.byClass('sf-graph-tip')[0];
    assert.ok(tip, 'the graph carries a tooltip');
    assert.ok(tip.hasClass('is-hidden'), 'nothing is being pointed at to begin with');

    const points = into.byClass('sf-graph-point');
    const middle = points[1];
    assert.equal(middle.attrs.tabindex, '0', 'a point is reachable by keyboard');
    assert.equal(middle.attrs.role, 'img');
    assert.equal(middle.attrs['aria-label'], 'Systolic: hours 4, mmHg 150', 'a screen reader gets the point without the tooltip');

    middle.dispatch('mouseenter');
    assert.equal(tip.hasClass('is-hidden'), false, 'hovering reveals the label');
    assert.equal(into.textOf('sf-graph-tip-title'), 'Systolic');
    assert.equal(into.textOf('sf-graph-tip-value'), 'hours 4, mmHg 150');
    assert.equal(tip.style['--sf-graph-tip-x'], `${geometry.series[0].points[1].cx}px`, 'the tip is placed from the point’s own coordinates');
    assert.equal(tip.style['--sf-graph-tip-y'], `${geometry.series[0].points[1].cy}px`);
    assert.ok(middle.hasClass('is-active'), 'and the point says which one it is');

    middle.dispatch('mouseleave');
    assert.equal(tip.hasClass('is-hidden'), true, 'letting go takes the label away');
    assert.equal(middle.hasClass('is-active'), false);

    // The keyboard path says exactly the same thing.
    middle.dispatch('focus');
    assert.equal(tip.hasClass('is-hidden'), false);
    assert.equal(middle.hasClass('is-active'), true);
    middle.dispatch('blur');
    assert.equal(tip.hasClass('is-hidden'), true);

    // A tap counts as asking on a touch screen.
    middle.dispatch('click');
    assert.equal(tip.hasClass('is-hidden'), false);

    // A point with its own name is titled with it; the series still shows.
    const named = points[0];
    named.dispatch('mouseenter');
    assert.equal(into.textOf('sf-graph-tip-title'), 'Crisis');
    assert.equal(into.textOf('sf-graph-tip-value'), 'Systolic · hours 0, mmHg 200');
    assert.equal(tip.hasClass('is-below'), true, 'a point at the top has no room above it, so the tip hangs below');

    // The lowest reading has room above it.
    const lowest = points[6];
    lowest.dispatch('mouseenter');
    assert.equal(tip.hasClass('is-below'), false);
});

test('a point outside the declared window still reports its true value', () => {
    const graph = clampedFixture();
    const { into } = mountGraph(graph);
    const point = into.byClass('sf-graph-point')[1];
    point.dispatch('focus');
    assert.equal(into.textOf('sf-graph-tip-title'), 'Off the chart');
    assert.equal(into.textOf('sf-graph-tip-value'), 'Run · x 14, y 12');
    assert.equal(into.byClass('sf-graph-point-dot')[1].attrs.cx, String(plotGeometry(graph, DRAWN_WIDTH).right));
});

// ==================================================================== the host

test('the drawing has a floor width and the box scrolls instead of widening the host', () => {
    const css = read(CSS_PATH);
    assert.match(ruleBody(css, '.sf-graph-box'), /overflow:\s*(auto|scroll)/, 'a narrow host gets a scroll box');
    assert.match(ruleBody(css, '.sf-graph-box'), /max-width:\s*100%/);
    assert.match(ruleBody(css, '.sf-graph'), /min-width:\s*0/, 'the graph may be squeezed to its host');
    assert.match(ruleBody(css, '.sf-graph-plot'), /position:\s*relative/, 'the tip is placed inside the plot');

    const graph = graphFixture();
    assert.equal(plotGeometry(graph, 80).width, GRAPH_MIN_WIDTH, 'a very narrow host gets the floor, not a squeezed plot');
    assert.equal(plotGeometry(graph, 4000).width, GRAPH_MAX_WIDTH, 'and a very wide one gets the ceiling');

    const { into } = mountGraph(graph);
    setBoxWidth(into, 120);
    assert.equal(into.byClass('sf-graph-box')[0].clientWidth, 120);
    // The drawing itself is at the floor, so the box has something to scroll.
    const svg = into.byClass('sf-graph-svg')[0];
    assert.equal(Number(svg.attrs.width) >= GRAPH_MIN_WIDTH, true);
});

test('a resize re-measures the host and redraws at the new width', () => {
    withResizeObserver(() => {
        const graph = graphFixture();
        const { into, teardown } = mountGraph(graph);
        const observer = FakeResizeObserver.created[0];
        assert.ok(observer, 'the graph watches its box for a resize');
        assert.equal(observer.observed[0], into.byClass('sf-graph-box')[0], 'and it is the box it watches');

        setBoxWidth(into, 500);
        observer.callback();
        const redrawn = into.byClass('sf-graph-svg')[0];
        assert.equal(redrawn.attrs.width, '500', 'the drawing follows the host');

        const geometry = plotGeometry(graph, 500);
        assert.equal(into.byClass('sf-graph-point-dot')[1].attrs.cx, String(geometry.series[0].points[1].cx), 'and the data moves with it');
        assert.equal(into.byClass('sf-graph-svg').length, 1, 'one drawing, redrawn');
        assert.equal(into.byClass('sf-graph-tip').length, 1, 'the tooltip is kept, not rebuilt into a second one');

        // A resize that changes nothing does not redraw: the old node is still
        // the one on screen.
        const before = into.byClass('sf-graph-svg')[0];
        observer.callback();
        assert.equal(into.byClass('sf-graph-svg')[0], before);

        teardown();
        assert.equal(observer.disconnected, true, 'teardown stops watching the host');
        assert.doesNotThrow(() => observer.callback(), 'and a late callback is harmless');
    });
});

test('a host with no ResizeObserver at all still draws', () => {
    // The observation is guarded, so the drawing must appear with the global
    // absent — which is the state the harness itself runs in unless a test
    // installs a stand-in.
    const globals = globalThis as Record<string, unknown>;
    const previous = globals.ResizeObserver;
    delete globals.ResizeObserver;
    try {
        assert.equal(typeof (globalThis as Record<string, unknown>).ResizeObserver, 'undefined');
        const { into } = mountGraph(graphFixture());
        assert.equal(into.byClass('sf-graph-svg').length, 1);
        assert.equal(into.byClass('sf-graph-point').length, 7);
    } finally {
        if (previous !== undefined) globals.ResizeObserver = previous;
    }
});

// ------------------------------------------------------------------- teardown

test('mounting again replaces the drawing instead of stacking a second one', () => {
    const { view, into } = mountGraph(graphFixture());
    assert.equal(into.byClass('sf-graph').length, 1);
    view.mount(into as unknown as HTMLElement, clampedFixture());
    assert.equal(into.byClass('sf-graph').length, 1, 'one graph, redrawn');
    assert.equal(into.byClass('sf-graph-series').length, 1, 'holding the new material');
    assert.equal(into.byClass('sf-graph-series')[0].attrs['data-series-id'], 'run');
});

test('teardown removes the svg, the listeners, and everything else it added', () => {
    const into = host();
    into.createDiv('someone-elses-box');
    const { teardown } = mountGraph(graphFixture(), into);

    const point = into.byClass('sf-graph-point')[0];
    assert.equal(point.listenerCount('mouseenter'), 1, 'one handler while it is mounted');
    assert.equal(point.listenerCount('focus'), 1);
    assert.equal(point.listenerCount('mouseleave'), 1);
    const marker = into.byClass('sf-graph-marker')[0];
    assert.equal(marker.listenerCount('keydown'), 1, 'the marker can be walked by keyboard while it is mounted');
    const plot = into.byClass('sf-graph-plot')[0];
    assert.equal(plot.listenerCount('pointerdown'), 1, 'and dragged while it is mounted');

    teardown();
    assert.equal(point.listenerCount('mouseenter'), 0);
    assert.equal(point.listenerCount('focus'), 0);
    assert.equal(point.listenerCount('blur'), 0);
    assert.equal(marker.listenerCount('keydown'), 0, 'the marker takes its listeners with it');
    assert.equal(plot.listenerCount('pointerdown'), 0);
    assert.equal(into.byClass('sf-graph').length, 0);
    assert.equal(into.byClass('sf-graph-svg').length, 0, 'the drawing is gone');
    assert.equal(into.byClass('sf-graph-marker').length, 0, 'and the marker with it');
    assert.equal(into.byClass('sf-graph-marker-readout').length, 0, 'and the readout it wrote to');
    assert.equal(into.children.length, 1, 'only what was there before is left');
    assert.equal(into.byClass('someone-elses-box').length, 1);

    // The detached point is inert: nothing reacts to it any more.
    assert.doesNotThrow(() => point.dispatch('mouseenter'));
    assert.equal(into.byClass('sf-graph').length, 0);
});

// ------------------------------------------------------- the stylesheet's part

test('every class the graph renders has a rule in its stylesheet', () => {
    const source = read('ui/study-visual-graph.ts');
    const css = read(CSS_PATH);
    const tokens = new Set([...source.replace(/--sf-[a-z0-9-]+/g, ' ').matchAll(/sf-[a-z0-9-]+/g)].map(match => match[0]));

    const missing = [...tokens].filter(token => !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(tokens.size >= 20, `expected to find the graph's classes, found ${tokens.size}`);

    for (const state of ['is-primary', 'is-accent', 'is-muted', 'is-active', 'is-below', 'is-hidden']) {
        assert.ok(css.includes(`.${state}`), `no rule for ${state}`);
    }
});

test('a series’ colour is decided in one place and read everywhere it is drawn', () => {
    const css = read(CSS_PATH);
    for (const tone of ['primary', 'accent', 'muted']) {
        assert.ok(css.includes(`--sf-graph-tone`), 'the tone is a custom property');
        assert.match(ruleBody(css, `.sf-graph-series.is-${tone},\n.sf-graph-legend-item.is-${tone}`), /--sf-graph-tone:/, `no tone for ${tone}`);
    }
    assert.match(ruleBody(css, '.sf-graph-line'), /stroke:\s*var\(--sf-graph-tone/);
    assert.match(ruleBody(css, '.sf-graph-point-dot'), /fill:\s*var\(--sf-graph-tone/);
    assert.match(ruleBody(css, '.sf-graph-legend-swatch'), /background:\s*var\(--sf-graph-tone/);

    // The tooltip is placed from the custom properties the code writes and
    // never eats the pointer that revealed it.
    assert.match(ruleBody(css, '.sf-graph-tip'), /left:\s*var\(--sf-graph-tip-x/);
    assert.match(ruleBody(css, '.sf-graph-tip'), /top:\s*var\(--sf-graph-tip-y/);
    assert.match(ruleBody(css, '.sf-graph-tip'), /pointer-events:\s*none/);
    assert.match(ruleBody(css, '.sf-graph-tip.is-hidden'), /display:\s*none/);
    assert.match(ruleBody(css, '.sf-graph-tip.is-below'), /transform:/);

    const source = read('ui/study-visual-graph.ts');
    assert.match(source, /setCssProps\(\{ '--sf-graph-tip-x'/, 'the tip is placed through custom properties');
    assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(source), 'and never through an inline style assignment');
});

test('the graph’s stylesheet sizes text from the house scale', () => {
    const css = read(CSS_PATH);
    const sized = [...css.matchAll(/font-size:\s*([^;{}]+)/g)].map(match => match[1].trim());
    assert.ok(sized.length > 0, 'the stylesheet sizes text');
    assert.deepEqual(sized.filter(value => /\d(\.\d+)?(px|rem|pt)/.test(value)), [], 'every size comes from a --sf-font-* token');
    assert.match(ruleBody(css, '.sf-graph-tick-label'), /font-size:\s*var\(--sf-font-/, 'tick labels scale with the reader’s text too');
});

// ============================================================== the draw-in

/** Run with a stand-in `matchMedia`, so the motion guard can be driven both ways. */
function withMatchMedia<T>(matches: boolean, run: () => T): T {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals.matchMedia;
    globals.matchMedia = ((query: string) => ({ matches, media: query })) as unknown;
    try {
        return run();
    } finally {
        if (previous === undefined) delete globals.matchMedia;
        else globals.matchMedia = previous;
    }
}

/**
 * Deliver a pointer event to an element the way a browser would: the stand-in's
 * `dispatch` spreads whatever it is handed into the payload, so the pointer's
 * own `clientX` rides along with it.
 */
function pointer(el: MiniElement, type: string, clientX: number): void {
    el.dispatch(type, { clientX } as unknown as { key?: string; target?: unknown });
}

test('the curve carries the class that draws it in on the mounting draw, and only where motion is allowed', () => {
    const graph = graphFixture();
    const { into } = mountGraph(graph);
    const line = into.byClass('sf-graph-line')[0];
    assert.ok(line, 'the graph draws a curve');
    assert.equal(line.hasClass('is-draw-in'), true, 'the mounting draw asks the curve to draw itself in');

    // The length the dash is set from is the curve's own, so the draw-in starts
    // exactly one curve long — the test adds the segments up itself.
    const geometry = plotGeometry(graph, DRAWN_WIDTH);
    let total = 0;
    for (let index = 1; index < geometry.series[0].points.length; index += 1) {
        const from = geometry.series[0].points[index - 1];
        const to = geometry.series[0].points[index];
        total += Math.hypot(to.cx - from.cx, to.cy - from.cy);
    }
    assert.equal(line.style['--sf-graph-line-length'], String(Math.ceil(total)));
    assert.equal(polylineLength(geometry.series[1].points) > 0, true, 'every series gets its own length');

    // With no `matchMedia` at all there is no motion to allow, and nothing throws.
    assert.equal(motionAllowed(), false, 'a host with no matchMedia never animates');
    assert.equal(into.byClass('sf-graph')[0].hasClass('is-motion'), false);

    // A reader who asked for reduced motion gets the curve already drawn.
    withMatchMedia(true, () => {
        assert.equal(motionAllowed(), false);
        const reduced = mountGraph(graphFixture());
        assert.equal(reduced.into.byClass('sf-graph')[0].hasClass('is-motion'), false);
        assert.equal(reduced.into.byClass('sf-graph-line')[0].hasClass('is-draw-in'), true, 'the curve is still the curve');
        assert.equal(reduced.into.byClass('sf-graph-line')[0].style['--sf-graph-line-length'], String(Math.ceil(total)));
    });

    // A host that allows motion gets the class that starts the drawing.
    withMatchMedia(false, () => {
        assert.equal(motionAllowed(), true);
        const moving = mountGraph(graphFixture());
        assert.equal(moving.into.byClass('sf-graph')[0].hasClass('is-motion'), true);
        assert.equal(moving.into.byClass('sf-graph-line')[0].hasClass('is-draw-in'), true);
    });

    // A resize redraws the curve at the new width without replaying the draw-in:
    // a re-measure is not a fresh arrival.
    withResizeObserver(() => {
        const boxed = mountGraph(graphFixture());
        const observer = FakeResizeObserver.created[0];
        setBoxWidth(boxed.into, 500);
        observer.callback();
        const redrawn = boxed.into.byClass('sf-graph-line')[0];
        assert.equal(redrawn.attrs.points.split(' ').length, 4, 'the curve was redrawn');
        assert.equal(redrawn.hasClass('is-draw-in'), false, 'but it does not draw itself in again');
    });
});

// ================================================================ the marker

test('the marker starts on the first reading of the series the graph leads with', () => {
    const graph = graphFixture();
    const { into } = mountGraph(graph);
    const geometry = plotGeometry(graph, DRAWN_WIDTH);
    const first = geometry.series[0].points[0];

    const marker = into.byClass('sf-graph-marker')[0];
    assert.ok(marker, 'the graph carries a marker the reader can drag');
    assert.equal(marker.attrs.tabindex, '0', 'it is reachable by keyboard');
    assert.equal(marker.attrs.role, 'slider');
    assert.equal(marker.attrs['aria-valuemin'], '0');
    assert.equal(marker.attrs['aria-valuemax'], '12');
    assert.equal(marker.attrs['aria-valuenow'], '0', 'it starts on the first reading');
    assert.match(marker.attrs['aria-valuetext'], /mmHg 200/, 'and says what the curve reads there');

    assert.equal(into.byClass('sf-graph-marker-dot')[0].attrs.cx, String(first.cx));
    assert.equal(into.byClass('sf-graph-marker-dot')[0].attrs.cy, String(first.cy));
    const backdrop = into.byClass('sf-graph-marker-line')[0];
    assert.equal(backdrop.attrs.x1, String(first.cx));
    assert.equal(backdrop.attrs.x2, String(first.cx));
    assert.equal(backdrop.attrs.y1, String(geometry.top), 'the line spans the plot');
    assert.equal(backdrop.attrs.y2, String(geometry.bottom));

    // The readout answers from the first paint: it is the marker's voice, not a hover tip.
    const readout = into.byClass('sf-graph-marker-readout')[0];
    assert.ok(readout, 'the graph carries a readout');
    assert.equal(readout.hasClass('is-hidden'), false, 'and it is showing');
    assert.equal(into.textOf('sf-graph-marker-title'), 'Crisis', 'named by the reading it is nearest');
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 200');
    assert.equal(readout.style['--sf-graph-marker-x'], `${first.cx}px`);
    assert.equal(readout.style['--sf-graph-marker-y'], `${first.cy}px`);
});

test('the marker snaps to the nearest reading, or reads between two of them when told to', () => {
    const graph = graphFixture();
    const { view, into } = mountGraph(graph);
    const geometry = plotGeometry(graph, DRAWN_WIDTH);
    const marker = into.byClass('sf-graph-marker')[0];

    // 3.6 is nearest the reading at x = 4, which the curve says is 150.
    view.moveMarkerTo(3.6);
    assert.equal(marker.attrs['aria-valuenow'], '4', 'the marker snapped to the nearest reading');
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 150');
    assert.equal(into.textOf('sf-graph-marker-title'), 'Systolic');
    assert.equal(into.byClass('sf-graph-marker-line')[0].attrs.x1, String(geometry.series[0].points[1].cx));

    // Asked for the exact x, it stays there and reads the curve between the two
    // readings either side: halfway from 200 to 150 is 175.
    view.moveMarkerTo(2, false);
    assert.equal(marker.attrs['aria-valuenow'], '2');
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 175', 'the readout interpolates between the readings');
    const expectedCy = Math.round((geometry.bottom - (175 / 200) * (geometry.bottom - geometry.top)) * 100) / 100;
    assert.equal(into.byClass('sf-graph-marker-dot')[0].attrs.cy, String(expectedCy), 'and the dot sits on that value');

    // It cannot leave the curve: past either end is that end.
    view.moveMarkerTo(999, false);
    assert.equal(marker.attrs['aria-valuenow'], '12');
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 110');
    view.moveMarkerTo(-5);
    assert.equal(marker.attrs['aria-valuenow'], '0');
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 200');

    // A readout of a series with no y axis named still reads plainly.
    const bare = clampedFixture();
    const { view: bareView, into: bareInto } = mountGraph(bare);
    bareView.moveMarkerTo(2, false);
    assert.equal(bareInto.textOf('sf-graph-marker-value'), 'y 2');
});

test('the arrow keys walk the marker from reading to reading, and the ends hold', () => {
    const { into } = mountGraph(graphFixture());
    const marker = into.byClass('sf-graph-marker')[0];
    const press = (key: string): boolean => {
        let prevented = false;
        marker.dispatch('keydown', { key, preventDefault: () => { prevented = true; } });
        return prevented;
    };

    assert.equal(press('ArrowRight'), true, 'a key the marker uses says so');
    assert.equal(marker.attrs['aria-valuenow'], '4');
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 150');

    press('ArrowRight');
    assert.equal(marker.attrs['aria-valuenow'], '8');
    assert.equal(into.textOf('sf-graph-marker-title'), 'Systolic');

    press('ArrowRight');
    assert.equal(marker.attrs['aria-valuenow'], '12', 'the last reading');
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 110');
    assert.equal(press('ArrowRight'), true, 'still handled at the end');
    assert.equal(marker.attrs['aria-valuenow'], '12', 'a marker on the last reading stops there');

    assert.equal(press('ArrowLeft'), true);
    assert.equal(marker.attrs['aria-valuenow'], '8');
    assert.equal(press('End'), true);
    assert.equal(marker.attrs['aria-valuenow'], '12');
    assert.equal(press('Home'), true);
    assert.equal(marker.attrs['aria-valuenow'], '0');
    press('ArrowLeft');
    assert.equal(marker.attrs['aria-valuenow'], '0', 'and the first reading is the other end');

    assert.equal(press('a'), false, 'a key it does not use is left to the app');
    assert.equal(marker.attrs['aria-valuenow'], '0');
    assert.equal(into.byClass('sf-graph-tip')[0].hasClass('is-hidden'), true, 'none of that revealed the point tooltip');
});

test('the marker is dragged along the plot with the pointer', () => {
    const graph = graphFixture();
    const { into } = mountGraph(graph);
    const geometry = plotGeometry(graph, DRAWN_WIDTH);
    const plot = into.byClass('sf-graph-plot')[0];
    // The plot measures itself the way a laid-out box does; the pointer's x is
    // then read in the axes' own numbers.
    (plot as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        width: geometry.width,
        height: geometry.height,
        right: geometry.width,
        bottom: geometry.height,
        x: 0,
        y: 0,
    });
    const at = (x: number): number => geometry.left + ((x - geometry.xMin) / (geometry.xMax - geometry.xMin)) * (geometry.right - geometry.left);
    const marker = into.byClass('sf-graph-marker')[0];

    pointer(plot, 'pointerdown', at(1.5));
    assert.equal(marker.attrs['aria-valuenow'], '1.5', 'the drag follows the pointer, and keeps the x it was given');
    assert.equal(into.byClass('sf-graph')[0].hasClass('is-dragging'), true, 'and the graph says it is being dragged');
    // 200 at x = 0 and 150 at x = 4: x = 1.5 is 181.25.
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 181.25');

    pointer(plot, 'pointermove', at(12));
    assert.equal(marker.attrs['aria-valuenow'], '12');
    assert.equal(into.textOf('sf-graph-marker-value'), 'mmHg 110');

    pointer(plot, 'pointerup', at(12));
    assert.equal(into.byClass('sf-graph')[0].hasClass('is-dragging'), false);
    pointer(plot, 'pointermove', at(0));
    assert.equal(marker.attrs['aria-valuenow'], '12', 'the drag let go: the marker stays where it was left');
});

test('the curve and the marker survive a redraw, with the marker where the reader left it', () => {
    withResizeObserver(() => {
        const graph = graphFixture();
        const { view, into } = mountGraph(graph);
        view.moveMarkerTo(8);
        const observer = FakeResizeObserver.created[0];

        setBoxWidth(into, 500);
        observer.callback();
        const geometry = plotGeometry(graph, 500);
        assert.equal(into.byClass('sf-graph-marker').length, 1, 'one marker after the redraw, not two');
        assert.equal(into.byClass('sf-graph-marker-readout').length, 1, 'and one readout');
        assert.equal(into.byClass('sf-graph-marker-readout')[0].hasClass('is-hidden'), false);
        const marker = into.byClass('sf-graph-marker')[0];
        assert.equal(marker.attrs['aria-valuenow'], '8', 'the marker is where the reader left it');
        assert.equal(into.byClass('sf-graph-marker-line')[0].attrs.x1, String(geometry.series[0].points[2].cx), 'and reads the axes it was redrawn on');
        assert.equal(marker.listenerCount('keydown'), 1, 'the redrawn marker is still walkable by keyboard');
    });
});

// ------------------------------------------------- the marker's own arithmetic

test('the curve reads between its readings, and snaps to the nearest one', () => {
    const readings = [
        { x: 0, y: 200 },
        { x: 4, y: 150 },
        { x: 8, y: 130 },
        { x: 12, y: 110 },
    ];
    assert.equal(interpolateSeriesY(readings, 0), 200);
    assert.equal(interpolateSeriesY(readings, 4), 150);
    assert.equal(interpolateSeriesY(readings, 2), 175, 'halfway between 200 and 150');
    assert.equal(interpolateSeriesY(readings, 6), 140);
    assert.equal(interpolateSeriesY(readings, -3), 200, 'before the first reading is the first reading');
    assert.equal(interpolateSeriesY(readings, 99), 110, 'and past the last is the last');
    assert.equal(interpolateSeriesY([], 3), null, 'nothing to read is null, never NaN');
    assert.equal(interpolateSeriesY(readings, Number.NaN), null);

    assert.deepEqual(orderedReadings([{ x: 8 }, { x: 0 }, { x: 4 }]).map(point => point.x), [0, 4, 8]);
    assert.equal(nearestReading(readings, 3.6)?.x, 4);
    assert.equal(nearestReading(readings, 2)?.x, 0, 'a tie goes to the earlier reading, so the answer is stable');
    assert.equal(nearestReading(readings, -9)?.x, 0);
    assert.equal(nearestReading([], 1), null);
    assert.equal(snapToReading(readings, 7.4), 8);
    assert.equal(snapToReading(readings, 5), 4, 'a tie snaps to the earlier reading');

    const series = plotGeometry(graphFixture(), DRAWN_WIDTH).series[0];
    assert.deepEqual(markerReading(series, 4, 'mmHg'), {
        x: 4,
        y: 150,
        title: 'Systolic',
        value: 'mmHg 150',
        label: 'Systolic: mmHg 150',
    });
    assert.deepEqual(markerReading(series, 0, 'mmHg'), {
        x: 0,
        y: 200,
        title: 'Crisis',
        value: 'mmHg 200',
        label: 'Systolic: Crisis · mmHg 200',
    });
    assert.equal(markerReading(series, 2, null)?.value, 'y 175', 'no y axis named reads plainly');
    assert.equal(markerReading(series, 2, null)?.title, 'Crisis', 'the nearest reading names it');

    // A placement helper for any value, so the marker can never sit somewhere
    // the dots would not.
    const geometry = plotGeometry(graphFixture(), DRAWN_WIDTH);
    assert.deepEqual(placeInPlot(geometry, 0, 200), { cx: geometry.left, cy: geometry.top });
    assert.deepEqual(placeInPlot(geometry, 12, 110), placeInPlot(geometry, 12, 110));
    assert.equal(placeInPlot(geometry, 14, 300).cx, geometry.right, 'past the window is the edge of the plot');
    assert.equal(polylineLength(plotGeometry(clampedFixture(), DRAWN_WIDTH).series[0].points) > 0, true);
});

// ------------------------------------------------- the stylesheet's new part

test('the draw-in and the marker are driven by the custom properties the code sets', () => {
    const css = read(CSS_PATH);
    const readout = ruleBody(css, '.sf-graph-marker-readout');
    assert.match(readout, /left:\s*var\(--sf-graph-marker-x/);
    assert.match(readout, /top:\s*var\(--sf-graph-marker-y/);
    assert.match(readout, /pointer-events:\s*none/);
    assert.match(ruleBody(css, '.sf-graph-marker-readout.is-below'), /transform:/);
    assert.match(ruleBody(css, '.sf-graph-marker-readout.is-hidden'), /display:\s*none/);
    assert.match(ruleBody(css, '.sf-graph-line.is-draw-in'), /stroke-dasharray:\s*var\(--sf-graph-line-length/);

    const source = read('ui/study-visual-graph.ts');
    assert.match(source, /setCssProps\(\{ '--sf-graph-marker-x'/, 'the readout is placed through custom properties');
    assert.match(source, /setCssProps\(\{ '--sf-graph-line-length'/, 'and so is the draw-in');
    assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(source), 'and never through an inline style assignment');
});

test('the drawing animates only where the host allows motion, and never at the reader’s expense', () => {
    const css = read(CSS_PATH);
    for (const state of ['is-draw-in', 'is-dragging', 'is-motion', 'is-hidden']) {
        assert.ok(css.includes(`.${state}`), `no rule for ${state}`);
    }
    assert.match(ruleBody(css, '.sf-graph.is-motion .sf-graph-line.is-draw-in'), /animation:/);
    assert.match(css, /@keyframes sf-graph-draw-in/, 'the draw-in has keyframes of its own');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'and the setting can change while the graph is open');
    assert.match(ruleBody(css, '.sf-graph.is-dragging .sf-graph-marker-line'), /stroke:/);
});
