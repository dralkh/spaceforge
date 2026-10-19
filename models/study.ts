/**
 * Spaceforge Study — data model for the adaptive tutoring system.
 *
 * A study plan is a *chart* of a note: the note broken into atomic learning
 * objectives. It is generated once per note, then kept for the life of the
 * note. Progress is tracked per objective (understanding / retrieval /
 * transfer) and merged into the plan across sessions, so the tutor resumes
 * where the learner actually stopped instead of restarting the topic.
 */

/** Bumped when the shape of persisted study data changes. */
import { StudyVisualPack } from './study-visuals';

export const STUDY_DATA_VERSION = 2;

import type { StudyImageRef } from '../utils/study-media';

export type { StudyImageRef };

/** Maximum stored sessions per note (older sessions are dropped). */
export const STUDY_MAX_SESSIONS_PER_NOTE = 12;

/** Maximum stored transcript turns per session. */
export const STUDY_MAX_TURNS_PER_SESSION = 400;

/**
 * The cognitive operation an objective asks for. Deliberately subject-neutral:
 * every discipline contains some mix of these, so the same engine works for
 * cardiology, contract law, calculus and guitar theory.
 */
export enum StudyObjectiveType {
    /** How something works: cause → step → effect chains. */
    Mechanism = 'mechanism',
    /** A discrete fact, term, name, threshold or definition worth memorising. */
    Fact = 'fact',
    /** Tells two look-alike things apart. */
    Distinction = 'distinction',
    /** Do the thing: solve, compute, produce, execute. */
    Application = 'application',
    /** Read a result, a text, a diagram, a chart, a case and say what it means. */
    Interpretation = 'interpretation',
    /** A sequence of steps with ordering that matters. */
    Procedure = 'procedure',
    /** Judge, argue, evaluate, weigh trade-offs. */
    Critique = 'critique',
    /** Getting it wrong has real, non-academic consequences. */
    Safety = 'safety',
    /** Build, design, compose, write, perform something new. */
    Creative = 'creative',
}

/** How much the objective matters to the point of the note. */
export type StudyImportance = 'critical' | 'high' | 'standard';

/**
 * What actually went wrong. Generic on purpose — the clinical prompt's
 * taxonomy generalises perfectly once "clinical" is removed from each label.
 */
export enum StudyErrorCategory {
    /** Never learned, or a prerequisite that was never available. */
    KnowledgeGap = 'knowledge-gap',
    /** Understood as words, not as a working model — cannot be restated. */
    EncodingGap = 'encoding-gap',
    /** Was understood before, cannot be produced from memory now. */
    RetrievalFailure = 'retrieval-failure',
    /** Two similar things blended together. */
    Discrimination = 'discrimination',
    /** Facts are there, the step of applying them is wrong. */
    ApplicationError = 'application-error',
    /** Qualifying detail, unit, denominator or exception was overlooked. */
    Careless = 'careless',
    /** "I don't know" — a signal, not a verdict; needs one more probe. */
    Uncertain = 'uncertain',
    /** Answered accurately with defensible reasoning. */
    Success = 'success',
}

/** Human-readable labels, used by the UI and the session digest. */
export const STUDY_ERROR_LABELS: Record<StudyErrorCategory, string> = {
    [StudyErrorCategory.KnowledgeGap]: 'Knowledge gap',
    [StudyErrorCategory.EncodingGap]: 'Explanation not internalised',
    [StudyErrorCategory.RetrievalFailure]: 'Recall failure',
    [StudyErrorCategory.Discrimination]: 'Confusion between look-alikes',
    [StudyErrorCategory.ApplicationError]: 'Application error',
    [StudyErrorCategory.Careless]: 'Overlooked a detail',
    [StudyErrorCategory.Uncertain]: 'Not attempted',
    [StudyErrorCategory.Success]: 'Correct',
};

/** Which step of the learning loop the tutor is currently in. */
export enum StudyStage {
    Chart = 'chart',
    Orient = 'orient',
    Teach = 'teach',
    Retrieve = 'retrieve',
    Transfer = 'transfer',
    Diagnose = 'diagnose',
    Remediate = 'remediate',
    Consolidate = 'consolidate',
    Complete = 'complete',
}

