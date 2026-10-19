/**
 * The visual pack: the vocabulary, its coercion, and the budgets.
 *
 * The model's answer is untrusted input, so most of this file is about what
 * happens when it is wrong: nothing here may throw, and nothing malformed may
 * reach the panel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    STUDY_VISUAL_VERSION,
    StudyMindMapNode,
    StudySummary,
    assetBudget,
    bulletBudget,
    coerceVisualPack,
    mapDepth,
    mapNodeCount,
    pearls,
    visualBudget,
} from '../models/study-visuals';
import { getDomainProfile, visualsFor } from '../models/study-domains';
import { extractJson, visualBudgetFor } from '../services/study-visuals-service';

const goodPayload = () => ({
    mindMap: {
        title: 'Acid–base',
        root: {
            id: 'root',
            label: 'Acid–base balance',
            detail: 'pH is the ratio of bicarbonate to CO2',
            children: [
                { id: 'resp', label: 'Respiratory', children: [{ id: 'co2', label: 'CO2 is the acid' }] },
                { id: 'metab', label: 'Metabolic', children: [{ id: 'hco3', label: 'HCO3 is the base' }] },
            ],
        },
    },
    visuals: [
        {
            kind: 'matrix',
            title: 'The four disturbances',
            columns: ['pH', 'CO2', 'HCO3'],
            rows: [
                { label: 'Metabolic acidosis', cells: ['low', 'low', 'low'], emphasis: true },
                { label: 'Respiratory acidosis', cells: ['low', 'high', 'high'] },
            ],
            pearl: 'First ask whether CO2 and HCO3 move together',
        },
        {
            kind: 'cycle',
            title: 'Compensation',
            steps: [
                { id: 'a', label: 'Primary change' },
                { id: 'b', label: 'Compensation starts', detail: 'hours to days' },
                { id: 'c', label: 'New steady state', kind: 'outcome' },
            ],
        },
    ],
    summary: {
        title: 'Acid–base in one page',
        kept: 'the ratio, the four disturbances, the compensation rule',
        bullets: [
            { text: 'pH = 6.1 + log(HCO3 / 0.03 × PaCO2)', emphasis: 'pearl' },
            { text: 'Respiratory: CO2 moves opposite to pH', children: ['hypoventilation raises CO2'] },
            'Metabolic: HCO3 moves with pH',
        ],
    },
});

test('a good answer becomes a pack, and keeps what makes it useful', () => {
    const pack = coerceVisualPack(goodPayload(), { domain: 'medicine', sourceHash: 'abc', now: 42 });
    assert.ok(pack);
    assert.equal(pack.version, STUDY_VISUAL_VERSION);
    assert.equal(pack.domain, 'medicine');
    assert.equal(pack.sourceHash, 'abc');
    assert.equal(pack.generatedAt, 42);
    assert.equal(pack.mindMap.root.label, 'Acid–base balance');
    assert.equal(mapNodeCount(pack.mindMap.root), 5);
    assert.equal(mapDepth(pack.mindMap.root), 3);
    assert.equal(pack.visuals.length, 2);
    const matrix = pack.visuals[0];
    assert.equal(matrix.kind, 'matrix');
    if (matrix.kind === 'matrix') {
        assert.equal(matrix.rows[0].emphasis, true);
        assert.equal(matrix.pearl, 'First ask whether CO2 and HCO3 move together');
        // cells are padded to the column count so the table never runs short
        assert.equal(matrix.rows.every(row => row.cells.length === matrix.columns.length), true);
    }
    assert.equal(pack.summary.bullets.length, 3);
    assert.equal(pearls(pack.summary).length, 1);
});

test('a summary bullet given as a bare string still becomes a bullet', () => {
    const payload = goodPayload();
    const pack = coerceVisualPack(payload, { domain: 'general', sourceHash: 'h' });
    assert.ok(pack);
    assert.equal(pack.summary.bullets[2].text, 'Metabolic: HCO3 moves with pH');
    assert.equal(pack.summary.bullets[2].emphasis, undefined);
});

test('nothing malformed reaches the panel', () => {
    assert.equal(coerceVisualPack(null, { domain: 'general', sourceHash: 'h' }), null);
    assert.equal(coerceVisualPack('a string', { domain: 'general', sourceHash: 'h' }), null);
    // no map
    assert.equal(coerceVisualPack({ summary: { bullets: ['x'] } }, { domain: 'g', sourceHash: 'h' }), null);
    // no summary
    assert.equal(coerceVisualPack({ mindMap: { root: { label: 'Root' } } }, { domain: 'g', sourceHash: 'h' }), null);
    // a map with no label anywhere
    assert.equal(coerceVisualPack({ mindMap: { root: {} }, summary: { bullets: ['x'] } }, { domain: 'g', sourceHash: 'h' }), null);
});

test('a matrix with one column or a flow with two steps is not a board', () => {
    const oneColumn = goodPayload();
    (oneColumn.visuals[0] as Record<string, unknown>).columns = ['only'];
    const shortFlow = goodPayload();
    (shortFlow.visuals[1] as Record<string, unknown>).steps = [{ id: 'a', label: 'one' }, { id: 'b', label: 'two' }];
    const pack = coerceVisualPack(oneColumn, { domain: 'g', sourceHash: 'h' });
    assert.ok(pack);
    // The malformed matrix is dropped and the sound cycle in the same answer is
    // kept: one bad board does not cost the reader the good one.
    assert.equal(pack.visuals.length, 1);
    assert.equal(pack.visuals[0].kind, 'cycle');

    const short = coerceVisualPack(shortFlow, { domain: 'g', sourceHash: 'h' });
    assert.ok(short);
    assert.equal(short.visuals.length, 1, 'the two-step "cycle" is not a board');
    assert.equal(short.visuals[0].kind, 'matrix');
});

test('an oversized map is cut rather than trusted', () => {
    const deep: StudyMindMapNode = { id: 'n', label: 'n', children: [] };
    let cursor = deep;
    for (let i = 0; i < 9; i += 1) {
        const child: StudyMindMapNode = { id: `n${i}`, label: `n${i}`, children: [] };
        cursor.children = [child];
        cursor = child;
    }
    const pack = coerceVisualPack(
        { mindMap: { root: deep }, summary: { bullets: ['one'] } },
        { domain: 'g', sourceHash: 'h' },
    );
    assert.ok(pack);
    assert.ok(mapDepth(pack.mindMap.root) <= 5, `depth ${mapDepth(pack.mindMap.root)} should be bounded`);
});

test('the bullet budget scales with the material and stays bounded', () => {
    const small = bulletBudget(2, 1, 1200);
    const medium = bulletBudget(10, 5, 12000);
    const large = bulletBudget(60, 40, 90000);
    assert.ok(small >= 3, 'a tiny note still gets a usable summary');
    assert.ok(medium > small, 'more material earns more bullets');
    assert.ok(large > medium, 'and it keeps growing');
    assert.ok(large <= 24, 'but never becomes a second copy of the note');
    assert.equal(bulletBudget(0, 0, 0), 3, 'an empty note still has a floor');
});

test('the visual budget bounds rows and steps', () => {
    assert.equal(visualBudget(0), 3);
    assert.ok(visualBudget(6) >= 3);
    assert.ok(visualBudget(100) <= 10);
});

test('a discipline with a profile keeps its own visual shape', () => {
    const medicine = getDomainProfile('medicine');
    const law = getDomainProfile('law');
    assert.ok(visualsFor(medicine).kinds.includes('matrix'), 'medicine reasons in differentials');
    assert.ok(visualsFor(law).kinds.includes('flow'), 'law reasons in ordered element tests');
    assert.ok(visualsFor(law).mapDepth >= 3);
    // an unknown discipline falls back rather than failing
    assert.ok(visualsFor(null).kinds.length > 0);
    assert.ok(visualsFor(undefined).bulletRatio > 0);
});

test('the budget the prompt is given reflects the discipline', () => {
    const request = {
        content: 'x'.repeat(12000),
        objectives: Array.from({ length: 10 }, () => ({}) as never),
        profile: getDomainProfile('law'),
    };
    const law = visualBudgetFor(request);
    const general = visualBudgetFor({ ...request, profile: getDomainProfile('general') });
    assert.ok(law.bullets >= general.bullets, 'law keeps more, by its profile');
    assert.ok(law.rowsOrSteps >= 3 && law.rowsOrSteps <= 10);
    assert.ok(law.mapDepth >= 3);
});

test('JSON is found however the model wrapped it', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Here is the answer:\n{"a":{"b":2}}\nHope it helps!'), { a: { b: 2 } });
    assert.equal(extractJson('no json here'), null);
    assert.equal(extractJson('{"broken": '), null);
    assert.equal(extractJson(''), null);
});

test('staleness is a fingerprint or a version away', () => {
    const pack = coerceVisualPack(goodPayload(), { domain: 'medicine', sourceHash: 'hash-1' });
    assert.ok(pack);
    assert.equal(pack.sourceHash, 'hash-1');
    // a different body means the map describes a note that no longer exists
    assert.equal(pack.sourceHash === 'hash-2', false);
    assert.equal(pack.version, STUDY_VISUAL_VERSION);
});

test('a summary with no pearls is still a summary', () => {
    const summary: StudySummary = { title: 'Plain', bullets: [{ text: 'one' }, { text: 'two' }] };
    assert.equal(pearls(summary).length, 0);
    assert.equal(summary.bullets.length, 2);
});

// ------------------------------------------------- the interactive assets

/** A pack whose gallery holds one of each interactive form. */
const interactivePayload = () => ({
    mindMap: { root: { id: 'r', label: 'Root' } },
    visuals: [
        {
            kind: 'lab',
            title: 'Acid–base balance',
            teach: 'Move CO2 and watch the pH answer',
            params: [
                { id: 'paco2', label: 'PaCO2', unit: 'mmHg', min: 10, max: 80, step: 1, value: 40 },
                { id: 'hco3', label: 'HCO3', unit: 'mmol/L', min: 5, max: 45, step: 1, value: 24 },
            ],
            outputs: [{ id: 'ph', label: 'pH', expression: '6.1 + log10(hco3 / (0.03 * paco2))' }],
            presets: [{ label: 'Normal', values: { paco2: 40, hco3: 24 } }],
        },
        {
            kind: 'diagram',
            title: 'The nephron',
            teach: 'Where each part reabsorbs what',
            shapes: [
                { id: 'glom', kind: 'ellipse', x: 20, y: 20, w: 14, h: 10, text: 'Glomerulus', tone: 'primary' },
                { id: 'flow', kind: 'arrow', x: 27, y: 26, x2: 45, y2: 26 },
            ],
            hotspots: [{ id: 'pct', label: 'Proximal tubule', x: 45, y: 26, detail: 'Most reabsorption happens here.' }],
        },
        {
            kind: 'sequence',
            title: 'Put the cascade in order',
            teach: 'The order the clotting factors act in',
            steps: [
                { id: 'a', label: 'Vessel injury' },
                { id: 'b', label: 'Platelet plug' },
                { id: 'c', label: 'Fibrin mesh' },
            ],
            shuffle: true,
        },
        {
            kind: 'graph',
            title: 'Enzyme rate against substrate',
            teach: 'The curve flattens as the enzyme saturates',
            xLabel: 'Substrate',
            yLabel: 'Rate',
            series: [
                { id: 'v', label: 'v0', points: [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 8 }] },
            ],
        },
    ],
    summary: { title: 'One page', bullets: ['A pearl', 'A detail'] },
});

