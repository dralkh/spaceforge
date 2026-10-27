/**
 * The study material section (ui/study-material-section.ts) is what the reader
 * actually touches: three tabs, one host, a Make it button, and a state line
 * that has to be honest about what exists and whether it is still true.
 *
 * The renderers are the real ones — this file mounts them through the section —
 * so a switch is proven by real DOM appearing and the previous surface's DOM
 * being gone, not by a spy saying it was called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { MiniElement, flatten, textsOfClass } from './support/mini-dom';
import { coerceVisualPack } from '../models/study-visuals';
import { StudyMaterialHost, StudyMaterialSection } from '../ui/study-material-section';

// ---------------------------------------------------------------- fixtures

const payload = () => ({
    mindMap: {
        title: 'Acid–base',
        root: {
            id: 'root',
            label: 'Acid–base balance',
            children: [
                { id: 'resp', label: 'Respiratory' },
                { id: 'metab', label: 'Metabolic' },
            ],
        },
    },
    visuals: [
        {
            kind: 'matrix',
            title: 'The four disturbances',
            columns: ['pH', 'CO2'],
            rows: [
                { label: 'Metabolic acidosis', cells: ['low', 'low'] },
                { label: 'Respiratory acidosis', cells: ['low', 'high'] },
            ],
        },
    ],
    summary: {
        title: 'Acid–base in one page',
        bullets: [
            { text: 'pH is a ratio', emphasis: 'pearl' },
            { text: 'Compensation takes hours to days' },
            { text: 'Winter’s formula estimates the expected CO2' },
        ],
    },
});

const goodPack = () => {
    const pack = coerceVisualPack(payload(), { domain: 'medicine', sourceHash: 'hash-1' });
    assert.ok(pack, 'fixture must coerce');
    return pack;
};

interface Harness {
    root: MiniElement;
    section: StudyMaterialSection;
    host: { pack: ReturnType<typeof goodPack> | null; stale: boolean; calls: number };
}

function mount(initial: ReturnType<typeof goodPack> | null, options: {
    stale?: boolean;
    result?: () => Promise<ReturnType<typeof goodPack> | null>;
    error?: Error;
    preparation?: { state: string; message: string; materials: string } | null;
} = {}): Harness {
    const root = new MiniElement('div');
    const state = { pack: initial, stale: options.stale ?? false, calls: 0 };
    const host: StudyMaterialHost = {
        snapshot: () => ({ pack: state.pack, stale: state.stale, preparation: options.preparation ?? null }),
        generate: async () => {
            state.calls += 1;
            if (options.error) throw options.error;
            const pack = options.result ? await options.result() : goodPack();
            // The real host (the panel) stores what it made before the section
            // repaints: the section reads `pack` back, it does not hold it. A
            // fresh pack matches the note, so it is no longer stale.
            if (pack) {
                state.pack = pack;
                state.stale = false;
            }
            return pack;
        },
    };
    const section = new StudyMaterialSection();
    section.mount(root, host);
    return { root, section, host: state };
}

/** Every element carrying `cls`, walked from the root. */
function byClass(root: MiniElement, cls: string): MiniElement[] {
    const found: MiniElement[] = [];
    const walk = (element: MiniElement) => {
        if (element.classList.contains(cls)) found.push(element);
        for (const child of element.children) walk(child);
    };
    walk(root);
    return found;
}

const stateText = (root: MiniElement) => textsOfClass(root, 'sf-study-material-state')[0] ?? '';
const generateLabel = (root: MiniElement) => textsOfClass(root, 'sf-study-material-generate')[0] ?? '';
const tab = (root: MiniElement, label: string) =>
    byClass(root, 'sf-study-material-tab').find(button => flatten(button).includes(label));

/**
 * Let the section's async paint finish. Two microtasks were not enough — the
 * chain is click -> make -> generate -> refresh -> mount — so this waits for the
 * macrotask boundary, which flushes everything queued before it.
 */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

// ---------------------------------------------------------------- the empty state

