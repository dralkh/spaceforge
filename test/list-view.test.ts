/**
 * The list's pin: the row the run is standing on — the note while the run is on
 * a note, the deck while it stands on a deck step.
 *
 * The run's cursor is the one remembered position (see
 * controllers/review-flow-controller.ts): a step of it is either a note or a
 * card lane's deck, and the list shows it where the reader looks for it. Two
 * halves are pinned here, both against real code:
 *
 * - `ListViewRenderer`'s own marker (`markRunPosition`): a note step marks the
 *   note's row and clears the decks; a deck step — where `currentPath()` is
 *   null by design — marks the row of the deck the sitting is on and clears the
 *   notes; and a position that names nothing marks nothing;
 * - the row the marker lands on is found by the path it carries
 *   (`data-deck-path`, as a note row carries `data-note-path`), and the deck
 *   row really carries it — the row is painted here by the real `DeckRowView`,
 *   so the contract between the two views cannot drift.
 *
 * Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DeckDueGroup, DeckRowHandlers, DeckRowView } from '../ui/sidebar/deck-list-renderer';
import { ListViewRenderer } from '../ui/sidebar/list-view-renderer';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const DECK = 'spaceforge/decks/Biology demo.md';

// ------------------------------------------------------------- the marker

/** The run, in the controller's own shape: a card step is not a note. */
interface RunStandIn {
    active: boolean;
    onCards: boolean;
    /** The note when on one — ignored on a card step, as the controller does. */
    path: string | null;
}

/** One row as the marker sees it: the path it carries, and the marker class. */
class Row {
    readonly classes = new Set<string>();
    constructor(readonly dataset: Record<string, string>) {}

    toggleClass(cls: string, value: boolean): void {
        if (value) this.classes.add(cls);
        else this.classes.delete(cls);
    }

    marked(): boolean {
        return this.classes.has('is-run-current');
    }
}

/** The list container, as `querySelectorAll` sees it: the two row kinds. */
class List {
    readonly noteRows: Row[];
    readonly deckRows: Row[];

    constructor(notes: string[], decks: string[]) {
        this.noteRows = notes.map(notePath => new Row({ notePath }));
        // A row painted without its path (an older renderer, a deck that cannot
        // name itself) is still a row: it must simply never be marked.
        this.deckRows = decks.map(deckPath => new Row(deckPath === '' ? {} : { deckPath }));
    }

    querySelectorAll(selector: string): Row[] {
        if (selector === '.review-note-item[data-note-path]') {
            return this.noteRows.filter(row => row.dataset.notePath !== undefined);
        }
        if (selector === '.sf-deck-row[data-deck-path]') {
            return this.deckRows.filter(row => row.dataset.deckPath !== undefined);
        }
        throw new Error(`the marker asked for a selector it should not: ${selector}`);
    }
}

function makeMarker(run: RunStandIn, sittingDeck: () => string | null): (container: List) => void {
    const plugin = {
        reviewFlowController: {
            isActive: () => run.active,
            isOnCardsStep: () => run.active && run.onCards,
            currentPath: () => (run.active && !run.onCards ? run.path : null),
        },
        deckSessionController: { currentDeckPath: sittingDeck },
    };
    const renderer = new ListViewRenderer(plugin as never, {} as never, {} as never, {
        getActiveListBaseDate: () => null,
        getSelectedNotes: () => [],
        setSelectedNotes: () => undefined,
        getExpandedUpcomingDayKey: () => null,
        setExpandedUpcomingDayKey: () => undefined,
        getLastSelectedNotePath: () => null,
        setLastSelectedNotePath: () => undefined,
        refreshSidebarView: async () => undefined,
    });
    return (container: List): void =>
        (renderer as unknown as { markRunPosition(c: unknown): void }).markRunPosition(container);
}

const marked = (rows: Row[]): boolean[] => rows.map(row => row.marked());

test('the note the run stands on wears the marker, and only it', () => {
    const list = new List(['notes/a.md', 'notes/b.md'], [DECK, 'spaceforge/decks/Other.md']);
    // A sitting may still be docked while the run is on a note: the flow, not
    // the sitting, decides which row is the run's place.
    makeMarker({ active: true, onCards: false, path: 'notes/b.md' }, () => DECK)(list);

    assert.deepEqual(marked(list.noteRows), [false, true]);
    assert.deepEqual(marked(list.deckRows), [false, false], 'a note step marks no deck');
});

test('the deck the run stands on wears the marker while its step names no note', () => {
    const list = new List(['notes/a.md'], [DECK, 'spaceforge/decks/Other.md']);
    // A deck step is not a note: `currentPath()` is null by design there, and
    // the deck the step stands for is the one the sitting is on.
    makeMarker({ active: true, onCards: true, path: null }, () => DECK)(list);

    assert.deepEqual(marked(list.deckRows), [true, false], 'the sitting deck row, by path');
    assert.deepEqual(marked(list.noteRows), [false], 'no note is claimed by a deck step');
});

