import { App, Notice, Plugin, ViewCreator, WorkspaceLeaf, addIcon, TFile, TFolder, normalizePath } from 'obsidian';
import { EventEmitter } from './utils/event-emitter';
import { DataStorage } from './data-storage';
import { ReviewController } from './controllers/review-controller';
import { ReviewNavigationController } from './controllers/review-navigation-controller';
import { ReviewSessionController } from './controllers/review-session-controller';
import { ReviewBatchController } from './controllers/review-batch-controller';
import { MCQController } from './controllers/review-controller-mcq';
import { ContextMenuHandler } from './ui/context-menu';
import { ReviewSidebarView } from './ui/sidebar-view';
import { SpaceforgeSettingTab } from './ui/settings-tab';
import { DEFAULT_SETTINGS, SpaceforgeSettings, ApiProvider } from './models/settings';
import { SpaceforgePluginData, PluginStateData, DEFAULT_APP_DATA, DEFAULT_PLUGIN_STATE_DATA } from './models/plugin-data';
import { EstimationUtils } from './utils/estimation';
import { OpenRouterService } from './api/openrouter-service';
import { OpenAIService } from './api/openai-service';
import { OllamaService } from './api/ollama-service';
import { GeminiService } from './api/gemini-service';
import { ClaudeService } from './api/claude-service';
import { TogetherService } from './api/together-service';
import { IMCQGenerationService } from './api/mcq-generation-service';
import { ReviewScheduleService } from './services/review-schedule-service';
import { ReviewHistoryService } from './services/review-history-service';
import { ReviewSessionService } from './services/review-session-service';
import { MCQService } from './services/mcq-service';
import { PomodoroService } from './services/pomodoro-service';

/**
 * Spaceforge: Spaced Repetition Plugin for Obsidian
 */
export default class SpaceforgePlugin extends Plugin {
    settings: SpaceforgeSettings;
    pluginState: PluginStateData;
    dataStorage: DataStorage;
    reviewScheduleService: ReviewScheduleService;
    reviewHistoryService: ReviewHistoryService;
    reviewSessionService: ReviewSessionService;
    mcqService: MCQService;
    pomodoroService: PomodoroService;

    private readonly stylesheetPath: string = "styles.css";
    private readonly stylesheetId: string = "spaceforge-styles";
    private lastStylesModTime: number | null = null;
    private cssHotReloadIntervalId: number | null = null;

    reviewController: ReviewController;
    navigationController: ReviewNavigationController;
    sessionController: ReviewSessionController;
    batchController: ReviewBatchController;
    mcqController: MCQController | undefined;
    mcqGenerationService: IMCQGenerationService | undefined; // Changed from openRouterService
    contextMenuHandler: ContextMenuHandler;
    sidebarView: ReviewSidebarView;
    public clickedDateFromCalendar: Date | null = null;
    events: EventEmitter;

