/**
 * Carrying review progress through the vault, for people who do not sync
 * `.obsidian`.
 *
 * The plugin's own `data.json` lives where Obsidian puts it, which is the right
 * place for it: it is fast, it is written atomically, and its backups sit
 * beside it. But that folder is exactly what many people leave out of their
 * sync — Obsidian Sync needs "community plugins" turned on to carry it, and
 * phone-only users usually do not want every plugin's configuration on every
 * device anyway. So the progress has to be able to travel in the one place a
 * vault always syncs: the vault's own folder.
 *
 * This module keeps a *projection* of the data file at
 * `spaceforge/state/progress.json`, and merges it back on load. Two rules keep
 * that safe:
 *
 * 1. The data file stays the authority on the device that is running. The
 *    projection is derived, never read blindly, and written only after the
 *    real file is safely on disk.
 * 2. Everything merged is merged per record, not per file. Two devices that
 *    each reviewed different notes keep both sets of reviews; the newest review
 *    of the same note wins; logs are unioned. Nothing is replaced wholesale
 *    except preferences, which are small and are taken from whichever side
 *    wrote last.
 *
 * What does *not* travel is as deliberate: settings that name this machine (the
 * Anki address, a custom data path, anything that looks like a secret) and
 * state that only makes sense while one device is sitting in a session (the
 * interrupted sitting, the run in progress, a running pomodoro). Carrying
 * those would be worse than not syncing at all.
 */

import { PluginStateData } from '../models/plugin-data';
import { SpaceforgeSettings } from '../models/settings';
import { objectiveDefinition } from './study-plan-service';

/** Where the projection lives, relative to the vault root. */
export const PROGRESS_DIR = 'spaceforge/state';

/** The projection itself. Not named `data.json`: it is not the data file. */
export const PROGRESS_FILE = `${PROGRESS_DIR}/progress.json`;

/** Bumped when the envelope's shape changes; older files are read, not refused. */
export const PROGRESS_SCHEMA = 1;

/** The projection, as written. */
export interface ProgressEnvelope {
    schema: number;
    /** Monotonic per device; a tiebreak, not a global clock. */
    rev: number;
    /** Wall clock, ms. Used to decide which side's *preferences* are newer. */
    updatedAt: number;
    /** Opaque and random, so two devices can be told apart without naming them. */
    device: string;
    version: string;
    settings: Partial<SpaceforgeSettings>;
    state: Partial<PluginStateData>;
}

/** The slice of Obsidian's DataAdapter this module needs. */
export interface ProgressAdapter {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    exists(path: string): Promise<boolean>;
    remove?(path: string): Promise<void>;
    rename?(from: string, to: string): Promise<void>;
    mkdir?(path: string): Promise<void>;
}

/**
 * Settings that must not travel: they describe this machine, or they are the
 * switch for this feature itself.
 *
 * The list is checked by a test against a name pattern, so a future setting
 * that looks like a secret cannot quietly join the projection.
 */
export const LOCAL_ONLY_SETTINGS: readonly string[] = [
    'useCustomDataPath',
    'customDataPath',
    'syncProgressThroughVault',
    'ankiConnectEnabled',
    'ankiConnectUrl',
    'ankiPushed',
    'cliExtraPath',
    // Credentials and endpoint overrides: these are this machine's keys, and a
    // synced vault folder is often a shared or cloud-backed one.
    'providerKeys',
    'providerUrls',
    // Not secrets, but they describe how this device reads and grades: an
    // editor preference and a token budget travel badly and cost nothing to
    // keep local.
    'reviewStripGradeKeys',
    'studyMaxTokens',
];

/**
 * A setting whose name suggests a credential never travels, listed or not.
 *
 * Deliberately narrow: `mcqApiProvider` names a provider, not a key, and a
 * pattern that matched `api` anywhere would quietly stop ordinary preferences
 * from travelling. `keys`, `…ApiKey`, `token`, `secret`, `password` and
 * `credential` are the shapes a stored credential actually takes here, and a
 * test requires every setting that matches to be a deliberate decision.
 */
