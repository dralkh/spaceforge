/**
 * The vault side of the deck format: reading, writing, importing and
 * exporting the deck documents that live under `spaceforge/decks/`, with
 * their media beside them in `spaceforge/decks/media/`.
 *
 * The format itself (and everything that can be tested without a vault) lives
 * in `models/deck-document.ts`; this service is the part that touches
 * Obsidian: it finds deck files, creates the folders, moves bytes, and
 * reports what it found.
 *
 * Two rules shape the code here:
 *
 * - a deck file is human property. Writing a deck rewrites the whole file
 *   (which is what "save this deck" means), but {@link DeckStore.updateCardStates}
 *   — the path the reviewer uses on every answer — rewrites only the state
 *   lines and their `modified:` stamp, so nothing a human typed is disturbed;
 * - deleting goes through the file manager, never straight to the vault, so
 *   the user's own trash preference decides what actually happens.
 */
import { TFile } from 'obsidian';

import SpaceforgePlugin from '../main';
import {
    AnkiCard,
    AnkiCardQueue,
    AnkiId,
    DeckBundle,
    DeckCounts,
    DeckMediaFile,
    DeckOptions,
    DECKS_FOLDER,
    DECKS_MEDIA_FOLDER,
    ImportReport,
} from '../models/anki';
import {
    DeckParseResult,
    bundleMediaReferences,
    cardIdOfStateLine,
    deckDocumentPath,
    isDeckDocumentPath,
    newDeck,
    parseDeckWithWarnings,
    rewriteMediaPaths,
    sanitizeDeckFileName,
    serializeDeck,
    updateCardStateLine,
} from '../models/deck-document';

/** What a deck list shows for one deck, read out of its state lines. */
export interface DeckSummary {
    /** Vault path of the deck document. */
    path: string;
    /** The deck's name, as its frontmatter spells it. */
    name: string;
    id: AnkiId;
    /** Card counts from the stored scheduling state (see {@link deckCountsFrom}). */
    counts: DeckCounts;
    /** Distinct media files the deck uses (see {@link deckMediaCount}). */
    mediaCount: number;
    /** When the deck file was last written. */
    modified: number;
    /** Anything the parse had to work around, for a warning strip. */
    warnings: string[];
}

/** A deck read for export, with its media resolved to bytes. */
export interface DeckExportPackage {
    bundle: DeckBundle;
    /** Every media file the deck lists, with its bytes. */
    media: { file: DeckMediaFile; bytes: ArrayBuffer }[];
    /** Listed media that is no longer in the vault, by original name. */
    missing: string[];
}

/** What an import can be told. */
export interface DeckImportOptions {
    /** Write here instead of making a fresh file (used when re-importing). */
    path?: string;
    /** Rename the deck on the way in. */
    name?: string;
    /** The bytes for the bundle's media files, keyed by the name cards use. */
    mediaBytes?: Map<string, ArrayBuffer> | Record<string, ArrayBuffer>;
}

/**
 * Anki's own counts, read from the stored card states.
 *
 * This is a quick read of the file, not the scheduler: new/learning/review are
 * counted by the queue each card sits in, and `dueToday` counts cards that are
 * neither suspended nor buried whose due time has passed (a new card is
 * available right away). `models/anki-scheduler.ts` owns the authoritative
 * counts, once it exists.
 */
export function deckCountsFrom(cards: AnkiCard[], now: number = Date.now()): DeckCounts {
    let newCount = 0;
    let learningCount = 0;
    let reviewCount = 0;
    let dueToday = 0;
    for (const card of cards) {
        const hidden = card.queue === AnkiCardQueue.Suspended
            || card.queue === AnkiCardQueue.SchedBuried
            || card.queue === AnkiCardQueue.UserBuried;
        if (card.queue === AnkiCardQueue.New) newCount += 1;
        else if (card.queue === AnkiCardQueue.Learning) learningCount += 1;
        else if (card.queue === AnkiCardQueue.Review) reviewCount += 1;
        if (!hidden && card.due <= now) dueToday += 1;
    }
    return { newCount, learningCount, reviewCount, totalCards: cards.length, dueToday };
}

