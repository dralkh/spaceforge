/**
 * The Study mind map (ui/study-mindmap.ts) is a tree the reader has to be able
 * to work: it must draw every node, collapse and expand on a click, open the
 * whole map (or fold it back) from the toolbar, open already collapsed when the
 * map is deep, keep a focus lens visible, be driven by the keyboard alone, and —
 * the three rules that break silently in the app — never widen its host, never
 * cut a label without saying so, and never let the app's own button paint land
 * on a label, which is what a reader sees as a highlight over the text.
 *
 * The measurements the mini-dom can honestly make are structural: the host's
 * width is stubbed, the band the module chose from it is read back, and the
 * label cap the band selects is read out of the real stylesheet and compared
 * with that host width.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MiniElement } from './support/mini-dom';
import { StudyMindMap, StudyMindMapNode, mapDepth, mapNodeCount } from '../models/study-visuals';
import { StudyMindMapView, defaultCollapsedDepth, mindMapBand } from '../ui/study-mindmap';

const rootDir = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(rootDir, relative), 'utf8');

// ---------------------------------------------------------------- fixtures

function simpleMap(): StudyMindMap {
    return {
        title: 'Photosynthesis',
        root: {
            id: 'root',
            label: 'Photosynthesis',
            detail: 'How a plant makes its own food.',
            children: [
                {
                    id: 'light',
                    label: 'Light reactions',
                    detail: 'Happen in the thylakoid membrane.',
                    children: [
                        { id: 'ps2', label: 'Photosystem II', detail: 'Splits water.' },
                        { id: 'ps1', label: 'Photosystem I' },
                    ],
                },
                { id: 'calvin', label: 'Calvin cycle', detail: 'Happens in the stroma.' },
            ],
        },
    };
}

/** Five levels deep: deeper than the toolbar can show unasked. */
function deepMap(): StudyMindMap {
    return {
        title: 'Deep',
        root: {
            id: 'root',
            label: 'Root',
            children: [
                {
                    id: 'd1',
                    label: 'Level two',
                    children: [
                        {
                            id: 'd2',
                            label: 'Level three',
                            children: [{ id: 'd3', label: 'Level four', children: [{ id: 'd4', label: 'Level five' }] }],
                        },
                    ],
                },
            ],
        },
    };
}

/** Four levels: the first depth the default collapse applies to. */
function fourLevelMap(): StudyMindMap {
    return {
        title: 'Four',
        root: { id: 'root', label: 'Root', children: [{ id: 'a', label: 'A', children: [{ id: 'b', label: 'B', children: [{ id: 'c', label: 'C' }] }] }] },
    };
}

/** Forty nodes: three branches of twelve leaves under one root. */
function largeMap(): StudyMindMap {
    let next = 0;
    const branch = (index: number): StudyMindMapNode => ({
        id: `branch-${index}`,
        label: `Branch ${index + 1}`,
        children: Array.from({ length: 12 }, () => ({ id: `leaf-${next++}`, label: `Leaf ${next}` })),
    });
    return { title: 'Large', root: { id: 'root', label: 'Everything', children: [0, 1, 2].map(branch) } };
}

/** Three children under one root: the branch that fans out on a wide host. */
function fanMap(): StudyMindMap {
    return {
        title: 'Fan',
        root: {
            id: 'root',
            label: 'Root',
            children: [
                { id: 'a', label: 'Alpha', children: [{ id: 'a1', label: 'Alpha one' }] },
                { id: 'b', label: 'Beta' },
                { id: 'c', label: 'Gamma' },
            ],
        },
    };
}

// ------------------------------------------------------------------ helpers

/** Mount a map into a host of a known width, as the app's host would be. */
function mountIn(map: StudyMindMap, hostWidth = 600) {
    const host = new MiniElement('div');
    if (hostWidth > 0) (host as unknown as { clientWidth: number }).clientWidth = hostWidth;
    const view = new StudyMindMapView();
    const teardown = view.mount(host as unknown as HTMLElement, map);
    return { host, view, teardown };
}

const nodeEl = (host: MiniElement, id: string): MiniElement => {
    const el = host.querySelector(`[data-node-id="${id}"]`);
    assert.ok(el, `no node rendered for ${id}`);
    return el as MiniElement;
};

/** The children column under a node, which is what the collapse hides. */
const childGroup = (host: MiniElement, id: string): MiniElement => {
    const branch = nodeEl(host, id).parent as MiniElement;
    const group = branch.children.find(child => child.hasClass('sf-mm-children'));
    assert.ok(group, `no children under ${id}`);
    return group as MiniElement;
};

const press = (view: StudyMindMapView, key: string): boolean => view.handleKey({ key } as KeyboardEvent);

const collapsedIds = (host: MiniElement): string[] =>
    host
        .byClass('sf-mm-node')
        .filter(node => node.hasClass('is-collapsed'))
        .map(node => node.getAttribute('data-node-id') ?? '');

/** Every connector the map has drawn, on screen or hidden with its branch. */
const connectors = (host: MiniElement): MiniElement[] => host.byClass('sf-mm-connector');