export const SECRET_SETTING_PATTERN = /key$|keys$|api[_-]?key|token|secret|password|credential|passphrase/i;

/** State keys that only mean something on the device that is running. */
export const LOCAL_ONLY_STATE: readonly string[] = [
    'deckSitting',
    'noteRun',
    'pomodoroCurrentMode',
    'pomodoroTimeLeftInSeconds',
    'pomodoroSessionsCompletedInCycle',
    'pomodoroIsRunning',
    'pomodoroEndTimeMs',
    'pomodoroEstimatedTotalCycles',
    'pomodoroEstimatedWorkSessions',
    'pomodoroIsEstimationActive',
    'pomodoroUserHasModifiedSettings',
    'pomodoroUserOverrideHours',
    'pomodoroUserOverrideMinutes',
    'pomodoroUserAddToEstimation',
    'lastLinkAnalysisTimestamp',
];

/**
 * How each travelling state key is merged.
 *
 * `dict`     — a record keyed by note path or id; the record whose stamp is
 *              newer replaces the other's, and a record the other side does not
 *              have is added. This is what makes two devices keep each other's
 *              reviews instead of overwriting them.
 * `log`      — an append-only list; unioned by identity, ordered by time, capped.
 * `dictLogs` — a record of append-only lists; unioned per key.
 * `counters` — nested counters; the larger value of each field wins, which is
 *              idempotent and never walks a day's total backwards.
 * `keep`     — a preference that cannot be ordered by record; only used to fill
 *              in a side that has nothing.
 */
type MergeKind = 'dict' | 'log' | 'dictLogs' | 'counters' | 'keep';

interface StateRule {
    kind: MergeKind;
    /** The record's own clock, in ms. Absent means "no opinion". */
    stamp?: (record: Record<string, unknown>) => number;
    /** A record's identity in a log, so the same review is not counted twice. */
    keyOf?: (record: Record<string, unknown>) => string;
    /** The time a log entry is sorted by. */
    timeOf?: (record: Record<string, unknown>) => number;
    /** How many entries the merged log keeps, newest first. */
    cap?: number;
    /** The array inside a `dictLogs` value. */
    listOf?: (record: Record<string, unknown>) => unknown;
}

const RULES: Record<string, StateRule> = {
    schedules: { kind: 'dict', stamp: (record) => numberOr0(record.lastReviewDate) },
    history: { kind: 'log', keyOf: (record) => `${record.path}@${record.timestamp}`, timeOf: (record) => numberOr0(record.timestamp), cap: 1000 },
    deckHistory: { kind: 'log', keyOf: (record) => `${record.deckPath}:${record.cardId}@${record.timestamp}`, timeOf: (record) => numberOr0(record.timestamp), cap: 5000 },
    reviewDayStats: { kind: 'counters' },
    studyPlans: { kind: 'dict', stamp: (record) => numberOr0(record.updatedAt ?? record.generatedAt) },
    studyProgress: { kind: 'dict', stamp: (record) => numberOr0(record.updatedAt) },
    studySessions: { kind: 'dictLogs', listOf: (record) => record, keyOf: (record) => String(record.id ?? `${record.notePath}@${record.startedAt}`), timeOf: (record) => numberOr0(record.startedAt), cap: 200 },
    mcqSets: { kind: 'dict', stamp: (record) => numberOr0(record.updatedAt ?? record.createdAt) },
    mcqSessions: { kind: 'dictLogs', listOf: (record) => record, keyOf: (record) => String(record.id ?? `${record.mcqSetId}@${record.startedAt}`), timeOf: (record) => numberOr0(record.startedAt), cap: 200 },
    calendarEvents: { kind: 'dict', stamp: (record) => numberOr0(record.updatedAt ?? record.start) },
    customNoteOrder: { kind: 'keep' },
};

