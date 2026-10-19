/**
 * The sidebar's third tab: the mount point the review session moves into.
 *
 * The view under test is the real `ReviewSidebarView`, driven against the mini
 * DOM. Only two things are stand-ins: Obsidian's own shell (a leaf, an element,
 * the few element helpers the view calls) and the flow controller, which is
 * observed — never changed — because moving the session is its job, not the
 * sidebar's. What is asserted here is the contract between the two: which
 * element the controller is handed, when the session moves in, and when it is
 * handed back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Setting } from './support/obsidian-shim';
import { DEFAULT_SETTINGS } from '../models/settings';
import { MiniElement, flatten, textsOfClass } from './support/mini-dom';
import { ReviewSidebarView } from '../ui/sidebar-view';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

/**
 * The mini DOM implements the helpers the plugin's own surfaces use. This view
 * additionally drives Obsidian's `hide()`/`show()` on the list and calendar
 * panes and a `Setting` in its header, and there is no seam to inject them
 * through — the harness shims are shared with the whole suite — so the missing
 * pieces are filled in on the prototypes, once.
 */
function installObsidianElementHelpers(): void {
    const elementProto = MiniElement.prototype as unknown as Record<string, unknown>;
    elementProto.hide ??= function (this: MiniElement): void { this.style.display = 'none'; };
    elementProto.show ??= function (this: MiniElement): void { this.style.display = ''; };

    const settingProto = Setting.prototype as unknown as Record<string, unknown>;
    settingProto.setHeading ??= function (this: unknown) { return this; };
    settingProto.setName ??= function (this: unknown) { return this; };
    settingProto.setDesc ??= function (this: unknown) { return this; };

    // refresh() applies the pane's scroll position on the next frame.
    const globals = globalThis as Record<string, unknown>;
    globals.requestAnimationFrame ??= (callback: () => void): number => { callback(); return 0; };
}
installObsidianElementHelpers();

type Mode = 'list' | 'calendar' | 'review';

interface HostCall {
    host: string;
    container: MiniElement | null;
    persist: boolean;
    /** Whether the review tab was already hidden when the move was asked for. */ 
    tabHidden: boolean | null;
    /** The mode the sidebar was still showing when the move was asked for. */
    modeAtMove: string;
}

interface Harness {
    settings: Record<string, unknown>;
    hostCalls: HostCall[];
    view: ReviewSidebarView;
    containerEl: MiniElement;
    saves(): number;
    refreshes(): number;
    started(): number;
    /** The session's home as the controller now reports it. */
    host(): string;
    /** Latch the controller's host without recording a move, for the leak states. */
    latchHost(next: string): void;
    /** Put the run somewhere: a note, a deck step, or nowhere. */
    setRun(next: { active: boolean; onCards: boolean; path: string | null }): void;
    /** The deck a sitting is on, as the deck lane would report it. */
    setSittingDeck(deckPath: string | null): void;
    /** The view's own follow machinery, driven a tick at a time. */
    follow(): FollowApi;
    /** The review body, wherever it sits in the sidebar. */
    reviewTab(): MiniElement | null;
    /** The tabs that carry the active state, by label. */
    activeTabs(): string[];
    clickTab(label: string): void;
    settle(rounds?: number): Promise<void>;
}

/** The list's follow tick, as the view keeps it — private, cast for the test. */
interface FollowApi {
    followRun(): void;
    ensureRunFollow(): void;
    stopRunFollow(): void;
    lastRunSignature: string | null;
    runFollowTimer: number | null;
}