/**
 * The connectors a collapsed branch has taken off screen: each one sits inside
 * the children column the collapse hides, so the reader never sees a line into
 * a subtree that is gone.
 */
const hiddenConnectors = (host: MiniElement): MiniElement[] =>
    connectors(host).filter(connector => {
        let node: MiniElement | null = connector.parent;
        while (node) {
            if (node.hasClass('sf-mm-children') && node.hasClass('is-collapsed')) return true;
            node = node.parent;
        }
        return false;
    });

/**
 * The rule body for a selector, so a declaration can be asserted where it lands.
 *
 * The map's rules for anything that is a `<button>` are written one level
 * deeper (`.sf-mm-map .sf-mm-label`) so they out-rank Obsidian's own
 * `button:not(.clickable-icon)` paint, so that prefix is part of the match.
 */
function ruleBody(source: string, selector: string): string {
    // Anchored to the start of a line: `.sf-mm-label {` also appears inside
    // longer selectors (`… .sf-mm-node .sf-mm-label {`), which are other rules.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)[\\t ]*(?:\\.sf-mm-map\\s+)?${escaped}[\\t ]*\\{`).exec(source);
    assert.ok(match, `no rule for ${selector}`);
    const at = match.index + match[0].length - 1;
    return source.slice(at, source.indexOf('}', at) + 1);
}

/** A stylesheet with its comments blanked, so a rule is a rule and not a note. */
function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every rule whose selector mentions the label, wherever it is written. */
function labelRules(source: string): string[] {
    const clean = withoutComments(source);
    const rules: string[] = [];
    for (const match of Array.from(clean.matchAll(/([^{}\n]*\.sf-mm-label[^{}\n]*)\{([^}]*)\}/g))) {
        rules.push(`${match[1].trim()} {${match[2].trim()}}`);
    }
    return rules;
}

