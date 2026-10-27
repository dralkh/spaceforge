/**
 * The study briefing (ui/study-briefing.ts) is the launch screen: what a reader
 * sees before a session starts, and in what order. Its whole job is decisions —
 * is anything blocking, what does the one obvious button do, what will this
 * teach, where am I with it, how should it run — so the assertions here are
 * about reading order and about the one control that answers each question.
 *
 * The view is mounted over the miniature DOM with a plain host object, which is
 * the point of extracting it: the screen is testable without a panel, a plugin
 * or a session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MiniElement, flatten, textsOfClass } from './support/mini-dom';
import { StudyMode, StudyObjectiveStatus, StudyObjectiveType, createObjectiveProgress } from '../models/study';
import type { ObjectiveProgressState, StudyObjective, StudyPlan } from '../models/study';
import { coerceVisualPack } from '../models/study-visuals';
import type { StudyBriefing } from '../services/study-session-service';
import type { StudyImageRef } from '../utils/study-media';
import { StudyBriefingHost, StudyBriefingView } from '../ui/study-briefing';

// ---------------------------------------------------------------- fixtures

const TITLES = [
    'Cardiac output',
    'Preload',
    'Afterload',
    'Contractility',
    'Frank–Starling',
    'Compliance',
    'Resistance',
    'Shunts',
    'Compensation',
    'Failure',
];

const objective = (index: number): StudyObjective => ({
    id: `obj-${index}`,
    title: TITLES[index] ?? `Objective ${index}`,
    statement: `Statement for ${TITLES[index] ?? index}, one idea, kept short for the fixture.`,
    type: StudyObjectiveType.Mechanism,
    importance: 'standard',
    prerequisites: [],
    anchors: [],
});

const entry = (index: number, status = StudyObjectiveStatus.Unseen) => ({
    objective: objective(index),
    state: { ...createObjectiveProgress(), status } as ObjectiveProgressState,
});

const tenObjectives = (status = StudyObjectiveStatus.Unseen) =>
    TITLES.map((_, index) => entry(index, status));

const makeBriefing = (overrides: Partial<StudyBriefing> = {}): StudyBriefing => ({
    notePath: 'notes/acid-base.md',
    noteTitle: 'Acid–base balance',
    hasPlan: true,
    stale: false,
    domainId: 'medicine',
    domainLabel: 'Medicine',
    domainNotes: '',
    safetyCritical: false,
    topicSummary: 'How the body keeps pH where enzymes work.',
    totalObjectives: 10,
    covered: 0,
    mastered: 0,
    fragile: 0,
    masteryScore: 0,
    due: [],
    objectives: tenObjectives(),
    lastSessionSummary: null,
    lastSessionAt: null,
    sessionsCount: 0,
    tutorMemory: [],
    suggestedMode: StudyMode.Guided,
    providerReady: true,
    providerReason: null,
    providerLabel: 'OpenRouter',
    providerModel: 'model-x',
    searchAvailable: true,
    searchLabel: 'Tavily',
    searchReason: null,
    webDefault: false,
    ...overrides,
} as StudyBriefing);

const image = (): StudyImageRef => ({
    id: 'img-1',
    raw: '![[figure.png]]',
    syntax: 'embed',
    target: 'figure.png',
    fileName: 'figure.png',
    resolvedPath: null,
});

/** A plan stub: only the figure rail reads it, and only for its images. */
const planWith = (images: StudyImageRef[]): StudyPlan => ({ images } as unknown as StudyPlan);

/**
 * A real pack, coerced through the model: the material buttons mount the same
 * renderers the section does, so the fixture has to be the shape those read.
 */
const materialPack = () => {
    const pack = coerceVisualPack(
        {
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
        },
        { domain: 'medicine', sourceHash: 'hash-1' },
    );
    assert.ok(pack, 'the fixture must coerce');
    return pack;
};

interface Calls {
    start: boolean[];
    rechart: number;
    domain: [string, string][];
    mode: StudyMode[];
    lookup: boolean[];
    figures: number;
}

interface Harness {
    root: MiniElement;
    view: StudyBriefingView;
    calls: Calls;
    slot: MiniElement | null;
}

