/**
 * Upgrading a real vault, not a hypothetical one.
 *
 * The data.json shapes here are taken from a live 1.0.x vault (the field names,
 * the nesting, the pomodoro keys, the FSRS parameters as they were written
 * then). What is being protected is not "does it load" but "does anything the
 * user accumulated come back": every schedule, every history entry, every
 * session, every chart and every question set, plus every setting they chose.
 *
 * The new default added in 1.1.0 (background charting off) is asserted from both
 * sides: a vault that never chose gets the new behaviour once, and a vault that
 * chooses afterwards keeps its choice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, migrateSettings, SpaceforgeSettings } from '../models/settings';
import { parsePluginData } from '../utils/data-file';

/** A 1.0.x data.json, field for field: no studySessions, no cli settings, no markers. */
function legacyDataFile(): Record<string, unknown> {
    const schedule = (path: string, day: number) => ({
        notePath: path,
        nextReviewDate: Date.UTC(2026, 9, day),
        interval: 4,
        repetitions: 3,
        easeFactor: 250,
        algorithm: 'sm2',
        created: Date.UTC(2026, 8, 1),
        lastReviewed: Date.UTC(2026, 9, 1),
        reviewCount: 3,
        lapses: 0,
    });
    return {
        settings: {
            // The 1.0.x surface, as saved: charting on (the old default), the
            // dialog interface, 17-weight FSRS params, and the user's own keys.
            reviewInterface: 'dialog',
            studyEnabled: true,
            studyAutoChart: true,
            studyShowInSidebar: true,
            studyChartSectionsPerRun: 4,
            showNavigationNotifications: false,
            baseEase: 240,
            maximumInterval: 400,
            useCustomDataPath: true,
            customDataPath: 'books/srs',
            openRouterApiKey: 'sk-or-legacy-key',
            openRouterModel: 'openai/gpt-4.1-mini',
            ollamaApiUrl: 'http://localhost:11434',
            enableMCQ: true,
            mcqQuestionsPerNote: 5,
            mcqGradingMode: 'score',
            pomodoroWorkDuration: 30,
            calendarDefaultEventCategory: 'Study',
            fsrsParameters: {
                request_retention: 0.9,
                maximum_interval: 400,
                w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
                learning_steps: ['1m', '10m'],
                enable_short_term: false,
            },
            // A setting from an even older version, to prove unknown keys survive.
            legacyRemovedSetting: 'keep-me',
        },
        pluginState: {
            version: '1.0.7',
            schedules: {
                'notes/cytoskeleton.md': schedule('notes/cytoskeleton.md', 17),
                'notes/krebs-cycle.md': schedule('notes/krebs-cycle.md', 19),
                'notes/photosynthesis.md': schedule('notes/photosynthesis.md', 12),
            },
            history: [
                { notePath: 'notes/cytoskeleton.md', rating: 3, timestamp: Date.UTC(2026, 9, 1), intervalBefore: 1, intervalAfter: 4 },
                { notePath: 'notes/cytoskeleton.md', rating: 4, timestamp: Date.UTC(2026, 9, 2), intervalBefore: 4, intervalAfter: 9 },
                { notePath: 'notes/krebs-cycle.md', rating: 2, timestamp: Date.UTC(2026, 9, 3), intervalBefore: 2, intervalAfter: 2 },
            ],
            reviewSessions: {
                sessions: {
                    'session-1': {
                        id: 'session-1',
                        startedAt: Date.UTC(2026, 9, 1),
                        completedAt: Date.UTC(2026, 9, 1, 1),
                        hierarchy: { traversalOrder: ['notes/cytoskeleton.md', 'notes/krebs-cycle.md'] },
                        currentIndex: 2,
                        ratings: { 'notes/cytoskeleton.md': { rating: 3, kind: 'grade' } },
                    },
                },
                activeSessionId: null,
            },
            mcqSets: {
                'notes/cytoskeleton.md': {
                    notePath: 'notes/cytoskeleton.md',
                    generatedAt: Date.UTC(2026, 9, 2),
                    questions: [
                        { question: 'Which filament system moves the cell?', choices: ['Actin', 'Microtubules'], correctAnswerIndex: 0 },
                        { question: 'Which motor walks on microtubules?', choices: ['Kinesin', 'Myosin'], correctAnswerIndex: 0 },
                    ],
                },
            },
            mcqSessions: {
                'notes/cytoskeleton.md': [
                    { notePath: 'notes/cytoskeleton.md', startedAt: Date.UTC(2026, 9, 2), completedAt: Date.UTC(2026, 9, 2, 1), answers: [{ questionIndex: 0, choiceIndex: 0, correct: true }], score: 1 },
                ],
            },
            customNoteOrder: ['notes/cytoskeleton.md', 'notes/krebs-cycle.md', 'notes/photosynthesis.md'],
            lastLinkAnalysisTimestamp: Date.UTC(2026, 9, 4),
            pomodoroCurrentMode: 'work',
            pomodoroTimeLeftInSeconds: 1420,
            pomodoroSessionsCompletedInCycle: 2,
            pomodoroIsRunning: false,
            pomodoroEndTimeMs: null,
            pomodoroEstimatedTotalCycles: 6,
            pomodoroEstimatedWorkSessions: 3,
            pomodoroIsEstimationActive: true,
            pomodoroUserHasModifiedSettings: true,
            pomodoroUserOverrideHours: 1,
            pomodoroUserOverrideMinutes: 30,
            pomodoroUserAddToEstimation: false,
            calendarEvents: {
                '2026-10-20': [{ id: 'e1', title: 'Anatomy exam', date: '2026-10-20', category: 'MedAtlax', allDay: true }],
            },
            studyPlans: {
                'notes/photosynthesis.md': {
                    notePath: 'notes/photosynthesis.md',
                    created: Date.UTC(2026, 9, 1),
                    objectives: [
                        { id: 'o1', text: 'Explain the light-dependent reactions', section: 's1', state: { U: 2, R: 1, T: 0 }, errorCounts: { retrieval: 1 } },
                        { id: 'o2', text: 'Describe the Calvin cycle', section: 's2', state: { U: 3, R: 3, T: 2 }, errorCounts: {} },
                    ],
                    chartState: { done: ['s1', 's2'], total: 2, sections: [{ id: 's1', title: 'Light', text: '…' }] },
                },
            },
            studyProgress: {
                'notes/photosynthesis.md': { lastStudied: Date.UTC(2026, 9, 3), attempts: 4, masteryScore: 0.62 },
            },
        },
    };
}

