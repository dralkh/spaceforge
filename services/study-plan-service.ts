import SpaceforgePlugin from '../main';
import {
    ObjectiveProgressState,
    StudyDigest,
    StudyObjective,
    StudyObjectiveStatus,
    StudyObjectiveType,
    StudyPlan,
    StudyProgressStore,
    StudyReviewSuggestion,
    STUDY_DATA_VERSION,
    STUDY_MAX_SESSIONS_PER_NOTE,
    STUDY_MAX_TURNS_PER_SESSION,
    STUDY_STATUS_REVIEW_DAYS,
    StudySessionRecord,
    StudySourceRef,
    StudySummaryPayload,
    createObjectiveProgress,
    deriveObjectiveStatus,
    objectiveMastery,
} from '../models/study';
import { detectDomain, getDomainProfile, STUDY_DOMAINS } from '../models/study-domains';
import { asRecordValue, asTextList, asTextValue } from '../utils/coerce';
import { parseImportance, parseObjectiveType } from '../utils/tutor-protocol';

/** Additive persistence fields; old versions safely ignore them. */
export interface IntegrityProgressStore extends StudyProgressStore {
    archivedObjectives?: Record<string, { objective: StudyObjective; progress: ObjectiveProgressState; archivedAt: number }>;
    objectiveDefinitions?: Record<string, string>;
    pendingObjectives?: Record<string, StudyObjective>;
    incompatibleObjectives?: Record<string, { definition?: string; progress: ObjectiveProgressState }>;
    planFingerprint?: string;
    deletedAt?: number;
    renamedTo?: string;
    restoredAt?: number;
    noteMissingAt?: number;
}

/** Identity witness for compatibility checks, never a fuzzy match. */
export function objectiveDefinition(objective: StudyObjective): string {
    return JSON.stringify([objective.title.trim().toLowerCase(), objective.statement.trim().toLowerCase(), objective.type]);
}

function newObjectiveId(reserved: Set<string>): string {
    let id: string;
    do {
        id = `objective-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`;
    } while (reserved.has(id));
    reserved.add(id);
    return id;
}

/**
 * Storage and lifecycle for study plans and mastery state.
 *
 * A plan is generated once per note and then owned by the learner: progress
 * accumulates into it, the tutor's domain notes can be corrected by hand, and
 * if the note changes underneath us the plan is re-charted while *keeping* the
 * mastery that was already earned. Nothing is silently thrown away.
 */
export class StudyPlanService {
    plugin: SpaceforgePlugin;
    /** Reference to pluginState.studyPlans. */
    plans: Record<string, StudyPlan>;
    /** Reference to pluginState.studyProgress. */
    progress: Record<string, StudyProgressStore>;
    /** Reference to pluginState.studySessions. */
    sessions: Record<string, StudySessionRecord[]>;

    constructor(
        plugin: SpaceforgePlugin,
        plans: Record<string, StudyPlan>,
        progress: Record<string, StudyProgressStore>,
        sessions: Record<string, StudySessionRecord[]>
    ) {
        this.plugin = plugin;
        this.plans = plans ?? {};
        this.progress = progress ?? {};
        this.sessions = sessions ?? {};
    }

    /** Cheap content hash used to notice that a note has moved on. */
    static fingerprint(content: string): string {
        let hash = 0x811c9dc5;
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return `${hash.toString(16)}-${content.length}`;
    }

    getPlan(notePath: string): StudyPlan | null {
        const plan = this.plans[notePath];
        if (!plan || !Array.isArray(plan.objectives) || plan.objectives.length === 0) return null;
        this.normalizeDomain(plan);
        return plan;
    }

    /**
     * Store a chart. Returns false when the note's study data is currently
     * forgotten (a deletion receipt from a rename or an explicit forget); the
     * caller must revive it first. Never fails silently: a chart that cannot be
     * stored is a cost the reader did not agree to.
     */
    savePlan(plan: StudyPlan): boolean {
        if (this.isForgotten(plan.notePath)) {
            console.warn(`[spaceforge] Study plan for ${plan.notePath} was not saved: the note's Study data is forgotten until it is revived.`);
            return false;
        }
        plan.updatedAt = Date.now();
        this.normalizeDomain(plan);
        this.plans[plan.notePath] = plan;
        this.ensureProgress(plan);
        // A chart that has just finished is the one moment worth announcing:
        // everything downstream of a plan (material, questions) waits on it.
        if (StudyPlanService.planReady(plan)) this.announcePlanReady(plan);
        return true;
    }

    /** True while a deletion receipt owns this path. */
    private isForgotten(notePath: string): boolean {
        return Boolean((this.progress[notePath] as IntegrityProgressStore | undefined)?.deletedAt);
    }