/**
 * How many distinct media files a deck uses: the media it lists, plus whatever
 * its card text names, counted by file name so a rewritten path does not count
 * twice.
 */
export function deckMediaCount(bundle: DeckBundle): number {
    const names = new Set<string>();
    for (const reference of bundleMediaReferences(bundle)) names.add(reference.split('/').pop() ?? reference);
    for (const entry of bundle.media) names.add(entry.originalName.split('/').pop() ?? entry.originalName);
    return names.size;
}

/** MIME types guessed from a media file's extension, when known. */
const MEDIA_MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
};

/** The MIME type for a file name, when the extension says so. */
export function mediaMimeType(name: string): string | undefined {
    const extension = name.split('.').pop()?.toLowerCase();
    return extension ? MEDIA_MIME_TYPES[extension] : undefined;
}

/** The store: one instance per plugin, like the other services. */
export class DeckStore {
    plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    // ------------------------------------------------------------ listing

    /** Every deck in the vault, by name. */
    async listDecks(): Promise<DeckSummary[]> {
        const summaries: DeckSummary[] = [];
        for (const file of this.deckFiles()) {
            try {
                const { bundle, warnings } = await this.readDeckFile(file);
                summaries.push({
                    path: file.path,
                    name: bundle.deck.name,
                    id: bundle.deck.id,
                    counts: deckCountsFrom(bundle.cards),
                    mediaCount: deckMediaCount(bundle),
                    modified: bundle.deck.modified || file.stat.mtime,
                    warnings,
                });
            } catch {
                // A file that cannot be read at all is skipped; it will show
                // up again (and be reported) on the next scan.
                continue;
            }
        }
        summaries.sort((a, b) => a.name.localeCompare(b.name));
        return summaries;
    }

    /** Read one deck, throwing when there is nothing at that path. */
    async readDeck(path: string): Promise<DeckBundle> {
        return (await this.readDeckWithWarnings(path)).bundle;
    }

    /** Read one deck, keeping the warnings the file produced. */
    async readDeckWithWarnings(path: string): Promise<DeckParseResult> {
        return await this.readDeckFile(this.fileAt(path));
    }

    /** The path of the deck document with this Anki id, or null. */
    async pathForDeck(deckId: AnkiId): Promise<string | null> {
        for (const file of this.deckFiles()) {
            try {
                const { bundle } = await this.readDeckFile(file);
                if (bundle.deck.id === deckId) return file.path;
            } catch {
                continue;
            }
        }
        return null;
    }

    // ------------------------------------------------------------ writing

    /**
     * Serialize a deck and write it, creating the folders on the way.
     *
     * The deck's `modified` stamp is set to now. Without an explicit path the
     * store reuses the file that already holds this deck (matched by id) and
     * otherwise makes a fresh, collision-free name. Returns the path written.
     */
    async writeDeck(bundle: DeckBundle, path?: string): Promise<string> {
        const target = path
            ?? (await this.pathForDeck(bundle.deck.id))
            ?? deckDocumentPath(bundle.deck.name, this.deckPaths());
        await this.ensureFolder(DECKS_FOLDER);
        bundle.deck.modified = Date.now();
        const text = serializeDeck(bundle);
        const existing = this.plugin.app.vault.getAbstractFileByPath(target);
        if (existing instanceof TFile) await this.plugin.app.vault.modify(existing, text);
        else await this.plugin.app.vault.create(target, text);
        return target;
    }

    /** Make an empty deck and write it. */
    async createDeck(name: string, options?: Partial<DeckOptions>): Promise<{ path: string; bundle: DeckBundle }> {
        const bundle = newDeck(name, options);
        const path = await this.writeDeck(bundle, deckDocumentPath(name, this.deckPaths()));
        return { path, bundle };
    }

    /**
     * Rename a deck (Anki hierarchy names included) and move its file to the
     * matching name. Media files stay where they are: they are shared by name
     * with the rest of the vault.
     */
    async renameDeck(path: string, newName: string): Promise<string> {
        const file = this.fileAt(path);
        const bundle = await this.readDeckFile(file);
        bundle.bundle.deck.name = newName;

        const taken = this.deckPaths().filter(existing => existing !== path);
        const target = deckDocumentPath(newName, taken);
        if (target !== path) await this.plugin.app.fileManager.renameFile(file, target);
        await this.writeDeck(bundle.bundle, target);
        return target;
    }