test('stepping off the deck takes the deck marker down', () => {
    const list = new List(['notes/a.md'], [DECK]);
    const run: RunStandIn = { active: true, onCards: true, path: null };
    const mark = makeMarker(run, () => DECK);

    mark(list);
    assert.equal(list.deckRows[0].marked(), true);

    // The run walks back onto a note.
    run.onCards = false;
    run.path = 'notes/a.md';
    mark(list);

    assert.equal(list.deckRows[0].marked(), false, 'the marker is a position, not a badge');
    assert.equal(list.noteRows[0].marked(), true, 'and it is now on the note');
});

test('a deck step whose sitting cannot name a deck marks nothing', () => {
    const list = new List(['notes/a.md'], [DECK, '']);
    // The run starts the sitting on its way to the step: an unnamed deck is a
    // real state, and claiming a row for it would be a guess.
    makeMarker({ active: true, onCards: true, path: null }, () => null)(list);

    assert.deepEqual(marked(list.deckRows), [false, false]);
    assert.deepEqual(marked(list.noteRows), [false]);
});

test('with no run walking, no row wears the marker', () => {
    const list = new List(['notes/a.md'], [DECK]);
    makeMarker({ active: false, onCards: false, path: 'notes/a.md' }, () => DECK)(list);

    assert.deepEqual(marked(list.noteRows), [false]);
    assert.deepEqual(marked(list.deckRows), [false]);
});

// ------------------------------------------------------- the row's identity

interface PaintedOptions {
    cls?: string;
    text?: string;
    attr?: Record<string, string>;
    title?: string;
}

/** A painted element: exactly the surface the deck rows use, and no more. */
class Painted {
    readonly classes = new Set<string>();
    readonly attrs: Record<string, string> = {};
    readonly children: Painted[] = [];
    textContent = '';

    createEl(_tag: string, options?: PaintedOptions): Painted {
        return this.append(options);
    }

    createDiv(options?: PaintedOptions): Painted {
        return this.append(options);
    }

    createSpan(options?: PaintedOptions): Painted {
        return this.append(options);
    }

    private append(options?: PaintedOptions): Painted {
        const child = new Painted();
        for (const cls of (options?.cls ?? '').split(' ')) if (cls.length > 0) child.classes.add(cls);
        if (options?.text !== undefined) child.textContent = options.text;
        if (options?.attr !== undefined) Object.assign(child.attrs, options.attr);
        // Obsidian's own `title` option is the title attribute.
        if (options?.title !== undefined) child.attrs.title = options.title;
        this.children.push(child);
        return child;
    }

    setAttribute(name: string, value: string): void {
        this.attrs[name] = value;
    }

    addEventListener(): void { /* the marker only reads the row */ }

    byClass(cls: string): Painted[] {
        const found: Painted[] = [];
        for (const child of this.children) {
            if (child.classes.has(cls)) found.push(child);
            found.push(...child.byClass(cls));
        }
        return found;
    }
}

function deckGroup(): DeckDueGroup {
    return {
        path: DECK,
        name: 'Biology demo',
        cards: [{ cardId: 'c1', front: 'What is the powerhouse of the cell?', state: 'due today' }],
    };
}

test('the row the marker lands on carries its deck path', () => {
    // The marker finds a deck's row the way it finds a note's — by the path the
    // row carries — so the row has to carry one; it is painted here by the real
    // view, which is what makes the two halves one contract.
    const container = new Painted();
    const handlers: DeckRowHandlers = {
        studyDeck: () => undefined,
        studyCard: () => undefined,
        openDeck: () => undefined,
    };
    new DeckRowView(null as never, handlers).renderDay(container as never, [deckGroup()]);

    const rows = container.byClass('sf-deck-row');
    assert.equal(rows.length, 1, 'the deck row is painted');
    assert.equal(rows[0].attrs['data-deck-path'], DECK, 'and it says which deck it is, by path');
    // A row identified by its name would highlight the wrong deck when two
    // decks share a display name; the path cannot collide.
    assert.equal(rows[0].attrs.title, 'Biology demo', 'the name still rides along, for the reader');
});

// ----------------------------------------------------------------- the look

/** The rule body for a selector, so a property can be asserted where it lands. */
function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at) + 1);
}

test('one marker, two row kinds: the same class and the same tokens', () => {
    const css = read('styles/sidebar.css');
    const noteRule = ruleBody(css, '.review-note-item.is-run-current');
    const deckRule = ruleBody(css, '.sf-deck-row.is-run-current');

    for (const [kind, rule] of [['note', noteRule], ['deck', deckRule]] as const) {
        assert.match(rule, /var\(--interactive-accent\)/, `${kind}: the marker is the accent, never a colour of its own`);
        assert.match(rule, /var\(--background-modifier-hover\)/, `${kind}: and the wash the rows already wear on hover`);
        assert.ok(!/#[0-9a-fA-F]{3,6}|rgb\(/.test(rule), `${kind}: no hard-coded colour`);
    }
    // The note row has no border, so its accent is an inset bar; the deck row
    // owns a left edge already, and its accent goes there. Neither invents a
    // second marker class.
    assert.match(noteRule, /box-shadow/, 'the note rows keep their inset accent bar');
    assert.match(deckRule, /border-left-color/, 'the deck row wears the same marker on its own edge');
    assert.ok(read('styles/deck-list.css').includes('.sf-deck-row'), 'the row the marker targets is the styled one');
});
