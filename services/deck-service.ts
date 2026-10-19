/**
 * The Anki interoperability service: one `.apkg` in, one deck in the vault,
 * and a deck back out as a `.apkg`.
 *
 * This is the seam between the two layers that each know half the job:
 *
 * - `api/anki/apkg.ts` and `api/anki/apkg-write.ts` speak Anki's container (a
 *   ZIP holding a SQLite collection, a media map and the media bytes);
 * - `models/deck-document.ts` and `services/deck-store.ts` speak the vault (a
 *   markdown deck under `spaceforge/decks/`, its media beside it under
 *   `spaceforge/decks/media/`, and card text pointing at where the store put
 *   the files).
 *
 * The service does the translation and nothing else: the store does every
 * vault write, and the package layer does every byte-level parse.
 *
 * Import
 * ------
 *
 * {@link DeckService.importApkg} reads the package, writes the media through
 * the store, rewrites each card's media references from the package's own file
 * names to the vault paths the store chose (`DeckStore.importBundle()` runs
 * `rewriteMediaPaths()` for that), and writes the deck document. It returns
 * the `ImportReport` from `models/anki.ts`.
 *
 * Re-importing the same deck replaces the file the earlier import made rather
 * than piling up a ` 2` copy: an existing deck is matched by its Anki id first,
 * then by the `ankiWebId` it was shared under, then by name, and the report
 * says `replaced: true`. `replaceExisting: false` opts out and writes a fresh
 * file beside the old one instead.
 *
 * Exactly one deck is imported per package. A package can carry several decks,
 * and there are two readings of that: import each as its own deck file, or
 * take one. This service takes **one — the deck that carries the most cards** —
 * because an `ImportReport` names a single deck (path and name) and a caller
 * that wants several files is better served by looping with a `name` override.
 * Decks that carry no cards of their own (Anki writes a `Default` next to every
 * deck) are ignored silently; a deck that does carry cards is reported as a
 * warning, and its cards are placed in the imported deck, so nothing is lost.
 *
 * Export
 * ------
 *
 * {@link DeckService.exportDeck} reads the deck through the store, resolves its
 * media to bytes, rewrites the vault paths back to the file names the cards
 * originally used (so the package Anki receives points at its own media map),
 * and builds the container with `writeApkg()`. What comes back is bytes plus a
 * suggested path: the package layer owns the format, the caller owns writing
 * the file. Importing the result back through {@link DeckService.importApkg}
 * reproduces the same notes, cards, media and scheduling state.
 *
 * What the two layers could not express
 * -------------------------------------
 *
 * - An imported package's revlog rows arrive folded into `card.timeTakenMs`
 *   (the package layer does not hand out raw rows), so an export rebuilds the
 *   notes, cards and media but not the review log itself.
 * - `DeckStore.saveMedia()` always writes a new, collision-free file, so a
 *   re-import of the same deck leaves the earlier copy of its media beside the
 *   fresh one. That is reported in the warnings rather than cleaned up here:
 *   media is shared by name across the vault, and an import must not delete a
 *   file another deck may still point at.
 * - Round-trip fidelity rides in `bundle.extra` — `crt`, the collection stamps
 *   and the raw `models`/`decks`/`dconf`/`conf` JSON — which the deck document
 *   keeps verbatim in its `sf-deck-meta` line.
 */

import { AnkiPackage, readApkg } from '../api/anki/apkg';
import { writeApkg } from '../api/anki/apkg-write';
import {
    AnkiCard,
    AnkiDeck,
    AnkiId,
    DeckBundle,
    DeckMediaFile,
    DEFAULT_DECK_OPTIONS,
    ExportReport,
    ImportReport,
    newAnkiId,
} from '../models/anki';
import { bundleMediaReferences, deckDocumentPath, rewriteMediaPaths, sanitizeDeckFileName } from '../models/deck-document';
import { DeckStore } from './deck-store';
import { displayDeckName } from '../utils/deck-display';
import SpaceforgePlugin from '../main';

