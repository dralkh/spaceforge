/**
 * Spaceforge Study — the diagram, as a label-placement game.
 *
 * `models/study-visuals.ts` hands over a picture: shapes placed in the asset's
 * own 0–100 space, and hotspots — named points that name parts of the system.
 * The surface this module draws is not a picture with captions behind taps: it
 * is the picture *taken apart*. The parts arrive as labelled chips in a tray,
 * shuffled out of order, and the reader puts them back where they belong —
 * dragging a chip onto the point it names, or picking a chip up with the
 * keyboard and pressing the part. A right placement locks the label onto the
 * drawing and hands over the one sentence of detail; a wrong one is refused on
 * the spot. The score line says how many parts are placed, and the diagram is
 * solved when the last one lands.
 *
 * The words are the reward, not the content: until a part is placed, its
 * sentence is not on screen at all — the reader works the picture first, then
 * reads what they proved they knew. Each part's detail opens only once its chip
 * is home, and activating a placed part again closes it.
 *
 * Seven decisions are load-bearing:
 *
 *  - **The drawing is scaled to the host, but only up to a readable size.** The
 *    SVG's viewBox *is* the asset's own 0–100 space; its width and height are
 *    the host's measured width, re-measured on a resize, and capped at
 *    `DIAGRAM_MAX_WIDTH` — a dock 1136px wide draws a 560px picture, not a wall
 *    of oversized shapes. The stylesheet caps the rendered width at the same
 *    number, so even a stale measurement cannot push the panel the drawing sits
 *    in.
 *  - **A part is a real control.** Every marker is an SVG `<g tabindex="0"
 *    role="button">` that Enter or Space activates like any button; every chip
 *    in the tray is a real `<button>`, so the game is fully playable from the
 *    keyboard — Space picks a label up, Enter or Space on a part puts it down.
 *  - **A shuffle is never the answer.** The chips are dealt in a seeded order
 *    derived from the hotspots' own ids — no `Math.random` — and the deal is
 *    turned over if it happens to land in the true order, because a tray that
 *    is already right is not an exercise.
 *  - **The feedback is immediate and small.** A placement lands or is refused
 *    on the spot, in the reader's own line of sight (the part's own state), and
 *    the only words around it are the score — `2 of 4 placed`, then `All parts
 *    placed.` Nothing is announced with a dialog.
 *  - **No label is cut in silence, and none before it has to.** A label that
 *    does not fit at the house UI size first steps down one house size (never
 *    below `--sf-font-small`) and wraps inside the shape it belongs to; only a
 *    shape too small even for that ellipsises its label, and the whole string
 *    stays one `title` away.
 *  - **Text is sized in real pixels, not in the drawing's units.** The
 *    stylesheet takes every text size from the house tokens
 *    (`var(--sf-font-ui)`, `var(--sf-font-small)`), and this module writes the
 *    drawing's units-per-pixel factor onto the SVG on every draw so those sizes
 *    survive the viewBox's scaling: a label reads at the reader's size whether
 *    the picture is drawn at 320px or at its 560px cap. The wrapping model
 *    measures the room a shape affords in those same pixels.
 *  - **Motion is an offer, never a requirement.** An arrow marked `flow` gets a
 *    dashed overlay of its own path whose offset travels, so the arrow visibly
 *    carries something from tail to head; a shape marked `pulse` is wrapped in
 *    a group that breathes; the drag ghost that follows the reader's pointer is
 *    a nicety of the same kind. All three are classes and CSS animations, and
 *    the drawing is left out of them entirely when the reader has asked for
 *    reduced motion — read through a guarded `matchMedia` — so the picture is
 *    the same picture, sitting still, and every interaction still works.
 *
 * Where the asset's numbers are unhelpful, this drawing is explicit rather than
 * silent: a `box`'s `x, y` is its top-left corner, an `ellipse`'s `x, y` is its
 * centre (radii from `w`/`h`), an `arrow` runs `x, y → x2, y2`, a `label` sits
 * on `x, y`. Shapes are held inside the 0–100 space so nothing is drawn where
 * the reader cannot see it.
 */

import { StudyDiagram, StudyDiagramHotspot, StudyDiagramShape } from '../models/study-visuals';

/** The asset's own coordinate space: every shape is placed in 0–100 units. */
export const DIAGRAM_UNITS = 100;

/** The width the drawing is given before its host can be measured, in px. */
export const DIAGRAM_FALLBACK_WIDTH = 320;

/**
 * The widest the drawing is ever rendered, in CSS px.
 *
 * The drawing scales with its host, but only up to here: past this width a
 * diagram becomes a wall of shape and type larger than the panel it sits in —
 * at 1136px the drawing's own units make a label read at roughly 40px, and a
 * label is the reader's text, not the picture's. The stylesheet caps the
 * rendered width at the same 560px from its side.
 */
export const DIAGRAM_MAX_WIDTH = 560;

/**
 * The width the fitting model assumes when it is not told the drawing's scale:
 * a sidebar-width drawing, which is where a Study diagram is most often read,
 * and the width the model's character arithmetic was calibrated against. Every
 * draw passes the scale it is really drawn at.
 */
export const DIAGRAM_SIDEBAR_WIDTH = 340;

/**
 * The two house sizes a shape's label may be drawn at, in CSS px: the size the
 * stylesheet's `--sf-font-ui` resolves to, and the floor (`--sf-font-small`)
 * that a label may step down to before anything is ever cut. The stylesheet
 * owns the sizes; the fitting model needs the numbers to know how much of a
 * label fits where.
 */
export const SHAPE_TEXT_FULL_PX = 13;
export const SHAPE_TEXT_FLOOR_PX = 12;

