import {
    ObjectiveProgressState,
    StudyDigest,
    StudyMode,
    StudyObjective,
    StudyObjectiveStatus,
    StudyPlan,
    StudyProgressStore,
    StudySearchBackendSummary,
    TutorPromptSpec,
} from '../models/study';
import { StudyDomainProfile, describeDomain, getDomainProfile } from '../models/study-domains';
import { SpaceforgeSettings, StudyExpertise } from '../models/settings';
import { ChatMessage } from '../api/chat-client';
import { StudyImageRef, describeImagesForPrompt, markImageLines } from '../utils/study-media';

/**
 * Prompt construction for the Study tutor.
 *
 * Three things make this work across disciplines without a prompt per subject:
 *
 * 1. The *pedagogy* is fixed and lives here — the loop, the rubric, the error
 *    taxonomy, the adaptation rules. Models are good at following a procedure
 *    and bad at inventing one, so we never ask them to invent it.
 * 2. The *subject* is a swappable adapter (see models/study-domains.ts) that
 *    changes what "mechanism", "unseen case" and "characteristic mistake" mean.
 * 3. The *state* is re-sent as structured data every turn rather than relying
 *    on the conversation history, so a small local model with a short context
 *    still adapts correctly to what the learner got wrong three sessions ago.
 */

/** Inputs for the ongoing tutor prompt. */
export interface TutorPromptContext {
    plan: StudyPlan;
    progress: StudyProgressStore;
    mode: StudyMode;
    webSearch: boolean;
    /** Backend description shown to the tutor so it knows what it can ask for. */
    searchBackend: StudySearchBackendSummary;
    /** The prompt the learner is currently answering, if any. */
    pendingPrompt: TutorPromptSpec | null;
    /** The learner's latest answer, or null on the opening turn. */
    learnerAnswer: string | null;
    /** Digest of the note's content, sized to the model's context. */
    sourceDigest: string;
    /** Figures in the note, which the tutor may point at but not describe. */
    images: StudyImageRef[];
    /** Objective ids in the order the engine wants them worked through. */
    focusOrder: string[];
    /** Recent turns, oldest first, already trimmed. */
    recentTurns: { role: 'tutor' | 'user'; text: string; objectiveId: string | null }[];
    /** Research results fetched for this turn, if any. */
    researchBlock: string | null;
    /** Set when the engine needs the tutor to close the session out. */
    wrapUp: boolean;
    /** Set when the previous reply failed to parse. */
    protocolRepair: boolean;
    settings: SpaceforgeSettings;
}

const MODE_INSTRUCTIONS: Record<StudyMode, string> = {
    [StudyMode.Guided]:
        'Mode: guided. Establish the mechanism first, then check recall, then transfer. One idea per turn. ' +
        'If the learner is accurate and can justify it, move forward; if not, fix that one thing before moving on.',
    [StudyMode.Drill]:
        'Mode: rapid drill. Ask one short question per turn with brief feedback. Keep explanations to a sentence or two ' +
        'unless the learner asks for more. Raise difficulty after two clean answers in a row, lower it after two misses.',
    [StudyMode.Repair]:
        'Mode: repair. Lead with the objectives that have the worst error history and with their unmet prerequisites. ' +
        'Prefer explicit A-versus-B contrasts and short re-teaching before every re-test.',
    [StudyMode.Scenarios]:
        'Mode: unseen situations. Work only through transfer tasks: situations the learner has not seen that require a ' +
        'decision and a justification. Never ask a recall question that has no new context.',
    [StudyMode.Exam]:
        'Mode: exam block. Ask questions only, without teaching between them. Keep your own verdicts terse; the learner ' +
        'will see the full feedback at the end of the block. Do not hint.',
};

/**
 * The static half of the system prompt: mission, loop, rubric, taxonomy,
 * adaptation rules and question design. Subject-neutral by construction.
 */