function makeHarness(mode: Mode, options: { host?: string; active?: boolean } = {}): Harness {
    const hostCalls: HostCall[] = [];
    let host = options.host ?? 'note';
    let active = options.active ?? false;
    let started = 0;
    let saves = 0;
    let refreshes = 0;
    // The run, in the flow controller's own shape: a card step is not a note.
    let onCards = false;
    let runPath: string | null = null;
    let sittingDeck: string | null = null;

    const settings: Record<string, unknown> = {
        ...DEFAULT_SETTINGS,
        sidebarViewType: mode,
        reviewSessionHost: host,
    };

    const containerEl = new MiniElement('div');
    containerEl.addClass('workspace-leaf-content');

    // The controller, recorded: the sidebar may only ask it to move, and the
    // run it starts is the run the tab then shows.
    const flow = {
        setHost(nextHost: string, container: MiniElement | null = null, persist = true): void {
            // Whether the tab is already hidden when the session is asked to
            // leave is exactly what the ordering bug was: a container may only
            // be hidden once nothing of the session is inside it.
            const tab = containerEl.byClass('sf-sidebar-review')[0] ?? null;
            hostCalls.push({
                host: nextHost,
                container,
                persist,
                tabHidden: tab ? tab.hasClass('sf-hidden') : null,
                modeAtMove: String(settings.sidebarViewType),
            });
            host = nextHost;
            if (persist) settings.reviewSessionHost = nextHost;
        },
        getHost: () => host,
        isActive: () => active,
        isOnCardsStep: () => active && onCards,
        currentPath: () => (active && !onCards ? runPath : null),
        start: () => { started += 1; active = true; },
    };

    const plugin: Record<string, unknown> = {
        settings,
        events: { on: () => undefined, off: () => undefined, emit: () => undefined },
        savePluginData: async () => { saves += 1; },
        reviewFlowController: flow,
        deckSessionController: { currentDeckPath: () => sittingDeck },
        reviewController: {
            getCurrentReviewDateOverride: () => null,
            setReviewDateOverride: async () => undefined,
        },
    };

    const view = new ReviewSidebarView({} as never, plugin as never);
    (view as unknown as { containerEl: MiniElement }).containerEl = containerEl;
    // This suite is about which pane is on screen; building a whole schedule is
    // what the two renderers the view already delegates through are for.
    view.renderListViewContent = async () => undefined;
    view.renderCalendarViewContent = async () => undefined;
    // Count the paint passes without changing one: the follow tick's whole
    // contract is when it does and does not ask for a refresh.
    const paint = view.refresh.bind(view);
    view.refresh = async () => { refreshes += 1; return paint(); };

    return {
        settings,
        hostCalls,
        view,
        containerEl,
        saves: () => saves,
        refreshes: () => refreshes,
        started: () => started,
        host: () => host,
        latchHost: (next: string) => { host = next; },
        setRun: next => { active = next.active; onCards = next.onCards; runPath = next.path; },
        setSittingDeck: deckPath => { sittingDeck = deckPath; },
        follow: () => view as unknown as FollowApi,
        reviewTab: () => containerEl.byClass('sf-sidebar-review')[0] ?? null,
        activeTabs: () => containerEl.byClass('review-view-btn')
            .filter(button => button.hasClass('active'))
            .map(button => flatten(button)),
        clickTab: (label: string) => {
            const button = containerEl.byClass('review-view-btn').find(
                candidate => flatten(candidate) === label
            );
            if (!button) throw new Error(`No view button labelled "${label}"`);
            button.click();
        },
        settle: async (rounds = 4) => {
            for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
        },
    };
}

/** Shorthand: the labels of the tab row, in the order they are rendered. */
function tabLabels(h: Harness): string[] {
    const toggle = h.containerEl.byClass('review-view-toggle')[0];
    assert.ok(toggle, 'the tab row is rendered');
    return textsOfClass(toggle, 'review-view-btn');
}

test('the header carries a review tab beside list and calendar', async () => {
    const h = makeHarness('list');
    await h.view.refresh();

    assert.deepEqual(tabLabels(h), ['List', 'Calendar', 'Review']);
    // The reader's choice is public state: exactly one tab is active.
    assert.deepEqual(h.activeTabs(), ['List']);
});

