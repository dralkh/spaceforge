import { Notice, Plugin, TFile, normalizePath, TFolder } from 'obsidian';
import { EventEmitter } from './utils/event-emitter';
import { DataStorage } from './data-storage';
import { ReviewController } from './controllers/review-controller';
import { ReviewFlowController } from './controllers/review-flow-controller';
import { ReviewNavigationController } from './controllers/review-navigation-controller';
import { ReviewSessionController } from './controllers/review-session-controller';
import { ReviewBatchController } from './controllers/review-batch-controller';
import { MCQController } from './controllers/review-controller-mcq';
import { ContextMenuHandler } from './ui/context-menu';
import { ReviewSidebarView } from './ui/sidebar-view';
import { REVIEW_WINDOW_VIEW, ReviewWindowView } from './ui/review-window-view';
import { STATS_VIEW, StatsView } from './ui/stats-view';
import { SpaceforgeSettingTab } from './ui/settings-tab';
import { DEFAULT_SETTINGS, SpaceforgeSettings, ApiProvider, migrateSettings } from './models/settings';
import { GradeBucket } from './models/review-flow';
import { SpaceforgePluginData, PluginStateData, DEFAULT_APP_DATA, DEFAULT_PLUGIN_STATE_DATA } from './models/plugin-data';
import {
    collectRecoverableCandidates,
    corruptBackupPath,
    dataFileName,
    goodCopyPath,
    mergePluginStates,
    parsePluginData,
    readTextOrNull,
    schedulesOf,
    writeJsonAtomically,
    type DataFileCandidate,
} from './utils/data-file';
import { DataRecoveryModal } from './ui/data-recovery-modal';
import { EstimationUtils } from './utils/estimation';
import { OpenRouterService } from './api/openrouter-service';
import { OpenAIService } from './api/openai-service';
import { OllamaService } from './api/ollama-service';
import { GeminiService } from './api/gemini-service';
import { ClaudeService } from './api/claude-service';
import { TogetherService } from './api/together-service';
import { OpenAICompatibleService } from './api/openai-compatible-service';
import { OpenAIHttpService } from './api/openai-http-service';
import { CliService } from './api/cli-service';
import { agentIdOfProvider, describeProviderGap, getHttpProvider, providerIsOpenAiShaped } from './api/provider-registry';
import { getCliAgent } from './api/cli/cli-agents';
import { setCliExtraPath } from './api/cli/cli-runner';
import { IMCQGenerationService } from './api/mcq-generation-service';
import { ReviewScheduleService } from './services/review-schedule-service';
import { ReviewHistoryService } from './services/review-history-service';
import { StatsService } from './services/stats-service';
import { ReviewSessionService } from './services/review-session-service';
import { MCQService } from './services/mcq-service';
import { PomodoroService } from './services/pomodoro-service';
import { CalendarEventService } from './services/calendar-event-service';
import { RecurringNotesService } from './services/recurring-notes-service';
import { StudyPlanService } from './services/study-plan-service';
import { DeckStore } from './services/deck-store';
import { DeckService } from './services/deck-service';
import { AnkiWebService, AnkiWebDeckResult } from './services/ankiweb-service';
import { AnkiWebSearchModal } from './ui/ankiweb-search-modal';
import { pickFile } from './ui/file-picker';
import { pickDeckPath, pickStudyTarget } from './ui/deck-picker-modal';
import { isDeckPath } from './models/anki';
import { DeckSessionController } from './controllers/deck-session-controller';
import { StudyVisualService } from './services/study-visuals-service';
import { StudyWebSearchService } from './services/study-web-search-service';
import { StudyController } from './controllers/study-controller';
import { StudyChartQueueService } from './services/study-chart-queue-service';

/**
 * Spaceforge: Spaced Repetition Plugin for Obsidian
 */
export interface SpaceforgeEvents {
    'sidebar-update': [];
    'pomodoro-update': [];
}

export default class SpaceforgePlugin extends Plugin {

    private studyVisualServiceInstance: StudyVisualService | null = null;

    /** One visual service per plugin, so two panels never generate twice. */
    get studyVisualService(): StudyVisualService {
        this.studyVisualServiceInstance ??= new StudyVisualService(this);
        return this.studyVisualServiceInstance;
    }
    settings: SpaceforgeSettings;
    pluginState: PluginStateData;
    dataStorage: DataStorage;
    reviewScheduleService: ReviewScheduleService;
    reviewHistoryService: ReviewHistoryService;
    /** Progress statistics: permanent day counters and the deck review log. */
    statsService: StatsService;
    reviewSessionService: ReviewSessionService;
    mcqService: MCQService;
    pomodoroService: PomodoroService;
    calendarEventService: CalendarEventService;
    recurringNotesService: RecurringNotesService;
    studyPlanService: StudyPlanService;
    /** The deck lane: cards, their own schedule, Anki's rules. */
    deckStore: DeckStore;
    /** Cards due across every deck, as last counted; null until something counts. */
    deckDueCount: number | null = null;
    /** The decks holding due cards, in the order the sidebar lists them. */
    deckDueDecks: string[] = [];
    deckDueCountedAt = 0;

    /**
     * What the decks owe, when that number can be trusted.
     *
     * The count is worked out by the sidebar, which is the only place that reads
     * every deck. It goes stale the moment a card is answered anywhere else, so
     * a caller that wants to print it gets it only while it is fresh — a number
     * that might be an hour old would be worse than no number.
     */
    freshDeckDue(maxAgeMs = 60_000): number {
        if (this.deckDueCount === null) return 0;
        return Date.now() - this.deckDueCountedAt < maxAgeMs ? this.deckDueCount : 0;
    }

    /** The decks behind that count, fresh or as last read. */
    knownDeckDueDecks(): string[] {
        return this.deckDueDecks ?? [];
    }
    deckSessionController: DeckSessionController;
    /** Packages in and out: .apkg files, however they arrive. */
    deckService: DeckService;
    ankiWebService: AnkiWebService;
    studyWebSearchService: StudyWebSearchService;
    studyController: StudyController;
    studyChartQueue: StudyChartQueueService;


    private beforeUnloadHandler: (event: Event) => void; // Declared as a class property
    /** The save that is currently writing, and whether state changed while it ran. */
    private saveInFlight: Promise<void> | null = null;
    private saveDirty = false;

    reviewController: ReviewController;
    navigationController: ReviewNavigationController;
    sessionController: ReviewSessionController;
    batchController: ReviewBatchController;
    reviewFlowController: ReviewFlowController;
    mcqController: MCQController | undefined;
    mcqGenerationService: IMCQGenerationService | undefined; // Changed from openRouterService
    contextMenuHandler: ContextMenuHandler;
    // sidebarView: ReviewSidebarView; // Avoid storing direct references to views
    public clickedDateFromCalendar: Date | null = null;
    events: EventEmitter<SpaceforgeEvents>;