    /**
     * Notes whose plan just became ready to build on.
     *
     * Called whenever a plan is saved in a state nothing more will be added to
     * on its own — every section of the note charted. That is the same fact
     * both charting paths reach (the background queue and a chart the reader
     * started), so a subscriber hears about both without knowing which ran.
     */
    subscribePlanReady(listener: (plan: StudyPlan) => void): () => void {
        this.readyListeners.push(listener);
        return () => {
            this.readyListeners = this.readyListeners.filter(existing => existing !== listener);
        };
    }

    private announcePlanReady(plan: StudyPlan): void {
        for (const listener of [...this.readyListeners]) {
            try {
                listener(plan);
            } catch {
                // A broken listener must not stop a chart from being saved.
            }
        }
    }

    private readyListeners: ((plan: StudyPlan) => void)[] = [];

    /**
     * Whether the note has been charted all the way through.
     *
     * Ids are assigned per run, so this reads the chart state the run left
     * behind: every section accounted for (charted, or skipped with a reason),
     * and at least one objective to show for it. A plan from before chart
     * states existed (`chartState: null`) counts as ready once it has
     * objectives — there is no section list to be part-way through.
     */
    static planReady(plan: StudyPlan | null | undefined): boolean {
        if (!plan || !Array.isArray(plan.objectives) || plan.objectives.length === 0) return false;
        const state = plan.chartState;
        if (!state) return true;
        return state.done.length >= Math.max(1, state.total);
    }

    /**
     * The discipline a note is written in, detected from the note itself.
     *
     * Keyword-first and offline by construction (`detectDomain` in
     * models/study-domains.ts): the opening of the note is scanned first,
     * because a discipline usually announces itself there, and only when that
     * finds nothing is the whole body scanned — a lecture export whose subject
     * is named in a later heading still gets its profile. No match is
     * 'general', the neutral profile, never an error.
     */
    static detectPlanDomain(content: string): string {
        const opening = detectDomain(content.slice(0, 4000));
        if (opening.id !== 'general') return opening.id;
        return detectDomain(content).id;
    }

    /**
     * Make a plan's discipline answerable, whatever the stored data says.
     *
     * A plan can arrive from disk with a discipline the current registry does
     * not know (an id from an older version, a hand-edited data.json) or with
     * none at all, and every surface downstream reads it: the tutor prompt, the
     * visual profile, the briefing's lens row. Reading it through the registry
     * means those surfaces can never meet an unknown id, a missing label or a
     * missing notes string — they meet the neutral profile instead.
     */
    private normalizeDomain(plan: StudyPlan): void {
        const profile = getDomainProfile(plan.domainId);
        if (plan.domainId !== profile.id) plan.domainId = profile.id;
        if (typeof plan.domainLabel !== 'string' || plan.domainLabel.length === 0) plan.domainLabel = profile.label;
        if (typeof plan.domainNotes !== 'string') plan.domainNotes = '';
        if (typeof plan.safetyCritical !== 'boolean') plan.safetyCritical = profile.safetyCritical;
        if (typeof plan.domainOverriddenByUser !== 'boolean') plan.domainOverriddenByUser = false;
    }

    getProgress(notePath: string): StudyProgressStore | null {
        return this.progress[notePath] ?? null;
    }

    /** Progress store for a note, created on demand. */
    ensureProgress(plan: StudyPlan): StudyProgressStore {
        let store = this.progress[plan.notePath];
        if (!store) {
            store = {
                notePath: plan.notePath,
                updatedAt: Date.now(),
                totalSessions: 0,
                completedSessions: 0,
                objectives: {},
                tutorMemory: [...plan.tutorMemory],
                lastSessionSummary: null,
                scheduleSuggestions: [],
            };
            this.progress[plan.notePath] = store;
        }
        if ((store as IntegrityProgressStore).deletedAt) return store;
        for (const objective of plan.objectives) {
            if (!store.objectives[objective.id]) {
                store.objectives[objective.id] = createObjectiveProgress();
            }
        }
        const integrity = store as IntegrityProgressStore;
        integrity.planFingerprint = plan.contentFingerprint;
        const definitions = {
            ...integrity.objectiveDefinitions,
            ...Object.fromEntries(plan.objectives.map(objective => [objective.id, objectiveDefinition(objective)])),
        };
        // Read every time a plan is touched, so retired definitions would grow
        // for the life of the vault. Only the objectives this plan teaches need
        // a witness; archived ones carry their own copy.
        const active = new Set(plan.objectives.map(objective => objective.id));
        integrity.objectiveDefinitions = Object.fromEntries(
            Object.entries(definitions).filter(([id]) => active.has(id)),
        );
        return store;
    }

    /** State of one objective, never null. */
    objectiveState(plan: StudyPlan, store: StudyProgressStore, objectiveId: string): ObjectiveProgressState {
        if (!store.objectives[objectiveId]) {
            store.objectives[objectiveId] = createObjectiveProgress();
        }
        return store.objectives[objectiveId];
    }