test('refreshing onto the review tab hands the controller the container', async () => {
    const h = makeHarness('review');
    await h.view.refresh();

    const tab = h.reviewTab();
    assert.ok(tab, 'the review body exists');
    assert.ok(!tab.hasClass('sf-hidden'), 'the tab is visible while it is the chosen mode');
    assert.ok(h.containerEl.byClass('spaceforge-container')[0]?.find(el => el === tab), 'it lives in the sidebar body');

    assert.equal(h.hostCalls.length, 1);
    assert.equal(h.hostCalls[0].host, 'sidebar');
    assert.equal(h.hostCalls[0].container, tab, 'the controller is handed that very element');
    assert.equal(h.hostCalls[0].persist, true, 'the reader chose the tab, so the choice is written down');
    assert.equal(h.hostCalls[0].tabHidden, false, 'and the tab is revealed before the session moves in');
    assert.equal(h.settings.reviewSessionHost, 'sidebar');
    assert.equal(h.started(), 1, 'an idle session is started so the tab has something to show');
});

test('the review body exists but stays hidden while another tab is on screen', async () => {
    const h = makeHarness('list');
    await h.view.refresh();

    const tab = h.reviewTab();
    assert.ok(tab, 'it is created from the first render, ready to host');
    assert.ok(tab.hasClass('sf-hidden'));
    assert.deepEqual(h.hostCalls, [], 'nothing is dragged into a tab nobody asked for');
    assert.equal(h.started(), 0);
});

test('the tab is created once: a refresh never re-creates the session\'s home', async () => {
    const h = makeHarness('review');
    await h.view.refresh();
    const tab = h.reviewTab();
    assert.ok(tab);

    // Stand in for the session's own DOM, which the controller moved in.
    const session = tab.createDiv('sf-strip');

    await h.view.refresh();
    await h.view.refresh();

    assert.equal(h.containerEl.byClass('sf-sidebar-review').length, 1, 'exactly one review body');
    assert.equal(h.reviewTab(), tab, 'the same element, not a fresh one');
    assert.equal(tab.children.includes(session), true, 'a session living inside it is left alone');
});

test('an active run is left running: the tab only mounts it', async () => {
    const h = makeHarness('review', { active: true });
    await h.view.refresh();

    assert.equal(h.started(), 0, 'the tab does not start a second run');
    assert.equal(h.hostCalls.at(-1)?.host, 'sidebar');
});

test('pressing review switches the mode, persists it and mounts the session', async () => {
    const h = makeHarness('list');
    await h.view.refresh();

    h.clickTab('Review');
    await h.settle();

    assert.equal(h.settings.sidebarViewType, 'review');
    assert.ok(h.saves() >= 1, 'the chosen tab is written to the settings file');
    const tab = h.reviewTab();
    assert.ok(tab && !tab.hasClass('sf-hidden'), 'the tab is on screen');
    assert.equal(h.hostCalls.at(-1)?.host, 'sidebar');
    assert.equal(h.hostCalls.at(-1)?.container, tab);
    assert.equal(h.hostCalls.at(-1)?.persist, true);
    assert.equal(h.started(), 1);
    assert.deepEqual(h.activeTabs(), ['Review']);
});

test('leaving for another tab hands the session back without rewriting the reader\'s home', async () => {
    const h = makeHarness('review');
    await h.view.refresh();
    const tab = h.reviewTab();
    assert.ok(tab && h.settings.reviewSessionHost === 'sidebar');

    h.clickTab('List');
    await h.settle();

    const last = h.hostCalls.at(-1);
    assert.equal(last?.host, 'note', 'the session goes back under the note');
    assert.equal(last?.container, null);
    assert.equal(last?.persist, false, 'leaving is not a choice, so the remembered home stays');
    assert.equal(last?.tabHidden, false, 'and the session is asked to leave before the tab is hidden');
    assert.equal(h.settings.reviewSessionHost, 'sidebar', 'the reader\'s default is left as it was');
    assert.ok(tab.hasClass('sf-hidden'), 'the tab body is hidden, never emptied');
    assert.deepEqual(h.activeTabs(), ['List']);
});