test('with nothing made yet the section offers generation and actionable material views', () => {
    const { root } = mount(null);
    assert.match(stateText(root), /mind map/i);
    assert.equal(generateLabel(root), 'Make it');
    const tabs = byClass(root, 'sf-study-material-tab');
    assert.equal(tabs.length, 3);
    for (const button of tabs) assert.equal(button.classList.contains('is-disabled'), false, 'views explain their preparation state instead of being inert');
    assert.match(flatten(root), /nothing made yet/);
});

test('a tab press with no pack names the requested view and keeps generation available', () => {
    const { root } = mount(null);
    tab(root, 'Visualize')?.click();
    assert.equal(byClass(root, 'sf-vb-visual').length, 0);
    assert.match(flatten(root), /Visualize: nothing made yet/);
    assert.equal(tab(root, 'Visualize')?.getAttribute('aria-pressed'), 'true');
    assert.match(flatten(root), /nothing made yet/);
});

test('a failed automatic attempt says what happened and offers the retry, not “Make it”', () => {
    const { root } = mount(null, { preparation: { state: 'error', message: 'The model did not return usable material.', materials: 'error' } });
    assert.match(flatten(root), /was not made/);
    assert.match(flatten(root), /Retry material/);
    assert.doesNotMatch(flatten(root), /nothing made yet/);
});

test('a view switch re-reads preparation, so a retry that finished while hidden is visible', () => {
    const options: { preparation: { state: string; message: string; materials: string } | null } = {
        preparation: { state: 'error', message: 'The model did not return usable material.', materials: 'error' },
    };
    const root = new MiniElement('div');
    const state = { pack: null as ReturnType<typeof goodPack> | null };
    const section = new StudyMaterialSection();
    section.mount(root as unknown as HTMLElement, {
        snapshot: () => ({ pack: state.pack, stale: false, preparation: options.preparation }),
        generate: async () => null,
    });
    assert.match(flatten(root), /was not made/);
    options.preparation = { state: 'ready', message: 'Study preparation ready', materials: 'ready' };
    state.pack = goodPack();
    section.setView('board');
    assert.doesNotMatch(flatten(root), /was not made/);
    assert.ok(byClass(root, 'sf-vb-visual').length > 0, 'the pack that arrived while hidden is drawn');
});

// ---------------------------------------------------------------- making it

test('pressing Make it calls the host once and paints what comes back', async () => {
    const h = mount(null);
    byClass(h.root, 'sf-study-material-generate')[0].click();
    await settle();
    assert.equal(h.host.calls, 1);
    assert.match(stateText(h.root), /1 visual asset · 3 bullets · made from this note/);
    assert.equal(generateLabel(h.root), 'Regenerate');
    for (const button of byClass(h.root, 'sf-study-material-tab')) {
        assert.equal(button.classList.contains('is-disabled'), false);
    }
    // the map is the default surface, and it is the real renderer
    assert.ok(byClass(h.root, 'sf-mm-node').length >= 3, 'the map drew its nodes');
    assert.equal(tab(h.root, 'Mind map')?.classList.contains('is-selected'), true);
});

test('two presses during one generation are one generation', async () => {
    let resolve: (pack: ReturnType<typeof goodPack>) => void = () => undefined;
    const h = mount(null, { result: () => new Promise(r => { resolve = r as never; }) });
    const button = byClass(h.root, 'sf-study-material-generate')[0];
    button.click();
    button.click();
    button.click();
    assert.equal(h.host.calls, 1, 'the busy guard holds');
    resolve(goodPack());
    await settle();
    assert.match(stateText(h.root), /made from this note/);
});

test('a model that returns nothing usable says so and stays recoverable', async () => {
    const h = mount(null, { result: () => Promise.resolve(null) });
    byClass(h.root, 'sf-study-material-generate')[0].click();
    await settle();
    assert.match(stateText(h.root), /did not return usable material/);
    assert.equal(byClass(h.root, 'sf-study-material-state')[0].classList.contains('is-error'), true);
    assert.equal(byClass(h.root, 'sf-study-material-generate')[0].getAttribute('disabled'), null, 'the button comes back');
});