function mount(overrides: Partial<StudyBriefing> = {}, patch: Partial<StudyBriefingHost> = {}): Harness {
    const root = new MiniElement('div');
    const calls: Calls = { start: [], rechart: 0, domain: [], mode: [], lookup: [], figures: 0 };
    let slot: MiniElement | null = null;
    const host: StudyBriefingHost = {
        briefing: makeBriefing(overrides),
        plan: null,
        mode: StudyMode.Guided,
        webLookup: false,
        charting: false,
        studyMinutes: 15,
        materialPack: null,
        materialStale: false,
        materialSlot: element => {
            slot = element as unknown as MiniElement;
        },
        start: fresh => calls.start.push(fresh),
        rechart: () => {
            calls.rechart += 1;
        },
        changeDomain: (domainId, notes) => calls.domain.push([domainId, notes]),
        changeMode: mode => calls.mode.push(mode),
        toggleLookup: on => calls.lookup.push(on),
        figureSource: () => null,
        openFigure: () => {
            calls.figures += 1;
        },
        ...patch,
    };
    const view = new StudyBriefingView();
    view.mount(root, host);
    return { root, view, calls, slot };
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

/** The section names the briefing rendered, in DOM order. */
const sections = (root: MiniElement): string[] =>
    byClass(root, 'sf-brief-section').map(element => element.getAttribute('data-section') ?? '');

const section = (root: MiniElement, name: string): MiniElement | null =>
    byClass(root, 'sf-brief-section').find(element => element.getAttribute('data-section') === name) ?? null;

const primary = (root: MiniElement): MiniElement => {
    const buttons = byClass(root, 'sf-brief-primary');
    assert.equal(buttons.length, 1, 'there is exactly one primary action');
    return buttons[0];
};

const modeButton = (root: MiniElement, label: string) =>
    byClass(root, 'sf-study-mode').find(button => flatten(button).includes(label));

/** The richer fixture: progress, something due, memory, and one figure. */
const studiedPatch: Partial<StudyBriefingHost> = {
    plan: planWith([image()]),
};

// ---------------------------------------------------------------- reading order

test('the briefing reads in launch order, warning to provider line', () => {
    const { root } = mount(
        {
            covered: 4,
            mastered: 2,
            fragile: 1,
            masteryScore: 0.42,
            due: [{ objectiveId: 'obj-0', title: 'Cardiac output', overdueDays: 2 }],
            lastSessionSummary: 'Worked through the four disturbances.',
            tutorMemory: ['Confuses preload with contractility.'],
            lastSessionAt: Date.now() - 6 * 86400000,
        },
        studiedPatch,
    );

    assert.deepEqual(sections(root), [
        'launch',
        'objectives',
        'progress',
        'context',
        'options',
        'figures',
        'material',
    ]);
    // The same order, read off the section classes themselves.
    const classes = byClass(root, 'sf-brief-section')
        .map(element => [...element.classes].filter(cls => cls !== 'sf-brief-section')[0]);
    assert.deepEqual(classes, [
        'sf-brief-launch',
        'sf-brief-objectives',
        'sf-brief-progress',
        'sf-brief-context',
        'sf-brief-options',
        'sf-brief-figures',
        'sf-brief-material',
    ]);
    assert.equal(section(root, 'warning'), null, 'a fresh chart has nothing blocking');
    assert.equal(section(root, 'provider'), null, 'a working model needs no caption');
});

test('a stale chart opens with the blocking notice, above everything else', () => {
    const { root, calls } = mount({ stale: true });

    assert.equal(sections(root)[0], 'warning', 'the warning is the first section');
    assert.match(flatten(section(root, 'warning') as MiniElement), /This note changed since it was charted/);
    assert.equal(byClass(root, 'sf-study-banner-warn').length, 1);

    // And the move it points at is the primary action, not a small button.
    const button = primary(root);
    assert.equal(flatten(button), 'Re-chart this note');
    button.click();
    assert.equal(calls.rechart, 1);
    assert.deepEqual(calls.start, [], 'a stale chart does not offer to start');
});

test('a fresh chart’s primary action starts studying', () => {
    const { root, calls } = mount();
    const button = primary(root);
    assert.equal(flatten(button), 'Start studying');
    assert.equal(button.disabled, false);
    button.click();
    assert.deepEqual(calls.start, [false]);
});

test('the primary action is the only element wearing the primary button class', () => {
    for (const stale of [false, true]) {
        const { root } = mount({ stale });
        const filled = byClass(root, 'sf-btn-primary');
        assert.equal(filled.length, 1, `one filled button with stale=${stale}`);
        assert.equal(filled[0], primary(root));
        assert.equal(section(root, 'launch')?.find(element => element === filled[0]), filled[0], 'it is in the launch header');
    }
});

test('start fresh and re-chart are links under the primary, not peer buttons', () => {
    const { root, calls } = mount();
    const links = byClass(root, 'sf-brief-link');
    assert.deepEqual(links.map(link => flatten(link)), ['Start fresh', 'Re-chart']);
    for (const link of links) assert.equal(link.classList.contains('sf-btn-primary'), false);

    links[0].click();
    assert.deepEqual(calls.start, [true], 'fresh is reported as a fresh start');
    links[1].click();
    assert.equal(calls.rechart, 1);
});

test('a stale note offers Start anyway as the secondary way in', () => {
    const { root, calls } = mount({ stale: true });
    const links = byClass(root, 'sf-brief-link');
    assert.deepEqual(links.map(link => flatten(link)), ['Start anyway', 'Start fresh']);
    links[0].click();
    assert.deepEqual(calls.start, [false]);
});

test('the scope line counts objectives, the estimate and the last session', () => {
    const { root } = mount({ lastSessionAt: Date.now() - 6 * 86400000 });
    assert.equal(textsOfClass(root, 'sf-brief-scope')[0], '10 objectives · about 15 min · last studied 6 days ago');
});

test('a fact that cannot be computed is left out of the scope line', () => {
    const { root } = mount({}, { studyMinutes: null });
    assert.equal(textsOfClass(root, 'sf-brief-scope')[0], '10 objectives');
});

// ---------------------------------------------------------------- objectives

test('the objectives summary previews three titles and opens the rest on demand', () => {
    const { root } = mount();
    const summary = byClass(root, 'sf-brief-objectives-summary')[0];
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    const text = flatten(summary);
    assert.match(text, /Cardiac output, Preload, Afterload/);
    assert.match(text, /\+7 more/);
    assert.ok(!text.includes('Contractility'), 'a fourth title is not on the summary line');

    assert.equal(byClass(root, 'sf-study-objective-list').length, 0, 'nothing is rendered until it is opened');
    assert.equal(byClass(root, 'sf-study-obj').length, 0);

    summary.click();
    assert.equal(summary.getAttribute('aria-expanded'), 'true');
    assert.equal(byClass(root, 'sf-study-objective-list').length, 1);
    const rows = byClass(root, 'sf-study-obj');
    assert.equal(rows.length, 10, 'the whole chart is there once it is asked for');
    assert.ok(rows.every(row => row.classList.contains('is-static')), 'rows in the briefing are read-only');
    assert.match(flatten(rows[3]), /Contractility/);

    summary.click();
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    assert.equal(byClass(root, 'sf-study-objective-list').length, 0, 'closing takes the list away again');
});

test('every objective row carries its mastery state marker', () => {
    const { root } = mount({ objectives: tenObjectives(StudyObjectiveStatus.Fragile) });
    byClass(root, 'sf-brief-objectives-summary')[0].click();
    const markers = byClass(root, 'sf-study-obj-status');
    assert.equal(markers.length, 10);
    for (const marker of markers) assert.equal(marker.getAttribute('title'), 'Fragile');
    const rows = byClass(root, 'sf-study-obj');
    for (const row of rows) assert.equal(row.getAttribute('data-status'), StudyObjectiveStatus.Fragile);
});

// ---------------------------------------------------------------- honest statistics

test('with no progress the briefing states that plainly instead of four zeroes', () => {
    const { root } = mount();
    assert.equal(byClass(root, 'sf-study-stat').length, 0, 'no stat tiles before anything is studied');
    assert.equal(textsOfClass(root, 'sf-brief-progress-empty')[0], 'Nothing studied yet · 10 objectives ready');
    assert.ok(!/Mastery/.test(flatten(root)), 'no mastery percentage on an untouched note');
});

test('with progress the mastery row renders, next to what is due', () => {
    const { root } = mount({
        covered: 4,
        mastered: 2,
        fragile: 1,
        masteryScore: 0.42,
        due: [{ objectiveId: 'obj-1', title: 'Preload', overdueDays: 0 }],
    });
    const progress = section(root, 'progress') as MiniElement;
    const tiles = progress.byClass('sf-study-stat');
    assert.equal(tiles.length, 4);
    assert.deepEqual(tiles.map(tile => flatten(tile).replace(/\d+%?/g, '').trim()), ['Covered', 'Solid', 'Fragile', 'Mastery']);
    assert.match(flatten(tiles[3]), /42%/);
    assert.match(flatten(progress.byClass('sf-study-due')[0]), /1 objective due for review/);
});

// ---------------------------------------------------------------- session options

test('the lookup toggle sits inside the session-options section', () => {
    const { root, calls } = mount();
    const options = section(root, 'options') as MiniElement;
    assert.equal(options.byClass('sf-study-mode-grid').length, 1, 'the mode grid is in the same section');
    const switches = options.byClass('sf-study-switch');
    assert.equal(switches.length, 1, 'and so is the lookup toggle');
    assert.equal(switches[0].getAttribute('aria-pressed'), 'false');

    switches[0].click();
    assert.deepEqual(calls.lookup, [true]);
    assert.equal(switches[0].classList.contains('is-on'), true);
});

test('the lookup toggle starts on when the panel says lookup is on', () => {
    const { root } = mount({}, { webLookup: true });
    const toggle = byClass(root, 'sf-study-switch')[0];
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.classList.contains('is-on'), true);
});

