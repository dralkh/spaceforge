/**
 * Spaceforge Study — visual learning material.
 *
 * A note's material is charted into objectives; these are the *other* three
 * shapes the same material takes, each chosen because the evidence for it is
 * different from the evidence for prose:
 *
 *  - a **mind map**: one hierarchy of the whole topic, for seeing the shape of a
 *    subject before its parts (Novak-style concept mapping, Buzan-style radial
 *    layout — the tree is what matters, the drawing is presentation);
 *  - a **visual board**: the forms a discipline actually reasons in — a
 *    comparison matrix, a decision flow, a cycle, a timeline — because
 *    medicine reasons in differentials, law in element tests, biochemistry in
 *    pathways, and history in sequence;
 *  - a **summary**: condensed bullets whose count scales with how much material
 *    there is, each pearl kept.
 *
 * Everything here is pure data with defensive coercion: a model returns JSON,
 * and this file is where that JSON becomes something the UI can trust. No
 * Obsidian import, so the whole vocabulary is testable without a DOM.
 */

export const STUDY_VISUAL_VERSION = 1;

/**
 * The forms a visual board can take.
 *
 * The first five *show* structure. The four below are the ones the reader can
 * *operate*, which is what the visualise surface is for: a lab whose parameters
 * move and whose outputs answer, a diagram whose parts open when clicked, a
 * sequence that can be shuffled and put back in order, a graph whose points
 * answer on hover. None of them restates the mind map or the summary — each
 * teaches one thing by being used.
 */
export type StudyVisualKind = 'matrix' | 'compare' | 'flow' | 'cycle' | 'timeline' | 'lab' | 'diagram' | 'sequence' | 'graph';

/** A parameter the reader can move. */
export interface StudyLabParam {
    id: string;
    label: string;
    unit?: string;
    min: number;
    max: number;
    step?: number;
    /** Where the control starts. */
    value: number;
}

/**
 * An answer computed from the parameters, as a safe arithmetic expression.
 *
 * An answer is *drawn*, not printed: the reader moves a control and a bar
 * grows, a gauge swings, a band turns red. `render: 'value'` exists for the
 * rare answer that is genuinely a word (a name, a category), not as a default.
 */
export interface StudyLabOutput {
    id: string;
    label: string;
    unit?: string;
    /** Identifiers are the parameter ids; see utils/expr.ts for what is allowed. */
    expression: string;
    note?: string;
    /** How the answer is drawn. Defaults to a bar. */
    render?: 'bar' | 'gauge' | 'value';
    /** The span the bar or gauge covers; omit and the drawing picks one. */
    scaleMin?: number;
    scaleMax?: number;
    /** The normal band. An answer outside it is drawn as out of band. */
    band?: [number, number];
    /** What the reader should conclude inside the band. */
    insideLabel?: string;
    /** And outside it. */
    outsideLabel?: string;
}

export interface StudyLab {
    kind: 'lab';
    title: string;
    /** The one thing this lab should make the reader see. */
    teach: string;
    /**
     * The goal the reader works toward, in one line: the controls are a task,
     * not a tour. The default is derived from the answers' bands ("bring every
     * reading into its band"), so a lab with a band always has a game.
     */
    mission?: string;
    params: StudyLabParam[];
    outputs: StudyLabOutput[];
    /** Named settings worth trying ("metabolic acidosis", "compensated"). */
    presets?: { label: string; values: Record<string, number> }[];
    pearl?: string;
}

/** A shape in the diagram's own 0–100 space; the renderer scales it. */
export interface StudyDiagramShape {
    id: string;
    kind: 'box' | 'ellipse' | 'arrow' | 'label';
    x: number;
    y: number;
    w?: number;
    h?: number;
    /** For arrows: where it points. */
    x2?: number;
    y2?: number;
    text?: string;
    tone?: 'primary' | 'muted' | 'accent';
    /** An arrow with `flow` carries travelling motion along itself. */
    flow?: boolean;
    /** A shape with `pulse` breathes, for the part the reader should watch. */
    pulse?: boolean;
}

/** A part of the diagram that opens when clicked. */
export interface StudyDiagramHotspot {
    id: string;
    label: string;
    x: number;
    y: number;
    detail: string;
}

export interface StudyDiagram {
    kind: 'diagram';
    title: string;
    teach: string;
    shapes: StudyDiagramShape[];
    hotspots: StudyDiagramHotspot[];
    caption?: string;
    pearl?: string;
}