/** Everything that travels, in the order it appears in a projection. */
export const PORTABLE_STATE_KEYS: readonly string[] = Object.keys(RULES);

function numberOr0(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The projection of what this device knows, ready to be written.
 *
 * `rev` is the caller's counter; this function does not mutate anything.
 */
export function projectProgress(
    settings: SpaceforgeSettings,
    state: PluginStateData,
    meta: { rev: number; device: string; version: string; now?: number },
): ProgressEnvelope {
    const portableSettings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings ?? {})) {
        if (LOCAL_ONLY_SETTINGS.includes(key)) continue;
        if (SECRET_SETTING_PATTERN.test(key)) continue;
        portableSettings[key] = value;
    }
    const portableState: Record<string, unknown> = {};
    for (const key of PORTABLE_STATE_KEYS) {
        if (LOCAL_ONLY_STATE.includes(key)) continue;
        const value = (state as unknown as Record<string, unknown>)[key];
        if (key === 'studyProgress' && isRecord(value)) {
            portableState[key] = Object.fromEntries(Object.entries(value).map(([path, store]) => {
                if (!isRecord(store)) return [path, store];
                const portable = { ...store };
                // Exact checkpoints/drafts are device state, not mergeable events.
                delete portable.workspace;
                return [path, portable];
            }));
        } else if (key === 'studySessions' && isRecord(value)) {
            // Session transcripts contain quoted note text and free-text answers.
            // Keep those on the device that made them; the portable copy carries
            // ids, timings and counts so progress still merges across devices.
            portableState[key] = Object.fromEntries(Object.entries(value).map(([path, sessions]) => [
                path,
                Array.isArray(sessions)
                    ? sessions.map((session: unknown) => isRecord(session) ? { ...session, transcript: [], summary: null } : session)
                    : sessions,
            ]));
        } else if (value !== undefined) portableState[key] = value;
    }
    return {
        schema: PROGRESS_SCHEMA,
        rev: meta.rev,
        updatedAt: meta.now ?? Date.now(),
        device: meta.device,
        version: meta.version,
        settings: portableSettings,
        state: portableState,
    };
}

/** What a merge did, for the notice and the log. */
export interface MergeReport {
    addedSchedules: string[];
    addedHistory: number;
    addedDeckHistory: number;
    addedSessions: number;
    /** Keys whose value was taken from the other side. */
    replaced: string[];
}

/**
 * Fold a projection into what this device has.
 *
 * `preferOtherSettings` is decided by the caller, which is the only place that
 * can compare the two writes' times. The state is merged record by record
 * either way: a newer projection never deletes what this device knows.
 */
export function mergeProgress(
    local: { settings: SpaceforgeSettings; state: PluginStateData },
    other: ProgressEnvelope,
    options: { preferOtherSettings: boolean },
): { settings: SpaceforgeSettings; state: PluginStateData; report: MergeReport } {
    const report: MergeReport = { addedSchedules: [], addedHistory: 0, addedDeckHistory: 0, addedSessions: 0, replaced: [] };

    const settings: SpaceforgeSettings = { ...local.settings };
    if (options.preferOtherSettings) {
        for (const [key, value] of Object.entries(other.settings ?? {})) {
            if (LOCAL_ONLY_SETTINGS.includes(key) || SECRET_SETTING_PATTERN.test(key)) continue;
            if (JSON.stringify(settings[key as keyof SpaceforgeSettings]) !== JSON.stringify(value)) {
                (settings as unknown as Record<string, unknown>)[key] = value;
                report.replaced.push(key);
            }
        }
    }

    const state = { ...local.state } as unknown as Record<string, unknown>;
    for (const key of PORTABLE_STATE_KEYS) {
        const incoming = (other.state as unknown as Record<string, unknown>)?.[key];
        if (incoming === undefined) continue;
        const current = state[key];
        const rule = RULES[key];
        if (['studyPlans', 'studyProgress', 'studySessions'].includes(key)) continue;
        const merged = mergeValue(key, current, incoming, rule, report);
        if (merged !== current) state[key] = merged;
        if (JSON.stringify(merged) !== JSON.stringify(current) && !report.replaced.includes(key)) report.replaced.push(key);
    }

    const study = mergeStudyState(state, other.state);
    for (const key of ['studyPlans', 'studyProgress', 'studySessions']) {
        if (JSON.stringify(state[key]) !== JSON.stringify(study[key])) report.replaced.push(key);
        const collection = study[key];
        if (key === 'studySessions' && isRecord(collection)) {
            const value = state[key];
            const current = isRecord(value) ? value : {};
            for (const [path, list] of Object.entries(collection)) {
                const existing = current[path];
                const before = Array.isArray(existing) ? existing : [];
                const seen = new Set(before.filter(isRecord).map(record => record.id));
                if (Array.isArray(list)) report.addedSessions += list.filter(isRecord).filter(record => !seen.has(record.id)).length;
            }
        }
        state[key] = study[key];
    }
    return { settings, state: state as unknown as PluginStateData, report };
}