/** What an import can be told. */
export interface DeckImportServiceOptions {
    /** Import the deck under this name instead of the package's own. */
    name?: string;
    /**
     * A fixed clock, for deterministic ids and stamps (new deck ids, the
     * `modified` fallback). The store still stamps the file with the real
     * write time.
     */
    now?: number;
    /**
     * Replace the deck this one already is — matched by id, then `ankiWebId`,
     * then name — instead of writing a second file beside it. Defaults to
     * true, which is what makes a re-import an update rather than a duplicate.
     */
    replaceExisting?: boolean;
}

/** What an export can be told. */
export interface DeckExportServiceOptions {
    /** A fixed clock, for a deterministic package. Defaults to `Date.now()`. */
    now?: number;
}

/** What an export produced. */
export interface DeckExportResult {
    /** The `.apkg` bytes, ready for the caller to write at `report.path`. */
    bytes: Uint8Array;
    report: ExportReport;
    /** Media the deck references that is no longer in the vault, and writer notes. */
    warnings: string[];
}

/** The deck a package was read as, plus the decks that lost out. */
export interface DeckChoice {
    /** The deck to import as, or null when the package names none. */
    deck: AnkiDeck | null;
    /** Decks carrying cards that are not imported under their own name. */
    ignored: { name: string; cards: number }[];
}

/**
 * Pick the deck a package is imported as: the one carrying the most cards.
 * Ties keep the earlier deck in the package's own order, so the choice is
 * deterministic. Decks with no cards are not reported (Anki writes its own
 * `Default` beside every export), and decks that do carry cards come back in
 * `ignored` so the caller can say where their cards went.
 */
export function chooseTopDeck(decks: readonly AnkiDeck[], cards: readonly AnkiCard[]): DeckChoice {
    if (decks.length === 0) {
        return { deck: null, ignored: [] };
    }
    const counts = new Map<AnkiId, number>();
    for (const card of cards) {
        counts.set(card.deckId, (counts.get(card.deckId) ?? 0) + 1);
    }
    let chosen = decks[0];
    let chosenCards = counts.get(chosen.id) ?? 0;
    for (const deck of decks.slice(1)) {
        const count = counts.get(deck.id) ?? 0;
        if (count > chosenCards) {
            chosen = deck;
            chosenCards = count;
        }
    }
    const ignored = decks
        .filter((deck) => deck.id !== chosen.id && (counts.get(deck.id) ?? 0) > 0)
        .map((deck) => ({ name: deck.name, cards: counts.get(deck.id) ?? 0 }));
    return { deck: chosen, ignored };
}

/** The service: one instance per plugin, like the other services. */
export class DeckService {
    plugin: SpaceforgePlugin;
    /** The vault-side store; the caller's own instance when one is given. */
    store: DeckStore;

    constructor(plugin: SpaceforgePlugin, store?: DeckStore) {
        this.plugin = plugin;
        this.store = store ?? new DeckStore(plugin);
    }

    // ------------------------------------------------------------- import