/** An order the reader can put back together. */
export interface StudySequenceStep {
    id: string;
    label: string;
    detail?: string;
}

export interface StudySequence {
    kind: 'sequence';
    title: string;
    teach: string;
    steps: StudySequenceStep[];
    /** True when the reader should be given them shuffled to reorder. */
    shuffle?: boolean;
    pearl?: string;
}

export interface StudyGraphPoint {
    x: number;
    y: number;
    label?: string;
}

export interface StudyGraphSeries {
    id: string;
    label: string;
    tone?: 'primary' | 'accent' | 'muted';
    points: StudyGraphPoint[];
}

export interface StudyGraph {
    kind: 'graph';
    title: string;
    teach: string;
    xLabel?: string;
    yLabel?: string;
    series: StudyGraphSeries[];
    xMin?: number;
    xMax?: number;
    yMin?: number;
    yMax?: number;
    pearl?: string;
}

/** A node in the mind map: a label, an optional one-line detail, children. */
export interface StudyMindMapNode {
    id: string;
    label: string;
    /** The line that makes the label mean something; kept short by prompt. */
    detail?: string;
    children?: StudyMindMapNode[];
}

export interface StudyMindMap {
    title: string;
    root: StudyMindMapNode;
}

/** A row of a comparison matrix: a thing, and what it is like in each column. */
export interface StudyMatrixRow {
    label: string;
    cells: string[];
    /** True for the row that is the point of the comparison. */
    emphasis?: boolean;
    /**
     * A visual verdict for the row, drawn as a mark rather than a sentence:
     * `better`, `worse`, `equal`, or none. Comparisons are read at a glance or
     * they are not read at all.
     */
    mark?: 'better' | 'worse' | 'equal';
}

export interface StudyMatrix {
    kind: 'matrix' | 'compare';
    title: string;
    columns: string[];
    rows: StudyMatrixRow[];
    /** One line the reader should leave with. */
    pearl?: string;
}

/** A step in a flow or a cycle; `decision` steps carry labelled branches. */
export interface StudyFlowStep {
    id: string;
    label: string;
    detail?: string;
    kind?: 'step' | 'decision' | 'outcome';
    branches?: { label: string; to: string }[];
}

export interface StudyFlow {
    kind: 'flow' | 'cycle';
    title: string;
    teach?: string;
    steps: StudyFlowStep[];
    /**
     * How the process moves when nobody is touching it: `flow` walks the steps,
     * `cycle` goes round, `none` waits to be stepped. A process that cannot be
     * watched moving is a list.
     */
    motion?: 'flow' | 'cycle' | 'pulse' | 'none';
    pearl?: string;
}

export interface StudyTimelineEntry {
    when: string;
    label: string;
    detail?: string;
}

export interface StudyTimeline {
    kind: 'timeline';
    title: string;
    entries: StudyTimelineEntry[];
    pearl?: string;
}

export type StudyVisual = StudyMatrix | StudyFlow | StudyTimeline | StudyLab | StudyDiagram | StudySequence | StudyGraph;

/** A bullet: the claim, and the pearls marked so they survive condensing. */
export interface StudyBullet {
    text: string;
    /** `pearl` is the thing worth remembering after everything else is gone. */
    emphasis?: 'pearl' | 'normal';
    /** Sub-points, one level only. */
    children?: string[];
}

export interface StudySummary {
    title: string;
    bullets: StudyBullet[];
    /** What the model was asked to keep, echoed for the reader. */
    kept?: string;
}

/**
 * Everything generated for one note, stored beside the plan.
 *
 * `sourceHash` is the chart's own hash of the note text: material generated from
 * a note that has since changed is stale, and the UI says so rather than showing
 * a map of a document that no longer exists.
 */
export interface StudyVisualPack {
    version: number;
    domain: string;
    mindMap: StudyMindMap;
    visuals: StudyVisual[];
    summary: StudySummary;
    generatedAt: number;
    sourceHash: string;
}

/**
 * How many summary bullets the material has earned.
 *
 * The reader asked for a summary "dynamic to the amount of material itself", so
 * this scales with the work in the note rather than being a fixed list: one
 * bullet per objective as a floor, a few more when the material is dense, and a
 * ceiling so a summary never becomes a second copy of the note. A one-objective
 * note gets a paragraph's worth; a forty-objective one gets a page, not forty
 * pages.
 */
