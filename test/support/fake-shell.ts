/**
 * A fake Obsidian shell around the real plugin code.
 *
 * It wires the *actual* ReviewController facade, ReviewFlowController and
 * ReviewScheduleService to stand-ins for the app, workspace, vault and DOM, so
 * a whole review run can be driven in Node: grades recorded, notes opened, the
 * bar re-rendered, keys dispatched. Only the Obsidian surface is faked — the
 * scheduling, flow and undo logic under test is the shipped code.
 */
import { TFile, notices } from './obsidian-shim';
import { MiniElement } from './mini-dom';
import { DateUtils } from '../../utils/dates';
import { DEFAULT_SETTINGS, SpaceforgeSettings } from '../../models/settings';
import { ReviewSchedule } from '../../models/review-schedule';
import { ReviewScheduleService } from '../../services/review-schedule-service';
import { ReviewController } from '../../controllers/review-controller';
import { ReviewFlowController } from '../../controllers/review-flow-controller';
import { ReviewNavigationController } from '../../controllers/review-navigation-controller';
import { MCQService } from '../../services/mcq-service';

export interface FakeKeyEvent {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    target: EventTarget | null;
    defaultPrevented: boolean;
    /** Set by stopImmediatePropagation: the event stops here. */
    immediateStopped: boolean;
    preventDefault(): void;
    stopPropagation(): void;
    stopImmediatePropagation(): void;
}

/** Minimal document: records keydown listeners and lets tests press keys. */
class FakeDocument {
    listeners: ((event: FakeKeyEvent) => void)[] = [];
    overlayOpen = false;
    /** The last event dispatched, for tests that need more than "claimed". */
    lastEvent: FakeKeyEvent | null = null;
    body = {
        querySelector: (selector: string): MiniElement | null => {
            if (!this.overlayOpen) return null;
            return /modal-container|\.menu|suggestion-container/.test(selector) ? new MiniElement('div') : null;
        },
    };

    addEventListener(type: string, handler: (event: FakeKeyEvent) => void): void {
        if (type === 'keydown') this.listeners.push(handler);
    }

    removeEventListener(type: string, handler: (event: FakeKeyEvent) => void): void {
        if (type === 'keydown') this.listeners = this.listeners.filter(entry => entry !== handler);
    }

    /** Dispatch a keydown; returns true when the plugin handled (prevented) it. */
    press(key: string, options: Partial<FakeKeyEvent> = {}): boolean {
        const event: FakeKeyEvent = {
            key,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            repeat: false,
            target: null,
            defaultPrevented: false,
            immediateStopped: false,
            preventDefault() { event.defaultPrevented = true; },
            stopPropagation() { /* no-op */ },
            stopImmediatePropagation() { event.immediateStopped = true; },
            ...options,
        };
        this.lastEvent = event;
        for (const listener of [...this.listeners]) listener(event);
        return event.defaultPrevented;
    }
}

export interface FakeLeaf {
    viewState: Record<string, unknown> | null;
    setViewState: (state: Record<string, unknown>) => Promise<void>;
    view: { containerEl: MiniElement; contentEl: MiniElement };
    openFile(file: TFile): Promise<void>;
}

export interface NoteSpec {
    path: string;
    schedule?: Partial<ReviewSchedule>;
    /** Days until due; 0 (default) means due today, negative means overdue. */
    dueInDays?: number;
}

export class FakeShell {
    settings: SpaceforgeSettings;
    service: ReviewScheduleService;
    reviewController: ReviewController;
    navigationController: ReviewNavigationController;
    flow: ReviewFlowController;
    document = new FakeDocument();
    opened: string[] = [];
    saves = 0;
    workspaceEvents: Record<string, ((...args: unknown[]) => void)[]> = {};
    leaf: FakeLeaf;
    /** A leaf in its own window, handed out by openPopoutLeaf(). */
    popoutLeaf: FakeLeaf;
    popoutOpens = 0;
    files = new Map<string, TFile>();
    /** When set, the plugin behaves as if a hierarchical review session is active. */
    activeSession: { nextFile: string | null } | null = null;

