/**
 * The interactive diagram, driven against the repo's mini-dom.
 *
 * What is pinned here is that the picture is drawn as the thing it is: one SVG
 * element per shape in the asset's own 0–100 space (a box with the geometry it
 * was given, an ellipse placed by its centre, an arrow with both endpoints and
 * a head where it points, a label on its point), scaled to the host's measured
 * width and re-measured when the host changes — capped at the width a diagram
 * can be read at, never wider than the host, and with its text held at the
 * house size in real pixels instead of scaling with the drawing.
 *
 * The game is pinned too, because it is now the surface: the parts arrive as a
 * shuffled tray of labelled chips, a chip in hand is placed on a part with one
 * press or one drop, a right placement lands the label on the drawing and opens
 * its one sentence, a wrong one is refused in place, the score counts what is
 * home, and the last placement solves the diagram. Text is never cut in
 * silence, and none before it has to be: a label that does not fit steps down a
 * house size and wraps inside its shape first, and only a shape too small even
 * for that ellipsises its label — which then carries the whole string in a
 * `title`.
 *
 * Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { StudyDiagram } from '../models/study-visuals';
import {
    DIAGRAM_MAX_WIDTH,
    DIAGRAM_UNITS,
    PLACE_ALL_TEXT,
    StudyVisualDiagramView,
    arrowHeadPoints,
    charsInUnits,
    chipOrder,
    chipSeed,
    ellipsise,
    placedReport,
    prefersReducedMotion,
    readHostWidth,
    shapeTextLines,
    wrapText,
} from '../ui/study-visual-diagram';

const repoRoot = process.cwd();
const CSS_PATH = 'styles/study-visual-diagram.css';
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

// The surfaces reach for no document of their own, but the suite installs the
// element and document globals every mini-dom suite works against.
installMiniDocument();

/**
 * A `ResizeObserver` the harness can drive.
 *
 * The renderer must watch its host, and the observation has to be provable
 * without a browser: this records what was observed, lets a test fire the
 * callback the way a resize would, and remembers a disconnect.
 */
class StubResizeObserver {
    static created: StubResizeObserver[] = [];

    observed: unknown[] = [];
    disconnected = false;

    private readonly callback: () => void;

    constructor(callback: () => void) {
        this.callback = callback;
        StubResizeObserver.created.push(this);
    }

    observe(target: unknown): void {
        this.observed.push(target);
    }

    disconnect(): void {
        this.disconnected = true;
    }

    /** What a real observer does when the box it watches changes. */
    fire(): void {
        this.callback();
    }
}

(globalThis as Record<string, unknown>).ResizeObserver = StubResizeObserver;
const lastObserver = (): StubResizeObserver => StubResizeObserver.created[StubResizeObserver.created.length - 1];

/** The width a sidebar hands the diagram. */
const SIDEBAR_WIDTH = 340;
/** A sentence that cannot fit the box it is put in, so the cut is exercised. */
const LONG_BOX_TEXT =
    'The proximal tubule reabsorbs roughly two thirds of the filtered sodium and water before the loop of Henle sees any of it';
const HOTSPOT_DETAIL = 'Most reabsorption happens here.';

// ------------------------------------------------------------------- fixtures

function diagramFixture(): StudyDiagram {
    return {
        kind: 'diagram',
        title: 'The nephron',
        teach: 'Where each part reabsorbs what',
        shapes: [
            { id: 'glom', kind: 'ellipse', x: 20, y: 20, w: 14, h: 10, text: 'Glomerulus', tone: 'primary' },
            { id: 'body', kind: 'box', x: 40, y: 40, w: 44, h: 22, text: 'Proximal tubule', tone: 'accent' },
            { id: 'long', kind: 'box', x: 4, y: 70, w: 30, h: 16, text: LONG_BOX_TEXT, tone: 'muted' },
            { id: 'flow', kind: 'arrow', x: 27, y: 24, x2: 60, y2: 24, tone: 'muted' },
            { id: 'name', kind: 'label', x: 50, y: 92, text: 'Cortex' },
        ],
        hotspots: [
            { id: 'pct', label: 'Proximal tubule', x: 45, y: 26, detail: HOTSPOT_DETAIL },
            { id: 'loop', label: 'Loop of Henle', x: 78, y: 60, detail: 'Concentrates the urine.' },
        ],
        caption: 'Not to scale.',
        pearl: 'The proximal tubule does the bulk of the work.',
    };
}

// -------------------------------------------------------------------- mounting

function host(width = SIDEBAR_WIDTH): MiniElement {
    const el = new MiniElement('div');
    (el as unknown as { clientWidth: number }).clientWidth = width;
    return el;
}

function mountDiagram(diagram: StudyDiagram, into: MiniElement = host()) {
    const view = new StudyVisualDiagramView();
    const teardown = view.mount(into as unknown as HTMLElement, diagram);
    return { view, into, teardown };
}

/** Document position of the first element carrying a class. */
function positionOf(root: MiniElement, cls: string): number {
    return root.findAll(() => true).findIndex(el => el.hasClass(cls));
}

// ------------------------------------------------------- the shapes, as shapes

