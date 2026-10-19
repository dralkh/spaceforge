import { ChatClient, ChatClientError, ChatMessage, createChatClient, inspectChatProvider } from '../api/chat-client';
import { StudyObjective } from '../models/study';
import { StudyDomainProfile, visualsFor } from '../models/study-domains';
import { STUDY_VISUAL_VERSION, StudyVisualPack, assetBudget, bulletBudget, coerceVisualPack, visualBudget } from '../models/study-visuals';
import SpaceforgePlugin from '../main';

/**
 * The three visual artifacts, generated from the material the chart already read.
 *
 * The map, the board and the summary come from one call each — one call, one
 * artifact, because a model asked for all three at once gives a thin version of
 * each. Everything is validated by `models/study-visuals.ts` before it is kept:
 * a malformed answer is a failed generation to retry, never a broken panel.
 */

export interface VisualPackRequest {
    notePath: string;
    /** The note's body, as the chart saw it. */
    content: string;
    /** The chart's objectives, so the visuals teach what the tutor teaches. */
    objectives: StudyObjective[];
    /** The chart's fingerprint of that body, for staleness. */
    fingerprint: string;
    profile: StudyDomainProfile;
}

/** What the prompt asks for, before the model answers. */
export interface VisualBudget {
    bullets: number;
    rowsOrSteps: number;
    mapDepth: number;
    /** How many interactive visual assets the gallery should hold. */
    assets: number;
}

export function visualBudgetFor(request: Pick<VisualPackRequest, 'content' | 'objectives' | 'profile'>): VisualBudget {
    const profile = visualsFor(request.profile);
    const objectiveCount = request.objectives.length;
    const base = bulletBudget(objectiveCount, Math.max(1, Math.round(request.content.length / 2500)), request.content.length);
    // The discipline decides how dense a summary may be before it stops being a
    // summary: a law note keeps every element, a history note keeps the spine.
    const bullets = Math.max(3, Math.min(28, Math.round(base * profile.bulletRatio)));
    return { bullets, rowsOrSteps: visualBudget(objectiveCount), mapDepth: profile.mapDepth, assets: assetBudget(objectiveCount) };
}