export function bulletBudget(objectiveCount: number, sectionCount: number, characters: number): number {
    const objectives = Math.max(0, Math.floor(objectiveCount));
    const sections = Math.max(0, Math.floor(sectionCount));
    const volume = Math.max(0, characters) / 4000;
    const earned = Math.ceil(objectives * 1.1 + sections * 0.5 + volume);
    return Math.max(3, Math.min(24, earned));
}

/**
 * How many interactive assets a note has earned.
 *
 * Visualise is a gallery, not a page: three assets is the floor that makes it a
 * gallery, five is where a reader stops operating them and starts scrolling.
 */
export function assetBudget(objectiveCount: number): number {
    const objectives = Math.max(0, Math.floor(objectiveCount));
    return Math.max(3, Math.min(5, Math.ceil(objectives / 3) + 1));
}

/** How many matrix rows / flow steps the material has earned, within reason. */
export function visualBudget(objectiveCount: number): number {
    const objectives = Math.max(0, Math.floor(objectiveCount));
    return Math.max(3, Math.min(10, Math.ceil(objectives / 2) + 2));
}

// ------------------------------------------------------------------ coercion

function asString(value: unknown, max = 240): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function coerceNode(raw: unknown, depth: number): StudyMindMapNode | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const label = asString(source.label, 120) ?? asString(source.title, 120);
    if (!label) return null;
    const node: StudyMindMapNode = { id: asString(source.id, 60) ?? label, label };
    const detail = asString(source.detail, 220);
    if (detail) node.detail = detail;
    if (depth < 4) {
        const children = asArray(source.children).map(child => coerceNode(child, depth + 1)).filter((child): child is StudyMindMapNode => child !== null);
        if (children.length > 0) node.children = children.slice(0, 12);
    }
    return node;
}

function coerceMatrix(raw: Record<string, unknown>): StudyMatrix | null {
    const columns = asArray(raw.columns).map(column => asString(column, 60)).filter((column): column is string => column !== null).slice(0, 6);
    if (columns.length < 2) return null;
    const rows: StudyMatrixRow[] = [];
    for (const entry of asArray(raw.rows).slice(0, 12)) {
        if (!entry || typeof entry !== 'object') continue;
        const row = entry as Record<string, unknown>;
        const label = asString(row.label, 90);
        if (!label) continue;
        const cells = asArray(row.cells).map(cell => asString(cell, 160) ?? '').slice(0, columns.length);
        while (cells.length < columns.length) cells.push('');
        const marked: StudyMatrixRow = { label, cells, emphasis: row.emphasis === true };
        if (row.mark === 'better' || row.mark === 'worse' || row.mark === 'equal') marked.mark = row.mark;
        rows.push(marked);
    }
    if (rows.length < 2) return null;
    const matrix: StudyMatrix = { kind: raw.kind === 'compare' ? 'compare' : 'matrix', title: asString(raw.title, 120) ?? 'Comparison', columns, rows };
    const pearl = asString(raw.pearl, 200);
    if (pearl) matrix.pearl = pearl;
    return matrix;
}

function coerceFlow(raw: Record<string, unknown>): StudyFlow | null {
    const steps: StudyFlowStep[] = [];
    for (const entry of asArray(raw.steps).slice(0, 14)) {
        if (!entry || typeof entry !== 'object') continue;
        const step = entry as Record<string, unknown>;
        const label = asString(step.label, 120);
        if (!label) continue;
        const coerced: StudyFlowStep = { id: asString(step.id, 60) ?? label, label };
        const detail = asString(step.detail, 200);
        if (detail) coerced.detail = detail;
        if (step.kind === 'decision' || step.kind === 'outcome' || step.kind === 'step') coerced.kind = step.kind;
        const branches = asArray(step.branches)
            .map(branch => {
                if (!branch || typeof branch !== 'object') return null;
                const source = branch as Record<string, unknown>;
                const branchLabel = asString(source.label, 60);
                const to = asString(source.to, 60);
                return branchLabel && to ? { label: branchLabel, to } : null;
            })
            .filter((branch): branch is { label: string; to: string } => branch !== null)
            .slice(0, 4);
        if (branches.length > 0) coerced.branches = branches;
        steps.push(coerced);
    }
    if (steps.length < 3) return null;
    const flow: StudyFlow = { kind: raw.kind === 'cycle' ? 'cycle' : 'flow', title: asString(raw.title, 120) ?? 'Process', steps };
    const teach = asString(raw.teach, 200);
    if (teach) flow.teach = teach;
    if (raw.motion === 'flow' || raw.motion === 'cycle' || raw.motion === 'pulse' || raw.motion === 'none') flow.motion = raw.motion;
    const pearl = asString(raw.pearl, 200);
    if (pearl) flow.pearl = pearl;
    return flow;
}