    private plugin: Record<string, unknown>;

    constructor(overrides: Partial<SpaceforgeSettings> = {}) {
        this.settings = { ...DEFAULT_SETTINGS, ...overrides };
        notices.length = 0;

        // DOM globals the controllers reach for.
        const globals = globalThis as Record<string, unknown>;
        globals.document = this.document;
        globals.HTMLElement = MiniElement;
        // The dock's resize handle binds on the window; Node has no window, and
        // a teardown that removes those listeners must not die on the way out.
        globals.addEventListener ??= () => undefined;
        globals.removeEventListener ??= () => undefined;

        this.leaf = this.createLeaf();
        this.popoutLeaf = this.createLeaf();
        this.plugin = this.buildPlugin();

        this.service = new ReviewScheduleService(
            this.plugin as never,
            {},
            [],
            null,
            []
        );
        this.wireService();

        this.reviewController = new ReviewController(this.plugin as never, {} as MCQService);
        this.plugin.reviewController = this.reviewController;

        this.navigationController = new ReviewNavigationController(this.plugin as never);
        this.plugin.navigationController = this.navigationController;

        this.flow = new ReviewFlowController(this.plugin as never);
        this.plugin.reviewFlowController = this.flow;
    }

    /** The plugin object the controllers were built with, for direct calls in tests. */
    get pluginRef(): Record<string, unknown> {
        return this.plugin;
    }

    private buildPlugin(): Record<string, unknown> {
        const shell = this;
        return {
            settings: this.settings,
            events: { emit: () => undefined },
            registerEvent: () => undefined,
            getSidebarView: () => null,
            savePluginData: async () => { shell.saves += 1; },
            mcqController: undefined,
            mcqGenerationService: undefined,
            initializeMCQComponents: () => undefined,
            reviewSessionService: { getActiveSession: () => null },
            reviewSessions: { getAllSessions: () => [] },
            app: {
                vault: {
                    getAbstractFileByPath: (path: string) => shell.files.get(path) ?? null,
                    adapter: {},
                },
                workspace: {
                    on: (event: string, handler: (...args: unknown[]) => void) => {
                        shell.workspaceEvents[event] = [...(shell.workspaceEvents[event] ?? []), handler];
                        return { event };
                    },
                    getLeaf: () => shell.leaf,
                    revealLeaf: async () => undefined,
                    openPopoutLeaf: () => {
                        shell.popoutOpens += 1;
                        return shell.popoutLeaf;
                    },
                    getActiveFile: () => null,
                    getLeavesOfType: () => [],
                    getMostRecentLeaf: () => shell.leaf,
                    setActiveLeaf: () => undefined,
                },
            },
            // The deck lane: what the sidebar last counted, and the fresh-enough
            // rule the real plugin keeps (main.ts).
            deckDueCount: null,
            deckDueCountedAt: 0,
            deckDueDecks: [] as string[],
            deckSessionController: { isActive: () => false, startAllDue: async () => undefined },
            knownDeckDueDecks() {
                return (this.deckDueDecks as string[]) ?? [];
            },
            freshDeckDue(maxAgeMs = 60_000) {
                const count = this.deckDueCount as number | null;
                if (count === null) return 0;
                return Date.now() - (this.deckDueCountedAt as number) < maxAgeMs ? count : 0;
            },
            dataStorage: {
                reviewScheduleService: undefined as unknown,
                getActiveSession: () => (shell.activeSession ? { id: 'fake-session' } : null),
                advanceActiveSession: async () => undefined,
                getNextSessionFile: () => shell.activeSession?.nextFile ?? null,
                estimateReviewTime: async () => 30,
            },
        };
    }

    /** Point the plugin's data surfaces at the real service. */
    private wireService(): void {
        (this.plugin.dataStorage as Record<string, unknown>).reviewScheduleService = this.service;
        this.plugin.reviewScheduleService = this.service;
        this.plugin.reviewHistoryService = { history: this.service.history };
    }