/** Room left between a shape's edge and its text, in the asset's own units. */
const SHAPE_PAD = 3;

/** A character's advance, as a share of the text size. */
const CHAR_WIDTH_RATIO = 0.55;

/** One line's height, as a share of the text size. */
const LINE_HEIGHT_RATIO = 1.26;

/**
 * One character's advance in the asset's own units — about two units a
 * character, at the size the drawing's own unit-based model drew text at on a
 * sidebar-width drawing. The fit itself is measured in real pixels
 * (`shapeTextLines`), because a label no longer scales with the drawing's
 * units; this stays the drawing's own rough arithmetic, `charsInUnits`.
 */
export const CHAR_UNITS = 2;

/** What a shape gets when the model left its size off. */
const DEFAULT_BOX_WIDTH = 30;
const DEFAULT_BOX_HEIGHT = 16;
const DEFAULT_ARROW_LENGTH = 24;

/** A label with no box to sit in is cut at this many characters. */
const LABEL_MAX_CHARS = 42;

/** The hotspot marker's radius, and the arrowhead's length, in the asset's units. */
const HOTSPOT_RADIUS = 3;
const ARROWHEAD_UNITS = 2.8;

/** The visible apology on text that does not fit where it was put. */
const ELLIPSIS = '…';

// ------------------------------------------------------------------ helpers

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), Math.max(min, max));
}

/** A coordinate, written at most two decimals so a test can read it back. */
function formatUnits(value: number): string {
    return String(Math.round(value * 100) / 100);
}

/** A ratio written at four decimals — enough for a font size to a tenth of a pixel. */
function formatRatio(value: number): string {
    return String(Math.round(value * 10000) / 10000);
}

function setGeometry(el: SVGElement, attributes: Record<string, number>): void {
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, formatUnits(value));
}

/**
 * The host's own width, from whichever measurement it answers.
 *
 * Zero when it cannot be measured at all (a detached host, a stand-in without
 * layout) — the caller then keeps the width it already drew at.
 */
export function readHostWidth(host: HTMLElement): number {
    const client = typeof host.clientWidth === 'number' && Number.isFinite(host.clientWidth) ? host.clientWidth : 0;
    if (client > 0) return client;
    if (typeof host.getBoundingClientRect === 'function') {
        const rect = host.getBoundingClientRect();
        const width = rect ? rect.width : 0;
        if (Number.isFinite(width) && width > 0) return width;
    }
    const offset = typeof host.offsetWidth === 'number' && Number.isFinite(host.offsetWidth) ? host.offsetWidth : 0;
    return offset > 0 ? offset : 0;
}

/** The media query a reader's own "reduce motion" preference answers. */
const PREFERS_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Whether the reader has asked their system for reduced motion.
 *
 * Read through the host's own `matchMedia`, and answered conservatively: no
 * `matchMedia` at all, one that answers nothing, and one that throws all mean
 * "no preference", which is also the honest answer for a host that cannot be
 * asked. Nothing is animated here — this only decides which classes are drawn.
 */
export function prefersReducedMotion(): boolean {
    try {
        const scope = window as unknown as { matchMedia?: unknown };
        if (typeof scope.matchMedia !== 'function') return false;
        const query = (scope.matchMedia as (query: string) => { matches?: boolean } | null | undefined)(
            PREFERS_REDUCED_MOTION
        );
        return query?.matches === true;
    } catch {
        return false;
    }
}

/** How many characters fit across this much of the drawing, in the drawing's own units. */
export function charsInUnits(units: number): number {
    return Math.max(1, Math.floor(Math.max(0, units) / CHAR_UNITS));
}

/** Cut a string to fit, with a visible ellipsis when it does not. */
export function ellipsise(text: string, maxChars: number): string {
    const limit = Math.max(1, Math.floor(maxChars));
    if (text.length <= limit) return text;
    // The apology never doubles itself: when the character it stands beside is
    // already an ellipsis (a word inside the text was cut first), it replaces
    // that one rather than being written next to it.
    const kept = text
        .slice(0, Math.max(1, limit - 1))
        .trimEnd()
        .replace(/…$/, '');
    return `${kept}${ELLIPSIS}`;
}

/**
 * Greedy word wrap. `cut` is true when the text did not fit in `maxLines`, and
 * the caller then keeps the whole string as the element's `title`.
 *
 * A single token longer than a line is cut where it stands rather than left to
 * overflow its shape: the reader still gets the whole word from the title, and
 * the drawing never lies about the room it had.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): { lines: string[]; cut: boolean } {
    const width = Math.max(1, Math.floor(maxChars));
    const limit = Math.max(1, Math.floor(maxLines));
    // A token with more characters than a whole line has is cut where it
    // stands, and that alone is a cut: the caller must offer the whole text.
    let truncated = false;
    const words = text
        .split(/\s+/)
        .filter(Boolean)
        .map(word => {
            const written = ellipsise(word, width);
            if (written !== word) truncated = true;
            return written;
        });
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= width) {
            current = candidate;
            continue;
        }
        if (current) lines.push(current);
        current = word;
    }
    if (current) lines.push(current);
    if (lines.length <= limit) return { lines, cut: truncated };
    return { lines: [...lines.slice(0, limit - 1), ellipsise(lines.slice(limit - 1).join(' '), width)], cut: true };
}

/**
 * The room a shape leaves inside itself for text: a fixed inset, but never more
 * than a tenth of the shape — a small shape keeps its own proportions rather
 * than losing a third of its width to a margin meant for a large one.
 */
function shapePadding(width: number, height: number): { x: number; y: number } {
    return { x: Math.min(SHAPE_PAD, Math.max(0, width) * 0.1), y: Math.min(SHAPE_PAD, Math.max(0, height) * 0.1) };
}