    async onload(): Promise<void> {
        this.events = new EventEmitter<SpaceforgeEvents>();

        // Initialize settings with defaults FIRST
        this.settings = { ...DEFAULT_SETTINGS };
        // Initialize pluginState with defaults
        this.pluginState = { ...DEFAULT_PLUGIN_STATE_DATA };


        // Now services can be initialized, they will use the default settings initially
        this.reviewScheduleService = new ReviewScheduleService(
            this,
            this.pluginState.schedules,
            this.pluginState.customNoteOrder,
            this.pluginState.lastLinkAnalysisTimestamp ?? null, // Coalesce undefined to null
            this.pluginState.history
        );
        this.reviewHistoryService = new ReviewHistoryService(this.pluginState.history);
        this.statsService = new StatsService(this, this.pluginState.reviewDayStats, this.pluginState.deckHistory);
        this.reviewSessionService = new ReviewSessionService(this, this.pluginState.reviewSessions);
        this.mcqService = new MCQService(this.pluginState.mcqSets, this.pluginState.mcqSessions);
        this.studyPlanService = new StudyPlanService(
            this,
            this.pluginState.studyPlans,
            this.pluginState.studyProgress,
            this.pluginState.studySessions
        );

        // The deck lane. A deck keeps its cards and their schedule in its own
        // file under spaceforge/decks/, so this store needs no plugin state.
        this.deckStore = new DeckStore(this);
        this.deckSessionController = new DeckSessionController(this, this.deckStore);
        this.deckService = new DeckService(this, this.deckStore);
        this.ankiWebService = new AnkiWebService();

        // Load stored data, which will override the defaults in this.settings and this.pluginState
        await this.loadPluginData();

        // After settings are fully loaded (including from storage), ensure services are updated
        // This is crucial for FsrsScheduleService to get the correct FSRS parameters.
        this.reviewScheduleService.updateAlgorithmServicesForSettingsChange();

        // Initialize PomodoroService after settings are loaded
        this.pomodoroService = new PomodoroService(this);

        // Initialize CalendarEventService after settings are loaded
        this.calendarEventService = new CalendarEventService();
        const eventsArray = Object.values(this.pluginState.calendarEvents);
        this.calendarEventService.initialize(eventsArray);

        // Initialize RecurringNotesService after settings are loaded
        this.recurringNotesService = new RecurringNotesService(this);

        // Study needs loaded settings (provider, search backend, limits)
        this.studyWebSearchService = new StudyWebSearchService(this);
        this.studyController = new StudyController(this, this.studyPlanService, this.studyWebSearchService);

        // Background charting: the queue is re-derived from the review schedule,
        // so it needs no persistence and cannot drift from the vault.
        this.studyChartQueue = new StudyChartQueueService(this, this.studyPlanService);
        this.studyController.attachToChartQueue();
        this.setupStudyCharting();

        // The auto-pilot: a note whose chart just became ready is finished in
        // the background — its study material, then its questions — when the
        // reader asked for that (both off by default). One subscription, at the
        // plan service's own "ready" announcement, so it holds for a chart the
        // background queue ran and one the reader started by hand alike.
        this.studyPlanService.subscribePlanReady(plan => {
            void this.studyChartQueue.notifyPlanReady(plan.notePath);
        });




        this.registerView(
            'spaceforge-review-schedule',
            (leaf) => new ReviewSidebarView(leaf, this)
        );

        // A window of the session's own: closing it hands the session back.
        this.registerView(
            REVIEW_WINDOW_VIEW,
            (leaf) => new ReviewWindowView(leaf, () => this.reviewFlowController?.handleSessionWindowClosed())
        );

        // Progress statistics, in a leaf of its own so it can use the width a
        // grid of charts needs.
        this.registerView(
            STATS_VIEW,
            (leaf) => new StatsView(leaf, this)
        );

        this.dataStorage = new DataStorage(
            this,
            this.reviewScheduleService,
            this.reviewHistoryService,
            this.reviewSessionService,
            this.mcqService
        );

        this.reviewController = new ReviewController(this, this.mcqService);
        this.navigationController = new ReviewNavigationController(this);
        this.sessionController = new ReviewSessionController(this);
        this.batchController = new ReviewBatchController(this);
        this.reviewFlowController = new ReviewFlowController(this);
        // A sitting that was live when the app last closed comes back where it
        // stopped — the reader's place in the queue is theirs, not the
        // session's. Registered *here*, after the controller exists: a
        // layout-ready callback registered earlier would fire before there is
        // anything to resume into, and the resume would be silently skipped.
        this.app.workspace.onLayoutReady(() => {
            this.reviewFlowController?.resumeSavedRunIfAny();
        });
        this.contextMenuHandler = new ContextMenuHandler(this);

        this.initializeMCQComponents(); // This will now use mcqGenerationService

        EstimationUtils.setPlugin(this);
        this.addIcons();
        this.contextMenuHandler.register();
        this.addRibbonIcon('calendar-clock', 'Spaceforge review', async () => {
            await this.activateSidebarView();
        });
        this.addSettingTab(new SpaceforgeSettingTab(this.app, this));
        this.addCommands();

        this.addCommand({
            id: 'add-selected-file-to-review',
            name: 'Add selected file to review schedule (file explorer)',
            // Only offered when the file explorer has a note selected, so the
            // palette never shows a command whose only outcome is a refusal.
            checkCallback: (checking) => {
                const selected = this.selectedExplorerFile();
                if (!selected) return false;
                if (checking) return true;
                void (async () => {
                    this.reviewScheduleService.scheduleNoteForReview(selected.path);
                    await this.savePluginData();
                    new Notice(`Added "${selected.path}" to review schedule.`);
                })();
                return true;
            }
        });

        this.registerEvent(this.app.workspace.on('file-open', (_file) => { /* ... */ }));
        this.registerEvent(this.app.vault.on('delete', async (file) => {
            if (file instanceof TFile && file.extension === "md") {
                this.reviewScheduleService.removeFromReview(file.path);
                await this.savePluginData();
            }
            void this.getSidebarView()?.refresh();
        }));
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (file instanceof TFile && file.extension === "md") {
                this.reviewScheduleService.handleNoteRename(oldPath, file.path);
                await this.savePluginData();
            }
            void this.getSidebarView()?.refresh();
        }));

        this.registerInterval(window.setInterval(() => {
            void this.getSidebarView()?.refresh();
        }, 60 * 1000));

        // A reload kills the renderer without waiting for pending writes. The save is
        // atomic, so the worst case is losing the last moment of work rather than the
        // whole file, and this gives that moment a chance to land.
        this.registerDomEvent(window, 'pagehide', () => { void this.savePluginData(); });

        // Styles come from the styles.css Obsidian loads for the plugin; there is
        // no manual stylesheet or filesystem watcher to keep alive here.

        if (this.settings.notifyBeforeDue > 0) {
            this.registerInterval(window.setInterval(() => this.checkForDueNotes(), 5 * 60 * 1000));
        }

        this.registerInterval(window.setInterval(() => {
            void (async () => {
                await this.savePluginData();
                // Removed specific openRouterApiKey backup from here, handled by general settings save.
            })();
        }, 5 * 60 * 1000));

        this.beforeUnloadHandler = (_event) => {
            const existingData = {};
            // Removed sync loadData call which returns a Promise and cannot be awaited here.

            try {
                const reviewData = {
                    schedules: this.reviewScheduleService.schedules,
                    history: this.reviewHistoryService.history,
                    reviewSessions: this.reviewSessionService.reviewSessions,
                    mcqSets: this.mcqService.mcqSets,
                    mcqSessions: this.mcqService.mcqSessions,
                    studyPlans: this.studyPlanService.plans,
                    studyProgress: this.studyPlanService.progress,
                    studySessions: this.studyPlanService.sessions,
                    customNoteOrder: this.reviewScheduleService.customNoteOrder,
                    lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp,
                    version: this.manifest.version
                };
                const combinedData = { ...existingData, reviewData };
                const backupStr = JSON.stringify(combinedData);
                this.app.saveLocalStorage('spaceforge-backup', backupStr);
                void (async () => {
                    try {
                        await this.savePluginData();
                    } catch { /* handle error */ }
                })();
            } catch {
                try {
                    const minimalBackup = JSON.stringify({ settings: this.settings, reviewData: { schedules: this.reviewScheduleService.schedules || {}, customNoteOrder: this.reviewScheduleService.customNoteOrder || [], lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp, version: this.manifest.version } });
                    this.app.saveLocalStorage('spaceforge-minimal-backup', minimalBackup);
                } catch { /* handle error */ }
            }
        }; // Removed the extra closing parenthesis and semicolon, and moved the declaration.
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }

    /**
     * Start the background charting loop.
     *
     * Charting waits for the workspace to be ready (it reads notes) and then
     * works through the schedule a few sections at a time. Nothing here blocks
     * the UI: the queue publishes progress and the sidebar shows it.
     */
    private setupStudyCharting(): void {
        const queue = this.studyChartQueue;
        this.registerInterval(window.setInterval(() => {
            void queue.tick();
        }, 45 * 1000));

        this.app.workspace.onLayoutReady(() => {
            const queued = queue.syncFromSchedules(Object.keys(this.reviewScheduleService.schedules));
            if (queued > 0) {
                window.setTimeout(() => { void queue.tick(); }, 10 * 1000);
            }
        });

        // Keep the sidebar honest about what the background is doing, without
        // refreshing it on every section the queue finishes.
        let lastRefresh = 0;
        queue.subscribe(status => {
            const now = Date.now();
            if (now - lastRefresh < 1500) return;
            lastRefresh = now;
            void this.getSidebarView()?.refresh();
            void status;
        });
    }

    /** Queue every scheduled note that still needs charting (command palette). */
    chartAllScheduledNotes(): number {
        const queue = this.studyChartQueue;
        queue.resume();
        const count = queue.syncFromSchedules(Object.keys(this.reviewScheduleService.schedules));
        new Notice(count > 0 ? `Study: charting ${count} note(s) in the background.` : 'Study: nothing left to chart.');
        void queue.drain(200);
        return count;
    }

    /**
     * Obsidian calls onunload synchronously and does not wait for it, so the save
     * below is an awaited async block rather than a floating promise chain: the
     * teardown is immediate, the write finishes on its own, and a failure is
     * reported where it can be seen.
     */
    onunload(): void {
        // The review bar and the dock are ours; without this they outlive the
        // plugin and the next enable puts a second copy beside the first.
        this.reviewFlowController?.dispose();

        // Explicitly remove the global event listener
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
        }

        void (async () => {
            let existingData: Partial<SpaceforgePluginData> = {};
            try {
                const loaded = await this.loadData() as Partial<SpaceforgePluginData> | null;
                if (loaded) existingData = loaded;
            } catch {
                // Unreadable or absent: start from what is already in memory.
            }

            try {
                const reviewData = {
                    schedules: this.reviewScheduleService.schedules,
                    history: this.reviewHistoryService.history,
                    reviewSessions: this.reviewSessionService.reviewSessions,
                    mcqSets: this.mcqService.mcqSets,
                    mcqSessions: this.mcqService.mcqSessions,
                    studyPlans: this.studyPlanService.plans,
                    studyProgress: this.studyPlanService.progress,
                    studySessions: this.studyPlanService.sessions,
                    customNoteOrder: this.reviewScheduleService.customNoteOrder,
                    lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp,
                    version: this.manifest.version
                };
                const combinedData = { ...existingData, reviewData };
                this.app.saveLocalStorage('spaceforge-backup', JSON.stringify(combinedData));
            } catch { /* the plugin data file is the real store; this is a safety copy */ }

            try {
                await this.savePluginData();
            } catch (e) {
                console.error('[spaceforge] could not save data on unload:', e);
            }
        })();

        if (this.pomodoroService) this.pomodoroService.destroy();
        this.studyChartQueue?.stop();
        if (this.reviewFlowController) this.reviewFlowController.dispose();
        this.deckSessionController?.destroy();
    }

    /**
     * Study a deck: the one that is open when a deck is open, the only deck when
     * there is only one, and a keyboard-first list otherwise.
     */
    /** 'Study a deck', also reachable from the sidebar session menu. */
    async chooseDeckToStudy(): Promise<void> {
        const active = this.activeMarkdownFile();
        if (active && isDeckPath(active.path)) {
            await this.deckSessionController.start(active.path);
            return;
        }

        const decks = await this.deckStore.listDecks();
        if (decks.length === 0) {
            new Notice('No decks yet. Import an Anki package, or write one in the decks folder.');
            return;
        }
        if (decks.length === 1) {
            await this.deckSessionController.start(decks[0].path);
            return;
        }

        const target = await pickStudyTarget(this.app, decks);
        if (!target) return;
        if (target.kind === 'everything') await this.deckSessionController.startAllDue();
        else await this.deckSessionController.start(target.path);
    }

    /**
     * Import a package the reader picked from their disk.
     *
     * The bytes go straight to the importer: an .apkg is read where it lies, its
     * media land in the deck's own media folder, and the deck becomes an
     * ordinary deck document that can be studied, edited and exported again.
     */
    async importAnkiPackage(): Promise<void> {
        const picked = await pickFile({ accept: '.apkg,.colpkg,.anki2,application/zip', hint: 'Anki package' });
        if (!picked) return;

        try {
            // The deck names itself: a package carries its own deck name, and the
            // file it arrived in is only a fallback (with its .apkg clipped off,
            // so the deck is not named after the container it came in).
            const fallback = picked.name.replace(/\.(apkg|colpkg|anki2)$/i, '');
            const name = await this.deckService.suggestImportName(picked.bytes, fallback);
            const report = await this.deckService.importApkg(picked.bytes, { name });
            new Notice(this.deckService.summarizeImport(report));
            for (const warning of report.warnings.slice(0, 2)) new Notice(warning);
            if (report.deckPath) this.deckSessionController.start(report.deckPath).catch(() => undefined);
        } catch (error) {
            console.error('spaceforge: could not import the package', error);
            new Notice('That file could not be read as an Anki package.');
        }
    }

    /** Export the deck that is open, or let the reader pick one. */
    private async exportDeck(): Promise<void> {
        const active = this.activeMarkdownFile();
        let path = active && isDeckPath(active.path) ? active.path : null;
        if (!path) {
            const decks = await this.deckStore.listDecks();
            if (decks.length === 0) {
                new Notice('No decks to export yet.');
                return;
            }
            path = await pickDeckPath(this.app, decks);
            if (!path) return;
        }

        try {
            const result = await this.deckService.exportDeck(path);
            const folder = result.report.path.split('/').slice(0, -1).join('/');
            if (folder.length > 0 && !this.app.vault.getAbstractFileByPath(folder)) {
                await this.app.vault.createFolder(folder).catch(() => undefined);
            }
            const existing = this.app.vault.getAbstractFileByPath(result.report.path);
            // A copied, tightly-sized buffer: `buffer.slice` loses its
            // ArrayBuffer type on newer TypeScript, and `SharedArrayBuffer`
            // must never reach the vault API.
            const bytes = new Uint8Array(result.bytes).buffer;
            if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, bytes);
            else await this.app.vault.createBinary(result.report.path, bytes);

            new Notice(`Exported ${result.report.cards} cards to ${result.report.path}.`);
            for (const warning of result.warnings.slice(0, 2)) new Notice(warning);
        } catch (error) {
            console.error('spaceforge: could not export the deck', error);
            new Notice('That deck could not be exported.');
        }
    }

    /**
     * Search AnkiWeb from inside the plugin.
     *
     * Searching needs a signed-in visitor and this plugin never holds anyone's
     * AnkiWeb session — so the honest shape is: try the search, and when AnkiWeb
     * asks for a session, say so and hand the reader their browser, where they
     * are already signed in. A deck that can be fetched is imported straight
     * away; a refused one still gives them the deck's page.
     */
    private openAnkiWebSearch(): void {
        new AnkiWebSearchModal(this.app, {
            searchDecks: query => this.ankiWebService.searchDecks(query),
            importDeck: async (deck: AnkiWebDeckResult) => {
                const info = await this.ankiWebService.fetchItemInfo(deck.id);
                const key = info.info?.deck?.downloadKey ?? null;
                const download = await this.ankiWebService.downloadDeck(deck.id, key);

                if (download.kind === 'needs-sign-in') {
                    return { kind: 'needs-sign-in', message: download.message };
                }
                if (download.kind !== 'apkg') {
                    return {
                        kind: 'refused',
                        message: download.kind === 'refused' ? download.message : 'AnkiWeb sent something that is not an Anki package.',
                    };
                }

                try {
                    const report = await this.deckService.importApkg(download.bytes, { name: deck.name });
                    return { kind: 'imported', message: this.deckService.summarizeImport(report) };
                } catch (error) {
                    console.error('spaceforge: could not import the downloaded deck', error);
                    return { kind: 'failed', message: 'The download arrived but could not be read as an Anki package.' };
                }
            },
        }).open();
    }

    private _getEffectiveDataPath(): string | null {
        if (this.settings?.useCustomDataPath) {
            const relativePath = this.settings.customDataPath?.trim(); // Get the path
            if (relativePath && relativePath !== '') { // Only proceed if path is non-empty
                let pathForJson = relativePath;
                // Assume customDataPath is a FOLDER, append /data.json
                if (!pathForJson.endsWith('/')) {
                    pathForJson += '/';
                }
                pathForJson += 'data.json';

                const vaultBasePath = this.app.vault.getRoot().path; // Usually an empty string for vault root
                let absolutePath = (vaultBasePath ? vaultBasePath + '/' : '') + pathForJson;
                absolutePath = normalizePath(absolutePath);
                return absolutePath;
            } else {
                // useCustomDataPath is true, but customDataPath is empty.
                // Silently fall back to default plugin storage without a warning.
                return null;
            }
        }
        return null; // useCustomDataPath is false, use default plugin storage
    }

    /**
     * Point the services at the loaded state.
     *
     * The history array is deliberately shared: the scheduler appends to its own
     * reference while savePluginData() serialises the history service's, so a
     * mismatch silently drops every recorded review.
     */
    private applyLoadedState(): void {
        this.reviewScheduleService.schedules = this.pluginState.schedules || {};
        const sharedHistory = this.pluginState.history || [];
        this.pluginState.history = sharedHistory;
        this.reviewHistoryService.history = sharedHistory;
        this.reviewScheduleService.history = sharedHistory;
        this.reviewSessionService.reviewSessions = this.pluginState.reviewSessions || { sessions: {}, activeSessionId: null };
        this.mcqService.mcqSets = this.pluginState.mcqSets || {};
        this.mcqService.mcqSessions = this.pluginState.mcqSessions || {};
        this.studyPlanService.plans = this.pluginState.studyPlans || {};
        this.studyPlanService.progress = this.pluginState.studyProgress || {};
        this.studyPlanService.sessions = this.pluginState.studySessions || {};
        this.reviewScheduleService.customNoteOrder = this.pluginState.customNoteOrder || [];
        this.reviewScheduleService.lastLinkAnalysisTimestamp = typeof this.pluginState.lastLinkAnalysisTimestamp === 'number' ? this.pluginState.lastLinkAnalysisTimestamp : null;
        // The statistics counters live across the whole file's lifetime; this
        // also seeds them from the review log the first time a file that
        // predates them is loaded.
        this.statsService.applyLoadedState(this.pluginState);
        this.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
    }

    /** Where the data file for this vault lives. */
    private dataFilePath(): string {
        return this._getEffectiveDataPath() ?? (this.app.vault.configDir + `/plugins/${this.manifest.id}/data.json`);
    }

    /** The folder holding the data file, where its backups live too. */
    private dataDirectory(): string {
        const path = this.dataFilePath();
        const cut = path.lastIndexOf('/');
        return cut > 0 ? path.substring(0, cut) : path;
    }

    private async fileMtime(path: string): Promise<number> {
        try {
            const stat = await this.app.vault.adapter.stat?.(path);
            return stat?.mtime ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     * Read the data file, recovering from a copy when it cannot be read.
     *
     * A save interrupted by a reload or a quick restart used to leave a truncated
     * file; loading that as "no data" and then saving over it is how a library
     * disappears. Instead the unreadable file is kept, and the last-known-good copy,
     * the backups and any sync-conflicted copies are searched for the richest state.
     * Notes the current file already has are never overwritten by an older copy.
     */
    private async readDataFileWithRecovery(path: string): Promise<SpaceforgePluginData | undefined> {
        const adapter = this.app.vault.adapter;
        const raw = await readTextOrNull(adapter, path);
        const parsed = parsePluginData(raw) as SpaceforgePluginData | null;

        if (parsed && Object.keys(schedulesOf(parsed)).length > 0) {
            this.refreshGoodCopy(path, parsed);
            return parsed;
        }

        const candidates = await collectRecoverableCandidates(adapter, this.dataDirectory(), dataFileName(), candidate => this.fileMtime(candidate));
        const best = candidates.find(candidate => candidate.schedules > 0);
        if (!best) {
            if (parsed) return parsed; // genuinely empty library: leave it as it is
            if (raw !== null) {
                const kept = await this.preserveUnreadableFile(path, raw);
                console.error('[spaceforge] the data file could not be read and no copy holds any reviews');
                new Notice(`Spaceforge: the data file could not be read, and no backup holds your notes. The unreadable file was kept as ${kept ?? '—'}.`, 12000);
            }
            return undefined;
        }

        const keptName = raw === null ? null : await this.preserveUnreadableFile(path, raw);
        const base = parsed ?? ({ settings: this.settings, pluginState: { ...DEFAULT_PLUGIN_STATE_DATA } });
        const { merged, addedSchedules, addedHistory } = mergePluginStates(base, best.data);
        new Notice(`Spaceforge: recovered ${addedSchedules.length} note(s) and ${addedHistory} review(s) from ${best.name}.${keptName ? ` The unreadable file was kept as ${keptName}.` : ''}`, 12000);
        return merged;
    }

    /** Keep a copy of the last state that loaded cleanly, to recover from next time. */
    private refreshGoodCopy(path: string, data: SpaceforgePluginData): void {
        void writeJsonAtomically(this.app.vault.adapter, goodCopyPath(path), data, message => console.warn('[spaceforge]', message))
            .catch(error => console.warn('[spaceforge] could not refresh the good copy:', error));
    }

    /** Keep the bytes of an unreadable data file so nothing about the loss is thrown away. */
    private async preserveUnreadableFile(path: string, raw: string): Promise<string | null> {
        const target = corruptBackupPath(path, Date.now());
        try {
            await this.app.vault.adapter.write(target, raw);
            return target.substring(target.lastIndexOf('/') + 1);
        } catch (error) {
            console.error('[spaceforge] could not preserve the unreadable data file:', error);
            return null;
        }
    }

    /** What is loaded right now, for the recovery dialog. */
    describeCurrentDataCounts(): string {
        const schedules = Object.keys(this.reviewScheduleService.schedules ?? {}).length;
        const history = this.reviewHistoryService.history?.length ?? 0;
        return `Current: ${schedules} note(s) scheduled, ${history} review(s) logged.`;
    }

    /** Copies of the data file that hold scheduling state, richest first. */
    async listDataRecoveryCandidates(): Promise<DataFileCandidate[]> {
        return collectRecoverableCandidates(this.app.vault.adapter, this.dataDirectory(), dataFileName(), path => this.fileMtime(path));
    }

    /**
     * Fold a copy of the data file into the live state and save.
     *
     * Only what is missing is added - reviews of notes already present keep their
     * due dates, so this can be run repeatedly without moving anything back.
     */
    async applyRecoveredData(candidate: DataFileCandidate): Promise<{ addedSchedules: number; addedHistory: number }> {
        const current = { settings: this.settings, pluginState: this.pluginState };
        const { merged, addedSchedules, addedHistory } = mergePluginStates(current, candidate.data);
        this.pluginState = (merged.pluginState) ?? this.pluginState;
        this.applyLoadedState();
        await this.savePluginData();
        this.reviewController.updateTodayNotes(true);
        void this.getSidebarView()?.refresh();
        new Notice(`Spaceforge: restored ${addedSchedules.length} note(s) and ${addedHistory} review(s) from ${candidate.name}.`, 8000);
        return { addedSchedules: addedSchedules.length, addedHistory };
    }

    async loadPluginData(): Promise<void> {
        // Initialize settings with defaults
        this.settings = { ...DEFAULT_SETTINGS };

        let rawLoadedData: SpaceforgePluginData | undefined;
        // let preliminarySettingsData: Partial<SpaceforgeSettings> | null = null; // No longer needed
        const effectivePath = this._getEffectiveDataPath(); // Uses the now-bootstrapped settings
        const defaultPluginDataPath = this.app.vault.configDir + `/plugins/${this.manifest.id}/data.json`;

        try {
            if (effectivePath) {
                // Using custom path
                rawLoadedData = await this.readDataFileWithRecovery(effectivePath);
                if (!rawLoadedData) {
                    // Nothing usable at the custom path: migrate from the default one.
                    const fallback = parsePluginData(await readTextOrNull(this.app.vault.adapter, defaultPluginDataPath)) as SpaceforgePluginData | null;
                    if (fallback && Object.keys(schedulesOf(fallback)).length > 0) {
                        new Notice(`Spaceforge: custom data file unusable. Migrating from the default location.`, 5000);
                        rawLoadedData = fallback;
                    } else {
                        new Notice(`Spaceforge: no data file found at ${effectivePath}. A new one will be created on save.`, 3000);
                    }
                }
            } else {
                // Using default plugin storage path
                rawLoadedData = await this.readDataFileWithRecovery(defaultPluginDataPath);
            }

            let loadedSettings = {}; // Start with empty object
            if (rawLoadedData?.settings && typeof rawLoadedData.settings === 'object') {
                // If data was loaded and settings is an object, use its settings
                loadedSettings = rawLoadedData.settings;
            }
            // Merge defaults and loaded settings
            this.settings = { ...DEFAULT_SETTINGS, ...loadedSettings };
            // One-time corrections for settings whose meaning changed; see
            // migrateSettings() for what and why.
            migrateSettings(this.settings);
            // Where to look for the agent CLIs, from the moment settings load: a
            // vault that names an unusual folder must be searched that way before
            // anything (detection included) looks for a binary.
            setCliExtraPath(this.settings.cliExtraPath);


            this.pluginState = { ...DEFAULT_APP_DATA.pluginState };
            if (rawLoadedData?.pluginState) {
                this.pluginState = { ...this.pluginState, ...rawLoadedData.pluginState };
            } else if (rawLoadedData && !rawLoadedData.pluginState && (rawLoadedData as Partial<PluginStateData>).schedules) { // Legacy check
                this.pluginState = { ...this.pluginState, ...(rawLoadedData as Partial<PluginStateData>) };
            }

            // Ensure calendarEvents exists for legacy data
            if (!this.pluginState.calendarEvents) {
                this.pluginState.calendarEvents = {};
            }

            // Ensure Study containers exist for data written before the feature
            if (!this.pluginState.studyPlans) this.pluginState.studyPlans = {};
            if (!this.pluginState.studyProgress) this.pluginState.studyProgress = {};
            if (!this.pluginState.studySessions) this.pluginState.studySessions = {};

            // Ensure pomodoro state is initialized if not present in loaded data
            this.pluginState.pomodoroCurrentMode = this.pluginState.pomodoroCurrentMode || DEFAULT_PLUGIN_STATE_DATA.pomodoroCurrentMode;
            this.pluginState.pomodoroTimeLeftInSeconds = this.pluginState.pomodoroTimeLeftInSeconds || DEFAULT_PLUGIN_STATE_DATA.pomodoroTimeLeftInSeconds;
            this.pluginState.pomodoroSessionsCompletedInCycle = this.pluginState.pomodoroSessionsCompletedInCycle || DEFAULT_PLUGIN_STATE_DATA.pomodoroSessionsCompletedInCycle;
            this.pluginState.pomodoroIsRunning = typeof this.pluginState.pomodoroIsRunning === 'boolean' ? this.pluginState.pomodoroIsRunning : DEFAULT_PLUGIN_STATE_DATA.pomodoroIsRunning;


            if (this.pluginState.schedules) {
                // Data migration for schedulingAlgorithm
                for (const path in this.pluginState.schedules) {
                    if (Object.prototype.hasOwnProperty.call(this.pluginState.schedules, path)) {
                        const schedule = this.pluginState.schedules[path];
                        if (!schedule.schedulingAlgorithm) {
                            schedule.schedulingAlgorithm = 'sm2'; // Default to SM-2 for old schedules
                            // Ensure FSRS-specific data is undefined for these migrated SM-2 cards
                            schedule.fsrsData = undefined;
                            // Ensure SM-2 specific 'scheduleCategory' has a default if missing
                            if (!schedule.scheduleCategory) {
                                schedule.scheduleCategory = this.settings.useInitialSchedule ? 'initial' : 'spaced';
                            }
                        }
                        // Ensure SM-2 fields are present for SM-2 cards if somehow missing
                        if (schedule.schedulingAlgorithm === 'sm2') {
                            schedule.ease = schedule.ease ?? this.settings.baseEase;
                            schedule.interval = schedule.interval ?? 0;
                            schedule.repetitionCount = schedule.repetitionCount ?? 0;
                            schedule.consecutive = schedule.consecutive ?? 0;
                            schedule.scheduleCategory = schedule.scheduleCategory ?? (this.settings.useInitialSchedule ? 'initial' : 'spaced');
                        }
                    }
                }
            }

            this.applyLoadedState();

        } catch (error) {
            console.error("Spaceforge: Error loading data:", error);

            // SIMPLE RECOVERY: Try the vault-local backup once, then use defaults
            try {
                const backupData: unknown = this.app.loadLocalStorage('spaceforge-backup');
                if (typeof backupData === 'string' && backupData) {
                    const parsedBackup = JSON.parse(backupData) as { reviewData?: Partial<PluginStateData>; settings?: Partial<SpaceforgeSettings> };
                    if (parsedBackup.reviewData) {
                        this.settings = { ...DEFAULT_SETTINGS, ...parsedBackup.settings };
                        this.pluginState = { ...DEFAULT_PLUGIN_STATE_DATA, ...parsedBackup.reviewData };
                        new Notice("Recovered data from backup", 5000);
                    } else {
                        throw new Error("Invalid backup format");
                    }
                } else {
                    throw new Error("No backup found");
                }
            } catch (backupError) {
                console.warn("Spaceforge: Backup recovery failed, using defaults:", backupError);
                this.settings = { ...DEFAULT_SETTINGS };
                this.pluginState = { ...DEFAULT_PLUGIN_STATE_DATA };
                new Notice("Error loading data, using defaults to prevent crash", 5000);
            }

            // Repopulate services
            this.applyLoadedState();
        }
    }

    /**
     * Rebuild every note's schedule from its review log.
     *
     * Cards scheduled under the older rules (a forced 1-day interval whenever a note
     * was late, an FSRS rating shifted a notch) end up where the corrected scheduler
     * would have put them. Notes whose log is incomplete are left alone and counted in
     * the notice; the data file is copied to a timestamped backup before anything
     * changes.
     */
    async repairSchedulesFromHistory(): Promise<void> {
        const backupPath = await this.writeRepairBackup();
        if (!backupPath) {
            new Notice('Repair cancelled: the data file could not be backed up.');
            return;
        }

        const report = this.reviewScheduleService.repairFromHistory();
        await this.savePluginData();
        this.reviewController.updateTodayNotes(true);
        void this.getSidebarView()?.refresh();

        const noHistory = report.skipped.filter(entry => entry.reason === 'no history').length;
        const partial = report.skipped.length - noHistory;
        const parts = [`${report.repaired.length} rebuilt from history`];
        if (partial > 0) parts.push(`${partial} skipped (incomplete log)`);
        if (noHistory > 0) parts.push(`${noHistory} skipped (never logged)`);
        new Notice(`Schedule repair: ${parts.join(', ')}. Backup: ${backupPath.substring(backupPath.lastIndexOf('/') + 1)}`);
        // Nothing goes to the console unless it is a problem; the report itself
        // is shown in a Notice, which is where the user will look for it.

    }

    /** Copy the data file aside before a repair, so the change can be undone. */
    private async writeRepairBackup(): Promise<string | null> {
        const target = this._getEffectiveDataPath()
            ?? (this.app.vault.configDir + `/plugins/${this.manifest.id}/data.json`);
        try {
            const contents = await this.app.vault.adapter.read(target);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const backupPath = `${target}.backup-${stamp}`;
            await this.app.vault.adapter.write(backupPath, contents);
            return backupPath;
        } catch (error) {
            console.error('[spaceforge] could not write the repair backup:', error);
            return null;
        }
    }

    /**
     * Save, at most one write at a time.
     *
     * Overlapping saves used to interleave two writers on one file, which is how a
     * reload in the middle of a save left an empty data.json behind. Callers that
     * await this get a write that includes their changes; a save already running just
     * marks the state dirty and loops once more.
     */
    async savePluginData(): Promise<void> {
        if (this.saveInFlight) {
            this.saveDirty = true;
            return this.saveInFlight;
        }
        const run = (async () => {
            do {
                this.saveDirty = false;
                await this.performSave();
            } while (this.saveDirty);
        })();
        this.saveInFlight = run.finally(() => { this.saveInFlight = null; });
        return this.saveInFlight;
    }

    private async performSave(): Promise<void> {
        try {
            // Ensure settings object exists and is valid, applying defaults if necessary
            if (!this.settings || typeof this.settings !== 'object') {
                this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as SpaceforgeSettings;
            } else {
                // Ensure all default keys are present
                this.settings = { ...DEFAULT_SETTINGS, ...this.settings };
            }

            // Ensure pluginState object exists
            if (!this.pluginState) {
                this.pluginState = { ...DEFAULT_PLUGIN_STATE_DATA };
            }

            const currentPluginState: PluginStateData = {
                schedules: this.reviewScheduleService.schedules || {},
                history: this.reviewHistoryService.history || [],
                reviewSessions: this.reviewSessionService.reviewSessions || { sessions: {}, activeSessionId: null },
                mcqSets: this.mcqService.mcqSets || {},
                mcqSessions: this.mcqService.mcqSessions || {},
                studyPlans: this.studyPlanService.plans || {},
                studyProgress: this.studyPlanService.progress || {},
                studySessions: this.studyPlanService.sessions || {},
                customNoteOrder: this.reviewScheduleService.customNoteOrder || [],
                lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp ?? null,
                pomodoroCurrentMode: this.pluginState.pomodoroCurrentMode || DEFAULT_PLUGIN_STATE_DATA.pomodoroCurrentMode,
                pomodoroTimeLeftInSeconds: this.pluginState.pomodoroTimeLeftInSeconds || DEFAULT_PLUGIN_STATE_DATA.pomodoroTimeLeftInSeconds,
                pomodoroSessionsCompletedInCycle: this.pluginState.pomodoroSessionsCompletedInCycle || DEFAULT_PLUGIN_STATE_DATA.pomodoroSessionsCompletedInCycle,
                pomodoroIsRunning: typeof this.pluginState.pomodoroIsRunning === 'boolean' ? this.pluginState.pomodoroIsRunning : DEFAULT_PLUGIN_STATE_DATA.pomodoroIsRunning,
                pomodoroEndTimeMs: this.pluginState.pomodoroEndTimeMs ?? null, // Add the missing field
                pomodoroEstimatedTotalCycles: this.pluginState.pomodoroEstimatedTotalCycles ?? DEFAULT_PLUGIN_STATE_DATA.pomodoroEstimatedTotalCycles,
                pomodoroEstimatedWorkSessions: this.pluginState.pomodoroEstimatedWorkSessions ?? DEFAULT_PLUGIN_STATE_DATA.pomodoroEstimatedWorkSessions,
                pomodoroIsEstimationActive: typeof this.pluginState.pomodoroIsEstimationActive === 'boolean' ? this.pluginState.pomodoroIsEstimationActive : DEFAULT_PLUGIN_STATE_DATA.pomodoroIsEstimationActive,
                pomodoroUserHasModifiedSettings: typeof this.pluginState.pomodoroUserHasModifiedSettings === 'boolean' ? this.pluginState.pomodoroUserHasModifiedSettings : DEFAULT_PLUGIN_STATE_DATA.pomodoroUserHasModifiedSettings,
                pomodoroUserOverrideHours: typeof this.pluginState.pomodoroUserOverrideHours === 'number' ? this.pluginState.pomodoroUserOverrideHours : DEFAULT_PLUGIN_STATE_DATA.pomodoroUserOverrideHours,
                pomodoroUserOverrideMinutes: typeof this.pluginState.pomodoroUserOverrideMinutes === 'number' ? this.pluginState.pomodoroUserOverrideMinutes : DEFAULT_PLUGIN_STATE_DATA.pomodoroUserOverrideMinutes,
                pomodoroUserAddToEstimation: typeof this.pluginState.pomodoroUserAddToEstimation === 'boolean' ? this.pluginState.pomodoroUserAddToEstimation : DEFAULT_PLUGIN_STATE_DATA.pomodoroUserAddToEstimation,
                calendarEvents: this.calendarEventService ? Object.fromEntries(this.calendarEventService.getAllEvents().map(event => [event.id, event])) : {},
                // The interrupted sitting. This object is rebuilt field by field
                // on every save, so a field that is not named here is a field
                // the save quietly deletes — which is exactly what happened to
                // the run the reader was in the middle of.
                noteRun: this.pluginState.noteRun ?? null,
                deckSitting: this.pluginState.deckSitting ?? null,
                // The statistics counters and the deck review log, likewise
                // named here or the save would drop them.
                reviewDayStats: this.statsService.reviewDayStats ?? {},
                deckHistory: this.statsService.deckHistory ?? [],
                version: this.manifest.version,
            };
            this.pluginState = currentPluginState; // Update the live pluginState
            const dataToSave: SpaceforgePluginData = {
                settings: this.settings, // Use the already prepared this.settings
                pluginState: this.pluginState,
            };

            const effectiveSavePath = this._getEffectiveDataPath();
            const defaultPluginDataPath = this.app.vault.configDir + `/plugins/${this.manifest.id}/data.json`;

            if (effectiveSavePath) {
                // Saving to custom path
                try {
                    const dirPathOnly = effectiveSavePath.substring(0, effectiveSavePath.lastIndexOf('/'));
                    if (dirPathOnly && !this.app.vault.getAbstractFileByPath(dirPathOnly)) {
                        await this.app.vault.createFolder(dirPathOnly);
                        new Notice(`Created directory for custom data: ${dirPathOnly}`, 3000);
                    }

                    // Atomic save: a temp file is renamed over the target, so an
                    // interrupted write can never truncate the real data file.
                    // The custom path may be inside the vault, but it is written
                    // through the adapter on purpose: the Vault API has no way to
                    // write to a temporary name and rename over the target, and a
                    // plain Vault.modify truncates before it writes — exactly the
                    // failure this guards against.
                    await writeJsonAtomically(this.app.vault.adapter, effectiveSavePath, dataToSave, message => console.warn('[spaceforge]', message));
                    // new Notice(`Spaceforge: Data saved to custom path: ${effectiveSavePath}`, 3000); // Removed notice

                    // Migration/Cleanup: If we just successfully saved to a custom path,
                    // and the old default data.json exists, KEEP IT as backup for safety.
                    // CRITICAL FIX: Never automatically delete user data to prevent data loss during reloads
                    const oldFile = this.app.vault.getAbstractFileByPath(defaultPluginDataPath);
                    if (oldFile instanceof TFile) {
                        // Instead of deleting, we'll keep the old file as a backup
                        // Users can manually clean it up later if needed
                        new Notice(`Successfully saved to custom path, original data file kept as backup for safety`, 5000);
                    }
                } catch (writeError) {
                    const msg = writeError instanceof Error ? writeError.message : String(writeError);
                    new Notice(`Error saving data to custom path ${effectiveSavePath}: ${msg}. Falling back to default path for this save.`, 10000);
                    // Fallback save to default location if custom path write fails
                    try {
                        await this.saveData(dataToSave); // Plugin's internal save
                        new Notice(`Data saved to default plugin folder due to error with custom path`, 5000);
                    } catch {
                        new Notice(`Critical error: failed to save data to both custom and default locations`, 10000);
                    }
                }
            } else {
                // Saving to default plugin storage path. Obsidian's own saveData()
                // truncates the file before writing it, which is what a quick restart
                // catches in the act - write through a temp file and rename instead.
                await writeJsonAtomically(this.app.vault.adapter, defaultPluginDataPath, dataToSave, message => console.warn('[spaceforge]', message));
                // new Notice(`Spaceforge: Data saved to default plugin storage.`, 3000); // Removed notice
            }

            // Removed the local backup for settings as it's not the source of truth for the path anymore.
            // If user wants to backup settings, they can use the export feature.

        } catch {
            new Notice("Error saving data. Check console for details", 5000);
        }
    }

    async activateSidebarView(): Promise<void> {
        const existingLeaves = this.app.workspace.getLeavesOfType('spaceforge-review-schedule');
        if (existingLeaves.length > 0) {
            // If a sidebar view already exists, reveal the first one found
            void this.app.workspace.revealLeaf(existingLeaves[0]);
        } else {
            // If no sidebar view exists, create a new one
            const leaf = this.app.workspace.getRightLeaf(false); // Default to right leaf if creating new
            if (leaf) {
                await leaf.setViewState({
                    type: 'spaceforge-review-schedule',
                    active: true,
                });
                void this.app.workspace.revealLeaf(leaf); // Reveal the newly created leaf
            } else {
                new Notice("Could not open sidebar view");
            }
        }
    }

    /**
     * Open (or reveal) the statistics view.
     *
     * The view lives in the main area on purpose: the charts need more width
     * than the sidebar has, and a leaf of its own can sit on a second monitor
     * or in a popout window. One leaf is reused; opening again just reveals
     * it and asks it to re-read the data.
     */
    async openStatsView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(STATS_VIEW);
        if (existing.length > 0) {
            void this.app.workspace.revealLeaf(existing[0]);
            const view = existing[0].view;
            if (view instanceof StatsView) await view.refresh();
            return;
        }
        const leaf = this.app.workspace.getLeaf('tab');
        if (!leaf) {
            new Notice('Could not open the statistics view');
            return;
        }
        await leaf.setViewState({ type: STATS_VIEW, active: true });
        void this.app.workspace.revealLeaf(leaf);
    }

    /**
     * The Markdown file the user is looking at, or null. One place for the
     * checkCallbacks above, so "is there a note to act on?" has one answer.
     */
    /**
     * The note selected in the core file explorer, if any.
     *
     * The explorer is not part of the public API, so every step of this is
     * optional-chained: an Obsidian version that changes shape leaves the
     * command hidden rather than broken.
     */
    private selectedExplorerFile(): TFile | null {
        const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
        const view = leaf?.view as { file?: unknown } | undefined;
        const file = view?.file;
        return file instanceof TFile && file.extension === 'md' ? file : null;
    }

    private activeMarkdownFile(): TFile | null {
        const file = this.app.workspace.getActiveFile();
        return file instanceof TFile && file.extension === 'md' ? file : null;
    }

    addCommands(): void {
        this.addCommand({
            id: 'next-review-note',
            name: 'Next review note',
            callback: () => {
                void this.navigationController.navigateToNextNote();
            },
        });

        this.addCommand({
            id: 'review-session-in-window',
            name: 'Move the review session into a window',
            callback: () => {
                this.reviewFlowController.setHost('window');
            },
        });

        this.addCommand({
            id: 'review-session-in-sidebar',
            name: 'Move the review session into the sidebar',
            callback: () => {
                void this.reviewFlowController.moveToHost('sidebar');
            },
        });

        this.addCommand({
            id: 'previous-review-note',
            name: 'Previous review note',
            callback: () => {
                void this.navigationController.navigateToPreviousNote();
            },
        });

        this.addCommand({
            id: 'open-statistics',
            name: 'Open statistics',
            callback: () => {
                void this.openStatsView();
            },
        });

        // The note-bound commands are checkCallbacks: the palette greys them out
        // when there is no note to act on, instead of offering a command whose
        // only outcome is a Notice saying it cannot run.
        this.addCommand({
            id: 'review-current-note',
            name: 'Review current note',
            checkCallback: (checking: boolean) => {
                const activeFile = this.activeMarkdownFile();
                if (!activeFile) return false;
                if (!checking) void this.reviewController.reviewNote(activeFile.path);
                return true;
            },
        });

        this.addCommand({
            id: 'study-current-note',
            name: 'Study current note',
            checkCallback: (checking: boolean) => {
                const activeFile = this.activeMarkdownFile();
                if (!activeFile) return false;
                if (!checking) this.studyController.openStudy(activeFile.path);
                return true;
            },
        });

        this.addCommand({
            id: 'chart-scheduled-notes-for-study',
            name: 'Chart scheduled notes',
            callback: () => {
                this.chartAllScheduledNotes();
            },
        });

        this.addCommand({
            id: 'chart-current-note-for-study',
            name: 'Chart this note',
            checkCallback: (checking: boolean) => {
                const activeFile = this.activeMarkdownFile();
                if (!activeFile) return false;
                if (!checking) void this.studyController.chartNote(activeFile.path, true);
                return true;
            },
        });

        this.addCommand({
            id: 'add-current-note-to-review',
            name: 'Add current note to review schedule',
            checkCallback: (checking: boolean) => {
                const activeFile = this.activeMarkdownFile();
                if (!activeFile) return false;
                if (!checking) {
                    void (async () => {
                        this.reviewScheduleService.scheduleNoteForReview(activeFile.path);
                        await this.savePluginData();
                        new Notice(`Added "${activeFile.path}" to review schedule`);
                    })();
                }
                return true;
            },
        });

        this.addCommand({
            id: 'add-current-folder-to-review',
            name: "Add current note's folder to review schedule",
            checkCallback: (checking: boolean) => {
                const folder = this.activeMarkdownFile()?.parent;
                if (!folder || !(folder instanceof TFolder)) return false;
                // Same logic as the context menu, so the two cannot disagree.
                if (!checking) void this.contextMenuHandler.addFolderToReview(folder);
                return true;
            },
        });
        this.addCommand({
            id: 'study-all-decks-due',
            name: 'Study everything due (all decks)',
            callback: () => void this.deckSessionController.startAllDue(),
        });

        this.addCommand({
            id: 'import-anki-package',
            name: 'Import an Anki deck (.apkg file)',
            callback: () => void this.importAnkiPackage(),
        });

        this.addCommand({
            id: 'export-deck',
            name: 'Export a deck as an Anki package',
            checkCallback: (checking: boolean) => {
                const ready = this.deckService !== undefined;
                if (!ready) return false;
                if (!checking) void this.exportDeck();
                return true;
            },
        });

        this.addCommand({
            id: 'search-ankiweb-decks',
            name: 'Find a deck on AnkiWeb',
            callback: () => this.openAnkiWebSearch(),
        });

        this.addCommand({
            id: 'study-deck',
            name: 'Study a deck',
            checkCallback: (checking: boolean) => {
                const decks = this.deckSessionController ? true : false;
                if (!decks) return false;
                if (!checking) void this.chooseDeckToStudy();
                return true;
            },
        });

        this.addCommand({
            id: 'study-deck-in-window',
            name: 'Study a deck in a new window',
            callback: () => {
                const previous = this.settings.reviewSessionPlacement;
                this.settings.reviewSessionPlacement = 'window';
                void this.chooseDeckToStudy().finally(() => {
                    this.settings.reviewSessionPlacement = previous;
                });
            },
        });

        this.addCommand({
            id: 'start-review-session-in-window',
            name: 'Start review session in a new window',
            callback: () => {
                // One-off: the session opens in its own window without changing the
                // setting, so a note on a second monitor needs no detour through
                // the settings screen.
                const previous = this.settings.reviewSessionPlacement;
                this.settings.reviewSessionPlacement = 'window';
                this.reviewFlowController.start();
                this.settings.reviewSessionPlacement = previous;
            }
        });

        this.addCommand({
            id: 'start-review-session',
            name: 'Start review session (docked review bar)',
            callback: () => {
                this.reviewFlowController.start();
            },
        });

        // Straight to the tutor, or straight to the questions, on the note you
        // are looking at — the two things the dock is for.
        const openDockTab = (tab: 'study' | 'mcq'): void => {
            const file = this.activeMarkdownFile();
            if (!file) return;
            // The dock lives under the review bar, so the note has to be under
            // review for it to exist.
            if (!this.reviewFlowController.isActive()) {
                this.reviewFlowController.start(file.path);
            }
            window.setTimeout(() => {
                if (!this.reviewFlowController.openDockTab(tab)) {
                    new Notice(tab === 'study' ? 'Study is not available for this note.' : 'Questions are not available for this note.');
                }
            }, 120);
        };

        // No default hotkeys: Obsidian reserves the right to bind keys itself,
        // and a plugin that ships defaults fights the user's own settings. These
        // four are meant to be bound in Settings → Hotkeys (search "Spaceforge"),
        // which the settings tab links to directly.
        this.addCommand({
            id: 'open-study-dock',
            name: 'Study the current note in the dock',
            checkCallback: (checking: boolean) => {
                if (!this.activeMarkdownFile()) return false;
                if (!checking) openDockTab('study');
                return true;
            },
        });

        this.addCommand({
            id: 'open-mcq-dock',
            name: 'Ask me questions on the current note',
            checkCallback: (checking: boolean) => {
                if (!this.activeMarkdownFile()) return false;
                if (!checking) openDockTab('mcq');
                return true;
            },
        });

        const gradeCommand = (id: string, name: string, bucket: GradeBucket) => {
            this.addCommand({
                id,
                name,
                checkCallback: (checking: boolean) => {
                    if (!this.reviewFlowController.isActive()) return false;
                    if (!checking) {
                        void this.reviewFlowController.gradeBucket(bucket);
                    }
                    return true;
                },
            });
        };

        // Coarse grades that work whichever algorithm the current note uses, so
        // they can be bound to keys in Obsidian's own hotkey settings.
        gradeCommand('rate-review-note-again', 'Rate current review note: again', 'again');
        gradeCommand('rate-review-note-hard', 'Rate current review note: hard', 'hard');
        gradeCommand('rate-review-note-good', 'Rate current review note: good', 'good');
        gradeCommand('rate-review-note-easy', 'Rate current review note: easy', 'easy');

        this.addCommand({
            id: 'recover-review-data',
            name: 'Recover review data from backup files',
            callback: () => { new DataRecoveryModal(this.app, this).open(); },
        });

        this.addCommand({
            id: 'repair-review-schedules-from-history',
            name: 'Repair review schedules from history',
            callback: () => { void this.repairSchedulesFromHistory(); },
        });

        this.addCommand({
            id: 'undo-last-review-rating',
            name: 'Undo last review rating',
            checkCallback: (checking: boolean) => {
                if (!this.reviewFlowController.isActive()) return false;
                if (!checking) void this.reviewFlowController.undo();
                return true;
            },
        });

        this.addCommand({
            id: 'skip-current-review-note',
            name: 'Skip current review note',
            checkCallback: (checking: boolean) => {
                if (!this.reviewFlowController.isActive()) return false;
                if (!checking) void this.reviewFlowController.skip();
                return true;
            },
        });

        this.addCommand({
            id: 'end-review-session',
            name: 'End review session',
            checkCallback: (checking: boolean) => {
                if (!this.reviewFlowController.isActive()) return false;
                if (!checking) this.reviewFlowController.end();
                return true;
            },
        });
    }

    addIcons(): void { /* ... */ }

    initializeMCQComponents(): void {
        this.mcqGenerationService = undefined; // Clear previous instance
        this.mcqController = undefined;

        if (this.settings.enableMCQ) {
            this.mcqGenerationService = this.createMcqGenerationService();
            if (this.mcqGenerationService) {
                // Pass the mcqService for data management, and the new mcqGenerationService for API calls
                this.mcqController = new MCQController(this, this.mcqService, this.mcqGenerationService);
            } else {
                new Notice('Generation service could not be initialized. Check API provider settings in settings');
            }
        }
    }

    private createMcqGenerationService(): IMCQGenerationService | undefined {
        switch (this.settings.mcqApiProvider) {
            case ApiProvider.OpenRouter:
                if (!this.settings.openRouterApiKey) {
                    new Notice('OpenRouter API key is not set in settings');
                    return undefined;
                }
                return new OpenRouterService(this);
            case ApiProvider.OpenAI:
                if (!this.settings.openaiApiKey) {
                    new Notice('OpenAI API key is not set in settings');
                    return undefined;
                }
                return new OpenAIService(this);
            case ApiProvider.Ollama:
                if (!this.settings.ollamaApiUrl || !this.settings.ollamaModel) {
                    new Notice('Ollama API URL or model is not set in settings');
                    return undefined;
                }
                return new OllamaService(this);
            case ApiProvider.Gemini:
                if (!this.settings.geminiApiKey) {
                    new Notice('Gemini API key is not set in settings');
                    return undefined;
                }
                return new GeminiService(this);
            case ApiProvider.Claude:
                if (!this.settings.claudeApiKey || !this.settings.claudeModel) {
                    new Notice('Claude API key or model is not set in settings');
                    return undefined;
                }
                return new ClaudeService(this);
            case ApiProvider.Together:
                if (!this.settings.togetherApiKey || !this.settings.togetherModel) {
                    new Notice('Together AI API key or model is not set in settings');
                    return undefined;
                }
                return new TogetherService(this);
            case ApiProvider.OpenAICompatible:
                if (!this.settings.openaiCompatibleApiUrl || !this.settings.openaiCompatibleModel) {
                    new Notice('The provider needs a server address and a model.');
                    return undefined;
                }
                return new OpenAICompatibleService(this);
            case ApiProvider.Cli:
                if (!this.settings.cliAgent) {
                    new Notice('No local CLI chosen yet.');
                    return undefined;
                }
                // The CLI brings its own login, so there is no key to check here;
                // whether it is installed and signed in is reported by detection
                // in the settings, and by the run itself if it is not.
                return new CliService(this);
            default: {
                // A local CLI is its own provider row (`cli:claude`), and runs
                // through the same service the old single CLI choice used.
                const agentId = agentIdOfProvider(this.settings.mcqApiProvider);
                if (agentId) {
                    if (!getCliAgent(agentId)) {
                        new Notice(`Unsupported MCQ API provider selected: ${String(this.settings.mcqApiProvider)}`);
                        return undefined;
                    }
                    return new CliService(this);
                }
                // Every other provider in the registry is spoken to through one
                // OpenAI-shaped service, so a new company needs no case here.
                const descriptor = getHttpProvider(this.settings.mcqApiProvider);
                if (!descriptor || !providerIsOpenAiShaped(descriptor)) {
                    new Notice(`Unsupported MCQ API provider selected: ${String(this.settings.mcqApiProvider)}`);
                    return undefined;
                }
                const gap = describeProviderGap(descriptor, this.settings);
                if (gap) {
                    new Notice(gap);
                    return undefined;
                }
                return new OpenAIHttpService(this, descriptor);
            }
        }
    }

    checkForDueNotes(): void { /* ... */ }
    exportPluginData(): void { /* ... */ }
    importPluginData(_fileContent: string): void { /* ... */ }

    getSidebarView(): ReviewSidebarView | null {
        const leaves = this.app.workspace.getLeavesOfType('spaceforge-review-schedule');
        if (leaves.length > 0) {
            const view = leaves[0].view;
            if (view instanceof ReviewSidebarView) {
                return view;
            }
        }
        return null;
    }
}