const CORE_SYSTEM = `You are the tutor inside Spaceforge, a note-taking plugin. A learner has asked you to take one note and actually teach it to them, from confused to competent, in small pieces, until they can use it.

MISSION
Maximum durable competence per minute. Not exposure, not flattery, not a longer summary. You are the controller of the learning loop and you decide what happens next on the basis of evidence you have actually observed in this conversation.

THE LOOP
chart (already done for you) → teach one piece → check recall → apply to something new → diagnose what went wrong → adapt → consolidate.
Never teach a second idea before the first has survived a recall attempt. One question per turn. Wait for the answer.

OBJECTIVES
The objective list in the state block is the chart of the note. Work through it. Only work on listed objectives; if the learner asks something adjacent, answer in one sentence and come back to the plan.
Respect prerequisites: if an objective keeps failing, the real problem is usually its prerequisite, so drop down to that instead of repeating yourself.

MASTERY RUBRIC (score only from observed evidence, never from politeness or familiarity)
U understanding: 0 absent · 1 fragmented · 2 an accurate explanation in the learner's own words · 3 causal/structural explanation that includes the limits and main caveats.
R retrieval: 0 cannot produce it · 1 only after a cue · 2 unaided, immediate · 3 unaided, and recalled again on an earlier day (credit this from the state block, not from this turn).
T transfer: 0 cannot apply it · 1 applies it with heavy coaching · 2 solves a straightforward unseen case · 3 solves a hard unseen case and can compare alternatives.
Never raise R above 2 from a single turn. Never score U or T from an answer that was merely recognised. If nothing was tested, do not change any score.

ERROR TAXONOMY — classify the primary cause, not the symptom
knowledge-gap: never learned, or a prerequisite that was never in place.
encoding-gap: the words are there but the model behind them is not; the learner cannot restate or explain it.
retrieval-failure: understood before and demonstrably explainable, but cannot be produced from memory now.
discrimination: two look-alike things blended together.
application-error: the facts are present but the step of using them is wrong.
careless: a qualifying detail, unit, condition or exception was overlooked.
uncertain: the learner said they do not know. Not a verdict — probe once, narrowly, then decide between knowledge-gap and retrieval-failure.
success: accurate and justified.
A correct answer with wrong reasoning is not success. Say so, plainly and without drama.

ADAPTATION
Accurate, justified, reasonably confident: move on, harder context, set a longer review interval.
Accurate but hesitant or lucky: probe once more from a different angle; keep it fragile.
Missed by recall: give the minimum cue, then re-test later in the session, and shorten the review interval.
Missed by understanding: re-teach with a different model or analogy, then ask for a teach-back.
Missed by discrimination: put the two things side by side explicitly, then use a new case.
Repeated failure: split into prerequisite micro-ideas, drop difficulty, work back up.
Change difficulty one step at a time. No trick questions, no ambiguity, no false certainty.

QUESTION DESIGN
Use a mix: causal why/how; exact criteria, thresholds, units and exceptions; compare and contrast of look-alikes; one-step interpretation of a result, text or dataset; transfer to a new situation with a decision; occasionally nothing at all — ask the learner to explain it back.
Prefer free recall over multiple choice. Use multiple choice only to separate two confusable alternatives. When you ask, also write the answer key you will grade against (the "expect" field) — it is never shown to the learner.
Ask for the reason as well as the answer. Protect denominators, units, conditions and exceptions in any numeric fact.

HONESTY
You are a generated tutor and can be wrong. Never present a claim as certain when it is contested. Never invent sources, statistics, dates or quotes — a URL is only legitimate if it came back from a lookup. Never infer general ability from a few answers. If the source material contradicts current knowledge, flag it as an inconsistency instead of quietly replacing it.

DIMENSIONS OF THE SOURCE
This is a note in someone's own vault, so it may be partial, opinionated or simply a set of prompts rather than a textbook: teach what it says, flag what is missing or wrong, and never pad the objectives with facts the note does not contain.

TONE
Direct, specific, unsentimental, respectful. No motivational filler, no praise for guessing, no long preambles. Teach in short units: at most about 150 words of explanation per turn unless the learner explicitly asks for more.`;

/**
 * The output contract. Kept as a single literal object example because models
 * follow examples far more reliably than schema prose.
 */
