/**
 * The tutor loop through the real `StudySessionService`, with the transport
 * scripted.
 *
 * The live NanoGPT test exercises the model; this one pins the engine around
 * it: a correct answer reaches the rubric, the progress/feedback events fire,
 * and a wrap-up closes the session with a saved record. The chat client is the
 * shipping one — only Obsidian's `requestUrl` is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { StudyPlanService } from '../services/study-plan-service';
import { StudySessionService } from '../services/study-session-service';
import { StudyWebSearchService } from '../services/study-web-search-service';
import { StudyMode, StudySessionEvent } from '../models/study';
import { ApiProvider, DEFAULT_SETTINGS, SpaceforgeSettings } from '../models/settings';
import { setRequestUrlStub, StubRequestUrlRequest } from './support/obsidian-shim';

const NOTE_PATH = 'notes/enzyme-kinetics.md';
const NOTE = `# Enzyme kinetics

The substrate binds the active site and the enzyme lowers the activation energy.
The overall free-energy change is untouched.
`;

function settings(): SpaceforgeSettings {
    return {
        ...DEFAULT_SETTINGS,
        mcqApiProvider: ApiProvider.OpenAICompatible,
        openaiCompatibleApiUrl: 'http://tutor.test/v1',
        openaiCompatibleModel: 'scripted-tutor',
        openaiCompatibleApiKey: 'test-key',
        studyEnabled: true,
        studyTurnLimit: 6,
    };
}

function makePlugin(settingsObject: SpaceforgeSettings): unknown {
    return {
        settings: settingsObject,
        app: {
            metadataCache: { getFirstLinkpathDest: (): null => null },
            vault: { getAbstractFileByPath: (): null => null },
        },
        savePluginData: async (): Promise<void> => { /* no-op */ },
    };
}

function reply(payload: Record<string, unknown>): { status: number; json: unknown } {
    return {
        status: 200,
        json: { choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] },
    };
}

test('a correct answer reaches the rubric, and the wrap-up closes the session', async () => {
    const settingsObject = settings();
    const plugin = makePlugin(settingsObject) as never;
    const planService = new StudyPlanService(plugin, {}, {}, {});
    const plan = planService.buildPlanFromChart(NOTE_PATH, NOTE, {
        domain: 'life-sciences',
        topicSummary: 'Enzyme kinetics',
        objectives: [
            {
                title: 'The activation barrier',
                statement: 'Explain how the enzyme lowers the activation barrier without changing the overall free-energy change.',
                type: 'mechanism',
                importance: 'high',
                prerequisites: [],
                anchors: ['the enzyme lowers the activation energy'],
            },
        ],
    }, 'life-sciences');
    planService.savePlan(plan);

    const requests: number[] = [];
    const requestUrlStub = (request: StubRequestUrlRequest): { status: number; json: unknown } => {
        void request;
        const call = requests.length;
        requests.push(call);
        if (call === 0) {
            return reply({
                stage: 'orient',
                objectiveId: 'obj-1',
                say: 'Start with the barrier.',
                next: {
                    kind: 'question',
                    text: 'What does the enzyme lower?',
                    format: 'free',
                    objectiveId: 'obj-1',
                    expect: 'the activation barrier',
                    difficulty: 1,
                },
            });
        }
        if (call === 1) {
            return reply({
                stage: 'diagnose',
                objectiveId: 'obj-1',
                say: '',
                verdict: { correct: true, errorCategory: 'success', diagnosis: null, correction: null },
                progress: { objectiveId: 'obj-1', U: 2, R: 2, T: 1, confidence: 2, observations: ['explains the barrier in his own words'] },
                next: {
                    kind: 'question',
                    text: 'And what happens to the overall free-energy change?',
                    format: 'free',
                    objectiveId: 'obj-1',
                    expect: 'nothing',
                    difficulty: 2,
                },
            });
        }
        return reply({
            stage: 'consolidate',
            say: 'Good — the barrier is the tool, and the free-energy change is untouched.',
            sessionComplete: true,
            summary: 'The barrier is lowered; the free-energy change is untouched.',
            scheduleSuggestions: [{ objectiveId: 'obj-1', inDays: 3 }],
        });
    };

    setRequestUrlStub(requestUrlStub);

    try {
        const search = new StudyWebSearchService(plugin);
        const session = new StudySessionService(
            plugin,
            planService,
            search,
            NOTE_PATH,
            NOTE,
            plan,
            { mode: StudyMode.Guided, webSearch: false, turnLimit: 6, freshStart: true }
        );
        const events: StudySessionEvent[] = [];
        session.subscribe(event => events.push(event));

        await session.start();
        const opening = events.find(event => event.type === 'turn');
        assert.ok(opening && opening.type === 'turn', 'the opening turn arrived');
        assert.equal(opening.turn.structured, true, 'the opening turn parsed as protocol JSON');
        assert.ok(session.getPendingPrompt(), 'the opening turn asked something');

        await session.answer('It lowers the activation barrier, so more molecules can react at the same temperature.');
        const state = session.getProgress().objectives['obj-1'];
        assert.ok(state, 'the objective has a progress state');
        assert.equal(state.attempts, 1, 'the attempt was recorded');
        assert.equal(state.successes, 1, 'the success was counted');
        // The rubric moves at most one step per turn, so a proposal of U2/R2/T1
        // lands as U1/R1/T1 on the first evidence.
        assert.ok(state.U >= 1, `the correct answer moved understanding (U=${state.U})`);
        assert.ok(state.R >= 1, `the correct answer moved retrieval (R=${state.R})`);
        assert.ok(events.some(event => event.type === 'progress'), 'a progress event was emitted');
        const feedback = session.getSessionRecord().transcript.find(turn => turn.kind === 'feedback');
        assert.ok(feedback, 'the transcript has tutor feedback');
        assert.equal(feedback.correct, true, 'the feedback is marked as a correct answer');

        await session.command('wrap-up');
        const record = session.getSessionRecord();
        assert.equal(record.completed, true, 'the wrap-up completed the session');
        assert.equal(record.errorCounts.success, 1, 'the session counted one success');
        assert.ok(record.summary?.includes('barrier'), 'the tutor summary was kept', record.summary);
        assert.ok(record.score !== null && record.score > 0, `the score reflects the correct answer (${record.score})`);
        assert.equal(planService.sessionsForNote(NOTE_PATH).length, 1, 'the session was saved under the note');
        assert.equal(requests.length, 3, 'one request per tutor turn');
    } finally {
        setRequestUrlStub(null);
    }
});
