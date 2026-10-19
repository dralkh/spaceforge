/**
 * The evidence rules for Study, as pure functions.
 *
 * Kept out of the session engine on purpose: these are the rules that decide
 * whether a learner is credited with knowing something, so they need to be
 * inspectable and testable without a model, a UI or Obsidian.
 *
 * Two things are enforced here rather than trusted to the tutor:
 *
 * - **Nothing rises too fast.** The model is optimistic, and it likes to hand
 *   out understanding after one good sentence and recall after one lucky
 *   guess. Scores can only rise by one point per turn.
 * - **Nothing is durable inside a single sitting.** Recall tops out at 2 until
 *   the learner has produced it correctly on a second day, and R3 requires
 *   that. This is what makes "you know this now" an earned claim, and it also
 *   keeps the review rating a session produces conservative.
 */

import {
    ObjectiveProgressState,
    StudyErrorCategory,
    StudyMode,
    StudyObjective,
    StudyObjectiveStatus,
    StudyObjectiveType,
    StudyProgressStore,
    STUDY_STATUS_REVIEW_DAYS,
    StudyReviewSuggestion,
    TutorProgressUpdate,
    TutorVerdict,
    createObjectiveProgress,
    deriveObjectiveStatus,
    objectiveMastery,
} from './study';

/** The most the rubric will credit from a single day's evidence. */
export const SINGLE_SESSION_RECALL_CEILING = 2;

export interface RubricEvidence {
    /** The tutor's proposed scores, if it proposed any. */
    proposal: TutorProgressUpdate | null;
    /** The tutor's judgement of the attempt, if there was one. */
    verdict: TutorVerdict | null;
    /** Local day key (YYYY-MM-DD) used for the cross-day rule. */
    today: string;
    /** Wall clock, injected so tests are deterministic. */
    now: number;
}

export interface RubricOutcome {
    /** The new state; the input is never mutated. */
    state: ObjectiveProgressState;
    /** Whether this counted as an attempt at all. */
    attempted: boolean;
    /** Whether the status changed from something else to mastered. */
    becameMastered: boolean;
    /** Review interval this evidence justifies, or null when nothing moved. */
    suggestedReviewDays: number | null;
}

/** Copy a state so callers can keep their own previous version. */
function copyState(state: ObjectiveProgressState): ObjectiveProgressState {
    return {
        ...state,
        errorCounts: { ...state.errorCounts },
        successfulDays: [...state.successfulDays],
        observations: [...state.observations],
    };
}

/**
 * Apply one piece of evidence to one objective.
 *
 * This is the only place scores change, so it is also the only place the
 * cross-day and one-step-per-turn rules can be bypassed — hence the tests.
 */
export function applyEvidence(state: ObjectiveProgressState, evidence: RubricEvidence): RubricOutcome {
    const next = copyState(state);
    const { proposal, verdict, today, now } = evidence;
    const attempted = verdict !== null;
    const correct = verdict?.correct ?? null;
    const wasMastered = state.status === StudyObjectiveStatus.Mastered;

    next.attempts += attempted ? 1 : 0;
    next.lastSeenAt = now;
    next.confidence = proposal?.confidence ?? verdict?.confidence ?? next.confidence;

    if (correct === true) {
        next.successes += 1;
        next.lastSuccessAt = now;
        next.lastSuccessDay = today;
        if (!next.successfulDays.includes(today)) {
            next.successfulDays = [...next.successfulDays, today].slice(-12);
        }
    }

    if (proposal) {
        // Cross-day rule: a session alone can never produce R3.
        const recallCeiling = next.successfulDays.length >= 2 ? 3 : SINGLE_SESSION_RECALL_CEILING;
        next.U = step(next.U, proposal.U, 3);
        next.R = step(next.R, proposal.R, recallCeiling);
        next.T = step(next.T, proposal.T, 3);

        const observations = proposal.observations.filter(observation => observation.trim().length > 0);
        if (observations.length > 0) {
            next.observations = Array.from(new Set([...next.observations, ...observations])).slice(-8);
        }
    }

    if (verdict && verdict.correct === false) {
        const category = verdict.errorCategory ?? StudyErrorCategory.ApplicationError;
        next.errorCounts[category] = (next.errorCounts[category] ?? 0) + 1;
        switch (category) {
            case StudyErrorCategory.EncodingGap:
                // They never had the model, so understanding is what is missing.
                next.U = Math.max(0, next.U - 1);
                break;
            case StudyErrorCategory.RetrievalFailure:
            case StudyErrorCategory.Discrimination:
                next.R = Math.max(0, next.R - 1);
                break;
            case StudyErrorCategory.ApplicationError:
                next.T = Math.max(0, next.T - 1);
                break;
            default:
                break;
        }
    }

    next.status = deriveObjectiveStatus(next);

    const suggestedReviewDays = correct === null
        ? null
        : correct
            ? (STUDY_STATUS_REVIEW_DAYS[next.status] ?? 1)
            : 1;

    return {
        state: next,
        attempted,
        becameMastered: !wasMastered && next.status === StudyObjectiveStatus.Mastered,
        suggestedReviewDays,
    };
}

/**
 * Move one score, allowing at most a single point of increase.
 * A decrease is applied as given: being wrong should cost something.
 */
