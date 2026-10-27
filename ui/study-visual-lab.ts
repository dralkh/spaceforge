/**
 * Spaceforge Study — the lab: parameters the reader moves, drawings that answer.
 *
 * A lab teaches one relationship by being operated: the reader drags a control
 * and every answer written from that parameter is *drawn* from it — a bar that
 * grows across its own scale, a gauge whose needle swings to its angle, a shaded
 * band that says where "normal" lies, and the band's own word for whether the
 * value is inside it. The number stays, small, under the drawing: the drawing is
 * the content, and a picture read at a glance is not a sentence read slowly.
 *
 * Four decisions are load-bearing:
 *
 *  - **An answer that cannot be computed says so.** The expressions come from a
 *    model, so some of them will not read (`utils/expr.ts` returns null for
 *    anything it cannot parse or compute). The row then reads "Cannot compute",
 *    which is honest, in place of a `NaN` or a silently empty cell — and the
 *    drawing is blanked rather than left holding the last value it had.
 *  - **Nothing is recomputed from a guess.** Every input event recomputes from
 *    the parameters' current values, so outputs that read several parameters
 *    agree with each other and with the controls on screen.
 *  - **A drawing is never invented.** The scale is the asset's own where it
 *    declared one, the band (padded) where it declared a band instead, and a
 *    plain 0–100 span otherwise; there is no band to be in or out of when the
 *    asset declared none. `render: 'value'` — the rare answer that is genuinely
 *    a word — is printed, and nothing is drawn for it.
 *  - **Movement is opt-in.** The fill and the needle animate only where the host
 *    allows motion (`motionAllowed()`): a reader who asked for reduced motion,
 *    or a host with no `matchMedia` at all, gets the same drawings, drawn
 *    without animating.
 *
 * The lab owns exactly one element of its own; a teardown takes that element
 * and every listener with it, leaving the host as it was found.
 */

import { StudyLab, StudyLabOutput, StudyLabParam } from '../models/study-visuals';
import { evaluateExpression, formatNumber } from '../utils/expr';

/** What an output says when its expression cannot be evaluated. */
export const LAB_UNKNOWN_TEXT = 'Cannot compute';
/** The tag on the line the reader should leave with. */
const PEARL_TAG = 'Pearl';
/** The control that puts the asset's own starting values back. */
const RESET_LABEL = 'Reset';
/** What the score says when the reader has brought every reading home. */
export const LAB_SOLVED_TEXT = 'Solved. Every reading in range.';
/** A range control with no declared step gets a hundred positions. */
const DEFAULT_STEP_DIVISIONS = 100;
/** The smallest step worth offering, so a tiny range still moves. */
const MIN_STEP = 0.000001;
/** The span a drawn answer covers when the asset declares neither ends nor a band. */
export const LAB_DEFAULT_SCALE: readonly [number, number] = [0, 100];

/** The gauge's own drawing space, in the units of its viewBox. */
export const GAUGE_WIDTH = 240;
export const GAUGE_HEIGHT = 132;
/** The needle's pivot, and the radius of the arc it reads. */
export const GAUGE_PIVOT = { x: 120, y: 120 };
export const GAUGE_RADIUS = 96;
/** The angle the needle sits at for the low end of the scale, and for the high one. */
export const GAUGE_MIN_ANGLE = -90;
export const GAUGE_MAX_ANGLE = 90;
/** The needle stops just inside the track, so its tip is never lost in it. */
const NEEDLE_LENGTH = GAUGE_RADIUS - 8;
const GAUGE_HUB_RADIUS = 6;

interface Binding {
    el: Element;
    type: string;
    handler: EventListener;
}

/** One parameter, with the control that moves it and the number it shows. */
interface ParamView {
    param: StudyLabParam;
    input: HTMLInputElement;
    readout: HTMLElement;
}

