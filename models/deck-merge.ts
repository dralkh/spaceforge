/**
 * Merging a deck that arrived from Anki into the one already in the vault.
 *
 * The two sides are independent schedulers. Anki reviewed some cards on the
 * desktop while the vault reviewed others on a phone, and neither knows about
 * the other's answers — so the merge cannot be "the package wins" (that throws
 * away every answer made here) nor "the vault wins" (that throws away every
 * answer made there). It is decided **per card**, by the card's own
 * modification stamp: Anki's `cards.mod`, which this model carries as
 * {@link AnkiCard.mod} in milliseconds, and which a package round trip now
 * preserves instead of stamping every row with the export time.
 *
 * The rules, in order:
 *
 * - a card only one side has is kept (and counted as added when it came from
 *   the package);
 * - a card both sides have, with the same schedule, is unchanged — the stamps
 *   are not consulted at all, so a package's coarse seconds cannot fake a
 *   change;
 * - otherwise the newer stamp wins, and a tie keeps the vault's card, because
 *   the deck document is the reader's own file;
 * - cards that predate the field fall back to their own review evidence
 *   ({@link cardMod}) rather than to a made-up time.
 *
 * The deck's identity, name and options stay the vault's: they are material a
 * human edits, not schedule state. What the merge brings over is cards, notes
 * (by their own `modified`), new media, and review-log rows, unioned.
 */
import {
    AnkiCard,
    AnkiCardType,
    AnkiId,
    AnkiNote,
    DeckBundle,
    DeckMediaFile,
} from './anki';

const DAY_MS = 86_400_000;

/** How one kind of record was resolved. The four counts partition the union. */
export interface MergeTally {
    /** In the vault and not in the package (kept as it was). */
    kept: number;
    /** In both, differing, and the package's stamp is newer. */
    taken: number;
    /** Only in the package (a card or note added there). */
    added: number;
    /** In both, with identical content — stamps were not consulted. */
    unchanged: number;
}

/** One card both sides changed differently, and who won. */
export interface CardResolution {
    cardId: AnkiId;
    winner: 'local' | 'incoming';
    localMod: number;
    incomingMod: number;
}

/** What a merge did, for the report the reader sees. */
export interface DeckMergeReport {
    cards: MergeTally;
    notes: MergeTally;
    /** Media files the package carried that the vault did not already have. */
    mediaAdded: number;
    /** Every card whose schedule differed, with the winner. */
    resolved: CardResolution[];
    warnings: string[];
}

/** A merge result: the bundle to write, and what it cost. */
export interface DeckMergeResult {
    bundle: DeckBundle;
    report: DeckMergeReport;
}

/**
 * When this card last changed, in ms.
 *
 * `card.mod` is the real answer. Cards that predate it are estimated from
 * their own evidence — FSRS keeps the last review timestamp, and an SM-2 card's
 * due date minus its interval is when it was last seen — so an upgrading vault
 * is not silently "older than everything" on its first merge. `fallback` (the
 * deck's own `modified`) is the last resort, and is deliberately the last: it
 * moves on every answer, so it says "this file changed", not "this card did".
 */
export function cardMod(card: AnkiCard, fallback = 0): number {
    if (card.mod !== undefined && card.mod > 0) return card.mod;
    const lastReview = card.memory?.lastReview ?? 0;
    if (lastReview > 0) return lastReview;
    if (card.type !== AnkiCardType.New && card.interval > 0 && card.due > 0) {
        const estimated = card.due - card.interval * DAY_MS;
        if (estimated > 0) return Math.min(estimated, card.due);
    }
    return fallback;
}

/** When this note last changed, in ms — the same rule, without a card's evidence. */
export function noteMod(note: AnkiNote, fallback = 0): number {
    if (note.modified !== undefined && note.modified > 0) return note.modified;
    return fallback;
}