/** One attempt at fitting a text into a shape's room, at one text size. */
function fitAtSize(text: string, roomWidthPx: number, roomHeightPx: number, fontPx: number): { lines: string[]; cut: boolean } {
    const columns = Math.max(1, Math.floor(roomWidthPx / (CHAR_WIDTH_RATIO * fontPx)));
    const rows = Math.max(1, Math.floor(roomHeightPx / (LINE_HEIGHT_RATIO * fontPx)));
    return wrapText(text, columns, rows);
}

/** What a shape's text was fitted to, and at what size. */
export interface ShapeTextFit {
    /** The lines to draw, top to bottom. */
    lines: string[];
    /** True when the text is longer than the shape can hold even at the floor size. */
    cut: boolean;
    /** True when the label stepped down to the floor size to fit. */
    shrunk: boolean;
    /** One line's height, in the asset's own units, for the size the text was fitted at. */
    lineUnits: number;
}

/**
 * The lines one shape's text fits into, and the size it was fitted at.
 *
 * The whole model of what a shape can say, in one pure function. A label is
 * drawn at the house UI size in real pixels whatever width the drawing is
 * rendered at, so the room a shape affords is measured in pixels: its own units
 * times the drawing's scale. A label that does not fit at that size steps down
 * one house size — never below `--sf-font-small` — and is wrapped onto the
 * lines the shape's height allows; only a label too long even for the floor
 * size is ellipsised, and `cut` then tells the caller to keep the whole string
 * in a `title`.
 */
export function shapeTextLines(
    text: string,
    width: number,
    height: number,
    pxPerUnit: number = DIAGRAM_SIDEBAR_WIDTH / DIAGRAM_UNITS
): ShapeTextFit {
    const scale = Number.isFinite(pxPerUnit) && pxPerUnit > 0 ? pxPerUnit : DIAGRAM_SIDEBAR_WIDTH / DIAGRAM_UNITS;
    const pad = shapePadding(width, height);
    const roomWidth = Math.max(0, width - pad.x * 2) * scale;
    const roomHeight = Math.max(0, height - pad.y * 2) * scale;
    const full = fitAtSize(text, roomWidth, roomHeight, SHAPE_TEXT_FULL_PX);
    if (!full.cut) {
        return { lines: full.lines, cut: false, shrunk: false, lineUnits: (LINE_HEIGHT_RATIO * SHAPE_TEXT_FULL_PX) / scale };
    }
    // It does not fit at the house UI size: step down to the floor size first,
    // and cut only what is still too long for that.
    const floor = fitAtSize(text, roomWidth, roomHeight, SHAPE_TEXT_FLOOR_PX);
    return { lines: floor.lines, cut: floor.cut, shrunk: true, lineUnits: (LINE_HEIGHT_RATIO * SHAPE_TEXT_FLOOR_PX) / scale };
}

/**
 * The arrowhead at the end of a line, as an SVG `points` string.
 *
 * A zero-length arrow has no direction to point in and answers null, so the
 * caller draws the line alone rather than a head with no way to be oriented.
 */
export function arrowHeadPoints(x1: number, y1: number, x2: number, y2: number, size = ARROWHEAD_UNITS): string | null {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(length) || length < 0.01) return null;
    const ux = dx / length;
    const uy = dy / length;
    const backX = x2 - ux * size;
    const backY = y2 - uy * size;
    const half = size * 0.6;
    return [
        [x2, y2],
        [backX - uy * half, backY + ux * half],
        [backX + uy * half, backY - ux * half],
    ]
        .map(point => `${formatUnits(point[0])},${formatUnits(point[1])}`)
        .join(' ');
}

/** One text element inside the drawing, with the room its shape affords it. */
interface ShapeTextEntry {
    el: SVGTextElement;
    shape: StudyDiagramShape;
    box: { cx: number; cy: number; w: number; h: number };
}

/** One hotspot's marker, so its open state can be shown without a re-render. */
interface HotspotEntry {
    el: SVGElement;
    hotspot: StudyDiagramHotspot;
}

/** One label in the tray: the hotspot it belongs to, and the button that carries it. */
interface ChipEntry {
    id: string;
    label: string;
    el: HTMLButtonElement;
}

// ------------------------------------------------------------- the label game

/** How long a refused placement is marked before the part goes quiet again, in ms. */
export const REJECT_MS = 600;
/** The longest a label written onto the drawing after a placement may be. */
const PLACED_LABEL_MAX_CHARS = 26;
/** What the tray tells the reader to do. */
const TRAY_HINT = 'Drag each label onto the part it names, or pick a label and press its part.';
/** What a refused placement says. */
const PLACE_WRONG = 'Not this part. Try another.';
/** What a placing press says when no label is in hand. */
const PLACE_NONE_SELECTED = 'Pick a label first.';
/** What the score says when the last part lands. */
export const PLACE_ALL_TEXT = 'All parts placed.';

/** `2 of 4 placed` — the game's own arithmetic, and never more than the whole. */
export function placedReport(placed: number, total: number): string {
    const whole = Math.max(0, total);
    return `${Math.min(whole, Math.max(0, placed))} of ${whole} placed`;
}

/** The game's own seed: a stable hash of the hotspots' ids, so the deal is a property of the asset. */
export function chipSeed(hotspots: StudyDiagramHotspot[]): number {
    let hash = 2166136261;
    for (const hotspot of hotspots) {
        for (const character of `${hotspot.id}|`) {
            hash ^= character.charCodeAt(0);
            hash = Math.imul(hash, 16777619);
        }
    }
    return hash >>> 0;
}

