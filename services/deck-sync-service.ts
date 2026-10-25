/**
 * The vault side of the deck sync log.
 *
 * Each device writes only its own file — `spaceforge/sync/decks/<deckId>/<deviceId>.jsonl`
 * — so a file sync has nothing to conflict on: two devices never touch the same
 * path, and an answer is appended the moment it is given. Every reader of a
 * deck (the sidebar's counts, a sitting, an export) folds those logs in through
 * {@link DeckStore}, which makes the deck document a cache rather than the
 * only copy of the schedule.
 *
 * The device id lives in local storage, not in `data.json`: plugin data is
 * synced between a reader's devices, and a device id that travelled would give
 * both devices the same log file — the one thing this design must not do.
 *
 * Growth is bounded by compaction: once this device's file passes a size
 * threshold it is rewritten to one entry per card. That rewrite is safe for the
 * same reason the appends are: the file has exactly one writer.
 */
import SpaceforgePlugin from '../main';
import { AnkiCard, AnkiId, DeckBundle } from '../models/anki';
import {
    applySyncToBundle,
    decodeSyncEntries,
    encodeSyncEntry,
    DeckSyncEntry,
    syncFolderName,
} from '../models/deck-sync';

/** Where the per-device logs live, relative to the vault root. */
export const DECK_SYNC_ROOT = 'spaceforge/sync/decks';

/** The local-storage key the device id is kept under (per device, never synced). */
const DEVICE_KEY = 'spaceforge-device-id';

/** Rewrite this device's log once it grows past this many bytes. */
const COMPACT_BYTES = 512 * 1024;

/** What one read of the logs found. */
export interface DeckSyncRead {
    entries: DeckSyncEntry[];
    warnings: string[];
}

export class DeckSyncService {
    plugin: SpaceforgePlugin;
    private cachedDeviceId: string | null = null;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    /** This install's id: stable across reloads, different on every device. */
    deviceId(): string {
        if (this.cachedDeviceId !== null) return this.cachedDeviceId;
        const app = this.plugin.app;
        let stored: unknown = null;
        try {
            stored = typeof app.loadLocalStorage === 'function' ? app.loadLocalStorage(DEVICE_KEY) : null;
        } catch {
            stored = null;
        }
        if (typeof stored === 'string' && stored.trim() !== '') {
            this.cachedDeviceId = stored.trim();
            return this.cachedDeviceId;
        }
        const fresh = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        try {
            if (typeof app.saveLocalStorage === 'function') app.saveLocalStorage(DEVICE_KEY, fresh);
        } catch {
            // A storage that refuses still leaves this session with an id; a
            // second device would only tie on an identical millisecond.
        }
        this.cachedDeviceId = fresh;
        return fresh;
    }

    /** The folder holding every device's log for one deck. */
    folderFor(deckId: AnkiId): string {
        return `${DECK_SYNC_ROOT}/${syncFolderName(deckId)}`;
    }

    /** This device's own log file for one deck. */
    logPath(deckId: AnkiId): string {
        return `${this.folderFor(deckId)}/${this.deviceId()}.jsonl`;
    }

    /**
     * Append one answer to this device's log. Never throws: losing the log
     * entry must not lose the answer itself, which is written to the deck
     * document right after.
     */
    async record(deck: DeckBundle, card: AnkiCard): Promise<void> {
        if (card.mod === undefined || card.mod <= 0) return;
        const path = this.logPath(deck.deck.id);
        try {
            await this.ensureFolder(this.folderFor(deck.deck.id));
            const adapter = this.plugin.app.vault.adapter;
            const line = encodeSyncEntry(card);
            if (typeof adapter.append === 'function') {
                await adapter.append(path, line);
            } else {
                const existing = (await adapter.exists(path)) ? await adapter.read(path) : '';
                await adapter.write(path, existing + line);
            }
            await this.compactIfNeeded(path);
        } catch (error) {
            console.warn('[spaceforge] a card answer could not be written to the sync log', error);
        }
    }

    /** Every device's log for one deck, oldest file first (order is irrelevant). */
    async read(deckId: AnkiId): Promise<DeckSyncRead> {
        const warnings: string[] = [];
        const entries: DeckSyncEntry[] = [];
        const folder = this.folderFor(deckId);
        try {
            const adapter = this.plugin.app.vault.adapter;
            if (!(await adapter.exists(folder))) return { entries, warnings };
            const listed = await adapter.list(folder);
            for (const file of listed.files) {
                if (!file.toLowerCase().endsWith('.jsonl')) continue;
                const name = file.split('/').pop() ?? file;
                const device = name.replace(/\.jsonl$/i, '');
                entries.push(...decodeSyncEntries(await adapter.read(file), device, warnings));
            }
        } catch (error) {
            warnings.push(`the sync logs for this deck could not be read (${String(error)}).`);
        }
        return { entries, warnings };
    }

    /**
     * A deck as every device left it: the document's cards with each device's
     * newest answer folded in. Errors leave the deck exactly as it was read.
     */
    async mergeInto(bundle: DeckBundle): Promise<DeckBundle> {
        try {
            const { entries, warnings } = await this.read(bundle.deck.id);
            if (warnings.length > 0) warnings.forEach(warning => console.warn('[spaceforge]', warning));
            if (entries.length === 0) return bundle;
            return applySyncToBundle(bundle, entries).bundle;
        } catch (error) {
            console.warn('[spaceforge] the deck sync logs were skipped', error);
            return bundle;
        }
    }

    /**
     * Keep this device's log one entry per card once it gets large. Only this
     * device writes the file, so a rewrite cannot race another writer; an
     * interrupted rewrite loses at most the entries it was compacting into the
     * document's own state, which the next answer re-stamps anyway.
     */
    private async compactIfNeeded(path: string): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const stat = await adapter.stat?.(path);
        if (!stat || stat.size < COMPACT_BYTES) return;
        const device = this.deviceId();
        const entries = decodeSyncEntries(await adapter.read(path), device, []);
        const latest = new Map<string, DeckSyncEntry>();
        for (const entry of entries) {
            const previous = latest.get(entry.card.id);
            if (!previous || entry.mod >= previous.mod) latest.set(entry.card.id, entry);
        }
        const text = [...latest.values()]
            .sort((a, b) => a.card.id.localeCompare(b.card.id))
            .map(entry => JSON.stringify({ mod: entry.mod, card: entry.card }))
            .join('\n');
        await adapter.write(path, text.length > 0 ? `${text}\n` : '');
    }

    /** Create a folder and any parent it needs, through the adapter so a
     * non-note extension never has to be in the vault's index. */
    private async ensureFolder(path: string): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        let current = '';
        for (const segment of path.split('/')) {
            current = current.length > 0 ? `${current}/${segment}` : segment;
            if (!(await adapter.exists(current))) await adapter.mkdir(current);
        }
    }
}
