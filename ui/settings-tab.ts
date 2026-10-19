import { App, Notice, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { getCliAgent } from '../api/cli/cli-agents';
import { CliModelEntry } from '../api/cli/cli-types';
import { getEnvVar, setCliExtraPath } from '../api/cli/cli-runner';
import { CliDetectionResult, detectCliAgent } from '../api/cli/cli-detection';
import {
    agentIdOfProvider,
    cliModelFor,
    cliProviderId,
    DiscoveredModel,
    discoverModels,
    detectProviders,
    getHttpProvider,
    HttpProviderDescriptor,
    providerModel,
    providerNeedsUrl,
    ProviderStatus,
    resolveHttpBaseUrl,
    listProviders,
    providerStoredKey,
    providerStoredModel,
    providerStoredUrl,
    searchModels,
    setCliModelFor,
    setProviderBaseUrl,
    setProviderKey,
    setProviderModel,
} from '../api/provider-registry';
import { ModelSuggest } from './model-suggest';
import { ConfirmationModal } from './confirmation-modal';
import SpaceforgePlugin from '../main';
import { ApiProvider, DEFAULT_SETTINGS, MCQQuestionAmountMode, MCQDifficulty, ProviderId, SpaceforgeSettings, StudySearchProvider, StudyExpertise } from '../models/settings';
import { SpaceforgePluginData, DEFAULT_PLUGIN_STATE_DATA, PluginStateData } from '../models/plugin-data';
import { SM2, FSRS, POMODORO, MCQS, API, SPACEFORGE, OLLAMA, WPM } from './constants';

/**
 * Settings tab for the plugin
 */
/**
 * The local-CLI provider's model field. Every HTTP provider describes its own
 * model field in `api/provider-registry.ts` (label, newest model), so this is
 * the only description left here — the CLI's, whose model is its own business.
 */
const CLI_MODEL_DESCRIPTION = 'Model for the CLI to use. Empty means the CLI chooses (the right answer for CLIs that resolve it from their own config).';

/**
 * One model field: which provider it belongs to, what that provider ships
 * newest, and where the value is stored. Built from a registry descriptor, or
 * by hand for the local CLI, which has no HTTP row.
 */
interface ModelFieldSpec {
    /** Cache and suggestion key: the provider id. */
    id: ProviderId;
    /** What the description names. */
    label: string;
    /** The newest model the provider ships; empty when only it can say. */
    latest: string;
    /** What is stored right now. */
    stored: string;
    /** Shown instead of the generated description, for the CLI's own wording. */
    description?: string;
    set(value: string): void;
}

function setStatusText(el: HTMLElement, text: string, level: 'ok' | 'warn' | 'error'): void {
    el.setText(text);
    el.removeClass('is-ok', 'is-warn', 'is-error');
    el.addClass(`is-${level}`);
}

export class SpaceforgeSettingTab extends PluginSettingTab {
    /**
     * The live key capture, if one is running. It is bound on document (Obsidian
     * hands focus back to the body constantly), so nothing else would clean it
     * up: it is released when the capture ends, when it is replaced, and on
     * plugin unload.
     */
    private captureHandler: ((event: KeyboardEvent) => void) | null = null;

    /**
     * Which collapsible sections the reader has open. Only the data-wide actions
     * rebuild the tab, and when they do the sections are restored rather than all
     * collapsed — being thrown back to a closed tab is its own small betrayal.
     */
    private sectionOpenState = new Map<string, boolean>();

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
    /** End a key capture, however it ended, and put the button's label back. */
    private stopCapture(button: { setButtonText: (text: string) => unknown }, label: string): void {
        if (this.captureHandler) {
            document.removeEventListener('keydown', this.captureHandler, { capture: true });
            this.captureHandler = null;
        }
        button.setButtonText(label);
    }
    display(): void {
        const { containerEl } = this;
        // Only the data-wide actions rebuild the tab. Even then the reader keeps
        // their place: Obsidian scrolls the content element itself (its parent is
        // the pane container, which does not scroll), so the offset is read from
        // whichever of the two scrolls and put back once the content is in place.
        const scroller = containerEl.scrollHeight > containerEl.clientHeight
            ? containerEl
            : containerEl.parentElement;
        const scrollTop = scroller?.scrollTop ?? 0;
        containerEl.empty();

        // containerEl.createEl('h2', { text: 'Spaceforge Settings' }); // Avoid top-level headings

        // Add a utility for creating collapsible sections
        const createCollapsible = (title: string, iconName: string, defaultOpen = true) => {
            // Create section container
            const sectionContainer = containerEl.createDiv({ cls: 'sf-settings-section' });

            // Create heading using Setting.setHeading()
            const headingSetting = new Setting(sectionContainer)
                .setName(title)
                .setHeading();

            // Add icon if provided
            if (iconName) {
                const iconEl = headingSetting.settingEl.createSpan({ cls: 'sf-settings-icon' });
                setIcon(iconEl, iconName);
                // Insert icon before the name
                headingSetting.nameEl.prepend(iconEl);
            }

            // Add collapse indicator
            const collapseIndicator = headingSetting.settingEl.createSpan({
                cls: 'sf-settings-collapse-indicator'
            });
            headingSetting.nameEl.appendChild(collapseIndicator);

            // Create content container
            const contentContainer = sectionContainer.createDiv({
                cls: 'sf-settings-section-content'
            });

            // One place decides the classes and the arrow together, so they cannot
            // disagree — and the state is remembered, so a rebuild of the tab puts
            // the reader back in the sections they had open. (The old toggle left a
            // section open by default carrying both `sf-hidden` and `sf-visible`,
            // with the arrow reading the wrong one.)
            const setOpen = (open: boolean) => {
                contentContainer.classList.toggle('sf-hidden', !open);
                contentContainer.classList.toggle('sf-visible', open);
                collapseIndicator.textContent = open ? '▾' : '▸';
                this.sectionOpenState.set(title, open);
            };
            setOpen(this.sectionOpenState.get(title) ?? defaultOpen);

            // Add click handler for toggling
            headingSetting.settingEl.addEventListener('click', () => {
                setOpen(contentContainer.classList.contains('sf-hidden'));
            });

            return contentContainer;
        };

        // We'll rely on the CSS in the styles.css file instead of inline styles

        // Create action buttons for global data operations
        const createActionButtons = () => {
            const actionsContainer = containerEl.createDiv({ cls: 'sf-settings-actions' });

            // Export all data button
            const exportBtn = actionsContainer.createEl('button', { text: 'Export all data', cls: 'sf-btn sf-btn-primary' });
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
                    pomodoroEstimatedTotalCycles: this.plugin.pluginState.pomodoroEstimatedTotalCycles ?? null,
                    pomodoroEstimatedWorkSessions: this.plugin.pluginState.pomodoroEstimatedWorkSessions ?? null,
                    pomodoroIsEstimationActive: this.plugin.pluginState.pomodoroIsEstimationActive ?? false,
                    pomodoroUserHasModifiedSettings: this.plugin.pluginState.pomodoroUserHasModifiedSettings ?? false,
                    pomodoroUserOverrideHours: this.plugin.pluginState.pomodoroUserOverrideHours ?? 0,
                    pomodoroUserOverrideMinutes: this.plugin.pluginState.pomodoroUserOverrideMinutes ?? 0,
                    pomodoroUserAddToEstimation: this.plugin.pluginState.pomodoroUserAddToEstimation ?? false,
                    calendarEvents: this.plugin.pluginState.calendarEvents ?? {},
                    studyPlans: this.plugin.studyPlanService?.plans ?? {},
                    studyProgress: this.plugin.studyPlanService?.progress ?? {},
                    studySessions: this.plugin.studyPlanService?.sessions ?? {},
                };

                const dataToExport: SpaceforgePluginData = {
                    settings: this.plugin.settings,
                    pluginState: pluginStateToExport
                };
                const dataJson = JSON.stringify(dataToExport, null, 2);
                const blob = new Blob([dataJson], { type: 'application/json' });

                const a = document.body.createEl('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'spaceforge-data.json'; // Changed filename
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                new Notice('All data exported successfully');
            });

            // Import all data button
            const importBtn = actionsContainer.createEl('button', { text: 'Import all data', cls: 'sf-btn sf-btn-primary' });
            importBtn.addEventListener('click', () => {
                const input = document.body.createEl('input');
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

                            new Notice('All data imported successfully. Plugin may require a reload for all changes to take effect.');
                        } catch (error) {
                            const msg = error instanceof Error ? error.message : String(error);
                            new Notice(`Failed to import data: ${msg} `);
                        }
                    }
                };
                input.click();
            });

            // Reset to defaults button
            const resetBtn = actionsContainer.createEl('button', { text: 'Reset to defaults', cls: 'sf-btn sf-btn-warning' });
            resetBtn.addEventListener('click', () => {
                new ConfirmationModal(
                    this.app,
                    'Reset to defaults',
                    'Are you sure you want to reset all plugin data (settings and state) to defaults? This cannot be undone.',
                    async () => {
                        // Apply default settings and default plugin state
                        this.plugin.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as SpaceforgeSettings;
                        this.plugin.pluginState = JSON.parse(JSON.stringify(DEFAULT_PLUGIN_STATE_DATA)) as PluginStateData;

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

                        new Notice('All data reset to defaults.');
                    }
                ).open();
            });

            // Clear Reviews Data button
            const clearReviewsBtn = actionsContainer.createEl('button', {
                text: 'Clear all reviews',
                cls: 'sf-btn sf-btn-danger' // Use existing danger button styling
            });
            clearReviewsBtn.addEventListener('click', () => {
                new ConfirmationModal(
                    this.app,
                    'Clear all reviews',
                    'Are you sure you want to clear all review schedules, history, and session data? This action cannot be undone.',
                    async () => {
                        try {
                            // Reset schedule-related parts of pluginState
                            this.plugin.pluginState.schedules = { ...DEFAULT_PLUGIN_STATE_DATA.schedules };
                            this.plugin.pluginState.history = [...DEFAULT_PLUGIN_STATE_DATA.history];
                            this.plugin.pluginState.reviewSessions = { ...DEFAULT_PLUGIN_STATE_DATA.reviewSessions };
                            this.plugin.pluginState.customNoteOrder = [...DEFAULT_PLUGIN_STATE_DATA.customNoteOrder];

                            // Update services
                            this.plugin.reviewScheduleService.schedules = this.plugin.pluginState.schedules;
                            this.plugin.reviewHistoryService.history = this.plugin.pluginState.history;
                            this.plugin.reviewSessionService.reviewSessions = this.plugin.pluginState.reviewSessions;
                            this.plugin.reviewScheduleService.customNoteOrder = this.plugin.pluginState.customNoteOrder;

                            // Explicitly update the review controller's state
                            if (this.plugin.reviewController) {
                                this.plugin.reviewController.updateTodayNotes();
                            }

                            // Emit an event that the sidebar might be listening to
                            if (this.plugin.events) {
                                this.plugin.events.emit('sidebar-update');
                            }

                            // Save the cleared data first
                            await this.plugin.savePluginData();

                            new Notice('All review data cleared successfully.');

                            // Then refresh UI elements
                            this.display(); // Refresh settings UI
                            void this.plugin.getSidebarView()?.refresh();

                        } catch {
                            new Notice('Failed to clear review data. Check console for details.');
                        }
                    }
                ).open();
            });

            // Clear Events Data button
            const clearEventsBtn = actionsContainer.createEl('button', {
                text: 'Clear all events',
                cls: 'sf-btn sf-btn-danger'
            });
            clearEventsBtn.addEventListener('click', () => {
                new ConfirmationModal(
                    this.app,
                    'Clear all events',
                    'Are you sure you want to clear all calendar events? This action cannot be undone.',
                    async () => {
                        try {
                            // Reset calendar events in pluginState
                            this.plugin.pluginState.calendarEvents = { ...DEFAULT_PLUGIN_STATE_DATA.calendarEvents };

                            // Update calendar service if it exists
                            if (this.plugin.calendarEventService) {
                                this.plugin.calendarEventService.initialize([]);
                            }

                            // Save the cleared data
                            await this.plugin.savePluginData();

                            new Notice('All calendar events cleared successfully.');

                            // Then refresh UI elements
                            this.display(); // Refresh settings UI
                            void this.plugin.getSidebarView()?.refresh();

                        } catch {
                            new Notice('Failed to clear calendar events. Check console for details.');
                        }
                    }
                ).open();
            });

            // Clear All Data button
            const clearAllBtn = actionsContainer.createEl('button', {
                text: 'Clear all data',
                cls: 'sf-btn sf-btn-danger'
            });
            clearAllBtn.addEventListener('click', () => {
                new ConfirmationModal(
                    this.app,
                    'Clear all data',
                    'Are you sure you want to clear ALL plugin data (reviews, events, MCQs, Pomodoro state)? This action cannot be undone.',
                    async () => {
                        try {
                            // Reset all plugin state to defaults
                            this.plugin.pluginState = JSON.parse(JSON.stringify(DEFAULT_PLUGIN_STATE_DATA)) as PluginStateData;

                            // Update all services
                            this.plugin.reviewScheduleService.schedules = this.plugin.pluginState.schedules;
                            this.plugin.reviewHistoryService.history = this.plugin.pluginState.history;
                            this.plugin.reviewSessionService.reviewSessions = this.plugin.pluginState.reviewSessions;
                            this.plugin.mcqService.mcqSets = this.plugin.pluginState.mcqSets;
                            this.plugin.mcqService.mcqSessions = this.plugin.pluginState.mcqSessions;
                            this.plugin.reviewScheduleService.customNoteOrder = this.plugin.pluginState.customNoteOrder;
                            this.plugin.reviewScheduleService.lastLinkAnalysisTimestamp = this.plugin.pluginState.lastLinkAnalysisTimestamp ?? null;

                            // Update calendar service if it exists
                            if (this.plugin.calendarEventService) {
                                this.plugin.calendarEventService.initialize([]);
                            }

                            // Update Pomodoro service
                            this.plugin.pomodoroService?.onSettingsChanged();
                            this.plugin.pomodoroService?.reinitializeTimerFromState();

                            // Explicitly update the review controller's state
                            if (this.plugin.reviewController) {
                                this.plugin.reviewController.updateTodayNotes();
                            }

                            // Emit an event that the sidebar might be listening to
                            if (this.plugin.events) {
                                this.plugin.events.emit('sidebar-update');
                            }

                            // Save the cleared data
                            await this.plugin.savePluginData();

                            new Notice('All data cleared successfully.');

                            // Then refresh UI elements
                            this.display(); // Refresh settings UI
                            void this.plugin.getSidebarView()?.refresh();

                        } catch {
                            new Notice('Failed to clear all data. Check console for details.');
                        }
                    }
                ).open();
            });

            return actionsContainer;
        };

        // ========= SPACED REPETITION SECTION =========
        const spacedRepSection = createCollapsible('Spaced repetition', 'calendar-clock', true);

        // --- Algorithm Selection ---
        // Changed to h3 and removed sf-settings-subsection class for potentially better contrast
        new Setting(spacedRepSection)
            .setName('Keyboard shortcuts')
            .setDesc('Commands are bindable keys. Obsidian owns the bindings: bind them in its hotkey settings, searching "Spaceforge". No keys are set by default.')
            .addButton(button => button
                .setButtonText('Open hotkey settings')
                .onClick(() => this.openHotkeySettings()));

        new Setting(spacedRepSection).setName('Algorithm configuration').setHeading();

        const algorithmContainer = spacedRepSection.createDiv({ cls: 'sf-settings-subsection' }); // Define algorithmContainer

        new Setting(algorithmContainer)
            .setName('Default scheduling algorithm')
            .setDesc('Choose the default algorithm for newly created notes.')
            .addDropdown(dropdown => dropdown
                .addOption('sm2', SM2)
                .addOption('fsrs', FSRS)
                .setValue(this.plugin.settings.defaultSchedulingAlgorithm)
                .onChange(async (value: 'sm2' | 'fsrs') => {
                    this.plugin.settings.defaultSchedulingAlgorithm = value;
                    await this.plugin.savePluginData();
                    // Only the explanation depends on the choice, so only it is redrawn.
                    this.renderAboutAlgorithmSection(aboutAlgoContainer, value);
                }));

        // --- Dynamic "About Algorithm" Section ---
        const aboutAlgoContainer = spacedRepSection.createDiv({ cls: 'sf-info-box sf-algo-about-box' });
        this.renderAboutAlgorithmSection(aboutAlgoContainer, this.plugin.settings.defaultSchedulingAlgorithm);

        // --- Review flow ---
        const reviewFlowContainer = spacedRepSection.createEl('details', { cls: 'sf-settings-collapsible-subsection' });
        reviewFlowContainer.createEl('summary').setText('Review flow');
        reviewFlowContainer.open = true;

        new Setting(reviewFlowContainer)
            .setName('Show the next interval on grade buttons')
            .setDesc('Each grade button shows how far out it schedules the note, so the choice is informed before it is made.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.reviewStripIntervalPreviews)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.reviewStripIntervalPreviews = value;
                    await this.plugin.savePluginData();
                }));

        new Setting(reviewFlowContainer)
            .setName('Where the session opens')
            .setDesc('In a split beside the note, or in a window of its own — which can go on a second monitor and leaves the pane you were working in alone.')
            .addDropdown(dropdown => dropdown
                .addOption('split', 'Split the note pane')
                .addOption('window', 'A window of its own')
                .setValue(this.plugin.settings.reviewSessionPlacement)
                .onChange(async (value: string) => {
                    this.plugin.settings.reviewSessionPlacement = value === 'window' ? 'window' : 'split';
                    await this.plugin.savePluginData();
                }));

        new Setting(reviewFlowContainer)
            .setName('Where card sittings open')
            .setDesc('Over the app as a modal, in a split beside the note, or in a window of its own. A card sitting is a short thing of its own, so the modal keeps what you were working on where it was.')
            .addDropdown(dropdown => dropdown
                .addOption('modal', 'A modal over the app')
                .addOption('split', 'Split the note pane')
                .addOption('window', 'A window of its own')
                .setValue(this.plugin.settings.deckSessionPlacement)
                .onChange(async (value: string) => {
                    this.plugin.settings.deckSessionPlacement =
                        value === 'modal' || value === 'window' ? value : 'split';
                    await this.plugin.savePluginData();
                }));

        new Setting(reviewFlowContainer)
            .setName('Where the review session lives')
            .setDesc('Under the note being reviewed, in a window of its own, or in the sidebar beside your calendar and list. You can move it whenever you like from the session menu on the bar.')
            .addDropdown(dropdown => dropdown
                .addOption('note', 'Under the note')
                .addOption('window', 'In a window of its own')
                .addOption('sidebar', 'In the sidebar')
                .setValue(this.plugin.settings.reviewSessionHost)
                .onChange(async (value: string) => {
                    const host = value === 'window' || value === 'sidebar' ? value : 'note';
                    this.plugin.settings.reviewSessionHost = host;
                    await this.plugin.savePluginData();
                    if (host === 'sidebar') {
                        await this.plugin.reviewFlowController?.moveToHost('sidebar');
                    } else {
                        this.plugin.reviewFlowController?.setHost(host);
                    }
                }));

        new Setting(reviewFlowContainer)
            .setName('Minutes per card')
            .setDesc('Every card is taken to take this long, which is how the sidebar estimates what a deck is holding for you. A note is measured from the note itself; a card is not.')
            .addText(text => text
                .setPlaceholder('1')
                .setValue(String(this.plugin.settings.deckMinutesPerCard))
                .onChange(async (value: string) => {
                    const minutes = Number(value);
                    if (!Number.isFinite(minutes) || minutes < 0) return;
                    this.plugin.settings.deckMinutesPerCard = Math.min(60, minutes);
                    await this.plugin.savePluginData();
                }));

        new Setting(reviewFlowContainer)
            .setName('Grade with the number keys')
            .setDesc(`While a review session is running, the number keys grade the note on screen (0-5 for ${SM2}, 1-4 for ${FSRS}). Keys are ignored while the caret is in text, where Alt plus the number still grades.`)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.reviewStripGradeKeys)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.reviewStripGradeKeys = value;
                    await this.plugin.savePluginData();
                }));

        new Setting(reviewFlowContainer)
            .setName('Lapse checkpoint')
            .setDesc('After this many lapses a note asks what should happen to it (reset its progress, postpone it for a week, remove it, or carry on). The question returns at each further multiple. 0 turns it off.')
            .addSlider(slider => slider
                .setLimits(0, 30, 1)
                .setValue(this.plugin.settings.leechThreshold)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.leechThreshold = value;
                    await this.plugin.savePluginData();
                }));

        // --- SM-2 Parameters ---
        const sm2ParamsContainer = spacedRepSection.createEl('details', { cls: 'sf-settings-collapsible-subsection' });
        const sm2Summary = sm2ParamsContainer.createEl('summary');
        // Changed to h3
        sm2Summary.setText(`${SM2} parameters`);
        sm2ParamsContainer.open = false; // Initially closed


        new Setting(sm2ParamsContainer)
            .setName(`Base ease factor (${SM2})`)
            .setDesc(`Initial ease factor for new ${SM2} notes (2.5 is ${SM2} default). Higher ease increases interval growth. Value shown is internal format (250 = 2.5).`)
            .addSlider(slider => slider
                .setLimits(130, 500, 10)
                .setValue(this.plugin.settings.baseEase)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.baseEase = value;
                    await this.plugin.savePluginData();
                }));

        new Setting(sm2ParamsContainer)
            .setName(`Use initial learning schedule (${SM2})`)
            .setDesc(`For new ${SM2} notes, use a fixed set of initial intervals before applying the full algorithm.`)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useInitialSchedule)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.useInitialSchedule = value;
                    await this.plugin.savePluginData();
                    // The row below appears and disappears; nothing else moves.
                    initialIntervalsRow.toggleClass('sf-hidden', !value);
                }));

        // Built once and shown or hidden in place: re-rendering the tab here would
        // collapse every section the reader had open.
        const initialIntervalsRow = sm2ParamsContainer.createDiv();

        new Setting(initialIntervalsRow)
            .setName(`Custom initial intervals (${SM2})`)
            .setDesc(`Comma-separated list for initial ${SM2} reviews (e.g., 0,1,3,7). Must start with 0.`)
            .addText(text => text
                .setValue(this.plugin.settings.initialScheduleCustomIntervals.join(', '))
                .onChange(async (value: string) => {
                    const intervals = value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 0);
                    if (intervals.length > 0 && intervals[0] === 0) {
                        this.plugin.settings.initialScheduleCustomIntervals = intervals;
                        await this.plugin.savePluginData();
                    } else {
                        new Notice(`Custom initial ${SM2} intervals must start with 0 and be valid numbers.`, 5000);
                        text.setValue(this.plugin.settings.initialScheduleCustomIntervals.join(', '));
                    }
                }));

        initialIntervalsRow.toggleClass('sf-hidden', !this.plugin.settings.useInitialSchedule);

        new Setting(sm2ParamsContainer)
            .setName(`Maximum interval (${SM2})`)
            .setDesc(`Longest possible interval between ${SM2} reviews.`)
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
            .setName(`Load balancing (${SM2})`)
            .setDesc(`Add slight randomness to ${SM2} intervals to prevent reviews clumping on the same day.`)
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
        fsrsSummary.setText(`${FSRS} parameters`);
        fsrsParamsContainer.open = false; // Initially closed

        new Setting(fsrsParamsContainer)
            .setName('Request retention')
            .setDesc('Desired recall probability (0.7-0.99, default: 0.9). Higher values mean more frequent reviews.')
            .addText(text => text
                .setValue(this.plugin.settings.fsrsParameters?.request_retention?.toString() ?? DEFAULT_SETTINGS.fsrsParameters.request_retention?.toString() ?? '0.9')
                .onChange(async (value) => {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue) && numValue >= 0.7 && numValue <= 0.99) {
                        this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, request_retention: numValue };
                        await this.plugin.savePluginData();
                        this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                    } else {
                        new Notice(`${FSRS} request retention must be between 0.7 and 0.99.`);
                    }
                }));

        new Setting(fsrsParamsContainer)
            .setName('Maximum interval (days)')
            .setDesc(`Longest possible interval ${FSRS} will schedule.`)
            .addText(text => text
                .setValue(this.plugin.settings.fsrsParameters?.maximum_interval?.toString() ?? DEFAULT_SETTINGS.fsrsParameters.maximum_interval?.toString() ?? '36500')
                .onChange(async (value) => {
                    const numValue = parseInt(value);
                    if (!isNaN(numValue) && numValue > 0) {
                        this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, maximum_interval: numValue };
                        await this.plugin.savePluginData();
                        this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                    } else {
                        new Notice(`${FSRS} maximum interval must be a positive number.`);
                    }
                }));

        new Setting(fsrsParamsContainer)
            .setName('Same-day relearning steps')
            .setDesc(`Anki-style short-term steps: a card rated Again comes back today (after a few minutes) instead of being pushed to tomorrow, and a new ${FSRS} card learns in short steps first. Turn this off for day-granularity scheduling only.`)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.fsrsParameters?.enable_short_term ?? DEFAULT_SETTINGS.fsrsParameters.enable_short_term ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, enable_short_term: value };
                    await this.plugin.savePluginData();
                    this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                }));

        new Setting(fsrsParamsContainer)
            .setName('Weights (w)')
            .setDesc(`${FSRS}-5 algorithm parameters (19 numbers). Edit with caution — the defaults are the weights the scheduler ships with.`)
            .addTextArea(text => {
                text.inputEl.rows = 3;
                text.inputEl.addClass('sf-full-width-textarea');
                text.setValue(this.plugin.settings.fsrsParameters?.w?.join(',') ?? DEFAULT_SETTINGS.fsrsParameters.w?.join(',') ?? '')
                    .onChange(async (value) => {
                        const weights = value.split(',').map(s => parseFloat(s.trim()));
                        if (weights.length === 19 && weights.every(n => !isNaN(n))) {
                            this.plugin.settings.fsrsParameters = { ...this.plugin.settings.fsrsParameters, w: weights };
                            await this.plugin.savePluginData();
                            this.plugin.reviewScheduleService.updateAlgorithmServicesForSettingsChange();
                        } else {
                            new Notice(`${FSRS} weights must be a comma-separated list of 19 valid numbers.`);
                        }
                    });
            });

        // --- Card Conversion Utilities ---
        const conversionContainer = spacedRepSection.createEl('details', { cls: 'sf-settings-collapsible-subsection' });
        const conversionSummary = conversionContainer.createEl('summary');
        // Changed to h3
        conversionSummary.setText('Card conversion utilities');
        conversionContainer.open = false; // Initially closed

        new Setting(conversionContainer)
            .setName(`Convert all ${SM2} cards to ${FSRS}`)
            .setDesc(`Migrate all existing ${SM2} cards to use the ${FSRS} algorithm. This will reset their learning state for ${FSRS}.`)
            .addButton(button => button
                .setButtonText(`Convert ${SM2} to ${FSRS}`)
                .setCta() // Call to action style
                .onClick(() => {
                    new ConfirmationModal(
                        this.app,
                        `Convert ${SM2} to ${FSRS}`,
                        `Are you sure you want to convert ALL ${SM2} cards to ${FSRS}? Their ${FSRS} learning state will be reset. This action cannot be easily undone.`,
                        async () => {
                            new Notice(`Converting ${SM2} cards to ${FSRS}... This may take a moment.`);
                            this.plugin.reviewScheduleService.convertAllSm2ToFsrs();
                            await this.plugin.savePluginData();
                            new Notice(`All ${SM2} cards have been converted to ${FSRS}.`);
                            this.display(); // Refresh settings tab
                        }
                    ).open();
                }));

        new Setting(conversionContainer)
            .setName(`Convert all ${FSRS} cards to ${SM2}`)
            .setDesc(`Migrate all existing ${FSRS} cards to use the ${SM2} algorithm. Their ${SM2} learning state will be initialized with defaults.`)
            .addButton(button => button
                .setButtonText(`Convert ${FSRS} to ${SM2}`)
                .setCta()
                .onClick(() => {
                    new ConfirmationModal(
                        this.app,
                        `Convert ${FSRS} to ${SM2}`,
                        `Are you sure you want to convert ALL ${FSRS} cards to ${SM2}? Their ${SM2} learning state will be reset to defaults. This action cannot be easily undone.`,
                        async () => {
                            new Notice(`Converting ${FSRS} cards to ${SM2}... This may take a moment.`);
                            this.plugin.reviewScheduleService.convertAllFsrsToSm2();
                            await this.plugin.savePluginData();
                            new Notice(`All ${FSRS} cards have been converted to ${SM2}.`);
                            this.display(); // Refresh settings tab
                        }
                    ).open();
                }));

        // ========= INTERFACE SECTION =========
        const interfaceSection = createCollapsible('Interface & behavior', 'settings', false); // Closed by default

        new Setting(interfaceSection)
            .setName("Display")
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
                    void this.plugin.getSidebarView()?.refresh();
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
            .setName("Review behavior")
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
            .setName(`Reading speed (${WPM})`)
            .setDesc('Words per minute for estimating review time')
            .addSlider(slider => slider
                .setLimits(100, 500, 10)
                .setValue(this.plugin.settings.readingSpeed)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.readingSpeed = value;
                    await this.plugin.savePluginData();
                }));

        interfaceSection.createDiv({ cls: 'sf-setting-explain', text: `Average adults read 200-250 ${WPM} for regular content, 100-150 ${WPM} for technical content` });

        new Setting(interfaceSection)
            .setName("Navigation command")
            .setHeading()
            .setClass("sf-settings-subsection-header");

        new Setting(interfaceSection)
            .setName('Enable navigation command')
            .setDesc('Execute a command with a slight delay after navigating to the next or previous note.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableNavigationCommands)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.enableNavigationCommands = value;
                    await this.plugin.savePluginData();
                    navCommandRows.toggleClass('sf-hidden', !value);
                }));

        // Dependent rows are built once and shown or hidden in place.
        const navCommandRows = interfaceSection.createDiv();

        new Setting(navCommandRows)
            .setName('Command to execute')
            .setDesc('Click the button and press the desired hotkey.')
            .addButton(button => {
                const describeChord = (command: { modifiers: string[]; key: string | null }): string =>
                    command.key ? [...command.modifiers, command.key].join(' + ') : 'Click to set';
                const hotkeyText = describeChord(this.plugin.settings.navigationCommand);
                button.setButtonText(hotkeyText)
                    .onClick(() => {
                        button.setButtonText('...');
                        // A second click must not leave the first capture running.
                        this.stopCapture(button, hotkeyText);
                        const keydownHandler = (e: KeyboardEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const modifiers = [];
                            if (e.ctrlKey) modifiers.push('Ctrl');
                            if (e.metaKey) modifiers.push('Meta');
                            if (e.altKey) modifiers.push('Alt');
                            if (e.shiftKey) modifiers.push('Shift');
                            let key = e.key;
                            if (key === ' ') key = 'Space';
                            if (key === 'Escape') {
                                this.stopCapture(button, hotkeyText);
                                return;
                            }
                            if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
                                const command = { modifiers, key };
                                this.plugin.settings.navigationCommand = command;
                                void this.plugin.savePluginData();
                                // The button carries the new chord itself; no need
                                // to rebuild the tab to relabel one button.
                                this.stopCapture(button, describeChord(command));
                            }
                        };
                        this.captureHandler = keydownHandler;
                        document.addEventListener('keydown', keydownHandler, { capture: true });
                        // Whatever happens to the settings screen, the listener
                        // does not outlive the plugin.
                        this.plugin.register(() => {
                            if (this.captureHandler === keydownHandler) {
                                this.captureHandler = null;
                            }
                            document.removeEventListener('keydown', keydownHandler, { capture: true });
                        });
                    });
            });
        new Setting(navCommandRows)
            .setName('Command execution delay (ms)')
            .setDesc('How long to wait before executing the command after navigation.')
            .addSlider(slider => slider
                .setLimits(0, 2000, 100)
                .setValue(this.plugin.settings.navigationCommandDelay)
                .setDynamicTooltip()
                .onChange(async (value: number) => {
                    this.plugin.settings.navigationCommandDelay = value;
                    await this.plugin.savePluginData();
                }));

        navCommandRows.toggleClass('sf-hidden', !this.plugin.settings.enableNavigationCommands);

        // ========= API CONFIGURATION SECTION =========
        // Its own section, above the features that use it: one provider serves the
        // multiple-choice questions and the Study tutor, so it is not a
        // multiple-choice setting. It is built whether or not those features are
        // on — picking a provider is what makes either of them usable.
        const apiSection = createCollapsible(`${API} configuration`, 'plug', false);

        new Setting(apiSection)
            .setName(`${API} provider`)
            .setDesc(`Select the ${API} provider for generating ${MCQS} and tutoring in Study.`)
            .addDropdown(dropdown => {
                // Every company, then every local CLI under its own name: a
                // provider that is not offered cannot be chosen, and one that is
                // offered always has rows and a model list to go with it. There is
                // no second choice of *which* CLI — the row is the CLI.
                for (const provider of listProviders()) {
                    dropdown.addOption(provider.id, provider.label);
                }
                dropdown
                    .setValue(this.plugin.settings.mcqApiProvider)
                    .onChange(async (value: ApiProvider) => {
                        this.plugin.settings.mcqApiProvider = value;
                        await this.plugin.savePluginData();
                        this.plugin.initializeMCQComponents(); // Re-initialize service
                        // Only the provider's own rows are redrawn. A full re-render
                        // would close every open section and lose the reader's place.
                        rerenderProviderFields();
                    });
            });

        // What the plugin can reach right now, as a count and the names that are
        // ready: keys in the settings or the environment, local servers that
        // answer, CLIs that are signed in. The chosen provider's own row carries
        // the detail — one line per provider, not a list of essays.
        const statusRow = new Setting(apiSection)
            .setName('Detected providers')
            .setDesc('Keys in your environment and CLIs already signed in on this machine count too.')
            .addButton(button => button
                .setButtonText('Detect')
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText('Detecting…');
                    const statuses = await detectProviders(this.plugin.settings);
                    button.setDisabled(false);
                    button.setButtonText('Detect');
                    this.renderProviderStatus(statusRow.descEl, statuses);
                }));
        const cached = this.providerStatusCache;
        if (cached) this.renderProviderStatus(statusRow.descEl, cached);

        // The chosen provider's own rows render into this container and nowhere
        // else, so switching provider redraws them without touching the tab.
        const providerFields = apiSection.createDiv();
        const rerenderProviderFields = (): void => {
            providerFields.empty();
            this.buildProviderConfiguration(providerFields);
        };
        rerenderProviderFields();

        // ========= MCQ SECTION =========
        const mcqSectionContainer = createCollapsible('Multiple choice questions', 'newspaper', false); // Closed by default

        new Setting(mcqSectionContainer)
            .setName('Enable multiple choice feature')
            .setDesc('Use AI-generated multiple-choice questions to test your knowledge')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMCQ)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.enableMCQ = value;
                    await this.plugin.savePluginData();

                    // Reinitialize MCQ components
                    this.plugin.initializeMCQComponents();

                    // The feature's settings are shown and hidden in place; a
                    // re-render would close the sections the reader has open.
                    syncMcqSettings();
                }));

        // The feature owns this wrapper, rendered once and shown or hidden as a
        // whole, so the toggle above never rebuilds the tab.
        const mcqBody = mcqSectionContainer.createDiv();
        const renderMcqSettings = (mcqSection: HTMLElement): void => {
            new Setting(mcqSection)
                .setName('Grade after a set of questions')
                .setDesc('Ask me: the sitting ends with its score and the grade buttons wait under the note, with the grade the score implies suggested. Or apply that grade as soon as the last question is answered. Either way the review bar stays on the note.')
                .addDropdown(dropdown => dropdown
                    .addOption('ask', 'Ask me (suggest the score-derived grade)')
                    .addOption('score', 'Apply the score-derived grade')
                    .setValue(this.plugin.settings.mcqGradingMode)
                    .onChange(async (value: string) => {
                        this.plugin.settings.mcqGradingMode = value === 'score' ? 'score' : 'ask';
                        await this.plugin.savePluginData();
                    }));

            // The provider's own rows are not here: they live in the "API
            // configuration" section above, which one provider serves for both the
            // questions and Study.

            // Question generation settings (common to all providers)
            new Setting(mcqSection)
                .setName("Question generation (common)")
                .setHeading()
                .setClass("sf-settings-subsection-header");

            // Setting for Question Amount Mode
            new Setting(mcqSection)
                .setName('Question amount mode')
                .setDesc('How to determine the number of questions per note.')
                .addDropdown(dropdown => dropdown
                    .addOption(MCQQuestionAmountMode.Fixed, 'Fixed number')
                    .addOption(MCQQuestionAmountMode.WordsPerQuestion, 'By note length')
                    .setValue(this.plugin.settings.mcqQuestionAmountMode)
                    .onChange(async (value: MCQQuestionAmountMode) => {
                        this.plugin.settings.mcqQuestionAmountMode = value;
                        await this.plugin.savePluginData();
                        // Two alternative rows: show the one the mode asks for.
                        syncAmountMode();
                    }));

            // Both rows exist; the mode decides which is shown. A re-render here
            // would close the section the reader is working in.
            const fixedAmountRow = mcqSection.createDiv();
            const wordsAmountRow = mcqSection.createDiv();

            new Setting(fixedAmountRow)
                .setName('Questions per note (fixed)')
                .setDesc('Number of questions to generate for each note.')
                .addSlider(slider => slider
                    .setLimits(1, 10, 1)
                    .setValue(this.plugin.settings.mcqQuestionsPerNote)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.mcqQuestionsPerNote = value;
                        await this.plugin.savePluginData();
                    }));

            new Setting(wordsAmountRow)
                .setName('Words per question target')
                .setDesc('Questions follow the length of the note: one question for every this many words.')
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

            const syncAmountMode = (): void => {
                const mode = this.plugin.settings.mcqQuestionAmountMode;
                fixedAmountRow.toggleClass('sf-hidden', mode !== MCQQuestionAmountMode.Fixed);
                wordsAmountRow.toggleClass('sf-hidden', mode !== MCQQuestionAmountMode.WordsPerQuestion);
            };
            syncAmountMode();

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
            const mcqFormattingGrid = mcqSection.createDiv({ cls: 'sf-setting-grid' });

            // First item in grid
            const promptTypeContainer = mcqFormattingGrid.createDiv();
            new Setting(promptTypeContainer)
                .setName('Prompt type')
                .setDesc('Format for question generation')
                .addDropdown(dropdown => dropdown
                    .addOption('basic', 'Basic')
                    .addOption('detailed', 'Detailed')
                    .setValue(this.plugin.settings.mcqPromptType)
                    .onChange(async (value: 'basic' | 'detailed') => {
                        this.plugin.settings.mcqPromptType = value;
                        await this.plugin.savePluginData();
                    }));

            // Second item in grid
            const difficultyContainer = mcqFormattingGrid.createDiv();
            new Setting(difficultyContainer)
                .setName('Difficulty')
                .setDesc('Complexity level')
                .addDropdown(dropdown => dropdown
                    .addOption(MCQDifficulty.Basic, 'Basic recall')
                    .addOption(MCQDifficulty.Advanced, 'Advanced understanding')
                    .setValue(this.plugin.settings.mcqDifficulty)
                    .onChange(async (value: MCQDifficulty) => {
                        this.plugin.settings.mcqDifficulty = value;
                        await this.plugin.savePluginData();
                    }));

            // Scoring settings
            new Setting(mcqSection)
                .setName("Scoring")
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
            new Setting(mcqSection)
                .setName('Deduct full mark on first failure')
                .setDesc('If enabled, the score for a question will be 0 if the first attempt is incorrect.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.mcqDeductFullMarkOnFirstFailure)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.mcqDeductFullMarkOnFirstFailure = value;
                        await this.plugin.savePluginData();
                    }));

            // Add collapsible section for system prompts
            const systemPromptsContainer = mcqSection.createEl('details', { cls: 'sf-system-prompts-container' });
            systemPromptsContainer.createEl('summary', { text: 'System prompts (advanced)', cls: 'sf-settings-subsection' });

            // Basic prompt textarea
            systemPromptsContainer.createDiv({ text: 'Basic difficulty prompt', cls: 'sf-prompt-label' });
            const basicTextarea = systemPromptsContainer.createEl('textarea', {
                attr: {
                    placeholder: 'Enter system prompt for basic difficulty',
                    rows: '6'
                },
                cls: 'prompt-textarea'
            });

            // Set value and add change handler
            basicTextarea.value = this.plugin.settings.mcqBasicSystemPrompt;
            basicTextarea.addEventListener('change', () => {
                this.plugin.settings.mcqBasicSystemPrompt = basicTextarea.value;
                void this.plugin.savePluginData();
            });

            // Advanced prompt textarea
            systemPromptsContainer.createDiv({ text: 'Advanced difficulty prompt', cls: 'sf-prompt-label' });
            const advancedTextarea = systemPromptsContainer.createEl('textarea', {
                attr: {
                    placeholder: 'Enter system prompt for advanced difficulty',
                    rows: '6'
                },
                cls: 'prompt-textarea'
            });

            // Set value and add change handler
            advancedTextarea.value = this.plugin.settings.mcqAdvancedSystemPrompt;
            advancedTextarea.addEventListener('change', () => {
                this.plugin.settings.mcqAdvancedSystemPrompt = advancedTextarea.value;
                void this.plugin.savePluginData();
            });

            // Advanced Question Behavior subsection
            new Setting(mcqSection)
                .setName("Advanced question behavior")
                .setHeading()
                .setClass("sf-settings-subsection-header");

            new Setting(mcqSection)
                .setName('Enable question regeneration on rating')
                .setDesc('Automatically regenerate questions for a note if its review rating meets or exceeds a specified value.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.enableQuestionRegenerationOnRating)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.enableQuestionRegenerationOnRating = value;
                        await this.plugin.savePluginData();
                        // The two thresholds below appear and disappear in place.
                        regenerationRows.toggleClass('sf-hidden', !value);
                    }));

            const regenerationRows = mcqSection.createDiv();

            new Setting(regenerationRows)
                .setName(`Minimum rating for regeneration (${SM2})`)
                .setDesc(`For ${SM2}: Regenerate ${MCQS} if review rating (0-5) is this value or higher. (0:Blackout, 5:Perfect)`)
                .addSlider(slider => slider
                    .setLimits(0, 5, 1)
                    .setValue(this.plugin.settings.minSm2RatingForQuestionRegeneration)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.minSm2RatingForQuestionRegeneration = value;
                        await this.plugin.savePluginData();
                    }));

            new Setting(regenerationRows)
                .setName(`Minimum rating for regeneration (${FSRS})`)
                .setDesc(`For ${FSRS}: Regenerate ${MCQS} if review rating (1-4) is this value or higher. (1:Again, 4:Easy)`)
                .addSlider(slider => slider
                    .setLimits(1, 4, 1) // FSRS ratings are 1-4
                    .setValue(this.plugin.settings.minFsrsRatingForQuestionRegeneration)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.minFsrsRatingForQuestionRegeneration = value;
                        await this.plugin.savePluginData();
                    }));

            regenerationRows.toggleClass('sf-hidden', !this.plugin.settings.enableQuestionRegenerationOnRating);
        };
        renderMcqSettings(mcqBody);

        const mcqDisabledMessage = mcqSectionContainer.createDiv({ cls: 'sf-info-box' });
        mcqDisabledMessage.createEl('p', {
            text: `${MCQS} are currently turned off. Turn the feature on to set how its questions are generated, scored and graded.`
        });

        const syncMcqSettings = (): void => {
            mcqBody.toggleClass('sf-hidden', !this.plugin.settings.enableMCQ);
            mcqDisabledMessage.toggleClass('sf-hidden', this.plugin.settings.enableMCQ);
        };
        syncMcqSettings();

        // ========= STUDY (ADAPTIVE TUTOR) SECTION =========
        const studySectionContainer = createCollapsible('Study', 'graduation-cap', false);

        new Setting(studySectionContainer)
            .setName('Enable Study')
            .setDesc('Adaptive tutoring over your notes: the note is charted into objectives, taught in small pieces, and tested until you can use it.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.studyEnabled)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.studyEnabled = value;
                    await this.plugin.savePluginData();
                    void this.plugin.getSidebarView()?.refresh();
                    studyBody.toggleClass('sf-hidden', !value);
                }));

        // Same pattern as the multiple-choice section: built once, shown or hidden
        // as a whole.
        const studyBody = studySectionContainer.createDiv();
        const renderStudySettings = (studySection: HTMLElement): void => {
            new Setting(studySection)
                .setName('Chart notes ahead of time')
                .setDesc('Off by default. When it is off, a note is charted the moment you open its Study panel and questions are written when you ask for them — one note at a time, when you are looking at it. Turn this on to chart every scheduled note in advance instead, a few sections per pass.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.studyAutoChart)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.studyAutoChart = value;
                        await this.plugin.savePluginData();
                        if (value) this.plugin.chartAllScheduledNotes();
                        void this.plugin.getSidebarView()?.refresh();
                        // The rows this turns on appear in place.
                        autoChartRows.toggleClass('sf-hidden', !value);
                    }));

            const autoChartRows = studySection.createDiv();

            new Setting(autoChartRows)
                .setName('Sections charted per pass')
                .setDesc('How much of one note is charted before the background job moves on. Higher finishes a long note sooner; lower keeps the model calls spread out.')
                .addSlider(slider => slider
                    .setLimits(1, 10, 1)
                    .setValue(this.plugin.settings.studyChartSectionsPerRun)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.studyChartSectionsPerRun = value;
                        await this.plugin.savePluginData();
                    }));

            const chartRow = autoChartRows.createDiv({ cls: 'sf-info-box' });
            const chartStatus = chartRow.createEl('p', {
                text: 'Charting happens quietly in the background; the sidebar shows what it is working on and can pause it.',
            });
            const chartAll = chartRow.createEl('button', { text: 'Chart scheduled notes now', cls: 'sf-btn' });
            chartAll.addEventListener('click', () => {
                this.plugin.chartAllScheduledNotes();
                const queue = this.plugin.studyChartQueue.getStatus();
                chartStatus.setText(queue.message || `${queue.queued} note(s) queued for charting.`);
            });

            autoChartRows.toggleClass('sf-hidden', !this.plugin.settings.studyAutoChart);

            // The auto-pilot. Deliberately outside `autoChartRows`: a note
            // charted by hand gets the same follow-ups, so these two belong to
            // the chart finishing, not to background charting being on.
            new Setting(studySection)
                .setName('Make Study material automatically')
                .setDesc('After a note is charted, draw its mind map, boards and summary in the background — the same material the Study panel makes when you ask for it.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.studyAutoMaterials)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.studyAutoMaterials = value;
                        await this.plugin.savePluginData();
                        // The hint this turns on appears in place.
                        syncAutoFollowRows();
                    }));

            new Setting(studySection)
                .setName('Write questions automatically')
                .setDesc('After a note is charted, write its question set in the background, so a review or the questions tab finds it ready instead of generating it while you watch.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.studyAutoMcq)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.studyAutoMcq = value;
                        await this.plugin.savePluginData();
                        syncAutoFollowRows();
                    }));

            const autoFollowRows = studySection.createDiv();
            const autoFollowInfo = autoFollowRows.createDiv({ cls: 'sf-info-box' });
            autoFollowInfo.createEl('p', {
                text: 'A charted note is finished quietly in the background: the material first, then its questions. Nothing is made for a note that has not been charted, and a step that fails is logged rather than announced.',
            });

            const syncAutoFollowRows = (): void => {
                autoFollowRows.toggleClass('sf-hidden', !(this.plugin.settings.studyAutoMaterials || this.plugin.settings.studyAutoMcq));
            };
            syncAutoFollowRows();

            new Setting(studySection)
                .setName('Show the Study button on note rows')
                .setDesc('Adds a Study button next to each note in the sidebar, with a dot when objectives are due.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.studyShowInSidebar)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.studyShowInSidebar = value;
                        await this.plugin.savePluginData();
                        void this.plugin.getSidebarView()?.refresh();
                    }));

            new Setting(studySection)
                .setName('Tutor')
                .setHeading()
                .setClass('sf-settings-subsection-header');

            new Setting(studySection)
                .setName('Starting level')
                .setDesc('Where the tutor starts. Auto reads it from your first few answers.')
                .addDropdown(dropdown => dropdown
                    .addOption(StudyExpertise.Auto, 'Auto (recommended)')
                    .addOption(StudyExpertise.Beginner, 'Beginner')
                    .addOption(StudyExpertise.Intermediate, 'Intermediate')
                    .addOption(StudyExpertise.Advanced, 'Advanced')
                    .setValue(this.plugin.settings.studyExpertise)
                    .onChange(async (value: string) => {
                        this.plugin.settings.studyExpertise = value as StudyExpertise;
                        await this.plugin.savePluginData();
                    }));

            new Setting(studySection)
                .setName('Tutor language')
                .setDesc('Leave empty to match the language of the note. Otherwise, e.g. English or العربية.')
                .addText(text => text
                    .setPlaceholder('Match the note')
                    .setValue(this.plugin.settings.studyLanguage)
                    .onChange(async (value: string) => {
                        this.plugin.settings.studyLanguage = value.trim();
                        await this.plugin.savePluginData();
                    }));

            new Setting(studySection)
                .setName('Objectives per note')
                .setDesc('Upper bound on how finely a note is charted. More objectives means smaller steps but more turns.')
                .addSlider(slider => slider
                    .setLimits(4, 60, 1)
                    .setValue(this.plugin.settings.studyMaxObjectives)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.studyMaxObjectives = value;
                        await this.plugin.savePluginData();
                    }));

            new Setting(studySection)
                .setName('Turns per session')
                .setDesc('The session wraps itself up with a summary when it reaches this many turns.')
                .addSlider(slider => slider
                    .setLimits(6, 60, 2)
                    .setValue(this.plugin.settings.studyTurnLimit)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.studyTurnLimit = value;
                        await this.plugin.savePluginData();
                    }));

            new Setting(studySection)
                .setName('Temperature')
                .setDesc('Lower is more literal and repeatable, higher is more inventive. 0.3-0.5 suits most tutoring.')
                .addSlider(slider => slider
                    .setLimits(0, 1, 0.05)
                    .setValue(this.plugin.settings.studyTemperature)
                    .setDynamicTooltip()
                    .onChange(async (value: number) => {
                        this.plugin.settings.studyTemperature = value;
                        await this.plugin.savePluginData();
                    }));

            new Setting(studySection)
                .setName('Maximum output tokens per turn')
                .setDesc('Caps the length of a single tutor reply. Thinking models (qwen3, deepseek-r1 and similar) spend part of this on reasoning before they answer, so give them 2000-4000. Charting scales its own budget above this for long sections.')
                .addText(text => text
                    .setPlaceholder('2000')
                    .setValue(this.plugin.settings.studyMaxTokens.toString())
                    .onChange(async (value: string) => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 256) {
                            this.plugin.settings.studyMaxTokens = parsed;
                            await this.plugin.savePluginData();
                        }
                    }));

            new Setting(studySection)
                .setName('Context window for local models')
                .setDesc(`Sent as num_ctx to ${OLLAMA}. Raise it for long notes, lower it if your machine struggles.`)
                .addText(text => text
                    .setPlaceholder('8192')
                    .setValue(this.plugin.settings.studyContextWindow.toString())
                    .onChange(async (value: string) => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 1024) {
                            this.plugin.settings.studyContextWindow = parsed;
                            await this.plugin.savePluginData();
                        }
                    }));

            new Setting(studySection)
                .setName('Record the session in the review schedule straight away')
                .setDesc('Off: the session ends with its score and the grade buttons wait under the note (the grade the score implies is suggested). On: the result is recorded as soon as the session ends. Nothing moves you off the note either way.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.studyAutoRateNote)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.studyAutoRateNote = value;
                        await this.plugin.savePluginData();
                    }));

            const studyInfo = studySection.createDiv({ cls: 'sf-info-box' });
            studyInfo.createEl('p', {
                text: `Study uses the ${API} provider set in the ${API} configuration section above: ${this.plugin.studyController ? this.plugin.studyController.providerLabel() : 'not configured yet'}.`,
            });

            new Setting(studySection)
                .setName('Web lookup')
                .setHeading()
                .setClass('sf-settings-subsection-header');

            new Setting(studySection)
                .setName('Search provider')
                .setDesc('Lets the tutor verify mechanisms and current facts mid-session. It can only cite sources this provider actually returned.')
                .addDropdown(dropdown => dropdown
                    .addOption(StudySearchProvider.None, 'Off — no lookups')
                    .addOption(StudySearchProvider.Tavily, 'Tavily')
                    .addOption(StudySearchProvider.Brave, 'Brave')
                    .addOption(StudySearchProvider.Searxng, 'SearXNG (self-hosted)')
                    .addOption(StudySearchProvider.Custom, 'Custom JSON endpoint')
                    .setValue(this.plugin.settings.studySearchProvider)
                    .onChange(async (value: string) => {
                        this.plugin.settings.studySearchProvider = value as StudySearchProvider;
                        await this.plugin.savePluginData();
                        // The choice decides which rows apply, so exactly those rows
                        // are redrawn — never the whole tab.
                        rerenderSearchFields();
                    }));

            // Everything the choice decides renders here: as many rows as the
            // provider needs, and the status line under them.
            const searchFields = studySection.createDiv();
            const rerenderSearchFields = (): void => {
                searchFields.empty();
                const searchProvider = this.plugin.settings.studySearchProvider;

                if (searchProvider !== StudySearchProvider.None) {
                    if (searchProvider !== StudySearchProvider.Custom) {
                        new Setting(searchFields)
                            .setName('Search API key')
                            .setDesc('Key for the selected search provider.')
                            .addText(text => text
                                .setPlaceholder('Enter the search API key')
                                .setValue(this.plugin.settings.studySearchApiKey)
                                .onChange(async (value: string) => {
                                    this.plugin.settings.studySearchApiKey = value;
                                    await this.plugin.savePluginData();
                                }));
                    }

                    if (searchProvider === StudySearchProvider.Searxng ||
                        searchProvider === StudySearchProvider.Custom) {
                        new Setting(searchFields)
                            .setName('Endpoint')
                            .setDesc(searchProvider === StudySearchProvider.Searxng
                                ? `Base URL of your SearXNG instance with the JSON API enabled (e.g. http:${'//'}localhost:8080).`
                                : 'URL that accepts a JSON body of {query, max_results} and returns a results array of {title, url, content}.')
                            .addText(text => text
                                .setPlaceholder(`http:${'//'}localhost:8080`)
                                .setValue(this.plugin.settings.studySearchEndpoint)
                                .onChange(async (value: string) => {
                                    this.plugin.settings.studySearchEndpoint = value.trim();
                                    await this.plugin.savePluginData();
                                }));
                    }

                    new Setting(searchFields)
                        .setName('Sources per lookup')
                        .setDesc('How many results to pull for each question the tutor asks.')
                        .addSlider(slider => slider
                            .setLimits(1, 10, 1)
                            .setValue(this.plugin.settings.studySearchMaxResults)
                            .setDynamicTooltip()
                            .onChange(async (value: number) => {
                                this.plugin.settings.studySearchMaxResults = value;
                                await this.plugin.savePluginData();
                            }));

                    new Setting(searchFields)
                        .setName('Lookups on by default in a session')
                        .setDesc('The switch is still in the Study window, so this only sets where it starts.')
                        .addToggle(toggle => toggle
                            .setValue(this.plugin.settings.studyWebSearchDefault)
                            .onChange(async (value: boolean) => {
                                this.plugin.settings.studyWebSearchDefault = value;
                                await this.plugin.savePluginData();
                            }));
                }

                const lookupStatus = this.plugin.studyWebSearchService?.status();
                const lookupInfo = searchFields.createDiv({ cls: 'sf-info-box' });
                lookupInfo.createEl('p', {
                    text: lookupStatus?.ok
                        ? `Lookups will use ${lookupStatus.label}. With lookups off, the tutor labels anything it cannot verify instead of guessing.`
                        : `Lookups are unavailable: ${lookupStatus?.reason ?? 'no provider configured'}. With lookups off, the tutor labels anything it cannot verify instead of guessing.`,
                });
            };
            rerenderSearchFields();
        };
        renderStudySettings(studyBody);
        studyBody.toggleClass('sf-hidden', !this.plugin.settings.studyEnabled);

        // ========= POMODORO TIMER SECTION =========
        const pomodoroSectionContainer = createCollapsible(`${POMODORO} timer`, 'timer', false); // Added timer icon

        new Setting(pomodoroSectionContainer)
            .setName(`Enable ${POMODORO} timer`)
            .setDesc(`Show the ${POMODORO} timer in the sidebar.`)
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.pomodoroEnabled)
                .onChange(async (value: boolean) => {
                    this.plugin.settings.pomodoroEnabled = value;
                    await this.plugin.savePluginData();
                    // Notify the service and refresh UI elements
                    this.plugin.pomodoroService?.onSettingsChanged();
                    void this.plugin.getSidebarView()?.refresh(); // Refresh sidebar to show/hide timer
                    syncPomodoroSettings(); // Show or hide the settings below, in place
                }));

        // Same pattern again: the timer's rows are built once and shown or hidden as
        // a whole, so the toggle never rebuilds the tab.
        const pomodoroBody = pomodoroSectionContainer.createDiv();
        const renderPomodoroSettings = (pomodoroSection: HTMLElement): void => {
            new Setting(pomodoroSection)
                .setName("Timer durations (minutes)")
                .setHeading()
                .setClass("sf-settings-subsection-header");

            new Setting(pomodoroSection)
                .setName('Work duration')
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
                .setName('Short break duration')
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
                .setName('Long break duration')
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
                .setName('Sessions until long break')
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
                .setName('Enable sound notifications')
                .setDesc('Play a sound at the end of each work/break session.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.pomodoroSoundEnabled)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.pomodoroSoundEnabled = value;
                        await this.plugin.savePluginData();
                    }));
        };
        renderPomodoroSettings(pomodoroBody);

        const pomodoroDisabledMessage = pomodoroSectionContainer.createDiv({ cls: 'sf-info-box' });
        pomodoroDisabledMessage.createEl('p', {
            text: `The ${POMODORO} timer is turned off. Turn it on to set its durations and its notification.`
        });

        const syncPomodoroSettings = (): void => {
            pomodoroBody.toggleClass('sf-hidden', !this.plugin.settings.pomodoroEnabled);
            pomodoroDisabledMessage.toggleClass('sf-hidden', this.plugin.settings.pomodoroEnabled);
        };
        syncPomodoroSettings();

        // ========= DATA MANAGEMENT SECTION =========
        const dataSection = createCollapsible('Data management', 'database', false);

        const defaultPath = this.plugin.app.vault.configDir + `/ plugins / ${this.plugin.manifest.id}/data.json`;
        let locationDesc = `Default: ${defaultPath}`;
        if (this.plugin.settings.useCustomDataPath && this.plugin.settings.customDataPath) {
            const customPath = this.plugin.settings.customDataPath.endsWith('/data.json')
                ? this.plugin.settings.customDataPath
                : `${this.plugin.settings.customDataPath}/data.json`;
            locationDesc = `Custom: ${customPath}`;
        }

        new Setting(dataSection)
            .setName('Current data location')
            .setDesc(locationDesc)
            .addExtraButton(button => button
                .setIcon('info')
                .setTooltip(`Current location of your ${SPACEFORGE} data`)
                .onClick(() => {
                    const message = this.plugin.settings.useCustomDataPath && this.plugin.settings.customDataPath
                        ? `Your data is stored at: ${this.plugin.settings.customDataPath.endsWith('/data.json') ? this.plugin.settings.customDataPath : `${this.plugin.settings.customDataPath}/data.json`}`
                        : `Your data is stored at: ${defaultPath}`;

                    new Notice(message, 8000);
                }));

        // Check if old default data file exists when using custom path
        if (this.plugin.settings.useCustomDataPath) {
            const oldFile = this.plugin.app.vault.getAbstractFileByPath(defaultPath);

            if (oldFile) {
                new Setting(dataSection)
                    .setName('Legacy data file found')
                    .setDesc(`A data file exists at the default location. You can safely delete it or keep it as a backup.`)
                    .addButton(button => button
                        .setButtonText('Keep as backup')
                        .setIcon('save')
                        .onClick(() => {
                            new Notice('Legacy data file kept as backup. You can delete it manually when ready.', 5000);
                        }))
                    .addButton(button => button
                        .setButtonText('Delete legacy file')
                        .setIcon('trash')
                        .setWarning()
                        .onClick(() => {
                            new ConfirmationModal(
                                this.plugin.app,
                                'Delete legacy data file',
                                'Are you sure you want to delete the legacy data file? Make sure your custom data path is working correctly before proceeding.',
                                async () => {
                                    try {
                                        await this.plugin.app.fileManager.trashFile(oldFile);
                                        new Notice('Legacy data file deleted successfully.', 3000);
                                        this.display(); // Refresh settings
                                    } catch (error) {
                                        const msg = error instanceof Error ? error.message : String(error);
                                        new Notice('Failed to delete legacy file: ' + msg, 5000);
                                    }
                                }
                            ).open();
                        }));
            }
        }

        // Add global action buttons at the bottom
        createActionButtons();

        // Put the reader back where they were before the rebuild.
        if (scroller && scrollTop > 0) scroller.scrollTop = scrollTop;
    }

    private renderAboutAlgorithmSection(container: HTMLElement, algorithm: 'sm2' | 'fsrs'): void {
        container.empty(); // Clear previous content

        if (algorithm === 'sm2') {
            new Setting(container).setName(`About modified ${SM2} algorithm`).setHeading();
            container.createEl('p', {
                text: `Spaceforge uses a modified version of the SuperMemo ${SM2} algorithm (1991) which schedules reviews based on how well you recall information. ` +
                    'When you rate your recall quality from 0-5, the algorithm adjusts the interval and difficulty (ease factor) accordingly.'
            });
            container.createEl('p', {
                text: 'Our implementation includes specific handling for overdue or skipped items to prevent them from accumulating in a backlog:'
            });
            const sm2List = container.createEl('ul');
            sm2List.createEl('li', { text: `${'Overdue'} items: Automatically set to review tomorrow with a quality rating of 0.` });
            sm2List.createEl('li', { text: `${'Postponed'} items: Explicitly moved to tomorrow with a one-step quality penalty.` });
            sm2List.createEl('li', { text: 'Both cases reset the repetition count to 1 and update the ease factor.' });

            const ratingsTable = container.createEl('table', { cls: 'sf-ratings-table' }); // Added a class for potential styling
            const thead = ratingsTable.createTHead();
            const tbody = ratingsTable.createTBody();
            const headerRow = thead.insertRow();
            headerRow.createEl('th', { text: 'Rating (0-5)' });
            headerRow.createEl('th', { text: 'Description' });
            headerRow.createEl('th', { text: 'Effect on interval' });

            const row1 = tbody.insertRow();
            row1.createEl('td', { text: '0-2' });
            row1.createEl('td', { text: 'Incorrect / struggled' });
            row1.createEl('td', { text: 'Resets, shortest interval' });

            const row2 = tbody.insertRow();
            row2.createEl('td', { text: '3' });
            row2.createEl('td', { text: 'Correct with difficulty' });
            row2.createEl('td', { text: 'Small increase' });

            const row3 = tbody.insertRow();
            row3.createEl('td', { text: '4' });
            row3.createEl('td', { text: 'Correct with hesitation' });
            row3.createEl('td', { text: 'Moderate increase' });

            const row4 = tbody.insertRow();
            row4.createEl('td', { text: '5' });
            row4.createEl('td', { text: 'Perfect recall' });
            row4.createEl('td', { text: 'Largest increase' });
        } else if (algorithm === 'fsrs') {
            new Setting(container).setName(`About ${FSRS} algorithm`).setHeading();
            container.createEl('p', {
                text: `${FSRS} (Free Spaced Repetition Scheduler) is a modern, evidence-based algorithm that models memory retention to optimize review schedules. ` +
                    `It calculates card difficulty and stability dynamically based on your review history and aims for a target retention rate.`
            });
            container.createEl('p', {
                text: `Key concepts in ${FSRS}:`
            });
            const fsrsList = container.createEl('ul');
            fsrsList.createEl('li', { text: `${'Difficulty'}: How hard a card is to remember.` });
            fsrsList.createEl('li', { text: `${'Stability'}: How long a card is likely to be remembered.` });
            fsrsList.createEl('li', { text: `${'Retention'}: The probability of recalling a card at the time of review.` });
            fsrsList.createEl('li', { text: `${'Learning'} steps: Initial short intervals for new cards (configurable).` });

            const ratingsTable = container.createEl('table', { cls: 'sf-ratings-table' });
            const thead = ratingsTable.createTHead();
            const tbody = ratingsTable.createTBody();
            const headerRow = thead.insertRow();
            headerRow.createEl('th', { text: 'Rating (1-4)' });
            headerRow.createEl('th', { text: 'Description' });
            headerRow.createEl('th', { text: 'Effect on stability/difficulty' });

            const row1 = tbody.insertRow();
            row1.createEl('td', { text: `${'1 (Again)'}` });
            row1.createEl('td', { text: 'Forgot the card' });
            row1.createEl('td', { text: 'Decreases stability, may increase difficulty' });

            const row2 = tbody.insertRow();
            row2.createEl('td', { text: `${'2 (Hard)'}` });
            row2.createEl('td', { text: 'Recalled with significant difficulty' });
            row2.createEl('td', { text: 'Smaller increase in stability' });

            const row3 = tbody.insertRow();
            row3.createEl('td', { text: `${'3 (Good)'}` });
            row3.createEl('td', { text: 'Recalled correctly' });
            row3.createEl('td', { text: 'Standard increase in stability' });

            const row4 = tbody.insertRow();
            row4.createEl('td', { text: `${'4 (Easy)'}` });
            row4.createEl('td', { text: 'Recalled easily' });
            row4.createEl('td', { text: 'Largest increase in stability' });
        }


    }
    /**
     * The rows for the chosen provider: its key (or its URL, for a server that
     * needs none) and the model to use. They render into the container the caller
     * owns, so switching provider redraws exactly these rows and nothing else —
     * the sections the reader has open stay open, and the scroll position holds.
     */
    private buildProviderConfiguration(container: HTMLElement): void {
        // The provider choice, the reachability report and the container this
        // renders into all live in the section (display), which owns them for the
        // lifetime of the tab. Here: only the rows for the chosen provider.
        const provider = this.plugin.settings.mcqApiProvider;

        const agentId = agentIdOfProvider(provider);
        if (agentId || provider === ApiProvider.Cli) {
            this.addCliConfiguration(container, agentId ?? this.plugin.settings.cliAgent);
            return;
        }

        const descriptor = getHttpProvider(provider);
        if (!descriptor) {
            const unsupported = container.createDiv({ cls: 'sf-info-box' });
            unsupported.createEl('p', {
                text: `This ${API} provider is not supported any more. Pick another one above.`,
            });
            return;
        }

        new Setting(container)
            .setName(`${descriptor.label} configuration`)
            .setHeading()
            .setClass("sf-settings-subsection-provider-header");

        // The chosen provider's matrix: what the vault holds, what that becomes at
        // the endpoint, and the model it would ask for. No network call is needed
        // for any of it — the check row above is what goes and looks.
        const matrix = container.createDiv({ cls: 'sf-detect-matrix' });
        const storedKey = providerStoredKey(descriptor, this.plugin.settings);
        const envName = descriptor.envKeys.find(name => getEnvVar(name));
        this.renderDetectionMatrix(matrix, [
            ['Key', storedKey
                ? 'from this vault'
                : envName
                    ? `from your environment (${envName})`
                    : descriptor.keyOptional ? 'not needed' : 'not set'],
            ['Endpoint', resolveHttpBaseUrl(descriptor, this.plugin.settings) || '—'],
            ['Model', providerModel(descriptor, this.plugin.settings) || '—'],
        ]);

        // The endpoint first when it is the reader's to give: a key belongs to a
        // URL, not the other way round.
        if (providerNeedsUrl(descriptor)) {
            new Setting(container)
                .setName(`${API} URL`)
                .setDesc(descriptor.endpoint
                    ? `Base URL of the ${descriptor.label} ${API}. Empty means ${descriptor.endpoint}.`
                    : `Base URL of the ${descriptor.label} ${API}.`)
                .addText(text => text
                    .setPlaceholder(descriptor.endpoint || `Your ${API} URL`)
                    .setValue(providerStoredUrl(descriptor, this.plugin.settings))
                    .onChange(async (value: string) => {
                        setProviderBaseUrl(descriptor, this.plugin.settings, value.trim());
                        await this.plugin.savePluginData();
                    }));
        }

        const keyRow = new Setting(container)
            .setName(`${API} key`)
            .setDesc(descriptor.keyOptional
                ? `${descriptor.label} does not require a key. One set in your environment counts too.`
                : `Required for generating ${MCQS} with ${descriptor.label}. A key set in your environment counts too.`)
            .addText(text => text
                .setPlaceholder(descriptor.keyPlaceholder ?? `Your ${descriptor.label} ${API} key`)
                .setValue(providerStoredKey(descriptor, this.plugin.settings))
                .onChange(async (value: string) => {
                    setProviderKey(descriptor, this.plugin.settings, value.trim());
                    await this.plugin.savePluginData();
                }));

        // One line about this provider, where its key is: what a check found is
        // otherwise a wall of text for twenty-eight rows nobody asked about.
        const keyStatusEl = keyRow.descEl.createDiv({ cls: 'sf-model-status' });
        const keyStatus = this.providerStatusCache?.find(status => status.id === descriptor.id);
        if (keyStatus) setStatusText(keyStatusEl, keyStatus.message, keyStatus.level);

        if (descriptor.note) {
            container.createDiv({ cls: 'sf-setting-explain' }).setText(descriptor.note);
        }

        this.addModelSetting(container, this.modelFieldFor(descriptor));
    }

    /** The model field's spec for a registry provider. */
    private modelFieldFor(descriptor: HttpProviderDescriptor): ModelFieldSpec {
        return {
            id: descriptor.id,
            label: descriptor.label,
            latest: descriptor.latestModel,
            stored: providerStoredModel(descriptor, this.plugin.settings),
            set: value => setProviderModel(descriptor, this.plugin.settings, value),
        };
    }

    /**
     * The model field for one provider: an editable input that knows what the
     * provider actually offers, filled by Find models. The suggestions come from
     * the provider itself (or, for a CLI, from the CLI or its small catalog), so
     * nobody has to keep a model id in their head — but anything they type is
     * still accepted, because the list is a convenience, not a gate.
     *
     * An empty field is not "no model": the provider's own newest model is used
     * until something else is typed, which is what makes a freshly pasted key
     * work. The description says which model that is.
     */
    private addModelSetting(container: HTMLElement, spec: ModelFieldSpec): void {
        const field = spec.id;
        const label = spec.label;
        const latest = spec.latest;
        const setting = new Setting(container)
            .setName('Model')
            .setDesc(spec.description ?? (latest
                ? `Newest from ${label}: ${latest}. Used while this is empty; Find models asks ${label} what the key can use.`
                : `Model id on ${label}. Find models asks it what the key can use.`))
            .addText(text => {
                text.setPlaceholder(latest || 'Type a model ID, or list what is available')
                    .setValue(spec.stored)
                    .onChange(async (value: string) => {
                        spec.set(value.trim());
                        await this.plugin.savePluginData();
                    });

                const suggest = new ModelSuggest(this.app, text.inputEl, this.modelsFor(field), model => {
                    spec.set(model.id);
                    void this.plugin.savePluginData();
                });
                this.modelSuggests.set(field, suggest);

                // The suggestion popover is the fast way to pick one; this line is
                // the honest way to see what matched, and it works everywhere the
                // field does — a model id is exactly the thing nobody can recall.
                text.inputEl.addEventListener('input', () => {
                    const query = text.inputEl.value;
                    const models = suggest.getModels();
                    if (models.length === 0) return;
                    const matches = searchModels(models, query, 6);
                    if (matches.length === 0) {
                        setStatusText(statusEl, `${models.length} known models, none matching "${query}".`, 'warn');
                        return;
                    }
                    const names = matches.map(model => model.id).join(', ');
                    setStatusText(
                        statusEl,
                        `${matches.length === 1 ? 'Match' : 'Matches'}: ${names}${models.length > matches.length ? ` — ${models.length} known, keep typing to narrow` : ''}`,
                        'ok',
                    );
                });
            })
            .addButton(button => button
                .setButtonText('List models')
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText('Asking…');
                    const result = await discoverModels(field, this.plugin.settings);
                    button.setDisabled(false);
                    button.setButtonText('Find models');
                    const suggest = this.modelSuggests.get(field);
                    if (result.models.length > 0) {
                        this.modelCache.set(field, result.models);
                        suggest?.setModels(result.models);
                        // The list leads with the newest chat model, so the first
                        // line of the status says which one that was.
                        const newest = result.models.find(model => model.latest);
                        const count = `${result.models.length} model${result.models.length === 1 ? '' : 's'}`;
                        setStatusText(
                            statusEl,
                            newest
                                ? `${count} found — newest: ${newest.id}. Start typing to pick one.`
                                : `${count} found — start typing to pick one.`,
                            'ok',
                        );
                        if (result.error) setStatusText(statusEl, result.error, 'warn');
                    } else {
                        setStatusText(statusEl, result.error ?? 'No models were listed. You can still type one.', 'warn');
                    }
                }));

        // The list's own line: what Find models found, if anything has been asked.
        const statusEl = setting.descEl.createDiv({ cls: 'sf-model-status' });
    }

    /**
     * The rows for one local CLI. The CLI *is* the provider row the reader chose,
     * so there is nothing to narrow down here: its name is the heading, its own
     * model field is the only choice left, and whether it is installed and signed
     * in is one line under a Detect button. A CLI brings its own login, and
     * Spaceforge never sees it.
     */
    private addCliConfiguration(container: HTMLElement, agentId: string): void {
        const agent = getCliAgent(agentId);
        if (!agent) {
            const unknown = container.createDiv({ cls: 'sf-info-box' });
            unknown.createEl('p', { text: `Unknown local CLI: ${agentId}. Pick another provider above.` });
            return;
        }
        const providerId = cliProviderId(agent.id);

        new Setting(container)
            .setName(`${agent.name} configuration`)
            .setHeading()
            .setClass("sf-settings-subsection-provider-header");

        this.addModelSetting(container, {
            id: providerId,
            label: agent.name,
            // A CLI resolves its own default; there is no "newest" to pin.
            latest: '',
            stored: cliModelFor(this.plugin.settings, agent.id),
            description: CLI_MODEL_DESCRIPTION,
            set: value => setCliModelFor(this.plugin.settings, agent.id, value),
        });

        // The matrix: what was found, on the left, and the answer on the right.
        // Checking runs as soon as the CLI is chosen — the choice is the question —
        // and the Detect button asks again.
        const detect = new Setting(container)
            .setName('Is it ready?')
            .setDesc('Install and sign in the CLI in a terminal first; this only reports what it finds.')
            .addButton(button => button
                .setButtonText('Detect')
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText('Checking…');
                    await refresh();
                    button.setDisabled(false);
                    button.setButtonText('Detect');
                }));
        const matrix = detect.descEl.createDiv({ cls: 'sf-detect-matrix' });
        const note = detect.descEl.createDiv({ cls: 'sf-model-status' });

        const refresh = async (): Promise<void> => {
            matrix.empty();
            note.empty();
            const result = await detectCliAgent(agent.id, {
                extra: this.plugin.settings.cliExtraPath,
            });
            const models = agent.listModels ? await this.modelsFromCli(agent.id) : agent.catalogModels;
            this.renderCliDetection(note, result);
            this.renderDetectionMatrix(matrix, [
                ['Binary', result.resolvedPath ?? `not found (\`${agent.bin}\`)`],
                ['Version', result.version ?? '—'],
                // Some CLIs answer a probe for this and some only reveal it on a
                // run, which is why "not signed in" comes with the command to fix it.
                ['Signed in', result.installed ? (result.authenticated ? 'Yes' : 'No') : '—'],
                ['Models', models.length
                    ? `${models.length} to choose from${agent.listModels ? ' (listed by the CLI)' : ' (its catalog)'}`
                    : '—'],
            ]);
        };

        const cached = this.providerStatusCache?.find(status => status.id === providerId);
        if (cached) setStatusText(note, cached.message, cached.level);
        else setStatusText(note, `Checking whether ${agent.name} is installed and signed in…`, 'warn');
        void refresh();

        // The escape hatch, for a CLI installed somewhere no search would think of.
        new Setting(container)
            .setName('Local CLI extra path')
            .setDesc('A folder to search for the CLI binaries before anywhere else, if yours is installed somewhere unusual. Separate several with a colon. The version-manager and npm locations are searched already, so this is only needed for an install of your own.')
            .addText(text => text
                .setPlaceholder('For example, ~/tools/bin')
                .setValue(this.plugin.settings.cliExtraPath)
                .onChange(async (value: string) => {
                    this.plugin.settings.cliExtraPath = value.trim();
                    setCliExtraPath(this.plugin.settings.cliExtraPath);
                    await this.plugin.savePluginData();
                    // A new place to look means the answer above may have changed.
                    void refresh();
                }));
    }

    /** What a CLI's own list command answers, for the matrix's model row. */
    private async modelsFromCli(agentId: string): Promise<CliModelEntry[]> {
        const id = cliProviderId(agentId);
        const cached = this.modelCache.get(id);
        if (cached) return cached;
        const result = await discoverModels(id, this.plugin.settings);
        this.modelCache.set(id, result.models);
        return result.models;
    }

    /**
     * The detection matrix: a label and what was found, one line each. It is the
     * shape a reader can check at a glance — binary, version, signed in, models —
     * instead of a paragraph they have to parse.
     */
    private renderDetectionMatrix(el: HTMLElement, rows: Array<[string, string]>): void {
        el.empty();
        for (const [label, value] of rows) {
            const row = el.createDiv({ cls: 'sf-detect-row' });
            row.createSpan({ cls: 'sf-detect-label', text: label });
            row.createSpan({ cls: 'sf-detect-value', text: value, title: value });
        }
    }

    private renderCliDetection(el: HTMLElement, result: CliDetectionResult): void {
        setStatusText(el, result.message, result.level);
        const id = cliProviderId(result.id);
        const statuses = this.providerStatusCache?.filter(status => status.id !== id) ?? [];
        this.providerStatusCache = [...statuses, {
            id,
            label: result.name,
            kind: 'cli',
            ready: result.installed && result.authenticated,
            configured: result.installed,
            level: result.level,
            message: result.message,
            credentialSource: result.authenticated ? 'cli' : null,
            models: this.modelCache.get(id) ?? [],
            detection: result,
        }];
    }

    /**
     * What a check found, in the space of one line: the providers that are ready,
     * by name, and how many are not. Every provider's own explanation stays where
     * it is needed — on the row of the one the reader has chosen — because a wall
     * of sentences for twenty-eight providers answers a question nobody asked.
     */
    private renderProviderStatus(el: HTMLElement, statuses: ProviderStatus[]): void {
        this.providerStatusCache = statuses;
        el.empty();
        if (statuses.length === 0) return;

        const ready = statuses.filter(status => status.ready);
        // Names only, and not a hundred of them: the ready list is a hint, the
        // chosen provider's row is where the detail lives.
        const shown = ready.slice(0, 8).map(status => status.label).join(', ');
        const rest = ready.length > 8 ? `, +${ready.length - 8} more` : '';
        el.createDiv({
            cls: 'sf-provider-status-summary',
            text: ready.length === 0
                ? `None of the ${statuses.length} providers is ready yet. Pick one above and its rows will say what it needs.`
                : `${ready.length} of ${statuses.length} ready now: ${shown}${rest}.`,
        });
    }

    /** What the model field should suggest for a provider, from what we have. */
    private modelsFor(providerId: ProviderId): DiscoveredModel[] {
        const cached = this.modelCache.get(providerId);
        if (cached) return cached;
        const agent = getCliAgent(agentIdOfProvider(providerId) ?? undefined);
        if (agent) {
            return agent.catalogModels.map(model => ({ id: model.id, label: model.label, source: 'catalog' as const }));
        }
        return [];
    }

    /**
     * Obsidian owns hotkeys, so the honest thing is to hand the learner to its
     * own settings screen, filtered to this plugin's commands, rather than keep
     * a second list of keys here that could disagree with it.
     */
    /** Discovered models per provider, and the live fields that suggest them. */
    private modelCache = new Map<string, DiscoveredModel[]>();
    private modelSuggests = new Map<string, ModelSuggest>();
    /** The last detection run, so the tab can show it without asking again. */
    private providerStatusCache: ProviderStatus[] | null = null;

    private openHotkeySettings(): void {
        const setting = (this.app as unknown as {
            setting?: {
                open(): void;
                openTabById(id: string): void;
                activeTab?: { searchComponent?: { inputEl?: HTMLInputElement } };
            };
        }).setting;
        if (!setting) {
            new Notice('Open the hotkey settings and search for Spaceforge.');
            return;
        }
        setting.open();
        setting.openTabById('hotkeys');
        const input = setting.activeTab?.searchComponent?.inputEl;
        if (input) {
            input.value = 'Spaceforge';
            input.dispatchEvent(new Event('input'));
        }
    }

}