    /** Wipe mastery for a note but keep the chart. */
    resetProgress(notePath: string): void {
        const plan = this.getPlan(notePath);
        const previous = this.progress[notePath];
        if ((previous as IntegrityProgressStore | undefined)?.deletedAt) return;
        if (!plan) {
            delete this.progress[notePath];
            return;
        }
        this.progress[notePath] = {
            notePath,
            updatedAt: Date.now(),
            ...((previous as IntegrityProgressStore | undefined)?.restoredAt ? { restoredAt: (previous as IntegrityProgressStore).restoredAt } : {}),
            totalSessions: 0,
            completedSessions: 0,
            objectives: {},
            tutorMemory: [],
            lastSessionSummary: null,
            scheduleSuggestions: [],
        };
        this.ensureProgress(plan);
        if (previous?.lastSessionSummary) {
            this.progress[notePath].lastSessionSummary = null;
        }
    }

    /** Forget everything about a note (plan, progress, sessions). */
    removeForNote(notePath: string): void {
        delete this.plans[notePath];
        const old = this.progress[notePath] as IntegrityProgressStore | undefined;
        const deletedAt = Math.max(Date.now(), old?.restoredAt ?? 0, old?.deletedAt ?? 0);
        this.progress[notePath] = {
            notePath, updatedAt: deletedAt, deletedAt,
            totalSessions: 0, completedSessions: 0, objectives: {},
            tutorMemory: [], lastSessionSummary: null, scheduleSuggestions: [],
        } as IntegrityProgressStore;
        delete this.sessions[notePath];
    }

    /**
     * Supersede a deletion receipt because the path is live again (a new file
     * was created there, or the reader asked to chart it). Until this runs,
     * every writer refuses the path — which is correct for sync, and a dead end
     * for a note that now exists.
     */
    reviveForNote(notePath: string): boolean {
        const old = this.progress[notePath] as IntegrityProgressStore | undefined;
        if (!old?.deletedAt) return false;
        this.progress[notePath] = {
            notePath, updatedAt: Date.now(), restoredAt: Math.max(Date.now(), old.deletedAt + 1),
            objectives: {}, totalSessions: 0, completedSessions: 0, tutorMemory: [],
            lastSessionSummary: null, scheduleSuggestions: [],
        } as IntegrityProgressStore;
        return true;
    }

    /** Move legacy buckets atomically; never overwrite another note's data. */
    renameForNote(oldPath: string, newPath: string): boolean {
        if (oldPath === newPath) return true;
        if (newPath.startsWith(`${oldPath}/`)) return false;
        const matches = (path: string): boolean => path === oldPath || path.startsWith(`${oldPath}/`);
        const maps = [this.plans, this.progress, this.sessions];
        const paths = new Set(maps.flatMap(map => Object.keys(map)).filter(matches));
        for (const path of paths) {
            const target = newPath + path.slice(oldPath.length);
            if (!paths.has(target) && (this.plans[target] || this.sessions[target] ||
                (this.progress[target] && !(this.progress[target] as IntegrityProgressStore).deletedAt))) return false;
        }
        const receipts = new Map([...paths].map(path => {
            const target = newPath + path.slice(oldPath.length);
            return [target, (this.progress[target] as IntegrityProgressStore | undefined)?.deletedAt ?? 0];
        }));
        for (const map of maps) {
            const record = map as Record<string, unknown>;
            const moved = [...paths].filter(path => path in record).map(path => [path, record[path]] as const);
            for (const [path] of moved) delete record[path];
            for (const [path, value] of moved) {
                record[newPath + path.slice(oldPath.length)] = value;
                const visit = (entry: unknown): void => {
                    if (!entry || typeof entry !== 'object') return;
                    for (const [key, child] of Object.entries(entry)) {
                        if (typeof child === 'string' && ['notePath', 'path', 'sourcePath', 'resolvedPath', 'filePath', 'currentPath', 'target'].includes(key) && matches(child)) {
                            (entry as Record<string, unknown>)[key] = newPath + child.slice(oldPath.length);
                        } else if (child && typeof child === 'object') visit(child);
                    }
                };
                visit(value);
            }
        }
        for (const [target, deletedAt] of receipts) {
            if (deletedAt && this.progress[target]) {
                const store = this.progress[target] as IntegrityProgressStore;
                store.restoredAt = Math.max(Date.now(), deletedAt + 1, store.restoredAt ?? 0);
            }
        }
        for (const path of paths) {
            this.removeForNote(path);
            (this.progress[path] as IntegrityProgressStore).renamedTo = newPath + path.slice(oldPath.length);
        }
        return true;
    }

    /** A missing file retains its learning history, including folder children. */
    markNoteMissing(notePath: string): void {
        for (const path of new Set([...Object.keys(this.plans), ...Object.keys(this.progress)])) {
            if (path !== notePath && !path.startsWith(`${notePath}/`)) continue;
            const store = this.progress[path] ?? (this.plans[path] ? this.ensureProgress(this.plans[path]) : null);
            if (store) {
                (store as IntegrityProgressStore).noteMissingAt = Date.now();
                store.updatedAt = Date.now();
            }
        }
    }