/** The system prompt: who the model is, and the rules that matter here. */
export function buildVisualSystemPrompt(profile: StudyDomainProfile): string {
    const visuals = visualsFor(profile);
    return [
        `You turn a study note into three visual artifacts for a learner: a mind map of the topic, one or two visual boards, and a condensed summary.`,
        `The discipline is ${profile.label}. It reasons as: ${profile.reasoning}.`,
        `Rules that override everything else:`,
        `- Use only what the note says. Never invent a fact, number, mechanism, case, date or citation. If the note is thin, the artifacts are thin.`,
        `- Nothing decorative. Every node, row, step and bullet must teach something; a visual that only restates the title is removed.`,
        `- The mind map is a hierarchy of *ideas*, not of the note's headings. Group by meaning: put a mechanism under the thing it explains, a consequence under its cause, a discriminator beside the pair it separates.`,
        `- The visual board may use only these forms: matrix, compare, flow, cycle, timeline. Prefer ${visuals.kinds.join(', ')} for this discipline. A comparison matrix is for things that are confused with each other; a flow is for an ordered decision or procedure; a cycle is for a process that returns to its start; a timeline is for sequence in time.`,
        `- "visuals" is a gallery of *drawings* the reader works with. The test for every asset is: could this be understood with the words removed? If it reads as a numbered list, a bulleted list or a paragraph, it is not a visual asset and must be redrawn. Labels are labels, never sentences; a cell is a few words, never a clause.`,
        `  * "lab" — a mission the reader solves with controls that drive a *drawing*. Params are numeric with honest ranges; outputs are arithmetic expressions over the param ids (allowed: + - * / ^ ( ), min max abs round sqrt ln log10 exp, pi, e). Every output is DRAWN: set "render": "bar" (fills across a scale), "gauge" (a needle that swings) or "value" (only when the answer is genuinely a word). Give scaleMin/scaleMax so the bar means something, and a "band" of normal values with insideLabel/outsideLabel so the drawing says "in range" or "out of range" without a sentence. Every drawn output MUST carry a band wherever a normal range is real — that band is the target the reader brings the reading into, and a lab with no band has no goal — and write "mission" as one short line naming what the reader is trying to achieve ("Bring both readings into range at the same time."). Use at least two params so there is a choice to make. This is the form for a relationship, a threshold, a dose, a balance — anything that can be watched move as a control moves.`,
        `  * "diagram" — a labelled picture the reader REBUILDS: shapes in a 0-100 coordinate space (box, ellipse, arrow, label) plus 2-6 hotspots, each a short NAME (one to three words — it is a chip the reader will drag) and one short sentence of detail. The reader is dealt the names shuffled and must place each on the right point, so the shape text must not give the names away: label the shapes with what they do, not with the hotspot's own name, or leave them unlabelled. Size every box to the words inside it (roughly 6 units of width per character), keep shapes in proportion to one another rather than one giant block beside tiny ones, and leave gaps so arrows are visible. Mark any arrow that carries movement with "flow": true and the one part the reader should watch with "pulse": true — the drawing then animates.`,
        `- At least one asset in every gallery must be a "lab" or a "graph": the reader must always have something to *operate*, not only something to look at. If the material has no relationship to compute and no numbers to plot, use a "lab" that compares two quantities the note does give (a ratio, a share, a total).`,
        `  * "sequence" — an order the reader rebuilds by DRAGGING the pieces (never a numbered list to read). 3-8 steps, each a label of a few words and optional short detail. Use it for cascades, procedures, derivations, chains of reasoning.`,
        `  * "graph" — numeric series the reader reads off a drawn curve: 1-3 series of at least 2 (x, y) points each, with axis labels and units. The reader can drag a marker along it and read values. Use it when the material has data, curves, dose/response or change over time.`,
        `  * matrix, compare, flow, cycle, timeline — each is shown as something the reader steps, scrubs, or reveals. A "compare" whose rows carry a "mark" becomes a game: the reader is asked to call each row's verdict (better / worse / equal) and is told on the spot, so give a "mark" on every row where a verdict is genuinely real and leave it off rows that merely differ. Cells of a few words. Give a "cycle" or "flow" a "motion" of "flow" | "cycle" | "pulse" so the process can be watched moving, and a "teach" line saying what to watch for. In a "flow", every branch's "to" must be the id of a step in that same flow, or the reader cannot take it; mark outcomes with "kind": "outcome".`,
        `- Every asset must be usable on its own: no asset may refer to another ("see above", "as in the map"), and no asset may be a paragraph of prose in disguise.`,
        `- The summary is not a second copy of the note: ${visuals.condense}. Aim for the number of bullets you are given, and mark each pearl with "emphasis": "pearl" — a pearl is what must survive when everything else is dropped.`,
        `- Keep the note's own numbers, units and names exactly as written, and keep every attribution exactly as the note has it: if a named component acts at a step, it is the component the note names for that step (P680 belongs to photosystem II and P700 to photosystem I; do not move a component to a step it does not act in). A drawing that teaches a wrong attribution is worse than no drawing.`,
        `- Keep every string short: labels under 60 characters, details one sentence, diagram shape text two or three words. A long answer gets cut off before it finishes, and a cut-off answer is worth nothing.`,
        `- Answer with JSON only, no prose around it.`,
        `JSON shape: {"mindMap":{"title":string,"root":{"id":string,"label":string,"detail":string?,"children":[node,...]}},"visuals":[{"kind":"matrix"|"compare","title":string,"columns":[string,...],"rows":[{"label":string,"cells":[string,...],"emphasis":boolean?,"mark":"better"|"worse"|"equal"?}],"pearl":string?},{"kind":"flow"|"cycle","title":string,"teach":string?,"motion":"flow"|"cycle"|"pulse"|"none"?,"steps":[{"id":string,"label":string,"detail":string?,"kind":"step"|"decision"|"outcome"?,"branches":[{"label":string,"to":string}]?}],"pearl":string?},{"kind":"timeline","title":string,"entries":[{"when":string,"label":string,"detail":string?}],"pearl":string?},{"kind":"lab","title":string,"teach":string,"mission":string?,"params":[{"id":string,"label":string,"unit":string?,"min":number,"max":number,"step":number?,"value":number}],"outputs":[{"id":string,"label":string,"unit":string?,"expression":string,"render":"bar"|"gauge"|"value"?,"scaleMin":number?,"scaleMax":number?,"band":[number,number]?,"insideLabel":string?,"outsideLabel":string?,"note":string?}],"presets":[{"label":string,"values":{}}]?,"pearl":string?},{"kind":"diagram","title":string,"teach":string,"shapes":[{"id":string,"kind":"box"|"ellipse"|"arrow"|"label","x":number,"y":number,"w":number?,"h":number?,"x2":number?,"y2":number?,"text":string?,"tone":"primary"|"muted"|"accent"?,"flow":boolean?,"pulse":boolean?}],"hotspots":[{"id":string,"label":string,"x":number,"y":number,"detail":string}],"caption":string?,"pearl":string?},{"kind":"sequence","title":string,"teach":string,"steps":[{"id":string,"label":string,"detail":string?}],"shuffle":boolean?,"pearl":string?},{"kind":"graph","title":string,"teach":string,"xLabel":string?,"yLabel":string?,"series":[{"id":string,"label":string,"tone":"primary"|"accent"|"muted"?,"points":[{"x":number,"y":number,"label":string?}]}],"pearl":string?}],"summary":{"title":string,"kept":string?,"bullets":[{"text":string,"emphasis":"pearl"|"normal"?,"children":[string]?}]}}`,
    ].join('\n');
}