test('the mode grid selects one mode and reports it to the panel', () => {
    const { root, calls } = mount();
    const drill = modeButton(root, 'Rapid drill') as MiniElement;
    drill.click();

    assert.deepEqual(calls.mode, [StudyMode.Drill]);
    assert.equal(drill.classList.contains('is-selected'), true);
    const selected = byClass(root, 'sf-study-mode').filter(button => button.classList.contains('is-selected'));
    assert.equal(selected.length, 1, 'exactly one mode stays selected');
});

// ---------------------------------------------------------------- the panel's own facts

test('correcting the subject lens reports the choice to the panel', () => {
    const { root, calls } = mount();
    const edit = byClass(root, 'sf-study-domain-edit')[0];
    assert.equal(byClass(root, 'sf-study-domain-editor').length, 0, 'the editor waits to be asked for');
    edit.click();

    const editor = byClass(root, 'sf-study-domain-editor')[0];
    assert.ok(editor, 'the editor opens where the reader asked');
    const select = byClass(root, 'sf-study-domain-select')[0];
    select.value = 'physics';
    byClass(root, 'sf-study-domain-school')[0].value = ' Keep the units. ';
    byClass(root, 'sf-study-domain-editor-actions')[0].byClass('sf-btn')[0].click();

    assert.deepEqual(calls.domain, [['physics', 'Keep the units.']]);
});