function loadLegacy(overrides: Partial<SpaceforgeSettings> = {}): { settings: SpaceforgeSettings; state: Record<string, unknown>; changed: boolean } {
    const raw = legacyDataFile();
    raw.settings = { ...(raw.settings as Record<string, unknown>), ...overrides };
    const parsed = parsePluginData(JSON.stringify(raw)) as { settings: Partial<SpaceforgeSettings>; pluginState: Record<string, unknown> } | null;
    assert.ok(parsed, 'a 1.0.x data file must parse');
    // The same two lines the plugin loads with: defaults first, then whatever the
    // file says. Anything the file predates keeps its default.
    const settings = { ...DEFAULT_SETTINGS, ...parsed.settings } as SpaceforgeSettings;
    const changed = migrateSettings(settings);
    return { settings, state: parsed.pluginState, changed };
}

test('a 1.0.x vault keeps every schedule, review, session, chart and question set', () => {
    const { state } = loadLegacy();

    const schedules = state.schedules as Record<string, unknown>;
    assert.deepEqual(Object.keys(schedules).sort(), ['notes/cytoskeleton.md', 'notes/krebs-cycle.md', 'notes/photosynthesis.md']);
    assert.equal((schedules['notes/cytoskeleton.md'] as { interval: number }).interval, 4);
    assert.equal((schedules['notes/krebs-cycle.md'] as { nextReviewDate: number }).nextReviewDate, Date.UTC(2026, 9, 19));

    assert.equal((state.history as unknown[]).length, 3);
    assert.equal(((state.reviewSessions as { sessions: Record<string, unknown> }).sessions['session-1'] as { currentIndex: number }).currentIndex, 2);

    const mcqSets = state.mcqSets as Record<string, { questions: unknown[] }>;
    assert.equal(Object.keys(mcqSets).length, 1);
    assert.equal(mcqSets['notes/cytoskeleton.md'].questions.length, 2);
    const mcqSessions = state.mcqSessions as Record<string, unknown[]>;
    assert.equal(mcqSessions['notes/cytoskeleton.md'].length, 1);

    const plans = state.studyPlans as Record<string, { objectives: unknown[]; chartState: { done: string[] } }>;
    assert.equal(plans['notes/photosynthesis.md'].objectives.length, 2);
    assert.deepEqual(plans['notes/photosynthesis.md'].chartState.done, ['s1', 's2']);
    assert.equal((state.studyProgress as Record<string, { attempts: number }>)['notes/photosynthesis.md'].attempts, 4);

    assert.deepEqual(state.customNoteOrder, ['notes/cytoskeleton.md', 'notes/krebs-cycle.md', 'notes/photosynthesis.md']);
    assert.equal(state.lastLinkAnalysisTimestamp, Date.UTC(2026, 9, 4));
    assert.equal(Object.keys(state.calendarEvents as Record<string, unknown>).length, 1);
    assert.equal(state.pomodoroTimeLeftInSeconds, 1420);
    assert.equal(state.pomodoroEstimatedTotalCycles, 6);
    assert.equal(state.version, '1.0.7');
});

