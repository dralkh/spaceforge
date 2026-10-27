import type { StudyErrorCategory, StudyObjective, StudySessionOptions, StudySessionRecord, StudyStage, TutorPromptSpec } from './study';

export interface StudyPendingRequest {
    id: string;
    learnerAnswer: string | null;
    forceWrapUp: boolean;
    status: 'pending' | 'interrupted' | 'failed';
    researchBlock?: string | null;
    protocolRepair?: boolean;
}

/** JSON-only exact engine checkpoint. No transport or credentials. */
export interface StudyTutorCheckpoint {
    session: StudySessionRecord;
    options: StudySessionOptions;
    pendingPrompt: TutorPromptSpec | null;
    recentTurns: { role: 'tutor' | 'user'; text: string; objectiveId: string | null }[];
    focusOrder: string[];
    stage: StudyStage;
    allowedUrls: string[];
    researchRounds: number;
    turnErrorCounts: Partial<Record<StudyErrorCategory, number>>;
    masteredBefore: string[];
    touched: string[];
    finished: boolean;
    pendingRequest: StudyPendingRequest | null;
    committedRequestIds: string[];
}

export interface StudyObjectiveThread {
    id: string;
    objective: StudyObjective | null;
    archived: boolean;
    draft: string;
    checkpoint: StudyTutorCheckpoint;
}

export interface StudyWorkspace {
    schema: 1;
    id: string;
    activeThreadId: string | null;
    threads: Record<string, StudyObjectiveThread>;
    /** Device-facing surface state; the panel owns its shape, not the model. */
    viewState?: Record<string, unknown>;
    updatedAt: number;
}

/** Result of reading a persisted workspace, including every repair applied. */
export interface StudyWorkspaceRepair {
    workspace: StudyWorkspace;
    changed: boolean;
    droppedThreads: number;
    reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Read a workspace from persisted data without trusting it.
 *
 * A chat is a large, nested object written by an older build, a partial save
 * or (rarely) a hand-edited data file. A malformed thread must cost that thread,
 * never the panel or the reader's other conversations. Objective identity is
 * checked against the current plan so a rechart can retire a thread without
 * silently re-attaching it to a different objective.
 */
export function repairStudyWorkspace(
    value: unknown,
    objectiveIds: ReadonlySet<string> | null,
    now = Date.now(),
): StudyWorkspaceRepair {
    const empty = (): StudyWorkspace => ({
        schema: 1,
        id: studyUniqueId('workspace'),
        activeThreadId: null,
        threads: {},
        updatedAt: now,
    });
    if (!isRecord(value) || value.schema !== 1) {
        return {
            workspace: empty(),
            changed: true,
            droppedThreads: 0,
            reason: isRecord(value) ? 'Unsupported workspace schema.' : 'No saved workspace.',
        };
    }

    let changed = false;
    let droppedThreads = 0;
    const threads: Record<string, StudyObjectiveThread> = {};
    const rawThreads = isRecord(value.threads) ? value.threads : {};
    if (!isRecord(value.threads)) changed = true;

    const keyToId = new Map<string, string>();
    for (const [key, raw] of Object.entries(rawThreads)) {
        if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
            droppedThreads += 1;
            changed = true;
            continue;
        }
        const checkpoint = normalizeCheckpoint(raw.checkpoint);
        if (!checkpoint) {
            droppedThreads += 1;
            changed = true;
            continue;
        }
        // The record key is not part of the contract; a hand edit or an older
        // writer may disagree with the thread's own id. Re-key on read so
        // `threads[id]` is an invariant for active lookup and pruning.
        if (threads[raw.id]) {
            droppedThreads += 1;
            changed = true;
            continue;
        }
        keyToId.set(key, raw.id);
        const objective = isRecord(raw.objective)
            && typeof raw.objective.id === 'string'
            && typeof raw.objective.title === 'string'
            && typeof raw.objective.statement === 'string'
            ? raw.objective as unknown as StudyObjective
            : null;
        const archived = raw.archived === true || (objective !== null && objectiveIds !== null && !objectiveIds.has(objective.id));
        if (archived !== (raw.archived === true)) changed = true;
        threads[raw.id] = {
            id: raw.id,
            objective,
            archived,
            draft: typeof raw.draft === 'string' ? raw.draft : '',
            checkpoint,
        };
        if (threads[raw.id].draft !== raw.draft || key !== raw.id) changed = true;
    }