test('a diagram draws one SVG element per shape, in the asset’s own 0–100 space', () => {
    const diagram = diagramFixture();
    const { into } = mountDiagram(diagram);

    const svg = into.byClass('sf-vd-svg')[0];
    assert.ok(svg, 'the picture is an SVG');
    assert.equal(svg.tag, 'svg');
    assert.equal(svg.attrs.viewBox, `0 0 ${DIAGRAM_UNITS} ${DIAGRAM_UNITS}`, 'the viewBox is the asset’s own space');
    assert.equal(svg.parent, into.byClass('sf-vd-figure')[0], 'inside its own figure box');

    // A box is a rounded rect at the corner it was given, with its size.
    const boxes = into.byClass('sf-vd-box');
    assert.equal(boxes.length, 2, 'one per box shape');
    assert.ok(boxes.every(box => box.tag === 'rect'));
    const body = boxes.find(box => box.attrs['data-shape-id'] === 'body');
    assert.ok(body);
    assert.deepEqual([body.attrs.x, body.attrs.y, body.attrs.width, body.attrs.height], ['40', '40', '44', '22']);
    assert.notEqual(body.attrs.rx, undefined, 'a box has rounded corners');

    // An ellipse is placed by its centre; w and h are its full size.
    const ellipse = into.byClass('sf-vd-ellipse')[0];
    assert.equal(ellipse.tag, 'ellipse');
    assert.deepEqual([ellipse.attrs.cx, ellipse.attrs.cy, ellipse.attrs.rx, ellipse.attrs.ry], ['20', '20', '7', '5']);

    // An arrow is a line with both endpoints, and a head drawn at the end.
    const arrow = into.byClass('sf-vd-arrow')[0];
    assert.equal(arrow.tag, 'line');
    assert.deepEqual([arrow.attrs.x1, arrow.attrs.y1, arrow.attrs.x2, arrow.attrs.y2], ['27', '24', '60', '24']);
    const head = into.byClass('sf-vd-arrowhead')[0];
    assert.equal(head.tag, 'polygon');
    assert.equal(head.attrs.points, arrowHeadPoints(27, 24, 60, 24));

    // A label is text on the point it names.
    const label = into.byClass('sf-vd-label')[0];
    assert.equal(label.tag, 'text');
    assert.deepEqual([label.attrs.x, label.attrs.y], ['50', '92']);
    assert.equal(label.textContent, 'Cortex');

    // Every shape carries its own id, and the tone the asset gave it — on the
    // shape and on the parts drawn for it (a box's text, an arrow's head).
    assert.deepEqual(boxes.map(box => box.attrs['data-shape-id']), ['body', 'long']);
    assert.ok(body.hasClass('sf-vd-tone-accent'));
    assert.ok(ellipse.hasClass('sf-vd-tone-primary'));
    const long = boxes.find(box => box.attrs['data-shape-id'] === 'long');
    assert.ok(long?.hasClass('sf-vd-tone-muted'));
    assert.ok(arrow.hasClass('sf-vd-tone-muted'));
    assert.equal(into.byClass('sf-vd-tone-primary').length, 2, 'the ellipse and its own text');

    // teach above, caption below, pearl last — all in the order they are read.
    assert.equal(into.textOf('sf-vd-teach'), diagram.teach);
    assert.equal(into.textOf('sf-vd-caption'), diagram.caption);
    assert.equal(into.textOf('sf-vd-pearl-tag'), 'Pearl');
    assert.equal(into.textOf('sf-vd-pearl-text'), diagram.pearl);
    assert.ok(positionOf(into, 'sf-vd-teach') < positionOf(into, 'sf-vd-figure'), 'the teach line is above the picture');
    assert.ok(positionOf(into, 'sf-vd-figure') < positionOf(into, 'sf-vd-caption'), 'the caption is below it');
    assert.ok(positionOf(into, 'sf-vd-caption') < positionOf(into, 'sf-vd-pearl'), 'and the pearl ends the card');
});

test('the arrow’s head points where the line does, and a headingless arrow has none', () => {
    const points = arrowHeadPoints(0, 0, 10, 0);
    assert.ok(points, 'a line with a direction has a head');
    assert.ok(points.startsWith('10,0 '), 'drawn at the arrow’s tip');
    assert.equal(points.split(' ').length, 3, 'a triangle: the tip and two base corners');
    assert.equal(arrowHeadPoints(5, 5, 5, 5), null, 'an arrow with no direction has nothing to point');

    // Up the page: the tip is above the base, and the base is wider than 0.
    const up = arrowHeadPoints(0, 10, 0, 0);
    assert.ok(up);
    const [tip, left] = up.split(' ').map(pair => pair.split(',').map(Number));
    assert.deepEqual(tip, [0, 0]);
    assert.ok(left[1] > tip[1], 'the corners sit behind the tip');
});

// ----------------------------------------------------------- the host’s width

test('the drawing is scaled to the host’s measured width, and never wider', () => {
    const into = host(SIDEBAR_WIDTH);
    const { view } = mountDiagram(diagramFixture(), into);
    const svg = into.byClass('sf-vd-svg')[0];

    assert.equal(svg.attrs.width, '340');
    assert.equal(svg.attrs.height, '340', 'the drawing is square: its own space is');
    assert.equal(view.getWidth(), 340);
    assert.equal(readHostWidth(into as unknown as HTMLElement), 340);

    // The host shrinks: the drawing is measured again, so it never sticks out.
    into.clientWidth = 260;
    view.remeasure();
    assert.equal(svg.attrs.width, '260');
    assert.equal(svg.attrs.height, '260');

    // A host that cannot be measured keeps the width the drawing already had.
    into.clientWidth = 0;
    view.remeasure();
    assert.equal(svg.attrs.width, '260', 'an unmeasurable host does not shrink the drawing to nothing');
    assert.equal(readHostWidth(into as unknown as HTMLElement), 0);

    // And the stylesheet caps it independently of any measurement.
    const css = read(CSS_PATH);
    assert.match(ruleBody(css, '.sf-vd-svg'), /max-width:\s*100%/);
    assert.match(ruleBody(css, '.sf-vd'), /min-width:\s*0/);
    assert.match(ruleBody(css, '.sf-vd-figure'), /max-width:\s*100%/);
});

test('the host is watched: a resize re-measures it, and a teardown lets go', () => {
    const into = host(SIDEBAR_WIDTH);
    const { teardown } = mountDiagram(diagramFixture(), into);

    const observer = lastObserver();
    assert.ok(observer, 'the drawing watches the host it was mounted into');
    assert.deepEqual(observer.observed, [into]);

    into.clientWidth = 500;
    observer.fire();
    assert.equal(into.byClass('sf-vd-svg')[0].attrs.width, '500', 'the resize is what re-measures');

    teardown();
    assert.equal(observer.disconnected, true, 'and nothing is watched once the drawing is gone');
});