    private createLeaf(): FakeLeaf {
        const containerEl = new MiniElement('div');
        containerEl.addClass('workspace-leaf-content');
        const contentEl = new MiniElement('div');
        contentEl.addClass('view-content');
        contentEl.parent = containerEl;
        containerEl.children.push(contentEl);

        const leaf: FakeLeaf = {
            view: { containerEl, contentEl },
            viewState: null,
            // A session window asks its leaf for a view; the fake records which.
            setViewState: async (state) => {
                leaf.viewState = state;
            },
            openFile: async (file: TFile) => {
                this.opened.push(file.path);
            },
        };
        return leaf;
    }

    // --- Fixtures ---

    /** Add a note file plus an SM-2 schedule due today (unless told otherwise). */
    addNote(spec: NoteSpec): ReviewSchedule {
        const file = new TFile();
        file.path = spec.path;
        file.basename = spec.path.replace(/\.md$/, '').split('/').pop() ?? spec.path;
        this.files.set(spec.path, file);

        const dueOffset = spec.dueInDays ?? 0;
        const schedule: ReviewSchedule = {
            path: spec.path,
            lastReviewDate: DateUtils.addDays(Date.now(), dueOffset - 7),
            nextReviewDate: DateUtils.addDays(DateUtils.startOfUTCDay(new Date()), dueOffset),
            ease: 250,
            interval: 6,
            consecutive: 2,
            reviewCount: 3,
            repetitionCount: 3,
            scheduleCategory: 'spaced',
            schedulingAlgorithm: 'sm2',
            ...spec.schedule,
        };
        this.service.schedules[spec.path] = schedule;
        return schedule;
    }

    removeFile(path: string): void {
        this.files.delete(path);
    }

    /** Close the pane the run is using; the next getLeaf() hands out a new one. */
    closeLeaf(): void {
        this.leaf.view.containerEl.isConnected = false;
        this.leaf = this.createLeaf();
    }

    /**
     * Pretend a hierarchical review session is running. Pass `active = false` to
     * stop one; an active session with no next file is one that has run dry.
     */
    setActiveSession(nextFile: string | null, active = true): void {
        this.activeSession = active ? { nextFile } : null;
    }

    // --- Observations ---

    duePaths(): string[] {
        return this.reviewController.getTodayNotes().map(note => note.path);
    }

    /**
     * The review bar, wherever the session put it: the note's pane when the
     * placement is a split, a window of its own when it is not.
     */
    strip(): MiniElement | null {
        return this.leaf.view.containerEl.byClass('sf-strip')[0]
            ?? this.popoutLeaf.view.containerEl.byClass('sf-strip')[0]
            ?? null;
    }

    stripText(): string {
        const strip = this.strip();
        if (!strip) return '';
        return strip.findAll(() => true).map(element => element.text).join(' ');
    }

    stripTitle(): string {
        const strip = this.strip();
        return strip ? strip.textOf('sf-strip-title') : '';
    }

    gradeButtons(): MiniElement[] {
        const strip = this.strip();
        return strip ? strip.byClass('sf-strip-grade') : [];
    }

    gradeLabels(): string[] {
        const strip = this.strip();
        return strip ? strip.byClass('sf-strip-grade-label').map(element => element.text) : [];
    }

    /** Press the grade button carrying a given label, as a user click would. */
    clickGrade(label: string): void {
        const button = this.gradeButtons().find(candidate => candidate.textOf('sf-strip-grade-label') === label);
        if (!button) throw new Error(`No grade button labelled "${label}"`);
        button.click();
    }

    fireLayoutChange(): void {
        for (const handler of this.workspaceEvents['layout-change'] ?? []) handler();
    }

    /**
     * Let the controllers' async chains (open a note, mount the bar, render,
     * persist) finish before a test inspects the result.
     */
    async settle(): Promise<void> {
        for (let i = 0; i < 3; i++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    keydownListenerCount(): number {
        return this.document.listeners.length;
    }

    takeNotices(): string[] {
        const collected = [...notices];
        notices.length = 0;
        return collected;
    }
}
