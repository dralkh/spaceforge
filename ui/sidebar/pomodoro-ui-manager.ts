import { Notice, setIcon } from "obsidian";
import SpaceforgePlugin from "../../main";
import { EstimationUtils } from "../../utils/estimation";

export class PomodoroUIManager {
    private plugin: SpaceforgePlugin;
    private attachedContainer: HTMLElement | null = null; // The container provided by ListViewRenderer

    // References to Pomodoro UI elements
    private pomodoroVisibilityToggleBtnContainer: HTMLElement | null = null;
    private pomodoroVisibilityToggleBtn: HTMLButtonElement | null = null;
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

    // private isPomodoroSectionOpen: boolean = false; // No longer needed, section is always "open"
    private areButtonsVisible: boolean = true; // For Play/Pause/Skip buttons
    private isTimerTextVisible: boolean = true; // For the timer countdown text
    private longPressTimer: number | null = null;
    private veryLongPressTimer: number | null = null;
    private readonly LONG_PRESS_DURATION = 500; // ms
    private readonly VERY_LONG_PRESS_DURATION = 1500; // ms
    private didLongPress: boolean = false;
    private didVeryLongPress: boolean = false;


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
            if(this.pomodoroQuickWorkInput) this.pomodoroQuickWorkInput.value = String(this.plugin.settings.pomodoroWorkDuration);
            if(this.pomodoroQuickShortInput) this.pomodoroQuickShortInput.value = String(this.plugin.settings.pomodoroShortBreakDuration);
            if(this.pomodoroQuickLongInput) this.pomodoroQuickLongInput.value = String(this.plugin.settings.pomodoroLongBreakDuration);
            if(this.pomodoroQuickSessionsInput) this.pomodoroQuickSessionsInput.value = String(this.plugin.settings.pomodoroSessionsUntilLongBreak);
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
            this.pomodoroRootEl.style.display = ''; 
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
            this.attachedContainer.style.display = show ? '' : 'none';
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
        this.pomodoroStopBtn.hide(); // Initial state, updatePomodoroUI will manage visibility

        // Timer Display
        if (!this.pomodoroTimerDisplayEl || this.pomodoroTimerDisplayEl.parentElement !== mainControlsRow) {
            this.pomodoroTimerDisplayEl?.remove();
            this.pomodoroTimerDisplayEl = mainControlsRow.createDiv("pomodoro-timer-display");
            this.pomodoroTimerDisplayEl.addClass("pomodoro-timer-fade");
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
                if (this.veryLongPressTimer) clearTimeout(this.veryLongPressTimer);
                if (this.longPressTimer) clearTimeout(this.longPressTimer);
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
                if (this.veryLongPressTimer) clearTimeout(this.veryLongPressTimer);
                if (this.longPressTimer) clearTimeout(this.longPressTimer);
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

        // Quick Settings Toggle Button - REMOVED
        // if (!this.pomodoroQuickSettingsToggleBtn || this.pomodoroQuickSettingsToggleBtn.parentElement !== mainControlsRow) {
        //     this.pomodoroQuickSettingsToggleBtn?.remove();
        //     this.pomodoroQuickSettingsToggleBtn = mainControlsRow.createDiv("pomodoro-quick-settings-toggle");
        //     setIcon(this.pomodoroQuickSettingsToggleBtn, "settings");
        //     this.pomodoroQuickSettingsToggleBtn.setAttribute("aria-label", "Pomodoro Settings");
        //     this.pomodoroQuickSettingsToggleBtn.addEventListener("click", () => {
        //         const panel = this.pomodoroQuickSettingsPanelEl;
        //         if (!panel) return;
        //         const isCurrentlyHidden = panel.style.display === 'none' || !panel.style.display;
        //         panel.style.display = isCurrentlyHidden ? 'flex' : 'none';

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
            this.pomodoroQuickSettingsPanelEl.style.display = 'none'; // Initial state

            // Recreate inputs and buttons if panel is new
            const createQuickSetting = (labelText: string, inputType: string = 'number'): HTMLInputElement => {
                const settingDiv = this.pomodoroQuickSettingsPanelEl!.createDiv("pomodoro-quick-setting");
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

            const calculateBtn = buttonsContainer.createEl("button", { text: "Calculate Reading Time", cls: "pomodoro-quick-calculate-btn" });
            calculateBtn.addEventListener("click", async () => {
                const settingsSaved = this._savePomodoroSettings();
                if (settingsSaved) {
                    await this.calculateAndDisplayPomodoroEstimate();
                }
            });

            this.pomodoroCalculationResultEl = this.pomodoroQuickSettingsPanelEl.createDiv({ cls: "pomodoro-calculation-result" });
            this.pomodoroCalculationResultEl.style.display = 'none';
        }
        
        this.updatePomodoroUI(); // Ensure UI reflects current state after potential recreation
    }

