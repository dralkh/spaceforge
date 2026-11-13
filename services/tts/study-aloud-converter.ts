import type {
    StudyDiagram,
    StudyFlow,
    StudyFlowStep,
    StudyGraph,
    StudyLab,
    StudyMatrix,
    StudyMindMap,
    StudyMindMapNode,
    StudySequence,
    StudySummary,
    StudyTimeline,
    StudyVisual,
    StudyVisualKind,
} from '../../models/study-visuals';
import { cleanMarkdownForSpeech } from '../../utils/tts-text';

export interface AloudSegmentSummaryTarget {
    kind: 'title' | 'bullet' | 'child' | 'kept';
    bulletIndex?: number;
    childIndex?: number;
}

export interface AloudSegmentMindMapTarget {
    nodeId: string;
    nodeKey: string;
}

export interface AloudSegmentVisualTarget {
    visualIndex: number;
    visualKind: StudyVisualKind;
    cardTitle: string;
    itemIndex?: number;
    subRole: 'intro' | 'item' | 'verdict' | 'pearl';
}

export interface AloudSegment {
    id: string;
    text: string;
    label: string;
    targetSurface: 'note' | 'summary' | 'mindmap' | 'visualize' | 'tutor';
    noteRange?: { start: number; end: number };
    summaryTarget?: AloudSegmentSummaryTarget;
    mindMapTarget?: AloudSegmentMindMapTarget;
    visualTarget?: AloudSegmentVisualTarget;
    tutorTurnIndex?: number;
}