test('each interactive asset survives coercion with its substance intact', () => {
    const pack = coerceVisualPack(interactivePayload(), { domain: 'medicine', sourceHash: 'h' });
    assert.ok(pack);
    assert.equal(pack.visuals.length, 4);
    const [lab, diagram, sequence, graph] = pack.visuals;
    assert.equal(lab.kind, 'lab');
    if (lab.kind === 'lab') {
        assert.equal(lab.params.length, 2);
        assert.equal(lab.outputs[0].expression, '6.1 + log10(hco3 / (0.03 * paco2))');
        assert.equal(lab.presets?.[0].values.paco2, 40);
    }
    assert.equal(diagram.kind, 'diagram');
    if (diagram.kind === 'diagram') {
        assert.equal(diagram.shapes.length, 2);
        assert.equal(diagram.shapes[1].x2, 45, 'an arrow keeps both endpoints');
        assert.equal(diagram.hotspots[0].detail, 'Most reabsorption happens here.');
    }
    assert.equal(sequence.kind, 'sequence');
    if (sequence.kind === 'sequence') {
        assert.equal(sequence.shuffle, true);
        assert.equal(sequence.steps.length, 3);
    }
    assert.equal(graph.kind, 'graph');
    if (graph.kind === 'graph') {
        assert.equal(graph.series[0].points.length, 3);
        assert.equal(graph.xLabel, 'Substrate');
    }
});