/** The drawing half of an answer: what moves when the value moves. */
interface Drawing {
    /** The bar's fill, or null on a gauge. */
    fill: HTMLElement | null;
    /** The gauge's swinging needle, or null on a bar. */
    needle: SVGGElement | null;
    /** The span the drawing covers. */
    scale: [number, number];
}

/** One answer, with the drawing that answers and the band's verdict on it. */
interface OutputView {
    output: StudyLabOutput;
    row: HTMLElement;
    valueEl: HTMLElement;
    /** Null for a `value` answer, which is printed rather than drawn. */
    drawing: Drawing | null;
    /** The band's word for where the value sits; null when the asset declared no band. */
    verdict: HTMLElement | null;
}

/**
 * Whether the host lets things move.
 *
 * Two cases are a plain no: `prefers-reduced-motion: reduce`, and a host with no
 * `matchMedia` at all (the tests' own world, and any host that never answers).
 * The second must be a return, never a throw — the guard is the only thing
 * standing between a missing browser API and a broken surface.
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

/** A number, or null for anything that is not one. */
function numberOrNull(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Float dust removed: `0.1 + 0.2` reads as `0.3`. */
function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/** A window with a width: its ends ordered, and a zero-width one opened up. */
function openWindow(low: number, high: number): [number, number] {
    let min = low;
    let max = high;
    if (max < min) {
        const swap = min;
        min = max;
        max = swap;
    }
    if (max === min) {
        min -= 1;
        max += 1;
    }
    return [min, max];
}

/**
 * The span a drawn answer covers. It is the asset's own where it declared one,
 * the band with half a band-width of room either side where it declared a band
 * instead (so the band reads as the middle of the scale), and 0–100 otherwise.
 */
export function outputScale(output: StudyLabOutput): [number, number] {
    const low = numberOrNull(output.scaleMin);
    const high = numberOrNull(output.scaleMax);
    if (low !== null || high !== null) {
        return openWindow(low === null ? LAB_DEFAULT_SCALE[0] : low, high === null ? LAB_DEFAULT_SCALE[1] : high);
    }
    if (output.band) {
        const span = output.band[1] - output.band[0];
        return openWindow(output.band[0] - span / 2, output.band[1] + span / 2);
    }
    return [LAB_DEFAULT_SCALE[0], LAB_DEFAULT_SCALE[1]];
}

/** Where a value sits across a scale, 0 at the low end and 1 at the high one, clamped outside. */
function fractionAcross(value: number, scaleMin: number, scaleMax: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(scaleMin) || !Number.isFinite(scaleMax) || scaleMax <= scaleMin) return 0;
    return Math.min(1, Math.max(0, (value - scaleMin) / (scaleMax - scaleMin)));
}

/** Where a value sits across a scale, as a percentage the stylesheet can draw with. */
export function percentAcross(value: number, scaleMin: number, scaleMax: number): number {
    return round2(fractionAcross(value, scaleMin, scaleMax) * 100);
}

/** Where the normal band sits on a scale: the shaded region's start and width, in percent. */
export function bandRange(band: [number, number], scaleMin: number, scaleMax: number): { start: number; width: number } {
    const start = percentAcross(band[0], scaleMin, scaleMax);
    const end = percentAcross(band[1], scaleMin, scaleMax);
    return { start, width: round2(Math.max(0, end - start)) };
}

/** The needle's angle for a value: the low end of the scale is −90°, the high end +90°, clamped outside. */
export function gaugeAngle(value: number, scaleMin: number, scaleMax: number): number {
    return round2(GAUGE_MIN_ANGLE + (GAUGE_MAX_ANGLE - GAUGE_MIN_ANGLE) * fractionAcross(value, scaleMin, scaleMax));
}

/** Whether a value is inside the band the asset called normal (its own edges included). */
export function valueInBand(value: number, band: [number, number]): boolean {
    return value >= band[0] && value <= band[1];
}

