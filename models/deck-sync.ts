/**
 * The per-device answer log: how two Obsidian devices that both reviewed a deck
 * while offline keep every answer.
 *
 * A deck document is one file, so a file sync cannot merge it — whichever copy
 * arrives last wins and the other device's answers are gone. The log sidesteps
 * that by never asking two devices to write the same file: each device appends
 * one line per answer to its own
 * `spaceforge/sync/decks/<deckId>/<deviceId>.jsonl`, and the deck document
 * becomes a cache that every reader reconciles against the union of the logs.
 *
 * The entry is the whole card, not a diff: a schedule is a small value and a
 * full snapshot means the merge needs no scheduler replay, no ordering rules
 * and no way to end up with a half-applied card. The stamp is the same
 * {@link AnkiCard.mod} the Anki merge uses, so both kinds of conflict — other
 * device, other app — are decided by one rule.
 *
 * This file is the pure half (encoding, decoding, applying); the vault I/O is
 * `services/deck-sync-service.ts`.
 */
import { AnkiCard, AnkiId, DeckBundle } from './anki';
import { cardMod, sameCardState } from './deck-merge';

/** One line of a device's log. */
export interface DeckSyncEntry {
    /** The device that wrote it, taken from the file's own name. */
    device: string;
    /** When the schedule changed, ms since epoch. */
    mod: number;
    card: AnkiCard;
}

/** The line a log file holds for one answer. */
export function encodeSyncEntry(card: AnkiCard): string {
    return `${JSON.stringify({ mod: cardMod(card, 0), card })}\n`;
}

/**
 * Read a log file. A line that is not an entry is reported and skipped: one
 * torn line (a sync client caught it mid-write) must not cost the whole log.
 */
export function decodeSyncEntries(text: string, device: string, warnings: string[]): DeckSyncEntry[] {
    const entries: DeckSyncEntry[] = [];
    let lineNumber = 0;
    for (const line of text.split('\n')) {
        lineNumber += 1;
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            warnings.push(`${device}: line ${lineNumber} is not valid JSON; it was skipped.`);
            continue;
        }
        const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
        const card = record && typeof record.card === 'object' && record.card !== null
            ? (record.card as Record<string, unknown>)
            : null;
        const id = card && typeof card.id === 'string' ? card.id : null;
        const mod = record && typeof record.mod === 'number' ? record.mod : null;
        if (card === null || id === null || mod === null || !Number.isFinite(mod) || mod <= 0) {
            warnings.push(`${device}: line ${lineNumber} is not a card state; it was skipped.`);
            continue;
        }
        entries.push({ device, mod, card: card as unknown as AnkiCard });
    }
    return entries;
}

/** What applying the logs did. */
export interface ApplySyncResult {
    cards: AnkiCard[];
    /** Cards whose schedule the logs actually changed. */
    applied: number;
    /** Entries naming a card this deck no longer has. */
    orphaned: number;
}

/**
 * Fold every device's log into the deck's cards: newest stamp per card wins,
 * a tie keeps the document (the log then agrees with it), and an entry for a
 * card the document no longer has is ignored — a deleted card is a material
 * edit, and resurrecting it from a log would undo that.
 */
export function applySyncEntries(cards: AnkiCard[], entries: DeckSyncEntry[]): ApplySyncResult {
    const byId = new Map<string, AnkiCard[]>();
    for (const entry of entries) {
        const list = byId.get(entry.card.id);
        if (list) list.push(entry.card);
        else byId.set(entry.card.id, [entry.card]);
    }

    let applied = 0;
    let orphaned = 0;
    const known = new Set<string>();
    const merged = cards.map(card => {
        known.add(card.id);
        const candidates = byId.get(card.id);
        if (!candidates || candidates.length === 0) return card;
        let best = card;
        let bestMod = cardMod(card, 0);
        for (const candidate of candidates) {
            const mod = cardMod(candidate, 0);
            if (mod > bestMod) {
                best = candidate;
                bestMod = mod;
            }
        }
        if (best === card || sameCardState(card, best)) return card;
        applied += 1;
        return { ...best, deckId: card.deckId };
    });
    for (const id of byId.keys()) {
        if (!known.has(id)) orphaned += 1;
    }
    return { cards: merged, applied, orphaned };
}

/** Apply the logs to a whole bundle, keeping its identity and material. */
export function applySyncToBundle(bundle: DeckBundle, entries: DeckSyncEntry[]): ApplySyncResult & { bundle: DeckBundle } {
    const result = applySyncEntries(bundle.cards, entries);
    return { ...result, bundle: { ...bundle, cards: result.cards } };
}

/** The path segment a deck id makes: Anki ids are digits, but a hand-written
 * deck can carry anything, so keep it path-safe and stable. */
export function syncFolderName(deckId: AnkiId): string {
    return deckId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'deck';
}