test('a malformed interactive asset is dropped without costing the others', () => {
    const payload = interactivePayload();
    // a lab whose range is nonsense, a sequence too short, a graph with one point
    (payload.visuals[0] as Record<string, unknown>).params = [{ id: 'x', label: 'X', min: 10, max: 10, value: 10 }];
    (payload.visuals[2] as Record<string, unknown>).steps = [{ id: 'a', label: 'One' }];
    (payload.visuals[3] as Record<string, unknown>).series = [{ id: 's', label: 'S', points: [{ x: 1, y: 1 }] }];
    const pack = coerceVisualPack(payload, { domain: 'medicine', sourceHash: 'h' });
    assert.ok(pack, 'the pack survives');
    assert.equal(pack.visuals.length, 1, 'only the diagram was sound');
    assert.equal(pack.visuals[0].kind, 'diagram');
});

test('a lab with no computable output is not a lab', () => {
    const payload = interactivePayload();
    (payload.visuals[0] as Record<string, unknown>).outputs = [];
    const pack = coerceVisualPack(payload, { domain: 'g', sourceHash: 'h' });
    assert.ok(pack);
    assert.equal(pack.visuals.some(v => v.kind === 'lab'), false);
});

test('the gallery budget is a gallery: three at least, five at most', () => {
    assert.equal(assetBudget(0), 3);
    assert.equal(assetBudget(10), 5);
    assert.ok(assetBudget(3) >= 3 && assetBudget(3) <= 5);
    assert.ok(assetBudget(100) <= 5);
});