    const rawActive = typeof value.activeThreadId === 'string' ? value.activeThreadId : null;
    let activeThreadId = rawActive ? (keyToId.get(rawActive) ?? rawActive) : null;
    if (activeThreadId !== null) {
        const active = threads[activeThreadId];
        if (!active || active.archived) {
            // A retired conversation must not silently promote a different
            // objective's chat into the panel on the next mount.
            activeThreadId = null;
            changed = true;
        }
    }

    const viewState = isRecord(value.viewState) ? value.viewState : undefined;
    if (value.viewState !== undefined && viewState === undefined) changed = true;
    const workspace: StudyWorkspace = {
        schema: 1,
        id: typeof value.id === 'string' && value.id.length > 0 ? value.id : studyUniqueId('workspace'),
        activeThreadId,
        threads,
        ...(viewState ? { viewState } : {}),
        updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    };
    if (workspace.id !== value.id || workspace.updatedAt !== value.updatedAt) changed = true;
    const pruned = pruneStudyWorkspace(workspace);
    if (pruned.changed) changed = true;
    droppedThreads += pruned.dropped;
    return {
        workspace: pruned.workspace,
        changed,
        droppedThreads,
        reason: droppedThreads > 0 ? 'Some saved conversations were unreadable or over the retention limit.' : null,
    };
}

/** Keep one live conversation per objective and one archived predecessor. */
export function pruneStudyWorkspace(
    workspace: StudyWorkspace,
    limits: { maxThreads?: number; maxArchivedPerObjective?: number } = {},
): { workspace: StudyWorkspace; changed: boolean; dropped: number } {
    const maxThreads = Math.max(1, limits.maxThreads ?? 64);
    const maxArchived = Math.max(0, limits.maxArchivedPerObjective ?? 1);
    const byObjective = new Map<string, StudyObjectiveThread[]>();
    const loose: StudyObjectiveThread[] = [];
    for (const thread of Object.values(workspace.threads)) {
        const objectiveId = thread.objective?.id;
        if (!objectiveId) { loose.push(thread); continue; }
        const list = byObjective.get(objectiveId) ?? [];
        list.push(thread);
        byObjective.set(objectiveId, list);
    }
    const keep = new Set<string>();
    if (workspace.activeThreadId) keep.add(workspace.activeThreadId);
    const newest = (threads: StudyObjectiveThread[]): StudyObjectiveThread[] =>
        [...threads].sort((a, b) => (b.checkpoint.session.startedAt ?? 0) - (a.checkpoint.session.startedAt ?? 0));
    for (const group of byObjective.values()) {
        const ordered = newest(group);
        const live = ordered.filter(thread => !thread.archived);
        const archived = ordered.filter(thread => thread.archived);
        // The active thread is the reader's place; keep it even when an older
        // live thread exists, and never keep a second live chat beside it.
        const liveKeep = live.find(thread => thread.id === workspace.activeThreadId) ?? live[0];
        if (liveKeep) keep.add(liveKeep.id);
        for (const thread of archived.slice(0, maxArchived)) keep.add(thread.id);
    }
    const newestLoose = newest(loose)[0];
    if (newestLoose) keep.add(newestLoose.id);
    if (keep.size > maxThreads) {
        // Retention must prefer the active thread and live conversations over
        // archived transcripts; otherwise a full archive can evict every live
        // chat at the cap.
        const ordered = Object.values(workspace.threads)
            .filter(thread => keep.has(thread.id))
            .sort((a, b) => {
                if (a.id === workspace.activeThreadId) return -1;
                if (b.id === workspace.activeThreadId) return 1;
                if (a.archived !== b.archived) return a.archived ? 1 : -1;
                return (b.checkpoint.session.startedAt ?? 0) - (a.checkpoint.session.startedAt ?? 0);
            });
        keep.clear();
        for (const thread of ordered) {
            if (keep.size >= maxThreads) break;
            keep.add(thread.id);
        }
    }
    const threads: Record<string, StudyObjectiveThread> = {};
    for (const [id, thread] of Object.entries(workspace.threads)) if (keep.has(id)) threads[id] = thread;
    const changed = Object.keys(threads).length !== Object.keys(workspace.threads).length;
    return {
        workspace: changed ? { ...workspace, threads, updatedAt: Date.now() } : workspace,
        changed,
        dropped: Object.keys(workspace.threads).length - Object.keys(threads).length,
    };
}