    /** True when the note body no longer matches the charted content. */
    isStale(plan: StudyPlan, content: string): boolean {
        return plan.contentFingerprint !== StudyPlanService.fingerprint(content);
    }

    /**
     * Merge a freshly charted plan over an existing one.
     *
     * Objectives that still describe the same idea keep their mastery (matched
     * by definition, never by provisional positional IDs). Continuations keep
     * their original identity; new objectives receive unique IDs and start empty.
     * Dropped definitions and mastery are archived only when replacement is final.
     */
    mergePlans(previous: StudyPlan | null, fresh: StudyPlan, options: { final?: boolean } = {}): { plan: StudyPlan; kept: number; added: number; dropped: StudyObjective[] } {
        const store = (this.progress[fresh.notePath] ?? (previous ? this.ensureProgress(previous) : undefined)) as IntegrityProgressStore | undefined;
        const current = this.plans[fresh.notePath];
        const previousObjectives = [...(previous?.objectives ?? [])];
        for (const objective of Object.values(store?.pendingObjectives ?? {})) {
            if (!previousObjectives.some(existing => existing.id === objective.id)) previousObjectives.push(objective);
        }
        // Continue newly discovered objectives across checkpoints too.
        for (const objective of current?.objectives ?? []) {
            if (!previousObjectives.some(existing => existing.id === objective.id)) previousObjectives.push(objective);
        }
        const reserved = new Set([
            ...previousObjectives.map(objective => objective.id),
            ...Object.values(this.plans).flatMap(plan => plan.objectives.map(objective => objective.id)),
            ...Object.values(this.progress).flatMap(value => [
                ...Object.keys(value.objectives), ...Object.keys((value as IntegrityProgressStore).archivedObjectives ?? {}),
            ]),
        ]);
        const usedPrevious = new Set<string>();
        /** new objective id -> previous objective id it continues. */
        const matched: Record<string, string> = {};
        let kept = 0;
        let added = 0;
        const mergedObjectives: StudyObjective[] = [];

        for (const objective of fresh.objectives) {
            const match = previousObjectives.find(candidate => !usedPrevious.has(candidate.id) &&
                objectiveDefinition(candidate) === objectiveDefinition(objective)) ?? previousObjectives.find(candidate =>
                !usedPrevious.has(candidate.id) && StudyPlanService.similar(candidate, objective)
            );
            if (match) {
                usedPrevious.add(match.id);
                matched[objective.id] = match.id;
                kept++;
            } else {
                matched[objective.id] = newObjectiveId(reserved);
                added++;
            }
            mergedObjectives.push({ ...objective, id: matched[objective.id], prerequisites: [...objective.prerequisites] });
        }

        for (const objective of mergedObjectives) {
            objective.prerequisites = objective.prerequisites.map(id => matched[id]).filter((id): id is string => !!id && id !== objective.id);
        }
        const dropped = previousObjectives.filter(objective => !usedPrevious.has(objective.id));
        const carriedMemory = Array.from(new Set([...(previous?.tutorMemory ?? []), ...(fresh.tutorMemory ?? [])])).slice(-20);

        const merged: StudyPlan = {
            ...fresh,
            objectives: mergedObjectives,
            tutorMemory: carriedMemory,
            images: fresh.images.length > 0 ? fresh.images : previous?.images ?? [],
            visuals: fresh.visuals ?? current?.visuals ?? previous?.visuals ?? null,
            chartState: fresh.chartState,
            generatedAt: previous?.generatedAt ?? fresh.generatedAt,
            version: STUDY_DATA_VERSION,
            // A chart that only gained objectives is not a content drift.
            contentFingerprint: fresh.contentFingerprint,
            domainOverriddenByUser: previous?.domainOverriddenByUser ?? fresh.domainOverriddenByUser,
        };

        // Stable IDs make repeated merge(original, partial) non-destructive.
        // Until the chart is final, unseen objectives remain in the live store.
        if (store) {
            for (const objective of mergedObjectives) {
                store.objectives[objective.id] ??= createObjectiveProgress();
            }
            const final = options.final ?? StudyPlanService.planReady(fresh);
            store.pendingObjectives = final ? {} : Object.fromEntries(dropped.map(objective => [objective.id, structuredClone(objective)]));
            if (final) {
                store.archivedObjectives ??= {};
                for (const objective of dropped) {
                    if (!store.objectives[objective.id]) continue;
                    store.archivedObjectives[objective.id] = {
                        objective: structuredClone(objective),
                        progress: structuredClone(store.objectives[objective.id]), archivedAt: Date.now(),
                    };
                    delete store.objectives[objective.id];
                }
                const active = new Set(mergedObjectives.map(objective => objective.id));
                store.scheduleSuggestions = store.scheduleSuggestions.filter(suggestion => active.has(suggestion.objectiveId));
            }
            if (final && dropped.length > 0) {
                store.tutorMemory = Array.from(new Set([
                    ...store.tutorMemory,
                    `Re-charted: ${dropped.length} objective(s) are no longer in the note.`,
                ])).slice(-20);
            }
            store.updatedAt = Date.now();
        }
        this.savePlan(merged);
        return { plan: merged, kept, added, dropped };
    }