/**
 * The order the chips are dealt in: the asset's own seeded shuffle, and never
 * the true order — a tray that reads right at a glance is not an exercise.
 * Deterministic, so the same note deals the same way tomorrow; no
 * `Math.random` anywhere.
 */
export function chipOrder(hotspots: StudyDiagramHotspot[]): StudyDiagramHotspot[] {
    const order = [...hotspots];
    if (order.length < 2) return order;
    let state = chipSeed(hotspots);
    const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    for (let position = order.length - 1; position > 0; position -= 1) {
        const swap = Math.floor(random() * (position + 1));
        const held = order[position];
        order[position] = order[swap];
        order[swap] = held;
    }
    const untouched = order.every((hotspot, index) => hotspot === hotspots[index]);
    return untouched ? [...order.slice(1), order[0]] : order;
}

/**
 * The diagram, mounted into a host of any width.
 *
 * The host is only ever filled, never restyled: every class, listener and
 * element the drawing needs is its own, so a teardown leaves the host exactly
 * as it found it. Mounting again replaces the drawing rather than stacking a
 * second one.
 */
export class StudyVisualDiagramView {
    private container: HTMLElement | null = null;
    private diagram: StudyDiagram | null = null;
    private root: HTMLElement | null = null;
    private svg: SVGSVGElement | null = null;
    private detailEl: HTMLElement | null = null;
    private detailLabelEl: HTMLElement | null = null;
    private detailTextEl: HTMLElement | null = null;

    private shapeTexts: ShapeTextEntry[] = [];
    private hotspotEntries: HotspotEntry[] = [];
    private openHotspotId: string | null = null;
    private hostWidth = DIAGRAM_FALLBACK_WIDTH;
    private drawnWidth = DIAGRAM_FALLBACK_WIDTH;
    /** Whether the reader asked for reduced motion, read once per mount. */
    private reducedMotion = false;
    private bindings: { el: EventTarget; type: string; handler: EventListener }[] = [];
    private resizeObserver: ResizeObserver | null = null;

    // the label game
    /** True once a tray was dealt: two or more named parts are a game. */
    private game = false;
    private chips: ChipEntry[] = [];
    private placedIds = new Set<string>();
    private selectedChipId: string | null = null;
    private reportEl: HTMLElement | null = null;
    private rejectTimers = new Set<number>();
    /** The chip a pointer drag is carrying, while one is running. */
    private dragChipId: string | null = null;
    private ghostEl: HTMLElement | null = null;
    private dragBindings: { el: EventTarget; type: string; handler: EventListener }[] = [];

    // ------------------------------------------------------------ lifecycle

    /** Draw the diagram inside `container` and return its teardown. */
    mount(container: HTMLElement, diagram: StudyDiagram): () => void {
        this.unmount();
        this.container = container;
        this.diagram = diagram;

        const root = container.createDiv('sf-vd');
        this.root = root;

        if (diagram.teach) root.createDiv({ cls: 'sf-vd-teach', text: diagram.teach });

        const figure = root.createDiv('sf-vd-figure');
        const svg = figure.createSvg('svg', { cls: 'sf-vd-svg' });
        svg.setAttribute('viewBox', `0 0 ${DIAGRAM_UNITS} ${DIAGRAM_UNITS}`);
        svg.setAttribute('role', 'group');
        svg.setAttribute('aria-label', diagram.title);
        this.svg = svg;
        // The motion preference is read once, before any shape is drawn: a
        // drawing that never adds the animated classes is the same picture the
        // reader would see with them, sitting still.
        this.reducedMotion = prefersReducedMotion();
        this.hostWidth = readHostWidth(container) || DIAGRAM_FALLBACK_WIDTH;
        this.sizeDrawing(svg, this.hostWidth);

        const shapes = svg.createSvg('g', { cls: 'sf-vd-shapes' });
        for (const shape of diagram.shapes) this.renderShape(shapes, shape);
        // Two or more named parts are dealt as a game; one is a picture with a
        // caption, and is left as one.
        this.game = diagram.hotspots.length >= 2;
        this.renderHotspots(svg, diagram);

        if (diagram.caption) root.createDiv({ cls: 'sf-vd-caption', text: diagram.caption });
        if (this.game) this.buildGame(root, diagram);
        this.buildDetail(root);
        if (diagram.pearl) this.renderPearl(root, diagram.pearl);

        this.watchResize(container);
        return () => this.unmount();
    }

    /** Take the drawing down: the observer, then the listeners, then the tree. */
    unmount(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.finishChipDrag();
        this.clearRejectTimers();
        for (const binding of this.bindings) binding.el.removeEventListener(binding.type, binding.handler);
        this.bindings = [];
        this.root?.remove();
        this.root = null;
        this.svg = null;
        this.detailEl = null;
        this.detailLabelEl = null;
        this.detailTextEl = null;
        this.shapeTexts = [];
        this.hotspotEntries = [];
        this.openHotspotId = null;
        this.hostWidth = DIAGRAM_FALLBACK_WIDTH;
        this.drawnWidth = DIAGRAM_FALLBACK_WIDTH;
        this.reducedMotion = false;
        this.game = false;
        this.chips = [];
        this.placedIds.clear();
        this.selectedChipId = null;
        this.reportEl = null;
        this.container = null;
        this.diagram = null;
    }

    /**
     * Re-measure the host and redraw at its width. Called on a resize; safe to
     * call by hand, and a no-op once the drawing is down.
     */
    remeasure(): void {
        const container = this.container;
        const svg = this.svg;
        if (!container || !svg) return;
        const width = readHostWidth(container);
        if (width <= 0 || width === this.hostWidth) return;
        this.hostWidth = width;
        this.sizeDrawing(svg, width);
        // The text holds its real size while the drawing's units change size,
        // so the room each shape affords its label has changed with it: fit
        // every label again.
        for (const entry of this.shapeTexts) this.layoutShapeText(entry);
    }