    /**
     * Import an `.apkg` (or `.colpkg`, or a bare collection database): write
     * its media, rewrite the card text to the vault paths, write the deck
     * document, and report what arrived.
     *
     * One deck is imported — the one carrying the most cards (see the file
     * comment). Everything the collection carried that the document does not
     * model (the stamps, the raw collection JSON) rides in `bundle.extra`, so
     * exporting the deck again reproduces it.
     */
    async importApkg(bytes: Uint8Array, options: DeckImportServiceOptions = {}): Promise<ImportReport> {
        const now = options.now ?? Date.now();
        const pkg = await readApkg(bytes);
        const warnings: string[] = [...pkg.warnings];

        const choice = chooseTopDeck(pkg.decks, pkg.cards);
        const deck = choice.deck ?? freshDeck(options.name, now, warnings);
        const deckName = options.name ?? deck.name;
        for (const ignored of choice.ignored) {
            warnings.push(
                `the package also carries the deck "${ignored.name}" (${countLabel(ignored.cards, 'card')}); its cards were placed in "${deckName}"`
            );
        }

        // Every card is placed in the imported deck: a deck document holds one
        // deck, and dropping cards would silently lose notes.
        const cards = pkg.cards.map((card) => (card.deckId === deck.id ? card : { ...card, deckId: deck.id }));
        const cardedNotes = new Set(cards.map((card) => card.noteId));
        const notes = pkg.notes.filter((note) => cardedNotes.has(note.id));
        const orphaned = pkg.notes.length - notes.length;
        if (orphaned > 0) {
            warnings.push(
                `${countLabel(orphaned, 'note')} with no cards ${orphaned === 1 ? 'was' : 'were'} left out: a deck document is made of cards`
            );
        }

        const media: DeckMediaFile[] = pkg.media.map((entry) => ({
            path: entry.path,
            originalName: entry.originalName,
            mime: entry.mime,
            size: entry.size,
        }));
        const mediaBytes = new Map<string, ArrayBuffer>();
        for (const entry of pkg.media) {
            mediaBytes.set(entry.originalName, exactBytes(entry.bytes));
        }

        const bundle: DeckBundle = {
            deck: {
                ...deck,
                name: deckName,
                modified: deck.modified > 0 ? deck.modified : now,
                options: {
                    ...deck.options,
                    learningSteps: [...deck.options.learningSteps],
                    relearningSteps: [...deck.options.relearningSteps],
                    fsrs: { ...deck.options.fsrs, weights: [...deck.options.fsrs.weights] },
                },
            },
            notes,
            cards,
            presets: pkg.presets,
            deckPresetOf: pkg.deckPresetOf,
            media,
            extra: packageFidelity(pkg),
        };
        const ankiWebId = deck.ankiWebId ?? ankiWebIdFromSource(deck.sourceUrl);
        if (ankiWebId !== undefined) {
            bundle.deck.ankiWebId = ankiWebId;
        }

        const replaceExisting = options.replaceExisting ?? true;
        const existing = replaceExisting
            ? await this.findExistingDeck({ id: bundle.deck.id, ankiWebId, name: deckName })
            : null;
        const path = existing ?? (replaceExisting ? undefined : await this.unusedDeckPath(deckName));
        // Read the deck being replaced *before* the import overwrites it.
        const previousMedia = existing !== null ? await this.listedMedia(existing) : null;

        // The store writes the media, rewrites the card text to where it put
        // them, and writes the deck file.
        const report = await this.store.importBundle(bundle, { path, name: deckName, mediaBytes });

        if (previousMedia !== null) {
            const stale = await this.mediaLeftBehind(previousMedia, report.deckPath);
            if (stale.length > 0) {
                warnings.push(
                    `${countLabel(stale.length, 'media file')} from the earlier import stay in the vault, because a re-import writes fresh copies beside them`
                );
            }
        }

        // Media the notes point at that the package did not carry: they were
        // left as written, and the reader should know.
        const carried = new Set(media.map((entry) => entry.originalName));
        const missing = bundleMediaReferences(bundle).filter((reference) => {
            const bare = reference.split('/').pop() ?? reference;
            return !carried.has(reference) && !carried.has(bare);
        });

        return {
            ...report,
            missingMedia: unique([...report.missingMedia, ...missing]),
            warnings: unique([...warnings, ...report.warnings]),
        };
    }

    // ------------------------------------------------------------- export

