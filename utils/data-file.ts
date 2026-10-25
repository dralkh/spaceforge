/**
 * Reading and writing the plugin's data file without ever losing it.
 *
 * Two failure modes have cost real data:
 *
 * 1. A write that is interrupted (quick restart, aggressive reload, a killed
 *    process) leaves a truncated `data.json`, because Obsidian's own save opens the
 *    file, truncates it and then writes. Writing to a temp file and renaming over the
 *    target makes the switch atomic: the old file is either fully there or fully
 *    replaced.
 * 2. Loading an unreadable file used to fall back to defaults *silently*, and the
 *    next autosave wrote those defaults over the only copy of the user's data.
 *    Anything unreadable is now preserved, and the load path looks for the last
 *    known good copy and any backups before it gives up.
 *
 * The adapter is duck-typed so this can be unit tested against an in-memory file map.
 *
 * Why the Adapter API: everything here reads and writes files inside
 * `.obsidian/plugins/spaceforge/`, which the Vault API does not address (it covers
 * the vault's notes, not the app's own configuration directory). The write is also
 * deliberately not `Vault.process`: it is a whole-file replace through a temp file
 * and a rename, so a crash mid-write cannot leave a half-written data file behind.
 */

/** The slice of Obsidian's DataAdapter this module needs. */
export interface DataFileAdapter {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    exists(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
    mkdir?(path: string): Promise<void>;
}

/** A file that could stand in for the data file, with what it holds. */
export interface DataFileCandidate {
    /** File name (no directory). */
    name: string;
    /** Full path, usable with the adapter. */
    path: string;
    /** Last modified, ms. */
    mtime: number;
    /** Number of schedules inside. */
    schedules: number;
    /** Number of history entries inside. */
    history: number;
    /** The parsed body, ready to merge. */
    data: PluginDataShape;
}

/** What the plugin stores: settings plus the scheduling state. */
export interface PluginDataShape {
    settings?: unknown;
    pluginState?: unknown;
}

/** The pluginState side of a stored body, as a plain record. */
function pluginStateRecord(data: PluginDataShape | null): Record<string, unknown> {
    const state = data?.pluginState;
    return state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : {};
}

const DATA_FILE = 'data.json';

/** The file name a given data path uses (frozen: changing it strands user data). */
export function dataFileName(): string {
    return DATA_FILE;
}

/** True for a raw file body that cannot be a saved state (empty or cut off). */
export function isUnusableDataBody(raw: string): boolean {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return true;
    // A truncated write can also stop mid-object; anything that does not parse is
    // unusable for our purposes.
    try {
        JSON.parse(trimmed);
        return false;
    } catch {
        return true;
    }
}

/** Parse a raw body, or null when it is not a usable saved state. */
export function parsePluginData(raw: string | null): PluginDataShape | null {
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

/** Schedules inside a parsed body. */
export function schedulesOf(data: PluginDataShape | null): Record<string, unknown> {
    const schedules = pluginStateRecord(data).schedules;
    return schedules && typeof schedules === 'object' && !Array.isArray(schedules) ? schedules as Record<string, unknown> : {};
}

/** History entries inside a parsed body. */
export function historyOf(data: PluginDataShape | null): unknown[] {
    const history = pluginStateRecord(data).history;
    return Array.isArray(history) ? history : [];
}

/**
 * Write JSON so a crash cannot cost the state, without ever leaving a file that
 * appears and vanishes.
 *
 * The old swap wrote `<path>.tmp`, moved the live file aside and renamed the temp
 * into place. That is atomic, and it is wrong for a synced folder: Nextcloud,
 * iCloud, Dropbox and OneDrive all try to upload the file the moment it appears,
 * lose it to the rename a millisecond later, and report an error — every save, for
 * every reader who keeps `.obsidian` in a synced folder. The reader's words: the
 * notifications were "not acceptable".
 *
 * So the write is now a plain in-place write, guarded by a complete copy of the
 * file it is about to replace:
 *
 *   write <path>.previous   the state that is on disk right now, in full
 *   write <path>            the new state
 *
 * Both names are permanent, so a sync client only ever sees files change (which it
 * handles), never files disappear. A crash during the second write leaves `.previous`
 * holding the last complete state, and the loader already prefers it over a file it
 * cannot parse.
 */
export async function writeJsonAtomically(
    adapter: DataFileAdapter,
    path: string,
    value: unknown,
    onWarning?: (message: string) => void,
): Promise<void> {
    const body = JSON.stringify(value, null, 2);
    const previousPath = `${path}.previous`;

    // Keep what is on disk before overwriting it. A failure here is not fatal —
    // the write below is what the reader is waiting for — but it is worth saying.
    try {
        if (await adapter.exists(path)) {
            const current = await adapter.read(path);
            if (typeof current === 'string' && current.length > 0) {
                await adapter.write(previousPath, current);
            }
        }
    } catch (error) {
        onWarning?.(`Could not refresh ${previousPath} (${String(error)}); keeping the older copy.`);
    }

    try {
        await adapter.write(path, body);
    } catch (error) {
        onWarning?.(`Save failed: ${String(error)}`);
        throw error;
    }

    // Leftovers from the temp-file era: the file may still be on disk from an
    // earlier version, and a sync client would keep retrying it forever.
    try {
        const legacyTemp = `${path}.tmp`;
        if (await adapter.exists(legacyTemp)) await adapter.remove(legacyTemp);
    } catch {
        /* nothing to clean, or the adapter refused; not a save failure */
    }
}

/** Read a file, returning null when it does not exist or cannot be read. */
export async function readTextOrNull(adapter: DataFileAdapter, path: string): Promise<string | null> {
    try {
        return await adapter.read(path);
    } catch {
        return null;
    }
}

/**
 * Files that may stand in for the data file, best first.
 *
 * Ranked by how much scheduling state they hold (losing reviews is worse than
 * reviving a note), then by modification time. `data.json` itself is not a
 * candidate - the caller only asks when that one is unusable.
 */
export async function collectRecoverableCandidates(
    adapter: DataFileAdapter,
    directory: string,
    baseName: string = DATA_FILE,
    mtimeOf?: (path: string) => Promise<number>,
): Promise<DataFileCandidate[]> {
    let files: string[] = [];
    try {
        const listing = await adapter.list(directory);
        files = listing.files ?? [];
    } catch {
        return [];
    }

    const candidates: DataFileCandidate[] = [];
    for (const filePath of files) {
        const name = filePath.substring(filePath.lastIndexOf('/') + 1);
        if (!isRecoverableName(name, baseName)) continue;
        const raw = await readTextOrNull(adapter, filePath);
        const parsed = parsePluginData(raw);
        if (!parsed) continue;
        candidates.push({
            name,
            path: filePath,
            mtime: mtimeOf ? await mtimeOf(filePath) : 0,
            schedules: Object.keys(schedulesOf(parsed)).length,
            history: historyOf(parsed).length,
            data: parsed,
        });
    }

    return candidates.sort((a, b) => (b.schedules - a.schedules) || (b.mtime - a.mtime));
}

/** True for names that hold a previous copy of the data file. */
export function isRecoverableName(name: string, baseName: string = DATA_FILE): boolean {
    if (name === baseName) return false;
    // The temp file only ever holds a *complete* new state (it is written before the
    // swap), so it is a legitimate recovery source; a partial one will not parse.
    if (name === `${baseName}.tmp`) return true;
    if (name.endsWith('.tmp')) return false;
    if (name.startsWith(`${baseName}.`)) return true;              // data.json.good, .previous, .backup-*, .bak-*, .corrupt-*

    // Sync clients (Nextcloud, iCloud, Dropbox) keep their conflicted copies next to
    // the file as "data (conflicted copy ...).json" - named after the stem, not the
    // full name - and those have saved users' data more than once.
    const stem = baseName.replace(/\.[^.]*$/, '');
    return name.startsWith(`${stem} (`) && name.toLowerCase().endsWith('.json');
}

/**
 * Fold a candidate into the current state: schedules the current state does not
 * have are added, everything it does have is left exactly as it is, and history
 * entries are unioned (by path and timestamp).
 */
export function mergePluginStates<T extends PluginDataShape>(
    current: T,
    incoming: PluginDataShape | null,
): { merged: T; addedSchedules: string[]; addedHistory: number } {
    if (!incoming) return { merged: current, addedSchedules: [], addedHistory: 0 };

    const currentSchedules = { ...schedulesOf(current) };
    const incomingSchedules = schedulesOf(incoming);
    const addedSchedules: string[] = [];
    for (const [path, schedule] of Object.entries(incomingSchedules)) {
        if (path in currentSchedules) continue;
        currentSchedules[path] = schedule;
        addedSchedules.push(path);
    }

    const currentHistory = [...historyOf(current)];
    const seen = new Set(currentHistory.map(entry => historyKey(entry)));
    let addedHistory = 0;
    for (const entry of historyOf(incoming)) {
        const key = historyKey(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        currentHistory.push(entry);
        addedHistory += 1;
    }

    const merged = {
        ...current,
        pluginState: {
            ...pluginStateRecord(current),
            schedules: currentSchedules,
            history: currentHistory,
        },
    } as T;
    return { merged, addedSchedules, addedHistory };
}

function historyKey(entry: unknown): string {
    if (!entry || typeof entry !== 'object') return String(entry);
    const record = entry as { path?: unknown; timestamp?: unknown; response?: unknown };
    return `${String(record.path)}@${String(record.timestamp)}#${String(record.response)}`;
}

/** Where an unusable file is moved so nothing is lost and the cause stays inspectable. */
export function corruptBackupPath(path: string, now: number): string {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${path}.corrupt-${stamp}`;
}

/** The last-known-good copy that is refreshed after every clean load. */
export function goodCopyPath(path: string): string {
    return `${path}.good`;
}