    /** The width the drawing is currently drawn at, for a caller that needs it. */
    getWidth(): number {
        return this.drawnWidth;
    }

    /**
     * Draw at this width: the host's, capped at what a diagram can be read at.
     * The stylesheet is told the drawing's units per CSS pixel alongside it, so
     * text and hairlines can hold their real size while the geometry scales.
     */
    private sizeDrawing(svg: SVGElement, width: number): void {
        const drawn = Math.min(Math.max(1, width), DIAGRAM_MAX_WIDTH);
        this.drawnWidth = drawn;
        const size = formatUnits(Math.round(drawn));
        svg.setAttribute('width', size);
        svg.setAttribute('height', size);
        svg.setCssProps({ '--sf-vd-unit-scale': formatRatio(DIAGRAM_UNITS / drawn) });
    }

    /** How many CSS pixels one of the drawing's units is at the width it is drawn at. */
    private pxPerUnit(): number {
        return this.drawnWidth / DIAGRAM_UNITS;
    }

    private watchResize(container: HTMLElement): void {
        // A host that has no ResizeObserver keeps the width it was measured at.
        if (typeof ResizeObserver === 'undefined') return;
        this.resizeObserver = new ResizeObserver(() => this.remeasure());
        this.resizeObserver.observe(container);
    }

    private bind(el: EventTarget, type: string, handler: (event: Event) => void): void {
        const listener = handler;
        el.addEventListener(type, listener);
        this.bindings.push({ el, type, handler: listener });
    }

    // ---------------------------------------------------------------- shapes

    /** Draw one shape: the geometry the asset asked for, in its own space. */
    private renderShape(parent: SVGElement, shape: StudyDiagramShape): void {
        // The one shape that should breathe is drawn into a group of its own,
        // so the animation moves it and its label together without touching the
        // geometry either of them was drawn with.
        const host = this.shapeHost(parent, shape);
        switch (shape.kind) {
            case 'box': {
                const width = shape.w && shape.w > 0 ? shape.w : DEFAULT_BOX_WIDTH;
                const height = shape.h && shape.h > 0 ? shape.h : DEFAULT_BOX_HEIGHT;
                const x = clamp(shape.x, 0, DIAGRAM_UNITS - width);
                const y = clamp(shape.y, 0, DIAGRAM_UNITS - height);
                const rect = this.shapeElement(host, 'rect', 'sf-vd-box', shape);
                setGeometry(rect, { x, y, width, height, rx: 2, ry: 2 });
                if (shape.text) {
                    this.renderShapeText(host, shape, { cx: x + width / 2, cy: y + height / 2, w: width, h: height });
                }
                break;
            }
            case 'ellipse': {
                const width = shape.w && shape.w > 0 ? shape.w : DEFAULT_BOX_WIDTH;
                const height = shape.h && shape.h > 0 ? shape.h : DEFAULT_BOX_HEIGHT;
                const rx = width / 2;
                const ry = height / 2;
                const cx = clamp(shape.x, rx, DIAGRAM_UNITS - rx);
                const cy = clamp(shape.y, ry, DIAGRAM_UNITS - ry);
                const ellipse = this.shapeElement(host, 'ellipse', 'sf-vd-ellipse', shape);
                setGeometry(ellipse, { cx, cy, rx, ry });
                if (shape.text) {
                    // An ellipse's usable text box is its inscribed rectangle.
                    this.renderShapeText(host, shape, { cx, cy, w: width * 0.72, h: height * 0.72 });
                }
                break;
            }
            case 'arrow': {
                const x = clamp(shape.x, 0, DIAGRAM_UNITS);
                const y = clamp(shape.y, 0, DIAGRAM_UNITS);
                // An arrow the model left an endpoint off points right rather
                // than collapsing to nothing, so a shape is never silently lost.
                const x2 = clamp(shape.x2 ?? x + DEFAULT_ARROW_LENGTH, 0, DIAGRAM_UNITS);
                const y2 = clamp(shape.y2 ?? y, 0, DIAGRAM_UNITS);
                const line = this.shapeElement(host, 'line', 'sf-vd-arrow', shape);
                setGeometry(line, { x1: x, y1: y, x2, y2 });
                // An arrow marked `flow` is drawn a second time, as a dashed
                // overlay of the very same path: the stylesheet travels its
                // dashes from tail to head. The reader who asked for no motion
                // never gets the overlay, so nothing is drawn here that would
                // have to stand still — the drawing is simply the picture.
                if (shape.flow === true && !this.reducedMotion) {
                    const flow = this.shapeElement(host, 'line', 'sf-vd-arrow-flow', shape);
                    setGeometry(flow, { x1: x, y1: y, x2, y2 });
                }
                const head = arrowHeadPoints(x, y, x2, y2);
                if (head) {
                    const points = this.shapeElement(host, 'polygon', 'sf-vd-arrowhead', shape);
                    points.setAttribute('points', head);
                }
                break;
            }
            case 'label': {
                const text = this.shapeElement(host, 'text', 'sf-vd-label', shape);
                setGeometry(text, { x: clamp(shape.x, 0, DIAGRAM_UNITS), y: clamp(shape.y, 0, DIAGRAM_UNITS) });
                // `dy` centres the glyphs on the point the asset named.
                text.setAttribute('dy', '0.35em');
                const source = shape.text ?? '';
                const written = ellipsise(source, LABEL_MAX_CHARS);
                text.setText(written);
                if (written !== source) text.setAttribute('title', source);
                break;
            }
        }
    }