/** The schedule, as one comparable string. Presentation is schedule-adjacent
 * (an MCQ's choices are what the reader sees), so it travels with it.
 * `timeTakenMs` is deliberately absent: it is a statistic derived from the
 * review log, not a schedule, and two cards that differ only in how long the
 * reader took are the same card. */
function cardStateKey(card: AnkiCard): string {
    return JSON.stringify([
        card.noteId,
        card.ord,
        card.type,
        card.queue,
        card.interval,
        card.easeFactor,
        card.reviews,
        card.lapses,
        card.due,
        card.newPosition,
        card.flag,
        card.desiredRetentionDays ?? null,
        card.memory
            ? [card.memory.stability, card.memory.difficulty, card.memory.lastReview, card.memory.scheduledDays]
            : null,
        card.presentation
            ? [
                card.presentation.mode,
                card.presentation.choices ?? null,
                card.presentation.answer ?? null,
                card.presentation.accept ?? null,
                card.presentation.caseInsensitive ?? null,
                card.presentation.ignoreDiacritics ?? null,
            ]
            : null,
    ]);
}

/** True when two cards say the same thing, whatever their stamps. */
export function sameCardState(a: AnkiCard, b: AnkiCard): boolean {
    return cardStateKey(a) === cardStateKey(b);
}

/** True when two notes say the same thing, whatever their stamps. */
export function sameNoteContent(a: AnkiNote, b: AnkiNote): boolean {
    return JSON.stringify([a.modelName, a.fields, a.values, a.tags, a.mediaFiles]) ===
        JSON.stringify([b.modelName, b.fields, b.values, b.tags, b.mediaFiles]);
}