function ensureSentenceEnding(text: string): string {
    const clean = text.trim();
    if (!clean) return '';
    return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function ordinalLabel(index: number, total: number): string {
    return `${index + 1} of ${total}`;
}

/**
 * Convert StudySummary directly into aloud segments while tracking exact DOM bullet/child targets
 * for synchronized highlighting and auto-scroll.
 */
export function convertSummaryToAloudSegments(
    summary: StudySummary,
    options: { pearlsOnly?: boolean } = {},
): AloudSegment[] {
    const segments: AloudSegment[] = [];
    const pearlsOnly = options.pearlsOnly === true;

    const titleText = cleanMarkdownForSpeech(summary.title || 'Summary');
    if (titleText) {
        segments.push({
            id: 'summary-title',
            text: ensureSentenceEnding(pearlsOnly ? `Summary pearls for ${titleText}` : `Summary: ${titleText}`),
            label: titleText,
            targetSurface: 'summary',
            summaryTarget: { kind: 'title' },
        });
    }

    summary.bullets.forEach((bullet, bulletIndex) => {
        if (pearlsOnly && bullet.emphasis !== 'pearl') return;
        const spokenBullet = cleanMarkdownForSpeech(bullet.text);
        if (spokenBullet) {
            const prefix = bullet.emphasis === 'pearl' ? 'Key pearl: ' : '';
            segments.push({
                id: `summary-bullet-${bulletIndex}`,
                text: ensureSentenceEnding(`${prefix}${spokenBullet}`),
                label: bullet.emphasis === 'pearl' ? `Pearl ${bulletIndex + 1}` : `Point ${bulletIndex + 1}`,
                targetSurface: 'summary',
                summaryTarget: { kind: 'bullet', bulletIndex },
            });
        }

        if (bullet.children && bullet.children.length > 0) {
            bullet.children.forEach((child, childIndex) => {
                const spokenChild = cleanMarkdownForSpeech(child);
                if (!spokenChild) return;
                segments.push({
                    id: `summary-bullet-${bulletIndex}-child-${childIndex}`,
                    text: ensureSentenceEnding(spokenChild),
                    label: `Point ${bulletIndex + 1}.${childIndex + 1}`,
                    targetSurface: 'summary',
                    summaryTarget: { kind: 'child', bulletIndex, childIndex },
                });
            });
        }
    });

    if (summary.kept) {
        const spokenKept = cleanMarkdownForSpeech(summary.kept);
        if (spokenKept) {
            segments.push({
                id: 'summary-kept',
                text: ensureSentenceEnding(`Remember: ${spokenKept}`),
                label: 'Takeaway',
                targetSurface: 'summary',
                summaryTarget: { kind: 'kept' },
            });
        }
    }

    return segments;
}

/**
 * Convert a hierarchical StudyMindMap into a structured, cohesive educational narrative.
 * Uses the exact same `'0'` / `'0.i'` path-key scheme as `StudyMindMapView` so every spoken segment
 * focuses, expands, highlights, and scrolls to its corresponding node.
 */
export function convertMindMapToAloudSegments(mindMap: StudyMindMap): AloudSegment[] {
    const segments: AloudSegment[] = [];
    const root = mindMap.root;
    if (!root) return segments;

    const mapTitle = cleanMarkdownForSpeech(mindMap.title || root.label);
    const rootLabel = cleanMarkdownForSpeech(root.label);
    const rootDetail = root.detail ? cleanMarkdownForSpeech(root.detail) : '';
    const topBranches = root.children ?? [];

    let intro = `Mind map overview: ${mapTitle}.`;
    if (rootLabel && rootLabel.toLowerCase() !== mapTitle.toLowerCase()) {
        intro += ` The central concept is ${rootLabel}.`;
    }
    if (rootDetail) {
        intro += ` ${ensureSentenceEnding(rootDetail)}`;
    }
    if (topBranches.length > 0) {
        const names = topBranches
            .slice(0, 5)
            .map(child => cleanMarkdownForSpeech(child.label))
            .filter(Boolean);
        const suffix = topBranches.length > 5 ? `, plus ${topBranches.length - 5} more branches` : '';
        intro += ` It organizes into ${topBranches.length} main branch${topBranches.length === 1 ? '' : 'es'}: ${names.join(', ')}${suffix}.`;
    }

    segments.push({
        id: 'mindmap-0',
        text: intro.trim(),
        label: `Root · ${root.label}`,
        targetSurface: 'mindmap',
        mindMapTarget: { nodeId: root.id, nodeKey: '0' },
    });

    const walk = (
        node: StudyMindMapNode,
        nodeKey: string,
        parentLabel: string,
        depth: number,
        siblingIndex: number,
        siblingCount: number,
    ): void => {
        const label = cleanMarkdownForSpeech(node.label);
        const detail = node.detail ? cleanMarkdownForSpeech(node.detail) : '';
        const children = node.children ?? [];

        let script = '';
        if (depth === 1) {
            script = `Branch ${ordinalLabel(siblingIndex, siblingCount)}: ${label}.`;
        } else if (depth === 2) {
            script = `Under ${parentLabel}, consider ${label}.`;
        } else {
            script = `${label}.`;
        }

        if (detail) {
            script += ` ${ensureSentenceEnding(detail)}`;
        }
        if (children.length > 0) {
            const preview = children
                .slice(0, 4)
                .map(c => cleanMarkdownForSpeech(c.label))
                .filter(Boolean)
                .join(', ');
            script += ` This breaks down into ${children.length} part${children.length === 1 ? '' : 's'}: ${preview}.`;
        }

        segments.push({
            id: `mindmap-${nodeKey}`,
            text: script.trim(),
            label: `${'· '.repeat(Math.max(0, depth - 1))}${node.label}`,
            targetSurface: 'mindmap',
            mindMapTarget: { nodeId: node.id, nodeKey },
        });

        children.forEach((child, idx) => {
            walk(child, `${nodeKey}.${idx}`, label || node.label, depth + 1, idx, children.length);
        });
    };

    topBranches.forEach((branch, index) => {
        walk(branch, `0.${index}`, rootLabel || mapTitle, 1, index, topBranches.length);
    });

    return segments;
}

function makeVisualSegment(
    visual: StudyVisual,
    visualIndex: number,
    suffix: string,
    text: string,
    label: string,
    subRole: AloudSegmentVisualTarget['subRole'],
    itemIndex?: number,
): AloudSegment {
    return {
        id: `visual-${visualIndex}-${suffix}`,
        text: text.trim(),
        label,
        targetSurface: 'visualize',
        visualTarget: {
            visualIndex,
            visualKind: visual.kind,
            cardTitle: visual.title,
            itemIndex,
            subRole,
        },
    };
}

function appendPearlIfPresent(
    segments: AloudSegment[],
    visual: StudyVisual,
    visualIndex: number,
    pearl?: string,
): void {
    if (!pearl) return;
    const spoken = cleanMarkdownForSpeech(pearl);
    if (!spoken) return;
    segments.push(
        makeVisualSegment(
            visual,
            visualIndex,
            'pearl',
            `Key takeaway: ${ensureSentenceEnding(spoken)}`,
            `${visual.title} · Pearl`,
            'pearl',
        ),
    );
}

function convertMatrixOrCompare(visual: StudyMatrix, visualIndex: number): AloudSegment[] {
    const segments: AloudSegment[] = [];
    const rawCols = Array.isArray(visual.columns) ? visual.columns : [];
    const rawRows = Array.isArray(visual.rows) ? visual.rows : [];
    const cols = rawCols.map(c => cleanMarkdownForSpeech(c)).filter(Boolean);
    const kindWord = visual.kind === 'compare' ? 'Side-by-side comparison' : 'Comparison matrix';

    let intro = `${kindWord}: ${cleanMarkdownForSpeech(visual.title)}.`;
    if (cols.length > 0) {
        intro += ` We are comparing ${cols.join(' versus ')}.`;
    }
    if (rawRows.length > 0) {
        intro += ` There are ${rawRows.length} dimensions to examine.`;
    }

    segments.push(makeVisualSegment(visual, visualIndex, 'intro', intro, visual.title, 'intro'));

    rawRows.forEach((row, rowIndex) => {
        const criterion = cleanMarkdownForSpeech(row.label ?? '');
        const parts: string[] = [];
        (Array.isArray(row.cells) ? row.cells : []).forEach((cell, cellIdx) => {
            const cleanCell = cleanMarkdownForSpeech(cell);
            if (!cleanCell) return;
            const colName = cols[cellIdx];
            parts.push(colName ? `for ${colName}, it is ${cleanCell}` : cleanCell);
        });

        let verdictNote = '';
        if (row.mark === 'better') verdictNote = ' This marks an advantage.';
        else if (row.mark === 'worse') verdictNote = ' This marks a drawback.';
        else if (row.mark === 'equal') verdictNote = ' Both are comparable here.';

        const prefix = row.emphasis ? 'Crucial distinction — ' : '';
        const text = `${prefix}For ${criterion}: ${parts.join('; ')}.${verdictNote}`;
        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                `row-${rowIndex}`,
                text,
                `${visual.title} · ${row.label}`,
                'item',
                rowIndex,
            ),
        );
    });

    appendPearlIfPresent(segments, visual, visualIndex, visual.pearl);
    return segments;
}