const PROTOCOL = `OUTPUT PROTOCOL
Reply with exactly one JSON object and nothing else — no markdown fence, no commentary before or after.

{
  "stage": "teach|retrieve|transfer|diagnose|remediate|consolidate|complete",
  "objectiveId": "obj-3",
  "say": "markdown shown to the learner for this turn",
  "anchors": ["short verbatim snippet from the note this turn relies on"],
  "verdict": { "correct": true, "errorCategory": "success", "diagnosis": "the precise missing distinction", "correction": "one-sentence causal correction" },
  "progress": { "objectiveId": "obj-3", "U": 2, "R": 1, "T": 0, "confidence": 2, "observations": ["confuses X with Y"] },
  "next": { "kind": "question|explain-back|decision|reflect", "text": "what you ask the learner", "format": "free|mcq|confidence", "choices": ["A","B","C","D"], "correctIndex": 0, "expect": "answer key used to grade the next reply", "hint": "one nudge, only shown if the learner asks for help", "difficulty": 2 },
  "research": { "needed": false, "queries": [], "reason": "" },
  "scheduleSuggestions": [{ "objectiveId": "obj-3", "inDays": 3 }],
  "tutorMemory": ["durable observation worth keeping about this learner"],
  "flags": { "inconsistency": null, "safetyCritical": null },
  "sessionComplete": false,
  "summary": "required only when sessionComplete is true"
}

Rules for the object:
- Omit or null out any field that does not apply; do not invent placeholder content for it.
- "say" is required on every turn. No answer keys, no grading notes and no meta-commentary inside "say".
- "next" is required unless sessionComplete is true.
- "verdict" is required whenever the learner just made an attempt, including "I don't know".
- Score "progress" only for the objective this turn was about.
- Set "sessionComplete" to true with a "summary" when every objective has been recalled unaided at least once and applied at least once, or when the learner says they are finished, or when told to wrap up.`;

/** Everything the model needs to know about its own five-can't-be-wrong limits. */
function describeSearchBackend(searchBackend: StudySearchBackendSummary): string {
    if (searchBackend.available) {
        return `Web lookup: available this session through ${searchBackend.label}. To use it, set research.needed to true with up to 3 queries and stop your turn — you will get the results back and then continue. Ask for a lookup when the mechanistic or empirical detail matters and you are not certain, or when the note conflicts with what you believe is current. Only URLs that come back from a lookup may appear in "sources".`;
    }
    return 'Web lookup: OFF for this session. You cannot verify anything externally. Where you are not certain about a mechanism, a current value or a contested claim, say so plainly inside "say" and mark it as unverified. Do not guess, and do not cite anything at all.';
}

/** Compress the objective list and its mastery state into a compact table. */
function buildStateBlock(ctx: TutorPromptContext): string {
    const { plan, progress } = ctx;
    const rows: string[] = [];

    for (const objective of plan.objectives) {
        const state = progress.objectives[objective.id];
        const mastery = state ? `U${state.U} R${state.R} T${state.T}` : 'U0 R0 T0';
        const status = state?.status ?? StudyObjectiveStatus.Unseen;
        const errors = state
            ? Object.entries(state.errorCounts)
                .filter(([category]) => category !== 'success')
                .map(([category, count]) => `${category}×${count}`)
                .join(', ')
            : '';
        const anchors = objective.anchors.length > 0 ? ` | anchors: ${objective.anchors.slice(0, 2).join(' / ')}` : '';
        const prerequisites = objective.prerequisites.length > 0 ? ` | after: ${objective.prerequisites.join(',')}` : '';
        const due = state?.nextReviewAt && state.nextReviewAt <= Date.now() ? ' | REVIEW DUE' : '';

        rows.push(
            `- ${objective.id} [${objective.type}${objective.importance === 'standard' ? '' : `,${objective.importance}`}] ${objective.title} — ${objective.statement}` +
            ` | ${mastery} | ${status}${errors ? ` | errors: ${errors}` : ''}${prerequisites}${due}${anchors}`
        );
    }

    const memory = progress.tutorMemory.length > 0
        ? `\nWhat you already learned about this learner (from earlier sessions):\n${progress.tutorMemory.map(line => `- ${line}`).join('\n')}`
        : '';

    const focus = ctx.focusOrder.length > 0
        ? `\nSuggested order for this session: ${ctx.focusOrder.slice(0, 10).join(' → ')}${ctx.focusOrder.length > 10 ? ' → …' : ''}\nFollow this order unless the learner's answers clearly justify a different move, and say why if you deviate.`
        : '';

    return `STATE
Note: ${plan.notePath}
Subject: ${plan.domainLabel}${plan.safetyCritical ? ' (mistakes here have real-world consequences)' : ''}
What this note is: ${plan.topicSummary}
Objectives (${plan.objectives.length}):${plan.uncoveredSource.length > 0 ? ` (not yet charted: ${plan.uncoveredSource.slice(0, 4).join('; ')})` : ''}
${rows.join('\n')}${focus}${memory}`;
}

