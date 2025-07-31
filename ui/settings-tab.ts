import { App, Notice, PluginSettingTab, Setting, setIcon, TextAreaComponent } from 'obsidian'; // Added TextAreaComponent
import SpaceforgePlugin from '../main';
// Import ApiProvider, DEFAULT_SETTINGS, SpaceforgeSettings, and MCQQuestionAmountMode
import { ApiProvider, DEFAULT_SETTINGS, SpaceforgeSettings, MCQQuestionAmountMode } from '../models/settings'; 
import { SpaceforgePluginData, DEFAULT_APP_DATA, DEFAULT_PLUGIN_STATE_DATA } from '../models/plugin-data'; // Import data structures

/**
 * Settings tab for the plugin
 */
export class SpaceforgeSettingTab extends PluginSettingTab {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;
    
    /**
     * Initialize settings tab
     * 
     * @param app Obsidian app
     * @param plugin Reference to the main plugin
     */
    constructor(app: App, plugin: SpaceforgePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    
    /**
     * Display settings
     */
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        
        containerEl.createEl('h2', { text: 'Spaceforge Settings' });
        
        // Add a utility for creating collapsible sections
        const createCollapsible = (title: string, iconName: string, defaultOpen = true) => {
            // Create section container
            const sectionContainer = containerEl.createEl('div', { cls: 'sf-settings-section' });
            
            // Create header
            const header = sectionContainer.createEl('div', { cls: 'sf-settings-section-header' });
            
            // Add icon
            if (iconName) {
                const iconEl = header.createEl('span', { cls: 'sf-settings-icon' });
                setIcon(iconEl, iconName);
            }
            
            // Add title and collapse indicator
            header.createEl('h3', { text: title });
            const collapseIndicator = header.createEl('span', { 
                cls: 'sf-settings-collapse-indicator',
                text: defaultOpen ? '▾' : '▸'
            });
            
            // Create content container
            const contentContainer = sectionContainer.createEl('div', { 
                cls: 'sf-settings-section-content'
            });
            
            // Initially hide if not defaultOpen
            if (!defaultOpen) {
                contentContainer.style.display = 'none';
            }
            
            // Add click handler for toggling
            header.addEventListener('click', () => {
                const isVisible = contentContainer.style.display !== 'none';
                contentContainer.style.display = isVisible ? 'none' : 'block';
                collapseIndicator.textContent = isVisible ? '▸' : '▾';
            });
            
            return contentContainer;
        };
        
        // We'll rely on the CSS in the styles.css file instead of inline styles
        
        // Create action buttons for global data operations
        const createActionButtons = () => {
            const actionsContainer = containerEl.createEl('div', { cls: 'sf-settings-actions' });
            
            // Export all data button
            const exportBtn = actionsContainer.createEl('button', { text: 'Export All Data' });
            exportBtn.addEventListener('click', () => {
                // Construct the full plugin data for export
                const pluginStateToExport = {
                    schedules: this.plugin.reviewScheduleService.schedules,
                    history: this.plugin.reviewHistoryService.history,
                    reviewSessions: this.plugin.reviewSessionService.reviewSessions,
                    mcqSets: this.plugin.mcqService.mcqSets,
                    mcqSessions: this.plugin.mcqService.mcqSessions,
                    customNoteOrder: this.plugin.reviewScheduleService.customNoteOrder,
                    lastLinkAnalysisTimestamp: this.plugin.reviewScheduleService.lastLinkAnalysisTimestamp,
                    version: this.plugin.manifest.version,
                    pomodoroCurrentMode: this.plugin.pluginState.pomodoroCurrentMode,
                    pomodoroTimeLeftInSeconds: this.plugin.pluginState.pomodoroTimeLeftInSeconds,
                    pomodoroSessionsCompletedInCycle: this.plugin.pluginState.pomodoroSessionsCompletedInCycle,
                    pomodoroIsRunning: this.plugin.pluginState.pomodoroIsRunning,
                    pomodoroEndTimeMs: this.plugin.pluginState.pomodoroEndTimeMs ?? null, // Add the missing field
                };

                const dataToExport: SpaceforgePluginData = {
                    settings: this.plugin.settings,
                    pluginState: pluginStateToExport
                };
                const dataJson = JSON.stringify(dataToExport, null, 2);
                const blob = new Blob([dataJson], { type: 'application/json' });
                
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'spaceforge-data.json'; // Changed filename
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                
                new Notice('All plugin data exported successfully');
            });
            
            // Import all data button
            const importBtn = actionsContainer.createEl('button', { text: 'Import All Data' });
            importBtn.addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'application/json';
                
                input.onchange = async (e: Event) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) {
                        try {
                            const text = await file.text();
                            const importedFullData = JSON.parse(text) as SpaceforgePluginData;
                            
                            if (!importedFullData || typeof importedFullData.settings !== 'object' || typeof importedFullData.pluginState !== 'object') {
                                throw new Error('Invalid data file format. Expected settings and pluginState properties.');
                            }
                            
                            // Apply imported settings, ensuring all defaults are present
                            this.plugin.settings = { ...DEFAULT_SETTINGS, ...importedFullData.settings };
                            
                            // Apply imported plugin state, ensuring all defaults are present
                            this.plugin.pluginState = { ...DEFAULT_PLUGIN_STATE_DATA, ...importedFullData.pluginState };

                            // Repopulate services from the newly loaded pluginState
                            this.plugin.reviewScheduleService.schedules = this.plugin.pluginState.schedules || {};
                            this.plugin.reviewHistoryService.history = this.plugin.pluginState.history || [];
                            this.plugin.reviewSessionService.reviewSessions = this.plugin.pluginState.reviewSessions || { sessions: {}, activeSessionId: null };
                            this.plugin.mcqService.mcqSets = this.plugin.pluginState.mcqSets || {};
                            this.plugin.mcqService.mcqSessions = this.plugin.pluginState.mcqSessions || {};
                            this.plugin.reviewScheduleService.customNoteOrder = this.plugin.pluginState.customNoteOrder || [];
                            this.plugin.reviewScheduleService.lastLinkAnalysisTimestamp = typeof this.plugin.pluginState.lastLinkAnalysisTimestamp === 'number' ? this.plugin.pluginState.lastLinkAnalysisTimestamp : null;
                            
                            // Pomodoro state update
                            this.plugin.pomodoroService?.onSettingsChanged(); // To re-evaluate durations if they changed from settings
                            this.plugin.pomodoroService?.reinitializeTimerFromState(); // To correctly start/stop timer based on imported state


                            // Re-initialize MCQ components if settings related to them changed
                            this.plugin.initializeMCQComponents();

                            await this.plugin.savePluginData(); // Save the fully imported data
                            
                            this.display(); // Refresh settings display
                            
                            new Notice('All plugin data imported successfully. Plugin may require a reload for all changes to take effect.');
                        } catch (error) {
                            console.error('Failed to import data:', error);
                            new Notice(`Failed to import data: ${error.message}`);
                        }
                    }
                };
                input.click();
            });
            
            // Reset to defaults button
            const resetBtn = actionsContainer.createEl('button', { text: 'Reset to Defaults' });
            resetBtn.addEventListener('click', async () => {
                const confirmed = confirm('Are you sure you want to reset all plugin data (settings and state) to defaults? This cannot be undone.');
                
                if (confirmed) {
                    // Apply default settings and default plugin state
                    this.plugin.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
                    this.plugin.pluginState = JSON.parse(JSON.stringify(DEFAULT_PLUGIN_STATE_DATA));

                    // Repopulate services with defaults
                    this.plugin.reviewScheduleService.schedules = this.plugin.pluginState.schedules;
                    this.plugin.reviewHistoryService.history = this.plugin.pluginState.history;
                    this.plugin.reviewSessionService.reviewSessions = this.plugin.pluginState.reviewSessions;
                    this.plugin.mcqService.mcqSets = this.plugin.pluginState.mcqSets;
                    this.plugin.mcqService.mcqSessions = this.plugin.pluginState.mcqSessions;
                    this.plugin.reviewScheduleService.customNoteOrder = this.plugin.pluginState.customNoteOrder;
                    this.plugin.reviewScheduleService.lastLinkAnalysisTimestamp = this.plugin.pluginState.lastLinkAnalysisTimestamp ?? null;
                    
                    this.plugin.pomodoroService?.onSettingsChanged(); // Reset pomodoro service state based on default settings
                    this.plugin.pomodoroService?.reinitializeTimerFromState(); // Reset pomodoro service timer based on default state


                    // Re-initialize MCQ components based on default settings
                    this.plugin.initializeMCQComponents();

                    await this.plugin.savePluginData(); // Save the complete default data
                    
                    this.display(); // Refresh settings display
                    
                    new Notice('All plugin data reset to defaults.');
                }
            });

            // Clear Schedule Data button
            const clearScheduleBtn = actionsContainer.createEl('button', { 
                text: 'Clear All Schedule Data', 
                cls: 'sf-button-danger' // Optional: Add a class for dangerous actions
            });
            clearScheduleBtn.addEventListener('click', async () => {
                const confirmed = confirm('Are you sure you want to clear all review schedules, history, and session data? This action cannot be undone.');
                if (confirmed) {
                    try {
                        // Reset schedule-related parts of pluginState
                        this.plugin.pluginState.schedules = { ...DEFAULT_PLUGIN_STATE_DATA.schedules };
                        this.plugin.pluginState.history = [...DEFAULT_PLUGIN_STATE_DATA.history];
                        this.plugin.pluginState.reviewSessions = { ...DEFAULT_PLUGIN_STATE_DATA.reviewSessions };
                        this.plugin.pluginState.customNoteOrder = [...DEFAULT_PLUGIN_STATE_DATA.customNoteOrder];
                        // Potentially mcqSets and mcqSessions if they are tied to notes that might be unscheduled
                        // For now, focusing on explicit schedule data as requested.

                        // Update services
                        this.plugin.reviewScheduleService.schedules = this.plugin.pluginState.schedules;
                        this.plugin.reviewHistoryService.history = this.plugin.pluginState.history;
                        this.plugin.reviewSessionService.reviewSessions = this.plugin.pluginState.reviewSessions;
                        this.plugin.reviewScheduleService.customNoteOrder = this.plugin.pluginState.customNoteOrder;

                        // Explicitly update the review controller's state
                        if (this.plugin.reviewController) {
                            await this.plugin.reviewController.updateTodayNotes();
                        }

                        // Emit an event that the sidebar might be listening to
                        if (this.plugin.events) {
                            this.plugin.events.emit('sidebar-update');
                        }
                        
                        // If mcq data should also be cleared when schedules are cleared:
                        // this.plugin.pluginState.mcqSets = { ...DEFAULT_PLUGIN_STATE_DATA.mcqSets };
                        // this.plugin.pluginState.mcqSessions = { ...DEFAULT_PLUGIN_STATE_DATA.mcqSessions };
                        // this.plugin.mcqService.mcqSets = this.plugin.pluginState.mcqSets;
                        // this.plugin.mcqService.mcqSessions = this.plugin.pluginState.mcqSessions;

                        // Save the cleared data first
                        await this.plugin.savePluginData();
                        
                        new Notice('All schedule data cleared successfully.');

                        // Then refresh UI elements
                        this.display(); // Refresh settings UI
                        if (this.plugin.sidebarView) {
                            this.plugin.sidebarView.refresh();
                        }

                    } catch (error) {
                        console.error('Failed to clear schedule data:', error);
                        new Notice('Failed to clear schedule data. Check console for details.');
                    }
                }
            });
            
            return actionsContainer;
        };
        
        // ========= SPACED REPETITION SECTION =========
        const spacedRepSection = createCollapsible('Spaced Repetition', 'calendar-clock', true);

        // --- Algorithm Selection ---
        // Changed to h3 and removed sf-settings-subsection class for potentially better contrast
        spacedRepSection.createEl('h3', { text: 'Algorithm Configuration' });

        const algoSelectionSetting = new Setting(spacedRepSection)
            .setName('Default scheduling algorithm')
            .setDesc('Choose the default algorithm for newly created notes.')
            .addDropdown(dropdown => dropdown
                .addOption('sm2', 'SM-2')
                .addOption('fsrs', 'FSRS')
                .setValue(this.plugin.settings.defaultSchedulingAlgorithm)
                .onChange(async (value: 'sm2' | 'fsrs') => {
                    this.plugin.settings.defaultSchedulingAlgorithm = value;
                    await this.plugin.savePluginData();
                    this.display(); // Re-render to update the "About" section and parameter visibility
                }));

        // --- Dynamic "About Algorithm" Section ---
        const aboutAlgoContainer = spacedRepSection.createEl('div', { cls: 'sf-info-box sf-algo-about-box' });
        this.renderAboutAlgorithmSection(aboutAlgoContainer, this.plugin.settings.defaultSchedulingAlgorithm);

        // --- SM-2 Parameters ---
        const sm2ParamsContainer = spacedRepSection.createEl('details', { cls: 'sf-settings-collapsible-subsection' });
        const sm2Summary = sm2ParamsContainer.createEl('summary');
        // Changed to h3
        sm2Summary.createEl('h3', { text: 'SM-2 Parameters' });
        sm2ParamsContainer.open = false; // Initially closed


        new Setting(sm2ParamsContainer)
            .setName('SM-2: Base ease factor')
            .setDesc('Initial ease factor for new SM-2 notes (2.5 is SM-2 default). Higher ease increases interval growth. Value shown is internal format (250 = 2.5).')
            .addSlider(slider => slider
                .setLimits(130, 500, 10) 
                .setValue(this.plugin.settings.baseEase)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.baseEase = value;
                    await this.plugin.savePluginData();
                }));
        
        new Setting(sm2ParamsContainer)
            .setName('SM-2: Use initial learning schedule')
            .setDesc('For new SM-2 notes, use a fixed set of initial intervals before applying the full algorithm.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useInitialSchedule)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.useInitialSchedule = value;
                    await this.plugin.savePluginData();
                    this.display(); 
                }));

        if (this.plugin.settings.useInitialSchedule) {
            new Setting(sm2ParamsContainer)
                .setName('SM-2: Custom initial intervals (days)')
                .setDesc('Comma-separated list for initial SM-2 reviews (e.g., 0,1,3,7). Must start with 0.')
                .addText(text => text
                    .setValue(this.plugin.settings.initialScheduleCustomIntervals.join(', '))
                    .onChange(async (value: string) => {
                        const intervals = value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 0);
                        if (intervals.length > 0 && intervals[0] === 0) {
                            this.plugin.settings.initialScheduleCustomIntervals = intervals;
                            await this.plugin.savePluginData();
                        } else {
                            new Notice("Custom initial SM-2 intervals must start with 0 and be valid numbers.", 5000);
                            text.setValue(this.plugin.settings.initialScheduleCustomIntervals.join(', '));
                        }
                    }));
        }
        
        new Setting(sm2ParamsContainer)
            .setName('SM-2: Maximum interval (days)')
            .setDesc('Longest possible interval between SM-2 reviews.')
            .addText(text => text
                .setValue(this.plugin.settings.maximumInterval.toString())
                .onChange(async (value: string) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        this.plugin.settings.maximumInterval = numValue;
                        await this.plugin.savePluginData();
                    }
                }));
        
        new Setting(sm2ParamsContainer)
            .setName('SM-2: Load balancing')
            .setDesc('Add slight randomness to SM-2 intervals to prevent reviews clumping on the same day.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.loadBalance)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.loadBalance = value;
                    await this.plugin.savePluginData();
                }));

        // --- FSRS Parameters ---
        const fsrsParamsContainer = spacedRepSection.createEl('details', { cls: 'sf-settings-collapsible-subsection' });
        const fsrsSummary = fsrsParamsContainer.createEl('summary');
        // Changed to h3
        fsrsSummary.createEl('h3', { text: 'FSRS Parameters' });
        fsrsParamsContainer.open = false; // Initially closed

        new Setting(fsrsParamsContainer)
            .setName('Request Retention')
            .setDesc('Desired recall probability (0.7-0.99, default: 0.9). Higher values mean more frequent reviews.')
            .addText(text => text
                .setValue(this.plugin.settings.fsrsParameters?.request_retention?.toString() ?? DEFAULT_SETTINGS.fsrsParameters.request_retention!.toString())
                .onChange(async (value) => {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue) && numValue >= 0.7 && numValue <= 0.99) {
                        this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, request_retention: numValue };
                        await this.plugin.savePluginData();
                        this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                    } else {
                        new Notice("FSRS Request Retention must be between 0.7 and 0.99.");
                    }
                }));

        new Setting(fsrsParamsContainer)
            .setName('Maximum Interval (days)')
            .setDesc('Longest possible interval FSRS will schedule.')
            .addText(text => text
                .setValue(this.plugin.settings.fsrsParameters?.maximum_interval?.toString() ?? DEFAULT_SETTINGS.fsrsParameters.maximum_interval!.toString())
                .onChange(async (value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, maximum_interval: numValue };
                        await this.plugin.savePluginData();
                        this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                    } else {
                        new Notice("FSRS Maximum Interval must be a positive number.");
                    }
                }));
        
        new Setting(fsrsParamsContainer)
            .setName('Learning Steps (minutes)')
            .setDesc('Comma-separated initial learning intervals in minutes (e.g., 1,10 for 1m, 10m).')
            .addText(text => text
                .setValue(this.plugin.settings.fsrsParameters?.learning_steps?.join(',') ?? DEFAULT_SETTINGS.fsrsParameters.learning_steps!.join(','))
                .onChange(async (value) => {
                    const steps = value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
                    if (steps.length > 0) { // Allow empty to use FSRS internal defaults if any
                        this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, learning_steps: steps };
                        await this.plugin.savePluginData();
                        this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                    } else if (value.trim() === "") { // Allow clearing to use FSRS defaults
                         this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, learning_steps: [] };
                         await this.plugin.savePluginData();
                         this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                    }else {
                        new Notice("FSRS Learning Steps must be valid comma-separated numbers > 0, or empty.");
                    }
                }));

        new Setting(fsrsParamsContainer)
            .setName('Enable Fuzz')
            .setDesc('Add slight randomness to FSRS intervals (recommended).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.fsrsParameters?.enable_fuzz ?? DEFAULT_SETTINGS.fsrsParameters.enable_fuzz!)
                .onChange(async (value) => {
                    this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, enable_fuzz: value };
                    await this.plugin.savePluginData();
                    this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                }));

        new Setting(fsrsParamsContainer)
            .setName('Enable Short Term Scheduling')
            .setDesc('Use FSRS short-term memory model (affects initial learning steps).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.fsrsParameters?.enable_short_term ?? DEFAULT_SETTINGS.fsrsParameters.enable_short_term!)
                .onChange(async (value) => {
                    this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, enable_short_term: value };
                    await this.plugin.savePluginData();
                    this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                }));
        
        new Setting(fsrsParamsContainer)
            .setName('Weights (W)')
            .setDesc('FSRS algorithm parameters (17 numbers). Edit with caution. Default weights are generally good.')
            .addTextArea(text => {
                text.inputEl.rows = 3;
                text.inputEl.style.width = "100%"; // Ensure it takes full width
                text.setValue(this.plugin.settings.fsrsParameters?.w?.join(',') ?? DEFAULT_SETTINGS.fsrsParameters.w!.join(','))
                    .onChange(async (value) => {
                        const weights = value.split(',').map(s => parseFloat(s.trim()));
                        if (weights.length === 17 && weights.every(n => !isNaN(n))) {
                            this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, w: weights };
                            await this.plugin.savePluginData();
                            this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                        } else {
                            new Notice("FSRS Weights must be a comma-separated list of 17 valid numbers.");
                        }
                    });
            });

        // --- Card Conversion Utilities ---
        const conversionContainer = spacedRepSection.createEl('details', { cls: 'sf-settings-collapsible-subsection' });
        const conversionSummary = conversionContainer.createEl('summary');
        // Changed to h3
        conversionSummary.createEl('h3', { text: 'Card Conversion Utilities' });
        conversionContainer.open = false; // Initially closed

        new Setting(conversionContainer)
            .setName('Convert all SM-2 cards to FSRS')
            .setDesc('Migrate all existing SM-2 cards to use the FSRS algorithm. This will reset their learning state for FSRS.')
            .addButton(button => button
                .setButtonText('Convert SM-2 to FSRS')
                .setCta() // Call to action style
                .onClick(async () => {
                    const confirmed = confirm('Are you sure you want to convert ALL SM-2 cards to FSRS? Their FSRS learning state will be reset. This action cannot be easily undone.');
                    if (confirmed) {
                        new Notice('Converting SM-2 cards to FSRS... This may take a moment.');
                        await this.plugin.reviewScheduleService.convertAllSm2ToFsrs();
                        await this.plugin.savePluginData();
                        new Notice('All SM-2 cards have been converted to FSRS.');
                        this.display(); // Refresh settings tab
                    }
                }));

        new Setting(conversionContainer)
            .setName('Convert all FSRS cards to SM-2')
            .setDesc('Migrate all existing FSRS cards to use the SM-2 algorithm. Their SM-2 learning state will be initialized with defaults.')
            .addButton(button => button
                .setButtonText('Convert FSRS to SM-2')
                .setCta()
                .onClick(async () => {
                    const confirmed = confirm('Are you sure you want to convert ALL FSRS cards to SM-2? Their SM-2 learning state will be reset to defaults. This action cannot be easily undone.');
                    if (confirmed) {
                        new Notice('Converting FSRS cards to SM-2... This may take a moment.');
                        await this.plugin.reviewScheduleService.convertAllFsrsToSm2();
                        await this.plugin.savePluginData();
                        new Notice('All FSRS cards have been converted to SM-2.');
                        this.display(); // Refresh settings tab
                    }
                }));
        
        // ========= INTERFACE SECTION =========
        const interfaceSection = createCollapsible('Interface & Behavior', 'settings', false); // Closed by default
        
        new Setting(interfaceSection)
            .setName("Display Settings")
            .setHeading()
            .setClass("sf-settings-subsection-header"); // Add a class for potential specific styling

        new Setting(interfaceSection)
            .setName('Default view type')
            .setDesc('Choose between list or calendar for the review sidebar')
            .addDropdown(dropdown => dropdown
                .addOption('list', 'List view')
                .addOption('calendar', 'Calendar view')
                .setValue(this.plugin.settings.sidebarViewType)
                .onChange(async (value: 'list' | 'calendar') => {
                    this.plugin.settings.sidebarViewType = value;
                    await this.plugin.savePluginData();
                    if (this.plugin.sidebarView) {
                        this.plugin.sidebarView.refresh();
                    }
                }));
        
        new Setting(interfaceSection)
            .setName('Show navigation notifications')
            .setDesc('Display notifications when moving between notes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showNavigationNotifications)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.showNavigationNotifications = value;
                    await this.plugin.savePluginData();
                }));
        
        new Setting(interfaceSection)
            .setName("Review Behavior")
            .setHeading()
            .setClass("sf-settings-subsection-header");

        new Setting(interfaceSection)
            .setName('Include subfolders')
            .setDesc('When adding a folder to review, include all notes in subfolders')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeSubfolders)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.includeSubfolders = value;
                    await this.plugin.savePluginData();
                }));
                
        new Setting(interfaceSection)
            .setName('Notification time')
            .setDesc('Minutes before due time to notify about upcoming reviews (0 to disable)')
            .addText(text => text
                .setValue(this.plugin.settings.notifyBeforeDue.toString())
                .onChange(async (value: string) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue >= 0) {
                        this.plugin.settings.notifyBeforeDue = numValue;
                        await this.plugin.savePluginData();
                    }
                }));
        
        new Setting(interfaceSection)
            .setName('Reading speed (WPM)')
            .setDesc('Words per minute for estimating review time')
            .addSlider(slider => slider
                .setLimits(100, 500, 10)
                .setValue(this.plugin.settings.readingSpeed)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.readingSpeed = value;
                    await this.plugin.savePluginData();
                }));
        
        interfaceSection.createEl('div', { cls: 'sf-setting-explain', 
            text: 'Average adults read 200-250 WPM for regular content, 100-150 WPM for technical content' 
        });
        
        // ========= MCQ SECTION =========
        const mcqSection = createCollapsible('Multiple Choice Questions', 'newspaper', false); // Closed by default
        
        new Setting(mcqSection)
            .setName('Enable MCQ feature')
            .setDesc('Use AI-generated multiple-choice questions to test your knowledge')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMCQ)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.enableMCQ = value;
                    await this.plugin.savePluginData();
                    
                    // Reinitialize MCQ components
                    this.plugin.initializeMCQComponents();
                    
                    // Update the API settings backup when enabling/disabling MCQ
                    try {
                        const apiSettings = {
                            openRouterApiKey: this.plugin.settings.openRouterApiKey,
                            enableMCQ: value,
                            openRouterModel: this.plugin.settings.openRouterModel
                        };
                        window.localStorage.setItem('spaceforge-api-settings', JSON.stringify(apiSettings));
                        console.log("Updated API settings backup with MCQ state");
                    } catch (e) {
                        console.error("Error updating API settings backup:", e);
                    }
                    
                    // Refresh the MCQ settings visibility
                    this.display();
                }));
        
        // Only show other MCQ settings if the feature is enabled
        if (this.plugin.settings.enableMCQ) {
            new Setting(mcqSection)
                .setName("API Configuration")
                .setHeading()
                .setClass("sf-settings-subsection-header");

            // API Provider Dropdown
            new Setting(mcqSection)
                .setName('API Provider')
                .setDesc('Select the API provider for generating MCQs.')
                .addDropdown(dropdown => {
                    dropdown
                        .addOption(ApiProvider.OpenRouter, 'OpenRouter')
                        .addOption(ApiProvider.OpenAI, 'OpenAI')
                        .addOption(ApiProvider.Ollama, 'Ollama')
                        .addOption(ApiProvider.Gemini, 'Gemini')
                        .addOption(ApiProvider.Claude, 'Claude')
                        .addOption(ApiProvider.Together, 'Together AI')
                        .setValue(this.plugin.settings.mcqApiProvider)
                        .onChange(async (value: ApiProvider) => {
                            this.plugin.settings.mcqApiProvider = value;
                            await this.plugin.savePluginData();
                            this.plugin.initializeMCQComponents(); // Re-initialize service
                            this.display(); // Refresh settings tab to show/hide relevant fields
                        });
                });

            // Conditional Settings based on Provider
            const provider = this.plugin.settings.mcqApiProvider;

            if (provider === ApiProvider.OpenRouter) {
                new Setting(mcqSection)
                    .setName("OpenRouter Configuration")
                    .setHeading()
                    .setClass("sf-settings-subsection-provider-header");
                const apiKeyContainer = mcqSection.createEl('div', { cls: 'sf-setting-highlight' });
                new Setting(apiKeyContainer)
                    .setName('OpenRouter API Key')
                    .setDesc('Required for generating MCQs via OpenRouter.')
                    .addText(text => text
                        .setPlaceholder('Enter your OpenRouter API key')
                        .setValue(this.plugin.settings.openRouterApiKey)
                        .onChange(async (value: string) => {
                            this.plugin.settings.openRouterApiKey = value;
                            await this.plugin.savePluginData();
                        }));
                // Removed sf-setting-explain class
                apiKeyContainer.createEl('div', { text: 'Get your API key at https://openrouter.ai/keys' });

                new Setting(mcqSection)
                    .setName('OpenRouter Model')
                    .setDesc('Model identifier from OpenRouter (e.g., openai/gpt-4.1-mini)')
                    .addText(text => text
                        .setPlaceholder('Enter OpenRouter model identifier')
                        .setValue(this.plugin.settings.openRouterModel)
                        .onChange(async (value: string) => {
                            this.plugin.settings.openRouterModel = value;
                            await this.plugin.savePluginData();
                             // Removed specific localStorage backup here
                        }));
            } else if (provider === ApiProvider.OpenAI) {
                new Setting(mcqSection)
                    .setName("OpenAI Configuration")
                    .setHeading()
                    .setClass("sf-settings-subsection-provider-header");
                new Setting(mcqSection)
                    .setName('OpenAI API Key')
                    .setDesc('Your OpenAI API key.')
                    .addText(text => text
                        .setPlaceholder('Enter your OpenAI API key (sk-...)')
                        .setValue(this.plugin.settings.openaiApiKey)
                        .onChange(async (value: string) => {
                            this.plugin.settings.openaiApiKey = value;
                            await this.plugin.savePluginData();
                        }));
                new Setting(mcqSection)
                    .setName('OpenAI Model')
                    .setDesc('Model name (e.g., gpt-3.5-turbo, gpt-4)')
                    .addText(text => text
                        .setPlaceholder('Enter OpenAI model name')
                        .setValue(this.plugin.settings.openaiModel)
                        .onChange(async (value: string) => {
                            this.plugin.settings.openaiModel = value;
                            await this.plugin.savePluginData();
                        }));
            } else if (provider === ApiProvider.Ollama) {
                new Setting(mcqSection)
                    .setName("Ollama Configuration")
                    .setHeading()
                    .setClass("sf-settings-subsection-provider-header");
                new Setting(mcqSection)
                    .setName('Ollama API URL')
                    .setDesc('URL of your running Ollama instance (e.g., http://localhost:11434)')
                    .addText(text => text
                        .setPlaceholder('http://localhost:11434')
                        .setValue(this.plugin.settings.ollamaApiUrl)
                        .onChange(async (value: string) => {
                            this.plugin.settings.ollamaApiUrl = value;
                            await this.plugin.savePluginData();
                        }));
                new Setting(mcqSection)
                    .setName('Ollama Model')
                    .setDesc('Name of the Ollama model to use (e.g., llama3, mistral)')
                    .addText(text => text
                        .setPlaceholder('Enter Ollama model name')
                        .setValue(this.plugin.settings.ollamaModel)
                        .onChange(async (value: string) => {
                            this.plugin.settings.ollamaModel = value;
                            await this.plugin.savePluginData();
                        }));
            } else if (provider === ApiProvider.Gemini) {
                new Setting(mcqSection)
                    .setName("Gemini Configuration")
                    .setHeading()
                    .setClass("sf-settings-subsection-provider-header");
                 new Setting(mcqSection)
                    .setName('Gemini API Key')
                    .setDesc('Your Google AI Gemini API key.')
                    .addText(text => text
                        .setPlaceholder('Enter your Gemini API key')
                        .setValue(this.plugin.settings.geminiApiKey)
                        .onChange(async (value: string) => {
                            this.plugin.settings.geminiApiKey = value;
                            await this.plugin.savePluginData();
                        }));
                new Setting(mcqSection)
                    .setName('Gemini Model')
                    .setDesc('Model name (e.g., gemini-pro)')
                    .addText(text => text
                        .setPlaceholder('Enter Gemini model name')
                        .setValue(this.plugin.settings.geminiModel)
                        .onChange(async (value: string) => {
                            this.plugin.settings.geminiModel = value;
                            await this.plugin.savePluginData();
                        }));
            } else if (provider === ApiProvider.Claude) {
                new Setting(mcqSection)
                    .setName("Claude Configuration")
                    .setHeading()
                    .setClass("sf-settings-subsection-provider-header");
                new Setting(mcqSection)
                    .setName('Claude API Key')
                    .setDesc('Your Anthropic Claude API key.')
                    .addText(text => text
                        .setPlaceholder('Enter your Claude API key')
                        .setValue(this.plugin.settings.claudeApiKey)
                        .onChange(async (value: string) => {
                            this.plugin.settings.claudeApiKey = value;
                            await this.plugin.savePluginData();
                        }));
                new Setting(mcqSection)
                    .setName('Claude Model')
                    .setDesc('Model name (e.g., claude-3-opus-20240229, claude-3-sonnet-20240229)')
                    .addText(text => text
                        .setPlaceholder('Enter Claude model name')
                        .setValue(this.plugin.settings.claudeModel)
                        .onChange(async (value: string) => {
                            this.plugin.settings.claudeModel = value;
                            await this.plugin.savePluginData();
                        }));
            } else if (provider === ApiProvider.Together) {
                new Setting(mcqSection)
                    .setName("Together AI Configuration")
                    .setHeading()
                    .setClass("sf-settings-subsection-provider-header");
                new Setting(mcqSection)
                    .setName('Together AI API Key')
                    .setDesc('Your Together AI API key.')
                    .addText(text => text
                        .setPlaceholder('Enter your Together AI API key')
                        .setValue(this.plugin.settings.togetherApiKey)
                        .onChange(async (value: string) => {
                            this.plugin.settings.togetherApiKey = value;
                            await this.plugin.savePluginData();
                        }));
                new Setting(mcqSection)
                    .setName('Together AI Model')
                    .setDesc('Model identifier from Together AI (e.g., meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8)')
                    .addText(text => text
                        .setPlaceholder('Enter Together AI model identifier')
                        .setValue(this.plugin.settings.togetherModel)
                        .onChange(async (value: string) => {
                            this.plugin.settings.togetherModel = value;
                            await this.plugin.savePluginData();
                        }));
            }
            
            // Question generation settings (common to all providers)
            new Setting(mcqSection)
                .setName("Question Generation (Common)")
                .setHeading()
                .setClass("sf-settings-subsection-header");

            // Setting for Question Amount Mode
            new Setting(mcqSection)
                .setName('Question amount mode')
                .setDesc('How to determine the number of questions per note.')
                .addDropdown(dropdown => dropdown
                    .addOption(MCQQuestionAmountMode.Fixed, 'Fixed Number')
                    .addOption(MCQQuestionAmountMode.WordsPerQuestion, 'Per X Words')
                    .setValue(this.plugin.settings.mcqQuestionAmountMode)
                    .onChange(async (value: MCQQuestionAmountMode) => {
                        this.plugin.settings.mcqQuestionAmountMode = value;
                        await this.plugin.savePluginData();
                        this.display(); // Re-render the settings tab to show/hide relevant fields
                    }));

            // Conditionally display settings based on the mode
            if (this.plugin.settings.mcqQuestionAmountMode === MCQQuestionAmountMode.Fixed) {
                new Setting(mcqSection)
                    .setName('Questions per note (Fixed)')
                    .setDesc('Number of questions to generate for each note.')
                    .addSlider(slider => slider
                        .setLimits(1, 10, 1)
                        .setValue(this.plugin.settings.mcqQuestionsPerNote)
                        .setDynamicTooltip()
                        .onChange(async (value: number) => {
                            this.plugin.settings.mcqQuestionsPerNote = value;
                            await this.plugin.savePluginData();
                        }));
            } else if (this.plugin.settings.mcqQuestionAmountMode === MCQQuestionAmountMode.WordsPerQuestion) {
                new Setting(mcqSection)
                    .setName('Words per question target')
                    .setDesc('Generate approximately 1 question for every X words in the note.')
                    .addText(text => text
                        .setPlaceholder('100')
                        .setValue(this.plugin.settings.mcqWordsPerQuestion.toString())
                        .onChange(async (value: string) => {
                            const numValue = parseInt(value);
                            if (!isNaN(numValue) && numValue > 0) {
                                this.plugin.settings.mcqWordsPerQuestion = numValue;
                                await this.plugin.savePluginData();
                            } else {
                                new Notice("Words per question must be a positive number.");
                                // Optionally reset to previous value or default
                                text.setValue(this.plugin.settings.mcqWordsPerQuestion.toString()); 
                            }
                        }));
            }
            
            // This setting is now conditional above
            // new Setting(mcqSection)
            //     .setName('Questions per note')
            //     .setDesc('Number of questions to generate for each note')
            //     .addSlider(slider => slider
            //         .setLimits(1, 10, 1)
            //         .setValue(this.plugin.settings.mcqQuestionsPerNote)
            //         .setDynamicTooltip()
            //         .onChange(async (value: number) => {
            //             this.plugin.settings.mcqQuestionsPerNote = value;
            //             await this.plugin.savePluginData();
            //         }));
            
            new Setting(mcqSection)
                .setName('Choices per question')
                .setDesc('Number of answer choices for each question')
                .addSlider(slider => slider
                    .setLimits(2, 6, 1)
                    .setValue(this.plugin.settings.mcqChoicesPerQuestion)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.mcqChoicesPerQuestion = value;
                        await this.plugin.savePluginData();
                    }));
            
            // Use CSS grid for the two dropdowns side by side
            const mcqFormattingGrid = mcqSection.createEl('div', { cls: 'sf-setting-grid' });
            
            // First item in grid
            const promptTypeContainer = mcqFormattingGrid.createEl('div');
            new Setting(promptTypeContainer)
                .setName('Prompt type')
                .setDesc('Format for MCQ generation')
                .addDropdown(dropdown => dropdown
                    .addOption('basic', 'Basic')
                    .addOption('detailed', 'Detailed')
                    .setValue(this.plugin.settings.mcqPromptType)
                    .onChange(async (value: 'basic' | 'detailed') => {
                        this.plugin.settings.mcqPromptType = value;
                        await this.plugin.savePluginData();
                    }));
            
            // Second item in grid
            const difficultyContainer = mcqFormattingGrid.createEl('div');
            new Setting(difficultyContainer)
                .setName('MCQ difficulty')
                .setDesc('Complexity level')
                .addDropdown(dropdown => dropdown
                    .addOption('basic', 'Basic recall')
                    .addOption('advanced', 'Advanced understanding')
                    .setValue(this.plugin.settings.mcqDifficulty)
                    .onChange(async (value: string) => {
                        this.plugin.settings.mcqDifficulty = value as any;
                        await this.plugin.savePluginData();
                    }));
            
            // Scoring settings
            new Setting(mcqSection)
                .setName("Scoring Settings")
                .setHeading()
                .setClass("sf-settings-subsection-header");
            
            new Setting(mcqSection)
                .setName('Time deduction amount')
                .setDesc('Score penalty for slow answers (0-1)')
                .addSlider(slider => slider
                    .setLimits(0, 1, 0.1)
                    .setValue(this.plugin.settings.mcqTimeDeductionAmount)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.mcqTimeDeductionAmount = value;
                        await this.plugin.savePluginData();
                    }));
            
            new Setting(mcqSection)
                .setName('Time deduction threshold')
                .setDesc('Apply penalty after this many seconds')
                .addSlider(slider => slider
                    .setLimits(10, 120, 5)
                    .setValue(this.plugin.settings.mcqTimeDeductionSeconds)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.mcqTimeDeductionSeconds = value;
                        await this.plugin.savePluginData();
                    }));
            
            // Add collapsible section for system prompts
            const systemPromptsContainer = mcqSection.createEl('details', { cls: 'sf-system-prompts-container' });
            systemPromptsContainer.createEl('summary', { text: 'System Prompts (Advanced)', cls: 'sf-settings-subsection' });
            
            // Basic prompt textarea
            systemPromptsContainer.createEl('div', { text: 'Basic Difficulty Prompt', cls: 'sf-prompt-label' });
            const basicTextarea = systemPromptsContainer.createEl('textarea', {
                attr: {
                    placeholder: 'Enter system prompt for basic difficulty',
                    rows: '6'
                },
                cls: 'prompt-textarea'
            });
            
            // Set value and add change handler
            basicTextarea.value = this.plugin.settings.mcqBasicSystemPrompt;
            basicTextarea.addEventListener('change', async () => {
                this.plugin.settings.mcqBasicSystemPrompt = basicTextarea.value;
                await this.plugin.savePluginData();
            });
            
            // Advanced prompt textarea
            systemPromptsContainer.createEl('div', { text: 'Advanced Difficulty Prompt', cls: 'sf-prompt-label' });
            const advancedTextarea = systemPromptsContainer.createEl('textarea', {
                attr: {
                    placeholder: 'Enter system prompt for advanced difficulty',
                    rows: '6'
                },
                cls: 'prompt-textarea'
            });
            
            // Set value and add change handler
            advancedTextarea.value = this.plugin.settings.mcqAdvancedSystemPrompt;
            advancedTextarea.addEventListener('change', async () => {
                this.plugin.settings.mcqAdvancedSystemPrompt = advancedTextarea.value;
                await this.plugin.savePluginData();
            });

            // Advanced Question Behavior subsection
            new Setting(mcqSection)
                .setName("Advanced Question Behavior")
                .setHeading()
                .setClass("sf-settings-subsection-header");

            const regenerationSetting = new Setting(mcqSection)
                .setName('Enable question regeneration on rating')
                .setDesc('Automatically regenerate questions for a note if its review rating meets or exceeds a specified value.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.enableQuestionRegenerationOnRating)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableQuestionRegenerationOnRating = value;
                        await this.plugin.savePluginData();
                        // Refresh display to show/hide dependent setting
                        this.display(); 
                    }));

            if (this.plugin.settings.enableQuestionRegenerationOnRating) {
                new Setting(mcqSection)
                    .setName('Min SM-2 rating for MCQ regeneration')
                    .setDesc('For SM-2: Regenerate MCQs if review rating (0-5) is this value or higher. (0:Blackout, 5:Perfect)')
                    .addSlider(slider => slider
                        .setLimits(0, 5, 1)
                        .setValue(this.plugin.settings.minSm2RatingForQuestionRegeneration)
                        .setDynamicTooltip()
                        .onChange(async (value: number) => {
                            this.plugin.settings.minSm2RatingForQuestionRegeneration = value;
                            await this.plugin.savePluginData();
                        }));

                new Setting(mcqSection)
                    .setName('Min FSRS rating for MCQ regeneration')
                    .setDesc('For FSRS: Regenerate MCQs if review rating (1-4) is this value or higher. (1:Again, 4:Easy)')
                    .addSlider(slider => slider
                        .setLimits(1, 4, 1) // FSRS ratings are 1-4
                        .setValue(this.plugin.settings.minFsrsRatingForQuestionRegeneration)
                        .setDynamicTooltip()
                        .onChange(async (value: number) => {
                            this.plugin.settings.minFsrsRatingForQuestionRegeneration = value;
                            await this.plugin.savePluginData();
                        }));
            }

        } else {
            // If MCQ is disabled, show a message about enabling it
            const mcqDisabledMessage = mcqSection.createEl('div', { cls: 'sf-info-box' });
            mcqDisabledMessage.createEl('p', { 
                text: 'Multiple Choice Questions are currently disabled. Enable them to generate AI-powered quizzes that test your understanding of notes.'
            });
        }
        
        // ========= POMODORO TIMER SECTION =========
        const pomodoroSection = createCollapsible('Pomodoro Timer', 'timer', false); // Added timer icon

        new Setting(pomodoroSection)
            .setName('Enable Pomodoro Timer')
            .setDesc('Show the Pomodoro timer in the sidebar.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.pomodoroEnabled)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.pomodoroEnabled = value;
                    await this.plugin.savePluginData();
                    // Notify the service and refresh UI elements
                    this.plugin.pomodoroService?.onSettingsChanged(); 
                    this.plugin.sidebarView?.refresh(); // Refresh sidebar to show/hide timer
                    this.display(); // Refresh settings tab to show/hide dependent settings
                }));

        // Only show other Pomodoro settings if the feature is enabled
        if (this.plugin.settings.pomodoroEnabled) {
            new Setting(pomodoroSection)
                .setName("Timer Durations (minutes)")
                .setHeading()
                .setClass("sf-settings-subsection-header");

            new Setting(pomodoroSection)
                .setName('Work Duration')
                .setDesc('Length of a work session.')
                .addText(text => text
                    .setPlaceholder('25')
                    .setValue(this.plugin.settings.pomodoroWorkDuration.toString())
                    .onChange(async (value: string) => {
                        const numValue = parseInt(value);
                        if (!isNaN(numValue) && numValue > 0) {
                            this.plugin.settings.pomodoroWorkDuration = numValue;
                            await this.plugin.savePluginData();
                            this.plugin.pomodoroService?.onSettingsChanged(); // Notify service of potential duration change
                        }
                    }));
            
            new Setting(pomodoroSection)
                .setName('Short Break Duration')
                .setDesc('Length of a short break.')
                .addText(text => text
                    .setPlaceholder('5')
                    .setValue(this.plugin.settings.pomodoroShortBreakDuration.toString())
                    .onChange(async (value: string) => {
                        const numValue = parseInt(value);
                        if (!isNaN(numValue) && numValue > 0) {
                            this.plugin.settings.pomodoroShortBreakDuration = numValue;
                            await this.plugin.savePluginData();
                            this.plugin.pomodoroService?.onSettingsChanged();
                        }
                    }));

            new Setting(pomodoroSection)
                .setName('Long Break Duration')
                .setDesc('Length of a long break.')
                .addText(text => text
                    .setPlaceholder('15')
                    .setValue(this.plugin.settings.pomodoroLongBreakDuration.toString())
                    .onChange(async (value: string) => {
                        const numValue = parseInt(value);
                        if (!isNaN(numValue) && numValue > 0) {
                            this.plugin.settings.pomodoroLongBreakDuration = numValue;
                            await this.plugin.savePluginData();
                            this.plugin.pomodoroService?.onSettingsChanged();
                        }
                    }));

            new Setting(pomodoroSection)
                .setName('Sessions Until Long Break')
                .setDesc('Number of work sessions before a long break starts.')
                .addText(text => text
                    .setPlaceholder('4')
                    .setValue(this.plugin.settings.pomodoroSessionsUntilLongBreak.toString())
                    .onChange(async (value: string) => {
                        const numValue = parseInt(value);
                        if (!isNaN(numValue) && numValue > 0) {
                            this.plugin.settings.pomodoroSessionsUntilLongBreak = numValue;
                            await this.plugin.savePluginData();
                            this.plugin.pomodoroService?.onSettingsChanged();
                        }
                    }));

            new Setting(pomodoroSection)
                .setName("Notifications")
                .setHeading()
                .setClass("sf-settings-subsection-header");

            new Setting(pomodoroSection)
                .setName('Enable Sound Notifications')
                .setDesc('Play a sound at the end of each work/break session.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.pomodoroSoundEnabled)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.pomodoroSoundEnabled = value;
                        await this.plugin.savePluginData();
                    }));
        } else {
             const pomodoroDisabledMessage = pomodoroSection.createEl('div', { cls: 'sf-info-box' });
             pomodoroDisabledMessage.createEl('p', { 
                 text: 'Pomodoro Timer is currently disabled. Enable it to configure durations and notifications.'
             });
        }

        // Add global action buttons at the bottom
        containerEl.createEl('h2', { text: 'Manage Plugin Data' });
        createActionButtons();
    }

    private renderAboutAlgorithmSection(container: HTMLElement, algorithm: 'sm2' | 'fsrs'): void {
        container.empty(); // Clear previous content

        if (algorithm === 'sm2') {
            container.createEl('h4', { text: 'About the Modified SM-2 Algorithm' });
            container.createEl('p', { 
                text: 'Spaceforge uses a modified version of the SuperMemo SM-2 algorithm (1991) which schedules reviews based on how well you recall information. ' +
                      'When you rate your recall quality from 0-5, the algorithm adjusts the interval and difficulty (ease factor) accordingly.'
            });
            container.createEl('p', {
                text: 'Our implementation includes specific handling for overdue or skipped items to prevent them from accumulating in a backlog:'
            });
            const sm2List = container.createEl('ul');
            sm2List.createEl('li', { text: 'Overdue items: Automatically set to review tomorrow with a quality rating of 0.' });
            sm2List.createEl('li', { text: 'Postponed items: Explicitly moved to tomorrow with a one-step quality penalty.' });
            sm2List.createEl('li', { text: 'Both cases reset the repetition count to 1 and update the ease factor.' });
            
            const ratingsTable = container.createEl('table', { cls: 'sf-ratings-table' }); // Added a class for potential styling
            ratingsTable.innerHTML = `
                <thead><tr><th>Rating (0-5)</th><th>Description</th><th>Effect on Interval</th></tr></thead>
                <tbody>
                    <tr><td>0-2</td><td>Incorrect / struggled</td><td>Resets, shortest interval</td></tr>
                    <tr><td>3</td><td>Correct with difficulty</td><td>Small increase</td></tr>
                    <tr><td>4</td><td>Correct with hesitation</td><td>Moderate increase</td></tr>
                    <tr><td>5</td><td>Perfect recall</td><td>Largest increase</td></tr>
                </tbody>
            `;
        } else if (algorithm === 'fsrs') {
            container.createEl('h4', { text: 'About the FSRS Algorithm' });
            container.createEl('p', { 
                text: 'FSRS (Free Spaced Repetition Scheduler) is a modern, evidence-based algorithm that models memory retention to optimize review schedules. ' +
                      'It calculates card difficulty and stability dynamically based on your review history and aims for a target retention rate.'
            });
            container.createEl('p', {
                text: 'Key concepts in FSRS:'
            });
            const fsrsList = container.createEl('ul');
            fsrsList.createEl('li', { text: 'Difficulty: How hard a card is to remember.' });
            fsrsList.createEl('li', { text: 'Stability: How long a card is likely to be remembered.' });
            fsrsList.createEl('li', { text: 'Retention: The probability of recalling a card at the time of review.' });
            fsrsList.createEl('li', { text: 'Learning Steps: Initial short intervals for new cards (configurable).' });

            const ratingsTable = container.createEl('table', { cls: 'sf-ratings-table' });
            ratingsTable.innerHTML = `
                <thead><tr><th>Rating (1-4)</th><th>Description</th><th>Effect on Stability/Difficulty</th></tr></thead>
                <tbody>
                    <tr><td>1 (Again)</td><td>Forgot the card</td><td>Decreases stability, may increase difficulty</td></tr>
                    <tr><td>2 (Hard)</td><td>Recalled with significant difficulty</td><td>Smaller increase in stability</td></tr>
                    <tr><td>3 (Good)</td><td>Recalled correctly</td><td>Standard increase in stability</td></tr>
                    <tr><td>4 (Easy)</td><td>Recalled very easily</td><td>Largest increase in stability, may decrease difficulty</td></tr>
                </tbody>
            `;
            container.createEl('p', {text: 'FSRS parameters (weights, retention, etc.) can be tuned, but the defaults are generally effective.'});
        }
    }
}