function normalizeCheckpoint(value: unknown): StudyTutorCheckpoint | null {
    if (!isRecord(value) || !isRecord(value.session) || !isRecord(value.options)) return null;
    const session = value.session;
    if (typeof session.id !== 'string' || !Array.isArray(session.transcript)) return null;
    const options = value.options;
    if (typeof options.mode !== 'string') return null;
    const pending = value.pendingRequest;
    const pendingRequest: StudyPendingRequest | null = isRecord(pending)
        && typeof pending.id === 'string'
        && (pending.status === 'pending' || pending.status === 'interrupted' || pending.status === 'failed')
        ? {
            id: pending.id,
            learnerAnswer: typeof pending.learnerAnswer === 'string' ? pending.learnerAnswer : null,
            forceWrapUp: pending.forceWrapUp === true,
            status: pending.status,
            ...(typeof pending.researchBlock === 'string' ? { researchBlock: pending.researchBlock } : {}),
            ...(pending.protocolRepair === true ? { protocolRepair: true } : {}),
        }
        : null;
    const transcript = session.transcript.filter((turn): turn is StudySessionRecord['transcript'][number] =>
        isRecord(turn)
        && typeof turn.id === 'string'
        && typeof turn.text === 'string'
        && (turn.role === 'tutor' || turn.role === 'user' || turn.role === 'system')
        && typeof turn.kind === 'string');
    const pendingPrompt = isRecord(value.pendingPrompt)
        && typeof value.pendingPrompt.text === 'string'
        && typeof value.pendingPrompt.kind === 'string'
        ? value.pendingPrompt as unknown as TutorPromptSpec
        : null;
    return {
        session: {
            ...session,
            transcript,
            objectivesTouched: stringList(session.objectivesTouched),
            objectivesMastered: stringList(session.objectivesMastered),
            sources: stringList(session.sources),
            errorCounts: isRecord(session.errorCounts) ? session.errorCounts as StudySessionRecord['errorCounts'] : {},
            startedAt: typeof session.startedAt === 'number' ? session.startedAt : 0,
            endedAt: typeof session.endedAt === 'number' ? session.endedAt : null,
            turnCount: typeof session.turnCount === 'number' ? session.turnCount : 0,
            webLookups: typeof session.webLookups === 'number' ? session.webLookups : 0,
        } as unknown as StudySessionRecord,
        options: {
            ...options,
            mode: typeof options.mode === 'string' ? options.mode as StudySessionOptions['mode'] : 'guided' as StudySessionOptions['mode'],
            webSearch: options.webSearch === true,
            turnLimit: typeof options.turnLimit === 'number' && Number.isFinite(options.turnLimit) ? options.turnLimit : 8,
            freshStart: options.freshStart === true,
        } as StudySessionOptions,
        pendingPrompt,
        recentTurns: Array.isArray(value.recentTurns)
            ? value.recentTurns.filter((turn): turn is { role: 'tutor' | 'user'; text: string; objectiveId: string | null } =>
                isRecord(turn) && (turn.role === 'tutor' || turn.role === 'user') && typeof turn.text === 'string')
                .map(turn => ({ role: turn.role, text: turn.text, objectiveId: typeof turn.objectiveId === 'string' ? turn.objectiveId : null }))
            : [],
        focusOrder: stringList(value.focusOrder),
        stage: typeof value.stage === 'string' ? value.stage as StudyStage : 'orient' as StudyStage,
        allowedUrls: stringList(value.allowedUrls),
        researchRounds: typeof value.researchRounds === 'number' ? value.researchRounds : 0,
        turnErrorCounts: isRecord(value.turnErrorCounts) ? value.turnErrorCounts as StudyTutorCheckpoint['turnErrorCounts'] : {},
        masteredBefore: stringList(value.masteredBefore),
        touched: stringList(value.touched),
        finished: value.finished === true,
        pendingRequest,
        committedRequestIds: stringList(value.committedRequestIds),
    };
}

let sequence = 0;
/** Random identity independent of buffer length, timestamps and plan positions. */
export function studyUniqueId(prefix: string): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    return `${prefix}-${uuid ?? `${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

export function studySnapshot<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