/** A length declared in px by a rule, read from the real stylesheet. */
function px(source: string, selector: string, property: string): number {
    const body = ruleBody(source, selector);
    const match = new RegExp(`${property}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(body);
    assert.ok(match, `no ${property} in px in ${selector}`);
    return Number(match[1]);
}

// -------------------------------------------------------------------- tests

test('mount renders every node of the map, with its label and its detail', () => {
    const map = simpleMap();
    const { host } = mountIn(map);

    assert.equal(host.byClass('sf-mm-node').length, mapNodeCount(map.root), 'a node for every node in the map');
    for (const id of ['root', 'light', 'ps2', 'ps1', 'calvin']) {
        assert.equal(nodeEl(host, id).byClass('sf-mm-label').length, 1, `${id} draws one label`);
    }
    assert.equal(nodeEl(host, 'light').textOf('sf-mm-label'), 'Light reactions', 'the label is the model text');
    assert.equal(host.textOf('sf-mm-count'), '5 nodes', 'and the toolbar counts the whole tree');
    assert.equal(host.textOf('sf-mm-title'), 'Photosynthesis');
});

test('clicking a node with children collapses it and clicking again brings it back', () => {
    const { host } = mountIn(simpleMap());
    const node = () => nodeEl(host, 'light');

    assert.equal(node().hasClass('is-collapsed'), false, 'a shallow map opens whole');

    node().click();
    assert.equal(node().hasClass('is-collapsed'), true, 'the node says it is collapsed');
    assert.equal(childGroup(host, 'light').hasClass('is-collapsed'), true, 'and so does the column it hides');
    assert.equal(host.textOf('sf-mm-count'), '3 of 5 nodes', 'the count says what is on screen');

    node().click();
    assert.equal(node().hasClass('is-collapsed'), false, 'a second click restores the subtree');
    assert.equal(childGroup(host, 'light').hasClass('is-collapsed'), false);
    assert.equal(host.textOf('sf-mm-count'), '5 nodes');
});

test('a deep map starts collapsed below the second level, a shallow one does not', () => {
    const shallow = mountIn(simpleMap());
    assert.deepEqual(collapsedIds(shallow.host), [], 'three levels fit on screen');

    const four = mountIn(fourLevelMap());
    // Both branches below the second level are marked, including the one the
    // first collapse already hides: when the reader opens `a`, `b` is still
    // closed — the same default, one level down.
    assert.deepEqual(collapsedIds(four.host), ['a', 'b'], 'four levels start collapsed from the second');
    assert.equal(four.host.textOf('sf-mm-count'), '2 of 4 nodes');

    const deep = mountIn(deepMap());
    assert.equal(mapDepth(deepMap().root), 5);
    assert.deepEqual(collapsedIds(deep.host), ['d1', 'd2', 'd3'], 'every branch below the second level is closed');
    assert.equal(nodeEl(deep.host, 'root').hasClass('is-collapsed'), false, 'and the root is never collapsed');
    assert.equal(deep.host.textOf('sf-mm-count'), '2 of 5 nodes');
    assert.equal(defaultCollapsedDepth(deepMap().root), 2);
    assert.equal(defaultCollapsedDepth(simpleMap().root), 0);
});

test('a branch can be opened and closed from the API, below any depth', () => {
    const { host, view } = mountIn(deepMap());

    view.setCollapsedDepth(0);
    assert.deepEqual(collapsedIds(host), [], 'depth zero opens the whole map');
    assert.equal(host.textOf('sf-mm-count'), '5 nodes');

    view.setCollapsedDepth(3);
    assert.deepEqual(collapsedIds(host), ['d2', 'd3'], 'from depth three down is closed');
    assert.equal(nodeEl(host, 'd1').hasClass('is-collapsed'), false, 'the node above it stays open');
});

test('focusing a node marks it and its ancestors, and shows what it means', () => {
    const { host, view } = mountIn(simpleMap());
    nodeEl(host, 'ps2').byClass('sf-mm-label')[0].click();

    assert.equal(nodeEl(host, 'ps2').hasClass('is-focused'), true, 'the focused node is marked');
    assert.equal(nodeEl(host, 'light').hasClass('is-ancestor'), true, 'so is the way down to it');
    assert.equal(nodeEl(host, 'root').hasClass('is-ancestor'), true);
    assert.equal(nodeEl(host, 'calvin').hasClass('is-ancestor'), false, 'and nothing else is');
    assert.equal(host.querySelector('.sf-mm-map')?.hasClass('is-focus-mode'), true, 'the map dims the rest');
    assert.equal(nodeEl(host, 'ps2').getAttribute('aria-selected'), 'true');
    assert.equal(view.getFocusedId(), 'ps2');
    assert.equal(host.textOf('sf-mm-detail-label'), 'Photosystem II');
    assert.equal(host.textOf('sf-mm-detail-text'), 'Splits water.', 'the detail is what the node means');
    assert.match(host.textOf('sf-mm-detail-path'), /Photosynthesis › Light reactions › Photosystem II/);

    // A label click focuses; it does not also collapse the branch it sits on.
    assert.equal(nodeEl(host, 'light').hasClass('is-collapsed'), false);
});

test('Escape clears the focus and the detail panel with it', () => {
    const { host, view } = mountIn(simpleMap());
    nodeEl(host, 'light').byClass('sf-mm-label')[0].click();
    assert.equal(press(view, 'Escape'), true);

    assert.equal(view.getFocusedId(), null);
    assert.equal(nodeEl(host, 'light').hasClass('is-focused'), false);
    assert.equal(nodeEl(host, 'root').hasClass('is-ancestor'), false);
    assert.equal(host.querySelector('.sf-mm-map')?.hasClass('is-focus-mode'), false, 'nothing is dimmed any more');
    assert.equal(host.textOf('sf-mm-detail-label'), 'No node selected');
    assert.equal(host.textOf('sf-mm-detail-text'), 'Select a node to read what it means.');
    assert.equal(press(view, 'Escape'), false, 'and Escape with nothing focused is not the map\'s business');
});

test('a node with no detail of its own says so instead of showing nothing', () => {
    const { host } = mountIn(simpleMap());
    nodeEl(host, 'ps1').byClass('sf-mm-label')[0].click();
    assert.equal(host.textOf('sf-mm-detail-text'), 'No extra detail for this node.');
});

test('arrow keys move the keyboard cursor, Enter toggles, Home and End jump', () => {
    const { host, view } = mountIn(simpleMap());

    assert.equal(view.getActiveId(), 'root', 'the tree is entered on its root');
    assert.equal(nodeEl(host, 'root').hasClass('is-cursor'), true, 'and the cursor is visible');

    assert.equal(press(view, 'ArrowDown'), true);
    assert.equal(view.getActiveId(), 'light');
    assert.equal(nodeEl(host, 'light').hasClass('is-cursor'), true);
    assert.equal(nodeEl(host, 'root').hasClass('is-cursor'), false, 'the cursor moved, it did not spread');

    assert.equal(press(view, 'ArrowDown'), true);
    assert.equal(view.getActiveId(), 'ps2', 'down walks the flattened, visible tree');

    assert.equal(press(view, 'ArrowUp'), true);
    assert.equal(view.getActiveId(), 'light');

    assert.equal(press(view, 'Enter'), true);
    assert.equal(nodeEl(host, 'light').hasClass('is-collapsed'), true, 'Enter collapsed the branch the cursor is on');
    assert.equal(press(view, 'Enter'), true);
    assert.equal(nodeEl(host, 'light').hasClass('is-collapsed'), false, 'and Enter opens it again');

    assert.equal(press(view, 'ArrowLeft'), true);
    assert.equal(nodeEl(host, 'light').hasClass('is-collapsed'), true, 'left closes what is open');
    assert.equal(press(view, 'ArrowLeft'), true);
    assert.equal(view.getActiveId(), 'root', 'left again walks up to the parent');

    assert.equal(press(view, 'ArrowRight'), true);
    assert.equal(view.getActiveId(), 'light', 'right opens and steps in');

    assert.equal(press(view, 'End'), true);
    assert.equal(view.getActiveId(), 'calvin');
    assert.equal(press(view, 'Enter'), true);
    assert.equal(view.getFocusedId(), 'calvin', 'Enter on a leaf focuses it, since it has nothing to collapse');
    assert.equal(press(view, 'Home'), true);
    assert.equal(view.getActiveId(), 'root');

    assert.equal(press(view, 'ArrowUp'), true);
    assert.equal(view.getActiveId(), 'root', 'the cursor stops at the ends instead of wrapping');
});

test('the keyboard reaches a node that is inside a collapsed branch', () => {
    const { host, view } = mountIn(deepMap());
    assert.equal(view.getActiveId(), 'root');
    press(view, 'ArrowDown');
    assert.equal(view.getActiveId(), 'd1');
    press(view, 'ArrowRight');
    assert.equal(nodeEl(host, 'd1').hasClass('is-collapsed'), false, 'right opens the closed branch');
    assert.equal(view.getActiveId(), 'd1', 'and stays on it until walked into');
    press(view, 'ArrowDown');
    assert.equal(view.getActiveId(), 'd2');
});

test('focus opens the way to a node that is inside a collapsed branch', () => {
    const { host, view } = mountIn(deepMap());
    assert.equal(nodeEl(host, 'd1').hasClass('is-collapsed'), true);

    view.focusNode('d3');
    assert.equal(nodeEl(host, 'd1').hasClass('is-collapsed'), false, 'the branch above it opened');
    assert.equal(nodeEl(host, 'd2').hasClass('is-collapsed'), false);
    assert.equal(nodeEl(host, 'd3').hasClass('is-focused'), true);
    assert.equal(view.getFocusedId(), 'd3');

    view.focusNode('no-such-node');
    assert.equal(view.getFocusedId(), null, 'an id the map does not know clears rather than throws');
});

test('collapsing a branch drops a focus that has just been hidden', () => {
    const { host, view } = mountIn(simpleMap());
    view.focusNode('ps2');
    nodeEl(host, 'light').click();
    assert.equal(nodeEl(host, 'light').hasClass('is-collapsed'), true);
    assert.equal(view.getFocusedId(), null, 'the map does not keep a focus nobody can see');
});

test('the measured host decides the label band, and Fit measures it again', () => {
    const narrow = mountIn(simpleMap(), 340);
    const narrowMap = narrow.host.querySelector('.sf-mm-map') as MiniElement;
    assert.equal(narrowMap.hasClass('is-narrow'), true, 'a 340px sidebar gets the narrow band');
    assert.equal(narrowMap.hasClass('is-wide'), false);

    const wide = mountIn(simpleMap(), 900);
    assert.equal((wide.host.querySelector('.sf-mm-map') as MiniElement).hasClass('is-wide'), true);

    const unmeasured = mountIn(simpleMap(), 0);
    assert.equal((unmeasured.host.querySelector('.sf-mm-map') as MiniElement).hasClass('is-mid'), true, 'an unmeasured host gets the middle');

    // The same host, remeasured by Fit: the band follows the host, not the mount.
    (narrow.host as unknown as { clientWidth: number }).clientWidth = 900;
    narrow.view.fit();
    assert.equal(narrowMap.hasClass('is-wide'), true, 'Fit re-measured the host');
    assert.equal(narrowMap.hasClass('is-narrow'), false, 'and dropped the band it was in');

    assert.equal(mindMapBand(339), 'narrow');
    assert.equal(mindMapBand(420), 'mid');
    assert.equal(mindMapBand(820), 'wide');
    assert.equal(mindMapBand(0), 'mid');
});

test('a 200-character label is capped, titled and never clipped in silence', () => {
    const label = 'Supercalifragilisticexpialidocious'.repeat(6).slice(0, 200); // 200 characters, and one unbroken token
    assert.equal(label.length, 200);
    const map: StudyMindMap = {
        title: 'Long labels',
        root: { id: 'root', label, children: [{ id: 'kid', label: 'Kid', children: [{ id: 'kid2', label: 'Kid two' }] }] },
    };

    const { host } = mountIn(map, 340);
    const rendered = nodeEl(host, 'root').byClass('sf-mm-label')[0];
    assert.equal(rendered.text.length, 200, 'every character of the label is in the DOM');
    assert.equal(rendered.getAttribute('title'), label, 'and the title carries all of them');

    // The measurement the mini DOM can make: the cap the chosen band sets is
    // read out of the real stylesheet, and the node box the label can build is
    // compared with the host width that chose the band.
    const stylesheet = read('styles/study-mindmap.css');
    const variables = read('styles/_variables.css');
    const cap = px(stylesheet, '.sf-mm-map.is-narrow', '--sf-mm-label-max');
    const toggle = px(stylesheet, '.sf-mm-toggle', 'width');
    const padding = /padding:\s*(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px/.exec(ruleBody(stylesheet, '.sf-mm-node'));
    assert.ok(padding, 'the node padding is legible');
    const gap = px(variables, ':root', '--sf-space-xs');
    const nodeBox = cap + toggle + Number(padding[2]) * 2 + gap;
    assert.ok(nodeBox <= 340, `a 200-character label builds a ${nodeBox}px node inside a 340px host`);

    const labelRule = ruleBody(stylesheet, '.sf-mm-label');
    assert.match(labelRule, /max-width:\s*var\(--sf-mm-label-max\)/, 'the cap is what the label is drawn to');
    assert.match(labelRule, /white-space:\s*normal/, 'a label is a button, so it has to be told to wrap');
    assert.match(labelRule, /overflow-wrap:\s*anywhere/, 'one unbroken token has to be allowed to break');
});

test('a 40-node map mounts, reports its node count and stays usable', () => {
    const map = largeMap();
    assert.equal(mapNodeCount(map.root), 40);

    const { host, view } = mountIn(map, 340);

    assert.equal(host.byClass('sf-mm-node').length, 40);
    assert.equal(host.textOf('sf-mm-count'), '40 nodes');
    assert.equal((host.querySelector('.sf-mm-map') as MiniElement).hasClass('is-narrow'), true);

    // Usable means drivable: the whole tree is reachable one arrow key at a time.
    const seen: string[] = [];
    for (let i = 0; i < 39; i += 1) {
        seen.push(view.getActiveId() ?? '');
        assert.equal(press(view, 'ArrowDown'), true);
    }
    assert.equal(view.getActiveId(), 'leaf-35', 'the last leaf in document order');
    assert.equal(new Set(seen).size, 39, '39 distinct nodes on the way down');
});

// --------------------------------------------------- the bulk controls

test('the toolbar carries Expand all and Collapse all beside the title and the live count', () => {
    const { host } = mountIn(simpleMap());
    const tools = host.querySelector('.sf-mm-tools') as MiniElement;
    assert.ok(tools, 'the toolbar has a tools row');
    assert.deepEqual(
        tools.children.map(button => button.text),
        ['Expand all', 'Collapse all', 'Fit'],
        'the bulk controls come first, in sentence case'
    );
    for (const button of tools.children) {
        assert.equal(button.tag, 'button', `${button.text} is a real button`);
        assert.equal(button.getAttribute('type'), 'button');
        assert.ok(button.getAttribute('title'), `${button.text} says what it does on hover`);
    }
    // The map is opened whole from the header, not branch by branch: the two
    // bulk controls are the reason a 24-node map is one press to read.
    assert.equal(host.textOf('sf-mm-count'), '5 nodes');
});

test('Expand all opens the whole map and Collapse all folds it back', () => {
    const { host, view } = mountIn(largeMap(), 340);
    const expandAll = host.querySelector('.sf-mm-expand-all') as MiniElement;
    const collapseAll = host.querySelector('.sf-mm-collapse-all') as MiniElement;
    assert.ok(expandAll && collapseAll, 'both bulk controls are mounted');

    // A 40-node, three-level map fits on screen as it mounts, so nothing is
    // folded and the one control that could do nothing says so.
    assert.deepEqual(collapsedIds(host), []);
    assert.equal(host.textOf('sf-mm-count'), '40 nodes');
    assert.equal(expandAll.disabled, true, 'Expand all is dead while nothing is folded');
    assert.equal(collapseAll.disabled, false, 'Collapse all is live');

    collapseAll.click();
    assert.deepEqual(collapsedIds(host), ['branch-0', 'branch-1', 'branch-2'], 'every branch below the root folded');
    assert.equal(host.textOf('sf-mm-count'), '4 of 40 nodes', 'the count follows the fold');
    assert.equal(expandAll.disabled, false);
    assert.equal(collapseAll.disabled, true, 'and Collapse all is dead once every branch is folded');

    expandAll.click();
    assert.deepEqual(collapsedIds(host), [], 'one press opens what 36 carets would have');
    assert.equal(host.textOf('sf-mm-count'), '40 nodes');
    assert.equal(expandAll.disabled, true, 'the two controls trade places');
    assert.equal(collapseAll.disabled, false);
    assert.equal(view.getActiveId(), 'root', 'and the cursor is where the reader left it');
});

test('a bulk fold drops a focus it has just hidden, and keeps one it has not', () => {
    const { host, view } = mountIn(deepMap());
    assert.deepEqual(collapsedIds(host), ['d1', 'd2', 'd3'], 'the deep map starts folded');

    view.expandAll();
    assert.deepEqual(collapsedIds(host), [], 'the API opens it whole');
    assert.equal(host.textOf('sf-mm-count'), '5 nodes');

    view.focusNode('d4');
    assert.equal(view.getFocusedId(), 'd4');
    view.collapseAll();
    assert.deepEqual(collapsedIds(host), ['d1', 'd2', 'd3']);
    assert.equal(host.textOf('sf-mm-count'), '2 of 5 nodes');
    assert.equal(view.getFocusedId(), null, 'the map does not keep a focus nobody can see');
    assert.equal(host.textOf('sf-mm-detail-label'), 'No node selected');

    // A node the fold leaves on screen keeps its focus.
    view.focusNode('d1');
    view.collapseAll();
    assert.equal(view.getFocusedId(), 'd1', 'a visible focus survives a fold');
});

// ---------------------------------------------- labels are text on a chip

test("the map's own rules out-rank Obsidian's button paint, one level deeper", () => {
    const stylesheet = read('styles/study-mindmap.css');
    const clean = withoutComments(stylesheet);

    // Obsidian's sheet paints `button:not(.clickable-icon)` — worth (0,1,1) — with
    // `background-color: var(--interactive-normal)` and `box-shadow:
    // var(--input-shadow)`. A single-class rule of ours loses to it whatever the
    // order, so every control the map draws as a button is styled one level
    // deeper. Both halves are asserted: the rule is prefixed, and the label's
    // own reset is intact behind the prefix.
    for (const control of ['.sf-mm-label', '.sf-mm-toggle', '.sf-mm-btn']) {
        const escaped = control.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.match(
            clean,
            new RegExp(`(?:^|\\n)[\\t ]*\\.sf-mm-map\\s+${escaped}[\\t ]*\\{`),
            `${control} is not written deep enough to out-rank the app's button paint`
        );
    }

    const label = ruleBody(stylesheet, '.sf-mm-label');
    assert.match(label, /background:\s*transparent/, 'a label carries no fill of its own');
    assert.match(label, /border:\s*none/, 'and no box');
    assert.match(label, /box-shadow:\s*none/, 'and no input shadow: the inset highlight line over the text');
    assert.match(label, /appearance:\s*none/, 'and no native button appearance');
    assert.match(label, /color:\s*var\(--text-normal\)/, 'the label is text, drawn in the reading colour, always');
});