test('the session leaves the review tab before that tab is hidden', async () => {
    // Hiding a container the session is still mounted in is how a live run went
    // invisible; the order is the fix, so it is asserted directly: at the moment
    // the move is asked for, the tab is still visible.
    const h = makeHarness('review');
    await h.view.refresh();
    const tab = h.reviewTab();
    assert.ok(tab && !tab.hasClass('sf-hidden'), 'the tab is on screen while the session lives in it');

    h.clickTab('Calendar');
    await h.settle();

    const last = h.hostCalls.at(-1);
    assert.equal(last?.host, 'note');
    assert.equal(last?.tabHidden, false, 'the move was asked for while the tab was still visible');
    assert.ok(tab.hasClass('sf-hidden'), 'and the tab is hidden only afterwards');
});

test('a remembered home other than the tab itself is restored as it is', async () => {
    const h = makeHarness('review');
    await h.view.refresh();
    h.settings.reviewSessionHost = 'window';

    h.clickTab('Calendar');
    await h.settle();

    assert.equal(h.hostCalls.at(-1)?.host, 'window');
    assert.equal(h.hostCalls.at(-1)?.persist, false);
});

test('closing the pane puts the session back', async () => {
    const h = makeHarness('review');
    await h.view.refresh();

    await h.view.onClose();

    const last = h.hostCalls.at(-1);
    assert.equal(last?.host, 'note');
    assert.equal(last?.container, null);
    assert.equal(last?.persist, false);
    assert.notEqual(h.host(), 'sidebar', 'the session is no longer inside a pane that is gone');
    assert.ok(h.reviewTab()?.hasClass('sf-hidden'));
});

test('closing the pane leaves a session that lives elsewhere where it is', async () => {
    // The saved mode is the tab, but the session itself was put in its own
    // window: the sidebar never held it, so closing must not move it.
    const h = makeHarness('review', { host: 'window' });

    await h.view.onClose();

    assert.deepEqual(h.hostCalls, []);
    assert.equal(h.settings.reviewSessionHost, 'window');
});

test('openReviewTab works before the first render', async () => {
    // The bar's menu calls this as soon as the pane is revealed — which can be
    // before this view has ever built its structure.
    const h = makeHarness('calendar');

    await h.view.openReviewTab();

    assert.equal(h.settings.sidebarViewType, 'review');
    assert.ok(h.saves() >= 1, 'asking for the tab is a choice, so it is persisted');
    const tab = h.reviewTab();
    assert.ok(tab, 'refresh() built the structure on the way');
    assert.equal(h.hostCalls.at(-1)?.host, 'sidebar');
    assert.equal(h.hostCalls.at(-1)?.container, tab);
    assert.equal(h.started(), 1);
    assert.deepEqual(h.activeTabs(), ['Review']);
});

// ---------------------------------------------------------------------------
// The pane, the mode and the session must agree. The mode is remembered across
// restarts and written from several places, so the view answers for the pane it
// is really showing — and a session is never left inside one that is not it.
// ---------------------------------------------------------------------------

test('the review pane answers for the pane this sidebar is really showing', async () => {
    const list = makeHarness('list');
    await list.view.refresh();
    assert.equal(list.view.isReviewPaneVisible(), false, 'the list is the pane on screen');

    const review = makeHarness('review');
    await review.view.refresh();
    assert.equal(review.view.isReviewPaneVisible(), true, 'the review pane is the pane on screen');

    review.clickTab('Calendar');
    await review.settle();
    assert.equal(review.view.isReviewPaneVisible(), false, 'and it stops being so the moment the reader leaves');
});

test('a mode written from outside the view still hands the session back', async () => {
    // The settings tab writes the mode and refreshes the view, and a date
    // picked in the calendar writes it before switching: neither presses a tab,
    // so the leave has to hang off the pane rather than off the buttons.
    const h = makeHarness('review');
    await h.view.refresh();
    assert.equal(h.host(), 'sidebar', 'the session is in the tab to begin with');

    h.settings.sidebarViewType = 'calendar'; // written elsewhere
    await h.view.refresh();

    const last = h.hostCalls.at(-1);
    assert.equal(last?.host, 'note', 'the session is handed back to the note');
    assert.equal(last?.persist, false, "without rewriting the reader's remembered home");
    assert.equal(last?.tabHidden, false, 'and before the pane is hidden');
    assert.ok(h.reviewTab()?.hasClass('sf-hidden'), 'the pane itself is hidden');
    assert.deepEqual(h.activeTabs(), ['Calendar']);
});