/** A point on the gauge's arc: fraction 0 is the scale's low end, 1 its high end. */
function arcPoint(fraction: number): { x: number; y: number } {
    const angle = Math.PI * (1 - fraction);
    return {
        x: round2(GAUGE_PIVOT.x + GAUGE_RADIUS * Math.cos(angle)),
        y: round2(GAUGE_PIVOT.y - GAUGE_RADIUS * Math.sin(angle)),
    };
}

/** `4` / `4.5` — a value as the reader should read it, never `-0`. */
export function formatLabValue(value: number): string {
    return formatNumber(value, 3);
}

/** `12 units` — the value and its unit, with no trailing space when there is none. */
export function valueWithUnit(value: number, unit?: string): string {
    const text = formatLabValue(value);
    return unit ? `${text} ${unit}` : text;
}

/** The step a control moves by: the asset's own, or a readable hundredth of the range. */
export function stepFor(param: StudyLabParam): number {
    if (typeof param.step === 'number' && Number.isFinite(param.step) && param.step > 0) return param.step;
    const step = (param.max - param.min) / DEFAULT_STEP_DIVISIONS;
    return step > MIN_STEP ? step : MIN_STEP;
}

/** A value held inside its parameter's own range. */
export function clampToParam(param: StudyLabParam, value: number): number {
    if (!Number.isFinite(value)) return param.value;
    return Math.min(param.max, Math.max(param.min, value));
}

// ---------------------------------------------------------------- the mission

/**
 * The answers the reader is judged on: the drawn ones that carry a band.
 *
 * A band is the asset saying "here is the healthy range", and that is the only
 * thing in a lab that can be succeeded or failed. Only an answer that is
 * *drawn* counts: a printed word has no band drawn against it, so it cannot be
 * seen to be in or out. A lab with no such answer has no mission — it is a
 * sandbox, and it is drawn as one.
 */
export function bandedOutputs(outputs: StudyLabOutput[]): StudyLabOutput[] {
    return outputs.filter(output => Array.isArray(output.band) && output.band.length === 2 && (output.render ?? 'bar') !== 'value');
}

/** The goal in the asset's own words, or the derived one when it gave none. */
export function missionText(lab: StudyLab): string | null {
    const targets = bandedOutputs(lab.outputs);
    if (targets.length === 0) return null;
    if (lab.mission) return lab.mission;
    if (targets.length === 1) return `Bring ${targets[0].label} into its band.`;
    return 'Bring every reading into its band.';
}

/** What the score line says for this many readings in range. */
export function missionScoreText(inRange: number, total: number): string {
    if (total > 0 && inRange >= total) return LAB_SOLVED_TEXT;
    return `${Math.max(0, inRange)} of ${total} in range`;
}

/** One answer's value in the mission's own count, or null when it cannot be read. */
export function countInBand(entries: { output: StudyLabOutput; value: number | null }[]): number {
    let inRange = 0;
    for (const entry of entries) {
        if (entry.value === null || !entry.output.band) continue;
        if (valueInBand(entry.value, entry.output.band)) inRange += 1;
    }
    return inRange;
}

export class StudyVisualLabView {
    private root: HTMLElement | null = null;
    private paramsView: ParamView[] = [];
    private outputsView: OutputView[] = [];
    private values = new Map<string, number>();
    private onStateChange?: (values: Record<string, number>) => void;
    private bindings: Binding[] = [];
    /** The score line of the mission, and how many readings it counts. */
    private scoreEl: HTMLElement | null = null;
    private missionTotal = 0;

