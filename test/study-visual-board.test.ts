/**
 * The visual board and the summary, driven against the repo's mini-dom.
 *
 * These two surfaces are the other shapes a note's material takes, so what is
 * pinned here is that each one is drawn as the thing it actually is: a
 * comparison is a real table (one header row, a row per thing, a `<th>` per
 * column, the row that is the point of the comparison marked), a flow is
 * numbered steps in order with its decisions branching and its outcomes
 * ending, a cycle is a ring with the steps around it, a timeline runs one
 * marker per entry. The summary's own arithmetic is checked in words, and its
 * condensing toggle is driven until it hides exactly the non-pearl bullets and
 * puts them back.
 *
 * Two further checks are about the host rather than the content: a matrix
 * wider than a sidebar scrolls inside its own box instead of pushing the host
 * wider (asked with a small model of the CSS, because mini-dom lays nothing
 * out), and a teardown leaves the host as it was found, listeners included.
 *
 * The board's three operated forms are pinned the same way: a comparison
 * starts covered and is revealed cell by cell with the count saying how much
 * shows, a plain matrix is a reference and starts readable — while either
 * table keeps every `<td>` it was born with — a flow and a cycle are stepped
 * with exactly one step current and the rest standing back, and a timeline is
 * scrubbed by its range, its arrows or a press on a marker. The keyboard is
 * driven through the board's own `handleKey`, which is the entry point the
 * cards' keydown listeners use, so what the tests press is what the app
 * delivers.
 *
 * The motion is pinned without a clock: the board's advance is a method, and
 * the ticks come from a scheduler the test supplies and fires by hand, so
 * `is-current` can be shown travelling one step at a time, Play/Pause can be
 * shown saying which state it is in, a reader's own step can be shown stopping
 * it, and a reader who asked for reduced motion can be shown never being
 * animated at all. A comparison row's verdict is pinned as a drawn mark
 * (`is-mark-better|worse|equal` and its own chip), and a cell too long to read
 * at a glance as an ellipsised cell that keeps its whole text as a title.
 *
 * Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { StudyFlow, StudyMatrix, StudySummary, StudyTimeline, StudyVisual } from '../models/study-visuals';
import {
    CELL_DRAW_LENGTH,
    MOTION_INTERVAL_MS,
    MotionScheduler,
    MotionTimer,
    StudySummaryView,
    StudyVisualBoardOptions,
    StudyVisualBoardView,
    VERDICT_ALL_TEXT,
    branchTargetLabel,
    cellText,
    prefersReducedMotion,
    ringAngle,
    summaryCountLine,
} from '../ui/study-visual-board';

const repoRoot = process.cwd();
const CSS_PATH = 'styles/study-visual-board.css';
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

// The surfaces reach for no document of their own, but the suite installs the
// element and document globals every mini-dom suite works against, so the two
// views are exercised the way the rest of the UI is.
installMiniDocument();

/** The rule body for a selector, so the stylesheet can be asserted where it lands. */
function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at) + 1);
}

/** A cell no space can break, so the table it sits in cannot be drawn narrow. */
const LONG_CELL = 'A'.repeat(420);
/** The width a sidebar hands the board. */
const SIDEBAR_WIDTH = 340;
/** What one character costs in the overflow model below, in px. */
const CHARACTER_WIDTH = 7;

// ------------------------------------------------------------------- fixtures

function matrixFixture(): StudyMatrix {
    return {
        kind: 'matrix',
        title: 'Differential: sudden chest pain',
        columns: ['Mechanism', 'Onset', 'First move'],
        rows: [
            { label: 'Angina', cells: ['Demand mismatch', 'Minutes, with exertion', 'Rest, then nitrates'] },
            { label: 'PE', cells: ['Embolic obstruction', 'Sudden', 'Anticoagulate'], emphasis: true },
            { label: 'Pericarditis', cells: ['Inflammation of the sac', 'Days, with a prodrome', 'Lean forward, NSAIDs'] },
        ],
        pearl: 'Sudden onset with hypoxia is PE until proven otherwise.',
    };
}

function compareFixture(): StudyMatrix {
    return {
        kind: 'compare',
        title: 'Bacterial or viral?',
        columns: ['Bacterial', 'Viral'],
        rows: [
            { label: 'Onset', cells: ['Fairly rapid, often unilateral', 'Gradual, often bilateral'] },
            { label: 'Discharge', cells: ['Purulent', 'Watery'], emphasis: true },
        ],
        pearl: 'One red eye with pus is bacterial until a culture says otherwise.',
    };
}

function flowFixture(): StudyFlow {
    return {
        kind: 'flow',
        title: 'Suspected stroke: the first ten minutes',
        steps: [
            { id: 's1', label: 'Check glucose', kind: 'step' },
            {
                id: 's2',
                label: 'Is the deficit sudden?',
                kind: 'decision',
                detail: 'Ask when the last known well was',
                branches: [{ label: 'yes', to: 'scan' }, { label: 'no', to: 'reassess' }],
            },
            { id: 'scan', label: 'Straight to imaging', kind: 'outcome' },
        ],
        pearl: 'A decision is a step like any other; what matters is where its branches go.',
    };
}

function cycleFixture(): StudyFlow {
    return {
        kind: 'cycle',
        title: 'The cardiac cycle',
        steps: [
            { id: 'c1', label: 'Atrial systole', kind: 'step' },
            { id: 'c2', label: 'Mitral closes?', kind: 'decision', branches: [{ label: 'present', to: 'c3' }, { label: 'absent', to: 'listen' }] },
            { id: 'c3', label: 'Isovolumetric contraction', kind: 'step', detail: 'Both valves shut, pressure climbs' },
            { id: 'c4', label: 'Ejection', kind: 'step' },
        ],
        pearl: 'Pressure gradients open and close valves; the valves never decide anything.',
    };
}

/** A flow that moves on its own: the same process, watched rather than read. */
function movingFlowFixture(): StudyFlow {
    return {
        kind: 'flow',
        title: 'Suspected stroke: the first ten minutes',
        teach: 'Watch the highlight walk from glucose to imaging: the decision is a step like any other.',
        motion: 'flow',
        steps: [
            { id: 's1', label: 'Check glucose', kind: 'step' },
            {
                id: 's2',
                label: 'Is the deficit sudden?',
                kind: 'decision',
                detail: 'Ask when the last known well was',
                branches: [{ label: 'yes', to: 'scan' }, { label: 'no', to: 'reassess' }],
            },
            { id: 'scan', label: 'Straight to imaging', kind: 'outcome' },
        ],
        pearl: 'A decision is a step like any other; what matters is where its branches go.',
    };
}

/** A cycle that travels its ring, one node per tick. */
function movingCycleFixture(): StudyFlow {
    return {
        kind: 'cycle',
        title: 'The cardiac cycle',
        teach: 'Follow the highlight round: every step hands on to the next.',
        motion: 'cycle',
        steps: [
            { id: 'c1', label: 'Atrial systole', kind: 'step' },
            { id: 'c2', label: 'Mitral closes?', kind: 'decision', branches: [{ label: 'present', to: 'c3' }, { label: 'absent', to: 'listen' }] },
            { id: 'c3', label: 'Isovolumetric contraction', kind: 'step', detail: 'Both valves shut, pressure climbs' },
            { id: 'c4', label: 'Ejection', kind: 'step' },
        ],
        pearl: 'Pressure gradients open and close valves; the valves never decide anything.',
    };
}

/** A cycle whose motion is the ring breathing, with no step of its own. */
function pulseCycleFixture(): StudyFlow {
    return {
        kind: 'cycle',
        title: 'The cardiac cycle',
        teach: 'The ring breathes once per beat.',
        motion: 'pulse',
        steps: [
            { id: 'p1', label: 'Atrial systole', kind: 'step' },
            { id: 'p2', label: 'Isovolumetric contraction', kind: 'step' },
            { id: 'p3', label: 'Ejection', kind: 'step' },
        ],
    };
}

/** A comparison whose rows carry verdicts, and one row that carries none. */
function markedCompareFixture(): StudyMatrix {
    return {
        kind: 'compare',
        title: 'Crystalloid or colloid?',
        columns: ['Crystalloid', 'Colloid'],
        rows: [
            { label: 'Cost', cells: ['Cheap', 'Dear'], mark: 'better' },
            { label: 'Oedema', cells: ['More', 'Less'], mark: 'worse' },
            { label: 'Availability', cells: ['Everywhere', 'Variable'], mark: 'equal' },
            { label: 'Mortality', cells: ['No difference', 'No difference'] },
        ],
        pearl: 'Resuscitate with crystalloid; colloid buys nothing.',
    };
}

function timelineFixture(): StudyTimeline {
    return {
        kind: 'timeline',
        title: 'Sepsis: the first hour',
        entries: [
            { when: '0 min', label: 'Recognise', detail: 'Two of: fever, tachycardia, tachypnoea, confusion' },
            { when: '15 min', label: 'Lactate and cultures' },
            { when: '30 min', label: 'Broad-spectrum antibiotics', detail: 'Before any imaging that would move them' },
        ],
        pearl: 'The hour is the intervention.',
    };
}

function summaryFixture(): StudySummary {
    return {
        title: 'Summary',
        bullets: [
            { text: 'Demand mismatch explains angina.', emphasis: 'pearl', children: ['Exertion, cold, emotion'] },
            { text: 'PE presents suddenly.' },
            { text: 'Pericarditis eases on leaning forward.' },
            { text: 'Time is muscle.', emphasis: 'pearl' },
            { text: 'Always ask about onset.' },
        ],
        kept: 'Every pearl, and the line that ties them together.',
    };
}

// -------------------------------------------------------------------- mounting

function host(): MiniElement {
    return new MiniElement('div');
}

/**
 * A scheduler that keeps its ticks in hand.
 *
 * The motion is proven without a clock: this records the schedule the board
 * asked for and the test fires a tick by hand. Nothing here waits on wall-clock
 * time, and no interval is left running when the suite ends — which is also why
 * a real timer is never used: a live interval holds Node open after the tests
 * have finished.
 */
