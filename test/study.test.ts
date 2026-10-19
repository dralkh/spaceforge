/**
 * Study (adaptive tutor) tests.
 *
 * These cover the parts that decide what the learner is credited with knowing
 * and how a note is charted, because those are the parts where being wrong
 * quietly poisons a study record. No model, UI or Obsidian instance is needed:
 * the protocol parser, the domain registry, the plan/merge logic and the
 * evidence rubric are all pure.
 *
 * Run with `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    StudyErrorCategory,
    StudyMode,
    StudyObjectiveStatus,
    StudyObjectiveType,
    StudyPlan,
    StudyProgressStore,
    StudySessionRecord,
    StudyStage,
    createObjectiveProgress,
    deriveObjectiveStatus,
    objectiveMastery,
} from '../models/study';
import { applyEvidence, computeFocusOrder, computeSessionScore } from '../models/study-rubric';
import { detectDomain, getDomainProfile, STUDY_DOMAINS } from '../models/study-domains';
import { StudyPlanService, filterVerifiedSources, renderSessionMarkdown } from '../services/study-plan-service';
import { parseErrorCategory, parseJsonLoose, parseObjectiveType, parseStage, parseTutorTurn } from '../utils/tutor-protocol';
import { DEFAULT_SETTINGS, SpaceforgeSettings } from '../models/settings';

function makePlugin(overrides: Partial<SpaceforgeSettings> = {}): Record<string, unknown> {
    return { settings: { ...DEFAULT_SETTINGS, ...overrides } };
}

function makePlanService(settings: Partial<SpaceforgeSettings> = {}): {
    service: StudyPlanService;
    plans: Record<string, StudyPlan>;
    progress: Record<string, StudyProgressStore>;
    sessions: Record<string, StudySessionRecord[]>;
} {
    const plans: Record<string, StudyPlan> = {};
    const progress: Record<string, StudyProgressStore> = {};
    const sessions: Record<string, StudySessionRecord[]> = {};
    const service = new StudyPlanService(
        makePlugin(settings) as unknown as ConstructorParameters<typeof StudyPlanService>[0],
        plans,
        progress,
        sessions
    );
    return { service, plans, progress, sessions };
}

// --------------------------------------------------------------- protocol

test('parses a clean tutor turn, normalising enums and clamping scores', () => {
    const turn = parseTutorTurn(JSON.stringify({
        stage: 'Retrieve',
        objectiveId: 'obj-2',
        say: 'Good. Now the harder part.',
        anchors: ['the threshold is 4 mmol/L'],
        verdict: { correct: false, errorCategory: 'confusion', diagnosis: 'mixed up A and B' },
        progress: { objectiveId: 'obj-2', U: 9, R: 11, T: -4, observations: ['blends A with B'] },
        next: { kind: 'question', text: 'Which one applies here?', format: 'mcq', choices: ['A', 'B', 'C'], correctIndex: 1, expect: 'B because…', difficulty: 7 },
        scheduleSuggestions: [{ objectiveId: 'obj-2', inDays: 3 }],
    }));

    assert.equal(turn.structured, true);
    assert.equal(turn.stage, StudyStage.Retrieve);
    assert.equal(turn.objectiveId, 'obj-2');
    // "confusion" is an alias the parser normalises to the canonical category.
    assert.equal(turn.verdict?.errorCategory, StudyErrorCategory.Discrimination);
    assert.equal(turn.verdict?.correct, false);
    // Scores are clamped into the 0-3 rubric instead of trusted.
    assert.equal(turn.progress?.U, 3);
    assert.equal(turn.progress?.R, 3);
    assert.equal(turn.progress?.T, 0);
    assert.deepEqual(turn.progress?.observations, ['blends A with B']);
    assert.equal(turn.next?.format, 'mcq');
    assert.equal(turn.next?.correctIndex, 1);
    assert.equal(turn.next?.expect, 'B because…');
    // Difficulty is clamped to 1-4.
    assert.equal(turn.next?.difficulty, 4);
    assert.equal(turn.scheduleSuggestions[0]?.inDays, 3);
});

test('repairs the JSON damage models actually produce', () => {
    const messy = 'Here you go:\n```json\n{ "say": "Take the “slow” path", "next": { "text": "Why?", }, }\n```\nHope that helps.';
    const turn = parseTutorTurn(messy);
    assert.equal(turn.structured, true);
    // Trailing commas are dropped, and curly quotes *inside* a string survive
    // intact instead of terminating it early.
    assert.equal(turn.say, 'Take the “slow” path');
    assert.equal(turn.next?.text, 'Why?');
});

test('repairs curly quotes used as delimiters', () => {
    const turn = parseTutorTurn('{ “stage”: “retrieve”, “say”: “Which threshold applies?”, “next”: { “kind”: “question”, “text”: “Say it in your own words.” } }');
    assert.equal(turn.structured, true);
    assert.equal(turn.stage, StudyStage.Retrieve);
    assert.equal(turn.say, 'Which threshold applies?');
    assert.equal(turn.next?.text, 'Say it in your own words.');
});

test('accepts an array of turns and uses the first', () => {
    const turn = parseTutorTurn('[{"say":"first"},{"say":"second"}]');
    assert.equal(turn.structured, true);
    assert.equal(turn.say, 'first');
});

test('degrades to prose instead of failing when nothing parses', () => {
    const turn = parseTutorTurn('```\nNo JSON here at all, just an explanation of the mechanism.\n```');
    assert.equal(turn.structured, false);
    assert.match(turn.say, /explanation of the mechanism/);
    assert.equal(turn.next, null);
    assert.equal(turn.verdict, null);
});

test('only accepts sources shaped like URLs', () => {
    const turn = parseTutorTurn(JSON.stringify({
        say: 'x',
        sources: [{ title: 'Paper', url: 'https://example.org/a' }, { title: 'made up' }, 'https://example.org/b'],
    }));
    assert.deepEqual(turn.sources.map(source => source.url), ['https://example.org/a', 'https://example.org/b']);
});

test('parses the enums from the words models actually write', () => {
    assert.equal(parseStage('recall'), StudyStage.Retrieve);
    assert.equal(parseStage('Re-teaching'), StudyStage.Remediate);
    assert.equal(parseStage('wrap up'), StudyStage.Consolidate);
    assert.equal(parseStage('consolidate'), StudyStage.Consolidate);
    assert.equal(parseStage('nonsense'), null);
    assert.equal(parseErrorCategory('I do not know'), StudyErrorCategory.Uncertain);
    assert.equal(parseErrorCategory('recall failure'), StudyErrorCategory.RetrievalFailure);
    assert.equal(parseErrorCategory('transfer'), StudyErrorCategory.ApplicationError);
    assert.equal(parseObjectiveType('compare/contrast'), StudyObjectiveType.Distinction);
    assert.equal(parseObjectiveType('calculation'), StudyObjectiveType.Application);
    assert.equal(parseJsonLoose('not json'), null);
});

// ---------------------------------------------------------------- domains

test('detects the discipline from the note and always has a fallback', () => {
    assert.equal(detectDomain('The patient presented with a fever; the diagnosis was made by blood culture and the dose was adjusted.').id, 'medicine');
    assert.equal(detectDomain('Prove that the integral converges; state the theorem and the lemma it depends on.').id, 'mathematics');
    assert.equal(detectDomain('The function returns a promise; check the runtime and the compiler version.').id, 'computing');
    assert.equal(detectDomain('nothing indicative here').id, 'general');
    assert.equal(detectDomain('').id, 'general');
});

test('every domain profile is complete enough to steer the tutor', () => {
    for (const profile of STUDY_DOMAINS) {
        assert.ok(profile.id.length > 0, `${profile.id} has an id`);
        assert.ok(profile.label.length > 0, `${profile.id} has a label`);
        assert.ok(profile.mechanism.length > 20, `${profile.id} explains what a mechanism is here`);
        assert.ok(profile.transfer.length > 20, `${profile.id} describes a transfer task`);
        assert.ok(profile.pitfalls.length > 0, `${profile.id} lists characteristic mistakes`);
        assert.ok(profile.authority.length > 0, `${profile.id} names an authority`);
    }
    // The unknown id falls back rather than throwing.
    assert.equal(getDomainProfile('not-a-domain').id, 'general');
    assert.equal(getDomainProfile(null).id, 'general');
    // Safety-critical subjects are flagged, so the tutor is told to be strict.
    assert.equal(getDomainProfile('medicine').safetyCritical, true);
    assert.equal(getDomainProfile('mathematics').safetyCritical, false);
});

// ------------------------------------------------------------------ plans

test('fingerprints notice when a note changes', () => {
    const a = StudyPlanService.fingerprint('# Note\nbody');
    const b = StudyPlanService.fingerprint('# Note\nbody.');
    assert.notEqual(a, b);
    assert.equal(a, StudyPlanService.fingerprint('# Note\nbody'));
});

test('charts a plan: assigns ids, folds duplicates, resolves prerequisites, caps the count', () => {
    const { service } = makePlanService({ studyMaxObjectives: 4 });
    const plan = service.buildPlanFromChart(
        'Topics/Cell.md',
        'Mitosis and meiosis are both division processes.',
        {
            domain: 'life-sciences',
            domainNotes: 'Teach the pathways before the outcomes.',
            topicSummary: 'Cell division.',
            objectives: [
                { title: 'Mitosis', statement: 'Explain how mitosis produces two identical cells', type: 'mechanism', importance: 'critical', anchors: ['identical cells'] },
                { title: 'Mitosis', statement: 'Explain how mitosis produces two identical cells', anchors: ['identical cells'] },
                { title: 'Meiosis', statement: 'Explain how meiosis produces four distinct cells', type: 'mechanism', prerequisites: ['Mitosis'], anchors: ['four distinct cells'] },
                { title: 'Contrast', statement: 'Distinguish mitosis from meiosis', type: 'distinction', prerequisites: ['Mitosis', 'Meiosis'] },
                { title: 'Extra', statement: 'Something beyond the cap', type: 'fact' },
                { title: 'Extra 2', statement: 'Something else beyond the cap', type: 'fact' },
            ],
            uncovered: ['a table of stages'],
        },
        'general'
    );

    assert.equal(plan.objectives.length, 4, 'the cap is honoured');
    assert.equal(plan.domainId, 'life-sciences');
    assert.equal(plan.domainNotes, 'Teach the pathways before the outcomes.');
    assert.equal(plan.objectives[0].id, 'obj-1');
    // The duplicate was folded into the first one, keeping its anchors.
    assert.equal(plan.objectives.filter(o => o.title === 'Mitosis').length, 1);
    // Prerequisites named by title became ids.
    assert.deepEqual(plan.objectives[1].prerequisites, ['obj-1']);
    assert.deepEqual(plan.objectives[2].prerequisites, ['obj-1', 'obj-2']);
    // An unknown type is inferred rather than left blank.
    assert.equal(plan.objectives[2].type, StudyObjectiveType.Distinction);
    assert.deepEqual(plan.uncoveredSource, ['a table of stages']);
    assert.equal(plan.contentFingerprint, StudyPlanService.fingerprint('Mitosis and meiosis are both division processes.'));
});

test('breaking a prerequisite cycle keeps the plan usable', () => {
    const { service } = makePlanService();
    const plan = service.buildPlanFromChart('a.md', 'body', {
        objectives: [
            { title: 'A', statement: 'Concept A depends on B', prerequisites: ['B'] },
            { title: 'B', statement: 'Concept B depends on A', prerequisites: ['A'] },
        ],
    }, 'general');
    const a = plan.objectives[0];
    const b = plan.objectives[1];
    assert.ok(!(a.prerequisites.includes(b.id) && b.prerequisites.includes(a.id)), 'no mutual dependency survives');
});

test('re-charting keeps earned mastery on matching objectives and drops the rest', () => {
    const { service, progress } = makePlanService();
    const first = service.buildPlanFromChart('a.md', 'body one', {
        objectives: [
            { title: 'Ion channels', statement: 'Explain how ion channels open and close', type: 'mechanism' },
            { title: 'Action potential', statement: 'Explain the phases of an action potential', type: 'mechanism' },
        ],
    }, 'general');
    service.savePlan(first);

    const store = service.ensureProgress(first);
    const kept = store.objectives['obj-1'];
    kept.U = 3;
    kept.R = 2;
    kept.successfulDays = ['2026-01-01', '2026-01-02'];
    store.objectives['obj-2'].U = 1;

    // The note changed: objective 1 survives (renamed id, same idea), 2 is gone.
    const rechart = service.buildPlanFromChart('a.md', 'body two', {
        objectives: [
            { title: 'Ion channels', statement: 'Explain how ion channels open and close', type: 'mechanism' },
            { title: 'Membrane pumps', statement: 'Explain how the sodium-potassium pump moves ions', type: 'mechanism' },
        ],
    }, 'general');

    const merged = service.mergePlans(first, rechart);
    assert.equal(merged.kept, 1);
    assert.equal(merged.added, 1);
    assert.equal(merged.dropped.length, 1);

    const carried = service.getProgress('a.md')?.objectives['obj-1'];
    assert.equal(carried?.U, 3, 'mastery followed the matching objective');
    assert.equal(carried?.successfulDays.length, 2);
    const fresh = service.getProgress('a.md')?.objectives['obj-2'];
    assert.equal(fresh?.U, 0, 'the new objective starts empty');
    assert.ok(service.getProgress('a.md')?.tutorMemory.some(line => /no longer in the note/.test(line)));
});

test('coverage, mastery and due dates read from the progress store', () => {
    const { service } = makePlanService();
    const plan = service.buildPlanFromChart('a.md', 'body', {
        objectives: [
            { title: 'One', statement: 'Explain the first idea properly' },
            { title: 'Two', statement: 'Explain the second idea properly' },
        ],
    }, 'general');
    service.savePlan(plan);
    const store = service.ensureProgress(plan);

    assert.equal(service.coverageCount(plan, store), 0);
    assert.equal(service.overallMastery(plan, store), 0);
    assert.deepEqual(service.dueObjectives(plan, store), []);

    store.objectives['obj-1'] = { ...store.objectives['obj-1'], U: 3, R: 2, T: 2, attempts: 3, successfulDays: ['2026-01-01', '2026-01-02'], status: deriveObjectiveStatus({ ...store.objectives['obj-1'], U: 3, R: 2, T: 2, successfulDays: ['2026-01-01', '2026-01-02'] }) };
    assert.equal(service.coverageCount(plan, store), 1);
    assert.ok(service.overallMastery(plan, store) > 0);

    service.scheduleObjective(plan, store, 'obj-1', 0);
    const due = service.dueObjectives(plan, store, Date.now() + 1000);
    assert.equal(due.length, 1);
    assert.equal(due[0].objectiveId, 'obj-1');
    // Suggestions are always labelled provisional.
    assert.equal(store.scheduleSuggestions[0].provisional, true);
});

test('the derived status needs evidence from more than one day for mastery', () => {
    const sameDay = { ...createObjectiveProgress(), U: 3, R: 3, T: 3, attempts: 4, successfulDays: ['2026-03-03'] };
    assert.notEqual(deriveObjectiveStatus(sameDay), StudyObjectiveStatus.Mastered);
    const acrossDays = { ...sameDay, successfulDays: ['2026-03-03', '2026-03-09'] };
    assert.equal(deriveObjectiveStatus(acrossDays), StudyObjectiveStatus.Mastered);
    const noTransfer = { ...acrossDays, T: 1 };
    assert.equal(deriveObjectiveStatus(noTransfer), StudyObjectiveStatus.Stable);
    assert.equal(deriveObjectiveStatus(createObjectiveProgress()), StudyObjectiveStatus.Unseen);
});

// ----------------------------------------------------------------- rubric

test('the rubric cannot be inflated: +1 per turn, and no durable recall in one sitting', () => {
    const start = createObjectiveProgress();
    const greedy = applyEvidence(start, {
        proposal: { objectiveId: 'obj-1', U: 3, R: 3, T: 3, confidence: 3, observations: [] },
        verdict: { correct: true, errorCategory: StudyErrorCategory.Success, diagnosis: null, correction: null, confidence: 3 },
        today: '2026-05-01',
        now: 1000,
    });

    assert.equal(greedy.state.U, 1, 'understanding rises one step at a time');
    assert.equal(greedy.state.R, 1, 'recall rises one step at a time');
    assert.equal(greedy.state.T, 1);
    assert.equal(greedy.attempted, true);
    assert.equal(greedy.state.successes, 1);
    assert.deepEqual(greedy.state.successfulDays, ['2026-05-01']);
    assert.equal(greedy.becameMastered, false);
    assert.equal(greedy.suggestedReviewDays, 1, 'a fragile objective comes back tomorrow');

    // A second sitting on another day can reach the ceiling, but still not 3.
    const dayTwo = applyEvidence(greedy.state, {
        proposal: { objectiveId: 'obj-1', U: 3, R: 3, T: 3, confidence: 3, observations: [] },
        verdict: { correct: true, errorCategory: StudyErrorCategory.Success, diagnosis: null, correction: null, confidence: 3 },
        today: '2026-05-02',
        now: 2000,
    });
    assert.equal(dayTwo.state.R, 2, 'R3 needs two separate days of recall');
    assert.equal(dayTwo.state.successfulDays.length, 2);
    assert.deepEqual(dayTwo.state.successfulDays, ['2026-05-01', '2026-05-02']);

    // Only once that history exists may the tutor's R3 through.
    const settled = { ...dayTwo.state, U: 3, T: 2, R: 2 };
    const third = applyEvidence(settled, {
        proposal: { objectiveId: 'obj-1', U: 3, R: 3, T: 3, confidence: 3, observations: [] },
        verdict: { correct: true, errorCategory: StudyErrorCategory.Success, diagnosis: null, correction: null, confidence: 3 },
        today: '2026-05-09',
        now: 3000,
    });
    assert.equal(third.state.R, 3);
    assert.equal(third.state.status, StudyObjectiveStatus.Mastered);
    assert.equal(third.becameMastered, true);
    assert.equal(third.suggestedReviewDays, 30, 'mastered objectives go a month out');
});

test('a miss costs the dimension that actually failed', () => {
    const base = { ...createObjectiveProgress(), U: 2, R: 2, T: 2, attempts: 2 };

    const encoding = applyEvidence(base, {
        proposal: null,
        verdict: { correct: false, errorCategory: StudyErrorCategory.EncodingGap, diagnosis: 'x', correction: 'y', confidence: null },
        today: '2026-06-01',
        now: 1,
    });
    assert.equal(encoding.state.U, 1);
    assert.equal(encoding.state.R, 2, 'recall was not the failure');
    assert.equal(encoding.state.errorCounts[StudyErrorCategory.EncodingGap], 1);
    assert.equal(encoding.suggestedReviewDays, 1);

    const recall = applyEvidence(base, {
        proposal: null,
        verdict: { correct: false, errorCategory: StudyErrorCategory.RetrievalFailure, diagnosis: null, correction: null, confidence: null },
        today: '2026-06-01',
        now: 1,
    });
    assert.equal(recall.state.R, 1);
    assert.equal(recall.state.U, 2);

    const transfer = applyEvidence(base, {
        proposal: null,
        verdict: { correct: false, errorCategory: StudyErrorCategory.ApplicationError, diagnosis: null, correction: null, confidence: null },
        today: '2026-06-01',
        now: 1,
    });
    assert.equal(transfer.state.T, 1);
    assert.equal(transfer.state.U, 2);

    // "I don't know" is a signal, not an automatic demotion of everything.
    const unsure = applyEvidence(base, {
        proposal: null,
        verdict: { correct: false, errorCategory: StudyErrorCategory.Uncertain, diagnosis: null, correction: null, confidence: null },
        today: '2026-06-01',
        now: 1,
    });
    assert.equal(unsure.state.U, 2);
    assert.equal(unsure.state.R, 2);
    assert.equal(unsure.state.T, 2);
    assert.equal(unsure.state.attempts, 3);
});

test('a turn with no attempt at all does not move the rubric', () => {
    const start = createObjectiveProgress();
    const outcome = applyEvidence(start, {
        proposal: { objectiveId: 'obj-1', U: 2, R: 2, T: 2, confidence: 2, observations: ['x'] },
        verdict: null,
        today: '2026-06-01',
        now: 1,
    });
    assert.equal(outcome.attempted, false);
    assert.equal(outcome.state.attempts, 0);
    assert.equal(outcome.state.U, 1, 'explanations still raise understanding, one step at a time');
    assert.equal(outcome.suggestedReviewDays, null);
});

test('session scoring refuses to award a perfect score inside one sitting', () => {
    const progress: StudyProgressStore = {
        notePath: 'a.md',
        updatedAt: 0,
        totalSessions: 1,
        completedSessions: 0,
        objectives: {
            'obj-1': { ...createObjectiveProgress(), U: 3, R: 3, T: 3, attempts: 3, successfulDays: ['2026-01-01'] },
        },
        tutorMemory: [],
        lastSessionSummary: null,
        scheduleSuggestions: [],
    };
    const sameDay = computeSessionScore(progress, ['obj-1']);
    assert.ok(sameDay < 1, `expected a capped score, got ${sameDay}`);

    progress.objectives['obj-1'].successfulDays = ['2026-01-01', '2026-01-08'];
    assert.equal(computeSessionScore(progress, ['obj-1']), 1);
    assert.equal(computeSessionScore(progress, []), 0);
    assert.equal(computeSessionScore(progress, ['missing']), 0);
    assert.equal(objectiveMastery(createObjectiveProgress()), 0);
});

// ------------------------------------------------------------ focus order

function planWith(objectives: Partial<StudyPlan['objectives'][number]>[]): { plan: StudyPlan; progress: StudyProgressStore } {
    const plan: StudyPlan = {
        notePath: 'a.md',
        generatedAt: 0,
        updatedAt: 0,
        version: 1,
        contentFingerprint: 'x',
        domainId: 'general',
        domainLabel: 'General topic',
        domainNotes: '',
        domainOverriddenByUser: false,
        safetyCritical: false,
        topicSummary: 'x',
        objectives: objectives.map((objective, index) => ({
            id: `obj-${index + 1}`,
            title: `Objective ${index + 1}`,
            statement: `Explain objective ${index + 1}`,
            type: StudyObjectiveType.Mechanism,
            importance: 'standard' as const,
            prerequisites: [],
            anchors: [],
            ...objective,
        })),
        uncoveredSource: [],
        tutorMemory: [],
    };
    const progress: StudyProgressStore = {
        notePath: 'a.md',
        updatedAt: 0,
        totalSessions: 0,
        completedSessions: 0,
        objectives: {},
        tutorMemory: [],
        lastSessionSummary: null,
        scheduleSuggestions: [],
    };
    for (const objective of plan.objectives) progress.objectives[objective.id] = createObjectiveProgress();
    return { plan, progress };
}

test('prerequisites are worked through before what depends on them', () => {
    const { plan, progress } = planWith([
        { title: 'Foundations', statement: 'Explain the groundwork', importance: 'standard' },
        { title: 'Application', statement: 'Apply the groundwork to a new case', prerequisites: ['obj-1'], importance: 'critical' },
    ]);
    const order = computeFocusOrder(StudyMode.Guided, plan.objectives, progress, Date.now());
    assert.deepEqual(order, ['obj-1', 'obj-2'], 'the depended-on objective comes first even though the other is critical');
});

test('guided sessions lead with the mechanism, not the loudest critical objective', () => {
    // A chart like the metformin one: a mechanism objective, then critical
    // application objectives that depend on it conceptually.
    const { plan, progress } = planWith([
        { title: 'Mechanism', statement: 'Explain how the drug lowers glucose', type: StudyObjectiveType.Mechanism, importance: 'high' },
        { title: 'Thresholds', statement: 'Apply the renal thresholds to a given eGFR', type: StudyObjectiveType.Application, importance: 'critical' },
        { title: 'Safety', statement: 'Decide when the drug must be held', type: StudyObjectiveType.Safety, importance: 'critical' },
    ]);
    const order = computeFocusOrder(StudyMode.Guided, plan.objectives, progress, Date.now());
    assert.equal(order[0], 'obj-1', 'the mechanism is taught before the thresholds that depend on understanding it');

    // A mechanism that is still shaky keeps priority until it is finished —
    // unfinished understanding is worse than unstarted material. Once it is
    // solid, untouched critical objectives come first instead.
    progress.objectives['obj-1'].attempts = 2;
    progress.objectives['obj-1'].U = 2;
    progress.objectives['obj-1'].status = StudyObjectiveStatus.Learning;
    const shaky = computeFocusOrder(StudyMode.Guided, plan.objectives, progress, Date.now());
    assert.equal(shaky[0], 'obj-1', 'a half-learned mechanism is finished before anything new is started');

    progress.objectives['obj-1'].U = 3;
    progress.objectives['obj-1'].R = 2;
    progress.objectives['obj-1'].T = 1;
    progress.objectives['obj-1'].status = StudyObjectiveStatus.Stable;
    const solid = computeFocusOrder(StudyMode.Guided, plan.objectives, progress, Date.now());
    assert.notEqual(solid[0], 'obj-1', 'a solid mechanism stops outranking untouched critical material');
});

test('repair sessions chase errors and scenario sessions refuse new material', () => {
    const { plan, progress } = planWith([
        { title: 'Shaky', statement: 'Explain the shaky idea', importance: 'standard' },
        { title: 'Untouched', statement: 'Explain the untouched idea', importance: 'critical' },
    ]);
    progress.objectives['obj-1'].errorCounts[StudyErrorCategory.Discrimination] = 3;
    progress.objectives['obj-1'].attempts = 4;
    progress.objectives['obj-1'].U = 2;
    progress.objectives['obj-1'].status = StudyObjectiveStatus.Fragile;

    const repair = computeFocusOrder(StudyMode.Repair, plan.objectives, progress, Date.now());
    assert.equal(repair[0], 'obj-1');

    const scenarios = computeFocusOrder(StudyMode.Scenarios, plan.objectives, progress, Date.now());
    assert.equal(scenarios[scenarios.length - 1], 'obj-2', 'an unseen objective is pushed to the end');
});

// ------------------------------------------------------------- reporting

test('citation filtering drops anything a lookup did not return', () => {
    const allowed = new Set(['https://example.org/real']);
    const kept = filterVerifiedSources([
        { title: 'real', url: 'https://example.org/real' },
        { title: 'invented', url: 'https://example.org/invented' },
    ], allowed);
    assert.deepEqual(kept.map(source => source.url), ['https://example.org/real']);
    assert.deepEqual(filterVerifiedSources([{ title: 'x', url: 'https://example.org/real' }], new Set()), []);
});

test('the session report is a readable note with usable cards', () => {
    const { plan } = planWith([
        { title: 'Ion channels', statement: 'Explain how ion channels open', importance: 'critical' },
    ]);
    const session: StudySessionRecord = {
        id: 'study-1',
        notePath: 'a.md',
        mode: StudyMode.Guided,
        webSearch: false,
        startedAt: Date.parse('2026-02-02T10:00:00Z'),
        endedAt: Date.parse('2026-02-02T10:30:00Z'),
        turnCount: 4,
        objectivesTouched: ['obj-1'],
        objectivesMastered: ['obj-1'],
        errorCounts: { [StudyErrorCategory.RetrievalFailure]: 2 },
        transcript: [
            { id: 't-1', role: 'tutor', kind: 'question', text: 'What opens the channel?', objectiveId: 'obj-1', stage: StudyStage.Retrieve, errorCategory: null, correct: null, at: 1 },
            { id: 't-2', role: 'user', kind: 'answer', text: 'voltage', objectiveId: 'obj-1', stage: null, errorCategory: null, correct: null, at: 2 },
            { id: 't-3', role: 'tutor', kind: 'feedback', text: 'Voltage, and specifically the threshold.', objectiveId: 'obj-1', stage: StudyStage.Diagnose, errorCategory: StudyErrorCategory.Success, correct: true, at: 3 },
        ],
        summary: 'Channels work; thresholds needed work.',
        score: 0.62,
        completed: true,
        webLookups: 0,
        sources: [{ title: 'A paper', url: 'https://example.org/a' }],
    };

    const markdown = renderSessionMarkdown(plan, {
        session,
        digest: {
            turnCount: 4, turnLimit: 24, covered: 1, totalObjectives: 1, mastered: 1, masteryScore: 0.8,
            errorCounts: session.errorCounts, dueObjectives: [], nextSuggestions: [], webLookups: 0, elapsedMs: 1000,
        },
        mastered: ['obj-1'],
        fragile: [],
        score: 0.62,
    });

    assert.match(markdown, /Study session/);
    assert.match(markdown, /Now solid/);
    assert.match(markdown, /retrieval-failure: 2/);
    assert.match(markdown, /What opens the channel\?\:\:Voltage, and specifically the threshold\./, 'cards are one question to one answer');
    assert.match(markdown, /https:\/\/example\.org\/a/);
    assert.match(markdown, /generated/i, 'the report says it is generated');
});