    /** Move a deck to the trash, the way the user's settings prefer. */
    async deleteDeck(path: string): Promise<void> {
        const file = this.fileAt(path);
        await this.plugin.app.fileManager.trashFile(file);
    }

    // ------------------------------------------------------------ media

    /**
     * Put a file into `spaceforge/decks/media/` and return its vault path.
     *
     * The name is sanitized (a package may name a file anything) and made
     * collision-safe: a second `nucleus.png` becomes `nucleus-1.png` rather
     * than overwriting the first, because two decks may both ship a
     * `nucleus.png` that is not the same picture.
     */
    async saveMedia(deckName: string, originalName: string, bytes: ArrayBuffer): Promise<string> {
        await this.ensureFolder(DECKS_MEDIA_FOLDER);
        const bare = originalName.split(/[\\/]/).pop() ?? originalName;
        const safe = sanitizeDeckFileName(bare) || sanitizeDeckFileName(deckName) || 'media';
        let path = `${DECKS_MEDIA_FOLDER}/${safe}`;
        let counter = 1;
        while (this.plugin.app.vault.getAbstractFileByPath(path)) {
            path = `${DECKS_MEDIA_FOLDER}/${withSuffix(safe, counter)}`;
            counter += 1;
        }
        await this.plugin.app.vault.createBinary(path, bytes);
        return path;
    }

    /** The bytes of a media file. */
    async readMedia(path: string): Promise<ArrayBuffer> {
        return await this.plugin.app.vault.readBinary(this.fileAt(path));
    }