function orderFlowSteps(steps: StudyFlowStep[]): StudyFlowStep[] {
    if (steps.length <= 1) return steps;
    const byId = new Map(steps.map(step => [step.id, step]));
    const visited = new Set<string>();
    const ordered: StudyFlowStep[] = [];

    const visit = (step: StudyFlowStep) => {
        if (visited.has(step.id)) return;
        visited.add(step.id);
        ordered.push(step);
        for (const branch of step.branches ?? []) {
            const next = byId.get(branch.to);
            if (next) visit(next);
        }
    };

    visit(steps[0]);
    for (const step of steps) {
        if (!visited.has(step.id)) visit(step);
    }
    return ordered;
}

function convertFlowOrCycle(visual: StudyFlow, visualIndex: number): AloudSegment[] {
    const segments: AloudSegment[] = [];
    const isCycle = visual.kind === 'cycle';
    const teach = visual.teach ? ` ${ensureSentenceEnding(cleanMarkdownForSpeech(visual.teach))}` : '';
    const intro = `${isCycle ? 'Cyclical process' : 'Decision flow'}: ${cleanMarkdownForSpeech(visual.title)}.${teach} Walking through ${visual.steps.length} steps.`;
    segments.push(makeVisualSegment(visual, visualIndex, 'intro', intro, visual.title, 'intro'));

    const ordered = isCycle ? visual.steps : orderFlowSteps(visual.steps);
    const labelById = new Map(visual.steps.map(s => [s.id, cleanMarkdownForSpeech(s.label)]));

    ordered.forEach((step, idx) => {
        const rawIndex = visual.steps.findIndex(s => s.id === step.id);
        const targetIndex = rawIndex >= 0 ? rawIndex : idx;
        const stepLabel = cleanMarkdownForSpeech(step.label);
        const detail = step.detail ? ` ${ensureSentenceEnding(cleanMarkdownForSpeech(step.detail))}` : '';

        let header = '';
        if (step.kind === 'decision') {
            header = `Decision point, step ${ordinalLabel(idx, ordered.length)}: ${stepLabel}.`;
        } else if (step.kind === 'outcome') {
            header = `Outcome reached: ${stepLabel}.`;
        } else {
            header = `Step ${ordinalLabel(idx, ordered.length)}: ${stepLabel}.`;
        }

        let transitions = '';
        if (step.branches && step.branches.length > 0) {
            const branchPhrases = step.branches.map(b => {
                const toName = labelById.get(b.to) || b.to;
                const cond = cleanMarkdownForSpeech(b.label);
                return cond ? `if ${cond}, proceed to ${toName}` : `next is ${toName}`;
            });
            transitions = ` From here, ${branchPhrases.join('; ')}.`;
        } else if (isCycle && idx === ordered.length - 1 && ordered.length > 1) {
            transitions = ` This completes the cycle and feeds back into ${cleanMarkdownForSpeech(ordered[0].label)}.`;
        }

        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                `step-${targetIndex}`,
                `${header}${detail}${transitions}`,
                `${visual.title} · ${step.label}`,
                'item',
                targetIndex,
            ),
        );
    });

    appendPearlIfPresent(segments, visual, visualIndex, visual.pearl);
    return segments;
}