    /**
     * Calculates the estimated Pomodoro cycles for today's notes and displays it.
     */
    private async calculateAndDisplayPomodoroEstimate(): Promise<void> {
        if (!this.plugin || !this.pomodoroCalculationResultEl) return;

        // Use notes from the review controller, which are context-aware (selected date or actual today)
        const notesForEstimate = this.plugin.reviewController.getTodayNotes(); 
        
        if (notesForEstimate.length === 0) {
            const activeDate = this.plugin.reviewController.getCurrentReviewDateOverride();
            const message = activeDate 
                ? `No notes scheduled for ${new Date(activeDate).toLocaleDateString()} to calculate.`
                : "No notes currently due to calculate.";
            this.pomodoroCalculationResultEl.setText(message);
            this.pomodoroCalculationResultEl.style.display = 'block';
            return;
        }

        let totalReadingTimeInSeconds = 0;
        for (const note of notesForEstimate) {
            totalReadingTimeInSeconds += await this.plugin.reviewScheduleService.estimateReviewTime(note.path);
        }
        const totalReadingTimeInMinutes = totalReadingTimeInSeconds / 60;

        const settings = this.plugin.settings;
        const workDuration = settings.pomodoroWorkDuration;
        const shortBreakDuration = settings.pomodoroShortBreakDuration;
        const longBreakDuration = settings.pomodoroLongBreakDuration;
        const sessionsUntilLongBreak = settings.pomodoroSessionsUntilLongBreak;

        let pomodorosNeeded = 0;
        let sessionsCompletedInCycle = 0;
        let remainingReadingTimeMinutes = totalReadingTimeInMinutes;
        let totalBreakTimeInMinutes = 0;

        if (totalReadingTimeInMinutes === 0) {
             this.pomodoroCalculationResultEl.setText("Estimated reading time is 0 minutes.");
             this.pomodoroCalculationResultEl.style.display = 'block';
             return;
        }

        while (remainingReadingTimeMinutes > 0) {
            pomodorosNeeded++;
            remainingReadingTimeMinutes -= workDuration;
            sessionsCompletedInCycle++;

            if (remainingReadingTimeMinutes <= 0) break;

            if (sessionsCompletedInCycle >= sessionsUntilLongBreak) {
                totalBreakTimeInMinutes += longBreakDuration;
                sessionsCompletedInCycle = 0;
            } else {
                totalBreakTimeInMinutes += shortBreakDuration;
            }
        }

        const totalTimeWithBreaksMinutes = (pomodorosNeeded * workDuration) + totalBreakTimeInMinutes;

        const formattedTotalReadingTime = EstimationUtils.formatTime(totalReadingTimeInSeconds);
        const formattedTotalTimeWithBreaks = EstimationUtils.formatTime(Math.ceil(totalTimeWithBreaksMinutes * 60));

        this.pomodoroCalculationResultEl.empty();
        this.pomodoroCalculationResultEl.createEl("p", { text: `Estimated reading time for ${notesForEstimate.length} note(s) in current view: ${formattedTotalReadingTime}.` });
        this.pomodoroCalculationResultEl.createEl("p", { text: `Requires ~${pomodorosNeeded} Pomodoro work session(s).` });
        this.pomodoroCalculationResultEl.createEl("p", { text: `Total time with breaks: ~${formattedTotalTimeWithBreaks}.` });
        this.pomodoroCalculationResultEl.style.display = 'block';
    }

    /**
     * Updates the Pomodoro UI based on the current state from PomodoroService.
     */
    private toggleSettingsPanel(): void {
        const panel = this.pomodoroQuickSettingsPanelEl;
        if (!panel) return;
        const isCurrentlyHidden = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = isCurrentlyHidden ? 'flex' : 'none';

        if (isCurrentlyHidden) { // Populate inputs when opening
            if(this.pomodoroQuickWorkInput) this.pomodoroQuickWorkInput.value = String(this.plugin.settings.pomodoroWorkDuration);
            if(this.pomodoroQuickShortInput) this.pomodoroQuickShortInput.value = String(this.plugin.settings.pomodoroShortBreakDuration);
            if(this.pomodoroQuickLongInput) this.pomodoroQuickLongInput.value = String(this.plugin.settings.pomodoroLongBreakDuration);
            if(this.pomodoroQuickSessionsInput) this.pomodoroQuickSessionsInput.value = String(this.plugin.settings.pomodoroSessionsUntilLongBreak);
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
        const buttonsVisibility = this.areButtonsVisible ? '' : 'none';
        const isRunning = this.plugin.pluginState.pomodoroIsRunning;

        if (this.pomodoroStartBtn) this.pomodoroStartBtn.style.display = isRunning ? 'none' : buttonsVisibility;
        if (this.pomodoroStopBtn) this.pomodoroStopBtn.style.display = isRunning ? buttonsVisibility : 'none';
        if (this.pomodoroSkipBtn) this.pomodoroSkipBtn.style.display = buttonsVisibility;
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
        this.pomodoroRootEl.style.display = '';

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
        if (this.pomodoroCalculationResultEl && this.pomodoroQuickSettingsPanelEl?.style.display === 'none') {
            this.pomodoroCalculationResultEl.style.display = 'none';
        }
    }
}
