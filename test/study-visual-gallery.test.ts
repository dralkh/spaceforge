/**
 * The visualise gallery (ui/study-visual-gallery.ts) is the surface the reader
 * actually browses: several interactive assets, one card each, the first open.
 *
 * The renderers behind it are the real ones, so a card that says "Diagram" is
 * proven to contain a diagram, and a collapse is proven by the component's DOM
 * leaving — not by a spy saying it was called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MiniElement, flatten, textsOfClass } from './support/mini-dom';
import { coerceVisualPack } from '../models/study-visuals';
import { StudyVisualGalleryView } from '../ui/study-visual-gallery';

const payload = () => ({
    mindMap: { root: { id: 'r', label: 'Root' } },
    visuals: [
        {
            kind: 'diagram',
            title: 'The nephron',
            teach: 'Where each part reabsorbs what',
            shapes: [
                { id: 'glom', kind: 'ellipse', x: 30, y: 30, w: 30, h: 20, text: 'Glomerulus', tone: 'primary' },
                { id: 'pct', kind: 'box', x: 60, y: 30, w: 24, h: 14, text: 'Proximal tubule' },
            ],
            hotspots: [{ id: 'h1', label: 'Proximal tubule', x: 72, y: 37, detail: 'Most reabsorption happens here.' }],
        },
        {
            kind: 'lab',
            title: 'Acid–base balance',
            teach: 'Move CO2 and watch the pH answer',
            params: [{ id: 'paco2', label: 'PaCO2', unit: 'mmHg', min: 10, max: 80, step: 1, value: 40 }],
            outputs: [{ id: 'ph', label: 'pH', expression: '6.1 + log10(24 / (0.03 * paco2))' }],
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
            title: 'Rate against substrate',
            teach: 'The curve flattens as the enzyme saturates',
            series: [{ id: 'v', label: 'v0', points: [{ x: 0, y: 0 }, { x: 1, y: 5 }] }],
        },
        {
            kind: 'compare',
            title: 'C3, C4 and CAM',
            teach: 'What each strategy trades away',
            columns: ['First product', 'Cost'],
            rows: [
                { label: 'C3', cells: ['3-PGA', 'Photorespiration'] },
                { label: 'C4', cells: ['Oxaloacetate', 'Extra ATP'] },
            ],
        },
    ],
    summary: { title: 'One page', bullets: ['A pearl'] },
});

const pack = () => {
    const built = coerceVisualPack(payload(), { domain: 'medicine', sourceHash: 'h' });
    assert.ok(built);
    return built;
};

function mount() {
    const root = new MiniElement('div');
    const view = new StudyVisualGalleryView();
    const teardown = view.mount(root, pack().visuals);
    return { root, teardown };
}

function byClass(root: MiniElement, cls: string): MiniElement[] {
    const found: MiniElement[] = [];
    const walk = (element: MiniElement) => {
        if (element.classList.contains(cls)) found.push(element);
        for (const child of element.children) walk(child);
    };
    walk(root);
    return found;
}

const heads = (root: MiniElement) => byClass(root, 'sf-vg-head');

test('every asset gets a card, with a noun for its kind and its own title', () => {
    const { root } = mount();
    assert.equal(byClass(root, 'sf-vg-card').length, 5);
    const chips = textsOfClass(root, 'sf-vg-kind');
    assert.deepEqual(chips, ['Diagram', 'Lab', 'Sequence', 'Graph', 'Comparison']);
    // a verb where a noun belongs is the kind of inconsistency a reader notices
    for (const chip of chips) assert.equal(/^(try|order|draw|make)\b/i.test(chip), false, `"${chip}" reads as an instruction, not a kind`);
    assert.match(flatten(heads(root)[0]), /The nephron/);
});

test('the first card is open and the rest wait collapsed', () => {
    const { root } = mount();
    const cards = byClass(root, 'sf-vg-card');
    assert.equal(cards[0].classList.contains('is-open'), true);
    for (const card of cards.slice(1)) assert.equal(card.classList.contains('is-open'), false);
    // and the open one really contains its component
    assert.ok(byClass(root, 'sf-vd-svg').length >= 1, 'the diagram drew');
});

test('a collapsed card keeps its component out of the reader’s way', () => {
    const { root } = mount();
    const labCard = byClass(root, 'sf-vg-card')[1];
    assert.equal(flatten(labCard).includes('PaCO2'), false, 'a closed card does not show its controls');
});

test('opening a card brings its component up, and closing it puts it away', () => {
    const { root } = mount();
    const labCard = byClass(root, 'sf-vg-card')[1];
    const head = labCard.byClass('sf-vg-head')[0];
    head.click();
    assert.equal(labCard.classList.contains('is-open'), true);
    assert.ok(byClass(labCard, 'sf-lab-range').length >= 1, 'the lab rendered inside its card');
    head.click();
    assert.equal(labCard.classList.contains('is-open'), false);
    assert.equal(byClass(labCard, 'sf-lab-range').length, 0, 'and was taken down, not just hidden');
});

test('each kind reaches its own renderer, not a generic one', () => {
    const { root } = mount();
    // the first card is already open: clicking it would close it again
    for (const card of byClass(root, 'sf-vg-card')) {
        if (!card.classList.contains('is-open')) card.byClass('sf-vg-head')[0].click();
    }
    assert.ok(byClass(root, 'sf-vd-svg').length >= 1, 'diagram');
    assert.ok(byClass(root, 'sf-lab-range').length >= 1, 'lab');
    assert.ok(byClass(root, 'sf-vsq-card').length >= 1, 'sequence, as cards the reader handles');
    assert.ok(byClass(root, 'sf-graph-svg').length >= 1 || byClass(root, 'sf-graph-plot').length >= 1, 'graph');
    assert.ok(byClass(root, 'sf-vb-table').length >= 1, 'compare, through the board');
});

test('the gallery says how many assets it holds', () => {
    const { root } = mount();
    assert.equal(textsOfClass(root, 'sf-vg-count')[0], '5 visual assets');
});

test('teardown takes every card and every component with it', () => {
    const { root, teardown } = mount();
    for (const card of byClass(root, 'sf-vg-card')) {
        if (!card.classList.contains('is-open')) card.byClass('sf-vg-head')[0].click();
    }
    teardown();
    assert.equal(byClass(root, 'sf-vg-card').length, 0);
    assert.equal(byClass(root, 'sf-vg').length, 0);
    assert.equal(flatten(root).trim(), '');
});

test('an empty pack says so instead of showing an empty gallery', () => {
    const root = new MiniElement('div');
    new StudyVisualGalleryView().mount(root, []);
    assert.equal(byClass(root, 'sf-vg-card').length, 0);
    assert.match(flatten(root), /No visual assets/);
});