// ---------------------------------------------------------- the readable cap

test('the drawing is capped at a readable width, and its text is sized from the house tokens in real pixels', () => {
    const into = host(1136);
    const { view } = mountDiagram(diagramFixture(), into);
    const svg = into.byClass('sf-vd-svg')[0];

    assert.equal(svg.attrs.width, String(DIAGRAM_MAX_WIDTH), 'a wide dock gets a capped drawing, not a wall of type');
    assert.equal(svg.attrs.height, String(DIAGRAM_MAX_WIDTH), 'and the drawing stays square');
    assert.equal(view.getWidth(), DIAGRAM_MAX_WIDTH, 'the width it draws at is the capped one');

    // The drawing's units per CSS pixel, written onto the SVG for the width it
    // is drawn at: what every text rule multiplies its house size by, so a
    // label holds its size while the geometry scales.
    const factor = Number(svg.style['--sf-vd-unit-scale']);
    assert.ok(Number.isFinite(factor), 'the renderer tells the stylesheet the drawing’s scale');
    assert.ok(
        Math.abs(factor - DIAGRAM_UNITS / DIAGRAM_MAX_WIDTH) < 0.001,
        `the factor is the capped width’s, was ${factor}`
    );

    // The stylesheet declares the same cap, and sizes every SVG text from the
    // house tokens — never as a fraction of the drawing's own units.
    const css = read(CSS_PATH);
    const cap = new RegExp(`width:\\s*min\\(100%,\\s*${DIAGRAM_MAX_WIDTH}px\\)`);
    assert.match(ruleBody(css, '.sf-vd-svg'), cap, 'the sheet declares the same cap as the renderer');
    assert.match(ruleBody(css, '.sf-vd-svg'), /max-width:\s*100%/, 'and still never widens its host');
    assert.match(
        ruleBody(css, '.sf-vd-shape-text'),
        /font-size:\s*calc\(var\(--sf-font-ui\) \* var\(--sf-vd-unit-scale\)\)/,
        'the shape text is the house UI size in real pixels'
    );
    assert.match(ruleBody(css, '.sf-vd-shape-text.is-shrunk'), /var\(--sf-font-small\)/, 'the step down is the floor size');
    assert.match(ruleBody(css, '.sf-vd-label'), /font-size:\s*calc\(var\(--sf-font-small\) \* var\(--sf-vd-unit-scale\)\)/);
    assert.match(ruleBody(css, '.sf-vd-hotspot-num'), /var\(--sf-font-small\)/);
    assert.ok(!/\*\s*0\.28\b/.test(css), 'no size is a fraction of a token in the drawing’s own units any more');
});

// --------------------------------------------------------------------- the game

/** The chip the tray dealt for a hotspot, found wherever it sits in the deal. */
function chipFor(into: MiniElement, id: string): MiniElement {
    const found = into.byClass('sf-vd-chip').find(chip => chip.attrs['data-hotspot-id'] === id);
    assert.ok(found, `no chip for ${id}`);
    return found;
}

test('a diagram with parts arrives taken apart: a shuffled tray of labels and a score', () => {
    const diagram = diagramFixture();
    const { into } = mountDiagram(diagram);

    // The tray holds every part's name, exactly once, as real buttons.
    const chips = into.byClass('sf-vd-chip');
    assert.equal(chips.length, diagram.hotspots.length, 'one chip per part');
    assert.deepEqual(
        chips.map(chip => chip.tag),
        ['button', 'button'],
        'a label is a real button, so it is focusable and presses like one'
    );
    assert.deepEqual(
        chips.map(chip => chip.textContent).sort(),
        diagram.hotspots.map(hotspot => hotspot.label).sort(),
        'every part is in the tray, and nothing else is'
    );
    assert.equal(chipFor(into, 'pct').attrs['aria-pressed'], 'false', 'nothing is in hand to begin with');

    // The deal is the asset's own shuffled order, and never the true one.
    const dealt = chips.map(chip => chip.attrs['data-hotspot-id']);
    assert.deepEqual(dealt, chipOrder(diagram.hotspots).map(hotspot => hotspot.id), 'the deal is the seeded one');
    assert.notDeepEqual(dealt, diagram.hotspots.map(hotspot => hotspot.id), 'and it is never the answer');

    // The score is a live region and starts at nothing placed.
    assert.equal(into.textOf('sf-vd-report'), placedReport(0, diagram.hotspots.length));
    assert.ok(into.byClass('sf-vd-report')[0].attrs['aria-live'] === 'polite');

    // The markers are still focusable buttons at their points — but in game
    // mode their accessible name is the target's number, not the answer.
    const markers = into.byClass('sf-vd-hotspot');
    const first = markers[0];
    assert.equal(first.attrs.tabindex, '0', 'a target is focusable');
    assert.equal(first.attrs.role, 'button');
    assert.equal(first.attrs['aria-label'], 'Target 1');
    const dot = first.byClass('sf-vd-hotspot-dot')[0];
    assert.deepEqual([dot.attrs.cx, dot.attrs.cy], ['45', '26'], 'the target sits at the point the asset named');
    assert.equal(first.byClass('sf-vd-hotspot-num').length, 1, 'and carries its own number');
    assert.equal(into.byClass('sf-vd-hotspot-label').length, 0, 'no part is labelled until its label is home');

    // Nothing is open to begin with: the words are behind the work.
    assert.ok(into.byClass('sf-vd-detail')[0].hasClass('sf-vd-hidden'));
    assert.equal(into.textOf('sf-vd-detail-label'), '');
});