test('figures are previewed through the panel, not in the view', () => {
    const { root, calls } = mount({}, studiedPatch);
    const figures = section(root, 'figures') as MiniElement;
    assert.equal(figures.byClass('sf-study-figure').length, 1);
    figures.byClass('sf-study-figure')[0].click();
    assert.equal(calls.figures, 1);
});

test('the material section is mounted into the slot the briefing reserves', () => {
    const { root, slot } = mount();
    assert.ok(slot, 'the panel was handed a slot');
    assert.equal(section(root, 'material'), slot, 'and it is the briefing’s material section');
});

// --------------------------------------------------------- the material buttons

/** The material button whose label is `label`. */
const materialButton = (root: MiniElement, label: string): MiniElement => {
    const button = byClass(root, 'sf-brief-material-button').find(candidate => flatten(candidate).includes(label));
    assert.ok(button, `the ${label} button exists`);
    return button;
};

const viewer = (root: MiniElement): MiniElement[] => byClass(root, 'sf-brief-material-viewer');

test('the launch row carries the three material buttons beside the primary action', () => {
    const { root } = mount({}, { materialPack: materialPack() });
    const row = byClass(root, 'sf-brief-actions')[0];
    assert.ok(row, 'the actions sit in one row');
    assert.equal(section(root, 'launch')?.find(element => element === row), row, 'the row is the launch section’s');
    assert.equal(byClass(row, 'sf-brief-primary').length, 1, 'the primary action leads the row');

    const buttons = byClass(row, 'sf-brief-material-button');
    assert.deepEqual(buttons.map(button => flatten(button)), ['Mind map', 'Visualize', 'Summary']);
    for (const button of buttons) {
        assert.equal(button.classList.contains('sf-btn-primary'), false, 'a material button is never filled');
        assert.equal(button.disabled, false, 'and it works when its material exists');
    }
    assert.equal(byClass(row, 'sf-brief-link').length, 0, 'Start fresh and Re-chart stay under the row');
});