// ------------------------------------- the fields that make a drawing a drawing

test('a lab output keeps how it is drawn, its scale and its band', () => {
    const payload = {
        mindMap: { root: { id: 'r', label: 'Root' } },
        visuals: [{
            kind: 'lab',
            title: 'Balance',
            teach: 'Watch the bar leave the band',
            params: [{ id: 'p', label: 'P', min: 0, max: 100, value: 40 }],
            outputs: [{
                id: 'o', label: 'Answer', unit: 'mmol/L', expression: 'p * 2',
                render: 'bar', scaleMin: 0, scaleMax: 200, band: [20, 60],
                insideLabel: 'in range', outsideLabel: 'out of range',
            }],
        }],
        summary: { title: 'S', bullets: ['b'] },
    };
    const pack = coerceVisualPack(payload, { domain: 'g', sourceHash: 'h' });
    assert.ok(pack);
    const lab = pack.visuals[0];
    assert.equal(lab.kind, 'lab');
    if (lab.kind === 'lab') {
        const output = lab.outputs[0];
        assert.equal(output.render, 'bar');
        assert.equal(output.scaleMin, 0);
        assert.equal(output.scaleMax, 200);
        assert.deepEqual(output.band, [20, 60]);
        assert.equal(output.outsideLabel, 'out of range');
    }
});

test('a nonsense band, scale or render is dropped rather than trusted', () => {
    const payload = {
        mindMap: { root: { id: 'r', label: 'Root' } },
        visuals: [{
            kind: 'lab',
            title: 'Balance',
            teach: 'x',
            params: [{ id: 'p', label: 'P', min: 0, max: 100, value: 40 }],
            outputs: [{ id: 'o', label: 'Answer', expression: 'p', render: 'sparkles', band: [60, 20], scaleMin: 'x' }],
        }],
        summary: { title: 'S', bullets: ['b'] },
    };
    const pack = coerceVisualPack(payload, { domain: 'g', sourceHash: 'h' });
    assert.ok(pack);
    const lab = pack.visuals[0];
    if (lab.kind === 'lab') {
        assert.equal(lab.outputs[0].render, undefined, 'an unknown render falls back to the drawn default');
        assert.equal(lab.outputs[0].band, undefined, 'a band that runs backwards is not a band');
        assert.equal(lab.outputs[0].scaleMin, undefined);
    }
});

test('motion, flow, pulse and marks survive coercion', () => {
    const payload = {
        mindMap: { root: { id: 'r', label: 'Root' } },
        visuals: [
            {
                kind: 'cycle', title: 'The cycle', motion: 'cycle', teach: 'Watch it go round',
                steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
            },
            {
                kind: 'diagram', title: 'The path', teach: 'Follow the arrows',
                shapes: [
                    { id: 's', kind: 'box', x: 10, y: 10, w: 20, h: 10, text: 'One', pulse: true },
                    { id: 'a', kind: 'arrow', x: 30, y: 15, x2: 60, y2: 15, flow: true },
                ],
                hotspots: [],
            },
            {
                kind: 'compare', title: 'Which one', columns: ['Cost', 'Speed'],
                rows: [
                    { label: 'A', cells: ['low', 'fast'], mark: 'better' },
                    { label: 'B', cells: ['high', 'slow'], mark: 'nonsense' },
                ],
            },
        ],
        summary: { title: 'S', bullets: ['b'] },
    };
    const pack = coerceVisualPack(payload, { domain: 'g', sourceHash: 'h' });
    assert.ok(pack);
    const [cycle, diagram, compare] = pack.visuals;
    if (cycle.kind === 'cycle') {
        assert.equal(cycle.motion, 'cycle');
        assert.equal(cycle.teach, 'Watch it go round');
    }
    if (diagram.kind === 'diagram') {
        assert.equal(diagram.shapes[0].pulse, true);
        assert.equal(diagram.shapes[1].flow, true);
        assert.equal(diagram.shapes[0].flow, undefined);
    }
    if (compare.kind === 'compare') {
        assert.equal(compare.rows[0].mark, 'better');
        assert.equal(compare.rows[1].mark, undefined, 'an unknown mark is no mark');
    }
});