    /**
     * Whether two objectives describe the same idea.
     *
     * Title identity is the primary signal: charts keep stable titles for
     * unchanged ideas, and merging on title alone avoids the failure mode that
     * matters more than duplication — silently collapsing two objectives that
     * merely share vocabulary. Statement similarity is only consulted for
     * statements long enough for the overlap to mean something.
     */
    static similar(a: StudyObjective, b: StudyObjective): boolean {
        const normalise = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
        const tokenize = (value: string): Set<string> =>
            new Set(normalise(value).split(' ').filter(token => token.length >= 4));

        const left = tokenize(a.statement);
        const right = tokenize(b.statement);
        let shared = 0;
        for (const token of left) {
            if (right.has(token)) shared++;
        }
        const union = left.size + right.size - shared;
        const overlap = union === 0 ? 0 : shared / union;

        // The statements must agree. Titles alone must never merge two
        // objectives: real notes repeat headings (a bolded "NSTEMI" section for
        // diagnosis and a later plain one for management are different ideas),
        // and merging them silently deletes material.
        const titleA = normalise(a.title);
        const titleB = normalise(b.title);
        const sameTitle = titleA.length > 0 && (titleA === titleB ||
            (titleA.length > 5 && titleB.length > 5 && (titleA.includes(titleB) || titleB.includes(titleA))));

        if (sameTitle) return shared >= 4 && overlap >= 0.5;
        return left.size >= 6 && right.size >= 6 && shared >= 6 && overlap >= 0.75;
    }

    /**
     * Turn raw model output into a StudyPlan.
     *
     * Ids are assigned here rather than trusted from the model, duplicates are
     * folded, prerequisites named by title are resolved to ids, and the
     * objective count is capped by settings.
     */
    buildPlanFromChart(
        notePath: string,
        content: string,
        chart: Record<string, unknown>,
        domainIdHint: string
    ): StudyPlan {
        const maxObjectives = Math.max(4, Math.min(40, this.plugin.settings.studyMaxObjectives || 12));

        const rawChart = asRecordValue(chart.chart);
        const rawObjectives = Array.isArray(chart.objectives)
            ? chart.objectives
            : rawChart && Array.isArray(rawChart.objectives)
                ? rawChart.objectives
                : [];
        const topicSummary =
            asTextValue(chart.topicSummary ?? chart.summary ?? chart.topic) ??
            `Coverage chart for ${notePath.split('/').pop() ?? notePath}`;

        // The discipline is a stored fact of the plan, not something a surface
        // re-decides later. Order: the chart's own answer when it names a
        // discipline the registry knows, then the discipline an already-charted
        // plan settled on (that is what preserves a reader's correction), then
        // the keyword pass over the note itself. The neutral entry is not a
        // hint — a plan that has no discipline yet carries 'general' — so the
        // keyword pass still gets its chance. Anything the registry cannot
        // place resolves to the neutral profile through getDomainProfile: a
        // note nothing recognises is 'general', never an error.
        const neutralId = getDomainProfile(null).id;
        const hintedDomain = this.resolveDomainId(domainIdHint);
        const domainIdCandidate = asTextValue(chart.domain) ?? asTextValue(chart.discipline);
        const resolvedDomainId =
            this.resolveDomainId(domainIdCandidate) ??
            (hintedDomain && hintedDomain !== neutralId ? hintedDomain : null) ??
            StudyPlanService.detectPlanDomain(content);
        const profile = getDomainProfile(resolvedDomainId);

        const objectives: StudyObjective[] = [];
        const prerequisitesByName: { objectiveIndex: number; names: string[] }[] = [];

        for (const entry of rawObjectives) {
            const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            const statement = asTextValue(record.statement ?? record.objective ?? record.text) ?? asTextValue(entry);
            if (!statement) continue;
            const title = asTextValue(record.title ?? record.name ?? record.label) ?? StudyPlanService.shorten(statement);

            const candidate: StudyObjective = {
                id: `obj-${objectives.length + 1}`,
                title,
                statement,
                type: parseObjectiveType(record.type ?? record.kind) ?? this.inferType(statement, record),
                importance: parseImportance(record.importance ?? record.priority),
                prerequisites: [],
                anchors: asTextList(record.anchors ?? record.source ?? record.quotes).slice(0, 4),
            };

            // Fold near-duplicates instead of shipping the learner two of them.
            const duplicate = objectives.find(existing => StudyPlanService.similar(existing, candidate));
            if (duplicate) {
                duplicate.anchors = Array.from(new Set([...duplicate.anchors, ...candidate.anchors]));
                continue;
            }

            prerequisitesByName.push({
                objectiveIndex: objectives.length,
                names: asTextList(record.prerequisites ?? record.requires ?? record.dependsOn),
            });
            objectives.push(candidate);
            if (objectives.length >= maxObjectives) break;
        }

        // Resolve prerequisite names to ids by fuzzy matching titles/statements.
        for (const entry of prerequisitesByName) {
            const target = objectives[entry.objectiveIndex];
            if (!target) continue;
            for (const name of entry.names) {
                const match = objectives.find(candidate =>
                    candidate.id !== target.id &&
                    (candidate.id === name ||
                        candidate.title.toLowerCase() === name.toLowerCase() ||
                        StudyPlanService.similar(candidate, {
                            id: '',
                            title: name,
                            statement: name,
                            type: candidate.type,
                            importance: candidate.importance,
                            prerequisites: [],
                            anchors: [],
                        }))
                );
                if (match) target.prerequisites.push(match.id);
            }
            target.prerequisites = Array.from(new Set(target.prerequisites));
        }

        // Prerequisite cycles would deadlock ordering, so break them cheaply.
        this.breakCycles(objectives);

        const uncovered = asTextList(chart.uncovered ?? chart.missing ?? chart.notCovered);
        const tutorMemory = asTextList(chart.tutorMemory ?? chart.memory ?? chart.notesAboutMe);

        const plan: StudyPlan = {
            notePath,
            generatedAt: Date.now(),
            updatedAt: Date.now(),
            version: STUDY_DATA_VERSION,
            contentFingerprint: StudyPlanService.fingerprint(content),
            visuals: null,
            domainId: profile.id,
            domainLabel: profile.label,
            domainNotes: asTextValue(chart.domainNotes ?? chart.domainNote) ?? '',
            domainOverriddenByUser: false,
            safetyCritical: profile.safetyCritical,
            topicSummary,
            objectives,
            uncoveredSource: uncovered,
            tutorMemory: tutorMemory.slice(0, 8),
            images: [],
            chartState: null,
        };

        return plan;
    }