function mergeValue(key: string, current: unknown, incoming: unknown, rule: StateRule, report: MergeReport): unknown {
    switch (rule.kind) {
        case 'dict':
            return mergeDict(key, current, incoming, rule, report);
        case 'log':
            return mergeLog(key, current, incoming, rule, report);
        case 'dictLogs':
            return mergeDictLogs(key, current, incoming, rule, report);
        case 'counters':
            return mergeCounters(current, incoming);
        case 'keep':
            // Only fills in a side that has nothing to say.
            if (Array.isArray(current) && current.length > 0) return current;
            return incoming;
        default:
            return current;
    }
}

function mergeDict(key: string, current: unknown, incoming: unknown, rule: StateRule, report: MergeReport): unknown {
    const base = isRecord(current) ? { ...current } : {};
    if (!isRecord(incoming)) return base;
    for (const [id, record] of Object.entries(incoming)) {
        const mine = base[id];
        if (mine === undefined) {
            base[id] = record;
            if (key === 'schedules') report.addedSchedules.push(id);
            continue;
        }
        const theirsAt = rule.stamp && isRecord(record) ? rule.stamp(record) : 0;
        const mineAt = rule.stamp && isRecord(mine) ? rule.stamp(mine) : 0;
        if (theirsAt > mineAt) base[id] = record;
    }
    return base;
}

/**
 * Durable observations from both sides, in the order they were first seen, at
 * most the last twenty — the same window the tutor keeps for itself.
 */
function mergedTutorMemory(...lists: unknown[]): string[] {
    const seen = new Set<string>();
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) if (typeof entry === 'string') seen.add(entry);
    }
    return [...seen].slice(-20);
}

function mergeLog(key: string, current: unknown, incoming: unknown, rule: StateRule, report: MergeReport): unknown {
    const mine: unknown[] = Array.isArray(current) ? current : [];
    const theirs: unknown[] = Array.isArray(incoming) ? incoming : [];
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const record of [...mine, ...theirs]) {
        if (!isRecord(record)) continue;
        const identity = rule.keyOf ? rule.keyOf(record) : JSON.stringify(record);
        if (seen.has(identity)) continue;
        seen.add(identity);
        merged.push(record);
    }
    merged.sort((a, b) => (isRecord(a) && isRecord(b) && rule.timeOf ? rule.timeOf(a) - rule.timeOf(b) : 0));
    const capped = rule.cap !== undefined && merged.length > rule.cap ? merged.slice(merged.length - rule.cap) : merged;
    const added = capped.length - mine.length;
    if (key === 'history') report.addedHistory = Math.max(0, added);
    if (key === 'deckHistory') report.addedDeckHistory = Math.max(0, added);
    return capped;
}