    /**
     * The element one shape is drawn into: a group of its own when the shape
     * should breathe, the shapes layer itself when it should not.
     *
     * The pulse is a CSS transform on the group, so the shape and its label
     * move together and nothing about the geometry — or the fit of the label —
     * is touched. Under reduced motion the group is not created at all: the
     * same drawing, at rest.
     */
    private shapeHost(parent: SVGElement, shape: StudyDiagramShape): SVGElement {
        if (shape.pulse !== true || this.reducedMotion) return parent;
        const group = parent.createSvg('g', { cls: 'sf-vd-pulse' });
        group.setAttribute('data-shape-id', shape.id);
        return group;
    }

    /** One shape element: its class, its id, and the tone it carries. */
    private shapeElement<T extends keyof SVGElementTagNameMap>(
        parent: SVGElement,
        tag: T,
        cls: string,
        shape: StudyDiagramShape
    ): SVGElementTagNameMap[T] {
        const el = parent.createSvg(tag, { cls });
        el.setAttribute('data-shape-id', shape.id);
        if (shape.tone) el.addClass(`sf-vd-tone-${shape.tone}`);
        return el;
    }

    /** The text inside a box or an ellipse, wrapped to the room the shape has. */
    private renderShapeText(
        parent: SVGElement,
        shape: StudyDiagramShape,
        box: { cx: number; cy: number; w: number; h: number }
    ): void {
        const el = this.shapeElement(parent, 'text', 'sf-vd-shape-text', shape);
        const entry: ShapeTextEntry = { el, shape, box };
        this.shapeTexts.push(entry);
        this.layoutShapeText(entry);
    }

    /**
     * Write the fitted lines into one text element, centred on its shape.
     *
     * The drawing's units change size with the host but its text does not, so
     * the room a shape affords its label is measured in pixels and this runs on
     * every draw and again on every re-measure. `is-shrunk` is the label
     * telling the stylesheet it has stepped down to the floor size, and a cut
     * label always carries the whole of itself in a `title`.
     */
    private layoutShapeText(entry: ShapeTextEntry): void {
        const source = entry.shape.text ?? '';
        const el = entry.el;
        el.empty();
        const { lines, cut, shrunk, lineUnits } = shapeTextLines(source, entry.box.w, entry.box.h, this.pxPerUnit());
        el.setAttribute('x', formatUnits(entry.box.cx));
        el.setAttribute('y', formatUnits(entry.box.cy - ((lines.length - 1) / 2) * lineUnits + lineUnits * 0.35));
        lines.forEach((line, index) => {
            const tspan = el.createSvg('tspan');
            tspan.setAttribute('x', formatUnits(entry.box.cx));
            if (index > 0) tspan.setAttribute('dy', formatUnits(lineUnits));
            tspan.setText(line);
        });
        el.toggleClass('is-shrunk', shrunk);
        if (cut) el.setAttribute('title', source);
        else el.removeAttribute('title');
    }

    // -------------------------------------------------------------- hotspots

    /** One focusable marker per hotspot: the part of the picture that opens, and the target a chip lands on. */
    private renderHotspots(svg: SVGElement, diagram: StudyDiagram): void {
        const group = svg.createSvg('g', { cls: 'sf-vd-hotspots' });
        diagram.hotspots.forEach((hotspot, index) => {
            const marker = group.createSvg('g', { cls: 'sf-vd-hotspot' });
            marker.setAttribute('data-hotspot-id', hotspot.id);
            marker.setAttribute('tabindex', '0');
            marker.setAttribute('role', 'button');
            // While the diagram is a game, the marker must not carry the answer
            // in its accessible name: it is `Target 2` until the right label
            // lands on it, which is the same information the drawn number gives.
            marker.setAttribute('aria-label', this.game ? `Target ${index + 1}` : hotspot.label);
            marker.setAttribute('aria-expanded', 'false');

            const cx = clamp(hotspot.x, HOTSPOT_RADIUS, DIAGRAM_UNITS - HOTSPOT_RADIUS);
            const cy = clamp(hotspot.y, HOTSPOT_RADIUS, DIAGRAM_UNITS - HOTSPOT_RADIUS);
            const dot = marker.createSvg('circle', { cls: 'sf-vd-hotspot-dot' });
            setGeometry(dot, { cx, cy, r: HOTSPOT_RADIUS });
            const number = marker.createSvg('text', { cls: 'sf-vd-hotspot-num' });
            setGeometry(number, { x: cx, y: cy });
            number.setAttribute('dy', '0.35em');
            number.setText(String(index + 1));

            this.bind(marker, 'click', () => this.onMarkerActivate(hotspot));
            this.bind(marker, 'keydown', event => {
                const key = (event as KeyboardEvent).key;
                if (key !== 'Enter' && key !== ' ') return;
                // Space would otherwise scroll the pane behind the drawing.
                event.preventDefault();
                this.onMarkerActivate(hotspot);
            });
            // A pointer drop: the marker under the pointer is the target. The
            // window's own pointerup (bound by the drag) cleans up after this.
            this.bind(marker, 'pointerup', () => {
                if (this.dragChipId !== null) this.attemptPlacement(this.dragChipId, hotspot.id);
            });

            this.hotspotEntries.push({ el: marker, hotspot });
        });
    }

    // -------------------------------------------------------------- the game