/** Stage labels for the live stage rail. */
export const STUDY_STAGE_LABELS: Record<StudyStage, string> = {
    [StudyStage.Chart]: 'Charting',
    [StudyStage.Orient]: 'Orienting',
    [StudyStage.Teach]: 'Explaining',
    [StudyStage.Retrieve]: 'Recall check',
    [StudyStage.Transfer]: 'New situation',
    [StudyStage.Diagnose]: 'Diagnosing',
    [StudyStage.Remediate]: 'Re-teaching',
    [StudyStage.Consolidate]: 'Consolidating',
    [StudyStage.Complete]: 'Complete',
};

/** The order the rail renders stages in. */
export const STUDY_STAGE_ORDER: StudyStage[] = [
    StudyStage.Chart,
    StudyStage.Orient,
    StudyStage.Teach,
    StudyStage.Retrieve,
    StudyStage.Transfer,
    StudyStage.Diagnose,
    StudyStage.Remediate,
    StudyStage.Consolidate,
];

/** How a session is driven. */
export enum StudyMode {
    /** Full map → explain → retrieve → transfer loop, prerequisite order. */
    Guided = 'guided',
    /** Rapid one-question-at-a-time drill with short feedback. */
    Drill = 'drill',
    /** Prioritise recurring errors and prerequisite gaps. */
    Repair = 'repair',
    /** Unseen scenarios across already-learned objectives. */
    Scenarios = 'scenarios',
    /** Block of questions, feedback held back until the end. */
    Exam = 'exam',
}

/** Lifecycle of one objective. */
export enum StudyObjectiveStatus {
    Unseen = 'unseen',
    Learning = 'learning',
    Fragile = 'fragile',
    Stable = 'stable',
    Mastered = 'mastered',
}

/** Grid/review interval (in days) suggested per status. */
export const STUDY_STATUS_REVIEW_DAYS: Record<StudyObjectiveStatus, number> = {
    [StudyObjectiveStatus.Unseen]: 0,
    [StudyObjectiveStatus.Learning]: 1,
    [StudyObjectiveStatus.Fragile]: 1,
    [StudyObjectiveStatus.Stable]: 7,
    [StudyObjectiveStatus.Mastered]: 30,
};

/** One atomic, answerable idea. */
export interface StudyObjective {
    /** Stable id within the plan, e.g. 'obj-3'. */
    id: string;
    /** Short label for the rail (a few words). */
    title: string;
    /** The full one-idea statement that must end up learnable. */
    statement: string;
    /** Which cognitive operation this asks for. */
    type: StudyObjectiveType;
    /** Importance for the point of the note. */
    importance: StudyImportance;
    /** Ids of objectives that should be learned first. */
    prerequisites: string[];
    /** Short verbatim anchors from the note that this objective covers. */
    anchors: string[];
}

/**
 * Progress of the charting job for one note.
 *
 * Charting a long note takes several model calls, so it is resumable: the
 * section list is derived from the note body, and this records which sections
 * have already produced objectives. A run that stops early (closed window,
 * failure, app quit) leaves the work done so far in place.
 */
export interface StudyChartState {
    /** Fingerprint of the note body the section list was computed from. */
    fingerprint: string;
    /** How many sections that body splits into. */
    total: number;
    /** Indices that produced objectives. */
    done: number[];
    /** Indices that failed, with the reason the last attempt gave. */
    failed: { index: number; reason: string }[];
    /** Last time the charting job touched this note. */
    updatedAt: number;
}