test('a tab press hands the session back before the new mode is written', async () => {
    // The window between writing the mode and the next render is exactly when a
    // session gets started from the list: the pane must not still be holding it.
    const h = makeHarness('review');
    await h.view.refresh();

    h.clickTab('List');
    await h.settle();

    assert.equal(h.hostCalls.at(-1)?.modeAtMove, 'review', 'the move was asked for while review was still the mode');
    assert.equal(h.host(), 'note');
});

test('a claim is refused while the pane is not the one on screen', async () => {
    // The app can take a view's element away (a rebuilt leaf) while the mode
    // still names the review pane: the tab must not hand the session to an
    // element nobody can see — that is how a run went missing from the list.
    const h = makeHarness('review');
    await h.view.refresh();
    const tab = h.reviewTab();
    assert.ok(tab, 'the pane exists');
    assert.equal(h.hostCalls.length, 1, 'it claimed the session while it was on screen');

    // The reader leaves; the claim is spent and the session is under the note.
    h.clickTab('List');
    await h.settle();
    assert.equal(h.view.isReviewPaneVisible(), false);

    // Back to review, but the pane the app has is no longer in the document.
    const callsBefore = h.hostCalls.length;
    h.settings.sidebarViewType = 'review';
    tab.isConnected = false;
    await h.view.refresh();

    assert.equal(h.view.isReviewPaneVisible(), false, 'a discarded pane is not on screen');
    assert.equal(h.hostCalls.length, callsBefore, 'so nothing is handed to it');
    assert.equal(h.started(), 1, 'and no second run is started for it');
});

test('closing the pane puts the session back even when the mode names another pane', async () => {
    // The leak the reader hit: the pane still holds the session while the mode
    // says the list is showing. Closing the view takes the element away either
    // way, so the session has to leave either way.
    const h = makeHarness('list');
    await h.view.refresh();
    h.reviewTab()?.removeClass('sf-hidden'); // a render from the review mode left it shown
    h.latchHost('sidebar'); // ... and the session in it

    await h.view.onClose();

    assert.equal(h.hostCalls.at(-1)?.host, 'note', 'the session is out of the pane before it goes');
    assert.equal(h.hostCalls.at(-1)?.persist, false, 'and the remembered home is untouched');
    assert.notEqual(h.host(), 'sidebar');
});

test('the review body is a flex column that never clips the session', () => {
    const css = read('styles/sidebar.css');
    const rule = ruleBody(css, '.sf-sidebar-review');

    assert.match(rule, /display:\s*flex/);
    assert.match(rule, /flex-direction:\s*column/);
    assert.match(rule, /width:\s*100%/);
    assert.match(rule, /min-height:\s*0/, 'the dock inside has to be able to scroll');
    assert.ok(!/overflow:\s*hidden/.test(rule), 'the session must not be clipped');
    assert.ok(!/font-size:\s*\d+px/.test(rule), 'font sizes scale with the theme');
    assert.match(ruleBody(css, '.sf-sidebar-review.sf-hidden'), /display:\s*none/);
});

test('the view mounts the session and styles none of it', () => {
    const view = read('ui/sidebar-view.ts');
    const css = read('styles/sidebar.css');

    assert.match(view, /createDiv\("sf-sidebar-review"\)/, 'the container the controller mounts into');
    assert.ok(css.includes('.sf-sidebar-review'), 'a class rendered without a rule shows as a bare rectangle');
    // The session's surfaces belong to the flow controller: this view may hand
    // it an element, but must not know the shape of what goes inside.
    assert.ok(!/sf-strip/.test(view), 'the sidebar view must not name the session\'s bar');
    assert.ok(!/sf-dock/.test(view), 'the sidebar view must not name the dock');
    assert.ok(!/sf-host-/.test(view), 'the host marker is the controller\'s to set');
});