test('no rule in the map paints a fill behind a label', () => {
    const stylesheet = read('styles/study-mindmap.css');

    // The defect the reader reported was a highlight over the words, and it was
    // a background the app's button rule painted. The contract against it is
    // structural: whatever the state, no rule in this sheet puts a fill behind a
    // label — a selection is drawn around the text (border and chip fill), never
    // on it.
    const fills = labelRules(stylesheet).flatMap(rule =>
        Array.from(rule.matchAll(/background(?:-color)?:\s*([^;}]+)/g)).map(match => match[1].trim())
    );
    assert.ok(fills.length > 0, 'the label declares its own background');
    assert.deepEqual(fills.filter(value => value !== 'transparent'), [], 'a rule paints a fill behind a label');
    assert.ok(labelRules(stylesheet).length >= 4, 'expected to find the label rules');

    // The selected state is the chip: an accent border, an accent-tinted box and
    // an accent edge — the label itself is untouched.
    const focused = ruleBody(stylesheet, '.sf-mm-node.is-focused');
    assert.match(focused, /border-color:\s*var\(--sf-primary\)/, 'the pick carries the accent border');
    assert.match(focused, /background:\s*var\(--sf-primary-light\)/, 'and the accent fill, on the chip');
    assert.equal(
        /\.sf-mm-node\.is-focused\s+\.sf-mm-label\s*\{/.test(withoutComments(stylesheet)),
        false,
        'the selected label is never repainted'
    );
});