    /** Everything in the media folder, by path. */
    listMedia(): DeckMediaFile[] {
        const prefix = `${DECKS_MEDIA_FOLDER}/`;
        const media = this.plugin.app.vault.getFiles()
            .filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes('/'))
            .map(file => {
                const entry: DeckMediaFile = { path: file.path, originalName: file.name, size: file.stat.size };
                const mime = mediaMimeType(file.name);
                if (mime !== undefined) entry.mime = mime;
                return entry;
            });
        media.sort((a, b) => a.path.localeCompare(b.path));
        return media;
    }

    /** Move one media file to the trash. */
    async deleteMedia(path: string): Promise<void> {
        await this.plugin.app.fileManager.trashFile(this.fileAt(path));
    }

    /**
     * Media the deck's text references that is not in the vault, by the
     * reference as written. Both a vault path and a bare file name (looked up
     * in the media folder) count as present. This reads the vault's in-memory
     * file list, so it does not need to be awaited.
     */
    missingMedia(bundle: DeckBundle): string[] {
        const present = new Set(this.listMedia().map(entry => entry.path));
        const missing: string[] = [];
        for (const reference of bundleMediaReferences(bundle)) {
            if (this.plugin.app.vault.getAbstractFileByPath(reference)) continue;
            if (present.has(`${DECKS_MEDIA_FOLDER}/${reference}`)) continue;
            missing.push(reference);
        }
        return missing;
    }

    // ------------------------------------------------------------ import / export

    /**
     * Write an imported deck into the vault: media first (so the text can
     * point at it), then the card text rewritten to the vault paths, then the
     * deck file itself. An import that fails halfway therefore leaves the
     * original bundle untouched and no half-linked deck on disk.
     *
     * The bundle is used, not copied: its deck name is whatever `options.name`
     * says, and its `modified` stamp ends up as the file's. The media list on
     * the report is the one that was written (vault paths and all); the
     * caller's own `bundle.media` array is left as it arrived.
     */
    async importBundle(bundle: DeckBundle, options: DeckImportOptions = {}): Promise<ImportReport> {
        const name = options.name ?? bundle.deck.name;
        bundle.deck.name = name;

        // Where the deck lands: an explicit path, an earlier import of the
        // same deck, or a fresh name.
        let path = options.path ?? null;
        let replaced = path !== null && this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile;
        if (path === null) {
            const existing = await this.pathForDeck(bundle.deck.id);
            if (existing !== null) {
                path = existing;
                replaced = true;
            } else {
                path = deckDocumentPath(name, this.deckPaths());
            }
        }

        // Media first.
        const bytesByName = toMediaMap(options.mediaBytes);
        const warnings: string[] = [];
        const missingMedia: string[] = [];
        const saved = new Map<string, string>();
        const media: DeckMediaFile[] = [];
        let mediaImported = 0;

        const save = async (originalName: string, bytes: ArrayBuffer): Promise<string> => {
            const known = saved.get(originalName);
            if (known !== undefined) return known;
            const savedPath = await this.saveMedia(name, originalName, bytes);
            saved.set(originalName, savedPath);
            mediaImported += 1;
            return savedPath;
        };

        for (const entry of bundle.media) {
            const bytes = bytesByName.get(entry.originalName)
                ?? bytesByName.get(entry.path.split('/').pop() ?? entry.path);
            if (!bytes) {
                missingMedia.push(entry.originalName || entry.path);
                media.push(entry);
                continue;
            }
            const savedPath = await save(entry.originalName || entry.path, bytes);
            const file: DeckMediaFile = { path: savedPath, originalName: entry.originalName || entry.path };
            const mime = entry.mime ?? mediaMimeType(savedPath);
            if (mime !== undefined) file.mime = mime;
            file.size = bytes.byteLength;
            media.push(file);
        }

        // Media the cards use but the bundle did not list: save it too, or the
        // card would point at a file nobody put in the vault.
        const referenced = bundleMediaReferences(bundle);
        for (const reference of referenced) {
            const bare = reference.split('/').pop() ?? reference;
            const bytes = bytesByName.get(reference) ?? bytesByName.get(bare);
            if (!bytes || saved.has(bare) || saved.has(reference)) continue;
            const savedPath = await save(bare, bytes);
            const file: DeckMediaFile = { path: savedPath, originalName: bare };
            const mime = mediaMimeType(savedPath);
            if (mime !== undefined) file.mime = mime;
            file.size = bytes.byteLength;
            media.push(file);
            warnings.push(`Saved "${bare}", which the cards use but the deck did not list.`);
        }

        if (missingMedia.length > 0) {
            warnings.push(`${missingMedia.length} media file(s) had no content to write.`);
        }

        // Then the text, so it points at where the media actually went.
        const resolver = (reference: string): string | null => {
            const exact = saved.get(reference);
            if (exact !== undefined) return exact;
            const bare = reference.split('/').pop() ?? reference;
            return saved.get(bare) ?? null;
        };
        const rewritten = rewriteMediaPaths(bundle, resolver);

        // Then the deck file.
        const outgoing: DeckBundle = { ...bundle, notes: rewritten.notes, media };
        const deckPath = await this.writeDeck(outgoing, path);

        return {
            deckPath,
            deckName: name,
            notesImported: outgoing.notes.length,
            cardsImported: outgoing.cards.length,
            mediaImported,
            missingMedia,
            warnings,
            replaced,
        };
    }

    /**
     * Read a deck for the package writer: the bundle, plus its media resolved
     * back to bytes. Media that has gone missing is reported rather than
     * failing the export, so a broken picture never blocks a whole deck.
     */
    async exportBundle(path: string): Promise<DeckExportPackage> {
        const { bundle } = await this.readDeckWithWarnings(path);
        const media: { file: DeckMediaFile; bytes: ArrayBuffer }[] = [];
        const missing: string[] = [];
        for (const entry of bundle.media) {
            const file = this.plugin.app.vault.getAbstractFileByPath(entry.path);
            if (file instanceof TFile) {
                media.push({ file: entry, bytes: await this.plugin.app.vault.readBinary(file) });
            } else {
                missing.push(entry.originalName || entry.path);
            }
        }
        return { bundle, media, missing };
    }

    // ------------------------------------------------------------ scheduling state

    /**
     * Write new scheduling state for `cards` back to the deck file.
     *
     * The state lines are rewritten in place: the question/answer text, the
     * note payloads, the frontmatter options and any prose keep the exact
     * bytes they already had, and only the `modified:` stamp changes with
     * them. When a card has no state line to update (a hand-added card, or a
     * line whose JSON was too broken to read), the whole file is rewritten
     * from the parsed bundle instead — which says so in the return value.
     */
    async updateCardStates(path: string, cards: AnkiCard[]): Promise<'in-place' | 'rewritten'> {
        const file = this.fileAt(path);
        const text = await this.plugin.app.vault.read(file);
        if (cards.length === 0) return 'in-place';
        const { bundle } = parseDeckWithWarnings(text, path);
        const byId = new Map(cards.map(card => [card.id, card]));

        const lines = text.split('\n');
        const updated = new Set<AnkiId>();
        for (let i = 0; i < lines.length; i++) {
            const id = cardIdOfStateLine(lines[i]);
            if (id === null) continue;
            const card = byId.get(id);
            if (!card) continue;
            const line = updateCardStateLine(lines[i], card, bundle.deck.id);
            if (line === null) continue;
            lines[i] = line;
            updated.add(id);
        }

        if (updated.size === byId.size) {
            // The stamp always moves, even when two writes land in the same
            // millisecond, so a reader can tell the file was saved.
            const modified = Math.max(Date.now(), bundle.deck.modified + 1);
            await this.plugin.app.vault.modify(file, withModifiedStamp(lines.join('\n'), modified));
            return 'in-place';
        }

        // A full rewrite: keep every card the file has, take the new state for
        // the ones it knows about, append the ones it does not.
        const merged = bundle.cards.map(existing => byId.get(existing.id) ?? existing);
        for (const card of cards) {
            if (!merged.some(existing => existing.id === card.id)) merged.push(card);
        }
        bundle.cards = merged;
        for (const note of bundle.notes) {
            note.cardIds = merged.filter(card => card.noteId === note.id).map(card => card.id);
        }
        await this.writeDeck(bundle, path);
        return 'rewritten';
    }

    // ------------------------------------------------------------ internals

    /** The deck document at a path, or a clear failure. */
    private fileAt(path: string): TFile {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`Deck file not found: ${path}`);
        return file;
    }

    /** Deck documents, in the vault's own order. */
    private deckFiles(): TFile[] {
        return this.plugin.app.vault.getFiles().filter(file => isDeckDocumentPath(file.path));
    }

    /** The vault paths deck documents already use. */
    private deckPaths(): string[] {
        return this.deckFiles().map(file => file.path);
    }

    private async readDeckFile(file: TFile): Promise<DeckParseResult> {
        const text = await this.plugin.app.vault.read(file);
        return parseDeckWithWarnings(text, file.path);
    }

    /** Create a folder and any parent it needs. */
    private async ensureFolder(path: string): Promise<void> {
        let current = '';
        for (const segment of path.split('/')) {
            current = current.length > 0 ? `${current}/${segment}` : segment;
            if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
                await this.plugin.app.vault.createFolder(current);
            }
        }
    }
}

/** `nucleus.png` + 1 -> `nucleus-1.png`. */
function withSuffix(name: string, counter: number): string {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name}-${counter}`;
    return `${name.slice(0, dot)}-${counter}${name.slice(dot)}`;
}

/** A lookup map for whatever shape the caller's media bytes arrived in. */
function toMediaMap(source: DeckImportOptions['mediaBytes']): Map<string, ArrayBuffer> {
    const map = new Map<string, ArrayBuffer>();
    if (!source) return map;
    if (source instanceof Map) {
        for (const [name, bytes] of source) map.set(name, bytes);
        return map;
    }
    for (const [name, bytes] of Object.entries(source)) map.set(name, bytes);
    return map;
}

/** Refresh the `modified:` stamp of a document whose lines were just edited. */
function withModifiedStamp(text: string, modified: number): string {
    const lines = text.split('\n');
    if ((lines[0] ?? '').trim() !== '---') return text;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') break;
        if (/^modified\s*:/.test(lines[i])) {
            lines[i] = `modified: ${modified}`;
            break;
        }
    }
    return lines.join('\n');
}