    mount(container: HTMLElement, lab: StudyLab, state: { values?: Record<string, number>; onChange?: (values: Record<string, number>) => void } = {}): () => void {
        this.unmount();
        this.onStateChange = undefined;
        const root = container.createDiv('sf-lab');
        this.root = root;
        // Movement is opt-in: a reader who asked for reduced motion gets the same
        // drawings, drawn where they belong without travelling there.
        if (motionAllowed()) root.addClass('is-motion');

        // The one thing the lab should make the reader see, as the lead-in.
        if (lab.teach) root.createDiv({ cls: 'sf-lab-teach', text: lab.teach });

        // The goal first: the reader should know what they are solving before
        // they touch a control, and the score answers on every move.
        this.renderMission(root, lab);

        const paramsBox = root.createDiv('sf-lab-params');
        for (const param of lab.params) this.renderParam(paramsBox, param);

        const outputsBox = root.createDiv('sf-lab-outputs');
        for (const output of lab.outputs) this.renderOutput(outputsBox, output);

        if (lab.presets && lab.presets.length > 0) this.renderPresets(root, lab);

        const actions = root.createDiv('sf-lab-actions');
        const reset = actions.createEl('button', { cls: 'sf-lab-reset', text: RESET_LABEL });
        reset.setAttribute('type', 'button');
        reset.setAttribute('title', 'Put the starting values back');
        this.bind(reset, 'click', () => this.resetToStart(lab));

        if (lab.pearl) this.renderPearl(root, lab.pearl);

        // First paint: the readouts and the drawings belong to the values on
        // screen the moment the lab exists, not to the first time a control moves.
        for (const param of lab.params) {
            const value = state.values?.[param.id];
            if (typeof value === 'number' && Number.isFinite(value)) this.setParam(param, String(value));
        }
        this.onStateChange = state.onChange;
        this.update();

        return () => this.unmount();
    }

    unmount(): void {
        for (const binding of this.bindings) binding.el.removeEventListener(binding.type, binding.handler);
        this.bindings = [];
        this.paramsView = [];
        this.outputsView = [];
        this.values.clear();
        this.scoreEl = null;
        this.missionTotal = 0;
        this.root?.remove();
        this.root = null;
    }

    // -------------------------------------------------------------- markup

    /**
     * The mission: what the reader is trying to achieve, and how far off they
     * are. It exists only when an answer carries a band — the thing success is
     * defined against — and its score is a live region, because the count
     * changing is the whole feedback loop of the lab.
     */
    private renderMission(root: HTMLElement, lab: StudyLab): void {
        const text = missionText(lab);
        if (text === null) return;
        this.missionTotal = bandedOutputs(lab.outputs).length;
        const box = root.createDiv('sf-lab-mission');
        box.createDiv({ cls: 'sf-lab-mission-text', text });
        this.scoreEl = box.createDiv('sf-lab-mission-score');
        this.scoreEl.setAttribute('aria-live', 'polite');
    }

    /** One parameter: its name, its current value with unit, and its control. */
    private renderParam(parent: HTMLElement, param: StudyLabParam): void {
        this.values.set(param.id, param.value);

        const row = parent.createDiv('sf-lab-param');
        row.setAttribute('data-param-id', param.id);

        const head = row.createDiv('sf-lab-param-head');
        head.createDiv({ cls: 'sf-lab-param-label', text: param.label });
        const readout = head.createDiv('sf-lab-param-readout');
        readout.setAttribute('aria-hidden', 'true');

        const input = row.createEl('input', { cls: 'sf-lab-range' });
        // The type is set as an attribute rather than left to the element
        // helper's own option object, so the control is a range in every host
        // (the test harness's stand-in ignores options it does not model).
        input.setAttribute('type', 'range');
        input.setAttribute('min', String(param.min));
        input.setAttribute('max', String(param.max));
        input.setAttribute('step', String(stepFor(param)));
        input.setAttribute('aria-label', param.unit ? `${param.label} (${param.unit})` : param.label);
        input.setAttribute('value', String(param.value));
        input.value = String(param.value);
        this.bind(input, 'input', () => this.setParam(param, input.value));

        this.paramsView.push({ param, input, readout });
    }