/** The user prompt: the material, what is being taught, and the budgets. */
export function buildVisualUserPrompt(request: VisualPackRequest, budget: VisualBudget): string {
    const objectives = request.objectives
        .slice(0, 24)
        .map((objective, index) => `${index + 1}. [${objective.type}] ${objective.title}`)
        .join('\n');
    return [
        `Note: ${request.notePath}`,
        ``,
        `What the learner is being taught from this note:`,
        objectives || '(the chart has not finished with this note)',
        ``,
        `Budgets — stay inside them:`,
        `- summary: about ${budget.bullets} bullets, one idea each, pearls marked`,
        `- each visual board: at most ${budget.rowsOrSteps} rows or steps`,
        `- the gallery: exactly ${budget.assets} assets, each of a different form if the material allows, each teaching one thing`,
        `- mind map: at most depth ${budget.mapDepth} below the root, at most 6 children per node`,
        ``,
        `The note:`,
        request.content,
    ].join('\n');
}

/**
 * The JSON in a model's answer, however it wrapped it.
 *
 * Models fence JSON, preface it, or trail an apology. This finds the outermost
 * object and returns it, or null when there is none — the caller treats that as
 * a failed generation.
 */
export function extractJson(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(candidate.slice(start, end + 1));
    } catch {
        return null;
    }
}

export class StudyVisualService {
    private readonly plugin: SpaceforgePlugin;
    /** One generation per note at a time: two presses are one artifact. */
    private inFlight = new Map<string, Promise<StudyVisualPack | null>>();

    constructor(plugin: SpaceforgePlugin, createClient?: () => ChatClient | null) {
        this.plugin = plugin;
        // A seam for tests: the production path builds the real client from the
        // reader's settings, and nothing else changes.
        if (createClient) this.clientFactory = createClient;
    }

    private clientFactory: (() => ChatClient | null) | null = null;

    /** True when a pack was made from a different body than the note now has. */
    isStale(pack: StudyVisualPack | null | undefined, fingerprint: string): boolean {
        if (!pack) return false;
        return pack.sourceHash !== fingerprint || pack.version !== STUDY_VISUAL_VERSION;
    }

    /**
     * Generate the pack, or join the generation already running for this note.
     *
     * The chart pipeline learned this the hard way: a guard before an `await`
     * is not a guard, and two renders during one generation produced two of
     * everything. The promise is shared, and cleared however it settles.
     */
    generate(request: VisualPackRequest): Promise<StudyVisualPack | null> {
        const existing = this.inFlight.get(request.notePath);
        if (existing) return existing;
        const run = this.runGeneration(request).finally(() => this.inFlight.delete(request.notePath));
        this.inFlight.set(request.notePath, run);
        return run;
    }

    private client(): ChatClient | null {
        if (this.clientFactory) return this.clientFactory();
        // Read the settings for every generation. The service lives for the
        // plugin's lifetime, so a cached client would keep talking to whichever
        // provider happened to be selected the first time material was made.
        return createChatClient(this.plugin.settings);
    }

    private async runGeneration(request: VisualPackRequest): Promise<StudyVisualPack | null> {
        const client = this.client();
        if (!client) {
            const provider = inspectChatProvider(this.plugin.settings);
            throw new ChatClientError(provider.reason ?? 'Study cannot reach a model.');
        }
        const budget = visualBudgetFor(request);
        const messages: ChatMessage[] = [
            { role: 'system', content: buildVisualSystemPrompt(request.profile) },
            { role: 'user', content: buildVisualUserPrompt(request, budget) },
        ];
        const result = await client.send({
            messages,
            temperature: Math.min(0.6, Math.max(0.1, this.plugin.settings.studyTemperature)),
            // A gallery of interactive assets, a map and a summary do not fit in
            // the chart's budget — and a truncated answer is a lost generation,
            // not a partial one, because the JSON never closes.
            maxTokens: Math.max(6000, this.plugin.settings.studyMaxTokens * 4),
            json: true,
            contextWindow: this.plugin.settings.studyContextWindow,
        });
        if (result.truncated) {
            throw new ChatClientError('The model ran out of room before it finished the answer. Try again, or ask for less material at once.');
        }
        const parsed = extractJson(result.text);
        return coerceVisualPack(parsed, {
            domain: request.profile.id,
            sourceHash: request.fingerprint,
        });
    }
}