class FakeScheduler implements MotionScheduler {
    /** Every interval the board has asked for, in the order it asked. */
    readonly intervals: number[] = [];
    private handlers = new Map<MotionTimer, () => void>();
    private next = 1;

    every(handler: () => void, ms: number): MotionTimer {
        const handle = this.next++;
        this.handlers.set(handle, handler);
        this.intervals.push(ms);
        return handle;
    }

    cancel(handle: MotionTimer): void {
        this.handlers.delete(handle);
    }

    /** How many schedules are live: none means nothing can tick. */
    get scheduled(): number {
        return this.handlers.size;
    }

    /** Fire every live schedule once, as a tick of a real timer would. */
    fire(): void {
        for (const handler of [...this.handlers.values()]) handler();
    }
}

function mountBoard(visuals: StudyVisual[], into: MiniElement = host(), options: StudyVisualBoardOptions = {}) {
    const view = new StudyVisualBoardView();
    const teardown = view.mount(into as unknown as HTMLElement, visuals, options);
    return { view, into, teardown };
}

function mountSummary(summary: StudySummary, into: MiniElement = host()) {
    const view = new StudySummaryView();
    const teardown = view.mount(into as unknown as HTMLElement, summary);
    return { view, into, teardown };
}

// -------------------------------------------------------- driving the controls

/** The elements a control has marked as current. */
const current = (into: MiniElement, cls: string): MiniElement[] =>
    into.byClass(cls).filter(element => element.hasClass('is-current'));

/** The cells the reader cannot see yet. */
const covered = (into: MiniElement): MiniElement[] =>
    into.byClass('sf-vb-cell').filter(cell => cell.hasClass('is-covered'));

/**
 * Press a key at a control, the way the card's own keydown listener does: the
 * board routes the event to the card that holds its target, so this drives the
 * same path the app does, with no document and no focus.
 */
const press = (view: StudyVisualBoardView, target: MiniElement, key: string): boolean =>
    view.handleKey({ key, target } as unknown as KeyboardEvent);

// ----------------------------------------------------- the five forms, as forms

test('a matrix is a table: one header row, a row per thing, a cell per column', () => {
    const matrix = matrixFixture();
    const { into } = mountBoard([matrix]);

    const scroller = into.byClass('sf-vb-table-scroll');
    assert.equal(scroller.length, 1, 'the table is given a box of its own to scroll in');
    const table = scroller[0].byClass('sf-vb-table')[0];
    assert.ok(table, 'a matrix is a table');
    assert.equal(table.tag, 'table');

    // One header row, one <th scope="col"> per column, after the blank corner.
    const head = table.byClass('sf-vb-table-head');
    assert.equal(head.length, 1, 'one header');
    assert.equal(head[0].tag, 'thead');
    assert.equal(head[0].children.length, 1, 'one header row');
    const headers = head[0].byClass('sf-vb-th');
    assert.equal(headers.length, matrix.columns.length + 1);
    assert.equal(headers[0].textContent, '', 'the corner above the row labels carries nothing');
    assert.deepEqual(headers.slice(1).map(header => header.textContent), matrix.columns);
    assert.ok(headers.every(header => header.attrs.scope === 'col'), 'columns are declared as columns');
    assert.ok(headers.every(header => header.tag === 'th'));

    // One body row per thing: a row label, then one cell per column.
    const body = table.byClass('sf-vb-table-body')[0];
    assert.equal(body.tag, 'tbody');
    const rows = body.byClass('sf-vb-row');
    assert.equal(rows.length, matrix.rows.length, 'one body row per thing');
    matrix.rows.forEach((row, index) => {
        const tr = rows[index];
        assert.equal(tr.tag, 'tr');
        const label = tr.byClass('sf-vb-row-label')[0];
        assert.equal(label.tag, 'th', 'the thing being compared is a row header, not a cell');
        assert.equal(label.attrs.scope, 'row');
        assert.equal(label.textContent, row.label);
        const cells = tr.byClass('sf-vb-cell');
        assert.equal(cells.length, matrix.columns.length, 'one cell per column');
        assert.ok(cells.every(cell => cell.tag === 'td'));
        assert.deepEqual(cells.map(cell => cell.textContent), row.cells);
    });

    // The pearl is the line under the table, tagged as a pearl.
    assert.equal(into.textOf('sf-vb-pearl-tag'), 'Pearl');
    assert.equal(into.textOf('sf-vb-pearl-text'), matrix.pearl);
});

test('a compare draws the same table, and says it is a comparison', () => {
    const compare = compareFixture();
    const { into } = mountBoard([compare]);

    const card = into.byClass('sf-vb-visual')[0];
    assert.equal(card.attrs['data-kind'], 'compare');
    assert.equal(into.textOf('sf-vb-title'), compare.title);
    assert.equal(into.byClass('sf-vb-table').length, 1, 'a comparison is a table too');
    assert.equal(into.byClass('sf-vb-row').length, compare.rows.length);
    assert.equal(into.byClass('sf-vb-cell').length, compare.rows.length * compare.columns.length);
});

test('the emphasised row is marked, and it is the only one', () => {
    const matrix = matrixFixture();
    const { into } = mountBoard([matrix]);

    const marked = into.byClass('sf-vb-row').filter(row => row.hasClass('is-emphasis'));
    assert.equal(marked.length, 1, 'one row is the point of the comparison');
    assert.equal(marked[0].byClass('sf-vb-row-label')[0].textContent, 'PE');
    assert.equal(marked[0].attrs['data-emphasis'], 'true');

    // Marked with an edge and a wash — not by recolouring the words.
    const rule = ruleBody(read(CSS_PATH), '.sf-vb-row.is-emphasis .sf-vb-row-label');
    assert.match(rule, /border-left/, 'the row carries an accent edge');
});

test('a flow is numbered steps in order, a decision with its branches, an outcome as an end', () => {
    const flow = flowFixture();
    const { into } = mountBoard([flow]);

    const list = into.byClass('sf-vb-steps')[0];
    assert.equal(list.tag, 'ol', 'a flow is an ordered sequence');
    const steps = list.byClass('sf-vb-step');
    assert.equal(steps.length, flow.steps.length);
    assert.deepEqual(steps.map(step => step.textOf('sf-vb-step-label')), flow.steps.map(step => step.label), 'in order');
    assert.deepEqual(steps.map(step => step.textOf('sf-vb-step-num')), ['1', '2', '3'], 'and numbered');

    const decision = steps[1];
    assert.equal(decision.attrs['data-kind'], 'decision');
    assert.ok(decision.hasClass('is-decision'));
    assert.equal(decision.textOf('sf-vb-step-kind'), 'Decision');
    assert.equal(decision.textOf('sf-vb-step-detail'), 'Ask when the last known well was');
    assert.deepEqual(decision.byClass('sf-vb-branch-label').map(branch => branch.textContent), ['yes', 'no']);

    const outcome = steps[2];
    assert.equal(outcome.attrs['data-kind'], 'outcome');
    assert.ok(outcome.hasClass('is-outcome'), 'an outcome is marked as an end');
    assert.equal(outcome.textOf('sf-vb-step-end'), 'End');
    assert.equal(outcome.byClass('sf-vb-branches').length, 0, 'and ends without branching');

    assert.equal(steps[0].attrs['data-kind'], 'step');
    assert.equal(steps[0].byClass('sf-vb-step-kind').length, 0, 'a plain step claims nothing');
    assert.equal(into.textOf('sf-vb-pearl-text'), flow.pearl);
});

test('a branch names the step it goes to, and falls back to the id it was given', () => {
    const flow = flowFixture();
    const { into } = mountBoard([flow]);
    const targets = into.byClass('sf-vb-branch-to').map(branch => branch.textContent);
    // 'scan' is a step in this flow, so the branch says where it goes in that
    // step's own words; 'reassess' is not, so it is left as the model wrote it.
    assert.deepEqual(targets, ['Straight to imaging', 'reassess']);
    assert.equal(branchTargetLabel(flow.steps, 'scan'), 'Straight to imaging');
    assert.equal(branchTargetLabel(flow.steps, 'nowhere'), 'nowhere');
});

test('a cycle is a ring: every step on it in order, a direction cue, branches said below', () => {
    const cycle = cycleFixture();
    const { into } = mountBoard([cycle]);

    const ring = into.byClass('sf-vb-ring')[0];
    assert.ok(ring, 'a cycle is drawn as a ring');
    const nodes = ring.byClass('sf-vb-ring-step');
    assert.equal(nodes.length, cycle.steps.length, 'every step sits on the ring');
    assert.deepEqual(nodes.map(node => node.textOf('sf-vb-ring-label')), cycle.steps.map(step => step.label));
    assert.deepEqual(nodes.map(node => node.textOf('sf-vb-ring-num')), ['1', '2', '3', '4']);
    assert.equal(ring.byClass('sf-vb-ring-arrow').length, 1, 'and the ring says which way it runs');

    // Placed around the ring by the ring's own arithmetic: one angle per step,
    // the first at the top, the rest evenly spaced clockwise.
    const angles = nodes.map(node => node.style['--sf-vb-angle']);
    assert.deepEqual(angles, cycle.steps.map((_step, index) => `${ringAngle(index, cycle.steps.length)}deg`));
    assert.equal(new Set(angles).size, cycle.steps.length, 'no two steps are drawn on top of each other');
    assert.equal(angles[0], '-90deg', 'the first step sits at the top');
    assert.equal(ringAngle(0, 4), -90);
    assert.equal(ringAngle(1, 4), 0);
    assert.equal(ringAngle(2, 4), 90);

    // The ring is the drawing; it is not a second numbered list.
    assert.equal(ring.byClass('sf-vb-step').length, 0);
    assert.equal(ring.byClass('sf-vb-tl-entry').length, 0);

    // What a label on a ring cannot carry — branches and details — is said
    // underneath in words, step by step.
    const notes = into.byClass('sf-vb-cycle-note');
    assert.equal(notes.length, 2, 'the decision and the step with a detail');
    assert.equal(notes[0].textOf('sf-vb-cycle-note-from'), '2 · Mitral closes?');
    assert.deepEqual(notes[0].byClass('sf-vb-branch-label').map(branch => branch.textContent), ['present', 'absent']);
    assert.equal(notes[1].textOf('sf-vb-step-detail'), 'Both valves shut, pressure climbs');
    assert.equal(into.textOf('sf-vb-pearl-text'), cycle.pearl);
});