    /**
     * One answer: what it is called, the drawing that answers it, the number
     * under the drawing, and the band's word for where the value sits.
     */
    private renderOutput(parent: HTMLElement, output: StudyLabOutput): void {
        const render = output.render ?? 'bar';
        const row = parent.createDiv('sf-lab-output');
        row.setAttribute('data-output-id', output.id);
        row.setAttribute('data-render', render);
        row.createDiv({ cls: 'sf-lab-output-label', text: output.label });

        const drawing = this.renderDrawing(row, output, render);

        const foot = row.createDiv('sf-lab-output-foot');
        const valueEl = foot.createDiv('sf-lab-output-value');
        valueEl.setAttribute('aria-live', 'polite');
        // The verdict belongs to the drawing, so an answer with no drawing has
        // no band to be in or out of — what a word answer declares by way of a
        // band is not invented as a sentence here.
        const verdict = output.band && drawing ? foot.createDiv('sf-lab-verdict') : null;
        if (verdict) {
            verdict.addClass('is-hidden');
            verdict.setAttribute('aria-live', 'polite');
        }

        // The note is the formula's own explanation, so it stays even when the
        // value cannot be computed — it is what tells the reader what the row is for.
        if (output.note) row.createDiv({ cls: 'sf-lab-output-note', text: output.note });
        this.outputsView.push({ output, row, valueEl, drawing, verdict });
    }

    /** The drawing an answer gets: a bar by default, a gauge when asked for, nothing for a printed answer. */
    private renderDrawing(row: HTMLElement, output: StudyLabOutput, render: 'bar' | 'gauge' | 'value'): Drawing | null {
        if (render === 'value') return null;
        const scale = outputScale(output);
        const draw = row.createDiv('sf-lab-draw');
        draw.setAttribute('aria-hidden', 'true');
        if (render === 'gauge') return this.renderGauge(draw, output, scale);
        return this.renderBar(draw, output, scale);
    }

    /** A bar: a track across the whole scale, the band shaded on it, and a fill that grows to the value. */
    private renderBar(draw: HTMLElement, output: StudyLabOutput, scale: [number, number]): Drawing {
        const track = draw.createDiv('sf-lab-bar');
        const fill = track.createDiv('sf-lab-bar-fill');
        if (output.band) {
            const range = bandRange(output.band, scale[0], scale[1]);
            const band = track.createDiv('sf-lab-bar-band');
            // Placed through custom properties, so the stylesheet owns the look
            // and the width it decides is the one that moves.
            band.setCssProps({
                '--sf-lab-band-start': `${range.start}%`,
                '--sf-lab-band-width': `${range.width}%`,
            });
        }
        return { fill, needle: null, scale };
    }

    /** A gauge: an arc across the scale, the band shaded on it, and a needle that swings to the value. */
    private renderGauge(draw: HTMLElement, output: StudyLabOutput, scale: [number, number]): Drawing {
        const svg = draw.createSvg('svg', {
            cls: 'sf-lab-gauge-svg',
            attr: { viewBox: `0 0 ${GAUGE_WIDTH} ${GAUGE_HEIGHT}`, focusable: 'false' },
        });
        const track = arcPoint(0);
        const end = arcPoint(1);
        this.arc(svg, 'sf-lab-gauge-track', track, end, 0);
        if (output.band) {
            const from = fractionAcross(output.band[0], scale[0], scale[1]);
            const to = fractionAcross(output.band[1], scale[0], scale[1]);
            this.arc(svg, 'sf-lab-gauge-band', arcPoint(Math.min(from, to)), arcPoint(Math.max(from, to)), Math.abs(to - from));
        }

        const needle = svg.createSvg('g', { cls: 'sf-lab-gauge-needle' });
        // The pivot the needle turns about, handed to the stylesheet: the CSS
        // rotation is the one that animates, and the attribute set on every
        // update carries the same angle so the drawing is right even where the
        // rotation is not animated.
        needle.setCssProps({ '--sf-lab-needle-origin': `${GAUGE_PIVOT.x}px ${GAUGE_PIVOT.y}px` });
        needle.createSvg('line', {
            cls: 'sf-lab-gauge-spoke',
            attr: {
                x1: String(GAUGE_PIVOT.x),
                y1: String(GAUGE_PIVOT.y),
                x2: String(GAUGE_PIVOT.x),
                y2: String(GAUGE_PIVOT.y - NEEDLE_LENGTH),
            },
        });
        needle.createSvg('circle', {
            cls: 'sf-lab-gauge-hub',
            attr: { cx: String(GAUGE_PIVOT.x), cy: String(GAUGE_PIVOT.y), r: String(GAUGE_HUB_RADIUS) },
        });

        const ends = draw.createDiv('sf-lab-gauge-ends');
        ends.createSpan({ cls: 'sf-lab-gauge-min', text: formatLabValue(scale[0]) });
        ends.createSpan({ cls: 'sf-lab-gauge-max', text: formatLabValue(scale[1]) });
        return { fill: null, needle, scale };
    }