test('the teardown removes the whole subtree and every listener it bound', () => {
    const { host, view, teardown } = mountIn(simpleMap());
    const mapEl = host.querySelector('.sf-mm-map') as MiniElement;
    const viewport = host.querySelector('.sf-mm-viewport') as MiniElement;
    const fit = host.querySelector('.sf-mm-fit') as MiniElement;
    const label = nodeEl(host, 'root').byClass('sf-mm-label')[0];

    assert.ok(viewport.listenerCount('keydown') > 0, 'the tree listens for keys');
    assert.ok(fit.listenerCount('click') > 0);
    assert.ok(label.listenerCount('click') > 0);
    assert.equal(mapEl.isConnected, true);

    teardown();

    assert.equal(host.byClass('sf-mm-map').length, 0, 'the map is gone from the host');
    assert.equal(host.children.length, 0, 'and nothing of it is left behind');
    assert.equal(mapEl.isConnected, false);
    assert.equal(viewport.listenerCount('keydown'), 0, 'the keyboard listener went with it');
    assert.equal(fit.listenerCount('click'), 0);
    assert.equal(label.listenerCount('click'), 0);
    assert.equal(mapEl.parent, null, 'and the tree is detached, not orphaned in place');
    assert.equal(host.byClass('sf-mm-node').length, 0, 'no node survives in the host');

    // The tree cannot be driven after its teardown, and a second teardown is a no-op.
    assert.equal(press(view, 'ArrowDown'), false);
    assert.equal(view.getFocusedId(), null);
    teardown();
    assert.equal(host.children.length, 0);
});