    /**
     * Deal the tray: every part's label as a chip, shuffled, with the score
     * line under it. This is the whole of the game's furniture — the parts
     * themselves are already on the drawing.
     */
    private buildGame(root: HTMLElement, diagram: StudyDiagram): void {
        const tray = root.createDiv('sf-vd-tray');
        tray.setAttribute('role', 'group');
        tray.setAttribute('aria-label', 'Labels to place');
        for (const hotspot of chipOrder(diagram.hotspots)) {
            const chip = tray.createEl('button', { cls: 'sf-vd-chip' });
            chip.setAttribute('type', 'button');
            chip.setAttribute('data-hotspot-id', hotspot.id);
            chip.setAttribute('aria-pressed', 'false');
            chip.createSpan({ cls: 'sf-vd-chip-text', text: hotspot.label });
            this.bind(chip, 'click', () => this.selectChip(hotspot.id));
            this.bind(chip, 'pointerdown', event => this.startChipDrag(event, hotspot.id));
            this.chips.push({ id: hotspot.id, label: hotspot.label, el: chip });
        }

        const foot = root.createDiv('sf-vd-game');
        foot.createDiv({ cls: 'sf-vd-hint', text: TRAY_HINT });
        const report = foot.createDiv('sf-vd-report');
        report.setAttribute('aria-live', 'polite');
        this.reportEl = report;
        this.updateReport();
    }

    /**
     * Pick a label up, or put it down again: exactly one chip is in hand.
     *
     * Public because it *is* the route: a chip's click and a drag's start both
     * come through here, so a test (or a host driving the component without a
     * pointer) can select the label the reader would have.
     */
    selectChip(id: string): boolean {
        if (!this.game || this.placedIds.has(id)) return false;
        this.setSelection(this.selectedChipId === id ? null : id);
        return true;
    }

    /** Put a label in hand, or none; the chips' own state says which. */
    private setSelection(id: string | null): void {
        this.selectedChipId = id;
        for (const chip of this.chips) {
            const on = chip.id === id;
            chip.el.toggleClass('is-selected', on);
            chip.el.setAttribute('aria-pressed', String(on));
        }
    }

    /** A part was activated: open it if it is placed, place the label in hand if not. */
    private onMarkerActivate(hotspot: StudyDiagramHotspot): void {
        if (!this.game) {
            this.toggleHotspot(hotspot);
            return;
        }
        if (this.placedIds.has(hotspot.id)) {
            this.toggleHotspot(hotspot);
            return;
        }
        if (this.selectedChipId !== null) {
            this.attemptPlacement(this.selectedChipId, hotspot.id);
            return;
        }
        this.reportEl?.setText(PLACE_NONE_SELECTED);
    }

    /**
     * Land a label on a part, and answer honestly: the right part takes it, the
     * wrong one refuses it on the spot.
     *
     * Public, and the single entry point both the pointer drop and the
     * keyboard's activation go through — so the game is one behaviour with two
     * ways to drive it. Answers whether a placement was attempted (a chip
     * already home, or an unknown id, is not).
     */
    attemptPlacement(chipId: string, hotspotId: string): boolean {
        if (!this.game) return false;
        this.clearRejectMarks();
        const chip = this.chips.find(entry => entry.id === chipId);
        const marker = this.hotspotEntries.find(entry => entry.hotspot.id === hotspotId);
        if (!chip || !marker || this.placedIds.has(hotspotId)) return false;
        if (chipId === hotspotId) {
            this.placeChip(chip, marker);
            return true;
        }
        this.rejectMarker(marker);
        return true;
    }

    /** A right placement: the chip leaves the tray, the label lands on the drawing, the score moves. */
    private placeChip(chip: ChipEntry, marker: HotspotEntry): void {
        this.placedIds.add(chip.id);
        this.setSelection(null);
        chip.el.addClass('is-placed');
        chip.el.disabled = true;
        marker.el.addClass('is-placed');
        marker.el.setAttribute('aria-label', `${marker.hotspot.label} — placed`);
        this.drawPlacedLabel(marker);
        this.updateReport();
        // The words are the reward: the part's own sentence opens once its
        // label is home, which is the only thing the reader was working for.
        this.setOpenHotspot(marker.hotspot.id);
        if (this.placedIds.size >= this.chips.length) this.solve();
    }

    /** The label, written onto the drawing at the part it named. */
    private drawPlacedLabel(entry: HotspotEntry): void {
        const hotspot = entry.hotspot;
        const cx = clamp(hotspot.x, HOTSPOT_RADIUS, DIAGRAM_UNITS - HOTSPOT_RADIUS);
        const cy = clamp(hotspot.y, HOTSPOT_RADIUS, DIAGRAM_UNITS - HOTSPOT_RADIUS);
        const label = entry.el.createSvg('text', { cls: 'sf-vd-hotspot-label' });
        const y = clamp(cy + 7, 1, DIAGRAM_UNITS - 1);
        setGeometry(label, { x: cx, y });
        const written = ellipsise(hotspot.label, PLACED_LABEL_MAX_CHARS);
        label.setText(written);
        if (written !== hotspot.label) label.setAttribute('title', hotspot.label);
    }

    /** A wrong placement: the part refuses it, visibly and in words. */
    private rejectMarker(entry: HotspotEntry): void {
        entry.el.addClass('is-rejected');
        this.reportEl?.setText(PLACE_WRONG);
        const host = typeof window === 'undefined' ? null : window;
        if (!host || typeof host.setTimeout !== 'function') return;
        const timer = host.setTimeout(() => {
            entry.el.removeClass('is-rejected');
            this.rejectTimers.delete(timer);
        }, REJECT_MS);
        this.rejectTimers.add(timer);
    }

    /** The refusals are a moment, not a state: a new attempt clears every old one. */
    private clearRejectMarks(): void {
        for (const entry of this.hotspotEntries) entry.el.removeClass('is-rejected');
        this.clearRejectTimers();
    }