/** The chart of a note. Generated once, kept, merged on regeneration. */
export interface StudyPlan {
    notePath: string;
    /** When the chart was first produced. */
    generatedAt: number;
    /** When the plan was last touched (regeneration, merge, domain edit). */
    updatedAt: number;
    /** Model/format version for migrations. */
    version: number;
    /** Hash of the note body the chart was made from; drift detection. */
    contentFingerprint: string;
    /** Detected discipline id — key into the study domain registry. */
    domainId: string;
    /** Display label for the discipline (user-editable). */
    domainLabel: string;
    /** The tutor's subject-specific reasoning notes (user-editable). */
    domainNotes: string;
    /** True once the user has corrected the detected discipline. */
    domainOverriddenByUser: boolean;
    /** Whether mistakes in this subject have real-world cost. */
    safetyCritical: boolean;
    /** One- or two-line statement of what the note is about. */
    topicSummary: string;
    /** The objectives, in prerequisite-friendly order. */
    objectives: StudyObjective[];
    /** Source anchors that could not be turned into objectives. */
    uncoveredSource: string[];
    /** Durable, cross-session observations written by the tutor. */
    tutorMemory: string[];
    /** Figures found in the note, so the panel can preview them. */
    images: StudyImageRef[];
    /** How far the charting job has got through this note. */
    chartState: StudyChartState | null;
    /**
     * The mind map, visual boards and summary generated from this note.
     *
     * Kept beside the chart rather than inside it: a map can be regenerated
     * without touching mastery, and a stale one (the note changed since) is
     * reported rather than silently shown.
     */
    visuals: StudyVisualPack | null;
}

/** Per-objective mastery state. U/R/T are each 0-3. */
export interface ObjectiveProgressState {
    /** Understanding: 0 absent, 1 fragmented, 2 accurate, 3 causal + caveats. */
    U: number;
    /** Retrieval: 0 none, 1 with cue, 2 unaided, 3 unaided and delayed. */
    R: number;
    /** Transfer: 0 none, 1 with coaching, 2 novel case, 3 hard case + limits. */
    T: number;
    /** Self-declared confidence for the last attempt: 1 low, 2 medium, 3 high. */
    confidence: number;
    attempts: number;
    successes: number;
    /** How often each error category has been observed. */
    errorCounts: Partial<Record<StudyErrorCategory, number>>;
    lastSeenAt: number | null;
    lastSuccessAt: number | null;
    /** Local day (YYYY-MM-DD) of the last success — durability needs 2 days. */
    lastSuccessDay: string | null;
    /** Distinct days on which this objective was answered correctly. */
    successfulDays: string[];
    /** When the engine suggests revisiting this objective. */
    nextReviewAt: number | null;
    status: StudyObjectiveStatus;
    /** Short tutor observations, most recent last. */
    observations: string[];
}

/** Persisted progress for one note. */
export interface StudyProgressStore {
    notePath: string;
    updatedAt: number;
    /** Sessions started for this note, completed or not. */
    totalSessions: number;
    completedSessions: number;
    objectives: Record<string, ObjectiveProgressState>;
    /** Durable observations that survive sessions (merged from the tutor). */
    tutorMemory: string[];
    /** Short prose summary of the last session. */
    lastSessionSummary: string | null;
    /** Provisional review suggestions produced by the tutor. */
    scheduleSuggestions: StudyReviewSuggestion[];
}

/** A provisional review suggestion for one objective. */
export interface StudyReviewSuggestion {
    objectiveId: string;
    inDays: number;
    madeAt: number;
    /** Explicitly labelled as provisional in the UI. */
    provisional: true;
}

/** One rendered turn in the transcript. */
export interface StudyTurnRecord {
    id: string;
    role: 'tutor' | 'user' | 'system';
    /** 'explain' | 'question' | 'answer' | 'feedback' | 'research' | 'map' | 'digest'. */
    kind: string;
    text: string;
    objectiveId: string | null;
    stage: StudyStage | null;
    errorCategory: StudyErrorCategory | null;
    correct: boolean | null;
    at: number;
}