test('a wrong placement is refused on the spot, and the label stays in hand', () => {
    const diagram = diagramFixture();
    const { into, view } = mountDiagram(diagram);
    const markers = into.byClass('sf-vd-hotspot');

    assert.equal(view.attemptPlacement('pct', 'loop'), true, 'the attempt is handled');
    assert.equal(markers[1].hasClass('is-rejected'), true, 'the part refuses it where it was put');
    assert.equal(markers[1].hasClass('is-placed'), false);
    assert.equal(into.textOf('sf-vd-report'), 'Not this part. Try another.');
    assert.equal(chipFor(into, 'pct').hasClass('is-placed'), false, 'the label is not spent by a wrong guess');
    assert.equal(into.byClass('sf-vd-hotspot-label').length, 0, 'and nothing is written onto the drawing');

    // A new attempt clears the refusal: it was a moment, not a state.
    view.attemptPlacement('pct', 'pct');
    assert.equal(markers[1].hasClass('is-rejected'), false, 'the old refusal is gone');
});

test('a right placement lands the label on the drawing and opens its one sentence', () => {
    const diagram = diagramFixture();
    const { into, view } = mountDiagram(diagram);
    const markers = into.byClass('sf-vd-hotspot');
    const [pct, loop] = markers;

    assert.equal(view.attemptPlacement('pct', 'pct'), true);
    assert.equal(pct.hasClass('is-placed'), true, 'the part takes it');
    assert.equal(pct.attrs['aria-label'], 'Proximal tubule — placed', 'and now says its own name');
    assert.equal(into.textOf('sf-vd-report'), placedReport(1, 2));
    assert.equal(pct.hasClass('is-open'), true, 'the reward is the part’s own sentence');
    assert.equal(into.textOf('sf-vd-detail-label'), diagram.hotspots[0].label);
    assert.equal(into.textOf('sf-vd-detail-text'), HOTSPOT_DETAIL);

    // The label is written onto the drawing, at the point it named.
    const written = pct.byClass('sf-vd-hotspot-label')[0];
    assert.ok(written, 'the drawing now carries the part’s name');
    assert.equal(written.textContent, 'Proximal tubule');
    assert.deepEqual([written.attrs.x, written.attrs.y], ['45', '33'], 'under the target it belongs to');

    // The chip is spent: dimmed and unpressable, but still on screen as a record.
    const spent = chipFor(into, 'pct');
    assert.equal(spent.hasClass('is-placed'), true);
    assert.equal(spent.disabled, true, 'a placed label cannot be picked up again');
    assert.equal(view.selectChip('pct'), false, 'and selecting it is refused');

    // A part already home cannot be stolen by another label.
    assert.equal(view.attemptPlacement('loop', 'pct'), false, 'a placed target is not a target');

    // The last label home solves the diagram: a state on the root and in the score.
    assert.equal(view.attemptPlacement('loop', 'loop'), true);
    assert.equal(into.byClass('sf-vd-report')[0].textContent, PLACE_ALL_TEXT);
    assert.equal(into.byClass('sf-vd')[0].hasClass('is-solved'), true, 'the diagram says it is whole');
    assert.equal(loop.hasClass('is-placed'), true);
});