// ----------------------------------------------------------------------------
// The run moves, the list follows. A step of the run re-renders the bar, not
// the sidebar — so the pane asks the run where it is on a slow tick and
// repaints only when the answer changed. The deck case is why this exists: the
// flow controller's own walk marks note rows, and knows nothing of the deck row
// a deck step stands on.
// ----------------------------------------------------------------------------

test('the tick repaints the list when the run moves — onto a note, and onto a deck', async () => {
    const h = makeHarness('list', { active: true });
    h.setRun({ active: true, onCards: false, path: 'notes/a.md' });
    await h.view.refresh();

    const view = h.follow();
    view.stopRunFollow(); // the tick is driven by hand here; a live timer would race the assertions
    const painted = h.refreshes();

    view.followRun();
    await h.settle();
    assert.equal(h.refreshes(), painted, 'a tick with nothing moved paints nothing');

    h.setRun({ active: true, onCards: false, path: 'notes/b.md' });
    view.followRun();
    await h.settle();
    assert.equal(h.refreshes(), painted + 1, 'the next note repaints the list');

    // The deck step: `currentPath()` is null there by design, and the deck the
    // sitting is on is the position the list has to pin.
    h.setRun({ active: true, onCards: true, path: null });
    h.setSittingDeck('spaceforge/decks/Biology.md');
    view.followRun();
    await h.settle();
    assert.equal(view.lastRunSignature, 'cards:spaceforge/decks/Biology.md', 'a deck step is followed by its deck');
    assert.equal(h.refreshes(), painted + 2, 'and the deck step repaints the list — the case the walk misses');
});

test('a deck step is repainted again when the sitting finally names its deck', async () => {
    const h = makeHarness('list', { active: true });
    h.setRun({ active: true, onCards: false, path: 'notes/a.md' });
    await h.view.refresh();
    const view = h.follow();
    view.stopRunFollow();
    const painted = h.refreshes();

    // Onto the deck step before the sitting has said which deck it is: the
    // position is real, the deck is not named yet.
    h.setRun({ active: true, onCards: true, path: null });
    view.followRun();
    await h.settle();
    assert.equal(h.refreshes(), painted + 1, 'the step itself repaints the list');
    assert.equal(view.lastRunSignature, 'cards:', 'with no deck to name yet');

    h.setSittingDeck('spaceforge/decks/Biology.md');
    view.followRun();
    await h.settle();
    assert.equal(h.refreshes(), painted + 2, 'and the deck landing repaints it again');
});

test('the follow repaints only while a run walks and the list is the pane', async () => {
    const h = makeHarness('list', { active: true });
    h.setRun({ active: true, onCards: false, path: 'notes/a.md' });
    await h.view.refresh();
    assert.notEqual(h.follow().runFollowTimer, null, 'the tick lives as long as the view does');

    const view = h.follow();
    view.stopRunFollow(); // the tick is driven by hand here
    const painted = h.refreshes();

    // No run walking: a tick paints nothing.
    h.setRun({ active: false, onCards: false, path: null });
    view.followRun();
    await h.settle();
    assert.equal(h.refreshes(), painted, 'no run, nothing to follow');

    // A run walking is followed only while the list is the pane on screen.
    h.setRun({ active: true, onCards: false, path: 'notes/a.md' });
    h.settings.sidebarViewType = 'calendar';
    view.followRun();
    await h.settle();
    assert.equal(h.refreshes(), painted, 'the calendar is not the list: no repaint for it');

    // Back on the list, the position the list was not showing reads as news.
    h.settings.sidebarViewType = 'list';
    view.followRun();
    await h.settle();
    assert.equal(h.refreshes(), painted + 1, 'the list repaints for the run it missed');
});

test('closing the pane takes the follow tick down with it', async () => {
    const h = makeHarness('list', { active: true });
    h.setRun({ active: true, onCards: false, path: 'notes/a.md' });
    await h.view.refresh();
    assert.notEqual(h.follow().runFollowTimer, null);

    await h.view.onClose();

    assert.equal(h.follow().runFollowTimer, null, 'the tick never outlives the pane');
});

/** The rule body for a selector, so a property can be asserted where it lands. */
function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at) + 1);
}