function convertTimeline(visual: StudyTimeline, visualIndex: number): AloudSegment[] {
    const segments: AloudSegment[] = [];
    segments.push(
        makeVisualSegment(
            visual,
            visualIndex,
            'intro',
            `Timeline: ${cleanMarkdownForSpeech(visual.title)}, covering ${visual.entries.length} milestones in chronological order.`,
            visual.title,
            'intro',
        ),
    );

    visual.entries.forEach((entry, idx) => {
        const when = cleanMarkdownForSpeech(entry.when);
        const label = cleanMarkdownForSpeech(entry.label);
        const detail = entry.detail ? ` ${ensureSentenceEnding(cleanMarkdownForSpeech(entry.detail))}` : '';
        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                `entry-${idx}`,
                `${when}: ${ensureSentenceEnding(label)}${detail}`,
                `${visual.title} · ${entry.when}`,
                'item',
                idx,
            ),
        );
    });

    appendPearlIfPresent(segments, visual, visualIndex, visual.pearl);
    return segments;
}

function convertLab(visual: StudyLab, visualIndex: number): AloudSegment[] {
    const segments: AloudSegment[] = [];
    const teach = cleanMarkdownForSpeech(visual.teach);
    const mission = visual.mission ? ` Goal: ${ensureSentenceEnding(cleanMarkdownForSpeech(visual.mission))}` : '';
    segments.push(
        makeVisualSegment(
            visual,
            visualIndex,
            'intro',
            `Interactive lab: ${cleanMarkdownForSpeech(visual.title)}. ${ensureSentenceEnding(teach)}${mission}`,
            visual.title,
            'intro',
        ),
    );

    if (visual.params.length > 0) {
        const paramDesc = visual.params
            .map(p => {
                const unit = p.unit ? ` ${p.unit}` : '';
                return `${cleanMarkdownForSpeech(p.label)} ranging from ${p.min} to ${p.max}${unit}, starting at ${p.value}${unit}`;
            })
            .join('; ');
        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                'params',
                `Adjustable inputs include ${paramDesc}.`,
                `${visual.title} · Parameters`,
                'item',
                0,
            ),
        );
    }

    visual.outputs.forEach((out, idx) => {
        const unit = out.unit ? ` ${out.unit}` : '';
        let desc = `Measured output: ${cleanMarkdownForSpeech(out.label)}.`;
        if (out.band) {
            desc += ` Its normal target band is ${out.band[0]} to ${out.band[1]}${unit}.`;
            if (out.insideLabel) desc += ` Within that band, it indicates ${cleanMarkdownForSpeech(out.insideLabel)}.`;
            if (out.outsideLabel) desc += ` Outside that band, it indicates ${cleanMarkdownForSpeech(out.outsideLabel)}.`;
        }
        if (out.note) {
            desc += ` ${ensureSentenceEnding(cleanMarkdownForSpeech(out.note))}`;
        }
        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                `output-${idx}`,
                desc,
                `${visual.title} · ${out.label}`,
                'item',
                idx,
            ),
        );
    });

    if (visual.presets && visual.presets.length > 0) {
        const presetNames = visual.presets.map(p => {
            const vals = Object.entries(p.values)
                .map(([k, v]) => {
                    const paramLabel = visual.params.find(pm => pm.id === k)?.label ?? k;
                    return `${cleanMarkdownForSpeech(paramLabel)} at ${v}`;
                })
                .join(', ');
            return `${cleanMarkdownForSpeech(p.label)} (${vals})`;
        });
        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                'presets',
                `Scenario presets you can explore: ${presetNames.join('; ')}.`,
                `${visual.title} · Presets`,
                'verdict',
            ),
        );
    }

    appendPearlIfPresent(segments, visual, visualIndex, visual.pearl);
    return segments;
}