test('a part opens on the keyboard, and Space does not scroll the pane', () => {
    const { into, view } = mountDiagram(diagramFixture());
    const [pct] = into.byClass('sf-vd-hotspot');

    // With no label in hand, a part answers honestly instead of opening.
    pct.dispatch('keydown', { key: 'Enter' });
    assert.equal(into.textOf('sf-vd-report'), 'Pick a label first.');
    assert.equal(pct.attrs['aria-expanded'], 'false', 'and nothing opens');

    // With a label in hand, Enter places it — the same route the pointer uses.
    assert.equal(view.selectChip('pct'), true);
    let prevented = false;
    pct.dispatch('keydown', { key: ' ', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, 'Space is consumed, so the pane behind it does not scroll');
    assert.equal(pct.hasClass('is-placed'), true, 'and the label was placed');

    // Once placed, the part opens and closes like the button it is.
    pct.dispatch('keydown', { key: 'Enter' });
    assert.equal(pct.attrs['aria-expanded'], 'false', 'activating the open part closes it');
    pct.dispatch('keydown', { key: 'Tab' });
    assert.equal(pct.attrs['aria-expanded'], 'false', 'a key that is not its own does nothing');
});

test('one detail is open at a time, and activating a placed part again closes it', () => {
    const diagram = diagramFixture();
    const { into, view } = mountDiagram(diagram);
    const markers = into.byClass('sf-vd-hotspot');
    const [first, second] = markers;
    const panel = into.byClass('sf-vd-detail')[0];
    const openCount = (): number => into.byClass('sf-vd-hotspot').filter(marker => marker.hasClass('is-open')).length;

    // Both parts placed by their own labels: the drawing is whole.
    view.attemptPlacement('pct', 'pct');
    view.attemptPlacement('loop', 'loop');
    assert.equal(openCount(), 1, 'each placement opens the part it completed');

    first.click();
    assert.equal(openCount(), 1, 'opening another part closes the first');
    assert.ok(first.hasClass('is-open'));
    assert.equal(second.attrs['aria-expanded'], 'false');
    assert.equal(into.textOf('sf-vd-detail-label'), diagram.hotspots[0].label);
    assert.equal(into.textOf('sf-vd-detail-text'), HOTSPOT_DETAIL);

    first.click();
    assert.equal(openCount(), 0, 'activating the open part closes it');
    assert.equal(panel.hasClass('sf-vd-hidden'), true, 'and the panel goes away with it');
    assert.equal(into.textOf('sf-vd-detail-label'), '');
    assert.equal(into.textOf('sf-vd-detail-text'), '');
});

test('a chip is picked up with the pointer and carried as a ghost', () => {
    const diagram = diagramFixture();
    const { into } = mountDiagram(diagram);
    const chip = chipFor(into, 'pct');

    const bag = globalThis as Record<string, unknown>;
    const bound: string[] = [];
    const originalAdd = bag.addEventListener;
    bag.addEventListener = ((type: string) => { bound.push(type); }) as typeof bag.addEventListener;
    try {
        chip.dispatch('pointerdown', { button: 0, clientX: 12, clientY: 34 } as unknown as { key?: string });
    } finally {
        bag.addEventListener = originalAdd;
    }

    assert.equal(chip.hasClass('is-carrying'), true, 'the chip says it is being carried');
    assert.equal(chip.hasClass('is-selected'), false, 'a drag does not select: the click that follows it is what selects');
    const ghost = into.byClass('sf-vd-ghost')[0];
    assert.ok(ghost, 'a ghost rides the pointer');
    assert.equal(ghost.textContent, 'Proximal tubule');
    assert.equal(ghost.style['--sf-vd-ghost-x'], '12px', 'placed where the pointer is');
    assert.ok(bound.includes('pointermove'), 'the drag listens on the window while it runs');
    assert.ok(bound.includes('pointerup'), 'and lets go on the window too');
});

test('the seed, the deal and the score line are pure and stable', () => {
    const hotspots = diagramFixture().hotspots;
    assert.equal(chipSeed(hotspots), chipSeed(hotspots), 'the seed is a property of the asset');
    assert.deepEqual(chipOrder(hotspots).map(hotspot => hotspot.id), chipOrder(hotspots).map(hotspot => hotspot.id), 'and so is the deal');
    assert.deepEqual(chipOrder([]), [], 'no parts, no deal');
    assert.deepEqual(chipOrder([hotspots[0]]), [hotspots[0]], 'one part is dealt as itself');
    assert.equal(placedReport(0, 4), '0 of 4 placed');
    assert.equal(placedReport(9, 4), '4 of 4 placed', 'the count never exceeds the whole');
    assert.equal(PLACE_ALL_TEXT, 'All parts placed.');
});

// ------------------------------------------------------------------ the text

test('a label too long for its shape is ellipsised, with the whole of it in the title', () => {
    const diagram = diagramFixture();
    const { into } = mountDiagram(diagram);
    const texts = into.byClass('sf-vd-shape-text');

    const cut = texts.find(text => text.attrs['data-shape-id'] === 'long');
    assert.ok(cut, 'the long box’s text is drawn');
    const expected = shapeTextLines(LONG_BOX_TEXT, 30, 16);
    assert.equal(expected.cut, true, 'the fixture must genuinely not fit its shape');
    assert.deepEqual(cut.querySelectorAll('tspan').map(tspan => tspan.text), expected.lines, 'wrapped in the box it sits in');
    assert.equal(expected.lines.length, 2);
    assert.ok(expected.lines[1].endsWith('…'), 'the cut is visible where it happens');
    assert.equal(cut.attrs.title, LONG_BOX_TEXT, 'and the whole text is one title away');

    const fits = texts.find(text => text.attrs['data-shape-id'] === 'body');
    assert.ok(fits);
    assert.deepEqual(fits.querySelectorAll('tspan').map(tspan => tspan.text), shapeTextLines('Proximal tubule', 44, 22).lines);
    assert.equal(fits.attrs.title, undefined, 'a label that fits claims no title');
    assert.ok(!fits.textContent.includes('…'));

    // A shape small enough for only a few characters says so: the cut is
    // drawn, and the whole word is still one title away.
    const small = texts.find(text => text.attrs['data-shape-id'] === 'glom');
    assert.ok(small, 'the ellipse’s label is drawn');
    assert.ok(small.textContent.endsWith('…'), 'a word too long for the shape is cut visibly');
    assert.equal(small.attrs.title, 'Glomerulus', 'and nothing is cut in silence');
    assert.equal(shapeTextLines('Glomerulus', 14 * 0.72, 10 * 0.72).cut, true);
    assert.equal(shapeTextLines('Glomerulus', 40, 20).cut, false, 'the same word fits a shape big enough for it');

    // The wrapping model on its own: greedy, visible when it cuts, and never
    // longer than the shape allows.
    assert.deepEqual(wrapText('one two three', 7, 2), { lines: ['one two', 'three'], cut: false });
    assert.deepEqual(wrapText('aaa bbb ccc', 5, 1), { lines: ['aaa…'], cut: true });
    assert.deepEqual(wrapText('pneumonoultramicroscopicsilicovolcanoconiosis', 8, 3), {
        lines: ['pneumon…'],
        cut: true,
    });
    assert.equal(ellipsise('longword', 4), 'lon…');
    assert.equal(ellipsise('fit', 4), 'fit');
    assert.equal(charsInUnits(38), 19);
    assert.equal(charsInUnits(0), 1, 'a shape with no room still gets one character');
});

test('a label placed on the drawing itself is cut at the length it can afford', () => {
    const long = 'Proximal convoluted tubule, pars convoluta, of the nephron';
    const diagram = diagramFixture();
    diagram.shapes = [{ id: 'name', kind: 'label', x: 50, y: 50, text: long }];
    const { into } = mountDiagram(diagram);

    const label = into.byClass('sf-vd-label')[0];
    assert.equal(label.textContent.length <= long.length, true);
    assert.ok(label.textContent.endsWith('…'), 'a label too long to draw is ellipsised');
    assert.equal(label.attrs.title, long, 'and carries the whole text');
});

// ------------------------------------------- fitting a label: shrink, wrap, cut

test('a label that fits its shape at the house size is not shrunk, wrapped or cut', () => {
    const { into } = mountDiagram(diagramFixture());
    const text = into.byClass('sf-vd-shape-text').find(candidate => candidate.attrs['data-shape-id'] === 'body');
    assert.ok(text, 'the box’s label is drawn');

    assert.equal(text.hasClass('is-shrunk'), false, 'there was room at the house size');
    assert.equal(text.querySelectorAll('tspan').length, 1, 'so it is drawn on one line');
    assert.ok(!text.textContent.includes('…'));
    assert.equal(text.attrs.title, undefined, 'and claims no title');

    const fit = shapeTextLines('Proximal tubule', 44, 22);
    assert.deepEqual(
        { lines: fit.lines, cut: fit.cut, shrunk: fit.shrunk },
        { lines: ['Proximal tubule'], cut: false, shrunk: false }
    );
});

test('a label that will not fit at the house size steps down and wraps rather than being cut', () => {
    const diagram = diagramFixture();
    // Tall enough for two lines at the stepped-down size and only one at the
    // house size: exactly the shape the shrink-before-cut step is for.
    diagram.shapes = [{ id: 'node', kind: 'box', x: 20, y: 40, w: 30, h: 11.6, text: 'Proximal tubule' }];
    diagram.hotspots = [];
    const { into } = mountDiagram(diagram);

    const text = into.byClass('sf-vd-shape-text')[0];
    assert.equal(text.hasClass('is-shrunk'), true, 'the label stepped down a house size');
    assert.deepEqual(
        text.querySelectorAll('tspan').map(tspan => tspan.text),
        ['Proximal', 'tubule'],
        'and wrapped onto two lines inside the shape'
    );
    assert.ok(!text.textContent.includes('…'), 'nothing was cut');
    assert.equal(text.attrs.title, undefined, 'so there is nothing to carry in a title');

    const fit = shapeTextLines('Proximal tubule', 30, 11.6);
    assert.equal(fit.shrunk, true, 'the model takes the step before it cuts');
    assert.equal(fit.cut, false);
});

test('a label too long even for the floor size is ellipsised, with the whole of it in the title', () => {
    const diagram = diagramFixture();
    diagram.shapes = [{ id: 'node', kind: 'box', x: 20, y: 40, w: 12, h: 6, text: 'Cytochrome b6f' }];
    diagram.hotspots = [];
    const { into } = mountDiagram(diagram);

    const text = into.byClass('sf-vd-shape-text')[0];
    assert.equal(text.hasClass('is-shrunk'), true, 'it stepped down before anything was cut');
    assert.ok(text.textContent.endsWith('…'), 'the cut is visible where it happens');
    assert.equal(text.attrs.title, 'Cytochrome b6f', 'and the whole label is one title away');
    assert.equal(shapeTextLines('Cytochrome b6f', 12, 6).cut, true, 'the shape is genuinely too small for even the floor size');

    // The apology never doubles itself when a word inside the text was cut
    // first: this is the difference between `Cy…` and `Cy……` on screen.
    assert.equal(ellipsise('Cy… b6f', 4), 'Cy…');
});

test('a wider drawing gives a shape more room, so its labels are fitted again when the host changes', () => {
    const diagram = diagramFixture();
    diagram.shapes = [
        { id: 'node', kind: 'box', x: 10, y: 40, w: 30, h: 16, text: 'Proximal tubule reabsorbs sodium' },
    ];
    diagram.hotspots = [];
    const into = host(260);
    const { view } = mountDiagram(diagram, into);
    const text = into.byClass('sf-vd-shape-text')[0];

    assert.ok(text.textContent.includes('…'), 'at a narrow width the label cannot fit');
    assert.equal(text.hasClass('is-shrunk'), true, 'not even after the step down');
    assert.equal(text.attrs.title, 'Proximal tubule reabsorbs sodium', 'so the whole label is in the title');

    into.clientWidth = 700;
    view.remeasure();

    assert.equal(
        into.byClass('sf-vd-svg')[0].attrs.width,
        String(DIAGRAM_MAX_WIDTH),
        'the drawing grows only to its cap'
    );
    assert.deepEqual(
        text.querySelectorAll('tspan').map(tspan => tspan.text),
        ['Proximal tubule', 'reabsorbs sodium'],
        'and the label is fitted again for the room it now has'
    );
    assert.equal(text.hasClass('is-shrunk'), false, 'at the capped width it fits at the house size');
    assert.ok(!text.textContent.includes('…'));
    assert.equal(text.attrs.title, undefined, 'and nothing is left to apologise for');
});

// ------------------------------------------------------------------- motion

/** A diagram where one arrow carries flow and one shape breathes. */
function motionFixture(): StudyDiagram {
    return {
        kind: 'diagram',
        title: 'The loop',
        teach: 'What moves while nobody is touching it',
        shapes: [
            { id: 'in', kind: 'box', x: 2, y: 42, w: 22, h: 16, text: 'Filter', pulse: true },
            { id: 'out', kind: 'box', x: 76, y: 42, w: 22, h: 16, text: 'Reabsorb' },
            { id: 'carry', kind: 'arrow', x: 26, y: 50, x2: 74, y2: 50, flow: true },
            { id: 'still', kind: 'arrow', x: 26, y: 20, x2: 74, y2: 20 },
        ],
        hotspots: [{ id: 'filter', label: 'Filter', x: 13, y: 42, detail: 'Where it starts.' }],
    };
}

/**
 * Run `body` with the host's `matchMedia` stubbed (`null` means a host that has
 * none at all), and put the real one back afterwards.
 */
function withMatchMedia(stub: unknown, body: () => void): void {
    const scope = globalThis as Record<string, unknown>;
    const original = scope.matchMedia;
    if (stub === null) delete scope.matchMedia;
    else scope.matchMedia = stub;
    try {
        body();
    } finally {
        if (original === undefined) delete scope.matchMedia;
        else scope.matchMedia = original;
    }
}

test('an arrow marked flow carries travelling motion, and one without it does not', () => {
    const { into } = mountDiagram(motionFixture());

    const overlays = into.byClass('sf-vd-arrow-flow');
    assert.equal(overlays.length, 1, 'exactly the arrow that asked for flow');
    const overlay = overlays[0];
    assert.equal(overlay.tag, 'line', 'the overlay is a drawing of the same path');
    assert.equal(overlay.attrs['data-shape-id'], 'carry', 'and belongs to its own arrow');

    const arrows = into.byClass('sf-vd-arrow');
    assert.equal(arrows.length, 2, 'both arrows are still drawn as arrows');
    assert.equal(
        overlays.filter(candidate => candidate.attrs['data-shape-id'] === 'still').length,
        0,
        'the arrow that did not ask for flow carries no overlay'
    );
    const carried = arrows.find(arrow => arrow.attrs['data-shape-id'] === 'carry');
    assert.ok(carried);
    assert.deepEqual(
        [overlay.attrs.x1, overlay.attrs.y1, overlay.attrs.x2, overlay.attrs.y2],
        [carried.attrs.x1, carried.attrs.y1, carried.attrs.x2, carried.attrs.y2],
        'the overlay travels exactly the arrow’s own path'
    );

    // The moving part sits under the hotspot layer and takes no pointer events,
    // so the parts still open on the arrow it rides.
    assert.ok(positionOf(into, 'sf-vd-shapes') < positionOf(into, 'sf-vd-hotspots'), 'the shapes are drawn under the parts');
    assert.equal(overlay.parent, into.byClass('sf-vd-shapes')[0]);
    const marker = into.byClass('sf-vd-hotspot')[0];
    marker.click();
    assert.equal(marker.attrs['aria-expanded'], 'true', 'the parts open exactly as they did');

    // The stylesheet is what travels it: a dash pattern sized from the
    // drawing's own scale, one whole period per cycle.
    const css = read(CSS_PATH);
    const rule = ruleBody(css, '.sf-vd-arrow-flow');
    assert.match(rule, /stroke-dasharray:[^;]*var\(--sf-vd-unit-scale\)/, 'the dashes are sized in the drawing’s own units');
    assert.match(rule, /animation:\s*sf-vd-flow-travel/, 'and the overlay is the thing that moves');
    assert.match(rule, /pointer-events:\s*none/);
    assert.match(css, /@keyframes sf-vd-flow-travel/);
    assert.match(css, /stroke-dashoffset:\s*calc\(-16px \* var\(--sf-vd-unit-scale\)\)/, 'the offset travels a whole dash period');
});

test('a shape marked pulse breathes, and one without it does not', () => {
    const { into } = mountDiagram(motionFixture());

    const groups = into.byClass('sf-vd-pulse');
    assert.equal(groups.length, 1, 'only the shape that asked for it');
    const group = groups[0];
    assert.equal(group.tag, 'g', 'the pulse moves a group');
    assert.equal(group.attrs['data-shape-id'], 'in');

    // The shape and its label are drawn inside it, with the geometry and the
    // fitted lines they would have had anywhere else.
    const box = group.byClass('sf-vd-box')[0];
    assert.ok(box, 'the shape is drawn into the group');
    assert.deepEqual(
        [box.attrs.x, box.attrs.y, box.attrs.width, box.attrs.height],
        ['2', '42', '22', '16'],
        'with the geometry it was given'
    );
    const text = group.byClass('sf-vd-shape-text')[0];
    assert.ok(text, 'and so is its label');
    assert.deepEqual(
        text.querySelectorAll('tspan').map(tspan => tspan.text),
        shapeTextLines('Filter', 22, 16).lines,
        'fitted the way it always is'
    );
    assert.equal(text.hasClass('is-shrunk'), false, 'the pulse changes nothing about the fit');

    const plain = into.byClass('sf-vd-box').find(candidate => candidate.attrs['data-shape-id'] === 'out');
    assert.ok(plain);
    assert.equal(plain.closest('.sf-vd-pulse'), null, 'a shape that did not ask to breathe is not wrapped');
    assert.equal(into.byClass('sf-vd-box').length, 2, 'and both shapes are drawn');

    // The breathing is a slow transform on the group: paint only, no size.
    const css = read(CSS_PATH);
    const rule = ruleBody(css, '.sf-vd-pulse');
    assert.match(rule, /animation:\s*sf-vd-pulse-breathe/);
    assert.match(rule, /transform-box:\s*fill-box/, 'the breath scales the shape about itself');
    assert.match(css, /@keyframes sf-vd-pulse-breathe[\s\S]*?transform:\s*scale\(/);
});

test('a reader who asked for reduced motion gets the same drawing, at rest', () => {
    withMatchMedia(() => ({ matches: true }), () => {
        const { into } = mountDiagram(motionFixture());
        assert.equal(into.byClass('sf-vd-arrow-flow').length, 0, 'no travelling overlay is drawn');
        assert.equal(into.byClass('sf-vd-pulse').length, 0, 'and no breathing group');

        // The same picture, though: every shape, every label, and the parts.
        assert.equal(into.byClass('sf-vd-box').length, 2);
        assert.equal(into.byClass('sf-vd-arrow').length, 2);
        assert.equal(into.byClass('sf-vd-arrowhead').length, 2);
        assert.equal(into.byClass('sf-vd-shape-text').length, 2);
        assert.equal(into.byClass('sf-vd-hotspot').length, 1);
        assert.equal(into.byClass('sf-vd-svg')[0].attrs.width, String(SIDEBAR_WIDTH));

        // And the picture still works: a part opens when it is clicked.
        const marker = into.byClass('sf-vd-hotspot')[0];
        marker.click();
        assert.equal(marker.attrs['aria-expanded'], 'true');
    });
});

test('the reduced-motion read is guarded: no host, no answer, no throw', () => {
    withMatchMedia(null, () => assert.equal(prefersReducedMotion(), false, 'a host with no matchMedia'));
    withMatchMedia(() => undefined, () => assert.equal(prefersReducedMotion(), false, 'one that answers nothing'));
    withMatchMedia(() => null, () => assert.equal(prefersReducedMotion(), false, 'one that answers null'));
    withMatchMedia(
        () => {
            throw new Error('blocked');
        },
        () => assert.equal(prefersReducedMotion(), false, 'one that throws')
    );
    withMatchMedia(() => ({ matches: true }), () => assert.equal(prefersReducedMotion(), true, 'a reader who asked is heard'));
    withMatchMedia(() => ({ matches: false }), () => assert.equal(prefersReducedMotion(), false));
});

test('teardown takes the moving parts down with the drawing', () => {
    const into = host();
    const { teardown } = mountDiagram(motionFixture(), into);
    assert.equal(into.byClass('sf-vd-arrow-flow').length, 1);
    assert.equal(into.byClass('sf-vd-pulse').length, 1);

    teardown();
    assert.equal(into.byClass('sf-vd-arrow-flow').length, 0, 'the overlay goes with everything else');
    assert.equal(into.byClass('sf-vd-pulse').length, 0);
    assert.equal(into.byClass('sf-vd-shapes').length, 0);
    assert.equal(into.byClass('sf-vd-svg').length, 0);
});

// ------------------------------------------------------------------ teardown

test('mounting again replaces the drawing instead of stacking a second one', () => {
    const { view, into } = mountDiagram(diagramFixture());
    assert.equal(into.byClass('sf-vd').length, 1);

    view.mount(into as unknown as HTMLElement, { ...diagramFixture(), shapes: [], hotspots: [] });
    assert.equal(into.byClass('sf-vd').length, 1, 'one drawing, redrawn');
    assert.equal(into.byClass('sf-vd-box').length, 0, 'holding only the new material');
});

test('teardown takes the drawing and its listeners down, and leaves the host as it was', () => {
    const into = host();
    into.createDiv('someone-elses-box');
    const { teardown } = mountDiagram(diagramFixture(), into);

    const marker = into.byClass('sf-vd-hotspot')[0];
    assert.equal(marker.listenerCount('click'), 1, 'one handler while it is mounted');
    assert.equal(marker.listenerCount('keydown'), 1);

    teardown();
    assert.equal(into.byClass('sf-vd').length, 0);
    assert.equal(into.byClass('sf-vd-svg').length, 0);
    assert.equal(into.byClass('sf-vd-hotspot').length, 0);
    assert.equal(marker.listenerCount('click'), 0, 'nothing is left listening');
    assert.equal(marker.listenerCount('keydown'), 0);
    assert.equal(into.children.length, 1, 'only what was there before is left');
    assert.equal(into.byClass('someone-elses-box').length, 1);

    // Nothing reacts to the detached marker any more.
    marker.click();
    assert.equal(marker.hasClass('is-open'), false);
});

// ------------------------------------------------------- the stylesheet’s part

/** The body of the first rule whose selector list mentions this selector. */
function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `no rule for ${selector}`);
    const open = css.indexOf('{', at);
    assert.ok(open >= 0, `no rule body for ${selector}`);
    return css.slice(open + 1, css.indexOf('}', open));
}