test('a material button whose surface was never made is disabled and says why', () => {
    // Charted, but nothing made from it yet: the way to make it is named.
    const charted = mount({}, { plan: planWith([]) });
    for (const button of byClass(charted.root, 'sf-brief-material-button')) {
        assert.equal(button.disabled, true);
        assert.match(button.getAttribute('title') ?? '', /Make it in Study material/);
    }
    // Nothing charted at all: there is nothing to draw the material from yet.
    const bare = mount({ hasPlan: false, totalObjectives: 0, objectives: [], topicSummary: '' });
    for (const button of byClass(bare.root, 'sf-brief-material-button')) {
        assert.equal(button.disabled, true);
        assert.match(button.getAttribute('title') ?? '', /no chart yet/);
    }
});

test('each material button shows its own surface under the row, and only that one', () => {
    const { root } = mount({}, { materialPack: materialPack() });
    assert.equal(viewer(root).length, 0, 'nothing is mounted until it is asked for');

    materialButton(root, 'Mind map').click();
    assert.equal(viewer(root).length, 1, 'the surface opens in the briefing itself');
    const launch = section(root, 'launch') as MiniElement;
    assert.equal(launch.find(element => element === viewer(root)[0]), viewer(root)[0], 'inside the launch section');
    assert.ok(
        launch.children.indexOf(viewer(root)[0]) > launch.children.indexOf(byClass(root, 'sf-brief-actions')[0]),
        'and under the row of buttons',
    );
    assert.ok(byClass(root, 'sf-mm-node').length >= 3, 'the real map rendered');
    assert.equal(materialButton(root, 'Mind map').getAttribute('aria-pressed'), 'true');
    assert.equal(materialButton(root, 'Mind map').classList.contains('is-active'), true);

    materialButton(root, 'Visualize').click();
    assert.equal(byClass(root, 'sf-mm-node').length, 0, 'the map is gone, not hidden');
    assert.equal(byClass(root, 'sf-vb-visual').length, 1, 'the gallery is up');
    assert.equal(viewer(root).length, 1, 'still one viewer, swapped in place');
    assert.equal(materialButton(root, 'Mind map').getAttribute('aria-pressed'), 'false');

    materialButton(root, 'Summary').click();
    assert.equal(byClass(root, 'sf-vb-visual').length, 0);
    assert.equal(byClass(root, 'sf-sum-bullet').length, 3);

    materialButton(root, 'Summary').click();
    assert.equal(viewer(root).length, 0, 'pressing it again puts the surface away');
    assert.equal(byClass(root, 'sf-sum-bullet').length, 0);
    assert.equal(materialButton(root, 'Summary').getAttribute('aria-pressed'), 'false');
});

test('a pack the note has moved past still opens, and says it is out of date', () => {
    const { root } = mount({}, { materialPack: materialPack(), materialStale: true });
    materialButton(root, 'Mind map').click();
    assert.match(flatten(byClass(root, 'sf-brief-material-note')[0]), /Out of date/);
    assert.ok(byClass(root, 'sf-mm-node').length >= 3, 'stale is a warning, not a lock');
});

test('the buttons wake up when the panel makes the material', () => {
    const { root, view } = mount({}, { plan: planWith([]) });
    const buttons = byClass(root, 'sf-brief-material-button');
    assert.ok(buttons.every(button => button.disabled), 'nothing made yet');

    view.setMaterial(materialPack(), false);
    assert.ok(buttons.every(button => !button.disabled), 'the row is live once the pack lands');
    materialButton(root, 'Visualize').click();
    assert.equal(byClass(root, 'sf-vb-visual').length, 1);
});

test('taking the briefing down takes an open surface with it', () => {
    const { root, view } = mount({}, { materialPack: materialPack() });
    materialButton(root, 'Mind map').click();
    assert.ok(byClass(root, 'sf-mm-node').length >= 3);

    view.destroy();
    assert.equal(viewer(root).length, 0);
    assert.equal(byClass(root, 'sf-mm-node').length, 0);
    assert.equal(flatten(root).trim(), '');
});