/** Compress the recent conversation so history does not have to be resent. */
function buildHistoryBlock(ctx: TutorPromptContext): string {
    if (ctx.recentTurns.length === 0) return '';
    const lines = ctx.recentTurns.map(turn =>
        `${turn.role === 'tutor' ? 'TUTOR' : 'LEARNER'}${turn.objectiveId ? ` (${turn.objectiveId})` : ''}: ${turn.text.slice(0, 700)}`
    );
    return `\nRECENT EXCHANGE (most recent last)\n${lines.join('\n')}`;
}

/** What the learner still has to answer, including the hidden answer key. */
function buildPendingBlock(ctx: TutorPromptContext): string {
    if (!ctx.pendingPrompt) {
        return '\nTHE LEARNER HAS NOT ANSWERED YET: this is the opening turn. Orient them in two sentences at most and begin with the first prerequisite-ready objective. Do not lecture.';
    }
    const prompt = ctx.pendingPrompt;
    const parts = [
        `\nYOU LAST ASKED (${prompt.objectiveId ?? 'no objective'})`,
        prompt.text,
    ];
    if (prompt.expect) parts.push(`Answer key you wrote for it: ${prompt.expect}`);
    if (ctx.learnerAnswer === null) {
        parts.push('The learner has not answered yet. Continue from here.');
    } else {
        parts.push(`\nTHE LEARNER ANSWERED\n${ctx.learnerAnswer}`);
    }
    return parts.join('\n');
}

/** The wrap-up request used when the turn limit is reached. */
function buildWrapUpBlock(ctx: TutorPromptContext): string {
    if (!ctx.wrapUp) return '';
    return `\nWRAP UP NOW: the session is at its turn limit. Diagnose the last answer briefly, then produce the closing turn: what is solid, what is fragile, the error pattern, what to study next, and a provisional review plan in "scheduleSuggestions". Set sessionComplete to true and write "summary". Do not ask another question.`;
}

function buildResearchBlock(ctx: TutorPromptContext): string {
    if (!ctx.researchBlock) return '';
    return `\nLOOKUP RESULTS (these are the only citable sources; ignore any that are irrelevant)\n${ctx.researchBlock}`;
}

function buildModeBlock(ctx: TutorPromptContext): string {
    const mode = MODE_INSTRUCTIONS[ctx.mode];
    const expertise = ctx.settings.studyExpertise;
    let expertiseLine: string;
    switch (expertise) {
        case StudyExpertise.Beginner:
            expertiseLine = 'Assume no background: define terms before using them, and use the smallest possible examples.';
            break;
        case StudyExpertise.Intermediate:
            expertiseLine = 'Assume working familiarity: skip basic definitions unless an answer shows they are missing.';
            break;
        case StudyExpertise.Advanced:
            expertiseLine = 'Assume strong background: go straight to the hard cases, limits and trade-offs.';
            break;
        default:
            expertiseLine = 'Start intermediate and let the first answers move the level up or down.';
    }

    const segments = [mode, expertiseLine];
    const language = ctx.settings.studyLanguage?.trim();
    segments.push(
        language
            ? `Language: teach in ${language}. Keep established technical terms in their original form.`
            : 'Language: match the language of the note. Keep established technical terms in their original form.'
    );
    return `\n${segments.join(' ')}`;
}

/** Footer that changes what the model is asked to do right now. */
function buildTask(ctx: TutorPromptContext): string {
    if (ctx.protocolRepair) {
        return '\nTASK: your previous reply could not be parsed. Reply with only the JSON object described in the protocol, with no other text.';
    }
    if (ctx.wrapUp) {
        return '\nTASK: reply with the closing turn as JSON.';
    }
    return '\nTASK: reply with the next turn as JSON.';
}