/** A finished (or abandoned) study session. */
export interface StudySessionRecord {
    id: string;
    notePath: string;
    mode: StudyMode;
    /** Whether web lookup was enabled for this session. */
    webSearch: boolean;
    startedAt: number;
    endedAt: number | null;
    turnCount: number;
    /** Objective ids touched during the session. */
    objectivesTouched: string[];
    /** Objective ids that reached mastered during the session. */
    objectivesMastered: string[];
    errorCounts: Partial<Record<StudyErrorCategory, number>>;
    transcript: StudyTurnRecord[];
    /** Tutor-written short summary. */
    summary: string | null;
    /** 0-1, computed from this session's objective deltas. */
    score: number | null;
    /** Whether the session ran to a natural conclusion. */
    completed: boolean;
    webLookups: number;
    sources: StudySourceRef[];
}

/** A source the tutor actually retrieved (never model-invented). */
export interface StudySourceRef {
    title: string;
    url: string;
}

/** What the tutor is told about web lookup for the current session. */
export interface StudySearchBackendSummary {
    available: boolean;
    label: string;
    /** Why lookups are unavailable, when they are. */
    reason: string | null;
}

/** A question / instruction the learner must respond to. */
export interface TutorPromptSpec {
    kind: 'question' | 'explain-back' | 'decision' | 'reflect' | 'acknowledge';
    text: string;
    format: 'free' | 'mcq' | 'confidence';
    objectiveId: string | null;
    /** For mcq prompts. */
    choices: string[];
    correctIndex: number | null;
    /** Offered only when the learner asks for a nudge. */
    hint: string | null;
    /** Hidden answer key: what a correct answer must contain. */
    expect: string | null;
    /** 1 (easiest) .. 4 (hardest). */
    difficulty: number;
}

/** The tutor's judgement of the learner's last answer. */
export interface TutorVerdict {
    correct: boolean | null;
    errorCategory: StudyErrorCategory | null;
    /** The precise missing distinction or step. */
    diagnosis: string | null;
    /** Concise causal correction. */
    correction: string | null;
    /** Confidence the learner reported, 1-3, when asked. */
    confidence: number | null;
}

/** Mastery deltas the tutor proposes for one objective. */
export interface TutorProgressUpdate {
    objectiveId: string | null;
    U: number | null;
    R: number | null;
    T: number | null;
    confidence: number | null;
    /** Short durable observations, e.g. 'confuses meiosis with mitosis'. */
    observations: string[];
}

/** A request for the engine to look something up. */
export interface TutorResearchRequest {
    queries: string[];
    reason: string | null;
}

/** Extra signals worth surfacing prominently. */
export interface TutorFlags {
    /** Source and current knowledge disagree — surfaced, never silently fixed. */
    inconsistency: string | null;
    /** Something that must not be misremembered. */
    safetyCritical: string | null;
}

/** Fully parsed model output for a single turn. */
export interface TutorTurn {
    stage: StudyStage;
    objectiveId: string | null;
    /** Markdown shown to the learner. */
    say: string;
    /** Anchors from the note this turn relies on. */
    anchors: string[];
    /** Only trusted when the URL came from a real lookup. */
    sources: StudySourceRef[];
    verdict: TutorVerdict | null;
    progress: TutorProgressUpdate | null;
    next: TutorPromptSpec | null;
    research: TutorResearchRequest | null;
    scheduleSuggestions: StudyReviewSuggestion[];
    sessionComplete: boolean;
    summary: string | null;
    /** New durable observations about the learner. */
    tutorMemory: string[];
    flags: TutorFlags;
    /** Whether the reply parsed as structured protocol or degraded to prose. */
    structured: boolean;
    /** The raw model reply, kept for troubleshooting. */
    raw: string;
}

/**
 * Outcome of one charting run.
 *
 * Charting is incremental, so the caller gets per-section detail: which
 * sections produced objectives, which failed and why, and how much is left for
 * a later run.
 */
export interface StudyChartReport {
    plan: StudyPlan;
    /** Objectives matched to existing ones on a re-chart. */
    kept: number;
    added: number;
    dropped: number;
    /** Sections left uncharted because the objective ceiling was reached. */
    limited?: number;
    /** Per-section results of this run. */
    sections: { index: number; title: string | null; objectives: number; error: string | null }[];
    /** True once every section has been charted. */
    complete: boolean;
    /** Sections still to chart after this run. */
    pending: number;
    /** Figures found in the note. */
    images: number;
    /** Sections that failed in this run. */
    failed: number;
}