test('a note with nothing charted offers to chart it', () => {
    const { root, calls } = mount({ hasPlan: false, totalObjectives: 0, objectives: [], topicSummary: '' });
    const button = primary(root);
    assert.equal(flatten(button), 'Chart this note');
    button.click();
    assert.equal(calls.rechart, 1);
    assert.equal(section(root, 'objectives'), null, 'there is nothing to list yet');
    assert.equal(section(root, 'progress'), null);
    assert.ok(section(root, 'intro'), 'the note explains what studying it will do');
});

test('an uncharted note that is being charted says so instead of offering', () => {
    const { root } = mount({ hasPlan: false, totalObjectives: 0, objectives: [], topicSummary: '' }, { charting: true });
    const button = primary(root);
    assert.equal(flatten(button), 'Waiting for objectives…');
    assert.equal(button.disabled, true);
});

// ---------------------------------------------------------------- teardown

test('every class the briefing renders has a rule in the stylesheet', () => {
    // A class rendered but never styled shows up as a bare rectangle, and a
    // renamed class fails silently — the same guard the bar keeps for itself.
    // Walked from the DOM rather than the source, so a class built as
    // `sf-brief-${name}` is caught too. `sf-btn*` come from the shared button
    // sheet; the rest are this surface's.
    const { root } = mount(
        {
            stale: true,
            covered: 4,
            mastered: 2,
            fragile: 1,
            masteryScore: 0.42,
            due: [{ objectiveId: 'obj-0', title: 'Cardiac output', overdueDays: 1 }],
            lastSessionSummary: 'Worked through the four disturbances.',
            tutorMemory: ['Confuses preload with contractility.'],
        },
        studiedPatch,
    );
    byClass(root, 'sf-brief-objectives-summary')[0].click();
    byClass(root, 'sf-study-domain-edit')[0].click();

    const css = fs.readFileSync(path.join(process.cwd(), 'styles/study.css'), 'utf8')
        + fs.readFileSync(path.join(process.cwd(), 'styles/_buttons.css'), 'utf8');
    const classes = new Set<string>();
    const walk = (element: MiniElement) => {
        for (const cls of element.classes) if (cls.startsWith('sf-')) classes.add(cls);
        for (const child of element.children) walk(child);
    };
    walk(root);

    const missing = [...classes].filter(cls => !css.includes(`.${cls}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(classes.size > 20, `expected to find the briefing’s classes, found ${classes.size}`);

    // The viewer's own classes only appear once a surface is open, and walking
    // an open one would drag the renderers' classes into this check (they live
    // in their own sheets) — so they are pinned here by name instead.
    for (const cls of ['sf-brief-material-viewer', 'sf-brief-material-note', 'sf-brief-material-surface']) {
        assert.ok(css.includes(`.${cls}`), `${cls} opens a view but has no rule`);
    }
});

test('workspace briefing retains its actions without a duplicate material row or five-mode wall', () => {
    const h = mount({}, { workspace: true });
    assert.equal(byClass(h.root, 'sf-brief-material-button').length, 0);
    assert.equal(byClass(h.root, 'sf-study-mode-grid').length, 0);
    assert.equal(byClass(h.root, 'sf-study-mode-button').length, 1);
    assert.equal(byClass(h.root, 'sf-study-switch').length, 1, 'lookup remains reachable');
    assert.equal(byClass(h.root, 'sf-study-domain-edit').length, 1, 'domain correction remains reachable');
    assert.equal(h.slot, null, 'the shared workspace owns the material host');
    byClass(h.root, 'sf-brief-primary')[0].click();
    assert.deepEqual(h.calls.start, [false]);
});

test('mounting the briefing twice replaces it instead of stacking it', () => {
    const root = new MiniElement('div');
    const view = new StudyBriefingView();
    const host: StudyBriefingHost = {
        briefing: makeBriefing(),
        plan: null,
        mode: StudyMode.Guided,
        webLookup: false,
        charting: false,
        studyMinutes: null,
        materialPack: null,
        materialStale: false,
        materialSlot: () => undefined,
        start: () => undefined,
        rechart: () => undefined,
        changeDomain: () => undefined,
        changeMode: () => undefined,
        toggleLookup: () => undefined,
        figureSource: () => null,
        openFigure: () => undefined,
    };
    view.mount(root, host);
    view.mount(root, host);
    assert.equal(byClass(root, 'sf-study-briefing').length, 1);
    assert.equal(byClass(root, 'sf-brief-launch').length, 1);

    view.destroy();
    assert.equal(byClass(root, 'sf-study-briefing').length, 0);
    assert.equal(flatten(root).trim(), '');
});