/** Assemble the full system prompt for one turn. */
export function buildTutorSystemPrompt(ctx: TutorPromptContext, domainProfile?: StudyDomainProfile): string {
    const profile = domainProfile ?? getDomainProfile(ctx.plan.domainId);
    const blocks = [
        CORE_SYSTEM,
        `\nSUBJECT ADAPTER (this replaces the assumptions you would normally make about a subject)\n${describeDomain(profile, ctx.plan.domainNotes)}`,
        buildModeBlock(ctx),
        `\n${describeSearchBackend(ctx.searchBackend)}`,
        `\n${PROTOCOL}`,
    ];
    return blocks.join('\n');
}

/** Assemble the user message for one turn. */
export function buildTutorUserPrompt(ctx: TutorPromptContext): string {
    const blocks = [
        buildStateBlock(ctx),
        `\nSOURCE EXTRACT\n${ctx.sourceDigest}`,
        `\n${describeImagesForPrompt(ctx.images)}`,
        buildHistoryBlock(ctx),
        buildPendingBlock(ctx),
        buildResearchBlock(ctx),
        buildWrapUpBlock(ctx),
        buildTask(ctx),
    ];
    return blocks.filter(block => block.trim().length > 0).join('\n');
}

/** Charting call: break a note into objectives. */
export function buildChartSystemPrompt(settings: SpaceforgeSettings): string {
    const language = settings.studyLanguage?.trim();
    return `You chart study material. You turn a piece of a note into atomic learning objectives: one answerable idea each, no padding, no repetition, and no facts the text does not contain.

Each objective has:
- title: a few words, for a sidebar list
- statement: one sentence stating exactly what must be learnable ("Explain why …", "Distinguish … from …", "Given …, decide …")
- type: mechanism | fact | distinction | application | interpretation | procedure | critique | safety | creative
- importance: critical | high | standard (relative to the point of the note, not to the world)
- prerequisites: titles of objectives that should be learned first (may be empty)
- anchors: 1-4 snippets copied character-for-character out of the text (never paraphrased, retyped or reworded — they are used to locate the passage), so nothing is silently lost

Also report, for the whole call:
- domain: one of general, medicine, life-sciences, physical-sciences, mathematics, statistics-data, computing, engineering, law, business, social-sciences, history-humanities, language, arts-media, philosophy-argument, procedural
- domainNotes: one or two sentences on how this specific subject should be taught (what counts as a mechanism here, what a good test looks like). Be concrete, not generic.
- topicSummary: one or two sentences on what the material is about
- uncovered: strings listing source content you could not turn into an objective
- tutorMemory: empty array on a first chart

Figures: the note contains images you cannot see. They appear in the text as [figure: name] markers and are listed for you below. Never describe or interpret a picture. When a figure carries the point of a section, write an objective that asks the learner to interpret or reproduce it and name the figure precisely ("Interpret the ECG strip in ACS_1e9fc8e5_img.jpg and state which lead shows the change").

Reply with exactly one JSON object, no markdown fence and no commentary, in the shape:
{ "domain": "...", "domainNotes": "...", "topicSummary": "...", "objectives": [ { "title": "...", "statement": "...", "type": "...", "importance": "...", "prerequisites": [], "anchors": [] } ], "uncovered": [], "tutorMemory": [] }

Produce at most ${Math.max(4, Math.min(40, settings.studyMaxObjectives || 12))} objectives for the whole note. Merge anything that is really one idea. Prefer a mechanism objective plus the two or three consequences worth being able to recall, over a list of every noun in the text.${language ? ` Write titles and statements in ${language}.` : ' Write titles and statements in the language of the source text.'}`;
}

/**
 * Charting call for a note the tutor has already charted before.
 *
 * The previous chart is included so the model updates it instead of starting
 * over, which is what keeps mastery attached to the right objectives.
 */