test('the map hides a collapsed branch, and pins it in the stylesheet', () => {
    const stylesheet = read('styles/study-mindmap.css');
    assert.match(stylesheet, /\.sf-mm-children\.is-collapsed\s*\{[^}]*display:\s*none/, 'the class is what hides the subtree');
    assert.match(stylesheet, /\.sf-mm-map\.is-focus-mode\s+\.sf-mm-node\s*\{[^}]*opacity/, 'the focus lens dims the rest of the map');
    assert.match(stylesheet, /\.sf-mm-node\.is-collapsed\s+\.sf-mm-toggle-mark/, 'the toggle says which way the branch is');
});

test('every class the mind map renders has a rule in its own stylesheet', () => {
    const source = read('ui/study-mindmap.ts');
    const css = read('styles/study-mindmap.css');

    // The same scan the repo runs over its other surfaces: every `sf-` token in
    // the module, including the ones a comment mentions.
    const tokens = new Set(
        [...source.matchAll(/sf-[a-z0-9-]+/g)]
            .map(match => match[0])
            .filter(token => !token.endsWith('-'))
    );
    const missing = [...tokens].filter(token => !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(tokens.size > 12, `expected to find the map's classes, found ${tokens.size}`);

    // The state classes are not `sf-` prefixed, so they are pinned by name: the
    // module renders each one and the stylesheet has a rule for it.
    const states = ['is-root', 'is-collapsed', 'is-focused', 'is-ancestor', 'is-cursor', 'is-focus-mode', 'is-narrow', 'is-mid', 'is-wide', 'is-idle'];
    for (const state of states) {
        assert.match(source, new RegExp(`'${state}'`), `the module never renders ${state}`);
        assert.ok(css.includes(`.${state}`), `${state} has no rule in the stylesheet`);
    }

    // Styling belongs in the stylesheet: the module sets no inline styles.
    assert.equal(/\.style\.[a-zA-Z]+\s*=/.test(source), false, 'no inline style assignments');
});

// --------------------------------------------------- the map reads as a map

test('a connector is drawn for every non-root node and none for the root', () => {
    const map = simpleMap();
    const { host } = mountIn(map);

    const drawn = connectors(host);
    assert.equal(drawn.length, mapNodeCount(map.root) - 1, 'one edge for every node but the root');
    assert.equal(nodeEl(host, 'root').byClass('sf-mm-connector').length, 0, 'the root has no parent to point at');
    for (const id of ['light', 'calvin', 'ps2', 'ps1']) {
        assert.equal(nodeEl(host, id).byClass('sf-mm-connector').length, 1, `${id} draws its own edge`);
    }
    // An edge lives inside the thing a collapse hides, so no line is ever left
    // pointing into a subtree that is not on screen.
    for (const connector of drawn) {
        assert.ok(connector.closest('.sf-mm-children'), 'a connector sits in the branch it feeds');
        assert.equal(connector.getAttribute('aria-hidden'), 'true', 'and says nothing to a screen reader');
    }

    const stylesheet = read('styles/study-mindmap.css');
    const rule = ruleBody(stylesheet, '.sf-mm-connector');
    assert.match(rule, /position:\s*absolute/, 'the edge is positioned against the node it feeds');
    assert.match(
        rule,
        /border-(left|bottom):\s*var\(--sf-mm-link-width\) solid var\(--sf-mm-link\)/,
        'the edge is a drawn line'
    );
    // One token for every line in the map, and it is a theme token, not a
    // literal grey: a hard-coded line is invisible on a dark theme.
    assert.match(ruleBody(stylesheet, '.sf-mm-map'), /--sf-mm-link:\s*var\(--text-(muted|faint)/);
    assert.match(
        stylesheet,
        /\.sf-mm-children\s*\{[^}]*border-left:\s*var\(--sf-mm-link-width\) solid var\(--sf-mm-link\)/,
        'the spine the children hang from is the same line'
    );
    assert.match(
        stylesheet,
        /\.sf-mm-children:not\(\.is-row\)::before\s*\{[^}]*background:\s*var\(--sf-mm-link\)/,
        'and the spine is attached to the chip it hangs from'
    );
});

test('collapsing a branch hides that branch\'s connectors with it', () => {
    const { host } = mountIn(simpleMap());
    assert.equal(connectors(host).length, 4);
    assert.equal(hiddenConnectors(host).length, 0, 'nothing is hidden while the map is open');

    nodeEl(host, 'light').click();
    const hidden = hiddenConnectors(host);
    assert.equal(hidden.length, 2, 'both edges into the hidden subtree went with it');
    assert.equal(connectors(host).length - hidden.length, 2, 'and the edges on screen are the ones to nodes on screen');

    nodeEl(host, 'light').click();
    assert.equal(hiddenConnectors(host).length, 0, 'the edges come back with the branch');
    assert.equal(connectors(host).length, 4, 'no edge is lost or duplicated on the way');
});

test('every node — the root included — is drawn as the same chip', () => {
    const { host } = mountIn(simpleMap());
    const nodes = host.byClass('sf-mm-node');
    assert.equal(nodes.length, 5);
    for (const node of nodes) {
        assert.equal(
            node.hasClass('sf-mm-node-chip'),
            true,
            `${node.getAttribute('data-node-id')} is a chip, not bare text beside one`
        );
    }

    const stylesheet = read('styles/study-mindmap.css');
    const chip = ruleBody(stylesheet, '.sf-mm-node-chip');
    assert.match(chip, /border:\s*var\(--sf-mm-chip-border\)\s+solid\s+var\(--background-modifier-border\)/, 'a chip is a box, so it has a border');
    assert.match(chip, /border-radius:/, 'and a shape');
    assert.match(chip, /background:/, 'and a fill');
    // The border width is one token, because the connectors are positioned
    // against it: a chip that changed it silently would leave every edge a
    // pixel wide of its chip.
    assert.match(ruleBody(stylesheet, '.sf-mm-map'), /--sf-mm-chip-border:\s*1px/);

    // The root differs by accent only: the same box, painted with the accent.
    const root = ruleBody(stylesheet, '.sf-mm-branch.is-root > .sf-mm-node');
    assert.match(root, /border-color:\s*var\(--sf-primary\)/, 'the root carries the accent border');
    assert.match(root, /background:\s*var\(--sf-primary-light\)/, 'and the accent fill');
    assert.ok(!/(^|;)\s*(width|height|padding|border-radius)\s*:/.test(root), 'the root is not a different shape');
});

test('a branch with more than two children fans into a row on a wide host only', () => {
    const stylesheet = read('styles/study-mindmap.css');

    const wide = mountIn(fanMap(), 900);
    assert.equal((wide.host.querySelector('.sf-mm-map') as MiniElement).hasClass('is-wide'), true);
    assert.equal(childGroup(wide.host, 'root').hasClass('is-row'), true, 'three children are laid out as a row');

    const narrow = mountIn(fanMap(), 340);
    assert.equal((narrow.host.querySelector('.sf-mm-map') as MiniElement).hasClass('is-narrow'), true);
    assert.equal(childGroup(narrow.host, 'root').hasClass('is-row'), false, 'a 340px host keeps its one column');

    // Two children stay a column however wide the host is.
    const pair = mountIn(simpleMap(), 900);
    assert.equal(childGroup(pair.host, 'root').hasClass('is-row'), false);
    assert.equal(childGroup(pair.host, 'light').hasClass('is-row'), false);

    // Fit measures the host again, so the fan follows the host it has now.
    (narrow.host as unknown as { clientWidth: number }).clientWidth = 900;
    narrow.view.fit();
    assert.equal((narrow.host.querySelector('.sf-mm-map') as MiniElement).hasClass('is-wide'), true);
    assert.equal(childGroup(narrow.host, 'root').hasClass('is-row'), true, 'Fit re-decided the rows');

    // The row is a row in the stylesheet, it wraps, and its width is the box it
    // actually scrolls in — a wide host is used to its own width.
    const row = ruleBody(stylesheet, '.sf-mm-children.is-row');
    assert.match(row, /flex-direction:\s*row/);
    assert.match(row, /flex-wrap:\s*wrap/);
    assert.match(row, /max-width:\s*calc\(100cqw/, 'the row measures itself against its viewport, never against a guess');
    assert.match(ruleBody(stylesheet, '.sf-mm-viewport'), /container-type:\s*inline-size/, 'and the viewport is what it measures');
});

test('a broad map fans out at every branch, and a deep one still mounts', () => {
    const deep = mountIn(deepMap(), 900);
    assert.equal(deep.host.byClass('sf-mm-node').length, 5, 'the deep map mounts whole');
    assert.equal(connectors(deep.host).length, 4, 'with an edge for every node but the root');
    assert.deepEqual(collapsedIds(deep.host), ['d1', 'd2', 'd3'], 'and the default collapse still applies');

    const broad = mountIn(largeMap(), 900);
    assert.equal((broad.host.querySelector('.sf-mm-map') as MiniElement).hasClass('is-wide'), true);
    assert.equal(childGroup(broad.host, 'root').hasClass('is-row'), true, 'the three branches fan out');
    assert.equal(childGroup(broad.host, 'branch-0').hasClass('is-row'), true, 'and so do the twelve leaves under each');
    assert.equal(broad.host.byClass('sf-mm-node').length, 40);
    assert.equal(connectors(broad.host).length, 39);

    // A fan is still walked the same way: the keyboard goes by the map's order,
    // and the row is only how it is drawn.
    for (let step = 0; step < 39; step += 1) assert.equal(press(broad.view, 'ArrowDown'), true);
    assert.equal(broad.view.getActiveId(), 'leaf-35');
});

test('the teardown takes the connectors and the chips with it', () => {
    const { host, teardown } = mountIn(simpleMap());
    assert.equal(connectors(host).length, 4);
    assert.equal(host.byClass('sf-mm-node-chip').length, 5);

    teardown();

    assert.equal(connectors(host).length, 0, 'not one edge survives the map');
    assert.equal(host.byClass('sf-mm-node-chip').length, 0, 'and not one chip');
    assert.equal(host.children.length, 0, 'the host is left as it was found');
});