function convertDiagram(visual: StudyDiagram, visualIndex: number): AloudSegment[] {
    const segments: AloudSegment[] = [];
    const teach = ensureSentenceEnding(cleanMarkdownForSpeech(visual.teach));
    const caption = visual.caption ? ` ${ensureSentenceEnding(cleanMarkdownForSpeech(visual.caption))}` : '';
    const labeledShapes = visual.shapes
        .map(s => (s.text ? cleanMarkdownForSpeech(s.text) : ''))
        .filter(Boolean);
    const shapeHint = labeledShapes.length > 0 && visual.hotspots.length === 0
        ? ` Visual elements labeled: ${labeledShapes.join(', ')}.`
        : '';

    segments.push(
        makeVisualSegment(
            visual,
            visualIndex,
            'intro',
            `Diagram walkthrough: ${cleanMarkdownForSpeech(visual.title)}. ${teach}${caption}${shapeHint}`,
            visual.title,
            'intro',
        ),
    );

    visual.hotspots.forEach((spot, idx) => {
        const label = cleanMarkdownForSpeech(spot.label);
        const detail = cleanMarkdownForSpeech(spot.detail);
        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                `hotspot-${idx}`,
                `Component ${ordinalLabel(idx, visual.hotspots.length)}: ${label}. ${ensureSentenceEnding(detail)}`,
                `${visual.title} · ${spot.label}`,
                'item',
                idx,
            ),
        );
    });

    appendPearlIfPresent(segments, visual, visualIndex, visual.pearl);
    return segments;
}

function convertSequence(visual: StudySequence, visualIndex: number): AloudSegment[] {
    const segments: AloudSegment[] = [];
    segments.push(
        makeVisualSegment(
            visual,
            visualIndex,
            'intro',
            `Ordered sequence: ${cleanMarkdownForSpeech(visual.title)}. ${ensureSentenceEnding(cleanMarkdownForSpeech(visual.teach))} Here are all ${visual.steps.length} steps in canonical order.`,
            visual.title,
            'intro',
        ),
    );

    visual.steps.forEach((step, idx) => {
        const label = cleanMarkdownForSpeech(step.label);
        const detail = step.detail ? ` ${ensureSentenceEnding(cleanMarkdownForSpeech(step.detail))}` : '';
        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                `seq-${idx}`,
                `Step ${ordinalLabel(idx, visual.steps.length)}: ${ensureSentenceEnding(label)}${detail}`,
                `${visual.title} · Step ${idx + 1}`,
                'item',
                idx,
            ),
        );
    });

    appendPearlIfPresent(segments, visual, visualIndex, visual.pearl);
    return segments;
}