    /** One arc of the gauge, between two points on it. */
    private arc(parent: Element, cls: string, from: { x: number; y: number }, to: { x: number; y: number }, span: number): SVGPathElement {
        const large = span > 0.5 ? 1 : 0;
        return parent.createSvg('path', {
            cls,
            attr: { d: `M ${from.x} ${from.y} A ${GAUGE_RADIUS} ${GAUGE_RADIUS} 0 ${large} 1 ${to.x} ${to.y}`, fill: 'none' },
        });
    }

    /** The named settings worth trying: one press puts every parameter it names there. */
    private renderPresets(root: HTMLElement, lab: StudyLab): void {
        const box = root.createDiv('sf-lab-presets');
        for (const preset of lab.presets ?? []) {
            const button = box.createEl('button', { cls: 'sf-lab-preset', text: preset.label });
            button.setAttribute('type', 'button');
            this.bind(button, 'click', () => this.applyPreset(lab, preset.values));
        }
    }

    private renderPearl(parent: HTMLElement, pearl: string): void {
        const line = parent.createDiv('sf-lab-pearl');
        line.createSpan({ cls: 'sf-lab-pearl-tag', text: PEARL_TAG });
        line.createSpan({ cls: 'sf-lab-pearl-text', text: pearl });
    }

    private bind(el: Element, type: string, handler: (event: Event) => void): void {
        const listener = handler;
        el.addEventListener(type, listener);
        this.bindings.push({ el, type, handler: listener });
    }

    // ----------------------------------------------------------- behaviour

    /** A control moved: hold the value inside its range, then recompute. */
    private setParam(param: StudyLabParam, raw: string | number): void {
        const parsed = typeof raw === 'number' ? raw : Number.parseFloat(raw);
        if (!Number.isFinite(parsed)) return;
        this.hold(param, clampToParam(param, parsed));
        this.update();
    }

    /** A preset: every parameter it names moves; the others stay where they are. */
    private applyPreset(lab: StudyLab, values: Record<string, number>): void {
        for (const param of lab.params) {
            const wanted = values[param.id];
            if (typeof wanted !== 'number' || !Number.isFinite(wanted)) continue;
            this.hold(param, clampToParam(param, wanted));
        }
        this.update();
    }

    /** Reset: the asset's own starting values, exactly as it declared them. */
    private resetToStart(lab: StudyLab): void {
        for (const param of lab.params) this.hold(param, clampToParam(param, param.value));
        this.update();
    }

    /** Put one parameter at a value, in the model and in the control. */
    private hold(param: StudyLabParam, value: number): void {
        this.values.set(param.id, value);
        const view = this.paramsView.find(candidate => candidate.param.id === param.id);
        if (!view) return;
        const text = String(value);
        if (view.input.value !== text) view.input.value = text;
    }