    /**
     * Build the `.apkg` for a deck document: read it through the store,
     * resolve its media to bytes, point the card text back at the original
     * media file names, and write the package.
     *
     * Nothing is written to the vault here — the caller writes `bytes` at
     * `report.path` (the deck document's sibling, `.apkg`).
     */
    async exportDeck(path: string, options: DeckExportServiceOptions = {}): Promise<DeckExportResult> {
        const { bundle, media } = await this.store.exportBundle(path);

        // The vault paths the cards were rewritten to become, once more, the
        // file names Anki's media map talks about. Listed-but-missing media is
        // rewritten too, so a package never carries a vault path.
        const originalNames = new Map<string, string>();
        for (const file of bundle.media) {
            originalNames.set(file.path, file.originalName);
            const bare = file.path.split('/').pop();
            if (bare !== undefined) {
                originalNames.set(bare, file.originalName);
            }
        }
        const rewritten = rewriteMediaPaths(bundle, (reference) => {
            const exact = originalNames.get(reference);
            if (exact !== undefined) return exact;
            const bare = reference.split('/').pop() ?? reference;
            return originalNames.get(bare) ?? null;
        });

        const written = await writeApkg(rewritten, {
            media: media.map((entry) => ({ ...entry.file, bytes: new Uint8Array(entry.bytes) })),
            now: options.now,
        });

        const warnings = [...written.warnings];
        const absent = this.store.missingMedia(bundle);
        if (absent.length > 0) {
            warnings.push(
                `the deck references ${countLabel(absent.length, 'file')} the vault does not have: ${absent.map((name) => `"${name}"`).join(', ')}`
            );
        }

        return {
            bytes: written.bytes,
            report: {
                path: apkgPathFor(path),
                notes: written.notes,
                cards: written.cards,
                media: written.media,
                bytes: written.bytes.length,
            },
            warnings: unique(warnings),
        };
    }

    // ------------------------------------------------------------ helpers

    /**
     * The name to offer for an import: the package's own deck name, sanitised
     * into something a file name can hold, or the caller's `fallback` when the
     * bytes cannot be read or the package names no deck. Never throws.
     */
    async suggestImportName(bytes: Uint8Array, fallback = 'Imported deck'): Promise<string> {
        let wanted = fallback;
        try {
            const pkg = await readApkg(bytes);
            const choice = chooseTopDeck(pkg.decks, pkg.cards);
            if (choice.deck !== null && choice.deck.name.trim() !== '') {
                wanted = choice.deck.name;
            }
        } catch {
            // Not a package we can read: the caller's name is the best offer.
        }
        return sanitizeDeckFileName(wanted) || sanitizeDeckFileName(fallback) || 'Deck';
    }

    /** One sentence for a Notice, in sentence case. */
    summarizeImport(report: ImportReport): string {
        const detail: string[] = [];
        if (report.mediaImported > 0) {
            detail.push(countLabel(report.mediaImported, 'media file'));
        }
        if (report.replaced) {
            detail.push('replacing the earlier import');
        }
        if (report.missingMedia.length > 0) {
            detail.push(`${countLabel(report.missingMedia.length, 'referenced file')} missing`);
        }
        if (report.warnings.length > 0) {
            detail.push(countLabel(report.warnings.length, 'warning'));
        }
        const head = `Imported ${countLabel(report.notesImported, 'note')} and ${countLabel(report.cardsImported, 'card')} into "${displayDeckName(report.deckName)}"`;
        return detail.length > 0 ? `${head} (${detail.join(', ')}).` : `${head}.`;
    }

    /** The extension an exported deck package carries, dot included. */
    deckFileExtension(): string {
        return '.apkg';
    }

    // ------------------------------------------------------------ internals

    /**
     * The deck file an import should replace, or null to make a new one.
     * Matched the way a deck is identified: its Anki id first (stable across
     * exports), then the AnkiWeb id it was shared under, then its name.
     */
    private async findExistingDeck(wanted: { id: AnkiId; ankiWebId?: string; name: string }): Promise<string | null> {
        const byId = await this.store.pathForDeck(wanted.id);
        if (byId !== null) {
            return byId;
        }
        let byName: string | null = null;
        for (const summary of await this.store.listDecks()) {
            if (byName === null && summary.name === wanted.name) {
                byName = summary.path;
            }
            if (wanted.ankiWebId === undefined) {
                continue;
            }
            try {
                const existing = await this.store.readDeck(summary.path);
                if (existing.deck.ankiWebId === wanted.ankiWebId) {
                    return summary.path;
                }
            } catch {
                continue; // a deck that cannot be read cannot be matched
            }
        }
        return byName;
    }