    async onload(): Promise<void> {
        console.log('Loading Spaceforge plugin (version ' + this.manifest.version + ')');
        this.events = new EventEmitter();

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
        this.reviewSessionService = new ReviewSessionService(this, this.pluginState.reviewSessions);
        this.mcqService = new MCQService(this.pluginState.mcqSets, this.pluginState.mcqSessions);

        // Load stored data, which will override the defaults in this.settings and this.pluginState
        await this.loadPluginData(); 
        
        // After settings are fully loaded (including from storage), ensure services are updated
        // This is crucial for FsrsScheduleService to get the correct FSRS parameters.
        this.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
        
        // Initialize PomodoroService after settings are loaded
        this.pomodoroService = new PomodoroService(this);


        this.registerView(
            'spaceforge-review-schedule',
            (leaf) => (this.sidebarView = new ReviewSidebarView(leaf, this))
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
        this.contextMenuHandler = new ContextMenuHandler(this);

        this.initializeMCQComponents(); // This will now use mcqGenerationService

        EstimationUtils.setPlugin(this);
        this.addIcons();
        this.contextMenuHandler.register();
        this.addRibbonIcon('calendar-clock', 'Spaceforge Review', async () => {
            await this.activateSidebarView();
        });
        this.addSettingTab(new SpaceforgeSettingTab(this.app, this));
        this.addCommands();

        this.addCommand({
            id: 'add-selected-file-to-review',
            name: 'Add Selected File to Review Schedule (File Explorer)',
            hotkeys: [{ modifiers: ['Alt', 'Shift'], key: 's' }],
            callback: () => {
                const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
                if (fileExplorerLeaf && fileExplorerLeaf.view && (fileExplorerLeaf.view as any).file) {
                    const selectedFile = (fileExplorerLeaf.view as any).file;
                    if (selectedFile instanceof TFile && selectedFile.extension === 'md') {
                        this.reviewScheduleService.scheduleNoteForReview(selectedFile.path)
                            .then(() => this.savePluginData());
                        new Notice(`Added "${selectedFile.path}" to review schedule.`);
                    } else {
                        new Notice("Selected item is not a markdown file.");
                    }
                } else {
                    new Notice("No file selected in file explorer.");
                }
            }
        });

        this.registerEvent(this.app.workspace.on('file-open', (file) => { /* ... */ }));
        this.registerEvent(this.app.vault.on('delete', async (file) => {
            if (file instanceof TFile && file.extension === "md") {
                await this.reviewScheduleService.removeFromReview(file.path);
                await this.savePluginData();
            }
            if (this.sidebarView) this.sidebarView.refresh();
        }));
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (file instanceof TFile && file.extension === "md") {
                this.reviewScheduleService.handleNoteRename(oldPath, file.path);
                await this.savePluginData();
            }
            if (this.sidebarView) this.sidebarView.refresh();
        }));

        this.registerInterval(window.setInterval(() => {
            if (this.sidebarView) this.sidebarView.refresh();
        }, 60 * 1000));

        this.app.workspace.onLayoutReady(() => this.activateSidebarView());
        this.addStylesheet();

        if (this.app.vault.adapter.stat && typeof this.app.vault.adapter.stat === 'function') {
            this.cssHotReloadIntervalId = window.setInterval(async () => {
                try {
                    const stats = await this.app.vault.adapter.stat(this.stylesheetPath);
                    if (stats && (this.lastStylesModTime === null || this.lastStylesModTime < stats.mtime)) {
                        this.lastStylesModTime = stats.mtime;
                        console.log("Detected styles.css change, reloading stylesheet...");
                        this.addStylesheet();
                    }
                } catch (error) { /* console.warn("Error checking stylesheet modification time:", error); */ }
            }, 1000);
            this.registerInterval(this.cssHotReloadIntervalId);
        }

        if (this.settings.notifyBeforeDue > 0) {
            this.registerInterval(window.setInterval(() => this.checkForDueNotes(), 5 * 60 * 1000));
        }

        this.registerInterval(window.setInterval(async () => {
            console.log("Auto-saving data...");
            await this.savePluginData();
            // Removed specific openRouterApiKey backup from here, handled by general settings save.
        }, 5 * 60 * 1000));

        window.addEventListener('beforeunload', (event) => {
            console.log("Window closing, saving data immediately...");
            let existingData = {};
            try {
                const loadedData = this.loadData();
                 if (loadedData && !(loadedData instanceof Promise)) {
                     existingData = loadedData;
                 } else if (loadedData instanceof Promise) {
                     console.warn("Synchronous loadData not available in beforeunload.");
                 }
            } catch (loadError) { console.warn("Could not load existing data during unload:", loadError); }

            try {
                const reviewData = {
                    schedules: this.reviewScheduleService.schedules,
                    history: this.reviewHistoryService.history,
                    reviewSessions: this.reviewSessionService.reviewSessions,
                    mcqSets: this.mcqService.mcqSets,
                    mcqSessions: this.mcqService.mcqSessions,
                    customNoteOrder: this.reviewScheduleService.customNoteOrder,
                    lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp,
                    version: this.manifest.version
                };
                const combinedData = { ...existingData, reviewData };
                let backupStr = JSON.stringify(combinedData);
                window.localStorage.setItem('spaceforge-backup', backupStr);
                console.log(`Saved emergency backup to localStorage (${Math.round(backupStr.length/1024)}KB)`);
                // Removed specific openRouterApiKey backup from here.
                this.savePluginData().catch(e => console.error("Error saving to Obsidian storage during unload:", e));
            } catch (error) {
                console.error("Emergency data backup failed:", error);
                try {
                    const minimalBackup = JSON.stringify({ settings: this.settings, reviewData: { schedules: this.reviewScheduleService.schedules || {}, customNoteOrder: this.reviewScheduleService.customNoteOrder || [], lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp, version: this.manifest.version }});
                    window.localStorage.setItem('spaceforge-minimal-backup', minimalBackup);
                } catch (minimalError) { console.error("Even minimal backup failed:", minimalError); }
            }
        });
    }

    async onunload(): Promise<void> {
        console.log('Unloading Spaceforge plugin');
        if (this.cssHotReloadIntervalId !== null) {
            window.clearInterval(this.cssHotReloadIntervalId);
            this.cssHotReloadIntervalId = null;
        }
        const styleEl = document.getElementById(this.stylesheetId);
        if (styleEl) styleEl.remove();

        let existingData = {};
        try { existingData = await this.loadData() || {}; }
        catch (loadError) { console.warn("Could not load existing data during unload:", loadError); }

        try {
            const reviewData = {
                schedules: this.reviewScheduleService.schedules,
                history: this.reviewHistoryService.history,
                reviewSessions: this.reviewSessionService.reviewSessions,
                mcqSets: this.mcqService.mcqSets,
                mcqSessions: this.mcqService.mcqSessions,
                customNoteOrder: this.reviewScheduleService.customNoteOrder,
                lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp,
                version: this.manifest.version
            };
            const combinedData = { ...existingData, reviewData };
            const backupStr = JSON.stringify(combinedData);
            window.localStorage.setItem('spaceforge-backup', backupStr);
        } catch (backupError) { console.error("Failed to create emergency backup before unload:", backupError); }

        try {
            await this.savePluginData();
        } catch (error) { console.error('Error saving plugin data before unload:', error); }

        if (this.pomodoroService) this.pomodoroService.destroy();
        this.app.workspace.detachLeavesOfType('spaceforge-review-schedule');
    }

    // private async _getEffectiveDataPathFromLocalStorage(): Promise<string | null> {
    //     const customPath = await this.app.loadLocalStorage('spaceforgeCustomDataPath');
    //     return (customPath && typeof customPath === 'string' && customPath.trim() !== '') ? customPath.trim() : null;
    // }

    private async _getEffectiveDataPath(): Promise<string | null> {
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

    async loadPluginData(): Promise<void> {
        // Step 1: Bootstrap critical path settings from localStorage
        const lsUseCustomPath = await this.app.loadLocalStorage('spaceforge_useCustomDataPath');
        const lsCustomPathRelative = await this.app.loadLocalStorage('spaceforge_customDataPathRelative');

        // Initialize settings with defaults
        this.settings = { ...DEFAULT_SETTINGS };

        // Override with localStorage values if they exist
        if (typeof lsUseCustomPath === 'boolean') {
            this.settings.useCustomDataPath = lsUseCustomPath;
        }
        if (typeof lsCustomPathRelative === 'string') {
            this.settings.customDataPath = lsCustomPathRelative;
        }
        
        // Now, this.settings.useCustomDataPath and this.settings.customDataPath reflect the user's
        // most recent choice from the UI (via localStorage) or defaults if never set.

        let rawLoadedData: SpaceforgePluginData | undefined;
        // let preliminarySettingsData: Partial<SpaceforgeSettings> | null = null; // No longer needed
        const effectivePath = await this._getEffectiveDataPath(); // Uses the now-bootstrapped settings
        const defaultPluginDataPath = this.app.vault.configDir + `/plugins/${this.manifest.id}/data.json`;

        try {
            if (effectivePath) {
                // Using custom path
                if (await this.app.vault.adapter.exists(effectivePath)) {
                    const jsonData = await this.app.vault.adapter.read(effectivePath);
                    if (jsonData) rawLoadedData = JSON.parse(jsonData);
                    new Notice(`Spaceforge: Loaded data from custom path: ${effectivePath}`, 3000);
                } else {
                    // Custom path specified but file doesn't exist.
                    // Check if old default data.json exists for migration.
                    if (await this.app.vault.adapter.exists(defaultPluginDataPath)) {
                        new Notice(`Spaceforge: Custom data file not found at ${effectivePath}. Attempting to migrate from default location.`, 5000);
                        try {
                            const oldJsonData = await this.app.vault.adapter.read(defaultPluginDataPath);
                            if (oldJsonData) {
                                rawLoadedData = JSON.parse(oldJsonData);
                                // Data will be saved to new path by savePluginData later
                                console.log(`Spaceforge: Data from default location will be migrated to ${effectivePath} on next save.`);
                            }
                        } catch (migrationReadError) {
                            console.error(`Spaceforge: Error reading data from default location for migration:`, migrationReadError);
                        }
                    }
                    if (!rawLoadedData) {
                         new Notice(`Spaceforge: No data file found at custom path ${effectivePath}. New data file will be created on save.`, 3000);
                    }
                }
            } else {
                // Using default plugin storage path
                rawLoadedData = await this.loadData(); // This is the plugin's internal save/load
            }

            let loadedSettings = {}; // Start with empty object
            if (rawLoadedData?.settings && typeof rawLoadedData.settings === 'object') {
                // If data was loaded and settings is an object, use its settings
                 loadedSettings = rawLoadedData.settings;
            }
            // Merge defaults, loaded settings, and prioritize localStorage path settings
            this.settings = { ...DEFAULT_SETTINGS, ...loadedSettings };
            if (typeof lsUseCustomPath === 'boolean') {
                 this.settings.useCustomDataPath = lsUseCustomPath;
            }
            if (typeof lsCustomPathRelative === 'string') {
                this.settings.customDataPath = lsCustomPathRelative;
            }


            this.pluginState = { ...DEFAULT_APP_DATA.pluginState };
            if (rawLoadedData?.pluginState) {
                this.pluginState = { ...this.pluginState, ...rawLoadedData.pluginState };
            } else if (rawLoadedData && !rawLoadedData.pluginState && (rawLoadedData as any).schedules) { // Legacy check
                this.pluginState = { ...this.pluginState, ...(rawLoadedData as any) };
            }
            
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

            this.reviewScheduleService.schedules = this.pluginState.schedules || {};
            this.reviewHistoryService.history = this.pluginState.history || [];
            this.reviewSessionService.reviewSessions = this.pluginState.reviewSessions || { sessions: {}, activeSessionId: null };
            this.mcqService.mcqSets = this.pluginState.mcqSets || {};
            this.mcqService.mcqSessions = this.pluginState.mcqSessions || {};
            this.reviewScheduleService.customNoteOrder = this.pluginState.customNoteOrder || [];
            this.reviewScheduleService.lastLinkAnalysisTimestamp = typeof this.pluginState.lastLinkAnalysisTimestamp === 'number' ? this.pluginState.lastLinkAnalysisTimestamp : null;
            
        } catch (error) {
            console.error("Error loading plugin data:", error);
            // Fallback to complete defaults if any error during loading sequence
            console.warn("Spaceforge: loadPluginData caught an error. Re-initializing settings and pluginState to defaults.");
            this.settings = { ...DEFAULT_SETTINGS }; 
            this.pluginState = { ...DEFAULT_PLUGIN_STATE_DATA }; 
            
            // Repopulate services with these fresh defaults
            this.reviewScheduleService.schedules = this.pluginState.schedules || {};
            this.reviewHistoryService.history = this.pluginState.history || [];
            this.reviewSessionService.reviewSessions = this.pluginState.reviewSessions || { sessions: {}, activeSessionId: null };
            this.mcqService.mcqSets = this.pluginState.mcqSets || {};
            this.mcqService.mcqSessions = this.pluginState.mcqSessions || {};
            this.reviewScheduleService.customNoteOrder = this.pluginState.customNoteOrder || [];
            this.reviewScheduleService.lastLinkAnalysisTimestamp = this.pluginState.lastLinkAnalysisTimestamp ?? null;
            
            // Ensure FSRS service is also updated with these default settings
            if (this.reviewScheduleService) {
                this.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
            }
            new Notice("Spaceforge: Error loading data, initialized with defaults.", 5000);
        }
    }

    async savePluginData(): Promise<void> {
        try {
            // Ensure settings object exists and is valid, applying defaults if necessary
            if (!this.settings || typeof this.settings !== 'object') {
                console.warn("Spaceforge: Settings object was invalid, resetting to defaults before save.");
                this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            } else {
                // Ensure all default keys are present
                this.settings = { ...DEFAULT_SETTINGS, ...this.settings };
            }

            // Ensure pluginState object exists
            if (!this.pluginState) {
                console.warn("Spaceforge: pluginState was undefined, initializing to default before save.");
                this.pluginState = { ...DEFAULT_PLUGIN_STATE_DATA };
            }
            
            const currentPluginState: PluginStateData = {
                schedules: this.reviewScheduleService.schedules || {},
                history: this.reviewHistoryService.history || [],
                reviewSessions: this.reviewSessionService.reviewSessions || { sessions: {}, activeSessionId: null },
                mcqSets: this.mcqService.mcqSets || {},
                mcqSessions: this.mcqService.mcqSessions || {},
                customNoteOrder: this.reviewScheduleService.customNoteOrder || [],
                lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp ?? null,
                pomodoroCurrentMode: this.pluginState.pomodoroCurrentMode || DEFAULT_PLUGIN_STATE_DATA.pomodoroCurrentMode,
                pomodoroTimeLeftInSeconds: this.pluginState.pomodoroTimeLeftInSeconds || DEFAULT_PLUGIN_STATE_DATA.pomodoroTimeLeftInSeconds,
                pomodoroSessionsCompletedInCycle: this.pluginState.pomodoroSessionsCompletedInCycle || DEFAULT_PLUGIN_STATE_DATA.pomodoroSessionsCompletedInCycle,
                pomodoroIsRunning: typeof this.pluginState.pomodoroIsRunning === 'boolean' ? this.pluginState.pomodoroIsRunning : DEFAULT_PLUGIN_STATE_DATA.pomodoroIsRunning,
                pomodoroEndTimeMs: this.pluginState.pomodoroEndTimeMs ?? null, // Add the missing field
                version: this.manifest.version,
            };
            this.pluginState = currentPluginState; // Update the live pluginState

            const dataToSave: SpaceforgePluginData = {
                settings: this.settings, // Use the already prepared this.settings
                pluginState: this.pluginState,
            };

            const effectiveSavePath = await this._getEffectiveDataPath();
            const defaultPluginDataPath = this.app.vault.configDir + `/plugins/${this.manifest.id}/data.json`;

            if (effectiveSavePath) {
                // Saving to custom path
                try {
                    const dirPathOnly = effectiveSavePath.substring(0, effectiveSavePath.lastIndexOf('/'));
                    if (dirPathOnly && !(await this.app.vault.adapter.exists(dirPathOnly))) {
                        await this.app.vault.adapter.mkdir(dirPathOnly);
                        new Notice(`Spaceforge: Created directory for custom data: ${dirPathOnly}`, 3000);
                    }
                    await this.app.vault.adapter.write(effectiveSavePath, JSON.stringify(dataToSave, null, 2));
                    // new Notice(`Spaceforge: Data saved to custom path: ${effectiveSavePath}`, 3000); // Removed notice

                    // Migration/Cleanup: If we just successfully saved to a custom path,
                    // and the old default data.json exists, remove it.
                    if (await this.app.vault.adapter.exists(defaultPluginDataPath)) {
                        // Check if this is a migration scenario (old data was loaded and new path was empty)
                        // This check is a bit implicit. A more robust way would be a flag.
                        // For now, if custom path is active and default exists, assume it's post-migration or user switched.
                        await this.app.vault.adapter.remove(defaultPluginDataPath);
                        new Notice(`Spaceforge: Removed old data file from default plugin folder as custom path is active.`, 5000);
                        console.log(`Spaceforge: Removed old data file at ${defaultPluginDataPath}`);
                    }
                } catch (writeError) {
                    console.error(`Error saving data to custom path ${effectiveSavePath}:`, writeError);
                    new Notice(`Error saving data to custom path ${effectiveSavePath}: ${writeError.message}. Falling back to default path for this save.`, 10000);
                    // Fallback save to default location if custom path write fails
                    try {
                        await this.saveData(dataToSave); // Plugin's internal save
                        new Notice(`Spaceforge: Data saved to default plugin folder due to error with custom path.`, 5000);
                    } catch (fallbackError) {
                        console.error(`Error saving data to default location after custom path failed:`, fallbackError);
                        new Notice(`CRITICAL: Spaceforge failed to save data to both custom and default locations.`, 10000);
                    }
                }
            } else {
                // Saving to default plugin storage path
                await this.saveData(dataToSave); // Plugin's internal save
                // new Notice(`Spaceforge: Data saved to default plugin storage.`, 3000); // Removed notice
            }
            
            // Removed localStorage backup for settings as it's not the source of truth for the path anymore.
            // If user wants to backup settings, they can use the export feature.

        } catch (error) {
            console.error("General error in savePluginData:", error);
            new Notice("Error saving Spaceforge data. Check console for details.", 5000);
        }
    }

    async activateSidebarView(): Promise<void> {
        const existingLeaves = this.app.workspace.getLeavesOfType('spaceforge-review-schedule');
        if (existingLeaves.length > 0) {
            // If a sidebar view already exists, reveal the first one found
            this.app.workspace.revealLeaf(existingLeaves[0]);
        } else {
            // If no sidebar view exists, create a new one
            const leaf = this.app.workspace.getRightLeaf(false); // Default to right leaf if creating new
            if (leaf) {
                await leaf.setViewState({
                    type: 'spaceforge-review-schedule',
                    active: true,
                });
                this.app.workspace.revealLeaf(leaf); // Reveal the newly created leaf
            } else {
                console.error("Spaceforge: Could not get a leaf to activate the sidebar view.");
                new Notice("Spaceforge: Could not open sidebar view.");
            }
        }
    }

    addCommands(): void {
        this.addCommand({
            id: 'spaceforge-next-review-note',
            name: 'Next Review Note',
            hotkeys: [{ modifiers: ['Alt', 'Shift'], key: '/' }],
            callback: () => {
                this.navigationController.navigateToNextNote();
            },
        });

        this.addCommand({
            id: 'spaceforge-previous-review-note',
            name: 'Previous Review Note',
            hotkeys: [{ modifiers: ['Alt', 'Shift'], key: '.' }],
            callback: () => {
                this.navigationController.navigateToPreviousNote();
            },
        });

        this.addCommand({
            id: 'spaceforge-review-current-note',
            name: 'Review Current Note',
            hotkeys: [{ modifiers: ['Alt', 'Shift'], key: ',' }],
            callback: () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile instanceof TFile && activeFile.extension === 'md') {
                    this.reviewController.reviewNote(activeFile.path);
                } else {
                    new Notice('No active markdown file to review.');
                }
            },
        });

        this.addCommand({
            id: 'spaceforge-add-current-note-to-review',
            name: 'Add Current Note to Review Schedule',
            hotkeys: [{ modifiers: ['Alt', 'Shift'], key: '\\\\' }],
            callback: () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile instanceof TFile && activeFile.extension === 'md') {
                    this.reviewScheduleService.scheduleNoteForReview(activeFile.path)
                        .then(() => this.savePluginData());
                    new Notice(`Added "${activeFile.path}" to review schedule.`);
                } else {
                    new Notice('No active markdown file to add to review.');
                }
            },
        });

        this.addCommand({
            id: 'spaceforge-add-current-folder-to-review',
            name: "Add Current Note's Folder to Review Schedule",
            hotkeys: [{ modifiers: ['Alt', 'Shift'], key: "'" }],
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile.parent && activeFile.parent instanceof TFolder) {
                    const folder = activeFile.parent;
                    // Use the same logic as the context menu for consistency
                    await this.contextMenuHandler.addFolderToReview(folder);
                } else {
                    new Notice("Could not determine the current note's folder, no active file, or parent is not a folder.");
                }
            },
        });
    }

    addIcons(): void { /* ... */ }

    initializeMCQComponents(): void {
        this.mcqGenerationService = undefined; // Clear previous instance
        this.mcqController = undefined;

        if (this.settings.enableMCQ) {
            console.log('Initializing MCQ components for provider:', this.settings.mcqApiProvider);
            this.mcqGenerationService = this.createMcqGenerationService();
            if (this.mcqGenerationService) {
                // Pass the mcqService for data management, and the new mcqGenerationService for API calls
                this.mcqController = new MCQController(this, this.mcqService, this.mcqGenerationService);
            } else {
                new Notice('MCQ Generation Service could not be initialized. Check API provider settings in Spaceforge settings.');
                console.warn(`Failed to create MCQ generation service for provider: ${this.settings.mcqApiProvider}`);
            }
        }
    }
    
    private createMcqGenerationService(): IMCQGenerationService | undefined {
        switch (this.settings.mcqApiProvider) {
            case ApiProvider.OpenRouter:
                if (!this.settings.openRouterApiKey) {
                    new Notice('OpenRouter API key is not set in Spaceforge settings.');
                    return undefined;
                }
                return new OpenRouterService(this);
            case ApiProvider.OpenAI:
                if (!this.settings.openaiApiKey) {
                    new Notice('OpenAI API key is not set in Spaceforge settings.');
                    return undefined;
                }
                return new OpenAIService(this);
            case ApiProvider.Ollama:
                if (!this.settings.ollamaApiUrl || !this.settings.ollamaModel) {
                    new Notice('Ollama API URL or Model is not set in Spaceforge settings.');
                    return undefined;
                }
                return new OllamaService(this);
            case ApiProvider.Gemini:
                if (!this.settings.geminiApiKey) {
                    new Notice('Gemini API key is not set in Spaceforge settings.');
                    return undefined;
                }
                return new GeminiService(this);
            case ApiProvider.Claude:
                if (!this.settings.claudeApiKey || !this.settings.claudeModel) {
                    new Notice('Claude API key or Model is not set in Spaceforge settings.');
                    return undefined;
                }
                return new ClaudeService(this);
            case ApiProvider.Together:
                if (!this.settings.togetherApiKey || !this.settings.togetherModel) {
                    new Notice('Together AI API key or Model is not set in Spaceforge settings.');
                    return undefined;
                }
                return new TogetherService(this);
            default:
                // It's good practice to handle unexpected enum values, even if TypeScript provides some safety.
                // This could happen if settings data is corrupted or from an older version.
                // const exhaustiveCheck: never = this.settings.mcqApiProvider; // This will cause a type error now, which is good!
                new Notice(`Unsupported MCQ API provider selected: ${this.settings.mcqApiProvider}`);
                console.error(`Unsupported MCQ API provider: ${this.settings.mcqApiProvider}`);
                return undefined;
        }
    }

    async checkForDueNotes(): Promise<void> { /* ... */ }
    private addStylesheet(): void { /* ... */ }
    async exportPluginData(): Promise<void> { /* ... */ }
    async importPluginData(fileContent: string): Promise<void> { /* ... */ }
}