test('every class the diagram renders has a rule in its stylesheet', () => {
    const source = read('ui/study-visual-diagram.ts');
    const css = read(CSS_PATH);
    // `--sf-vd-tone` is data the code sets, and `sf-vd-tone-` is a prefix on
    // the name it completes; the three tones are asserted by name below.
    const tokens = new Set([...source.replace(/--sf-[a-z0-9-]+/g, ' ').matchAll(/sf-[a-z0-9-]+/g)].map(match => match[0]));

    const missing = [...tokens].filter(token => !token.endsWith('-') && !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(tokens.size >= 20, `expected to find the diagram's classes, found ${tokens.size}`);

    // The open marker and the hidden panel carry meaning; each needs its rule.
    assert.ok(css.includes('.is-open'), 'no rule for the open hotspot');
    assert.ok(css.includes('.sf-vd-hidden'), 'no rule for the hidden panel');

    // The asset's tones map onto the theme's own colours.
    assert.match(ruleBody(css, '.sf-vd-tone-primary'), /--sf-vd-tone:\s*var\(--sf-primary\)/);
    assert.match(ruleBody(css, '.sf-vd-tone-muted'), /--sf-text-muted/);
    assert.match(ruleBody(css, '.sf-vd-tone-accent'), /--interactive-accent/, 'accent is the app’s own accent');
});

test('the diagram is styled with classes, on the house type scale, and cuts nothing silently', () => {
    const source = read('ui/study-visual-diagram.ts');
    const css = read(CSS_PATH);

    assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(source), 'no inline style assignment');

    // Text sizes come from the house tokens: inside the SVG the size is a
    // fraction of them, in the drawing's own units, never a px literal.
    const sized = [...css.matchAll(/font-size:\s*([^;{}]+)/g)].map(match => match[1].trim());
    assert.ok(sized.length > 0, 'the stylesheet sizes text');
    assert.deepEqual(sized.filter(value => /\d(\.\d+)?(px|rem|pt|pc|cm|mm|in)\b/.test(value)), [], 'every size comes from a --sf-font-* token');
    assert.ok(sized.every(value => value.includes('var(--sf-font-')), 'and each one reads a token');

    // A label that cannot fit is ellipsised in the code (asserted above), so
    // the sheet itself never has to clip a line.
    assert.ok(!/overflow(-[xy])?:\s*hidden/.test(css), 'nothing is clipped by the sheet');
    assert.match(ruleBody(css, '.sf-vd-detail-text'), /overflow-wrap:\s*anywhere/, 'the panel wraps its text');

    // The hotspot's focus is visible: the dot's ring thickens on :focus-visible.
    assert.match(css, /\.sf-vd-hotspot:focus-visible\s+\.sf-vd-hotspot-dot/);
    assert.match(ruleBody(css, '.sf-vd-hotspot.is-open .sf-vd-hotspot-dot'), /fill:\s*var\(--interactive-accent\)/);
});