function convertGraph(visual: StudyGraph, visualIndex: number): AloudSegment[] {
    const segments: AloudSegment[] = [];
    const xAxis = visual.xLabel ? cleanMarkdownForSpeech(visual.xLabel) : 'horizontal axis';
    const yAxis = visual.yLabel ? cleanMarkdownForSpeech(visual.yLabel) : 'vertical axis';
    const teach = ensureSentenceEnding(cleanMarkdownForSpeech(visual.teach));

    segments.push(
        makeVisualSegment(
            visual,
            visualIndex,
            'intro',
            `Graph explanation: ${cleanMarkdownForSpeech(visual.title)}. ${teach} The ${xAxis} is plotted against the ${yAxis}.`,
            visual.title,
            'intro',
        ),
    );

    visual.series.forEach((serie, idx) => {
        const pts = serie.points;
        let trend = '';
        if (pts.length >= 2) {
            const first = pts[0];
            const last = pts[pts.length - 1];
            const minPt = pts.reduce((a, b) => (b.y < a.y ? b : a), pts[0]);
            const maxPt = pts.reduce((a, b) => (b.y > a.y ? b : a), pts[0]);
            const direction = last.y > first.y ? 'rises overall' : last.y < first.y ? 'falls overall' : 'stays level overall';
            trend = ` Across ${xAxis} from ${first.x} to ${last.x}, it ${direction}, spanning values from ${minPt.y} at ${minPt.x} up to a peak of ${maxPt.y} at ${maxPt.x}.`;
        }
        const labeledPoints = pts
            .filter(p => p.label)
            .map(p => `${cleanMarkdownForSpeech(p.label!)} at x equals ${p.x}, y equals ${p.y}`);
        const pointNotes = labeledPoints.length > 0 ? ` Notable points: ${labeledPoints.join('; ')}.` : '';

        segments.push(
            makeVisualSegment(
                visual,
                visualIndex,
                `series-${idx}`,
                `Curve ${ordinalLabel(idx, visual.series.length)}, ${cleanMarkdownForSpeech(serie.label)}:${trend}${pointNotes}`,
                `${visual.title} · ${serie.label}`,
                'item',
                idx,
            ),
        );
    });

    appendPearlIfPresent(segments, visual, visualIndex, visual.pearl);
    return segments;
}

/**
 * Convert a single StudyVisual (any of the 9 kinds) into aloud-readable educational segments.
 */
export function convertVisualToAloudSegments(visual: StudyVisual, visualIndex = 0): AloudSegment[] {
    switch (visual.kind) {
        case 'matrix':
        case 'compare':
            return convertMatrixOrCompare(visual, visualIndex);
        case 'flow':
        case 'cycle':
            return convertFlowOrCycle(visual, visualIndex);
        case 'timeline':
            return convertTimeline(visual, visualIndex);
        case 'lab':
            return convertLab(visual, visualIndex);
        case 'diagram':
            return convertDiagram(visual, visualIndex);
        case 'sequence':
            return convertSequence(visual, visualIndex);
        case 'graph':
            return convertGraph(visual, visualIndex);
    }
}

/**
 * Convert the entire Visualize gallery into ordered educational segments across all visuals.
 */
export function convertVisualGalleryToAloudSegments(visuals: StudyVisual[]): AloudSegment[] {
    const out: AloudSegment[] = [];
    visuals.forEach((visual, index) => {
        out.push(...convertVisualToAloudSegments(visual, index));
    });
    return out;
}

export interface SpokenTutorMessage {
    role: string;
    text: string;
}

/**
 * Convert Study tutor conversation turns into aloud segments.
 */
export function convertTutorTurnsToAloudSegments(
    turns: SpokenTutorMessage[],
    fromLastTutorOnly = false,
): AloudSegment[] {
    if (!turns.length) return [];
    const targetTurns = fromLastTutorOnly
        ? turns.map((turn, index) => ({ turn, index })).filter(entry => entry.turn.role === 'tutor').slice(-1)
        : turns.map((turn, index) => ({ turn, index }));

    const segments: AloudSegment[] = [];
    for (const { turn, index } of targetTurns) {
        const clean = cleanMarkdownForSpeech(turn.text);
        if (!clean) continue;
        const speaker = turn.role === 'tutor' ? 'Tutor' : turn.role === 'user' ? 'You' : 'Study';
        segments.push({
            id: `tutor-turn-${index}`,
            text: fromLastTutorOnly ? clean : `${speaker}: ${clean}`,
            label: `${speaker} · Turn ${index + 1}`,
            targetSurface: 'tutor',
            tutorTurnIndex: index,
        });
    }
    return segments;
}