test('a cycle keeps its step notes behind one folded disclosure', () => {
    const cycle = cycleFixture();
    const { into } = mountBoard([cycle]);
    const details = into.byClass('sf-vb-cycle-details')[0];
    assert.equal(details.tag, 'details');
    assert.equal(details.attrs.open, undefined, 'the reference notes start folded');
    assert.equal(details.textOf('sf-vb-cycle-summary-label'), 'Step details');
    assert.equal(into.byClass('sf-vb-cycle-note').length, 2);
    assert.equal(into.byClass('sf-vb-stepper').length, 1, 'the stepper remains the live control');
});

test('a timeline runs down a rule: one marker per entry, the time as the marker', () => {
    const timeline = timelineFixture();
    const { into } = mountBoard([timeline]);

    const list = into.byClass('sf-vb-timeline')[0];
    assert.equal(list.tag, 'ol', 'a sequence is ordered');
    const entries = list.byClass('sf-vb-tl-entry');
    assert.equal(entries.length, timeline.entries.length, 'one row per entry');
    const markers = list.byClass('sf-vb-tl-marker');
    assert.equal(markers.length, timeline.entries.length, 'one marker per entry');
    assert.deepEqual(markers.map(marker => marker.textOf('sf-vb-tl-when')), timeline.entries.map(entry => entry.when));
    assert.deepEqual(entries.map(entry => entry.textOf('sf-vb-tl-label')), timeline.entries.map(entry => entry.label));
    assert.deepEqual(
        entries.map(entry => entry.textOf('sf-vb-tl-detail')),
        timeline.entries.map(entry => entry.detail ?? ''),
        'the detail is beside its entry, and only where there is one'
    );
    assert.equal(into.textOf('sf-vb-pearl-text'), timeline.pearl);

    // The rule is drawn, and the markers hang from it.
    assert.match(read(CSS_PATH), /\.sf-vb-timeline::before\s*\{/, 'the vertical rule is the list itself');
    assert.match(read(CSS_PATH), /\.sf-vb-tl-marker::before\s*\{/, 'and each marker draws its own dot');
});

test('a board of every form keeps them in order, each named for what it is', () => {
    const visuals: StudyVisual[] = [matrixFixture(), compareFixture(), flowFixture(), cycleFixture(), timelineFixture()];
    const { into } = mountBoard(visuals);

    const cards = into.byClass('sf-vb-visual');
    assert.deepEqual(cards.map(card => card.attrs['data-kind']), ['matrix', 'compare', 'flow', 'cycle', 'timeline']);
    assert.deepEqual(cards.map(card => card.textOf('sf-vb-title')), visuals.map(visual => visual.title));
    // Each form still ends with its pearl.
    assert.equal(into.byClass('sf-vb-pearl').length, visuals.length);
});

// -------------------------------------------- the reveal (matrix / compare)

test('a compare starts covered: the cells hide behind a tap and the count says how much shows', () => {
    const compare = compareFixture();
    const { into } = mountBoard([compare]);

    const cells = into.byClass('sf-vb-cell');
    const total = compare.rows.length * compare.columns.length;
    assert.equal(cells.length, total);
    assert.equal(covered(into).length, total, 'every cell is covered to begin with');

    // Covered, not gone: the answer is still the cell's own text, so revealing
    // is a state and not a re-render.
    assert.deepEqual(
        cells.map(cell => cell.textContent),
        compare.rows.flatMap(row => row.cells),
        'the answers are hidden from the eye, not from the table'
    );

    const toggle = into.byClass('sf-vb-reveal-toggle')[0];
    assert.equal(toggle.tag, 'button', 'the toggle is a real button');
    assert.equal(toggle.attrs.type, 'button');
    assert.equal(toggle.textContent, 'Reveal all');
    assert.equal(into.textOf('sf-vb-reveal-count'), `0 of ${total} shown`);

    // A cell reveals itself, one cell at a time.
    into.byClass('sf-vb-reveal')[0].click();
    assert.equal(covered(into).length, total - 1, 'the cell the reader tapped is showing');
    assert.equal(cells[0].hasClass('is-covered'), false);
    assert.equal(into.textOf('sf-vb-reveal-count'), `1 of ${total} shown`, 'and the count followed');

    // The toggle reveals the rest...
    toggle.click();
    assert.equal(covered(into).length, 0, 'one press reveals every cell');
    assert.equal(toggle.textContent, 'Hide all', 'the toggle says what it will do next');
    assert.equal(toggle.attrs['aria-pressed'], 'true');
    assert.equal(into.textOf('sf-vb-reveal-count'), `${total} of ${total} shown`);

    // ...and covers them all again.
    toggle.click();
    assert.equal(covered(into).length, total, 'and the next hides every cell');
    assert.equal(toggle.textContent, 'Reveal all');
    assert.equal(toggle.attrs['aria-pressed'], 'false');
    assert.equal(into.textOf('sf-vb-reveal-count'), `0 of ${total} shown`);
});

test('a matrix is a reference: it starts readable, and its table is unchanged by the toggle', () => {
    const matrix = matrixFixture();
    const { into } = mountBoard([matrix]);

    const table = into.byClass('sf-vb-table')[0];
    const cells = into.byClass('sf-vb-cell');
    const rows = into.byClass('sf-vb-row');
    const headers = into.byClass('sf-vb-th');
    const toggle = into.byClass('sf-vb-reveal-toggle')[0];

    assert.equal(covered(into).length, 0, 'a matrix needs no guessing: it is readable as it arrives');
    assert.equal(toggle.textContent, 'Hide all', 'the toggle is offered all the same');
    assert.equal(into.textOf('sf-vb-reveal-count'), `${cells.length} of ${cells.length} shown`);

    toggle.click();
    assert.equal(covered(into).length, cells.length, 'it can cover the lot');
    toggle.click();
    assert.equal(covered(into).length, 0, 'and put it all back');

    // Same table, same cells, same count — the toggle changed a class, nothing else.
    assert.equal(into.byClass('sf-vb-table').length, 1);
    assert.equal(into.byClass('sf-vb-table')[0], table, 'the same table');
    assert.equal(into.byClass('sf-vb-cell').length, cells.length, 'the same <td> count');
    assert.ok(into.byClass('sf-vb-cell').every((cell, index) => cell === cells[index]), 'the same <td>s, in order');
    assert.ok(into.byClass('sf-vb-cell').every(cell => cell.tag === 'td'));
    assert.equal(into.byClass('sf-vb-row').length, rows.length, 'and the same rows');
    assert.equal(into.byClass('sf-vb-th').length, headers.length, 'the header row is untouched');
    assert.equal(table.byClass('sf-vb-table-head')[0].children.length, 1, 'still one header row');
    assert.equal(table.byClass('sf-vb-table-body').length, 1, 'and one body');
    assert.deepEqual(cells.map(cell => cell.textContent), matrix.rows.flatMap(row => row.cells), 'every answer is still in its own cell');
});

test('a revealed cell stays revealed after the toggle is used twice', () => {
    // Two uses of the toggle are a round trip: for a matrix — readable as it
    // arrives — they end where they started, with every cell revealed again,
    // and the cells that come back are the ones that went away.
    const matrix = matrixFixture();
    const { into } = mountBoard([matrix]);

    const cells = into.byClass('sf-vb-cell');
    const toggle = into.byClass('sf-vb-reveal-toggle')[0];

    toggle.click();
    assert.equal(covered(into).length, cells.length, 'the first press covers every cell');
    toggle.click();
    assert.equal(covered(into).length, 0, 'and the second reveals them all again');
    assert.ok(into.byClass('sf-vb-cell').every((cell, index) => cell === cells[index]), 'the cells themselves, revealed');
    assert.equal(into.textOf('sf-vb-reveal-count'), `${cells.length} of ${cells.length} shown`);
});

test('a cell the reader revealed themselves survives a toggle round trip', () => {
    // On a comparison the toggle starts out revealing: one press shows the lot,
    // the next covers it again — and the reader's own cell comes back with the
    // rest, because hiding a cell is a class and never a rewrite of the table.
    const compare = compareFixture();
    const { into } = mountBoard([compare]);

    const cells = into.byClass('sf-vb-cell');
    const toggle = into.byClass('sf-vb-reveal-toggle')[0];
    const own = cells[3];

    own.byClass('sf-vb-reveal')[0].click();
    assert.equal(own.hasClass('is-covered'), false, 'the reader checked that one themselves');

    toggle.click();
    assert.equal(covered(into).length, 0, 'reveal all shows the rest');
    toggle.click();
    assert.equal(covered(into).length, cells.length, 'hide all covers them again, the reader’s cell included');
    toggle.click();
    assert.equal(covered(into).length, 0, 'and the next press brings the reader’s own cell back with the rest');
    assert.equal(own.hasClass('is-covered'), false);
    assert.equal(into.byClass('sf-vb-cell')[3], own, 'the same cell it always was');
});

test('a covered cell does not hand its answer over in a tooltip', () => {
    const answer = 'A'.repeat(120);
    const compare: StudyMatrix = {
        kind: 'compare',
        title: 'Long answers',
        columns: ['Left', 'Right'],
        rows: [{ label: 'Row', cells: [answer, 'short'] }],
    };
    const { into } = mountBoard([compare]);

    const cell = into.byClass('sf-vb-cell')[0];
    const toggle = into.byClass('sf-vb-reveal-toggle')[0];
    assert.equal(cell.hasClass('is-covered'), true, 'the long answer starts covered');
    assert.equal(cell.getAttribute('title'), null, 'and a cell hiding its answer does not show it on hover');

    toggle.click();
    assert.equal(cell.getAttribute('title'), answer, 'revealed, a cell too long to draw whole can still be read in full');

    toggle.click();
    assert.equal(cell.getAttribute('title'), null, 'and covering it again takes the tooltip with it');
});

test('a comparison with verdicts is a game: the reader calls each row and is answered on the spot', () => {
    const compare = markedCompareFixture();
    const { into } = mountBoard([compare]);

    // The table is the table it always was: every row, every cell, readable.
    const rows = into.byClass('sf-vb-row');
    assert.equal(rows.length, compare.rows.length);
    assert.equal(into.byClass('sf-vb-cell').length, compare.rows.length * compare.columns.length, 'the evidence is the evidence');
    assert.equal(into.byClass('sf-vb-table-head')[0].children.length, 1, 'one header row');

    // Every marked row asks the question, with one button per verdict.
    const guessRows = into.byClass('sf-vb-guess');
    assert.equal(guessRows.length, 3, 'one guess group per marked row, none on the unmarked one');
    assert.deepEqual(
        guessRows.map(group => group.byClass('sf-vb-guess-btn').map(button => button.textContent)),
        [
            ['Better', 'Worse', 'Equal'],
            ['Better', 'Worse', 'Equal'],
            ['Better', 'Worse', 'Equal'],
        ],
        'every group offers the same three calls'
    );
    assert.deepEqual(
        guessRows.map(group => group.attrs['aria-label']),
        ['Verdict for Cost', 'Verdict for Oedema', 'Verdict for Availability'],
        'and each says which row it judges'
    );

    // Nothing is given away: no verdict chip, no verdict state, on any row yet.
    assert.equal(into.byClass('sf-vb-mark').length, 0, 'the chips arrive only when the call is right');
    assert.deepEqual(rows.map(row => row.attrs['data-mark'] ?? ''), ['', '', '', '']);
    assert.equal(into.textOf('sf-vb-guess-score'), '0 of 3 verdicts matched', 'and the score starts at nothing');

    // A wrong call is refused where it was made, and changes nothing else.
    const cost = rows[0];
    const costButtons = guessRows[0].byClass('sf-vb-guess-btn');
    costButtons[1].click();
    assert.equal(cost.hasClass('is-guess-wrong'), true, 'the row refuses the call in place');
    assert.equal(cost.hasClass('is-mark-worse'), false, 'and no wrong verdict is drawn');
    assert.equal(into.byClass('sf-vb-mark').length, 0);
    assert.equal(into.textOf('sf-vb-guess-score'), '0 of 3 verdicts matched', 'a wrong call moves no count');

    // The right call locks the row, draws its verdict, and moves the count.
    costButtons[0].click();
    assert.equal(cost.hasClass('is-guess-wrong'), false, 'the refusal is gone');
    assert.equal(cost.hasClass('is-guess-right'), true);
    assert.equal(cost.hasClass('is-mark-better'), true, 'the verdict is drawn as the row’s own state');
    assert.equal(cost.attrs['data-mark'], 'better');
    assert.ok(costButtons.every(button => button.disabled), 'and the row is settled: its buttons are done');
    assert.equal(into.textOf('sf-vb-guess-score'), '1 of 3 verdicts matched');
    const chips = into.byClass('sf-vb-mark');
    assert.equal(chips.length, 1, 'the chip is drawn at the head of the row it judges');
    assert.equal(chips[0].attrs.title, 'Better');
    assert.equal(chips[0].parent, cost.byClass('sf-vb-row-label')[0], 'the chip belongs to the row label');
    assert.equal(cost.byClass('sf-vb-row-label')[0].children[0], chips[0], 'and leads it');

    // Settled rows cannot be re-called.
    costButtons[2].click();
    assert.equal(cost.hasClass('is-mark-equal'), false, 'a settled row takes no second verdict');

    // The last call solves the table, and the card says so as a state.
    rows[1].byClass('sf-vb-guess-btn')[1].click();
    assert.equal(rows[1].hasClass('is-mark-worse'), true, 'the second verdict was the wrong-sounding one, and it is right');
    rows[2].byClass('sf-vb-guess-btn')[2].click();
    assert.equal(rows[2].hasClass('is-mark-equal'), true);
    assert.equal(into.textOf('sf-vb-guess-score'), VERDICT_ALL_TEXT);
    assert.equal(into.byClass('sf-vb-visual')[0].hasClass('is-solved'), true);
    assert.equal(into.byClass('sf-vb-guess-score')[0].hasClass('is-solved'), true, 'the score says it too');

    // The tones are the stylesheet's, drawn from the row's own class — the same
    // contract the marks always had.
    const css = read(CSS_PATH);
    assert.match(ruleBody(css, '.sf-vb-row.is-mark-better .sf-vb-mark'), /--sf-success/);
    assert.match(ruleBody(css, '.sf-vb-row.is-mark-worse .sf-vb-mark'), /--sf-warning/);
    assert.match(ruleBody(css, '.sf-vb-row.is-mark-equal .sf-vb-mark'), /--sf-text-muted/);
    assert.match(ruleBody(css, '.sf-vb-row.is-mark-better .sf-vb-row-label'), /box-shadow/, 'the bar is the row’s as well as the chip’s');
    assert.match(ruleBody(css, '.sf-vb-row.is-guess-wrong'), /--sf-warning/, 'and the refusal is drawn in the warning tone');
});

test('a cell too long to read at a glance is cut with an ellipsis, and the table keeps its shape', () => {
    const long = `${'a finding worth writing down in full '.repeat(6)}and the end`.trim();
    const compare: StudyMatrix = {
        kind: 'compare',
        title: 'One long verdict',
        columns: ['Left', 'Right'],
        rows: [
            { label: 'First', cells: [long, 'short'] },
            { label: 'Second', cells: ['also short', 'short too'] },
        ],
    };
    const { into } = mountBoard([compare]);

    assert.ok(long.length > CELL_DRAW_LENGTH, `the fixture must genuinely exceed the cap: ${long.length} of ${CELL_DRAW_LENGTH}`);
    assert.equal(cellText('fits in a few words'), 'fits in a few words', 'a cell that fits is untouched');
    assert.equal(cellText('A'.repeat(400)), `${'A'.repeat(CELL_DRAW_LENGTH)}…`, 'an unbroken token is cut where it stands');
    assert.ok(cellText(long).length <= CELL_DRAW_LENGTH + 1, 'and nothing drawn exceeds the cap by more than the ellipsis');

    const cells = into.byClass('sf-vb-cell');
    assert.equal(cells.length, compare.rows.length * compare.columns.length, 'a cut cell is still one <td>');
    assert.equal(cells[0].textContent, cellText(long), 'the drawn cell is the capped one, and the cut is visible');
    assert.ok(cells[0].textContent.endsWith('…'));
    assert.equal(cells[1].textContent, 'short', 'a short cell is left exactly as it was');
    assert.equal(cells[1].attrs.title, undefined, 'and needs no tooltip');

    // The structure is untouched: the same table, the same cells, in the same order.
    assert.equal(into.byClass('sf-vb-table').length, 1);
    assert.deepEqual(cells.map(cell => cell.tag), ['td', 'td', 'td', 'td']);
    assert.deepEqual(
        cells.map(cell => cell.textContent),
        [cellText(long), 'short', 'also short', 'short too'],
        'every cell is drawn in its own place'
    );

    // A covered cell still hands nothing over — the tooltip is part of the
    // reveal, and the whole text is what it hands over.
    assert.equal(cells[0].hasClass('is-covered'), true, 'a comparison arrives covered');
    assert.equal(cells[0].attrs.title, undefined, 'so no tooltip gives the answer away');
    into.byClass('sf-vb-reveal-toggle')[0].click();
    assert.equal(cells[0].attrs.title, long, 'revealed, a cut cell keeps the whole of itself a tooltip away');
    assert.equal(cells[0].hasClass('is-covered'), false);
});

test('the reveal control is operable from the keyboard', () => {
    const compare = compareFixture();
    const { into, view } = mountBoard([compare]);

    // Every cell's reveal, and the toggle, are real buttons: focusable, and
    // activated by Enter and Space without a line of our own.
    const buttons = [into.byClass('sf-vb-reveal-toggle')[0], ...into.byClass('sf-vb-reveal')];
    assert.ok(
        buttons.every(button => button.tag === 'button' && button.attrs.type === 'button'),
        'the reveal is buttons all the way down'
    );

    // Enter on a covered cell is answered by the control, once: the key's own
    // default is that button's click, and the control takes it over.
    const cell = into.byClass('sf-vb-cell')[1];
    assert.equal(press(view, cell.byClass('sf-vb-reveal')[0], 'Enter'), true, 'the board says it used the key');
    assert.equal(cell.hasClass('is-covered'), false, 'and the cell is revealed');

    assert.equal(press(view, into.byClass('sf-vb-cell')[2], ' '), true, 'Space, aimed at the cell itself, does the same');
    assert.equal(into.byClass('sf-vb-cell')[2].hasClass('is-covered'), false);

    assert.equal(press(view, into.byClass('sf-vb-reveal-toggle')[0], 'Enter'), false, 'the toggle answers Enter itself, through its own click');
    assert.equal(press(view, into.byClass('sf-vb-reveal-count')[0], 'Enter'), false, 'and a key anywhere else in the card is nobody’s');
});

// ------------------------------------------------------------- the stepper

test('the stepper starts at step 1, walks both ways and holds at the ends', () => {
    const flow = flowFixture();
    const { into } = mountBoard([flow]);

    const steps = into.byClass('sf-vb-step');
    const next = into.byClass('sf-vb-step-next')[0];
    const previous = into.byClass('sf-vb-step-prev')[0];
    const report = (): string => into.textOf('sf-vb-step-report');
    const now = (): MiniElement => into.byClass('sf-vb-step-now')[0];

    assert.equal(report(), `Step 1 of ${flow.steps.length}`, 'it opens on the first step');
    assert.equal(current(into, 'sf-vb-step').length, 1, 'exactly one step is current');
    assert.equal(current(into, 'sf-vb-step')[0], steps[0]);
    assert.ok(into.byClass('sf-vb-steps')[0].hasClass('is-stepped'), 'and the list says it is being stepped');
    assert.equal(now().textOf('sf-vb-step-label'), flow.steps[0].label, 'the current step’s own words are read out');
    assert.equal(now().byClass('sf-vb-step-detail')[0].hasClass('is-empty'), true, 'a step with no detail adds no empty line');

    next.click();
    assert.equal(report(), 'Step 2 of 3', 'next advances');
    assert.equal(current(into, 'sf-vb-step')[0], steps[1], 'the current step moved');
    assert.equal(current(into, 'sf-vb-step').length, 1, 'and did not spread');
    assert.equal(now().textOf('sf-vb-step-detail'), 'Ask when the last known well was', 'the step’s detail comes with it');
    assert.equal(now().byClass('sf-vb-step-detail')[0].hasClass('is-empty'), false);
    assert.equal(previous.disabled, false, 'and there is somewhere to go back to');

    previous.click();
    assert.equal(report(), 'Step 1 of 3', 'previous goes back');
    assert.equal(current(into, 'sf-vb-step')[0], steps[0]);

    previous.click();
    assert.equal(report(), 'Step 1 of 3', 'the first step is where going back stops');
    assert.equal(previous.disabled, true, 'and the control says so');

    next.click();
    next.click();
    assert.equal(report(), 'Step 3 of 3');
    assert.equal(next.disabled, true, 'the last step is where going forward stops');
    next.click();
    assert.equal(report(), 'Step 3 of 3', 'a press at the end changes nothing');
});

test('the stepper answers the arrow keys while its card has focus', () => {
    const flow = flowFixture();
    const { into, view } = mountBoard([flow]);

    const card = into.byClass('sf-vb-visual')[0];
    const bar = into.byClass('sf-vb-stepper')[0];
    assert.equal(card.listenerCount('keydown'), 1, 'one listener, on the card it belongs to');

    assert.equal(press(view, into.byClass('sf-vb-step-next')[0], 'ArrowRight'), true, 'the focus can be on the control itself');
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 2 of 3');
    assert.equal(press(view, bar, 'ArrowRight'), true, 'or on the bar around it');
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 3 of 3');
    assert.equal(press(view, into.byClass('sf-vb-step')[0], 'ArrowLeft'), true, 'or anywhere inside the card');
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 2 of 3');
    assert.equal(press(view, bar, 'ArrowLeft'), true);
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 1 of 3');
    assert.equal(press(view, bar, 'ArrowLeft'), true, 'an arrow at the end is still the stepper’s key');
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 1 of 3', 'and it holds there');
    assert.equal(press(view, bar, 'y'), false, 'a key it does not own is left to the app');
    assert.equal(press(view, bar, 'Enter'), false, 'and Enter belongs to whatever button the reader is on');
});

test('a cycle’s stepper walks the ring, and the ring shows which step is current', () => {
    const cycle = cycleFixture();
    const { into } = mountBoard([cycle]);

    const ring = into.byClass('sf-vb-ring')[0];
    const nodes = ring.byClass('sf-vb-ring-step');
    const angles = nodes.map(node => node.style['--sf-vb-angle']);
    const branches = into.byClass('sf-vb-branch').length;

    assert.equal(current(into, 'sf-vb-ring-step').length, 1, 'one node of the ring is current');
    assert.equal(current(into, 'sf-vb-ring-step')[0], nodes[0]);
    assert.equal(into.textOf('sf-vb-step-report'), `Step 1 of ${cycle.steps.length}`);

    into.byClass('sf-vb-step-next')[0].click();
    assert.equal(current(into, 'sf-vb-ring-step').length, 1, 'and only one, whatever moves');
    assert.equal(current(into, 'sf-vb-ring-step')[0], nodes[1], 'the ring moved with the stepper');
    assert.equal(into.byClass('sf-vb-step-now')[0].textOf('sf-vb-step-label'), cycle.steps[1].label);
    assert.deepEqual(nodes.map(node => node.style['--sf-vb-angle']), angles, 'the ring’s geometry did not move');
    assert.equal(into.byClass('sf-vb-branch').length, branches, 'a decision keeps its branches wherever the reader is on it');
    assert.equal(into.byClass('sf-vb-cycle-note').length, 2, 'and the notes under the ring are untouched');

    into.byClass('sf-vb-step-prev')[0].click();
    assert.equal(current(into, 'sf-vb-ring-step')[0], nodes[0], 'and the ring walks back with it');
});

// ---------------------------------------------------------------- the motion

test('a flow’s decisions are taken, not just read: a branch button walks the process', () => {
    const flow = movingFlowFixture();
    const scheduler = new FakeScheduler();
    const { into, teardown } = mountBoard([flow], host(), { scheduler });

    const steps = into.byClass('sf-vb-step');
    const choices = into.byClass('sf-vb-choices')[0];
    const toggle = into.byClass('sf-vb-motion-toggle')[0];

    // Step 1 is a plain step: no branch to take, so the bar offers none.
    assert.equal(choices.byClass('sf-vb-choice').length, 0, 'a step with no branches offers no choices');

    // Walk onto the decision: its branches become buttons in the same bar.
    into.byClass('sf-vb-step-next')[0].click();
    assert.equal(toggle.hasClass('is-playing'), false, 'taking the wheel by hand stopped the motion');
    assert.equal(scheduler.scheduled, 0, 'nothing is left scheduled behind the reader');
    const buttons = choices.byClass('sf-vb-choice');
    assert.deepEqual(
        buttons.map(button => button.textContent),
        ['yes'],
        'only the branches that lead to a step in this flow are offered — `reassess` is not one of them'
    );

    // Take the branch: the process moves to the step the branch names.
    buttons[0].click();
    assert.equal(current(into, 'sf-vb-step')[0], steps[2], 'the branch moved the process where it points');
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 3 of 3');
    assert.equal(steps[0].hasClass('is-walked'), true, 'the steps the path came through stay marked');
    assert.equal(steps[1].hasClass('is-walked'), true);
    assert.equal(steps[2].hasClass('is-walked'), false, 'the step the reader is on is current, not walked');
    assert.equal(current(into, 'sf-vb-step').length, 1, 'still exactly one current step');
    assert.equal(choices.byClass('sf-vb-choice').length, 0, 'an outcome branches nowhere, so it offers nothing');

    teardown();
});

test('a flow with motion walks itself, and the board’s advance comes round at the end', () => {
    const flow = movingFlowFixture();
    const { into, view, teardown } = mountBoard([flow], host(), { scheduler: new FakeScheduler() });

    assert.equal(into.textOf('sf-vb-teach'), flow.teach, 'the teach line says what to watch for');
    const steps = into.byClass('sf-vb-step');
    const at = (): MiniElement[] => current(into, 'sf-vb-step');
    assert.equal(at().length, 1, 'one step is current to begin with');
    assert.equal(at()[0], steps[0], 'and it is the first');

    // The card reads top to bottom: what it is, what to watch for, the control
    // that runs it, and then the process itself.
    const card = into.byClass('sf-vb-visual')[0];
    const order = (cls: string): number => card.children.findIndex(child => child.hasClass(cls));
    assert.ok(order('sf-vb-teach') > order('sf-vb-title'), 'the teach line sits under the title');
    assert.ok(order('sf-vb-stepper') > order('sf-vb-teach'), 'and above the control it explains');
    assert.ok(order('sf-vb-steps') > order('sf-vb-stepper'), 'which sits above the process');

    assert.equal(view.advance(), true, 'the board says there was a process to move');
    assert.equal(at()[0], steps[1], 'the highlight moved on');
    assert.equal(at().length, 1, 'and did not spread');
    assert.equal(into.textOf('sf-vb-step-report'), `Step 2 of ${flow.steps.length}`);

    assert.equal(view.advance(), true);
    assert.equal(at()[0], steps[2], 'and on to the last');

    assert.equal(view.advance(), true, 'past the last step the process comes round');
    assert.equal(at()[0], steps[0], 'the walk wraps to the first step');
    assert.equal(into.textOf('sf-vb-step-report'), `Step 1 of ${flow.steps.length}`);
    teardown();
});

test('a process with no motion carries no motion control, and the board has nothing to move', () => {
    const scheduler = new FakeScheduler();
    const silent: StudyFlow = { ...movingFlowFixture(), motion: 'none' };
    const { into, view, teardown } = mountBoard([silent], host(), { scheduler });

    assert.equal(into.byClass('sf-vb-motion-toggle').length, 0, 'no Play button where there is nothing to play');
    assert.equal(scheduler.scheduled, 0, 'and nothing scheduled');
    assert.equal(view.advance(), false, 'the board says there is no process to move');

    // The stepper is exactly what it was: the reader walks it, ends and all.
    into.byClass('sf-vb-step-next')[0].click();
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 2 of 3');
    assert.equal(current(into, 'sf-vb-step')[0], into.byClass('sf-vb-step')[1]);
    teardown();

    // The same when the material never asked for motion at all.
    const unmoved = mountBoard([flowFixture()], host(), { scheduler });
    assert.equal(unmoved.into.byClass('sf-vb-motion-toggle').length, 0, 'an absent motion is no control either');
    assert.equal(unmoved.view.advance(), false);
    unmoved.teardown();
});

test('the motion ticks on a repeating interval, and Play/Pause says which state it is in', () => {
    const flow = movingFlowFixture();
    const scheduler = new FakeScheduler();
    const { into, teardown } = mountBoard([flow], host(), { scheduler });
    const toggle = into.byClass('sf-vb-motion-toggle')[0];

    assert.equal(toggle.tag, 'button', 'the motion is offered as a real control');
    assert.equal(toggle.attrs.type, 'button');
    assert.equal(toggle.textContent, 'Pause', 'a card with motion opens moving, and says so');
    assert.equal(toggle.attrs['aria-pressed'], 'true');
    assert.ok(toggle.hasClass('is-playing'), 'and shows its state as well as saying it');
    assert.equal(scheduler.scheduled, 1, 'its ticks are scheduled');
    assert.equal(scheduler.intervals[0], MOTION_INTERVAL_MS, 'one step per interval');
    const bar = into.byClass('sf-vb-stepper')[0];
    assert.equal(bar.children[0], toggle, 'and the control that runs the process leads the bar');

    scheduler.fire();
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 2 of 3', 'a tick moves the process on');

    toggle.click();
    assert.equal(toggle.textContent, 'Play', 'the control says what it will do next');
    assert.equal(toggle.attrs['aria-pressed'], 'false');
    assert.equal(toggle.hasClass('is-playing'), false);
    assert.equal(scheduler.scheduled, 0, 'and the schedule is let go of, not merely ignored');

    const settled = into.textOf('sf-vb-step-report');
    scheduler.fire();
    assert.equal(into.textOf('sf-vb-step-report'), settled, 'nothing moves while it is paused');

    toggle.click();
    assert.equal(toggle.textContent, 'Pause', 'Play starts it again');
    assert.equal(scheduler.scheduled, 1);
    assert.equal(scheduler.intervals.length, 2, 'one schedule per play, never two');
    scheduler.fire();
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 3 of 3', 'and it carries on from where it stopped');

    teardown();
    assert.equal(scheduler.scheduled, 0, 'and the board takes its motion with it');
});

test('a reader who takes the wheel keeps it: stepping by hand stops the motion', () => {
    const flow = movingFlowFixture();
    const scheduler = new FakeScheduler();
    const { into, view, teardown } = mountBoard([flow], host(), { scheduler });
    const toggle = into.byClass('sf-vb-motion-toggle')[0];
    assert.ok(toggle.hasClass('is-playing'), 'the process is moving to begin with');

    into.byClass('sf-vb-step-next')[0].click();
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 2 of 3', 'the step the reader asked for happened');
    assert.equal(toggle.hasClass('is-playing'), false, 'and the motion let go of the wheel');
    assert.equal(toggle.textContent, 'Play', 'the control says so');
    assert.equal(scheduler.scheduled, 0, 'nothing is left scheduled behind the reader');

    // The arrow keys are the reader too.
    toggle.click();
    assert.equal(press(view, into.byClass('sf-vb-stepper')[0], 'ArrowRight'), true);
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 3 of 3');
    assert.equal(toggle.hasClass('is-playing'), false, 'a key stops it as surely as a button does');
    assert.equal(scheduler.scheduled, 0);
    teardown();
});

test('a reader who asks for reduced motion is never animated, and can still step', () => {
    const flow = movingFlowFixture();
    const scheduler = new FakeScheduler();
    const { into, teardown } = mountBoard([flow], host(), { scheduler, reducedMotion: () => true });
    const toggle = into.byClass('sf-vb-motion-toggle')[0];

    assert.equal(toggle.textContent, 'Play', 'the control is honest: nothing is moving');
    assert.equal(toggle.hasClass('is-playing'), false);
    assert.equal(toggle.attrs['aria-pressed'], 'false');
    assert.equal(toggle.disabled, true, 'and the motion is not offered');
    assert.equal(toggle.attrs.title, 'Your system asks for reduced motion: step it yourself', 'the control says why');
    assert.equal(scheduler.scheduled, 0, 'no tick was ever scheduled');
    assert.equal(scheduler.intervals.length, 0);

    toggle.click();
    assert.equal(scheduler.scheduled, 0, 'and a press of it starts nothing');
    assert.equal(toggle.hasClass('is-playing'), false);

    // The stepper still works: that is the whole of what was promised.
    into.byClass('sf-vb-step-next')[0].click();
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 2 of 3', 'the reader still walks it themselves');
    assert.equal(current(into, 'sf-vb-step')[0], into.byClass('sf-vb-step')[1]);
    assert.equal(scheduler.scheduled, 0, 'and stepping it by hand starts no motion either');
    teardown();
});

test('the reduced-motion guard answers even where there is no matchMedia to ask', () => {
    // The harness has no matchMedia at all: the guard must answer "no
    // preference" rather than throw while a card is being drawn — and the board
    // must be reading it, because a card with motion opens moving.
    assert.equal(typeof (globalThis as { matchMedia?: unknown }).matchMedia, 'undefined', 'the harness has nothing to ask');
    assert.equal(prefersReducedMotion(), false, 'having nothing to ask is not a preference');

    const scheduler = new FakeScheduler();
    const { into, teardown } = mountBoard([movingFlowFixture()], host(), { scheduler });
    assert.ok(into.byClass('sf-vb-motion-toggle')[0].hasClass('is-playing'), 'so the motion starts');
    teardown();
});

test('a cycle with motion keeps exactly one node current as the highlight travels the ring', () => {
    const cycle = movingCycleFixture();
    const scheduler = new FakeScheduler();
    const { into, teardown } = mountBoard([cycle], host(), { scheduler });

    const ring = into.byClass('sf-vb-ring')[0];
    const nodes = ring.byClass('sf-vb-ring-step');
    const angles = nodes.map(node => node.style['--sf-vb-angle']);
    const at = (): MiniElement[] => current(into, 'sf-vb-ring-step');

    assert.equal(at().length, 1, 'one node is current to begin with');
    assert.equal(at()[0], nodes[0]);
    assert.equal(into.textOf('sf-vb-teach'), cycle.teach);

    for (let tick = 1; tick <= cycle.steps.length; tick++) {
        scheduler.fire();
        const landed = tick % cycle.steps.length;
        assert.equal(at().length, 1, `exactly one node is current after ${tick} ticks`);
        assert.equal(at()[0], nodes[landed], 'the highlight travelled with the tick');
        assert.equal(into.textOf('sf-vb-step-report'), `Step ${landed + 1} of ${cycle.steps.length}`);
    }

    assert.equal(at()[0], nodes[0], 'and a full turn brings it home');
    assert.deepEqual(nodes.map(node => node.style['--sf-vb-angle']), angles, 'the ring’s geometry never moved');
    assert.equal(into.byClass('sf-vb-cycle-note').length, 2, 'and the notes under it are untouched');
    teardown();
});

test('a pulse cycle breathes instead of stepping, and the stylesheet draws the breath', () => {
    const cycle = pulseCycleFixture();
    const scheduler = new FakeScheduler();
    const { into, teardown } = mountBoard([cycle], host(), { scheduler });
    const ring = into.byClass('sf-vb-ring')[0];
    const toggle = into.byClass('sf-vb-motion-toggle')[0];

    assert.ok(toggle.hasClass('is-playing'), 'the ring is breathing as it arrives');
    assert.ok(ring.hasClass('is-pulsing'), 'and it says so on the ring the stylesheet animates');
    assert.equal(scheduler.scheduled, 0, 'a pulse has no step to walk, so nothing ticks');
    assert.equal(into.textOf('sf-vb-step-report'), 'Step 1 of 3', 'and the highlight stays where it was');

    toggle.click();
    assert.equal(ring.hasClass('is-pulsing'), false, 'Pause stops the breathing');
    assert.equal(toggle.textContent, 'Play');
    toggle.click();
    assert.ok(ring.hasClass('is-pulsing'), 'and Play starts it again');

    const css = read(CSS_PATH);
    assert.match(ruleBody(css, '.sf-vb-ring.is-pulsing .sf-vb-ring-track'), /animation:/, 'the breath is an animation, not a class with no rule');
    assert.match(css, /@keyframes sf-vb-breathe/, 'with the keyframes it names');
    assert.match(ruleBody(css, '.sf-vb-motion-toggle'), /cursor:\s*pointer/, 'and the toggle is a control in the stylesheet too');
    assert.match(ruleBody(css, '.sf-vb-motion-toggle.is-playing'), /(border-color|background)/, 'whose playing state is drawn as well as said');
    assert.match(ruleBody(css, '.sf-vb-motion-toggle:disabled'), /opacity/, 'and whose disabled state says so');
    assert.match(ruleBody(css, '.sf-vb-step'), /transition:/, 'a step’s highlight travels rather than jumps');
    assert.match(ruleBody(css, '.sf-vb-ring-step'), /transition:/, 'and so does the ring’s');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'and the stylesheet honours the preference as well as the code');
    teardown();
});

// ------------------------------------------------------------ the scrubber

test('the scrubber moves the highlight along the entries and says which one it is on', () => {
    const timeline = timelineFixture();
    const { into, view } = mountBoard([timeline]);

    const entries = into.byClass('sf-vb-tl-entry');
    const range = into.byClass('sf-vb-scrub-range')[0];
    const report = (): string => into.textOf('sf-vb-scrub-report');
    const now = (): MiniElement => into.byClass('sf-vb-scrub-now')[0];

    assert.equal(range.tag, 'input');
    assert.equal(range.attrs.type, 'range', 'the scrubber is a range control');
    assert.equal(range.attrs.min, '1');
    assert.equal(range.attrs.max, String(timeline.entries.length));
    assert.equal(range.value, '1', 'it opens on the first entry');
    assert.equal(report(), `Entry 1 of ${timeline.entries.length}`);
    assert.equal(current(into, 'sf-vb-tl-entry').length, 1, 'one entry is current');
    assert.equal(current(into, 'sf-vb-tl-entry')[0], entries[0]);

    assert.equal(press(view, range, 'ArrowRight'), true);
    assert.equal(report(), 'Entry 2 of 3', 'a key moves it one entry');
    assert.equal(range.value, '2', 'the range follows the reader');
    assert.equal(current(into, 'sf-vb-tl-entry')[0], entries[1]);
    assert.equal(current(into, 'sf-vb-tl-entry').length, 1, 'and the highlight does not spread');
    assert.equal(now().textOf('sf-vb-tl-label'), timeline.entries[1].label, 'the entry is read out above the rule too');
    assert.equal(now().byClass('sf-vb-tl-detail')[0].hasClass('is-empty'), true, 'an entry with no detail adds no empty line');

    assert.equal(press(view, into.byClass('sf-vb-tl-marker')[1], 'ArrowRight'), true, 'the keys work from a marker as well');
    assert.equal(report(), 'Entry 3 of 3');
    assert.equal(now().textOf('sf-vb-tl-detail'), timeline.entries[2].detail, 'and the detail comes with its entry');
    assert.equal(now().byClass('sf-vb-tl-detail')[0].hasClass('is-empty'), false);

    assert.equal(press(view, range, 'ArrowRight'), true, 'the last entry is where it stops');
    assert.equal(report(), 'Entry 3 of 3');
    assert.equal(range.value, '3');
    assert.equal(press(view, range, 'ArrowLeft'), true);
    assert.equal(report(), 'Entry 2 of 3');
    assert.equal(range.value, '2');
});

test('a marker jumps the scrubber to the entry it names', () => {
    const timeline = timelineFixture();
    const { into } = mountBoard([timeline]);

    const markers = into.byClass('sf-vb-tl-marker');
    const range = into.byClass('sf-vb-scrub-range')[0];
    assert.ok(markers.every(marker => marker.tag === 'button' && marker.attrs.type === 'button'), 'the time on the rule is the control');
    assert.deepEqual(
        markers.map(marker => marker.textOf('sf-vb-tl-when')),
        timeline.entries.map(entry => entry.when),
        'and it still says what it always said'
    );

    markers[1].click();
    assert.equal(into.textOf('sf-vb-scrub-report'), 'Entry 2 of 3');
    assert.equal(range.value, '2', 'the range follows the jump');
    assert.equal(current(into, 'sf-vb-tl-entry')[0], into.byClass('sf-vb-tl-entry')[1]);

    markers[0].click();
    assert.equal(into.textOf('sf-vb-scrub-report'), 'Entry 1 of 3', 'and back to the first');
    assert.equal(range.value, '1');
});

// --------------------------------------------------------- the host's width

/**
 * mini-dom lays nothing out, so the overflow question is asked with a model of
 * the two mechanisms the stylesheet actually relies on: a cell that may break
 * anywhere needs one character of room, and a table that cannot be drawn
 * inside the host is scrolled by the box around it rather than by the host.
 * The model is here to give the structural assertions a number to disagree
 * with — `X px` of content in a `340px` host.
 */
function inherentCellWidth(text: string, breaksAnywhere: boolean): number {
    if (breaksAnywhere) return CHARACTER_WIDTH;
    const longest = text.split(/\s+/).reduce((widest, token) => Math.max(widest, token.length), 0);
    return longest * CHARACTER_WIDTH;
}

function inherentTableWidth(table: MiniElement, breaksAnywhere: boolean): number {
    const body = table.byClass('sf-vb-table-body')[0];
    const columns: number[] = [];
    for (const row of body.byClass('sf-vb-row')) {
        row.byClass('sf-vb-cell').forEach((cell, index) => {
            columns[index] = Math.max(columns[index] ?? 0, inherentCellWidth(cell.textContent, breaksAnywhere));
        });
    }
    return columns.reduce((total, needed) => total + needed, 0);
}

test('a matrix with a very long cell stays inside its host', () => {
    const css = read(CSS_PATH);
    const wide: StudyMatrix = {
        kind: 'matrix',
        title: 'One finding, no spaces',
        columns: ['Finding', 'Note'],
        rows: [
            { label: 'Alpha', cells: [LONG_CELL, 'short note'] },
            { label: 'Beta', cells: ['a normal sentence that wraps on its spaces', 'x'] },
        ],
    };
    const { into } = mountBoard([wide]);

    // The host lays out the box; the table lives inside it.
    const scroller = into.byClass('sf-vb-table-scroll')[0];
    assert.equal(scroller.parent, into.byClass('sf-vb-visual')[0], 'the host lays out the table’s own box');
    assert.equal(scroller.byClass('sf-vb-table')[0].parent, scroller);

    // Unbroken, this table cannot be drawn in a sidebar: that is what the box is for.
    const unbroken = inherentTableWidth(scroller.byClass('sf-vb-table')[0], false);
    assert.ok(unbroken > SIDEBAR_WIDTH, `the fixture must be genuinely wide: ${unbroken}px of a ${SIDEBAR_WIDTH}px host`);
    // Allowed to break anywhere, it fits — and the stylesheet is what allows it.
    const breaksAnywhere = /overflow-wrap:\s*anywhere/.test(ruleBody(css, '.sf-vb-cell'));
    assert.equal(breaksAnywhere, true, 'a cell must be allowed to break anywhere');
    const broken = inherentTableWidth(scroller.byClass('sf-vb-table')[0], true);
    assert.ok(broken <= SIDEBAR_WIDTH, `a broken table asks for ${broken}px of a ${SIDEBAR_WIDTH}px host`);

    // The box that holds it never asks the host for more than the host has.
    assert.match(ruleBody(css, '.sf-vb-table-scroll'), /max-width:\s*100%/);
    assert.match(ruleBody(css, '.sf-vb-table-scroll'), /overflow(-x)?:\s*(auto|scroll)/, 'a wide matrix scrolls rather than spreading');
    assert.match(ruleBody(css, '.sf-vb'), /min-width:\s*0/, 'the board may be squeezed to its host');

    // Nothing is cut without a word: a cell too long to draw whole is drawn as
    // a few words and keeps the whole of itself as a title.
    const cut = into.byClass('sf-vb-cell').find(cell => cell.attrs.title === LONG_CELL);
    assert.ok(cut, 'the long cell is drawn');
    assert.equal(cut.textContent, `${'A'.repeat(CELL_DRAW_LENGTH)}…`, 'cut to the cap, with the apology the reader can see');
});

// ----------------------------------------------------------------- the summary

test('the summary counts its own bullets and pearls, in the reader’s words', () => {
    const summary = summaryFixture();
    const { into } = mountSummary(summary);
    assert.equal(into.textOf('sf-sum-count'), '5 bullets · 2 pearls');
    assert.equal(into.textOf('sf-sum-title'), summary.title);

    assert.equal(summaryCountLine(summary), '5 bullets · 2 pearls');
    assert.equal(summaryCountLine({ title: 'One', bullets: [{ text: 'Only one.', emphasis: 'pearl' }] }), '1 bullet · 1 pearl', 'one is singular');
    assert.equal(summaryCountLine({ title: 'None', bullets: [{ text: 'a' }, { text: 'b' }] }), '2 bullets · 0 pearls');
    assert.equal(summaryCountLine({ title: 'Empty', bullets: [] }), '0 bullets · 0 pearls');
});

test('a pearl is marked at a glance, and its children sit one level in', () => {
    const summary = summaryFixture();
    const { into } = mountSummary(summary);

    const bullets = into.byClass('sf-sum-bullet');
    assert.equal(bullets.length, summary.bullets.length);
    assert.deepEqual(
        bullets.map(bullet => bullet.hasClass('is-pearl')),
        summary.bullets.map(bullet => bullet.emphasis === 'pearl')
    );
    assert.equal(into.byClass('sf-sum-mark').length, summary.bullets.length, 'every bullet carries a mark');

    // A pearl is recognisable without reading closely: an accent edge and a
    // mark of its own, not just a heavier weight.
    const rule = ruleBody(read(CSS_PATH), '.sf-sum-bullet.is-pearl');
    assert.match(rule, /(border-left|box-shadow|background)/, 'a pearl is marked, not just emphasised in text');
    assert.match(read(CSS_PATH), /\.sf-sum-bullet\.is-pearl \.sf-sum-mark::before/, 'and its marker is its own');

    assert.equal(bullets[0].textOf('sf-sum-text'), summary.bullets[0].text);
    const main = bullets[0].byClass('sf-sum-main')[0];
    assert.equal(main.byClass('sf-sum-children')[0].parent, main, 'children hang off their own bullet');
    assert.deepEqual(main.byClass('sf-sum-child').map(child => child.textContent), ['Exertion, cold, emotion']);
    assert.equal(bullets[1].byClass('sf-sum-children').length, 0, 'a bullet with no children adds none');
    assert.equal(into.textOf('sf-sum-kept'), summary.kept, 'what the model was asked to keep is echoed');
});

test('the pearls-only toggle hides exactly the non-pearl bullets, and puts them back', () => {
    const summary = summaryFixture();
    const { into } = mountSummary(summary);
    const toggle = into.byClass('sf-sum-toggle')[0];
    assert.equal(toggle.tag, 'button', 'the toggle is a real button');
    assert.equal(toggle.attrs.type, 'button');
    assert.equal(toggle.attrs['aria-pressed'], 'false');
    assert.equal(toggle.textContent, 'Pearls only');

    const drawn = into.byClass('sf-sum-bullet');
    const hiddenTexts = (): string[] =>
        into.byClass('sf-sum-bullet')
            .filter(bullet => bullet.hasClass('sf-sum-hidden'))
            .map(bullet => bullet.textOf('sf-sum-text'));
    const notPearls = summary.bullets.filter(bullet => bullet.emphasis !== 'pearl').map(bullet => bullet.text);

    assert.deepEqual(hiddenTexts(), [], 'nothing is hidden to begin with');

    toggle.click();
    assert.deepEqual(hiddenTexts(), notPearls, 'exactly the bullets that are not pearls');
    assert.equal(hiddenTexts().length, 3, 'and all of them');
    assert.ok(
        into.byClass('sf-sum-bullet').filter(bullet => bullet.hasClass('is-pearl')).every(bullet => !bullet.hasClass('sf-sum-hidden')),
        'no pearl is hidden'
    );
    assert.equal(toggle.attrs['aria-pressed'], 'true');
    assert.ok(toggle.hasClass('is-on'), 'the control shows its own state');
    assert.ok(
        into.byClass('sf-sum-bullet').every((bullet, index) => bullet === drawn[index]),
        'the bullets were hidden, not thrown away'
    );

    toggle.click();
    assert.deepEqual(hiddenTexts(), [], 'and one more press puts them all back');
    assert.equal(toggle.attrs['aria-pressed'], 'false');
    assert.equal(toggle.hasClass('is-on'), false);
});

test('a summary with no pearls cannot be condensed away to nothing', () => {
    const { into } = mountSummary({ title: 'Nothing marked', bullets: [{ text: 'a' }, { text: 'b' }] });
    const toggle = into.byClass('sf-sum-toggle')[0];
    assert.equal(toggle.disabled, true, 'the control says it cannot do anything');

    toggle.click();
    assert.equal(into.byClass('sf-sum-hidden').length, 0, 'and a press of it hides nothing');
});

// ------------------------------------------------------------------- teardown

test('mounting again replaces the board instead of stacking a second one', () => {
    const { view, into } = mountBoard([flowFixture()]);
    assert.equal(into.byClass('sf-vb').length, 1);
    view.mount(into as unknown as HTMLElement, [matrixFixture()]);
    assert.equal(into.byClass('sf-vb').length, 1, 'one board, redrawn');
    assert.equal(into.byClass('sf-vb-table').length, 1, 'holding the new material');
    assert.equal(into.byClass('sf-vb-step').length, 0);
});

test('a board with no visuals leaves the host exactly as it was', () => {
    const into = host();
    into.createDiv('someone-elses-box');
    const { teardown } = mountBoard([], into);
    assert.equal(into.children.length, 1, 'nothing was added');
    teardown();
    assert.equal(into.children.length, 1, 'and nothing was taken away');
    assert.equal(into.byClass('someone-elses-box').length, 1);
});

test('teardown takes the board down and leaves the host as it was', () => {
    const into = host();
    into.createDiv('someone-elses-box');
    const { teardown } = mountBoard([flowFixture(), timelineFixture()], into);
    assert.equal(into.byClass('sf-vb').length, 1);

    teardown();
    assert.equal(into.byClass('sf-vb').length, 0);
    assert.equal(into.byClass('sf-vb-visual').length, 0);
    assert.equal(into.children.length, 1, 'only what was there before is left');
    assert.equal(into.byClass('someone-elses-box').length, 1);
});

test('teardown takes every control and every listener with it', () => {
    const visuals: StudyVisual[] = [matrixFixture(), compareFixture(), flowFixture(), cycleFixture(), timelineFixture()];
    const into = host();
    const { teardown } = mountBoard(visuals, into);

    const cards = into.byClass('sf-vb-visual');
    assert.equal(cards.length, visuals.length);
    assert.equal(
        cards.reduce((total, card) => total + card.listenerCount('keydown'), 0),
        visuals.length,
        'every card answers its own keys'
    );
    assert.deepEqual(
        cards.map(card => card.attrs['data-vb-control']),
        ['reveal', 'reveal', 'step', 'step', 'scrub'],
        'and says what it answers with'
    );

    const bound: Array<[MiniElement, string]> = [
        [into.byClass('sf-vb-reveal-toggle')[0], 'click'],
        [into.byClass('sf-vb-reveal')[0], 'click'],
        [into.byClass('sf-vb-step-prev')[0], 'click'],
        [into.byClass('sf-vb-step-next')[0], 'click'],
        [into.byClass('sf-vb-scrub-range')[0], 'input'],
        [into.byClass('sf-vb-tl-marker')[0], 'click'],
    ];
    assert.ok(bound.every(([element, type]) => element.listenerCount(type) === 1), 'one handler each while the board is mounted');

    const next = into.byClass('sf-vb-step-next')[0];
    const report = into.byClass('sf-vb-step-report')[0];
    const settled = report.textContent;

    teardown();

    assert.equal(into.byClass('sf-vb-visual').length, 0, 'the controls are gone from the host');
    assert.ok(bound.every(([element, type]) => element.listenerCount(type) === 0), 'and none of them is still listening');
    assert.equal(cards.reduce((total, card) => total + card.listenerCount('keydown'), 0), 0, 'every card let go of its keys');
    assert.equal(into.children.length, 0, 'the host is as it was found');

    // A control whose listener went with the board is inert.
    next.click();
    assert.equal(report.textContent, settled, 'nothing reacts to a control any more');
});

test('teardown takes the motion with it: no timer left behind, and no listener', () => {
    const scheduler = new FakeScheduler();
    const { into, teardown } = mountBoard([movingFlowFixture()], host(), { scheduler });
    const toggle = into.byClass('sf-vb-motion-toggle')[0];
    assert.equal(scheduler.scheduled, 1, 'the motion is running while the board is mounted');
    assert.equal(toggle.listenerCount('click'), 1, 'and the control answers the reader');

    teardown();

    assert.equal(scheduler.scheduled, 0, 'the schedule is let go of with the board');
    assert.equal(toggle.listenerCount('click'), 0, 'along with the control that drove it');
    assert.equal(into.children.length, 0, 'and the host is as it was found');
    assert.equal(toggle.hasClass('is-playing'), false, 'the control is left saying it is stopped');

    // A control whose listeners went with the board is inert.
    toggle.click();
    assert.equal(scheduler.scheduled, 0, 'nothing starts a motion that is not there');
});

test('teardown takes the summary down and lets go of its listener', () => {
    const { into, teardown } = mountSummary(summaryFixture());
    const toggle = into.byClass('sf-sum-toggle')[0];
    assert.equal(toggle.listenerCount('click'), 1, 'one handler while it is mounted');

    teardown();
    assert.equal(toggle.listenerCount('click'), 0, 'and none when it is gone');
    assert.equal(into.byClass('sf-sum').length, 0);
    assert.equal(into.children.length, 0);

    // The detached button is inert: nothing reacts to it any more.
    toggle.click();
    assert.equal(toggle.hasClass('is-on'), false);
});

// ------------------------------------------------------- the stylesheet's part

test('every class the board and the summary render has a rule in their stylesheet', () => {
    const source = read('ui/study-visual-board.ts');
    const css = read(CSS_PATH);
    // `--sf-vb-angle` is data the code sets, not a class it renders.
    const tokens = new Set([...source.replace(/--sf-[a-z0-9-]+/g, ' ').matchAll(/sf-[a-z0-9-]+/g)].map(match => match[0]));

    const missing = [...tokens].filter(token => !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(tokens.size >= 40, `expected to find the board's classes, found ${tokens.size}`);

    // The modifier classes carry the meaning; each one needs its own rule too.
    for (const modifier of [
        'is-pearl',
        'is-on',
        'is-emphasis',
        'is-decision',
        'is-outcome',
        'is-covered',
        'is-current',
        'is-stepped',
        'is-empty',
        'is-playing',
        'is-pulsing',
        'is-mark-better',
        'is-mark-worse',
        'is-mark-equal',
    ]) {
        assert.ok(css.includes(`.${modifier}`), `no rule for ${modifier}`);
    }
});

test('the stylesheet draws the cover, the current step and the scrubber', () => {
    const css = read(CSS_PATH);
    // The cover hides the answer and says what to do instead — without putting
    // a word into the cell's own text, because that text is the answer.
    assert.match(ruleBody(css, '.sf-vb-cell.is-covered .sf-vb-reveal-text'), /display:\s*none/);
    assert.match(ruleBody(css, '.sf-vb-cell.is-covered .sf-vb-reveal::before'), /content:\s*'Tap to reveal'/);
    // Every control is a real control in the stylesheet too: the bars exist,
    // and both kinds of button have been stripped of the app's own chrome.
    for (const bar of ['.sf-vb-reveal-bar', '.sf-vb-stepper', '.sf-vb-scrub']) assert.ok(css.includes(`${bar} {`), `no rule for ${bar}`);
    assert.match(ruleBody(css, '.sf-vb-reveal'), /(width:\s*100%|display:\s*block)/, 'the cell button fills its cell');
    assert.match(ruleBody(css, '.sf-vb-tl-marker'), /background:\s*transparent/, 'the marker reads as the cell it sits in, not as a button');
    // A step the reader is not on stands back; the one they are on carries an edge.
    assert.match(ruleBody(css, '.sf-vb-steps.is-stepped .sf-vb-step:not(.is-current)'), /opacity/);
    assert.match(ruleBody(css, '.sf-vb-ring.is-stepped .sf-vb-ring-step:not(.is-current)'), /opacity/);
    assert.match(ruleBody(css, '.sf-vb-step.is-current'), /(box-shadow|border-left|background)/, 'the current step is marked, not merely undimmed');
    assert.match(ruleBody(css, '.sf-vb-tl-entry.is-current'), /(box-shadow|border-left|background)/, 'and so is the entry the scrubber is on');
});

test('the stylesheet keeps the table in its own box and its header in view', () => {
    const css = read(CSS_PATH);
    assert.match(ruleBody(css, '.sf-vb-th'), /position:\s*sticky/, 'the column names stay while the matrix scrolls');
    assert.match(ruleBody(css, '.sf-vb-cell'), /white-space:\s*normal/, 'a cell wraps rather than clipping');
    assert.match(ruleBody(css, '.sf-vb-tl-detail'), /overflow-wrap:\s*anywhere/, 'a timeline detail wraps too');
    // No rule in this stylesheet sizes text off the house scale, and none clips
    // a line silently (the suite-wide consistency test reads the same file).
    const sized = [...css.matchAll(/font-size:\s*([^;{}]+)/g)].map(match => match[1].trim());
    assert.ok(sized.length > 0, 'the stylesheet sizes text');
    assert.deepEqual(sized.filter(value => /\d(\d+)?(px|rem|pt)/.test(value)), [], 'every size comes from a --sf-font-* token');
});

test('the ring’s angles are data, set the way the house sets them', () => {
    const source = read('ui/study-visual-board.ts');
    assert.match(source, /setCssProps\(\{ '--sf-vb-angle'/, 'the ring is placed through a custom property');
    assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(source), 'and never through an inline style assignment');
});
