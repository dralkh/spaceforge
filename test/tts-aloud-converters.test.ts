import test from 'node:test';
import assert from 'node:assert/strict';

import {
    StudyMindMap,
    StudySummary,
    StudyVisual,
} from '../models/study-visuals';
import {
    convertMindMapToAloudSegments,
    convertSummaryToAloudSegments,
    convertVisualGalleryToAloudSegments,
    convertVisualToAloudSegments,
} from '../services/tts/study-aloud-converter';
import {
    chunkTextWithOffsets,
    cleanMarkdownForSpeech,
    pcmToWavArrayBuffer,
    resolveAutomaticNoteRange,
} from '../utils/tts-text';

test('resolves Aloud-style automatic note selection from selection, cursor, or full note skipping frontmatter', () => {
    const md = '---\ntags: [bio]\n---\n# Title\nFirst sentence here. Second sentence follows.';
    const sel = resolveAutomaticNoteRange(md, md.indexOf('Second'), md.length);
    assert.equal(sel.mode, 'selection');
    assert.equal(sel.text, 'Second sentence follows.');

    const cur = resolveAutomaticNoteRange(md, md.indexOf('First'), md.indexOf('First'));
    assert.equal(cur.mode, 'cursor-to-end');
    assert.ok(cur.text.startsWith('First sentence here.'));

    const full = resolveAutomaticNoteRange(md);
    assert.equal(full.mode, 'full-note');
    assert.ok(!full.text.includes('tags: [bio]'));

    const chunks = chunkTextWithOffsets(full.text, 'sentence', full.start);
    assert.ok(chunks.length >= 3);
    assert.equal(md.slice(chunks[0].start, chunks[0].end), '# Title');
});

test('cleans markdown links, tables, callouts, and LaTeX math for natural speech', () => {
    const raw = [
        '[[Action Potential|AP]] rises via $Na^+$ channels when $\\frac{a}{b}$ exceeds threshold.',
        '> [!tip] Key point',
        '| Ion | Direction |',
        '| --- | --- |',
        '| Sodium | Inward |',
    ].join('\n');

    const clean = cleanMarkdownForSpeech(raw);
    assert.ok(clean.includes('AP rises via'));
    assert.ok(clean.includes('a over b'));
    assert.ok(clean.includes('tip: Key point'));
    assert.ok(clean.includes('Ion: Sodium, Direction: Inward.'));
});

test('wraps raw PCM audio in valid 44-byte RIFF/WAVE headers', () => {
    const pcm = new Uint8Array([10, 20, 30, 40]).buffer;
    const wav = pcmToWavArrayBuffer(pcm, 24000, 1, 16);
    const view = new DataView(wav);
    assert.equal(wav.byteLength, 48);
    assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), 'RIFF');
    assert.equal(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)), 'WAVE');
    assert.equal(view.getUint32(24, true), 24000);
});

test('reads StudySummary directly while respecting pearlsOnly toggle and preserving bullet targets', () => {
    const summary: StudySummary = {
        title: 'Renal Physiology',
        bullets: [
            { text: 'Normal detail point.', emphasis: 'normal', children: ['Sub-detail A'] },
            { text: 'GFR equals filtration coefficient times net pressure.', emphasis: 'pearl', children: ['Starling forces balance'] },
        ],
        kept: 'Check urine osmolarity first.',
    };

    const all = convertSummaryToAloudSegments(summary, { pearlsOnly: false });
    assert.equal(all.length, 6);
    assert.deepEqual(all[1].summaryTarget, { kind: 'bullet', bulletIndex: 0 });
    assert.deepEqual(all[2].summaryTarget, { kind: 'child', bulletIndex: 0, childIndex: 0 });
    assert.match(all[3].text, /^Key pearl:/);
    assert.deepEqual(all[5].summaryTarget, { kind: 'kept' });

    const pearls = convertSummaryToAloudSegments(summary, { pearlsOnly: true });
    assert.equal(pearls.length, 4); // title + pearl bullet + pearl child + kept
    assert.equal(pearls.some(s => s.text.includes('Normal detail point')), false);
});

test('converts StudyMindMap hierarchy fully into educational aloud segments with exact path keys', () => {
    const map: StudyMindMap = {
        title: 'Cardiac Cycle',
        root: {
            id: 'root',
            label: 'Cardiac Cycle',
            detail: 'Alternating contraction and relaxation.',
            children: [
                {
                    id: 'systole',
                    label: 'Systole',
                    detail: 'Ventricular ejection.',
                    children: [
                        { id: 'iso', label: 'Isovolumetric Contraction', detail: 'All valves shut.' },
                    ],
                },
                {
                    id: 'diastole',
                    label: 'Diastole',
                    detail: 'Passive filling then atrial kick.',
                },
            ],
        },
    };

    const segments = convertMindMapToAloudSegments(map);
    assert.equal(segments.length, 4);
    assert.deepEqual(segments[0].mindMapTarget, { nodeId: 'root', nodeKey: '0' });
    assert.match(segments[0].text, /2 main branches: Systole, Diastole/);
    assert.deepEqual(segments[1].mindMapTarget, { nodeId: 'systole', nodeKey: '0.0' });
    assert.match(segments[1].text, /Branch 1 of 2: Systole/);
    assert.deepEqual(segments[2].mindMapTarget, { nodeId: 'iso', nodeKey: '0.0.0' });
    assert.match(segments[2].text, /Under Systole, consider Isovolumetric Contraction/);
    assert.deepEqual(segments[3].mindMapTarget, { nodeId: 'diastole', nodeKey: '0.1' });
});