    /** Map a model-provided discipline onto a known profile id. */
    resolveDomainId(value: string | null): string | null {
        if (!value) return null;
        const slug = value.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-+|-+$/g, '');
        if (slug.length === 0) return null;
        const exact = STUDY_DOMAINS.find(profile => profile.id === slug);
        if (exact) return exact.id;
        const partial = STUDY_DOMAINS.find(profile => slug.includes(profile.id) || profile.id.includes(slug));
        if (partial) return partial.id;
        const byLabel = STUDY_DOMAINS.find(profile => profile.label.toLowerCase().replace(/[^a-z]+/g, '-').includes(slug));
        return byLabel ? byLabel.id : null;
    }

    /** Guess an objective type when the model did not supply one. */
    private inferType(statement: string, record: Record<string, unknown>): StudyObjectiveType {
        const haystack = `${statement} ${asTextValue(record.title) ?? ''}`.toLowerCase();
        if (/(contraindicat|danger|risk|safety|must not|never)/.test(haystack)) return StudyObjectiveType.Safety;
        if (/(differ|distinguish|versus|vs\.?|compare|contrast|confus)/.test(haystack)) return StudyObjectiveType.Distinction;
        if (/(why|because|mechanism|pathway|cause|leads to|results in)/.test(haystack)) return StudyObjectiveType.Mechanism;
        if (/(calculate|solve|compute|apply|derive|perform|produce)/.test(haystack)) return StudyObjectiveType.Application;
        if (/(interpret|read|identify|recognise|diagnose)/.test(haystack)) return StudyObjectiveType.Interpretation;
        if (/(step|procedure|sequence|order|process)/.test(haystack)) return StudyObjectiveType.Procedure;
        if (/(evaluate|judge|critique|argue|justify|trade-off)/.test(haystack)) return StudyObjectiveType.Critique;
        return StudyObjectiveType.Fact;
    }

    /** Remove prerequisite cycles by dropping the weakest back-edges. */
    private breakCycles(objectives: StudyObjective[]): void {
        const byId = new Map(objectives.map(objective => [objective.id, objective]));
        for (const objective of objectives) {
            const seen = new Set<string>([objective.id]);
            const walk = (current: StudyObjective, depth: number): void => {
                if (depth > objectives.length) return;
                for (const prerequisiteId of [...current.prerequisites]) {
                    if (prerequisiteId === objective.id) {
                        current.prerequisites = current.prerequisites.filter(id => id !== prerequisiteId);
                        continue;
                    }
                    if (seen.has(prerequisiteId)) continue;
                    seen.add(prerequisiteId);
                    const next = byId.get(prerequisiteId);
                    if (next) walk(next, depth + 1);
                }
            };
            walk(objective, 0);
        }
    }

    /** Short human label from a long statement. */
    static shorten(statement: string): string {
        const firstClause = statement.split(/[.;:—–\n]/)[0] ?? statement;
        const trimmed = firstClause.trim();
        if (trimmed.length <= 64) return trimmed;
        return `${trimmed.slice(0, 61).trim()}…`;
    }

    /** Objectives whose suggested review date has passed. */
    dueObjectives(plan: StudyPlan, store: StudyProgressStore, now = Date.now()): { objectiveId: string; overdueDays: number }[] {
        const due: { objectiveId: string; overdueDays: number }[] = [];
        for (const objective of plan.objectives) {
            const state = store.objectives[objective.id];
            if (!state || state.status === StudyObjectiveStatus.Unseen) continue;
            if (state.nextReviewAt === null) continue;
            if (state.nextReviewAt <= now) {
                due.push({ objectiveId: objective.id, overdueDays: Math.max(0, Math.floor((now - state.nextReviewAt) / 86400000)) });
            }
        }
        return due.sort((a, b) => b.overdueDays - a.overdueDays);
    }

    /** How many objectives have been attempted at all. */
    coverageCount(plan: StudyPlan, store: StudyProgressStore | null): number {
        if (!store) return 0;
        return plan.objectives.filter(objective => {
            const state = store.objectives[objective.id];
            return state !== undefined && (state.attempts > 0 || state.U > 0);
        }).length;
    }

    /** Mean mastery across all objectives, 0-1. */
    overallMastery(plan: StudyPlan, store: StudyProgressStore | null): number {
        if (!store || plan.objectives.length === 0) return 0;
        let total = 0;
        for (const objective of plan.objectives) {
            const state = store.objectives[objective.id];
            total += state ? objectiveMastery(state) : 0;
        }
        return total / plan.objectives.length;
    }

    /** Suggested next review for an objective, written by the engine. */
    scheduleObjective(plan: StudyPlan, store: StudyProgressStore, objectiveId: string, inDays: number): void {
        const state = store.objectives[objectiveId];
        if (!state) return;
        const days = Math.max(0, Math.min(365, Math.round(inDays)));
        state.nextReviewAt = Date.now() + days * 86400000;
        const suggestion: StudyReviewSuggestion = { objectiveId, inDays: days, madeAt: Date.now(), provisional: true };
        store.scheduleSuggestions = [
            ...store.scheduleSuggestions.filter(existing => existing.objectiveId !== objectiveId),
            suggestion,
        ].slice(-24);
        store.updatedAt = Date.now();
    }

    /** Default review interval for the objective's current status. */
    defaultReviewDays(state: ObjectiveProgressState): number {
        return STUDY_STATUS_REVIEW_DAYS[state.status] ?? 1;
    }

    /** Recompute an objective's derived status after a rubric change. */
    refreshStatus(state: ObjectiveProgressState): StudyObjectiveStatus {
        state.status = deriveObjectiveStatus(state);
        return state.status;
    }

    /** Sessions for a note, newest first. */
    sessionsForNote(notePath: string): StudySessionRecord[] {
        return this.sessions[notePath] ?? [];
    }

    mostRecentSession(notePath: string): StudySessionRecord | null {
        const list = this.sessionsForNote(notePath);
        return list.length > 0 ? list[0] : null;
    }

    /** Store a finished sitting. False when the path is currently forgotten. */
    saveSession(session: StudySessionRecord): boolean {
        if (this.isForgotten(session.notePath)) {
            console.warn(`[spaceforge] Study session for ${session.notePath} was not saved: the note's Study data is forgotten until it is revived.`);
            return false;
        }
        const list = this.sessions[session.notePath] ?? [];
        const index = list.findIndex(existing => existing.id === session.id);
        if (index >= 0) list[index] = StudySessionRecordLimit(session);
        else list.unshift(StudySessionRecordLimit(session));
        list.sort((a, b) => b.startedAt - a.startedAt);
        this.sessions[session.notePath] = list.slice(0, STUDY_MAX_SESSIONS_PER_NOTE);
        return true;
    }

    /** Record that a session started. */
    noteSessionStarted(notePath: string): void {
        const plan = this.getPlan(notePath);
        if (!plan) return;
        const store = this.ensureProgress(plan);
        store.totalSessions += 1;
        store.updatedAt = Date.now();
    }

    /** Record that a session finished. */
    noteSessionFinished(notePath: string, summary: string, completed: boolean): void {
        const plan = this.getPlan(notePath);
        if (!plan) return;
        const store = this.ensureProgress(plan);
        if (completed) store.completedSessions += 1;
        store.lastSessionSummary = summary;
        store.updatedAt = Date.now();
    }

    /** Live snapshot for the modal's digest strip. */
    buildDigest(
        plan: StudyPlan,
        store: StudyProgressStore,
        session: { turnCount: number; turnLimit: number; errorCounts: Partial<Record<string, number>>; webLookups: number; startedAt: number }
    ): StudyDigest {
        const covered = this.coverageCount(plan, store);
        const mastered = plan.objectives.filter(objective => store.objectives[objective.id]?.status === StudyObjectiveStatus.Mastered).length;
        return {
            turnCount: session.turnCount,
            turnLimit: session.turnLimit,
            covered,
            totalObjectives: plan.objectives.length,
            mastered,
            masteryScore: this.overallMastery(plan, store),
            errorCounts: session.errorCounts,
            dueObjectives: this.dueObjectives(plan, store),
            nextSuggestions: store.scheduleSuggestions.slice(-6),
            webLookups: session.webLookups,
            elapsedMs: Date.now() - session.startedAt,
        };
    }
}