    private clearRejectTimers(): void {
        if (this.rejectTimers.size === 0) return;
        const host = typeof window === 'undefined' ? null : window;
        if (host && typeof host.clearTimeout === 'function') {
            for (const timer of this.rejectTimers) host.clearTimeout(timer);
        }
        this.rejectTimers.clear();
    }

    /** The score: how many labels are home, and the end of the game. */
    private updateReport(): void {
        this.reportEl?.setText(placedReport(this.placedIds.size, this.chips.length));
    }

    /** Every label home: the diagram says so, once. */
    private solve(): void {
        this.root?.addClass('is-solved');
        this.reportEl?.setText(PLACE_ALL_TEXT);
        this.reportEl?.addClass('is-solved');
    }

    // --------------------------------------------------------- the pointer drag

    /**
     * A chip is picked up with the pointer and a ghost rides the pointer until
     * it is let go. The drop lands through `attemptPlacement` — the same route
     * the keyboard uses — so the drag adds nothing but the carrying.
     */
    private startChipDrag(event: Event, id: string): void {
        if (!this.game || this.placedIds.has(id) || this.dragChipId !== null) return;
        const pointer = event as PointerEvent;
        if (typeof pointer.button === 'number' && pointer.button !== 0) return;
        const chip = this.chips.find(entry => entry.id === id);
        if (!chip) return;
        if (typeof pointer.preventDefault === 'function') pointer.preventDefault();
        // The drag does not *select*: a pointerdown that ends in a click without
        // moving still has to reach the chip's own click, which is what selects.
        // While the pointer is down the chip says it is being carried.
        this.dragChipId = id;
        chip.el.addClass('is-carrying');
        this.ghostEl = this.buildGhost(chip.label);
        this.moveGhost(pointer);
        this.bindDrag(window, 'pointermove', move => this.moveGhost(move as PointerEvent));
        this.bindDrag(window, 'pointerup', () => this.finishChipDrag());
        this.bindDrag(window, 'pointercancel', () => this.finishChipDrag());
    }

    private buildGhost(label: string): HTMLElement | null {
        const root = this.root;
        if (!root) return null;
        const ghost = root.createDiv('sf-vd-ghost');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.createSpan({ cls: 'sf-vd-chip-text', text: label });
        return ghost;
    }

    private moveGhost(pointer: PointerEvent): void {
        const ghost = this.ghostEl;
        if (!ghost) return;
        const x = typeof pointer.clientX === 'number' ? Math.round(pointer.clientX) : 0;
        const y = typeof pointer.clientY === 'number' ? Math.round(pointer.clientY) : 0;
        ghost.setCssProps({ '--sf-vd-ghost-x': `${x}px`, '--sf-vd-ghost-y': `${y}px` });
    }

    /** The pointer let go: the ghost goes, and the window's listeners with it. */
    private finishChipDrag(): void {
        this.releaseDragListeners();
        if (this.dragChipId !== null) {
            const chip = this.chips.find(entry => entry.id === this.dragChipId);
            chip?.el.removeClass('is-carrying');
        }
        this.dragChipId = null;
        this.ghostEl?.remove();
        this.ghostEl = null;
    }

    private bindDrag(el: EventTarget, type: string, handler: (event: Event) => void): void {
        const listener = handler;
        el.addEventListener(type, listener);
        this.dragBindings.push({ el, type, handler: listener });
    }

    private releaseDragListeners(): void {
        for (const binding of this.dragBindings) binding.el.removeEventListener(binding.type, binding.handler);
        this.dragBindings = [];
    }

    /** One part at a time: activating the part that is open closes it. */
    private toggleHotspot(hotspot: StudyDiagramHotspot): void {
        this.setOpenHotspot(this.openHotspotId === hotspot.id ? null : hotspot.id);
    }

    private setOpenHotspot(id: string | null): void {
        this.openHotspotId = id;
        for (const entry of this.hotspotEntries) {
            const open = entry.hotspot.id === id;
            entry.el.toggleClass('is-open', open);
            entry.el.setAttribute('aria-expanded', String(open));
        }
        const open = id === null ? null : this.diagram?.hotspots.find(candidate => candidate.id === id) ?? null;
        this.renderDetail(open);
    }

    private buildDetail(root: HTMLElement): void {
        const panel = root.createDiv('sf-vd-detail');
        panel.setAttribute('aria-live', 'polite');
        this.detailEl = panel;
        this.detailLabelEl = panel.createDiv('sf-vd-detail-label');
        this.detailTextEl = panel.createDiv('sf-vd-detail-text');
        this.renderDetail(null);
    }

    /** The open part's name and what it means; nothing while none is open. */
    private renderDetail(hotspot: StudyDiagramHotspot | null): void {
        const panel = this.detailEl;
        const label = this.detailLabelEl;
        const text = this.detailTextEl;
        if (!panel || !label || !text) return;
        panel.toggleClass('sf-vd-hidden', hotspot === null);
        if (!hotspot) {
            label.setText('');
            label.removeAttribute('title');
            text.setText('');
            return;
        }
        label.setText(hotspot.label);
        // The part's name is data, so the title carries the whole of it.
        label.setAttribute('title', hotspot.label);
        text.setText(hotspot.detail);
    }

    /** The one line the reader should leave with, marked as such. */
    private renderPearl(parent: HTMLElement, pearl: string): void {
        const line = parent.createDiv('sf-vd-pearl');
        line.createSpan({ cls: 'sf-vd-pearl-tag', text: 'Pearl' });
        line.createSpan({ cls: 'sf-vd-pearl-text', text: pearl });
    }
}
