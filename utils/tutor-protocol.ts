/**
 * Parsing and sanitising for the tutor protocol.
 *
 * Language models are unreliable at structured output, and the Study feature
 * fails badly if a good turn is lost to one stray comma. So the parser takes
 * the most optimistic interpretation available at every step:
 *
 *   1. strip code fences and hedge text, find the outermost balanced object
 *   2. parse it; if that fails, repair common damage and parse again
 *   3. coerce every field, clamping numbers and normalising enum words
 *   4. if all of that fails, degrade to plain prose instead of erroring out
 *
 * A turn that parses structurally but contains nonsense is still better than
 * a dead session, so callers should treat `structured: false` as "show the text
 * and re-ask", not as a fatal error.
 */

import {
    StudyErrorCategory,
    StudyImportance,
    StudyObjectiveType,
    StudyStage,
    TutorTurn,
    TutorPromptSpec,
    TutorVerdict,
    TutorProgressUpdate,
    TutorResearchRequest,
    TutorFlags,
    StudySourceRef,
    StudyReviewSuggestion,
} from '../models/study';
import { asBoolValue, asRecordValue, asTextList, asTextValue, clampIntValue, slugify } from './coerce';

/** Find the outermost balanced JSON object in a string. */
export function findJsonObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const char = text[i];

        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (char === '{') depth++;
        else if (char === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

/** Strip code fences and stray prose wrappers around a JSON payload. */
function stripWrappers(text: string): string {
    return text
        .replace(/^\uFEFF/, '')
        .replace(/```(?:json|JSON)?/g, '')
        .replace(/```/g, '')
        .trim();
}

/**
 * Best-effort repairs for the mistakes models actually make.
 *
 * Order matters. Curly quotes that act as *delimiters* are converted to real
 * quotes, but curly quotes inside a string are escaped instead — a blanket
 * replacement would turn `"the “slow” path"` into broken JSON, which is the
 * most common way naive repair makes things worse.
 */
function repairJson(candidate: string): string {
    let out = candidate
        // Trailing commas before a closing brace or bracket.
        .replace(/,{1}\s*([}\]])/g, '$1')
        // Line comments outside strings are rare but fatal when present.
        .replace(/(^|\s)\/\/[^\n"]*$/gm, '');
    out = out
        // Curly quotes wrapping a key.
        .replace(/[\u201C\u201D]([^"\u201C\u201D\n]*)[\u201C\u201D]\s*:/g, '"$1":')
        // Curly quotes wrapping a whole value.
        .replace(/([:,[]\s*)[\u201C\u201D]([^"\u201C\u201D\n]*)[\u201C\u201D]/g, '$1"$2"')
        // Unquoted object keys.
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":')
        // Anything left is quoting inside a string, so escape it — as a unicode
        // escape, which keeps the character itself intact once parsed.
        .replace(/\u201C/g, '\\u201C')
        .replace(/\u201D/g, '\\u201D');
    return out;
}

/** Parse a model reply into a plain object, or null when nothing workable. */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
    if (!text || text.trim().length === 0) return null;
    const cleaned = stripWrappers(text);

    const candidates: string[] = [];
    const objectCandidate = findJsonObject(cleaned);
    if (objectCandidate) candidates.push(objectCandidate);
    if (cleaned.startsWith('{') && cleaned.endsWith('}')) candidates.push(cleaned);

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as unknown;
            if (Array.isArray(parsed)) {
                const first = parsed[0];
                if (first && typeof first === 'object') return first as Record<string, unknown>;
                continue;
            }
            if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
        } catch {
            try {
                const parsed = JSON.parse(repairJson(candidate)) as unknown;
                if (Array.isArray(parsed)) {
                    const first = parsed[0];
                    if (first && typeof first === 'object') return first as Record<string, unknown>;
                    continue;
                }
                if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
            } catch {
                // Try the next candidate.
            }
        }
    }
    return null;
}

const asRecord = asRecordValue;
const asString = asTextValue;
const asStringArray = asTextList;
const clampInt = clampIntValue;
const asBool = asBoolValue;
const slug = slugify;

const STAGE_ALIASES: Record<string, StudyStage> = {
    chart: StudyStage.Chart,
    map: StudyStage.Chart,
    'knowledge-map': StudyStage.Chart,
    orient: StudyStage.Orient,
    intro: StudyStage.Orient,
    teach: StudyStage.Teach,
    explain: StudyStage.Teach,
    explanation: StudyStage.Teach,
    retrieve: StudyStage.Retrieve,
    retrieval: StudyStage.Retrieve,
    recall: StudyStage.Retrieve,
    question: StudyStage.Retrieve,
    quiz: StudyStage.Retrieve,
    transfer: StudyStage.Transfer,
    application: StudyStage.Transfer,
    apply: StudyStage.Transfer,
    'case': StudyStage.Transfer,
    scenario: StudyStage.Transfer,
    diagnose: StudyStage.Diagnose,
    diagnosis: StudyStage.Diagnose,
    feedback: StudyStage.Diagnose,
    remediate: StudyStage.Remediate,
    reteach: StudyStage.Remediate,
    're-teaching': StudyStage.Remediate,
    reteaching: StudyStage.Remediate,
    remediation: StudyStage.Remediate,
    consolidate: StudyStage.Consolidate,
    summary: StudyStage.Consolidate,
    wrap: StudyStage.Consolidate,
    'wrap-up': StudyStage.Consolidate,
    wrapup: StudyStage.Consolidate,
    closing: StudyStage.Consolidate,
    complete: StudyStage.Complete,
    done: StudyStage.Complete,
    finish: StudyStage.Complete,
    finished: StudyStage.Complete,
};

export function parseStage(value: unknown): StudyStage | null {
    const raw = asString(value);
    if (!raw) return null;
    const key = slug(raw);
    if (STAGE_ALIASES[key]) return STAGE_ALIASES[key];
    const direct = (Object.values(StudyStage) as string[]).find(stage => stage === key);
    return (direct as StudyStage | undefined) ?? null;
}

const ERROR_ALIASES: Record<string, StudyErrorCategory> = {
    'knowledge-gap': StudyErrorCategory.KnowledgeGap,
    gap: StudyErrorCategory.KnowledgeGap,
    'never-learned': StudyErrorCategory.KnowledgeGap,
    prerequisite: StudyErrorCategory.KnowledgeGap,
    'prerequisite-gap': StudyErrorCategory.KnowledgeGap,
    'encoding-gap': StudyErrorCategory.EncodingGap,
    encoding: StudyErrorCategory.EncodingGap,
    misunderstanding: StudyErrorCategory.EncodingGap,
    'not-understood': StudyErrorCategory.EncodingGap,
    'retrieval-failure': StudyErrorCategory.RetrievalFailure,
    retrieval: StudyErrorCategory.RetrievalFailure,
    recall: StudyErrorCategory.RetrievalFailure,
    forgetting: StudyErrorCategory.RetrievalFailure,
    forgotten: StudyErrorCategory.RetrievalFailure,
    discrimination: StudyErrorCategory.Discrimination,
    confusion: StudyErrorCategory.Discrimination,
    confused: StudyErrorCategory.Discrimination,
    mixup: StudyErrorCategory.Discrimination,
    'application-error': StudyErrorCategory.ApplicationError,
    application: StudyErrorCategory.ApplicationError,
    'transfer-error': StudyErrorCategory.ApplicationError,
    reasoning: StudyErrorCategory.ApplicationError,
    procedural: StudyErrorCategory.ApplicationError,
    careless: StudyErrorCategory.Careless,
    'context-error': StudyErrorCategory.Careless,
    oversight: StudyErrorCategory.Careless,
    detail: StudyErrorCategory.Careless,
    misread: StudyErrorCategory.Careless,
    uncertain: StudyErrorCategory.Uncertain,
    'dont-know': StudyErrorCategory.Uncertain,
    unknown: StudyErrorCategory.Uncertain,
    skipped: StudyErrorCategory.Uncertain,
    success: StudyErrorCategory.Success,
    correct: StudyErrorCategory.Success,
    mastered: StudyErrorCategory.Success,
};

/**
 * Stems matched against a whole phrase, in priority order.
 *
 * The tutor is asked for a category word but often writes the excuse instead
 * ("I do not know", "kept mixing the two up", "forgot the threshold"), so the
 * exact-match table is followed by this looser pass.
 */
const ERROR_STEMS: [string, StudyErrorCategory][] = [
    ['knowledge', StudyErrorCategory.KnowledgeGap],
    ['prerequisite', StudyErrorCategory.KnowledgeGap],
    ['never-learned', StudyErrorCategory.KnowledgeGap],
    ['encoding', StudyErrorCategory.EncodingGap],
    ['misunderstand', StudyErrorCategory.EncodingGap],
    ['not-understood', StudyErrorCategory.EncodingGap],
    ['retrieval', StudyErrorCategory.RetrievalFailure],
    ['recall', StudyErrorCategory.RetrievalFailure],
    ['forgot', StudyErrorCategory.RetrievalFailure],
    ['forgotten', StudyErrorCategory.RetrievalFailure],
    ['discriminat', StudyErrorCategory.Discrimination],
    ['confus', StudyErrorCategory.Discrimination],
    ['look-alike', StudyErrorCategory.Discrimination],
    ['mix', StudyErrorCategory.Discrimination],
    ['blend', StudyErrorCategory.Discrimination],
    ['application', StudyErrorCategory.ApplicationError],
    ['transfer', StudyErrorCategory.ApplicationError],
    ['applying', StudyErrorCategory.ApplicationError],
    ['reasoning', StudyErrorCategory.ApplicationError],
    ['step', StudyErrorCategory.ApplicationError],
    ['careless', StudyErrorCategory.Careless],
    ['oversight', StudyErrorCategory.Careless],
    ['misread', StudyErrorCategory.Careless],
    ['overlooked', StudyErrorCategory.Careless],
    ['unit', StudyErrorCategory.Careless],
    ['do-not-know', StudyErrorCategory.Uncertain],
    ['dont-know', StudyErrorCategory.Uncertain],
    ['no-idea', StudyErrorCategory.Uncertain],
    ['unsure', StudyErrorCategory.Uncertain],
    ['uncertain', StudyErrorCategory.Uncertain],
    ['blank', StudyErrorCategory.Uncertain],
    ['guessing', StudyErrorCategory.Uncertain],
];

export function parseErrorCategory(value: unknown): StudyErrorCategory | null {
    const raw = asString(value);
    if (!raw) return null;
    const key = slug(raw);
    if (ERROR_ALIASES[key]) return ERROR_ALIASES[key];
    const direct = (Object.values(StudyErrorCategory) as string[]).find(category => category === key);
    if (direct) return direct as StudyErrorCategory;

    for (const [stem, category] of ERROR_STEMS) {
        if (key.includes(stem)) return category;
    }
    // Only after everything else: "correct" must not swallow "incorrect".
    if (!key.includes('incorrect') && (key.includes('success') || key.includes('correct') || key.includes('master'))) {
        return StudyErrorCategory.Success;
    }
    return null;
}

/** Objective-type stems, in priority order (safety and contrast win ties). */
const TYPE_STEMS: [string, StudyObjectiveType][] = [
    ['contraindic', StudyObjectiveType.Safety],
    ['danger', StudyObjectiveType.Safety],
    ['hazard', StudyObjectiveType.Safety],
    ['risk', StudyObjectiveType.Safety],
    ['safety', StudyObjectiveType.Safety],
    ['distinguish', StudyObjectiveType.Distinction],
    ['distinct', StudyObjectiveType.Distinction],
    ['differ', StudyObjectiveType.Distinction],
    ['versus', StudyObjectiveType.Distinction],
    ['contrast', StudyObjectiveType.Distinction],
    ['compare', StudyObjectiveType.Distinction],
    ['procedur', StudyObjectiveType.Procedure],
    ['workflow', StudyObjectiveType.Procedure],
    ['sequence', StudyObjectiveType.Procedure],
    ['step', StudyObjectiveType.Procedure],
    ['order', StudyObjectiveType.Procedure],
    ['applicat', StudyObjectiveType.Application],
    ['appli', StudyObjectiveType.Application],
    ['calculat', StudyObjectiveType.Application],
    ['comput', StudyObjectiveType.Application],
    ['solut', StudyObjectiveType.Application],
    ['deriv', StudyObjectiveType.Application],
    ['practi', StudyObjectiveType.Application],
    ['exercise', StudyObjectiveType.Application],
    ['problem', StudyObjectiveType.Application],
    ['perform', StudyObjectiveType.Application],
    ['interpret', StudyObjectiveType.Interpretation],
    ['identif', StudyObjectiveType.Interpretation],
    ['recogni', StudyObjectiveType.Interpretation],
    ['analy', StudyObjectiveType.Interpretation],
    ['diagnos', StudyObjectiveType.Interpretation],
    ['read', StudyObjectiveType.Interpretation],
    ['evaluat', StudyObjectiveType.Critique],
    ['judgem', StudyObjectiveType.Critique],
    ['judgment', StudyObjectiveType.Critique],
    ['judge', StudyObjectiveType.Critique],
    ['critiqu', StudyObjectiveType.Critique],
    ['argument', StudyObjectiveType.Critique],
    ['argue', StudyObjectiveType.Critique],
    ['justif', StudyObjectiveType.Critique],
    ['trade-off', StudyObjectiveType.Critique],
    ['design', StudyObjectiveType.Creative],
    ['compos', StudyObjectiveType.Creative],
    ['creat', StudyObjectiveType.Creative],
    ['writ', StudyObjectiveType.Creative],
    ['mechanis', StudyObjectiveType.Mechanism],
    ['pathway', StudyObjectiveType.Mechanism],
    ['causal', StudyObjectiveType.Mechanism],
    ['cause', StudyObjectiveType.Mechanism],
    ['process', StudyObjectiveType.Mechanism],
    ['defin', StudyObjectiveType.Fact],
    ['concept', StudyObjectiveType.Fact],
    ['term', StudyObjectiveType.Fact],
    ['fact', StudyObjectiveType.Fact],
];

export function parseObjectiveType(value: unknown): StudyObjectiveType | null {
    const raw = asString(value);
    if (!raw) return null;
    const key = slug(raw);
    const types = Object.values(StudyObjectiveType) as string[];
    if (types.includes(key)) return key as StudyObjectiveType;
    for (const [stem, type] of TYPE_STEMS) {
        if (key.includes(stem)) return type;
    }
    return null;
}

export function parseImportance(value: unknown): StudyImportance {
    const raw = asString(value);
    if (!raw) return 'standard';
    const key = slug(raw);
    if (key === 'critical' || key === 'essential' || key === 'must') return 'critical';
    if (key === 'high' || key === 'important') return 'high';
    return 'standard';
}

function parsePromptSpec(value: unknown, fallbackObjectiveId: string | null): TutorPromptSpec | null {
    const raw = asRecord(value);
    if (!raw) {
        const text = asString(value);
        if (!text) return null;
        return {
            kind: 'question',
            text,
            format: 'free',
            objectiveId: fallbackObjectiveId,
            choices: [],
            correctIndex: null,
            hint: null,
            expect: null,
            difficulty: 2,
        };
    }

    const text = asString(raw.text) ?? asString(raw.question) ?? asString(raw.prompt);
    if (!text) return null;

    const rawKind = slug(asString(raw.kind) ?? 'question');
    const kind: TutorPromptSpec['kind'] =
        rawKind === 'explain-back' || rawKind === 'explainback' || rawKind === 'teachback' || rawKind === 'explain'
            ? 'explain-back'
            : rawKind === 'decision' || rawKind === 'apply' || rawKind === 'application'
                ? 'decision'
                : rawKind === 'reflect' || rawKind === 'reflection' || rawKind === 'confidence'
                    ? 'reflect'
                    : rawKind === 'acknowledge' || rawKind === 'ack'
                        ? 'acknowledge'
                        : 'question';

    const choices = asStringArray(raw.choices ?? raw.options);
    const declaredFormat = slug(asString(raw.format) ?? '');
    const format: TutorPromptSpec['format'] =
        choices.length >= 2 ? 'mcq' : declaredFormat === 'mcq' ? 'free' : declaredFormat === 'confidence' ? 'confidence' : 'free';

    let correctIndex = clampInt(raw.correctIndex ?? raw.correct ?? raw.answerIndex, -1, Math.max(choices.length - 1, 0));
    if (correctIndex !== null && correctIndex < 0) correctIndex = null;

    return {
        kind: choices.length >= 2 ? 'question' : kind,
        text,
        format,
        objectiveId: asString(raw.objectiveId ?? raw.objective) ?? fallbackObjectiveId,
        choices,
        correctIndex: correctIndex !== null && correctIndex < choices.length ? correctIndex : null,
        hint: asString(raw.hint),
        expect: asString(raw.expect ?? raw.answerKey ?? raw.criteria),
        difficulty: clampInt(raw.difficulty, 1, 4) ?? 2,
    };
}

function parseVerdict(value: unknown): TutorVerdict | null {
    const raw = asRecord(value);
    if (!raw) return null;
    const correct = asBool(raw.correct ?? raw.isCorrect ?? raw.verdictCorrect);
    const errorCategory = parseErrorCategory(raw.errorCategory ?? raw.error ?? raw.category ?? raw.type);
    return {
        correct: correct ?? (errorCategory ? errorCategory === StudyErrorCategory.Success : null),
        errorCategory,
        diagnosis: asString(raw.diagnosis ?? raw.missing ?? raw.gap),
        correction: asString(raw.correction ?? raw.fix ?? raw.reteach),
        confidence: clampInt(raw.confidence, 1, 3),
    };
}

function parseProgressUpdate(value: unknown, fallbackObjectiveId: string | null): TutorProgressUpdate | null {
    const raw = asRecord(value);
    if (!raw) return null;
    return {
        objectiveId: asString(raw.objectiveId ?? raw.objective ?? raw.id) ?? fallbackObjectiveId,
        U: clampInt(raw.U ?? raw.understanding, 0, 3),
        R: clampInt(raw.R ?? raw.retrieval, 0, 3),
        T: clampInt(raw.T ?? raw.transfer, 0, 3),
        confidence: clampInt(raw.confidence, 1, 3),
        observations: asStringArray(raw.observations ?? raw.notes).slice(0, 4),
    };
}

function parseResearch(value: unknown): TutorResearchRequest | null {
    const raw = asRecord(value);
    if (!raw) {
        const direct = asStringArray(value);
        return direct.length > 0 ? { queries: direct.slice(0, 3), reason: null } : null;
    }
    const needed = asBool(raw.needed ?? raw.required);
    const queries = asStringArray(raw.queries ?? raw.query ?? raw.search).slice(0, 3);
    if (needed === false && queries.length === 0) return null;
    if (queries.length === 0) return null;
    return { queries, reason: asString(raw.reason ?? raw.why) };
}

function parseSources(value: unknown): StudySourceRef[] {
    if (!Array.isArray(value)) return [];
    const refs: StudySourceRef[] = [];
    for (const entry of value) {
        const record = asRecord(entry);
        if (record) {
            const url = asString(record.url ?? record.link);
            if (!url) continue;
            refs.push({ title: asString(record.title ?? record.name) ?? url, url });
            continue;
        }
        const text = asString(entry);
        if (text && /^https?:\/\//i.test(text)) refs.push({ title: text, url: text });
    }
    return refs.slice(0, 8);
}

function parseScheduleSuggestions(value: unknown, fallbackObjectiveId: string | null): StudyReviewSuggestion[] {
    if (!Array.isArray(value)) return [];
    const now = Date.now();
    const suggestions: StudyReviewSuggestion[] = [];
    for (const entry of value) {
        const record = asRecord(entry);
        if (!record) continue;
        const inDays = clampInt(record.inDays ?? record.days ?? record.interval, 0, 365);
        if (inDays === null) continue;
        suggestions.push({
            objectiveId: asString(record.objectiveId ?? record.objective ?? record.id) ?? fallbackObjectiveId ?? '',
            inDays,
            madeAt: now,
            provisional: true,
        });
    }
    return suggestions.filter(s => s.objectiveId.length > 0).slice(0, 8);
}

/** Extract free-text fallback from a reply that carried no usable structure. */
function salvageProse(text: string): string {
    return stripWrappers(text)
        .replace(/^\s*(?:here(?:'s| is)[^\n]*)\n?/i, '')
        .trim();
}

/**
 * Coerce a raw model reply into a TutorTurn.
 *
 * Never throws and never returns null: an unparseable reply becomes a prose
 * turn with `structured: false` so the session can recover.
 */
export function parseTutorTurn(text: string, fallbackObjectiveId: string | null = null): TutorTurn {
    const parsed = parseJsonLoose(text);
    const emptyFlags: TutorFlags = { inconsistency: null, safetyCritical: null };

    if (!parsed) {
        return {
            stage: StudyStage.Teach,
            objectiveId: fallbackObjectiveId,
            say: salvageProse(text),
            anchors: [],
            sources: [],
            verdict: null,
            progress: null,
            next: null,
            research: null,
            scheduleSuggestions: [],
            sessionComplete: false,
            summary: null,
            tutorMemory: [],
            flags: emptyFlags,
            structured: false,
            raw: text,
        };
    }

    const objectiveId = asString(parsed.objectiveId ?? parsed.objective ?? parsed.objective_id) ?? fallbackObjectiveId;
    const flags = asRecord(parsed.flags);
    const say = asString(parsed.say ?? parsed.text ?? parsed.message ?? parsed.explanation) ?? salvageProse(text);

    return {
        stage: parseStage(parsed.stage ?? parsed.phase) ?? StudyStage.Teach,
        objectiveId,
        say,
        anchors: asStringArray(parsed.anchors ?? parsed.sourceAnchors).slice(0, 6),
        sources: parseSources(parsed.sources),
        verdict: parseVerdict(parsed.verdict),
        progress: parseProgressUpdate(parsed.progress, objectiveId),
        next: parsePromptSpec(parsed.next ?? parsed.question ?? parsed.prompt, objectiveId),
        research: parseResearch(parsed.research),
        scheduleSuggestions: parseScheduleSuggestions(parsed.scheduleSuggestions ?? parsed.review, objectiveId),
        sessionComplete: asBool(parsed.sessionComplete ?? parsed.complete ?? parsed.done) ?? false,
        summary: asString(parsed.summary),
        tutorMemory: asStringArray(parsed.tutorMemory ?? parsed.memory ?? parsed.observations).slice(0, 4),
        flags: {
            inconsistency: asString(flags?.inconsistency ?? parsed.inconsistency),
            safetyCritical: asString(flags?.safetyCritical ?? parsed.safetyCritical ?? parsed.safety),
        },
        structured: true,
        raw: text,
    };
}