function step(current: number, proposed: number | null, ceiling: number): number {
    if (proposed === null || Number.isNaN(proposed)) return current;
    const bounded = Math.max(0, Math.min(ceiling, Math.round(proposed)));
    if (bounded >= current) return Math.min(bounded, current + 1);
    return bounded;
}

/**
 * Score a session from the objectives the learner actually worked on.
 *
 * Recall is re-capped here for the same reason as above: a single sitting is
 * not evidence of durable recall, so a perfect score has to be earned across
 * days rather than inside one conversation.
 */
export function computeSessionScore(progress: StudyProgressStore, touchedObjectiveIds: string[]): number {
    if (touchedObjectiveIds.length === 0) return 0;
    let total = 0;
    let counted = 0;
    for (const id of touchedObjectiveIds) {
        const state = progress.objectives[id];
        if (!state) continue;
        const recall = state.successfulDays.length >= 2 ? state.R : Math.min(state.R, SINGLE_SESSION_RECALL_CEILING);
        total += objectiveMastery({ ...state, R: recall });
        counted++;
    }
    return counted === 0 ? 0 : Math.max(0, Math.min(1, total / counted));
}

export interface FocusEntry {
    objectiveId: string;
    score: number;
}

/**
 * Order the objectives for a session.
 *
 * Prerequisites are respected by construction: an objective is only considered
 * once nothing it depends on is still waiting. Inside that constraint the mode
 * decides what matters — a repair session ignores new material, a scenarios
 * session refuses to look at anything the learner has not started, and a drill
 * session chases whatever is due.
 */
export function computeFocusOrder(
    mode: StudyMode,
    objectives: StudyObjective[],
    progress: StudyProgressStore,
    now: number
): string[] {
    const score = (objective: StudyObjective): number => {
        const state = progress.objectives[objective.id] ?? createObjectiveProgress();
        const importanceWeight = objective.importance === 'critical' ? 3 : objective.importance === 'high' ? 2 : 1;
        const errors = Object.entries(state.errorCounts)
            .filter(([category]) => category !== 'success')
            .reduce((sum, [, count]) => sum + (count ?? 0), 0);
        const due = state.nextReviewAt !== null && state.nextReviewAt <= now ? 2 : 0;
        const untouched = state.status === StudyObjectiveStatus.Unseen ? 1 : 0;
        const fragility = state.status === StudyObjectiveStatus.Fragile ? 3 : state.status === StudyObjectiveStatus.Learning ? 2 : 0;
        const mastery = objectiveMastery(state);
        // The loop is mechanism-first, so in guided mode the "how it works"
        // objectives lead when nothing is known about them yet.
        const foundational = state.attempts === 0 &&
            (objective.type === StudyObjectiveType.Mechanism || objective.type === StudyObjectiveType.Interpretation) ? 2 : 0;

        switch (mode) {
            case StudyMode.Repair:
                return errors * 4 + fragility * 3 + importanceWeight;
            case StudyMode.Scenarios:
                return (state.status === StudyObjectiveStatus.Unseen ? -10 : 0) + importanceWeight + (3 - Math.min(3, Math.round(mastery * 3)));
            case StudyMode.Exam:
                return importanceWeight * 2 + (state.status === StudyObjectiveStatus.Unseen ? -2 : 0);
            case StudyMode.Drill:
                return due * 4 + errors * 2 + importanceWeight;
            default:
                return due * 4 + fragility * 3 + errors * 2 + untouched * 2 + importanceWeight + foundational - Math.round(mastery * 2);
        }
    };

    const ordered: StudyObjective[] = [];
    const remaining = new Set(objectives.map(objective => objective.id));
    const ready = (objective: StudyObjective): boolean => objective.prerequisites.every(id => !remaining.has(id));

    while (remaining.size > 0) {
        const candidates = objectives.filter(objective => remaining.has(objective.id) && ready(objective));
        const pool = candidates.length > 0 ? candidates : objectives.filter(objective => remaining.has(objective.id));
        pool.sort((a, b) => score(b) - score(a));
        const chosen = pool[0];
        ordered.push(chosen);
        remaining.delete(chosen.id);
    }

    // Hard prerequisites outrank the heuristic ordering, so pull any dependent
    // back behind its prerequisite.
    const position = new Map<string, number>();
    ordered.forEach((objective, index) => position.set(objective.id, index));
    for (const objective of ordered) {
        for (const prerequisiteId of objective.prerequisites) {
            const prerequisiteIndex = position.get(prerequisiteId);
            const objectiveIndex = position.get(objective.id);
            if (prerequisiteIndex === undefined || objectiveIndex === undefined) continue;
            if (prerequisiteIndex > objectiveIndex) {
                const [prerequisite] = ordered.splice(prerequisiteIndex, 1);
                ordered.splice(objectiveIndex, 0, prerequisite);
                position.clear();
                ordered.forEach((entry, index) => position.set(entry.id, index));
            }
        }
    }

    return ordered.map(objective => objective.id);
}

/** Keep the most recent provisional suggestions, one per objective. */
export function mergeSuggestions(
    existing: StudyReviewSuggestion[],
    incoming: StudyReviewSuggestion[]
): StudyReviewSuggestion[] {
    const merged = [...existing];
    for (const suggestion of incoming) {
        const index = merged.findIndex(entry => entry.objectiveId === suggestion.objectiveId);
        if (index >= 0) merged[index] = suggestion;
        else merged.push(suggestion);
    }
    return merged.slice(-24);
}