function mergeDictLogs(key: string, current: unknown, incoming: unknown, rule: StateRule, report: MergeReport): unknown {
    const base = isRecord(current) ? { ...current } : {};
    if (!isRecord(incoming)) return base;
    for (const [id, list] of Object.entries(incoming)) {
        const mine = base[id];
        const merged = mergeLog(key, mine, list, rule, report);
        if (Array.isArray(merged) && merged.length > (Array.isArray(mine) ? mine.length : 0)) {
            report.addedSessions += merged.length - (Array.isArray(mine) ? mine.length : 0);
        }
        base[id] = merged;
    }
    return base;
}

/** Merge Study atomically: a mastery record only follows a matching definition.
 * Recovery uses keepCurrent to fill holes without replacing authoritative data.
 */
export function mergeStudyState(local: Record<string, unknown>, incoming: Record<string, unknown>, keepCurrent = false): Record<string, unknown> {
    const dict = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
    const localPlans = dict(local.studyPlans);
    const otherPlans = dict(incoming.studyPlans);
    const localProgress = dict(local.studyProgress);
    const otherProgress = dict(incoming.studyProgress);
    const localSessions = dict(local.studySessions);
    const otherSessions = dict(incoming.studySessions);
    const plans = { ...localPlans };
    const progress = { ...localProgress };
    const sessions = { ...localSessions };
    const paths = new Set([...Object.keys(localPlans), ...Object.keys(otherPlans), ...Object.keys(localProgress), ...Object.keys(otherProgress), ...Object.keys(otherSessions)]);
    for (const path of paths) {
        const rawMine = dict(localProgress[path]);
        const rawTheirs = dict(otherProgress[path]);
        const restoredAt = Math.max(numberOr0(rawMine.restoredAt), numberOr0(rawTheirs.restoredAt));
        const mineCurrent = numberOr0(rawMine.restoredAt) >= restoredAt;
        const theirsCurrent = numberOr0(rawTheirs.restoredAt) >= restoredAt;
        const mine = mineCurrent ? rawMine : {};
        const theirs = theirsCurrent ? rawTheirs : {};
        const deletedAt = Math.max(numberOr0(rawMine.deletedAt), numberOr0(rawTheirs.deletedAt));
        if (deletedAt > 0 && deletedAt >= restoredAt) {
            // A receipt wins over offline saves, even with a later wall clock.
            progress[path] = { ...(numberOr0(rawMine.deletedAt) >= numberOr0(rawTheirs.deletedAt) ? rawMine : rawTheirs), deletedAt };
            delete plans[path];
            delete sessions[path];
            continue;
        }
        const myPlan = mineCurrent ? dict(localPlans[path]) : {};
        const theirPlan = theirsCurrent ? dict(otherPlans[path]) : {};
        const plan = !Object.keys(myPlan).length || (!keepCurrent && numberOr0(theirPlan.updatedAt ?? theirPlan.generatedAt) > numberOr0(myPlan.updatedAt ?? myPlan.generatedAt)) ? theirPlan : myPlan;
        if (Object.keys(plan).length > 0) plans[path] = plan;
        else delete plans[path];
        const definitions = (source: Record<string, unknown>, sourcePlan: Record<string, unknown>): Record<string, unknown> => {
            const result = { ...dict(source.objectiveDefinitions) };
            if (Array.isArray(sourcePlan.objectives)) {
                for (const objective of sourcePlan.objectives) {
                    if (isRecord(objective) && typeof objective.id === 'string' && typeof objective.title === 'string' && typeof objective.statement === 'string') {
                        result[objective.id] ??= objectiveDefinition(objective as never);
                    }
                }
            }
            return result;
        };
        const activeDefinitions = definitions({}, plan);
        const myDefinitions = definitions(mine, myPlan);
        const theirDefinitions = definitions(theirs, theirPlan);
        const myObjectives = dict(mine.objectives);
        const theirObjectives = dict(theirs.objectives);
        const newer = !Object.keys(mine).length || (!keepCurrent && numberOr0(theirs.updatedAt) > numberOr0(mine.updatedAt)) ? theirs : mine;
        if (keepCurrent && !Object.keys(mine).length && plan === theirPlan) {
            if (otherProgress[path]) progress[path] = otherProgress[path];
        } else if (localProgress[path] || otherProgress[path]) {
            const objectives: Record<string, unknown> = {};
            const witnesses: Record<string, unknown> = {};
            const archivedObjectives = { ...dict(theirs.archivedObjectives), ...dict(mine.archivedObjectives) };
            const pendingObjectives = { ...dict(theirs.pendingObjectives), ...dict(mine.pendingObjectives) };
            const incompatibleObjectives = { ...dict(mine.incompatibleObjectives), ...dict(theirs.incompatibleObjectives) };
            for (const id of new Set([...Object.keys(myObjectives), ...Object.keys(theirObjectives)])) {
                const expected = activeDefinitions[id];
                if (expected === undefined && archivedObjectives[id] && !pendingObjectives[id]) continue;
                const accepts = (definition: unknown): boolean => expected === undefined || definition === expected;
                const a = accepts(myDefinitions[id]) ? myObjectives[id] : undefined;
                const b = accepts(theirDefinitions[id]) ? theirObjectives[id] : undefined;
                for (const [value, definition] of [[myObjectives[id], myDefinitions[id]], [theirObjectives[id], theirDefinitions[id]]]) {
                    if (value && !accepts(definition)) incompatibleObjectives[JSON.stringify([id, definition])] = { definition, progress: value };
                }
                // A different objective's answer must not advance this clock.
                const clock = (value: unknown): number => isRecord(value) ? Math.max(numberOr0(value.updatedAt), numberOr0(value.lastSeenAt), numberOr0(value.lastSuccessAt)) : 0;
                const chosen = a === undefined || (!keepCurrent && clock(b) > clock(a)) ? b : a;
                if (chosen !== undefined) {
                    objectives[id] = chosen;
                    witnesses[id] = chosen === b ? theirDefinitions[id] : myDefinitions[id];
                }
            }
            const suggestions = new Map<string, Record<string, unknown>>();
            for (const source of [mine, theirs]) {
                const defs = source === mine ? myDefinitions : theirDefinitions;
                if (!Array.isArray(source.scheduleSuggestions)) continue;
                for (const suggestion of source.scheduleSuggestions) {
                    if (!isRecord(suggestion) || typeof suggestion.objectiveId !== 'string') continue;
                    const id = suggestion.objectiveId;
                    if (!objectives[id] || (activeDefinitions[id] !== undefined && defs[id] !== activeDefinitions[id])) continue;
                    if (numberOr0(suggestion.madeAt) >= numberOr0(suggestions.get(id)?.madeAt)) suggestions.set(id, suggestion);
                }
            }
            progress[path] = {
                ...newer, objectives, objectiveDefinitions: witnesses,
                ...(!keepCurrent ? { workspace: mine.workspace } : {}),
                planFingerprint: plan.contentFingerprint ?? newer.planFingerprint,
                archivedObjectives, pendingObjectives,
                incompatibleObjectives, scheduleSuggestions: [...suggestions.values()],
                tutorMemory: mergedTutorMemory(mine.tutorMemory, theirs.tutorMemory),
            };
        }
        const localById = new Map<string, Record<string, unknown>>();
        if (Array.isArray(localSessions[path])) {
            for (const record of localSessions[path] as unknown[]) {
                if (isRecord(record) && typeof record.id === 'string') localById.set(record.id, record);
            }
        }
        const records = new Map<string, Record<string, unknown>>();
        for (const list of [mineCurrent ? localSessions[path] : undefined, theirsCurrent ? otherSessions[path] : undefined]) {
            if (!Array.isArray(list)) continue;
            for (const record of list) {
                if (!isRecord(record) || typeof record.id !== 'string') continue;
                const previous = records.get(record.id);
                const clock = (entry: Record<string, unknown>): number => numberOr0(entry.updatedAt ?? entry.endedAt ?? entry.startedAt);
                if (!previous || (!keepCurrent && clock(record) > clock(previous))) {
                    // A portable record has no transcript/summary; never let it
                    // erase the fuller copy that exists on this device.
                    const local = localById.get(record.id);
                    const merged = { ...record };
                    if ((!Array.isArray(merged.transcript) || merged.transcript.length === 0) && Array.isArray(local?.transcript)) {
                        merged.transcript = local?.transcript ?? [];
                    }
                    if ((merged.summary === null || merged.summary === undefined) && typeof local?.summary === 'string') {
                        merged.summary = local?.summary ?? merged.summary;
                    }
                    records.set(record.id, merged);
                }
            }
        }
        if (localSessions[path] || otherSessions[path]) sessions[path] = [...records.values()].sort((a, b) => numberOr0(b.startedAt) - numberOr0(a.startedAt)).slice(0, 200);
    }
    return { studyPlans: plans, studyProgress: progress, studySessions: sessions };
}