test('a failure carries the real reason rather than a shrug', async () => {
    const h = mount(null, { error: new Error('OpenAI API key is not set') });
    byClass(h.root, 'sf-study-material-generate')[0].click();
    await settle();
    assert.equal(stateText(h.root), 'OpenAI API key is not set');
    assert.equal(byClass(h.root, 'sf-study-material-state')[0].classList.contains('is-error'), true);
});

// ---------------------------------------------------------------- the three surfaces

test('switching surfaces mounts the next and takes the last one away', () => {
    const h = mount(goodPack());
    assert.ok(byClass(h.root, 'sf-mm-node').length >= 3, 'the map is up');

    tab(h.root, 'Visualize')?.click();
    assert.equal(byClass(h.root, 'sf-mm-node').length, 0, 'the map is gone, not hidden');
    assert.equal(byClass(h.root, 'sf-vb-visual').length, 1, 'the board is up');
    assert.equal(byClass(h.root, 'sf-vb-table').length, 1, 'a matrix renders as a table');

    tab(h.root, 'Summary')?.click();
    assert.equal(byClass(h.root, 'sf-vb-visual').length, 0);
    assert.equal(byClass(h.root, 'sf-sum-bullet').length, 3);
    assert.equal(byClass(h.root, 'sf-sum-bullet').filter(b => b.classList.contains('is-pearl')).length, 1);

    tab(h.root, 'Mind map')?.click();
    assert.equal(byClass(h.root, 'sf-sum-bullet').length, 0);
    assert.ok(byClass(h.root, 'sf-mm-node').length >= 3, 'the map comes back');
});

test('only the surface on screen is selected', () => {
    const h = mount(goodPack());
    tab(h.root, 'Summary')?.click();
    const selected = byClass(h.root, 'sf-study-material-tab').filter(b => b.classList.contains('is-selected'));
    assert.equal(selected.length, 1);
    assert.match(flatten(selected[0]), /Summary/);
});

// ---------------------------------------------------------------- freshness

test('a note that changed since the pack was made says so', () => {
    const h = mount(goodPack(), { stale: true });
    assert.match(stateText(h.root), /Out of date/);
    assert.equal(byClass(h.root, 'sf-study-material-state')[0].classList.contains('is-stale'), true);
    // and the material is still readable: stale is a warning, not a lock
    assert.ok(byClass(h.root, 'sf-mm-node').length >= 3);
});

test('regenerating replaces the pack instead of stacking a second one', async () => {
    const h = mount(goodPack(), { stale: true });
    byClass(h.root, 'sf-study-material-generate')[0].click();
    await settle();
    assert.equal(h.host.calls, 1);
    assert.equal(stateText(h.root), '1 visual asset · 3 bullets · made from this note');
    assert.equal(byClass(h.root, 'sf-study-material-state')[0].classList.contains('is-stale'), false);
    assert.equal(byClass(h.root, 'sf-mm-node').length >= 3, true);
    assert.equal(byClass(h.root, 'sf-study-material-tab').length, 3, 'the tabs were not duplicated');
});

// ---------------------------------------------------------------- teardown

test('taking the section down removes the surfaces and the section itself', () => {
    const h = mount(goodPack());
    assert.ok(byClass(h.root, 'sf-study-material').length === 1);
    h.section.destroy();
    assert.equal(byClass(h.root, 'sf-study-material').length, 0);
    assert.equal(byClass(h.root, 'sf-mm-node').length, 0);
    assert.equal(flatten(h.root).trim(), '');
});

test('remounting after a destroy rebuilds one section, not two', () => {
    const h = mount(goodPack());
    h.section.destroy();
    h.section.mount(h.root, {
        snapshot: () => ({ pack: null, stale: false }),
        generate: () => Promise.resolve(null),
    });
    assert.equal(byClass(h.root, 'sf-study-material').length, 1);
    assert.equal(byClass(h.root, 'sf-study-material-tab').length, 3);
});