function emptyTally(): MergeTally {
    return { kept: 0, taken: 0, added: 0, unchanged: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rows of raw SQL data (`revlog`, `graves`) as one set, local row winning a
 * duplicate. Both sides answering the same card produce two rows with
 * different ids, so a union is the right shape — but a re-imported row must
 * not appear twice. */
function unionRows(mine: unknown, theirs: unknown): unknown {
    if (!Array.isArray(mine) || !Array.isArray(theirs)) return mine;
    const seen = new Set(mine.map(row => JSON.stringify(row)));
    const out = [...mine];
    for (const row of theirs) {
        const key = JSON.stringify(row);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    return out;
}

/**
 * `bundle.extra` is bucketed by record kind (`cards`, `notes`, `deck`, and the
 * raw `revlog`/`graves` rows). A merge keeps the vault's value wherever both
 * sides have one, except for the raw row lists, which are unioned.
 */
function mergeExtra(
    mine: Record<string, unknown> | undefined,
    theirs: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (mine === undefined) return theirs === undefined ? undefined : { ...theirs };
    if (theirs === undefined) return { ...mine };
    const out: Record<string, unknown> = { ...mine };
    for (const [key, value] of Object.entries(theirs)) {
        const existing = out[key];
        if (existing === undefined) {
            out[key] = value;
        } else if (key === 'revlog' || key === 'graves') {
            out[key] = unionRows(existing, value);
        } else if (isRecord(existing) && isRecord(value)) {
            out[key] = { ...value, ...existing };
        }
    }
    return out;
}

/**
 * Merge a deck that arrived from Anki into the deck already in the vault.
 *
 * `incoming` is the package as read (one deck, its notes, its cards); `local`
 * is the vault's own bundle, which is the source of the deck's identity, name
 * and options. Neither argument is modified.
 */
export function mergeDeckBundles(local: DeckBundle, incoming: DeckBundle): DeckMergeResult {
    const deckId = local.deck.id;
    const localFallback = local.deck.modified > 0 ? local.deck.modified : Date.now();
    const incomingFallback = incoming.deck.modified > 0 ? incoming.deck.modified : localFallback;

    const cardsTally = emptyTally();
    const resolved: CardResolution[] = [];
    const incomingCards = new Map(incoming.cards.map(card => [card.id, card]));
    const cards: AnkiCard[] = [];

    for (const card of local.cards) {
        const other = incomingCards.get(card.id);
        if (!other) {
            cardsTally.kept += 1;
            cards.push({ ...card, deckId });
            continue;
        }
        incomingCards.delete(card.id);
        if (sameCardState(card, other)) {
            cardsTally.unchanged += 1;
            cards.push({ ...card, deckId });
            continue;
        }
        const localMod = cardMod(card, localFallback);
        const incomingMod = cardMod(other, incomingFallback);
        const winner: 'local' | 'incoming' = incomingMod > localMod ? 'incoming' : 'local';
        if (winner === 'incoming') cardsTally.taken += 1;
        else cardsTally.kept += 1;
        resolved.push({ cardId: card.id, winner, localMod, incomingMod });
        if (winner === 'incoming') {
            // Taking a schedule must not drop a measured review time the
            // package does not carry (Anki's package has no revlog rows).
            cards.push({ ...other, deckId, timeTakenMs: other.timeTakenMs ?? card.timeTakenMs });
        } else {
            cards.push({ ...card, deckId });
        }
    }
    for (const card of incomingCards.values()) {
        cardsTally.added += 1;
        cards.push({ ...card, deckId });
    }

    const notesTally = emptyTally();
    const incomingNotes = new Map(incoming.notes.map(note => [note.id, note]));
    const notes: AnkiNote[] = [];
    for (const note of local.notes) {
        const other = incomingNotes.get(note.id);
        if (!other) {
            notesTally.kept += 1;
            notes.push(note);
            continue;
        }
        incomingNotes.delete(note.id);
        if (sameNoteContent(note, other)) {
            notesTally.unchanged += 1;
            notes.push(note);
            continue;
        }
        const localMod = noteMod(note, localFallback);
        const incomingMod = noteMod(other, incomingFallback);
        if (incomingMod > localMod) {
            notesTally.taken += 1;
            notes.push(other);
        } else {
            notesTally.kept += 1;
            notes.push(note);
        }
    }
    for (const note of incomingNotes.values()) {
        notesTally.added += 1;
        notes.push(note);
    }

    const knownMedia = new Set(local.media.map(entry => entry.originalName));
    const media: DeckMediaFile[] = [...local.media];
    let mediaAdded = 0;
    for (const entry of incoming.media) {
        if (knownMedia.has(entry.originalName)) continue;
        knownMedia.add(entry.originalName);
        media.push(entry);
        mediaAdded += 1;
    }

    const report: DeckMergeReport = {
        cards: cardsTally,
        notes: notesTally,
        mediaAdded,
        resolved,
        warnings: [],
    };

    return {
        bundle: {
            deck: {
                ...local.deck,
                // Provenance is package metadata, not material a human edits:
                // a vault deck that has none inherits the package's, so the
                // next import still recognises the deck it came from.
                ankiWebId: local.deck.ankiWebId ?? incoming.deck.ankiWebId,
                sourceUrl: local.deck.sourceUrl ?? incoming.deck.sourceUrl,
                parentId: local.deck.parentId ?? incoming.deck.parentId,
                modified: Math.max(local.deck.modified, incoming.deck.modified),
            },
            notes,
            cards,
            presets: local.presets ?? incoming.presets,
            deckPresetOf: local.deckPresetOf ?? incoming.deckPresetOf,
            media,
            extra: mergeExtra(local.extra, incoming.extra),
        },
        report,
    };
}

/**
 * One line for the reader, or null when the merge changed nothing worth
 * mentioning (a first import, or a package identical to the vault).
 */
export function mergeSummary(report: DeckMergeReport): string | null {
    const { taken, added } = report.cards;
    if (taken === 0 && added === 0) return null;
    const parts: string[] = [];
    if (taken > 0) parts.push(`${taken} ${taken === 1 ? 'card' : 'cards'} updated from Anki`);
    if (added > 0) parts.push(`${added} new ${added === 1 ? 'card' : 'cards'}`);
    return parts.join(', ');
}