function mergeCounters(current: unknown, incoming: unknown): unknown {
    if (!isRecord(current)) return incoming;
    if (!isRecord(incoming)) return current;
    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
        const mine = merged[key];
        if (typeof value === 'number' && typeof mine === 'number') merged[key] = Math.max(mine, value);
        else if (isRecord(value) && isRecord(mine)) merged[key] = mergeCounters(mine, value);
        else if (mine === undefined) merged[key] = value;
    }
    return merged;
}

/** Parse an envelope, refusing anything that is not one. */
export function parseProgress(raw: string | null): ProgressEnvelope | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<ProgressEnvelope> | null;
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.rev !== 'number' || typeof parsed.updatedAt !== 'number') return null;
        if (!isRecord(parsed.state) && !isRecord(parsed.settings)) return null;
        return {
            schema: typeof parsed.schema === 'number' ? parsed.schema : 0,
            rev: parsed.rev,
            updatedAt: parsed.updatedAt,
            device: typeof parsed.device === 'string' ? parsed.device : 'unknown',
            version: typeof parsed.version === 'string' ? parsed.version : '',
            settings: parsed.settings ?? {},
            state: parsed.state ?? {},
        };
    } catch {
        return null;
    }
}

/**
 * Whether a file name is a sync tool's copy of the projection.
 *
 * Dropbox writes "name (conflicted copy 2026-10-21).json", Syncthing writes
 * "name.sync-conflict-20261021-120000-ABCDEF.json", iCloud and Obsidian's own
 * mobile sync write "name 2.json", and Obsidian duplicates as "name (1).json".
 * Each of them holds a real version of the progress, so each is read and merged
 * rather than ignored.
 */