export function buildChartUserPrompt(
    noteTitle: string,
    chunk: string,
    chunkIndex: number,
    chunkCount: number,
    previousObjectives: StudyObjective[],
    sectionTitle?: string | null,
    images: StudyImageRef[] = [],
    objectiveBudget = 0
): string {
    const previous = previousObjectives.length > 0
        ? `\nThe note was charted before with these objectives. Reuse a title and statement verbatim when the idea is unchanged, so the learner keeps the mastery they earned:\n${previousObjectives.map(o => `- ${o.title} — ${o.statement}`).join('\n')}`
        : '';
    // When one section of a long note is charted on its own, the whole-note
    // ceiling in the system prompt is meaningless — a section must not try to
    // spend the entire allowance, or one part produces fifty objectives and
    // the call takes minutes.
    const budget = objectiveBudget > 0
        ? `\nThis part is worth at most ${objectiveBudget} objective${objectiveBudget === 1 ? '' : 's'} — a hard limit, not a target to reach. If it holds more ideas than that, keep the ${objectiveBudget} the learner would be worst off not knowing and leave the rest; other parts of the note are charted separately.`
        : '';
    const position = chunkCount > 1
        ? `\nThis is part ${chunkIndex + 1} of ${chunkCount}${sectionTitle ? ` (section: ${sectionTitle})` : ''}. Chart only what is in this part; ignore that it continues beyond it — later parts are charted separately.${budget}`
        : '';
    const figures = images.length > 0 ? `\n\n${describeImagesForPrompt(images)}` : '';
    return `Note: ${noteTitle}${position}${previous}${figures}\n\n---\n${chunk}`;
}

/** Sent when the previous reply could not be parsed at all. */
export function buildProtocolRepairMessage(): string {
    return 'Your last reply was not a single valid JSON object. Reply again with only the JSON object, starting with { and ending with }, with escaped quotes and no trailing commas.';
}

/** Opening message for the very first chart call on a note. */
export function buildChartOpeningMessage(): string {
    return 'Chart the note above into learning objectives and reply with the JSON object only.';
}

/** Assemble the message array for a chart request. */
export function buildChartMessages(
    settings: SpaceforgeSettings,
    noteTitle: string,
    noteContent: string,
    chunkIndex: number,
    chunkCount: number,
    previousObjectives: StudyObjective[],
    sectionTitle: string | null = null,
    images: StudyImageRef[] = [],
    objectiveBudget = 0
): ChatMessage[] {
    return [
        { role: 'system', content: buildChartSystemPrompt(settings) },
        {
            role: 'user',
            content: buildChartUserPrompt(noteTitle, noteContent, chunkIndex, chunkCount, previousObjectives, sectionTitle, images, objectiveBudget),
        },
    ];
}

/** Assemble the message array for a tutor turn. */
export function buildTutorMessages(ctx: TutorPromptContext): ChatMessage[] {
    return [
        { role: 'system', content: buildTutorSystemPrompt(ctx) },
        { role: 'user', content: buildTutorUserPrompt(ctx) },
    ];
}

/** One slice of a note, as charted by one model call. */
export interface ChartSection {
    /** 0-based, stable for a given note body. */
    index: number;
    /** 1-based line range in the note, used to place figures and anchors. */
    startLine: number;
    endLine: number;
    /** The text sent for charting, with image lines reduced to markers. */
    text: string;
    /** First heading in the slice, for progress messages. */
    title: string | null;
    /** Figures inside this slice. */
    images: StudyImageRef[];
    /** Full-note count of sections, so progress can say "3 of 12". */
    total: number;
}

/**
 * Split a note into chart-sized sections, preferring heading boundaries.
 *
 * Every section is returned: there is deliberately no cap here, because a cap
 * that silently folds the tail into a truncated chunk loses material the
 * learner would never know was missing. Callers decide how many sections to
 * process in one run, which is what makes background charting resumable
 * instead of all-or-nothing.
 */
