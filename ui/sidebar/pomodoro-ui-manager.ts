import { Notice, setIcon } from "obsidian";
import SpaceforgePlugin from "../../main";
import { EstimationUtils } from "../../utils/estimation";

export class PomodoroUIManager {
    private plugin: SpaceforgePlugin;
    private attachedContainer: HTMLElement | null = null; // The container provided by ListViewRenderer

    // References to Pomodoro UI elements
    // private pomodoroVisibilityToggleBtnContainer & Btn removed as unused
    public pomodoroRootEl: HTMLElement | null = null; // Container for the actual timer content
    private pomodoroTimerDisplayEl: HTMLElement | null = null;
    private pomodoroStartBtn: HTMLButtonElement | null = null;
    private pomodoroStopBtn: HTMLButtonElement | null = null;
    private pomodoroSkipBtn: HTMLButtonElement | null = null;
    private pomodoroQuickSettingsPanelEl: HTMLElement | null = null;
    // private pomodoroQuickSettingsToggleBtn: HTMLElement | null = null; // Removed
    private pomodoroQuickWorkInput: HTMLInputElement | null = null;
    private pomodoroQuickShortInput: HTMLInputElement | null = null;
    private pomodoroQuickLongInput: HTMLInputElement | null = null;
    private pomodoroQuickSessionsInput: HTMLInputElement | null = null;
    private pomodoroCalculationResultEl: HTMLElement | null = null;

    // New estimation and cycle tracking elements (moved to calculation panel)
    private pomodoroCycleProgressEl: HTMLElement | null = null;

    // User override input elements
    private pomodoroUserOverrideHoursInput: HTMLInputElement | null = null;
    private pomodoroUserOverrideMinutesInput: HTMLInputElement | null = null;
    private pomodoroUserAddToEstimationCheckbox: HTMLInputElement | null = null;

    // private isPomodoroSectionOpen: boolean = false; // No longer needed, section is always "open"
    private areButtonsVisible = true; // For Play/Pause/Skip buttons
    private isTimerTextVisible = true; // For the timer countdown text
    private longPressTimer: number | null = null;
    private veryLongPressTimer: number | null = null;
    private readonly LONG_PRESS_DURATION = 500; // ms
    private readonly VERY_LONG_PRESS_DURATION = 1500; // ms
    private didLongPress = false;
    private didVeryLongPress = false;