/** Session-scoped configuration chosen by the user in the modal. */
export interface StudySessionOptions {
    mode: StudyMode;
    /** Web lookup for this session; seeded from settings, toggleable live. */
    webSearch: boolean;
    /** Max tutor turns before the engine wraps the session up. */
    turnLimit: number;
    /** Start from scratch: ignore prior progress when choosing the order. */
    freshStart: boolean;
}

/** What the session engine emits to the UI. */
export type StudySessionEvent =
    | { type: 'status'; text: string }
    | { type: 'stage'; stage: StudyStage }
    | { type: 'thinking'; active: boolean; label: string }
    | { type: 'turn'; turn: TutorTurn }
    | { type: 'user-turn'; turn: StudyTurnRecord }
    | { type: 'research'; queries: string[]; results: number; done: boolean }
    | { type: 'progress'; objectiveId: string; state: ObjectiveProgressState }
    | { type: 'plan'; plan: StudyPlan }
    | { type: 'digest'; digest: StudyDigest }
    | { type: 'complete'; summary: StudySummaryPayload }
    | { type: 'error'; message: string; detail: string | null };

/** Live snapshot of where the session stands. */
export interface StudyDigest {
    turnCount: number;
    turnLimit: number;
    covered: number;
    totalObjectives: number;
    mastered: number;
    /** Mean of U/R/T across attempted objectives, 0-1. */
    masteryScore: number;
    /** Most frequent error categories this session. */
    errorCounts: Partial<Record<StudyErrorCategory, number>>;
    dueObjectives: { objectiveId: string; overdueDays: number }[];
    nextSuggestions: StudyReviewSuggestion[];
    webLookups: number;
    elapsedMs: number;
}

/** Output handed to the controller when the session ends. */
export interface StudySummaryPayload {
    notePath: string;
    session: StudySessionRecord;
    /** 0-1 session score used to rate the note's schedule. */
    score: number;
    digest: StudyDigest;
    /** Objectives that reached mastered in this session. */
    mastered: string[];
    /** Objectives still fragile, worth an early revisit. */
    fragile: string[];
    /** Markdown suitable for writing into the vault. */
    markdown: string;
}

/** Empty progress state for an objective. */
export function createObjectiveProgress(): ObjectiveProgressState {
    return {
        U: 0,
        R: 0,
        T: 0,
        confidence: 0,
        attempts: 0,
        successes: 0,
        errorCounts: {},
        lastSeenAt: null,
        lastSuccessAt: null,
        lastSuccessDay: null,
        successfulDays: [],
        nextReviewAt: null,
        status: StudyObjectiveStatus.Unseen,
        observations: [],
    };
}

/**
 * Rough mastery score for one objective, 0-1.
 * Weighted towards recall and transfer: understanding alone never counts as
 * durable knowledge.
 */
export function objectiveMastery(state: ObjectiveProgressState): number {
    return (state.U / 3) * 0.25 + (state.R / 3) * 0.4 + (state.T / 3) * 0.35;
}

/**
 * Derive the lifecycle status of an objective from its rubric scores.
 *
 * "mastered" is deliberately hard to reach: it needs a full understanding,
 * unaided recall on two different days, and transfer to a novel case. Anything
 * less stays stable-but-provisional, which is what the evidence supports.
 */
export function deriveObjectiveStatus(state: ObjectiveProgressState): StudyObjectiveStatus {
    if (state.attempts === 0 && state.U === 0) return StudyObjectiveStatus.Unseen;
    if (state.U < 2) return StudyObjectiveStatus.Learning;

    // Recall only counts as durable when it was produced on two different days.
    const durableRecall = state.R >= 2 && state.successfulDays.length >= 2;
    if (state.U >= 3 && durableRecall && state.T >= 2) return StudyObjectiveStatus.Mastered;

    if (state.R >= 2 && state.T >= 1) return StudyObjectiveStatus.Stable;
    return StudyObjectiveStatus.Fragile;
}