/** Keep a stored session inside the size budget. */
function StudySessionRecordLimit(session: StudySessionRecord): StudySessionRecord {
    if (session.transcript.length <= STUDY_MAX_TURNS_PER_SESSION) return session;
    return { ...session, transcript: session.transcript.slice(-STUDY_MAX_TURNS_PER_SESSION) };
}

/**
 * Render a session into markdown that is useful inside a vault.
 *
 * Deliberately plain: a summary a human would read, the cards that are worth
 * keeping, and the error pattern. No invented links, no dead exports.
 */
export function renderSessionMarkdown(
    plan: StudyPlan,
    payload: Pick<StudySummaryPayload, 'session' | 'digest' | 'mastered' | 'fragile' | 'score'>
): string {
    const { session, digest, mastered, fragile, score } = payload;
    const title = plan.notePath.split('/').pop()?.replace(/\.md$/, '') ?? plan.notePath;
    const lines: string[] = [];
    const when = new Date(session.startedAt).toLocaleString();

    lines.push(`# Study session — ${title}`);
    lines.push('');
    lines.push(`Subject: ${plan.domainLabel} · Session: ${when} · Mode: ${session.mode} · Web lookup: ${session.webSearch ? 'on' : 'off'}`);
    lines.push(`Objectives covered: ${digest.covered}/${digest.totalObjectives} · Session score: ${Math.round(score * 100)}%`);
    if (session.summary) {
        lines.push('');
        lines.push('## What the tutor concluded');
        lines.push('');
        lines.push(session.summary);
    }

    const objectiveById = new Map(plan.objectives.map(objective => [objective.id, objective]));
    const strong = Object.entries(session.errorCounts)
        .filter(([category]) => category !== 'success')
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));

    if (strong.length > 0) {
        lines.push('');
        lines.push('## Error pattern');
        lines.push('');
        for (const [category, count] of strong) {
            lines.push(`- ${category}: ${count}`);
        }
    }

    if (mastered.length > 0) {
        lines.push('');
        lines.push('## Now solid');
        lines.push('');
        for (const id of mastered) {
            const objective = objectiveById.get(id);
            if (objective) lines.push(`- ${objective.statement}`);
        }
    }

    if (fragile.length > 0) {
        lines.push('');
        lines.push('## Needs another pass');
        lines.push('');
        for (const id of fragile) {
            const objective = objectiveById.get(id);
            if (objective) lines.push(`- ${objective.statement}`);
        }
    }

    // Cards, in the one-fact-per-line form that flashcard tooling can ingest.
    const cardLines: string[] = [];
    const transcript = session.transcript;
    for (let i = 0; i < transcript.length; i++) {
        const turn = transcript[i];
        if (turn.role !== 'tutor' || turn.kind !== 'question') continue;
        const next = transcript.slice(i + 1).find(candidate => candidate.role === 'tutor' && candidate.kind === 'feedback');
        if (!next) continue;
        const answer = next.text.replace(/\s+/g, ' ').trim();
        if (answer.length === 0 || answer.length > 400) continue;
        const question = turn.text.replace(/\s+/g, ' ').trim();
        if (question.length === 0 || question.includes('::')) continue;
        cardLines.push(`${question}::${answer}`);
    }

    if (cardLines.length > 0) {
        lines.push('');
        lines.push('## Cards worth keeping');
        lines.push('');
        for (const card of cardLines.slice(0, 20)) lines.push(card);
        lines.push('');
        lines.push('_Generated cards are drafts: check them before trusting them._');
    }

    if (session.sources.length > 0) {
        lines.push('');
        lines.push('## Sources looked up');
        lines.push('');
        for (const source of session.sources.slice(0, 12)) {
            lines.push(`- [${source.title}](${source.url})`);
        }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('_Tutor output is generated and can be wrong. It is study support, not a substitute for the authoritative source._');

    return lines.join('\n');
}

/** Collected source URLs from a session, used as the citation allow-list. */
export function collectSourceUrls(sessions: StudySessionRecord[]): Set<string> {
    const urls = new Set<string>();
    for (const session of sessions) {
        for (const source of session.sources) urls.add(source.url);
    }
    return urls;
}

/** Filter model-reported sources down to ones a lookup actually returned. */
export function filterVerifiedSources(reported: StudySourceRef[], allowed: Set<string>): StudySourceRef[] {
    return reported.filter(source => allowed.has(source.url));
}