    /**
     * Saves the current values from the Pomodoro quick settings input fields.
     * @returns true if settings were valid and saved, false otherwise.
     */
    private _savePomodoroSettings(): boolean {
        const work = parseInt(this.pomodoroQuickWorkInput?.value || "0");
        const short = parseInt(this.pomodoroQuickShortInput?.value || "0");
        const long = parseInt(this.pomodoroQuickLongInput?.value || "0");
        const sessions = parseInt(this.pomodoroQuickSessionsInput?.value || "0");

        if (work > 0 && short > 0 && long > 0 && sessions > 0) {
            this.plugin.pomodoroService.updateDurations(work, short, long, sessions);
            // new Notice("Pomodoro durations updated."); // Removed notification
            return true;
        } else {
            new Notice("Invalid Pomodoro durations. Settings not saved. Please enter positive numbers.");
            // Re-populate with current valid settings to prevent saving invalid on next close if not corrected
            if (this.pomodoroQuickWorkInput) this.pomodoroQuickWorkInput.value = String(this.plugin.settings.pomodoroWorkDuration);
            if (this.pomodoroQuickShortInput) this.pomodoroQuickShortInput.value = String(this.plugin.settings.pomodoroShortBreakDuration);
            if (this.pomodoroQuickLongInput) this.pomodoroQuickLongInput.value = String(this.plugin.settings.pomodoroLongBreakDuration);
            if (this.pomodoroQuickSessionsInput) this.pomodoroQuickSessionsInput.value = String(this.plugin.settings.pomodoroSessionsUntilLongBreak);
            return false;
        }
    }

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
        // Elements will be created in attachAndRender
    }

    /**
     * Attaches the Pomodoro UI to a given container and renders its initial state.
     * Creates necessary sub-containers if they don't exist.
     * @param container The parent element where the Pomodoro UI should be placed.
     */
    public attachAndRender(container: HTMLElement): void {
        this.attachedContainer = container;

        // Ensure pomodoroRootEl exists and is parented correctly
        // The old pomodoroVisibilityToggleBtnContainer is now hidden by CSS and its logic removed.
        let rootElWasCreated = false;
        if (!this.pomodoroRootEl || this.pomodoroRootEl.parentElement !== this.attachedContainer) {
            this.pomodoroRootEl?.remove();
            this.pomodoroRootEl = this.attachedContainer.createDiv("pomodoro-section-content");
            rootElWasCreated = true;
        }

        // Pomodoro section is always "open" now, so pomodoroRootEl should always be visible.
        if (this.pomodoroRootEl) {
            this.pomodoroRootEl.classList.remove('sf-hidden');
            this.pomodoroRootEl.classList.add('sf-visible');
        }

        // If pomodoroRootEl was just created or its children are missing, render its internal timer structure
        if (rootElWasCreated || (this.pomodoroRootEl && this.pomodoroRootEl.children.length === 0)) {
            this.renderPomodoroTimer(this.pomodoroRootEl);
        }

        // Always update UI details as the section is considered always open
        this.updatePomodoroUI();
    }

    // getIsPomodoroSectionOpen, setIsPomodoroSectionOpen, setupPomodoroVisibilityToggleButton, updatePomodoroVisibility are no longer needed
    // as the section is always visible and the toggle button is removed.

    /** Controls the visibility of the entire attached Pomodoro UI section (e.g. for global plugin enable/disable) */
    public showPomodoroSection(show: boolean): void {
        if (this.attachedContainer) {
            if (show) {
                this.attachedContainer.classList.remove('sf-hidden');
                this.attachedContainer.classList.add('sf-visible');
            } else {
                this.attachedContainer.classList.remove('sf-visible');
                this.attachedContainer.classList.add('sf-hidden');
            }
            // If the section is hidden externally, we might want to ensure controls are visible when it's re-shown.
            // For now, we'll let areMainControlsVisible persist.
        }
    }


    /**
     * Renders or updates the Pomodoro Timer UI elements into pomodoroRootEl.
     * @param container The parent element to render into (this.pomodoroRootEl).
     */
    private renderPomodoroTimer(container: HTMLElement): void {
        // container.empty(); // REMOVED - We will find or create elements

        let mainControlsRow = container.querySelector(".pomodoro-main-controls") as HTMLElement;
        if (!mainControlsRow) {
            mainControlsRow = container.createDiv("pomodoro-main-controls");
        }

        // Start Button
        if (!this.pomodoroStartBtn || this.pomodoroStartBtn.parentElement !== mainControlsRow) {
            this.pomodoroStartBtn?.remove();
            this.pomodoroStartBtn = mainControlsRow.createEl("button", { cls: "pomodoro-start-btn" });
            setIcon(this.pomodoroStartBtn, "play");
            this.pomodoroStartBtn.addEventListener("click", () => this.plugin.pomodoroService.start());
        }

        // Stop Button
        if (!this.pomodoroStopBtn || this.pomodoroStopBtn.parentElement !== mainControlsRow) {
            this.pomodoroStopBtn?.remove();
            this.pomodoroStopBtn = mainControlsRow.createEl("button", { cls: "pomodoro-stop-btn" });
            setIcon(this.pomodoroStopBtn, "pause");
            this.pomodoroStopBtn.addEventListener("click", () => this.plugin.pomodoroService.stop());
        }
        // this.pomodoroStopBtn.hide(); // Initial state, updatePomodoroUI will manage visibility

        // Timer Display
        if (!this.pomodoroTimerDisplayEl || this.pomodoroTimerDisplayEl.parentElement !== mainControlsRow) {
            this.pomodoroTimerDisplayEl?.remove();
            this.pomodoroTimerDisplayEl = mainControlsRow.createDiv({ cls: "pomodoro-timer-display pomodoro-timer-fade" });
        }
        this.pomodoroTimerDisplayEl.setText(this.plugin.pomodoroService.getFormattedTimeLeft());
        // Add event listeners for long-press and click on timer display
        if (this.pomodoroTimerDisplayEl) {
            this.pomodoroTimerDisplayEl.addEventListener("mousedown", (e) => {
                // Prevent text selection during long press
                e.preventDefault();
                this.didLongPress = false;
                this.didVeryLongPress = false;

                this.longPressTimer = window.setTimeout(() => {
                    this.didLongPress = true; // Mark that the first threshold was met
                    // Action for long press (toggle buttons) will be decided on mouseup/touchend
                    // unless veryLongPressTimer also fires.
                }, this.LONG_PRESS_DURATION);

                this.veryLongPressTimer = window.setTimeout(() => {
                    this.didVeryLongPress = true;
                    this.isTimerTextVisible = !this.isTimerTextVisible; // Toggle timer text
                    // If timer text is now hidden, also hide buttons. If shown, show buttons.
                    this.areButtonsVisible = this.isTimerTextVisible;
                    this.updateTimerTextDisplay();
                    this.updateButtonVisibility();
                }, this.VERY_LONG_PRESS_DURATION);
            });

            const handlePressEnd = () => {
                if (this.veryLongPressTimer) window.clearTimeout(this.veryLongPressTimer);
                if (this.longPressTimer) window.clearTimeout(this.longPressTimer);
                this.veryLongPressTimer = null;
                this.longPressTimer = null;

                if (this.didVeryLongPress) {
                    // Action for very long press (timer text + buttons) already taken by its timeout.
                } else if (this.didLongPress) {
                    if (!this.isTimerTextVisible) { // If timer text was hidden
                        this.isTimerTextVisible = true; // Make text visible
                        this.areButtonsVisible = true;  // Make buttons visible
                    } else { // Timer text was already visible
                        this.areButtonsVisible = !this.areButtonsVisible; // Just toggle buttons
                    }
                    this.updateTimerTextDisplay();
                    this.updateButtonVisibility();
                } else { // Short click
                    if (this.isTimerTextVisible) { // Only toggle settings if timer text is visible
                        this.toggleSettingsPanel();
                    }
                }
                this.didLongPress = false;
                this.didVeryLongPress = false;
            };

            this.pomodoroTimerDisplayEl.addEventListener("mouseup", handlePressEnd);
            this.pomodoroTimerDisplayEl.addEventListener("touchend", handlePressEnd);

            const cancelPress = () => {
                if (this.veryLongPressTimer) window.clearTimeout(this.veryLongPressTimer);
                if (this.longPressTimer) window.clearTimeout(this.longPressTimer);
                this.veryLongPressTimer = null;
                this.longPressTimer = null;
                this.didLongPress = false;
                this.didVeryLongPress = false;
            };

            this.pomodoroTimerDisplayEl.addEventListener("mouseleave", cancelPress);
            this.pomodoroTimerDisplayEl.addEventListener("touchmove", cancelPress);

            // Touchstart needs to mirror mousedown logic for setting up timers
            this.pomodoroTimerDisplayEl.addEventListener("touchstart", (e) => {
                e.preventDefault();
                this.didLongPress = false;
                this.didVeryLongPress = false;

                this.longPressTimer = window.setTimeout(() => {
                    this.didLongPress = true;
                }, this.LONG_PRESS_DURATION);

                this.veryLongPressTimer = window.setTimeout(() => {
                    this.didVeryLongPress = true;
                    this.isTimerTextVisible = !this.isTimerTextVisible;
                    this.areButtonsVisible = this.isTimerTextVisible;
                    this.updateTimerTextDisplay();
                    this.updateButtonVisibility();
                }, this.VERY_LONG_PRESS_DURATION);
            }, { passive: false });
        }


        // Skip Button
        if (!this.pomodoroSkipBtn || this.pomodoroSkipBtn.parentElement !== mainControlsRow) {
            this.pomodoroSkipBtn?.remove();
            this.pomodoroSkipBtn = mainControlsRow.createEl("button", { cls: "pomodoro-skip-btn" });
            setIcon(this.pomodoroSkipBtn, "skip-forward");
            this.pomodoroSkipBtn.addEventListener("click", () => this.plugin.pomodoroService.skipSession());
        }

        // Cycle Progress Display (shows current cycle and remaining sessions)
        if (!this.pomodoroCycleProgressEl || this.pomodoroCycleProgressEl.parentElement !== container) {
            this.pomodoroCycleProgressEl?.remove();
            this.pomodoroCycleProgressEl = container.createDiv("pomodoro-cycle-progress");
        }

        // Quick Settings Toggle Button - REMOVED
        // if (!this.pomodoroQuickSettingsToggleBtn || this.pomodoroQuickSettingsToggleBtn.parentElement !== mainControlsRow) {
        //     this.pomodoroQuickSettingsToggleBtn?.remove();
        //     this.pomodoroQuickSettingsToggleBtn = mainControlsRow.createDiv("pomodoro-quick-settings-toggle");
        //     setIcon(this.pomodoroQuickSettingsToggleBtn, "settings");
        //     this.pomodoroQuickSettingsToggleBtn.setAttribute("aria-label", "Pomodoro Settings");
        //     this.pomodoroQuickSettingsToggleBtn.addEventListener("click", () => {
        //         const panel = this.pomodoroQuickSettingsPanelEl;
        //         if (!panel) return;
        //         const isCurrentlyHidden = panel.classList.contains('sf-hidden');
        //         if (isCurrentlyHidden) {
        //             panel.classList.remove('sf-hidden');
        //             panel.classList.add('sf-visible');
        //         } else {
        //             panel.classList.remove('sf-visible');
        //             panel.classList.add('sf-hidden');
        //         }

        //         if (isCurrentlyHidden) { // Populate inputs when opening
        //             if(this.pomodoroQuickWorkInput) this.pomodoroQuickWorkInput.value = String(this.plugin.settings.pomodoroWorkDuration);
        //             if(this.pomodoroQuickShortInput) this.pomodoroQuickShortInput.value = String(this.plugin.settings.pomodoroShortBreakDuration);
        //             if(this.pomodoroQuickLongInput) this.pomodoroQuickLongInput.value = String(this.plugin.settings.pomodoroLongBreakDuration);
        //             if(this.pomodoroQuickSessionsInput) this.pomodoroQuickSessionsInput.value = String(this.plugin.settings.pomodoroSessionsUntilLongBreak);
        //         }
        //     });
        // }

        // Quick Settings Panel
        // The panel is now created directly under the mainControlsRow for better layout control with dropdown
        let settingsPanelContainer = container.querySelector(".pomodoro-settings-panel-container") as HTMLElement;
        if (!settingsPanelContainer) {
            settingsPanelContainer = container.createDiv("pomodoro-settings-panel-container");
        }

        if (!this.pomodoroQuickSettingsPanelEl || this.pomodoroQuickSettingsPanelEl.parentElement !== settingsPanelContainer) {
            this.pomodoroQuickSettingsPanelEl?.remove();
            this.pomodoroQuickSettingsPanelEl = settingsPanelContainer.createDiv("pomodoro-quick-settings-panel");
            // this.pomodoroQuickSettingsPanelEl.classList.add('sf-hidden'); // Initial state

            // Recreate inputs and buttons if panel is new
            const panel = this.pomodoroQuickSettingsPanelEl;
            const createQuickSetting = (labelText: string, inputType = 'number'): HTMLInputElement => {
                const settingDiv = panel.createDiv("pomodoro-quick-setting");
                settingDiv.createEl("label", { text: labelText });
                const input = settingDiv.createEl("input", { type: inputType });
                input.setAttr("min", "1");
                return input;
            };

            this.pomodoroQuickWorkInput = createQuickSetting("Work (min):");
            this.pomodoroQuickShortInput = createQuickSetting("Short Break (min):");
            this.pomodoroQuickLongInput = createQuickSetting("Long Break (min):");
            this.pomodoroQuickSessionsInput = createQuickSetting("Sessions/Long Break:");

            const buttonsContainer = this.pomodoroQuickSettingsPanelEl.createDiv({ cls: "pomodoro-quick-settings-buttons" });

            // const saveBtn = buttonsContainer.createEl("button", { text: "Save", cls: "pomodoro-quick-save-btn" });
            // saveBtn.addEventListener("click", () => {
            //     const work = parseInt(this.pomodoroQuickWorkInput?.value || "0");
            //     const short = parseInt(this.pomodoroQuickShortInput?.value || "0");
            //     const long = parseInt(this.pomodoroQuickLongInput?.value || "0");
            //     const sessions = parseInt(this.pomodoroQuickSessionsInput?.value || "0");

            //     if (work > 0 && short > 0 && long > 0 && sessions > 0) {
            //         this.plugin.pomodoroService.updateDurations(work, short, long, sessions);
            //         this.pomodoroQuickSettingsPanelEl?.hide();
            //         new Notice("Pomodoro durations updated.");
            //     } else {
            //         new Notice("Please enter valid positive numbers for durations.");
            //     }
            // });

            // User override time inputs
            const overrideContainer = this.pomodoroQuickSettingsPanelEl.createDiv({ cls: "pomodoro-override-container" });
            overrideContainer.createEl("label", { text: "Override time (optional):", cls: "pomodoro-override-label" });

            const overrideInputsContainer = overrideContainer.createDiv("pomodoro-override-inputs");
            this.pomodoroUserOverrideHoursInput = overrideInputsContainer.createEl("input", { type: "number", cls: "pomodoro-override-hours" });
            this.pomodoroUserOverrideHoursInput.setAttr("min", "0");
            this.pomodoroUserOverrideHoursInput.setAttr("placeholder", "H");
            this.pomodoroUserOverrideHoursInput.value = String(this.plugin.pluginState.pomodoroUserOverrideHours);

            const hoursLabel = overrideInputsContainer.createSpan("pomodoro-override-label-small");
            hoursLabel.setText("h");

            this.pomodoroUserOverrideMinutesInput = overrideInputsContainer.createEl("input", { type: "number", cls: "pomodoro-override-minutes" });
            this.pomodoroUserOverrideMinutesInput.setAttr("min", "0");
            this.pomodoroUserOverrideMinutesInput.setAttr("placeholder", "M");
            this.pomodoroUserOverrideMinutesInput.value = String(this.plugin.pluginState.pomodoroUserOverrideMinutes);

            const minutesLabel = overrideInputsContainer.createSpan("pomodoro-override-label-small");
            minutesLabel.setText("m");

            // Add to estimation toggle
            const toggleContainer = overrideContainer.createDiv("pomodoro-override-toggle-container");
            this.pomodoroUserAddToEstimationCheckbox = toggleContainer.createEl("input", { type: "checkbox", cls: "pomodoro-add-to-estimation" });
            this.pomodoroUserAddToEstimationCheckbox.checked = this.plugin.pluginState.pomodoroUserAddToEstimation;

            const toggleLabel = toggleContainer.createEl("label", { text: "Add to estimated time", cls: "pomodoro-toggle-label" });
            toggleLabel.setAttribute("for", "pomodoro-add-to-estimation");

            const calculateBtn = buttonsContainer.createEl("button", { text: "Calculate reading time", cls: "pomodoro-quick-calculate-btn" });
            calculateBtn.addEventListener("click", () => {
                const settingsSaved = this._savePomodoroSettings();
                if (settingsSaved) {
                    void this.calculateAndDisplayPomodoroEstimate();
                }
            });

            this.pomodoroCalculationResultEl = this.pomodoroQuickSettingsPanelEl.createDiv({ cls: "pomodoro-calculation-result" });
            this.pomodoroCalculationResultEl.classList.add('sf-hidden');
        }

        this.updatePomodoroUI(); // Ensure UI reflects current state after potential recreation
    }

    /**
     * Calculates the estimated Pomodoro cycles for today's notes and displays it.
     */
    private async calculateAndDisplayPomodoroEstimate(): Promise<void> {
        if (!this.plugin || !this.pomodoroCalculationResultEl) return;

        // Save user override settings
        this.saveUserOverrideSettings();

        // Use notes from the review controller, which are context-aware (selected date or actual today)
        const notesForEstimate = this.plugin.reviewController.getTodayNotes();

        // Check if we have either notes or user override
        const userOverrideHours = this.plugin.pluginState.pomodoroUserOverrideHours || 0;
        const userOverrideMinutes = this.plugin.pluginState.pomodoroUserOverrideMinutes || 0;
        const userOverrideTimeInMinutes = (userOverrideHours * 60) + userOverrideMinutes;

        if (notesForEstimate.length === 0 && userOverrideTimeInMinutes === 0) {
            const activeDate = this.plugin.reviewController.getCurrentReviewDateOverride();
            const message = activeDate
                ? `No notes scheduled for ${new Date(activeDate).toLocaleDateString()} to calculate.`
                : "No notes currently due to calculate.";
            this.pomodoroCalculationResultEl.setText(message);
            this.pomodoroCalculationResultEl.classList.remove('sf-hidden');
            this.pomodoroCalculationResultEl.classList.add('sf-visible');
            return;
        }

        // Use the PomodoroService to calculate estimation (this also resets and updates cycle tracking)
        const result = await this.plugin.pomodoroService.calculateEstimationFromNotes(notesForEstimate);

        if (!result) {
            this.pomodoroCalculationResultEl.setText("Unable to calculate estimation.");
            this.pomodoroCalculationResultEl.removeClass('sf-hidden');
            return;
        }

        const { totalReadingTimeInSeconds, pomodorosNeeded, totalTimeWithBreaksMinutes } = result;

        // Get user override values for display (already declared above)
        const addToEstimation = this.plugin.pluginState.pomodoroUserAddToEstimation || false;

        const formattedTotalTimeWithBreaks = EstimationUtils.formatTime(Math.ceil(totalTimeWithBreaksMinutes * 60));

        this.pomodoroCalculationResultEl.empty();

        // Show base reading time if we have notes and it wasn't completely overridden
        if (notesForEstimate.length > 0 && totalReadingTimeInSeconds > 0 && (!userOverrideTimeInMinutes || addToEstimation)) {
            // Calculate base reading time without overrides for display
            let baseReadingTimeInSeconds = 0;
            for (const note of notesForEstimate) {
                baseReadingTimeInSeconds += await this.plugin.reviewScheduleService.estimateReviewTime(note.path);
            }
            const formattedBaseReadingTime = EstimationUtils.formatTime(baseReadingTimeInSeconds);
            this.pomodoroCalculationResultEl.createEl("p", { text: `Base reading time for ${notesForEstimate.length} note(s): ${formattedBaseReadingTime}.` });
        } else if (notesForEstimate.length === 0 && userOverrideTimeInMinutes > 0) {
            // Show message when using only override time
            this.pomodoroCalculationResultEl.createEl("p", { text: `Using override time only (no notes).` });
        }

        // Show user override information if applicable
        if (userOverrideTimeInMinutes > 0) {
            const overrideText = addToEstimation
                ? `Added ${userOverrideHours}h ${userOverrideMinutes}m override time.`
                : `Using ${userOverrideHours}h ${userOverrideMinutes}m override time (replacing estimate).`;
            this.pomodoroCalculationResultEl.createEl("p", { text: overrideText, cls: "pomodoro-override-info" });
        }

        this.pomodoroCalculationResultEl.createEl("p", { text: `Requires ~${pomodorosNeeded} Pomodoro work session(s).` });
        this.pomodoroCalculationResultEl.createEl("p", { text: `Total time with breaks: ~${formattedTotalTimeWithBreaks}.` });
        this.pomodoroCalculationResultEl.removeClass('sf-hidden');

        // Update the cycle progress display to show the new estimation
        this.updateCycleProgressDisplay();
    }

    /**
     * Saves user override settings to plugin state
     */
    private saveUserOverrideSettings(): void {
        const hours = parseInt(this.pomodoroUserOverrideHoursInput?.value || "0");
        const minutes = parseInt(this.pomodoroUserOverrideMinutesInput?.value || "0");
        const addToEstimation = this.pomodoroUserAddToEstimationCheckbox?.checked || false;

        this.plugin.pluginState.pomodoroUserOverrideHours = hours;
        this.plugin.pluginState.pomodoroUserOverrideMinutes = minutes;
        this.plugin.pluginState.pomodoroUserAddToEstimation = addToEstimation;

        void this.plugin.savePluginData();
    }

    /**
     * Updates the Pomodoro UI based on the current state from PomodoroService.
     */
    private toggleSettingsPanel(): void {
        const panel = this.pomodoroQuickSettingsPanelEl;
        if (!panel) return;
        const isCurrentlyOpen = panel.classList.contains('is-open');
        if (!isCurrentlyOpen) {
            panel.classList.add('is-open');
        } else {
            panel.classList.remove('is-open');
        }

        if (!isCurrentlyOpen) { // Populate inputs when opening
            if (this.pomodoroQuickWorkInput) this.pomodoroQuickWorkInput.value = String(this.plugin.settings.pomodoroWorkDuration);
            if (this.pomodoroQuickShortInput) this.pomodoroQuickShortInput.value = String(this.plugin.settings.pomodoroShortBreakDuration);
            if (this.pomodoroQuickLongInput) this.pomodoroQuickLongInput.value = String(this.plugin.settings.pomodoroLongBreakDuration);
            if (this.pomodoroQuickSessionsInput) this.pomodoroQuickSessionsInput.value = String(this.plugin.settings.pomodoroSessionsUntilLongBreak);
        } else {
            // Panel is being closed, so save the settings
            this._savePomodoroSettings();
        }
    }

    private updateTimerTextDisplay(): void {
        if (this.pomodoroTimerDisplayEl) {
            // This makes the text invisible but keeps the element in layout
            this.pomodoroTimerDisplayEl.style.opacity = this.isTimerTextVisible ? '1' : '0';
            // Or, to truly remove text content:
            // this.pomodoroTimerDisplayEl.setText(this.isTimerTextVisible ? this.plugin.pomodoroService.getFormattedTimeLeft() : '');
            // Using opacity is generally smoother and preserves layout/border.
        }
    }

    private updateButtonVisibility(): void {

        const isRunning = this.plugin.pluginState.pomodoroIsRunning;

        if (this.pomodoroStartBtn) this.pomodoroStartBtn.toggleClass('sf-hidden', isRunning);
        if (this.pomodoroStopBtn) this.pomodoroStopBtn.toggleClass('sf-hidden', !isRunning);
        if (this.pomodoroSkipBtn) this.pomodoroSkipBtn.toggleClass('sf-hidden', !this.areButtonsVisible);
    }


    /**
     * Updates the Pomodoro UI based on the current state from PomodoroService.
     */
    public updatePomodoroUI(): void {
        // Don't update if the UI hasn't been attached yet or pomodoroRootEl is not created
        if (!this.attachedContainer || !this.pomodoroRootEl) {
            return;
        }

        // Ensure the root container is visible (it should always be, managed by attachAndRender)
        this.pomodoroRootEl.removeClass('sf-hidden');

        const state = this.plugin.pluginState;
        const service = this.plugin.pomodoroService;

        if (this.pomodoroTimerDisplayEl) {
            this.pomodoroTimerDisplayEl.setText(service.getFormattedTimeLeft());
            this.pomodoroTimerDisplayEl.className = 'pomodoro-timer-display pomodoro-timer-fade'; // Reset classes
            if (state.pomodoroCurrentMode !== 'idle') {
                this.pomodoroTimerDisplayEl.addClass(`mode-${state.pomodoroCurrentMode}`);
            } else {
                this.pomodoroTimerDisplayEl.addClass('mode-idle');
            }
            if (state.pomodoroIsRunning) {
                this.pomodoroTimerDisplayEl.addClass('timer-visible');
            } else {
                this.pomodoroTimerDisplayEl.removeClass('timer-visible');
            }
        }

        // This function now primarily updates timer text, mode classes, and calls helper visibility functions.

        if (this.pomodoroTimerDisplayEl) {
            this.pomodoroTimerDisplayEl.setText(service.getFormattedTimeLeft()); // Always set text for screen readers / state
            this.updateTimerTextDisplay(); // Then apply visual visibility for the text

            this.pomodoroTimerDisplayEl.className = 'pomodoro-timer-display pomodoro-timer-fade'; // Reset classes
            if (state.pomodoroCurrentMode !== 'idle') {
                this.pomodoroTimerDisplayEl.addClass(`mode-${state.pomodoroCurrentMode}`);
            } else {
                this.pomodoroTimerDisplayEl.addClass('mode-idle');
            }
            // 'timer-visible' class might be redundant if opacity is used, but keep for now if it affects other styles.
            if (state.pomodoroIsRunning) {
                this.pomodoroTimerDisplayEl.addClass('timer-visible');
            } else {
                this.pomodoroTimerDisplayEl.removeClass('timer-visible');
            }
        }

        this.updateButtonVisibility(); // Update button visibility based on their state

        // Update classes on the root element itself for styling paused/idle states
        this.pomodoroRootEl.toggleClass('is-running', state.pomodoroIsRunning);
        this.pomodoroRootEl.toggleClass('is-paused', !state.pomodoroIsRunning && state.pomodoroCurrentMode !== 'idle');
        this.pomodoroRootEl.toggleClass('is-idle', state.pomodoroCurrentMode === 'idle');

        // Hide calculation result if quick settings panel is closed
        if (this.pomodoroCalculationResultEl && this.pomodoroQuickSettingsPanelEl && !this.pomodoroQuickSettingsPanelEl.classList.contains('is-open')) {
            this.pomodoroCalculationResultEl.addClass('sf-hidden');
        }

        // Update cycle progress display
        this.updateCycleProgressDisplay();
    }



    /**
     * Updates the cycle progress display based on current state
     */
    private updateCycleProgressDisplay(): void {
        if (!this.pomodoroCycleProgressEl) return;

        const cycleProgress = this.plugin.pomodoroService.getCycleProgress();

        if (cycleProgress) {
            const { current, total, workSessionsRemaining, totalWorkSessions, totalTimeMinutes } = cycleProgress;

            // Calculate completed sessions
            const completedSessions = totalWorkSessions - workSessionsRemaining;

            // Format total time
            const totalHours = Math.floor(totalTimeMinutes / 60);
            const totalMinutes = Math.round(totalTimeMinutes % 60);
            const timeString = totalHours > 0 ? `${totalHours}H/${totalMinutes}M` : `${totalMinutes}M`;

            this.pomodoroCycleProgressEl.setText(`Cycles ${current}/${total} - Sessions ${completedSessions}/${totalWorkSessions} - ${timeString}`);
            this.pomodoroCycleProgressEl.removeClass('sf-hidden');
            this.pomodoroCycleProgressEl.addClass('cycle-active');
        } else {
            this.pomodoroCycleProgressEl.addClass('sf-hidden');
        }
    }

    /**
     * Format time in seconds to a readable string
     */
    private formatTime(totalSeconds: number): string {
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }

    /**
     * Calculate and display estimation for current notes
     */
    public async calculateAndDisplayEstimation(): Promise<void> {
        const notesForEstimate = this.plugin.reviewController.getTodayNotes();
        await this.plugin.pomodoroService.calculateEstimationFromNotes(notesForEstimate);
    }
}