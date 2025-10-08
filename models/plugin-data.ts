import { SpaceforgeSettings, DEFAULT_SETTINGS } from './settings';
import { ReviewSchedule, ReviewHistoryItem } from './review-schedule';
import { ReviewSessionStore } from './review-session';
import { MCQSet, MCQSession } from './mcq';
import { CalendarEvent } from './calendar-event';

/**
 * Interface for the plugin's operational state (excluding settings).
 * This corresponds to the data previously managed by DataStorage.
 */
export interface PluginStateData {
    schedules: Record<string, ReviewSchedule>;
    history: ReviewHistoryItem[];
    reviewSessions: ReviewSessionStore;
    mcqSets: Record<string, MCQSet>;
    mcqSessions: Record<string, MCQSession[]>;
    customNoteOrder: string[];
    lastLinkAnalysisTimestamp?: number | null;
    version: string; // To track data structure version for migrations

    // Pomodoro Timer State
    pomodoroCurrentMode: 'work' | 'shortBreak' | 'longBreak' | 'idle';
    pomodoroTimeLeftInSeconds: number;
    pomodoroSessionsCompletedInCycle: number;
    pomodoroIsRunning: boolean;
    pomodoroEndTimeMs: number | null; // Timestamp when the current session ends
    
    // Pomodoro Estimation and Cycle Tracking
    pomodoroEstimatedTotalCycles: number | null; // Total cycles calculated from reading time
    pomodoroEstimatedWorkSessions: number | null; // Total work sessions calculated
    pomodoroIsEstimationActive: boolean; // Whether estimation is currently active (not overridden by user)
    pomodoroUserHasModifiedSettings: boolean; // Whether user has manually changed H/M settings
    
    // User Override Time Settings
    pomodoroUserOverrideHours: number; // User-specified hours for override
    pomodoroUserOverrideMinutes: number; // User-specified minutes for override
    pomodoroUserAddToEstimation: boolean; // Whether to add user time to estimation or replace it
    
    // Calendar Events
    calendarEvents: Record<string, CalendarEvent>;
}

/**
 * Default values for the plugin's operational state.
 */
export const DEFAULT_PLUGIN_STATE_DATA: PluginStateData = {
    schedules: {},
    history: [],
    reviewSessions: { sessions: {}, activeSessionId: null },
    mcqSets: {},
    mcqSessions: {},
    customNoteOrder: [],
    lastLinkAnalysisTimestamp: null,
    version: "0.0.0", // This will be updated from plugin.manifest.version on save

    // Pomodoro Timer State Defaults
    pomodoroCurrentMode: 'idle',
    pomodoroTimeLeftInSeconds: 25 * 60, // Default to work duration
    pomodoroSessionsCompletedInCycle: 0,
    pomodoroIsRunning: false,
    pomodoroEndTimeMs: null,
    
    // Pomodoro Estimation and Cycle Tracking Defaults
    pomodoroEstimatedTotalCycles: null,
    pomodoroEstimatedWorkSessions: null,
    pomodoroIsEstimationActive: false,
    pomodoroUserHasModifiedSettings: false,
    
    // User Override Time Settings Defaults
    pomodoroUserOverrideHours: 0,
    pomodoroUserOverrideMinutes: 0,
    pomodoroUserAddToEstimation: false,
    
    // Calendar Events Defaults
    calendarEvents: {},
};

/**
 * Unified data structure for everything persisted in data.json.
 * This includes both plugin settings and the plugin's operational state.
 */
export interface SpaceforgePluginData {
    settings: SpaceforgeSettings;
    pluginState: PluginStateData;
}

/**
 * Default values for the entire application data, including settings and state.
 * Used for new installations or when data.json is missing/corrupted.
 */
export const DEFAULT_APP_DATA: SpaceforgePluginData = {
    settings: DEFAULT_SETTINGS,
    pluginState: DEFAULT_PLUGIN_STATE_DATA,
};