function coerceTimeline(raw: Record<string, unknown>): StudyTimeline | null {
    const entries: StudyTimelineEntry[] = [];
    for (const entry of asArray(raw.entries).slice(0, 16)) {
        if (!entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;
        const when = asString(source.when, 60);
        const label = asString(source.label, 120);
        if (!when || !label) continue;
        const coerced: StudyTimelineEntry = { when, label };
        const detail = asString(source.detail, 200);
        if (detail) coerced.detail = detail;
        entries.push(coerced);
    }
    if (entries.length < 2) return null;
    const timeline: StudyTimeline = { kind: 'timeline', title: asString(raw.title, 120) ?? 'Sequence', entries };
    const pearl = asString(raw.pearl, 200);
    if (pearl) timeline.pearl = pearl;
    return timeline;
}

function asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function coerceLab(raw: Record<string, unknown>): StudyLab | null {
    const params: StudyLabParam[] = [];
    for (const entry of asArray(raw.params).slice(0, 6)) {
        if (!entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;
        const id = asString(source.id, 40);
        const label = asString(source.label, 60);
        const min = asNumber(source.min);
        const max = asNumber(source.max);
        const value = asNumber(source.value);
        if (!id || !label || min === null || max === null || value === null || max <= min) continue;
        const param: StudyLabParam = { id, label, min, max, value };
        const unit = asString(source.unit, 20);
        if (unit) param.unit = unit;
        const step = asNumber(source.step);
        if (step !== null && step > 0) param.step = step;
        params.push(param);
    }
    if (params.length === 0) return null;
    const outputs: StudyLabOutput[] = [];
    for (const entry of asArray(raw.outputs).slice(0, 4)) {
        if (!entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;
        const id = asString(source.id, 40);
        const label = asString(source.label, 80);
        const expression = asString(source.expression, 200);
        if (!id || !label || !expression) continue;
        const output: StudyLabOutput = { id, label, expression };
        const unit = asString(source.unit, 20);
        if (unit) output.unit = unit;
        const note = asString(source.note, 160);
        if (note) output.note = note;
        if (source.render === 'bar' || source.render === 'gauge' || source.render === 'value') output.render = source.render;
        const scaleMin = asNumber(source.scaleMin);
        const scaleMax = asNumber(source.scaleMax);
        if (scaleMin !== null) output.scaleMin = scaleMin;
        if (scaleMax !== null) output.scaleMax = scaleMax;
        const band = asArray(source.band);
        if (band.length === 2) {
            const low = asNumber(band[0]);
            const high = asNumber(band[1]);
            if (low !== null && high !== null && high > low) output.band = [low, high];
        }
        const insideLabel = asString(source.insideLabel, 80);
        const outsideLabel = asString(source.outsideLabel, 80);
        if (insideLabel) output.insideLabel = insideLabel;
        if (outsideLabel) output.outsideLabel = outsideLabel;
        outputs.push(output);
    }
    if (outputs.length === 0) return null;
    const lab: StudyLab = { kind: 'lab', title: asString(raw.title, 120) ?? 'Try it', teach: asString(raw.teach, 200) ?? '', params, outputs };
    const mission = asString(raw.mission, 160);
    if (mission) lab.mission = mission;
    const presets = asArray(raw.presets)
        .map(entry => {
            if (!entry || typeof entry !== 'object') return null;
            const source = entry as Record<string, unknown>;
            const label = asString(source.label, 60);
            const valuesRaw = source.values && typeof source.values === 'object' ? (source.values as Record<string, unknown>) : {};
            const values: Record<string, number> = {};
            for (const [key, value] of Object.entries(valuesRaw)) {
                const parsed = asNumber(value);
                if (parsed !== null) values[key] = parsed;
            }
            return label && Object.keys(values).length > 0 ? { label, values } : null;
        })
        .filter((preset): preset is { label: string; values: Record<string, number> } => preset !== null)
        .slice(0, 4);
    if (presets.length > 0) lab.presets = presets;
    const pearl = asString(raw.pearl, 200);
    if (pearl) lab.pearl = pearl;
    return lab;
}

function coerceDiagram(raw: Record<string, unknown>): StudyDiagram | null {
    const shapes: StudyDiagramShape[] = [];
    for (const entry of asArray(raw.shapes).slice(0, 30)) {
        if (!entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;
        const id = asString(source.id, 40);
        const x = asNumber(source.x);
        const y = asNumber(source.y);
        const kind = source.kind;
        if (!id || x === null || y === null) continue;
        if (kind !== 'box' && kind !== 'ellipse' && kind !== 'arrow' && kind !== 'label') continue;
        const shape: StudyDiagramShape = { id, kind, x, y };
        const w = asNumber(source.w);
        const h = asNumber(source.h);
        const x2 = asNumber(source.x2);
        const y2 = asNumber(source.y2);
        if (w !== null) shape.w = w;
        if (h !== null) shape.h = h;
        if (x2 !== null) shape.x2 = x2;
        if (y2 !== null) shape.y2 = y2;
        const text = asString(source.text, 80);
        if (text) shape.text = text;
        if (source.tone === 'primary' || source.tone === 'accent' || source.tone === 'muted') shape.tone = source.tone;
        if (source.flow === true) shape.flow = true;
        if (source.pulse === true) shape.pulse = true;
        shapes.push(shape);
    }
    const hotspots: StudyDiagramHotspot[] = [];
    for (const entry of asArray(raw.hotspots).slice(0, 12)) {
        if (!entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;
        const id = asString(source.id, 40);
        const label = asString(source.label, 60);
        const x = asNumber(source.x);
        const y = asNumber(source.y);
        const detail = asString(source.detail, 240);
        if (!id || !label || x === null || y === null || !detail) continue;
        hotspots.push({ id, label, x, y, detail });
    }
    if (shapes.length === 0) return null;
    const diagram: StudyDiagram = { kind: 'diagram', title: asString(raw.title, 120) ?? 'Diagram', teach: asString(raw.teach, 200) ?? '', shapes, hotspots };
    const caption = asString(raw.caption, 200);
    if (caption) diagram.caption = caption;
    const pearl = asString(raw.pearl, 200);
    if (pearl) diagram.pearl = pearl;
    return diagram;
}

function coerceSequence(raw: Record<string, unknown>): StudySequence | null {
    const steps: StudySequenceStep[] = [];
    for (const entry of asArray(raw.steps).slice(0, 12)) {
        if (!entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;
        const id = asString(source.id, 40);
        const label = asString(source.label, 120);
        if (!id || !label) continue;
        const step: StudySequenceStep = { id, label };
        const detail = asString(source.detail, 200);
        if (detail) step.detail = detail;
        steps.push(step);
    }
    if (steps.length < 3) return null;
    const sequence: StudySequence = { kind: 'sequence', title: asString(raw.title, 120) ?? 'Order it', teach: asString(raw.teach, 200) ?? '', steps };
    if (raw.shuffle === true) sequence.shuffle = true;
    const pearl = asString(raw.pearl, 200);
    if (pearl) sequence.pearl = pearl;
    return sequence;
}

function coerceGraph(raw: Record<string, unknown>): StudyGraph | null {
    const series: StudyGraphSeries[] = [];
    for (const entry of asArray(raw.series).slice(0, 4)) {
        if (!entry || typeof entry !== 'object') continue;
        const source = entry as Record<string, unknown>;
        const id = asString(source.id, 40);
        const label = asString(source.label, 60);
        if (!id || !label) continue;
        const points: StudyGraphPoint[] = [];
        for (const point of asArray(source.points).slice(0, 40)) {
            if (!point || typeof point !== 'object') continue;
            const coordinates = point as Record<string, unknown>;
            const x = asNumber(coordinates.x);
            const y = asNumber(coordinates.y);
            if (x === null || y === null) continue;
            const labelled: StudyGraphPoint = { x, y };
            const pointLabel = asString(coordinates.label, 40);
            if (pointLabel) labelled.label = pointLabel;
            points.push(labelled);
        }
        if (points.length < 2) continue;
        const coerced: StudyGraphSeries = { id, label, points };
        if (source.tone === 'primary' || source.tone === 'accent' || source.tone === 'muted') coerced.tone = source.tone;
        series.push(coerced);
    }
    if (series.length === 0) return null;
    const graph: StudyGraph = { kind: 'graph', title: asString(raw.title, 120) ?? 'Graph', teach: asString(raw.teach, 200) ?? '', series };
    const xLabel = asString(raw.xLabel, 40);
    const yLabel = asString(raw.yLabel, 40);
    if (xLabel) graph.xLabel = xLabel;
    if (yLabel) graph.yLabel = yLabel;
    for (const [key, target] of [['xMin', 'xMin'], ['xMax', 'xMax'], ['yMin', 'yMin'], ['yMax', 'yMax']] as const) {
        const value = asNumber(raw[key]);
        if (value !== null) (graph as unknown as Record<string, number>)[target] = value;
    }
    const pearl = asString(raw.pearl, 200);
    if (pearl) graph.pearl = pearl;
    return graph;
}

function coerceVisual(raw: unknown): StudyVisual | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    switch (source.kind) {
        case 'lab':
            return coerceLab(source);
        case 'diagram':
            return coerceDiagram(source);
        case 'sequence':
            return coerceSequence(source);
        case 'graph':
            return coerceGraph(source);
        case 'timeline':
            return coerceTimeline(source);
        case 'flow':
        case 'cycle':
            return coerceFlow(source);
        case 'matrix':
        case 'compare':
            return coerceMatrix(source);
        default:
            return null;
    }
}

function coerceBullet(raw: unknown): StudyBullet | null {
    if (typeof raw === 'string') {
        const text = asString(raw, 300);
        return text ? { text } : null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const text = asString(source.text, 300);
    if (!text) return null;
    const bullet: StudyBullet = { text };
    if (source.emphasis === 'pearl') bullet.emphasis = 'pearl';
    const children = asArray(source.children).map(child => asString(child, 200)).filter((child): child is string => child !== null).slice(0, 5);
    if (children.length > 0) bullet.children = children;
    return bullet;
}

/**
 * The model's answer, made safe.
 *
 * Returns null when there is nothing usable rather than throwing: a malformed
 * answer is a failed generation the caller retries, not a crash in the panel.
 */
export function coerceVisualPack(raw: unknown, meta: { domain: string; sourceHash: string; now?: number }): StudyVisualPack | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Record<string, unknown>;
    const mindMapRaw = source.mindMap ?? source.mindmap ?? source.map;
    const root = coerceNode(mindMapRaw && typeof mindMapRaw === 'object' ? (mindMapRaw as Record<string, unknown>).root ?? mindMapRaw : null, 0);
    if (!root) return null;

    const visuals = asArray(source.visuals).map(coerceVisual).filter((visual): visual is StudyVisual => visual !== null).slice(0, 6);

    const summaryRaw = (source.summary ?? {}) as Record<string, unknown>;
    const bullets = asArray(summaryRaw.bullets).map(coerceBullet).filter((bullet): bullet is StudyBullet => bullet !== null).slice(0, 30);
    if (bullets.length === 0) return null;

    const mindMapTitle = asString(mindMapRaw && typeof mindMapRaw === 'object' ? (mindMapRaw as Record<string, unknown>).title : null, 120);
    const summary: StudySummary = { title: asString(summaryRaw.title, 120) ?? 'Summary', bullets };
    const kept = asString(summaryRaw.kept, 240);
    if (kept) summary.kept = kept;

    return {
        version: STUDY_VISUAL_VERSION,
        domain: meta.domain,
        mindMap: { title: mindMapTitle ?? 'Mind map', root },
        visuals,
        summary,
        generatedAt: meta.now ?? Date.now(),
        sourceHash: meta.sourceHash,
    };
}

/** Every label in a map, for tests and for counting what a pack contains. */
export function mapNodeCount(node: StudyMindMapNode): number {
    return 1 + (node.children ?? []).reduce((total, child) => total + mapNodeCount(child), 0);
}

/** Depth of a map, so the UI can decide whether to start collapsed. */
export function mapDepth(node: StudyMindMapNode): number {
    const children = node.children ?? [];
    if (children.length === 0) return 1;
    return 1 + Math.max(...children.map(mapDepth));
}

/** Bullets that must survive any condensing. */
export function pearls(summary: StudySummary): StudyBullet[] {
    return summary.bullets.filter(bullet => bullet.emphasis === 'pearl');
}