test('converts all 9 StudyVisual kinds completely into aloud-readable educational scripts', () => {
    const visuals: StudyVisual[] = [
        {
            kind: 'matrix',
            title: 'Mitosis vs Meiosis',
            columns: ['Mitosis', 'Meiosis'],
            rows: [{ label: 'Daughter cells', cells: ['2 diploid', '4 haploid'], emphasis: true, mark: 'better' }],
            pearl: 'Crossing over occurs only in meiosis I.',
        },
        {
            kind: 'compare',
            title: 'DNA vs RNA',
            columns: ['DNA', 'RNA'],
            rows: [{ label: 'Sugar', cells: ['Deoxyribose', 'Ribose'], mark: 'equal' }],
        },
        {
            kind: 'flow',
            title: 'Chest Pain Triage',
            teach: 'Rule out life threats first.',
            steps: [
                { id: 's1', label: 'Obtain ECG', kind: 'decision', branches: [{ label: 'ST elevation', to: 's2' }] },
                { id: 's2', label: 'Activate cath lab', kind: 'outcome' },
            ],
        },
        {
            kind: 'cycle',
            title: 'Citric Acid Cycle',
            steps: [
                { id: 'c1', label: 'Citrate', detail: '6 carbons' },
                { id: 'c2', label: 'Oxaloacetate', detail: 'Regenerated' },
            ],
        },
        {
            kind: 'timeline',
            title: 'Action Potential',
            entries: [
                { when: '0 ms', label: 'Depolarization', detail: 'Sodium influx' },
                { when: '2 ms', label: 'Repolarization', detail: 'Potassium efflux' },
            ],
        },
        {
            kind: 'lab',
            title: 'Henderson-Hasselbalch Lab',
            teach: 'See how bicarbonate and CO2 control blood pH.',
            mission: 'Keep pH inside normal range.',
            params: [{ id: 'hco3', label: 'Bicarbonate', unit: 'mEq/L', min: 10, max: 40, value: 24 }],
            outputs: [{
                id: 'ph',
                label: 'Arterial pH',
                expression: '7.4',
                band: [7.35, 7.45],
                insideLabel: 'Normal acid-base balance',
                outsideLabel: 'Acidemia or alkalemia',
            }],
            presets: [{ label: 'Metabolic acidosis', values: { hco3: 14 } }],
            pearl: 'pH falls when bicarbonate drops.',
        },
        {
            kind: 'diagram',
            title: 'Nephron',
            teach: 'Identify filtration vs reabsorption zones.',
            shapes: [{ id: 'b1', kind: 'box', x: 10, y: 10, text: 'Glomerulus' }],
            hotspots: [{ id: 'h1', label: 'Loop of Henle', x: 50, y: 50, detail: 'Countercurrent multiplier.' }],
        },
        {
            kind: 'sequence',
            title: 'PCR Steps',
            teach: 'Put thermal cycling steps in order.',
            steps: [
                { id: 'p1', label: 'Denaturation', detail: '95C melts strands' },
                { id: 'p2', label: 'Annealing', detail: 'Primers bind' },
            ],
        },
        {
            kind: 'graph',
            title: 'Enzyme Kinetics',
            teach: 'Compare velocity against substrate concentration.',
            xLabel: 'Substrate',
            yLabel: 'Velocity',
            series: [{ id: 'v', label: 'No inhibitor', points: [{ x: 0, y: 0 }, { x: 10, y: 50, label: 'Half Vmax' }, { x: 40, y: 95 }] }],
        },
    ];

    const gallerySegments = convertVisualGalleryToAloudSegments(visuals);
    assert.ok(gallerySegments.length >= 20);

    // Every single visual index 0..8 produced at least intro + item segments
    for (let i = 0; i < visuals.length; i++) {
        const slice = convertVisualToAloudSegments(visuals[i], i);
        assert.ok(slice.length >= 2, `Expected >=2 segments for kind ${visuals[i].kind}`);
        assert.equal(slice[0].targetSurface, 'visualize');
        assert.equal(slice[0].visualTarget?.visualIndex, i);
        assert.equal(slice[0].visualTarget?.visualKind, visuals[i].kind);
    }

    const joined = gallerySegments.map(s => s.text).join(' ');
    assert.match(joined, /Daughter cells.*for Mitosis, it is 2 diploid/);
    assert.match(joined, /if ST elevation, proceed to Activate cath lab/);
    assert.match(joined, /feeds back into Citrate/);
    assert.match(joined, /normal target band is 7\.35 to 7\.45/);
    assert.match(joined, /Countercurrent multiplier/);
    assert.match(joined, /Step 1 of 2: Denaturation/);
    assert.match(joined, /rises overall/);
});
