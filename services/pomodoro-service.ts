import SpaceforgePlugin from "../main";
import { PluginStateData } from "../models/plugin-data";
import { SpaceforgeSettings } from "../models/settings";

export type PomodoroMode = 'work' | 'shortBreak' | 'longBreak' | 'idle';

export class PomodoroService {
    private plugin: SpaceforgePlugin;
    private timerInterval: number | null = null;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
        // Initialize state from plugin.pluginState if needed, or rely on defaults
        if (this.plugin.settings.pomodoroEnabled && this.plugin.pluginState.pomodoroIsRunning) {
            // If resuming from a saved state where timer was running, recalculate timeLeft
            this.recalculateTimeLeftFromEndTime();
            this.startTimerInterval(); // Resume timer interval
        }
    }

    private get settings(): SpaceforgeSettings {
        return this.plugin.settings;
    }

    private get state(): PluginStateData {
        return this.plugin.pluginState;
    }

    // --- Public API ---

    public start(): void {
        if (this.state.pomodoroIsRunning) return;

        this.state.pomodoroIsRunning = true;
        if (this.state.pomodoroCurrentMode === 'idle') {
            this.switchToMode('work');
        } else if (this.state.pomodoroTimeLeftInSeconds <= 0) {
            // If timer ended and user clicks start, transition to next appropriate mode
            this.handleTimerEnd();
        }
        // Calculate end time based on current timeLeft
        this.state.pomodoroEndTimeMs = Date.now() + this.state.pomodoroTimeLeftInSeconds * 1000;
        this.startTimerInterval();
        this.notifyUpdate();
        this.plugin.savePluginData();
    }

    public stop(): void { // Pause functionality
        if (!this.state.pomodoroIsRunning) return;

        this.stopTimerInterval(); // Stop the interval first
        this.state.pomodoroIsRunning = false;

        // Calculate and store remaining time based on end time
        if (this.state.pomodoroEndTimeMs) {
            const remainingMs = this.state.pomodoroEndTimeMs - Date.now();
            this.state.pomodoroTimeLeftInSeconds = Math.max(0, Math.round(remainingMs / 1000));
        }
        // Clear the end time as it's no longer actively counting down
        this.state.pomodoroEndTimeMs = null;

        this.notifyUpdate();
        this.plugin.savePluginData();
    }

    public resetCurrentSession(): void {
        this.stopTimerInterval();
        this.state.pomodoroIsRunning = false;
        this.state.pomodoroEndTimeMs = null; // Clear end time on reset
        this.resetTimeForMode(this.state.pomodoroCurrentMode === 'idle' ? 'work' : this.state.pomodoroCurrentMode);
        this.notifyUpdate();
        this.plugin.savePluginData();
    }
    
    public skipSession(): void {
        this.stopTimerInterval();
        this.state.pomodoroIsRunning = false; // Stop current timer before switching
        this.handleTimerEnd(true); // true to indicate a skip
        // handleTimerEnd will call start if it transitions to a new timed session
        // If it transitions to idle, it remains stopped.
        // If it transitions and starts, pomodoroIsRunning will be true.
        // We need to ensure the interval is started if it's running.
        if (this.state.pomodoroIsRunning) {
            this.startTimerInterval();
        }
        this.notifyUpdate(); // handleTimerEnd also notifies, but an extra one here is fine
        this.plugin.savePluginData();
    }

    public getFormattedTimeLeft(): string {
        const minutes = Math.floor(this.state.pomodoroTimeLeftInSeconds / 60);
        const seconds = this.state.pomodoroTimeLeftInSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    public updateDurations(work: number, short: number, long: number, sessions: number): void {
        this.settings.pomodoroWorkDuration = work;
        this.settings.pomodoroShortBreakDuration = short;
        this.settings.pomodoroLongBreakDuration = long;
        this.settings.pomodoroSessionsUntilLongBreak = sessions;
        
        // If current session is not running and its mode (which is an active timed mode) had its duration changed, update its timeLeft
        const activeModesForDurationUpdate: PomodoroMode[] = ['work', 'shortBreak', 'longBreak'];
        if (!this.state.pomodoroIsRunning && activeModesForDurationUpdate.includes(this.state.pomodoroCurrentMode)) {
             this.resetTimeForMode(this.state.pomodoroCurrentMode);
        }
        this.plugin.savePluginData(); // Save settings and potentially updated state
        this.notifyUpdate();
    }


    // --- Internal Logic ---

    private startTimerInterval(): void {
        if (this.timerInterval !== null) {
            window.clearInterval(this.timerInterval);
        }
        if (!this.settings.pomodoroEnabled || !this.state.pomodoroIsRunning) return;

        this.timerInterval = window.setInterval(() => {
            this.tick();
        }, 1000);
    }

    private stopTimerInterval(): void {
        if (this.timerInterval !== null) {
            window.clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    private tick(): void {
        if (!this.state.pomodoroIsRunning || !this.state.pomodoroEndTimeMs) {
            // Should not happen if running, but safety check
            this.stop(); // Stop if state is inconsistent
            return;
        }

        const now = Date.now();
        const remainingMs = this.state.pomodoroEndTimeMs - now;
        const remainingSeconds = Math.max(0, Math.round(remainingMs / 1000));

        this.state.pomodoroTimeLeftInSeconds = remainingSeconds;

        if (remainingSeconds <= 0) {
            this.handleTimerEnd();
            // handleTimerEnd will notifyUpdate and savePluginData
        } else {
            this.notifyUpdate();
            // No need to savePluginData on every tick
        }
    }

    private handleTimerEnd(skipped: boolean = false): void {
        this.stopTimerInterval(); // Stop the current interval
        // pomodoroIsRunning might still be true if we auto-transition to a new session

        if (this.settings.pomodoroSoundEnabled && !skipped) {
            this.playSoundNotification();
        }

        const currentMode = this.state.pomodoroCurrentMode;
        let nextMode: PomodoroMode = 'idle';

        if (currentMode === 'work') {
            this.state.pomodoroSessionsCompletedInCycle++;
            if (this.state.pomodoroSessionsCompletedInCycle >= this.settings.pomodoroSessionsUntilLongBreak) {
                nextMode = 'longBreak';
            } else {
                nextMode = 'shortBreak';
            }
        } else if (currentMode === 'shortBreak' || currentMode === 'longBreak') {
            nextMode = 'work';
            if (currentMode === 'longBreak') {
                this.state.pomodoroSessionsCompletedInCycle = 0; // Reset for new cycle
            }
        } // If currentMode was 'idle' or another unhandled state, nextMode remains 'idle' as initialized.
        
        const wasRunning = this.state.pomodoroIsRunning; // Capture state before potentially changing it
        this.switchToMode(nextMode); // This resets timeLeft based on the new mode

        if (nextMode !== 'idle') {
            this.state.pomodoroIsRunning = true; // Auto-start next session
            // Calculate new end time based on the duration of the *new* mode
            this.state.pomodoroEndTimeMs = Date.now() + this.state.pomodoroTimeLeftInSeconds * 1000;
            if (!wasRunning) { // Only start interval if it wasn't already running (e.g., transitioning from idle)
                 this.startTimerInterval();
            } else if (!this.timerInterval) { // Or if interval somehow stopped but should be running
                 this.startTimerInterval();
            }
        } else {
            this.state.pomodoroIsRunning = false;
            this.state.pomodoroEndTimeMs = null; // No end time when idle
            this.stopTimerInterval(); // Ensure interval is stopped when idle
        }
        
        this.plugin.savePluginData(); // Save state changes
        this.notifyUpdate();
    }

    private switchToMode(mode: PomodoroMode): void {
        this.state.pomodoroCurrentMode = mode;
        this.resetTimeForMode(mode);
    }

    private resetTimeForMode(mode: PomodoroMode): void {
        switch (mode) {
            case 'work':
                this.state.pomodoroTimeLeftInSeconds = this.settings.pomodoroWorkDuration * 60;
                break;
            case 'shortBreak':
                this.state.pomodoroTimeLeftInSeconds = this.settings.pomodoroShortBreakDuration * 60;
                break;
            case 'longBreak':
                this.state.pomodoroTimeLeftInSeconds = this.settings.pomodoroLongBreakDuration * 60;
                break;
            case 'idle':
                this.state.pomodoroTimeLeftInSeconds = this.settings.pomodoroWorkDuration * 60; // Default to work duration when idle
                break;
        }
    }

    private playSoundNotification(): void {
        // Simple beep sound using AudioContext
        try {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            if (!audioContext) return;
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.type = 'sine'; // sine, square, sawtooth, triangle
            oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4 note
            gainNode.gain.setValueAtTime(0.1, audioContext.currentTime); // Volume

            oscillator.start();
            oscillator.stop(audioContext.currentTime + 0.5); // Play for 0.5 seconds
        } catch (e) { /* handle error */ }
    }

    private notifyUpdate(): void {
        this.plugin.events.emit('pomodoro-update');
    }

    // Call this when global settings change from the settings tab
    public onSettingsChanged(): void {
        if (!this.settings.pomodoroEnabled) {
            this.stop();
            this.state.pomodoroCurrentMode = 'idle';
            this.resetTimeForMode('idle'); // Reset to default work time but keep idle
        } else {
            // If timer is not running, and current mode is an active timed mode
            if (!this.state.pomodoroIsRunning) {
                const currentMode = this.state.pomodoroCurrentMode;
                const activeModes: PomodoroMode[] = ['work', 'shortBreak', 'longBreak'];
                if (activeModes.includes(currentMode)) {
                    this.resetTimeForMode(currentMode);
                }
            }
        }
        this.notifyUpdate();
    }

    public destroy(): void {
        this.stopTimerInterval();
    }

    // Recalculate time left based on stored end time, useful on load/reinit
    private recalculateTimeLeftFromEndTime(): void {
        if (this.state.pomodoroIsRunning && this.state.pomodoroEndTimeMs) {
            const now = Date.now();
            const remainingMs = this.state.pomodoroEndTimeMs - now;
            this.state.pomodoroTimeLeftInSeconds = Math.max(0, Math.round(remainingMs / 1000));

            if (remainingMs <= 0) {
                // Timer should have ended while plugin was inactive/closed
                // We could try to simulate the transition, but it gets complex.
                // Simplest: Stop the timer, reset to the expected next state's duration.
                this.handleTimerEnd(true); // Treat as skipped to avoid sound, force transition logic
            }
        } else if (!this.state.pomodoroIsRunning) {
             // If not running, ensure end time is null
             this.state.pomodoroEndTimeMs = null;
        }
        // If running but no end time (shouldn't happen), maybe log error or reset?
        // For now, assume state is consistent or gets corrected by start/stop.
    }

    // Call this after pluginState has been externally modified (e.g., by data import)
    public reinitializeTimerFromState(): void {
        this.stopTimerInterval(); // Stop any existing timer first

        if (this.settings.pomodoroEnabled) {
            // Recalculate time left based on potentially loaded end time
            this.recalculateTimeLeftFromEndTime();

            // Start interval only if it should be running *after* recalculation
            if (this.state.pomodoroIsRunning) {
                this.startTimerInterval();
            }
        } else {
            // If Pomodoro is disabled, ensure it's stopped and idle
            this.stop();
            this.state.pomodoroCurrentMode = 'idle';
            this.resetTimeForMode('idle');
            this.state.pomodoroEndTimeMs = null;
        }

        this.notifyUpdate(); // Ensure UI reflects the potentially new state
    }
}