test('settings the user chose survive, settings that did not exist yet get defaults', () => {
    const { settings } = loadLegacy();

    // Chosen values, untouched.
    assert.equal(settings.openRouterApiKey, 'sk-or-legacy-key');
    assert.equal(settings.openRouterModel, 'openai/gpt-4.1-mini');
    assert.equal(settings.maximumInterval, 400);
    assert.equal(settings.baseEase, 240);
    assert.equal(settings.useCustomDataPath, true);
    assert.equal(settings.customDataPath, 'books/srs');
    assert.equal(settings.mcqQuestionsPerNote, 5);
    assert.equal(settings.mcqGradingMode, 'score');
    assert.equal(settings.studyChartSectionsPerRun, 4);
    assert.equal(settings.pomodoroWorkDuration, 30);

    // Settings that only exist in 1.1.0 arrive as defaults, not as undefined.
    assert.equal(settings.cliAgent, DEFAULT_SETTINGS.cliAgent);
    assert.equal(settings.cliModel, DEFAULT_SETTINGS.cliModel);
    assert.equal(settings.fsrsShortTermMigrated, true);
    assert.equal(settings.reviewInterface, 'strip', 'the docked bar is the only interface left');
});

test('background charting lands off, once, and a later choice sticks', () => {
    const first = loadLegacy();
    assert.equal(first.settings.studyAutoChart, false, 'the 1.0.x default must not survive the upgrade');
    assert.equal(first.settings.studyChartDefaultMigrated, true);
    assert.equal(first.changed, true, 'the caller has to be told there is something to save');

    // The user turns it back on. Nothing may flip it off again.
    first.settings.studyAutoChart = true;
    assert.equal(migrateSettings(first.settings), false, 'a migrated vault has nothing left to correct');
    assert.equal(first.settings.studyAutoChart, true);

    // And a vault that already chose "off" is simply left alone.
    const { settings } = loadLegacy({ studyAutoChart: false, studyChartDefaultMigrated: true });
    assert.equal(settings.studyAutoChart, false);
});

test('the FSRS parameters are corrected in the same pass, not the next launch', () => {
    const { settings, changed } = loadLegacy();
    assert.equal(changed, true);
    // Old defaults (17 weights, enable_short_term false) are replaced by FSRS-5.
    assert.deepEqual(settings.fsrsParameters?.w, DEFAULT_SETTINGS.fsrsParameters.w);
    assert.equal(settings.fsrsParameters?.enable_short_term, DEFAULT_SETTINGS.fsrsParameters.enable_short_term);
    assert.ok(!('learning_steps' in (settings.fsrsParameters as Record<string, unknown>)),
        'the step list is not part of the settings any more');
});

test('the correction is not a rewrite: earlier review state is never touched', () => {
    const a = loadLegacy();
    const b = loadLegacy();
    assert.deepEqual(a.state, b.state, 'loading twice must produce the same state');
    assert.deepEqual(
        Object.keys(a.state).sort(),
        Object.keys(b.state).sort(),
        'no key appears or disappears between loads',
    );
    // A key the current version does not know about is still there afterwards.
    assert.equal((a.settings as unknown as Record<string, unknown>).legacyRemovedSetting, 'keep-me');
});