export function buildChartSections(
    content: string,
    images: StudyImageRef[],
    maxChars = 6000
): ChartSection[] {
    const lines = content.split('\n');
    const marked = markImageLines(content, images).split('\n');
    const slices: { startLine: number; endLine: number; lines: string[] }[] = [];
    let current: string[] = [];
    let currentStart = 1;
    let currentLength = 0;

    const flush = (endLine: number): void => {
        if (current.length > 0) {
            slices.push({ startLine: currentStart, endLine, lines: current });
            current = [];
            currentLength = 0;
        }
    };

    for (let i = 0; i < marked.length; i++) {
        const line = marked[i];
        const lineNumber = i + 1;
        const isHeading = /^#{1,6}\s/.test(line);
        // Start a new section at a heading once the current one is reasonably
        // full, so sections follow the author's structure where possible.
        if (isHeading && currentLength > maxChars * 0.6) flush(lineNumber - 1);
        if (current.length === 0) currentStart = lineNumber;
        current.push(line);
        currentLength += line.length + 1;
        if (currentLength >= maxChars * 1.5) {
            // A very long run without headings (tables, transcripts): cut on
            // the last blank line so a table is not split mid-row.
            let cut = current.length - 1;
            for (let j = current.length - 1; j > current.length / 2; j--) {
                if (current[j].trim() === '') { cut = j; break; }
            }
            const kept = current.slice(0, cut + 1);
            const remainder = current.slice(cut + 1);
            slices.push({ startLine: currentStart, endLine: currentStart + kept.length - 1, lines: kept });
            current = remainder;
            currentStart = currentStart + kept.length;
            currentLength = remainder.reduce((sum, l) => sum + l.length + 1, 0);
        }
    }
    flush(lines.length);

    const total = slices.length;
    return slices.map((slice, index) => {
        const firstHeading = slice.lines.find(line => /^#{1,6}\s/.test(line));
        return {
            index,
            startLine: slice.startLine,
            endLine: slice.endLine,
            text: slice.lines.join('\n').trim(),
            title: firstHeading ? firstHeading.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').trim() : null,
            images: images.filter(image => image.line >= slice.startLine && image.line <= slice.endLine),
            total,
        };
    }).filter(section => section.text.length > 0);
}

/**
 * Build the source extract sent with each turn.
 *
 * A short note goes in whole. A long one is reduced to its headings plus a
 * window of text around each active anchor, which keeps the prompt small
 * without hiding the part of the note the tutor actually needs.
 */
export function buildSourceDigest(content: string, objectives: StudyObjective[], activeObjectiveId: string | null, budget = 6000): string {
    const trimmed = content.trim();
    if (trimmed.length <= budget) return trimmed;

    const headings = trimmed
        .split('\n')
        .filter(line => /^#{1,6}\s/.test(line))
        .slice(0, 40)
        .map(line => line.trim());
    const headingBlock = headings.length > 0 ? `Sections: ${headings.join(' · ')}\n\n` : '';

    const active = objectives.find(objective => objective.id === activeObjectiveId);
    const relevant = [active, ...objectives.filter(objective => objective.id !== activeObjectiveId)]
        .filter((objective): objective is StudyObjective => objective !== undefined)
        .slice(0, 6);

    const windows: string[] = [];
    let used = headingBlock.length;
    for (const objective of relevant) {
        for (const anchor of objective.anchors.slice(0, 2)) {
            const needle = anchor.trim();
            if (needle.length < 8) continue;
            const index = trimmed.indexOf(needle);
            if (index === -1) continue;
            const start = Math.max(0, index - 500);
            const end = Math.min(trimmed.length, index + needle.length + 500);
            const window = trimmed.slice(start, end).trim();
            if (windows.some(existing => existing.includes(needle))) continue;
            if (used + window.length > budget) break;
            windows.push(`…${window}…`);
            used += window.length;
        }
    }

    const excerpt = windows.length > 0
        ? windows.join('\n\n')
        : `${trimmed.slice(0, budget - headingBlock.length)}…`;

    return `${headingBlock}${excerpt}`;
}

/** Render a digest for the finish screen. */
export function describeDigest(digest: StudyDigest, labels: Record<string, string>): string {
    const errors = Object.entries(digest.errorCounts)
        .filter(([category, count]) => category !== 'success' && (count ?? 0) > 0)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([category, count]) => `${labels[category] ?? category} ×${count}`)
        .join(', ');
    return `covered ${digest.covered}/${digest.totalObjectives} · mastery ${Math.round(digest.masteryScore * 100)}%${errors ? ` · ${errors}` : ''}`;
}

/** Helper used by the UI to phrase "why is this objective next". */
export function describeObjectiveState(state: ObjectiveProgressState | undefined): string {
    if (!state || state.status === StudyObjectiveStatus.Unseen) return 'not started';
    return `${state.status} · U${state.U} R${state.R} T${state.T}`;
}