    /**
     * Recompute everything the lab shows from the current parameter values, in
     * one pass: the number beside each control, every answer's drawing, the
     * band's verdict on it, and the mission's own count. One pass, so an answer
     * that reads several parameters cannot disagree with the controls the
     * reader is looking at.
     */
    private update(): void {
        const variables: Record<string, number> = {};
        for (const [id, value] of this.values) variables[id] = value;
        this.onStateChange?.({ ...variables });

        for (const view of this.paramsView) {
            const value = this.values.get(view.param.id) ?? view.param.value;
            view.readout.setText(valueWithUnit(value, view.param.unit));
        }

        const mission: { output: StudyLabOutput; value: number | null }[] = [];
        for (const view of this.outputsView) {
            const value = evaluateExpression(view.output.expression, variables);
            if (view.output.band && view.drawing) mission.push({ output: view.output, value });
            // A value that could not be computed leaves the drawing blank: the
            // last number it had is not an answer to the question on screen.
            this.moveDrawing(view.drawing, value);
            if (value === null) {
                view.valueEl.setText(LAB_UNKNOWN_TEXT);
                view.row.addClass('is-unknown');
                this.showVerdict(view, null);
                continue;
            }
            view.valueEl.setText(valueWithUnit(value, view.output.unit));
            view.row.removeClass('is-unknown');
            this.showVerdict(view, value);
        }

        this.updateMission(mission);
    }

    /**
     * The score, and the solved state that goes with it.
     *
     * Success is not announced by a toast or a dialog — the lab is a surface,
     * not a wizard — but the reader sees it happen where they are looking: the
     * score line turns over, and the mission's own bar changes tone. Both are
     * states on the elements that already exist, so nothing moves.
     */
    private updateMission(entries: { output: StudyLabOutput; value: number | null }[]): void {
        if (!this.scoreEl || this.missionTotal === 0) return;
        const inRange = countInBand(entries);
        const solved = inRange >= this.missionTotal;
        this.scoreEl.setText(missionScoreText(inRange, this.missionTotal));
        this.root?.toggleClass('is-solved', solved);
        this.scoreEl.toggleClass('is-solved', solved);
    }

    /** Put a drawing at a value; a value that could not be computed leaves it blank. */
    private moveDrawing(drawing: Drawing | null, value: number | null): void {
        if (!drawing) return;
        const [min, max] = drawing.scale;
        drawing.fill?.setCssProps({ '--sf-lab-fill': `${value === null ? 0 : percentAcross(value, min, max)}%` });
        if (drawing.needle) {
            const angle = value === null ? GAUGE_MIN_ANGLE : gaugeAngle(value, min, max);
            drawing.needle.setAttribute('transform', `rotate(${angle} ${GAUGE_PIVOT.x} ${GAUGE_PIVOT.y})`);
            drawing.needle.setCssProps({ '--sf-lab-needle-angle': `${angle}deg` });
        }
    }

    /**
     * The band's verdict, in the band's own words: inside the band the drawing
     * keeps its tone and says what inside means, outside it switches to the
     * warning tone and says what that means. `null` is no verdict to give.
     */
    private showVerdict(view: OutputView, value: number | null): void {
        const band = view.output.band;
        const verdict = view.verdict;
        if (!band || !verdict) return;
        view.row.removeClass('is-in-band');
        view.row.removeClass('is-out-of-band');
        if (value === null) {
            verdict.setText('');
            verdict.addClass('is-hidden');
            return;
        }
        const inside = valueInBand(value, band);
        view.row.addClass(inside ? 'is-in-band' : 'is-out-of-band');
        const label = inside ? view.output.insideLabel : view.output.outsideLabel;
        if (label) {
            verdict.setText(label);
            verdict.removeClass('is-hidden');
        } else {
            verdict.setText('');
            verdict.addClass('is-hidden');
        }
    }
}