    /** A deck path that is not taken, for an import that must not replace. */
    private async unusedDeckPath(name: string): Promise<string> {
        const taken = (await this.store.listDecks()).map((summary) => summary.path);
        return deckDocumentPath(name, taken);
    }

    /** The media a deck currently lists, read before an import can overwrite it. */
    private async listedMedia(path: string): Promise<string[] | null> {
        try {
            const bundle = await this.store.readDeck(path);
            return bundle.media.map((file) => file.path);
        } catch {
            return null;
        }
    }

    /** Media the earlier import left in the vault that the written deck no longer uses. */
    private async mediaLeftBehind(previousMedia: readonly string[], writtenPath: string): Promise<string[]> {
        try {
            const written = await this.store.readDeck(writtenPath);
            const live = new Set(written.media.map((file) => file.path));
            for (const reference of bundleMediaReferences(written)) {
                live.add(reference);
            }
            return previousMedia.filter((path) => !live.has(path));
        } catch {
            return [];
        }
    }
}

/* -------------------------------------------------------------- helpers */

/**
 * A deck for a package that names none: fresh identity, Anki's defaults, and a
 * warning, because a deck file has to be called something.
 */
function freshDeck(name: string | undefined, now: number, warnings: string[]): AnkiDeck {
    warnings.push('the package names no deck of its own; the cards were imported into a new one');
    return {
        id: newAnkiId(now),
        name: name ?? 'Imported deck',
        modified: now,
        options: {
            ...DEFAULT_DECK_OPTIONS,
            learningSteps: [...DEFAULT_DECK_OPTIONS.learningSteps],
            relearningSteps: [...DEFAULT_DECK_OPTIONS.relearningSteps],
            fsrs: { ...DEFAULT_DECK_OPTIONS.fsrs, weights: [...DEFAULT_DECK_OPTIONS.fsrs.weights] },
        },
        parentId: null,
    };
}

/**
 * The parts of the collection the deck document does not model but an export
 * has to reproduce: the stamp the day-based schedule is relative to, and the
 * raw JSON the package layer reuses verbatim. The document keeps them in its
 * meta line, so they survive the vault round trip.
 */
function packageFidelity(pkg: AnkiPackage): Record<string, unknown> {
    return {
        crt: pkg.meta.created,
        mod: pkg.meta.collectionModified,
        scm: pkg.meta.collectionModified,
        models: pkg.meta.raw.models,
        decks: pkg.meta.raw.decks,
        dconf: pkg.meta.raw.dconf,
        conf: pkg.meta.raw.conf,
    };
}

/** The AnkiWeb deck id a shared deck's URL carries, when it looks like one. */
function ankiWebIdFromSource(sourceUrl: string | undefined): string | undefined {
    if (sourceUrl === undefined) {
        return undefined;
    }
    const match = /ankiweb\.net\/(?:shared\/info|decks)\/(\d+)/i.exec(sourceUrl);
    return match ? match[1] : undefined;
}

/** The package path a deck document is exported to: its sibling, `.apkg`. */
function apkgPathFor(deckPath: string): string {
    return /\.md$/i.test(deckPath) ? `${deckPath.slice(0, -3)}.apkg` : `${deckPath}.apkg`;
}

/** A media entry's own bytes, as an exact ArrayBuffer (no shared tail). */
function exactBytes(bytes: Uint8Array): ArrayBuffer {
    // A fresh copy is exactly the view's bytes; `buffer.slice` loses its
    // ArrayBuffer type on newer TypeScript, and a SharedArrayBuffer must
    // never reach the album writer.
    return new Uint8Array(bytes).buffer;
}

/** "1 card", "2 cards" — how Anki's own counts read. */
function countLabel(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

/** The values in order, each only once. */
function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}