export function isProgressConflictCopy(name: string): boolean {
    if (name === 'progress.json') return false;
    if (!name.endsWith('.json')) return false;
    return /conflict/i.test(name) || /\s\d+\.json$/.test(name) || /\(\d+\)\.json$/.test(name) || /\.sync-conflict-/i.test(name);
}

/** The newest projection in a folder, including any conflicted copies. */
export async function readNewestProgress(adapter: ProgressAdapter): Promise<{ envelope: ProgressEnvelope; path: string; copies: string[] } | null> {
    const candidates: { envelope: ProgressEnvelope; path: string }[] = [];
    const copies: string[] = [];
    const own = parseProgress(await readOrNull(adapter, PROGRESS_FILE));
    if (own) candidates.push({ envelope: own, path: PROGRESS_FILE });

    try {
        const listing = await adapter.list(PROGRESS_DIR);
        for (const entry of listing.files) {
            // Obsidian's adapter lists **vault-relative paths**
            // ("spaceforge/state/progress.json"), not bare names; a Node-style
            // adapter lists bare names. Accept both, or every conflict copy is
            // silently skipped.
            const name = entry.slice(entry.lastIndexOf('/') + 1);
            if (!isProgressConflictCopy(name)) continue;
            const path = entry.includes('/') ? entry : `${PROGRESS_DIR}/${entry}`;
            const parsed = parseProgress(await readOrNull(adapter, path));
            if (!parsed) continue;
            candidates.push({ envelope: parsed, path });
            copies.push(name);
        }
    } catch {
        // No folder yet: the projection has never been written here.
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.envelope.rev - a.envelope.rev) || (b.envelope.updatedAt - a.envelope.updatedAt));
    return { envelope: candidates[0].envelope, path: candidates[0].path, copies };
}

