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
import { CalendarEventService } from './services/calendar-event-service';

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
    calendarEventService: CalendarEventService;


    private readonly stylesheetPath: string = "styles.css";
    private readonly stylesheetId: string = "spaceforge-styles";
    private lastStylesModTime: number | null = null;
    private cssHotReloadIntervalId: number | null = null;
    private beforeUnloadHandler: (event: Event) => void; // Declared as a class property

    reviewController: ReviewController;
    navigationController: ReviewNavigationController;
    sessionController: ReviewSessionController;
    batchController: ReviewBatchController;
    mcqController: MCQController | undefined;
    mcqGenerationService: IMCQGenerationService | undefined; // Changed from openRouterService
    contextMenuHandler: ContextMenuHandler;
    // sidebarView: ReviewSidebarView; // Avoid storing direct references to views
    public clickedDateFromCalendar: Date | null = null;
    events: EventEmitter;

    async onload(): Promise<void> {
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
        
        // Initialize CalendarEventService after settings are loaded
        this.calendarEventService = new CalendarEventService();
        const eventsArray = Object.values(this.pluginState.calendarEvents);
        this.calendarEventService.initialize(eventsArray);




        this.registerView(
            'spaceforge-review-schedule',
            (leaf) => new ReviewSidebarView(leaf, this)
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
            callback: async () => {
                const fileExplorerLeaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
                const viewWithFile = fileExplorerLeaf?.view as { file?: TFile };
                if (viewWithFile?.file) {
                    const selectedFile = viewWithFile.file;
                    if (selectedFile instanceof TFile && selectedFile.extension === 'md') {
                        await this.reviewScheduleService.scheduleNoteForReview(selectedFile.path);
                        await this.savePluginData();
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
            this.getSidebarView()?.refresh();
        }));
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (file instanceof TFile && file.extension === "md") {
                this.reviewScheduleService.handleNoteRename(oldPath, file.path);
                await this.savePluginData();
            }
            this.getSidebarView()?.refresh();
        }));

        this.registerInterval(window.setInterval(() => {
            this.getSidebarView()?.refresh();
        }, 60 * 1000));

        // this.app.workspace.onLayoutReady(() => this.activateSidebarView()); // Removed automatic activation
        this.addStylesheet();

        if (this.app.vault.adapter.stat && typeof this.app.vault.adapter.stat === 'function') {
            this.cssHotReloadIntervalId = window.setInterval(async () => {
                try {
                    const stats = await this.app.vault.adapter.stat(this.stylesheetPath);
                    if (stats && (this.lastStylesModTime === null || this.lastStylesModTime < stats.mtime)) {
                        this.lastStylesModTime = stats.mtime;
                        this.addStylesheet();
                    }
                } catch (error) { /* handle error */ }
            }, 1000);
            this.registerInterval(this.cssHotReloadIntervalId);
        }

        if (this.settings.notifyBeforeDue > 0) {
            this.registerInterval(window.setInterval(() => this.checkForDueNotes(), 5 * 60 * 1000));
        }

        this.registerInterval(window.setInterval(async () => {
            await this.savePluginData();
            // Removed specific openRouterApiKey backup from here, handled by general settings save.
        }, 5 * 60 * 1000));

        this.beforeUnloadHandler = (event) => {
            let existingData = {};
            try {
                const loadedData = this.loadData();
                 if (loadedData && !(loadedData instanceof Promise)) {
                     existingData = loadedData;
                 } else if (loadedData instanceof Promise) {
                 }
            } catch (loadError) { /* handle error */ }

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
                this.app.saveLocalStorage('spaceforge-backup', backupStr);
                (async () => {
                    try {
                        await this.savePluginData();
                    } catch (e) { /* handle error */ }
                })();
            } catch (error) {
                try {
                    const minimalBackup = JSON.stringify({ settings: this.settings, reviewData: { schedules: this.reviewScheduleService.schedules || {}, customNoteOrder: this.reviewScheduleService.customNoteOrder || [], lastLinkAnalysisTimestamp: this.reviewScheduleService.lastLinkAnalysisTimestamp, version: this.manifest.version }});
                    this.app.saveLocalStorage('spaceforge-minimal-backup', minimalBackup);
                } catch (minimalError) { /* handle error */ }
            }
        }; // Removed the extra closing parenthesis and semicolon, and moved the declaration.
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }

    async onunload(): Promise<void> {
        if (this.cssHotReloadIntervalId !== null) {
            window.clearInterval(this.cssHotReloadIntervalId);
            this.cssHotReloadIntervalId = null;
        }
        const styleEl = document.getElementById(this.stylesheetId);
        if (styleEl) styleEl.remove();

        // Explicitly remove the global event listener
        if (this.beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this.beforeUnloadHandler);
        }

        let existingData: Partial<SpaceforgePluginData> = {};
        try { 
            const loaded = await this.loadData();
            if (loaded) {
                existingData = loaded;
            }
        }
        catch (loadError) { /* handle error */ }

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
            this.app.saveLocalStorage('spaceforge-backup', backupStr);
        } catch (backupError) { /* handle error */ }

        try {
            await this.savePluginData();
        } catch (error) { /* handle error */ }

        if (this.pomodoroService) this.pomodoroService.destroy();
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
                const file = this.app.vault.getAbstractFileByPath(effectivePath);
                if (file instanceof TFile) {
                    const jsonData = await this.app.vault.read(file);
                    if (jsonData) rawLoadedData = JSON.parse(jsonData);
                    new Notice(`Spaceforge: Loaded data from custom path: ${effectivePath}`, 3000);
                } else {
                    // Custom path specified but file doesn't exist.
                    // Check if old default data.json exists for migration.
                    const oldFile = this.app.vault.getAbstractFileByPath(defaultPluginDataPath);
                    if (oldFile instanceof TFile) {
                        new Notice(`Spaceforge: Custom data file not found at ${effectivePath}. Attempting to migrate from default location.`, 5000);
                        try {
                            const oldJsonData = await this.app.vault.read(oldFile);
                            if (oldJsonData) {
                                rawLoadedData = JSON.parse(oldJsonData);
                                // Data will be saved to new path by savePluginData later
                            }
                        } catch (migrationReadError) { /* handle error */ }
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
            } else if (rawLoadedData && !rawLoadedData.pluginState && (rawLoadedData as Partial<PluginStateData>).schedules) { // Legacy check
                this.pluginState = { ...this.pluginState, ...(rawLoadedData as Partial<PluginStateData>) };
            }
            
            // Ensure calendarEvents exists for legacy data
            if (!this.pluginState.calendarEvents) {
                this.pluginState.calendarEvents = {};
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
            console.error("Spaceforge: Error loading data:", error);
            
            // SIMPLE RECOVERY: Try localStorage backup once, then use defaults
            try {
                const backupData = await this.app.loadLocalStorage('spaceforge-backup');
                if (backupData && typeof backupData === 'string') {
                    const parsedBackup = JSON.parse(backupData);
                    if (parsedBackup.reviewData) {
                        this.settings = { ...DEFAULT_SETTINGS, ...parsedBackup.settings };
                        this.pluginState = { ...DEFAULT_PLUGIN_STATE_DATA, ...parsedBackup.reviewData };
                        new Notice("Spaceforge: Recovered data from backup.", 5000);
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
                new Notice("Spaceforge: Error loading data. Using defaults to prevent crash.", 5000);
            }
            
            // Repopulate services
            this.reviewScheduleService.schedules = this.pluginState.schedules || {};
            this.reviewHistoryService.history = this.pluginState.history || [];
            this.reviewSessionService.reviewSessions = this.pluginState.reviewSessions || { sessions: {}, activeSessionId: null };
            this.mcqService.mcqSets = this.pluginState.mcqSets || {};
            this.mcqService.mcqSessions = this.pluginState.mcqSessions || {};
            this.reviewScheduleService.customNoteOrder = this.pluginState.customNoteOrder || [];
            this.reviewScheduleService.lastLinkAnalysisTimestamp = this.pluginState.lastLinkAnalysisTimestamp ?? null;
            
            if (this.reviewScheduleService) {
                this.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
            }
        }
    }

    async savePluginData(): Promise<void> {
        try {
            // Ensure settings object exists and is valid, applying defaults if necessary
            if (!this.settings || typeof this.settings !== 'object') {
                this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
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
                    if (dirPathOnly && !this.app.vault.getAbstractFileByPath(dirPathOnly)) {
                        await this.app.vault.createFolder(dirPathOnly);
                        new Notice(`Spaceforge: Created directory for custom data: ${dirPathOnly}`, 3000);
                    }
                    
                    // SIMPLE SAVE: Use Obsidian's standard file operations
                    const file = this.app.vault.getAbstractFileByPath(effectiveSavePath);
                    if (file instanceof TFile) {
                        await this.app.vault.modify(file, JSON.stringify(dataToSave, null, 2));
                    } else {
                        await this.app.vault.create(effectiveSavePath, JSON.stringify(dataToSave, null, 2));
                    }
                    // new Notice(`Spaceforge: Data saved to custom path: ${effectiveSavePath}`, 3000); // Removed notice

                    // Migration/Cleanup: If we just successfully saved to a custom path,
                    // and the old default data.json exists, KEEP IT as backup for safety.
                    // CRITICAL FIX: Never automatically delete user data to prevent data loss during reloads
                    const oldFile = this.app.vault.getAbstractFileByPath(defaultPluginDataPath);
                    if (oldFile instanceof TFile) {
                        // Instead of deleting, we'll keep the old file as a backup
                        // Users can manually clean it up later if needed
                        new Notice(`Spaceforge: Successfully saved to custom path. Original data file kept as backup for safety.`, 5000);
                    }
                } catch (writeError) {
                    new Notice(`Error saving data to custom path ${effectiveSavePath}: ${writeError.message}. Falling back to default path for this save.`, 10000);
                    // Fallback save to default location if custom path write fails
                    try {
                        await this.saveData(dataToSave); // Plugin's internal save
                        new Notice(`Spaceforge: Data saved to default plugin folder due to error with custom path.`, 5000);
                    } catch (fallbackError) {
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
                new Notice("Spaceforge: Could not open sidebar view.");
            }
        }
    }

    addCommands(): void {
        this.addCommand({
            id: 'spaceforge-next-review-note',
            name: 'Next Review Note',
            callback: () => {
                this.navigationController.navigateToNextNote();
            },
        });

        this.addCommand({
            id: 'spaceforge-previous-review-note',
            name: 'Previous Review Note',
            callback: () => {
                this.navigationController.navigateToPreviousNote();
            },
        });

        this.addCommand({
            id: 'spaceforge-review-current-note',
            name: 'Review Current Note',
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
            callback: async () => {
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile instanceof TFile && activeFile.extension === 'md') {
                    await this.reviewScheduleService.scheduleNoteForReview(activeFile.path);
                    await this.savePluginData();
                    new Notice(`Added "${activeFile.path}" to review schedule.`);
                } else {
                    new Notice('No active markdown file to add to review.');
                }
            },
        });

        this.addCommand({
            id: 'spaceforge-add-current-folder-to-review',
            name: "Add Current Note's Folder to Review Schedule",
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
            this.mcqGenerationService = this.createMcqGenerationService();
            if (this.mcqGenerationService) {
                // Pass the mcqService for data management, and the new mcqGenerationService for API calls
                this.mcqController = new MCQController(this, this.mcqService, this.mcqGenerationService);
            } else {
                new Notice('MCQ Generation Service could not be initialized. Check API provider settings in Spaceforge settings.');
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
                return undefined;
        }
    }

    async checkForDueNotes(): Promise<void> { /* ... */ }
    private addStylesheet(): void { /* ... */ }
    async exportPluginData(): Promise<void> { /* ... */ }
    async importPluginData(fileContent: string): Promise<void> { /* ... */ }

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