async function readOrNull(adapter: ProgressAdapter, path: string): Promise<string | null> {
    try {
        if (adapter.exists && !(await adapter.exists(path))) return null;
        return await adapter.read(path);
    } catch {
        return null;
    }
}

/**
 * Write the projection, unless the text is the one already there.
 *
 * In place, with the previous copy kept under a permanent name. The temp-then-
 * rename dance this used to do is atomic, and it is exactly what makes a sync
 * client complain: the file appears, is uploaded, and is renamed away while the
 * upload is in flight, so Nextcloud, iCloud and the rest log an error on every
 * save. Both names here are permanent — nothing appears and vanishes.
 */
export async function writeProgress(
    adapter: ProgressAdapter,
    envelope: ProgressEnvelope,
    options: { lastHash?: string | null } = {},
): Promise<{ written: boolean; hash: string; path: string }> {
    const text = JSON.stringify(envelope, null, 2);
    const hash = hashOf(text);
    if (options.lastHash && options.lastHash === hash) return { written: false, hash, path: PROGRESS_FILE };
    try {
        if (adapter.mkdir) {
            try { await adapter.mkdir(PROGRESS_DIR); } catch { /* exists */ }
        }
        const previous = `${PROGRESS_FILE}.previous`;
        try {
            if (await adapter.exists(PROGRESS_FILE)) {
                const current = await adapter.read(PROGRESS_FILE);
                if (typeof current === 'string' && current.length > 0) await adapter.write(previous, current);
            }
        } catch {
            /* the copy is a courtesy; the write below is the job */
        }
        await adapter.write(PROGRESS_FILE, text);
        // A temp file left by an earlier version would be retried by a sync
        // client forever; clear it on the way past.
        try {
            const legacy = `${PROGRESS_FILE}.tmp`;
            if (await adapter.exists(legacy)) await adapter.remove?.(legacy);
        } catch { /* nothing to clear */ }
        return { written: true, hash, path: PROGRESS_FILE };
    } catch (error) {
        throw new Error(`could not write ${PROGRESS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Move conflicted copies out of the way once they are merged.
 *
 * They are renamed into `.merged/` rather than deleted: they are copies of the
 * reader's progress, and the merge is the only thing that has looked at them.
 */
export async function retireConflictCopies(adapter: ProgressAdapter, names: readonly string[]): Promise<string[]> {
    const moved: string[] = [];
    if (!adapter.rename) return moved;
    try { await adapter.mkdir?.(`${PROGRESS_DIR}/.merged`); } catch { /* exists */ }
    for (const name of names) {
        const from = `${PROGRESS_DIR}/${name}`;
        const to = `${PROGRESS_DIR}/.merged/${name}`;
        try {
            await adapter.rename(from, to);
            moved.push(name);
        } catch {
            // Left where it is; it will be read again next time, which is harmless.
        }
    }
    return moved;
}

/** FNV-1a over the text: enough to skip a rewrite, not a checksum of record. */
export function hashOf(text: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** A device id that says nothing about the machine. */
export function newDeviceId(): string {
    let id = '';
    for (let index = 0; index < 4; index += 1) id += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    return id;
}
