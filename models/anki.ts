/**
 * The Anki side of Spaceforge: decks, notes, cards and their scheduling state.
 *
 * This mirrors Anki's own data model closely enough that a deck can be imported,
 * reviewed and exported without losing anything, and its identifiers are Anki's
 * own (epoch-millisecond integers, staying strings here because they exceed
 * JavaScript's safe integer range for notes and cards created after 1970 in the
 * high bits — Anki uses the low bits for a sequence).
 *
 * Kept in its own lane, deliberately: a card is scheduled on its own, a deck has
 * its own limits and options, and none of it touches the note-review scheduler.
 */

/** Anki timestamps: milliseconds since the epoch, as a string. */
export type AnkiId = string;

/** What a card is doing right now, matching Anki's queue values. */
export enum AnkiCardType {
    New = 0,
    Learning = 1,
    Review = 2,
    Relearning = 3,
}

/**
 * Anki's card queue, value for value (`rslib/src/card/mod.rs`), so an exported
 * collection is read the same way Anki reads it.
 */
export enum AnkiCardQueue {
    /** due is the order cards are shown in. */
    New = 0,
    /** due is a unix timestamp. */
    Learning = 1,
    /** due is a day number since the collection was created. */
    Review = 2,
    /** Learnt today, still counted with reviews. */
    DayLearn = 3,
    /** Preview cards that failed. */
    PreviewRepeat = 4,
    /** Not due in this state; the user's choice. */
    Suspended = -1,
    /** Buried by the scheduler — a sibling of a card just answered. */
    SchedBuried = -2,
    /** Buried by the user. */
    UserBuried = -3,
}

/** Which scheduler a deck follows. */
export enum DeckScheduler {
    /** Anki's classic SM-2-derived scheduler. */
    Sm2 = 'sm2',
    /** FSRS (Anki 23.10+, and Spaceforge's own option). */
    Fsrs = 'fsrs',
}

/**
 * Per-deck options, named after Anki's own fields so the mapping is obvious.
 * A deck's file holds one of these; importing takes the source deck's options.
 */
export interface DeckOptions {
    /** New cards introduced per day. */
    newPerDay: number;
    /** Reviews allowed per day (0 = unlimited). */
    reviewsPerDay: number;
    /** Learning steps, e.g. [1, 10] minutes. */
    learningSteps: number[];
    /** Relearning steps after a lapse, e.g. [10] minutes. */
    relearningSteps: number[];
    /** Days a new card waits after graduating. */
    graduatingInterval: number;
    /** Days an "easy" answer gives a new card. */
    easyInterval: number;
    /** Starting ease, in permille (2500 = 250%). */
    startingEase: number;
    /** Multiplier on the interval for "easy", in permille (1300 = 130%). */
    easyBonus: number;
    /** Multiplier applied to every review interval, in permille (1000 = 100%). */
    intervalMultiplier: number;
    /** How much of the interval survives a lapse, in permille (0 = start over). */
    lapseMultiplier: number;
    /** Hard answers multiply the interval by this, in permille (1200 = 120%). */
    hardMultiplier: number;
    /** Smallest interval a review can end at, in days. */
    minimumInterval: number;
    /** Largest interval a review can end at, in days (36500 = 100 years). */
    maximumInterval: number;
    /** How many lapses make a card a leech. */
    leechThreshold: number;
    /** What to do with a leech. */
    leechAction: LeechAction;
    /** Bury sibling cards until the next day. */
    buryNewSiblings: boolean;
    buryReviewSiblings: boolean;
    /** Show the answer only after this many seconds, 0 = off. */
    maxAnswerSeconds: number;
    /** How long "again" on a review delays it, in minutes (Anki's 10m default). */
    againDelayMinutes: number;
    /** Stop reviewing this deck for the day when the time box is up. */
    scheduler: DeckScheduler;
    /** FSRS settings, used when scheduler is Fsrs. */
    fsrs: FsrsOptions;
}

export enum LeechAction {
    Suspend = 0,
    TagOnly = 1,
}

/** FSRS parameters for one deck, matching Anki's presets. */
export interface FsrsOptions {
    /** Target retention, 0.70–0.99. */
    desiredRetention: number;
    /** Days from the last review that an interval is computed for. */
    maximumInterval: number;
    /** The 19 FSRS-5 weights. */
    weights: number[];
    /** Whether the deck keeps its own state or follows the global parameters. */
    useOwnWeights: boolean;
}

/** A card's memory state, as FSRS describes it. */
export interface CardMemoryState {
    /** Days until recall probability drops to the target. */
    stability: number;
    /** How hard this item is for the learner, 1–10. */
    difficulty: number;
    /** Timestamp of the last review, in ms. */
    lastReview: number;
    /** Scheduled days at the last review. */
    scheduledDays: number;
}

/**
 * How a card presents itself. `flip` and `cloze` are Anki's own two shapes; the
 * other two are the ways a deck of plain question-and-answer text can ask more
 * of the reader.
 */
export type CardPresentationMode =
    /** The front, then the back — Anki's basic card. */
    | 'flip'
    /** Multiple choice: pick one of the choices. */
    | 'mcq'
    /** Type the answer and have it compared against the back. */
    | 'type'
    /** A cloze deletion, written into the text as {{c1::…}}. */
    | 'cloze';

/**
 * A card's presentation, when it differs from what the note's own shape
 * implies. Whatever is set here overrides the default reading of the note.
 */
export interface CardPresentation {
    mode: CardPresentationMode;
    /** Multiple choice: the choices, in the order they are shown. */
    choices?: string[];
    /** Multiple choice: the index of the right choice. */
    answer?: number;
    /**
     * Typing: other spellings that count as right. Anki compares exactly, so
     * anything a person might reasonably type instead has to be listed.
     */
    accept?: string[];
    /** Typing: ignore capitalisation, as Anki's `ci:` modifier does. */
    caseInsensitive?: boolean;
    /** Typing: ignore diacritics, as Anki's `nc:` modifier does. */
    ignoreDiacritics?: boolean;
}

/** One card: one question (or one direction of a note) and its schedule. */
export interface AnkiCard {
    /** Anki's card id. */
    id: AnkiId;
    /** The note this card was generated from. */
    noteId: AnkiId;
    /** Anki's deck id, as a string. */
    deckId: AnkiId;
    /** Ordinal of the card template within the note (0, 1, …). */
    ord: number;
    type: AnkiCardType;
    queue: AnkiCardQueue;
    /** Days from the last review to this one; negative while learning. */
    interval: number;
    /** Ease factor in permille (SM-2); FSRS uses difficulty instead. */
    easeFactor: number;
    /** How many times the card has been reviewed. */
    reviews: number;
    /** How many times the card has been forgotten. */
    lapses: number;
    /** When the card is due, ms since epoch. */
    due: number;
    /** Position in the new queue; null once it has been introduced. */
    newPosition: number | null;
    /** 1–7; 1 = red, 2 = orange, 3 = green, 4 = blue. */
    flag: number;
    /** Days until the next review, as scheduled (FSRS saves this). */
    desiredRetentionDays?: number;
    memory?: CardMemoryState;
    /** Anki's optional global ordering value. */
    originalDue?: number;
    /** Anki's timestamp for when the card left the new queue. */
    originalPosition?: number;
    /** Accumulated review time in ms, for the statistics screen. */
    timeTakenMs?: number;
    /**
     * How this card asks its question, when that is not what the note's own
     * shape implies. A note with two fields is a flip card, one field with
     * {{c1::…}} markers is a cloze card; a deck written by hand can also ask
     * multiple choice or ask for a typed answer.
     */
    presentation?: CardPresentation;
}

/** One note: the fields, plus the templates that turn them into cards. */
export interface AnkiNote {
    id: AnkiId;
    /** The notetype ("Basic", "Cloze", …). */
    modelName: string;
    /** The model's field names, in order. */
    fields: string[];
    /** Field values, in the same order. */
    values: string[];
    /** Tags, without the leading/trailing spaces Anki stores. */
    tags: string[];
    /** The card ids generated from this note. */
    cardIds: AnkiId[];
    /** Images/audio the fields reference, by file name. */
    mediaFiles: string[];
    /** Set when the note was created/modified outside Anki. */
    modified?: number;
}

/** A deck: identity, options, and where its cards live. */
export interface AnkiDeck {
    id: AnkiId;
    /** Deck name, using Anki's "::" hierarchy separator. */
    name: string;
    /** Set for a deck shared on AnkiWeb. */
    ankiWebId?: string;
    /** The deck this one was imported from, when known. */
    sourceUrl?: string;
    /** When the deck file was last written. */
    modified: number;
    options: DeckOptions;
    parentId?: AnkiId | null;
}

/** The whole of a deck as it lives in the vault. */
export interface DeckBundle {
    deck: AnkiDeck;
    notes: AnkiNote[];
    cards: AnkiCard[];
    /** Deck presets, keyed by id, for decks that were exported from Anki. */
    presets?: DeckPreset[];
    /** Which preset each deck id uses. */
    deckPresetOf?: Record<AnkiId, string>;
    /** The file name each media file was imported as. */
    media: DeckMediaFile[];
    /** Everything a round trip has to keep but Spaceforge does not model. */
    extra?: Record<string, unknown>;
}

/** Media that travelled with a deck. */
export interface DeckMediaFile {
    /** The vault-relative path inside `spaceforge/decks/media/`. */
    path: string;
    /** The original file name referenced by the cards. */
    originalName: string;
    /** MIME type, when known. */
    mime?: string;
    /** Size in bytes. */
    size?: number;
}

/** An Anki deck preset, kept for a faithful export. */
export interface DeckPreset {
    id: string;
    name: string;
    options: DeckOptions;
}

/** The answer a learner gives, in Anki's four grades. */
export enum AnkiGrade {
    Again = 1,
    Hard = 2,
    Good = 3,
    Easy = 4,
}

/** What the scheduler decided for one answer. */
export interface ScheduleOutcome {
    card: AnkiCard;
    /** Why the card moved where it did, for the UI. */
    reason: 'new' | 'learning' | 'relearning' | 'review' | 'lapse' | 'early';
    /** The human-readable interval, Anki style: "10m", "3d", "2.4mo". */
    intervalLabel: string;
}

/** Result of answering a card, including the bookkeeping a session needs. */
export interface AnswerResult extends ScheduleOutcome {
    /** Milliseconds spent on the answer. */
    timeTakenMs: number;
    /** True when the card was suspended because it became a leech. */
    leeched: boolean;
    /** Cards buried as a result of this answer. */
    buriedCardIds: AnkiId[];
}

/** Counts shown for a deck, Anki's own numbers. */
export interface DeckCounts {
    newCount: number;
    learningCount: number;
    reviewCount: number;
    totalCards: number;
    /** Cards due today, all queues. */
    dueToday: number;
}

/** What an import produced, for the report the reader sees. */
export interface ImportReport {
    /** The deck file that was written. */
    deckPath: string;
    deckName: string;
    notesImported: number;
    cardsImported: number;
    mediaImported: number;
    /** Files the package referenced that were not inside it. */
    missingMedia: string[];
    /** Anything dropped, with the reason. */
    warnings: string[];
    /** True when the deck replaced an earlier import of the same deck. */
    replaced: boolean;
}

/** What an export produced. */
export interface ExportReport {
    /** Where the .apkg was written, vault-relative. */
    path: string;
    notes: number;
    cards: number;
    media: number;
    bytes: number;
}

/** The four grades, in Anki's order, with the labels its buttons use. */
export const ANKI_GRADES: { grade: AnkiGrade; label: string }[] = [
    { grade: AnkiGrade.Again, label: 'Again' },
    { grade: AnkiGrade.Hard, label: 'Hard' },
    { grade: AnkiGrade.Good, label: 'Good' },
    { grade: AnkiGrade.Easy, label: 'Easy' },
];

/** Defaults that match a fresh Anki install (v3 scheduler, FSRS off). */
export const DEFAULT_DECK_OPTIONS: DeckOptions = {
    newPerDay: 20,
    reviewsPerDay: 200,
    learningSteps: [1, 10],
    relearningSteps: [10],
    graduatingInterval: 1,
    easyInterval: 4,
    startingEase: 2500,
    easyBonus: 1300,
    intervalMultiplier: 1000,
    lapseMultiplier: 0,
    hardMultiplier: 1200,
    minimumInterval: 1,
    maximumInterval: 36500,
    leechThreshold: 8,
    leechAction: LeechAction.Suspend,
    buryNewSiblings: true,
    buryReviewSiblings: false,
    maxAnswerSeconds: 60,
    againDelayMinutes: 10,
    scheduler: DeckScheduler.Sm2,
    fsrs: {
        desiredRetention: 0.9,
        maximumInterval: 36500,
        weights: [],
        useOwnWeights: false,
    },
};

/** An Anki deck id for a newly created deck: epoch ms, as Anki would make it. */
export function newAnkiId(now: number = Date.now()): AnkiId {
    return String(now);
}

/**
 * Is this vault path a deck file (or anything under the deck folder)?
 *
 * Decks keep their own lane: their cards are scheduled per card, per deck, with
 * Anki's rules — so a deck file must never be picked up by the note scheduler,
 * and a note must never be mistaken for a deck.
 */
export function isDeckPath(path: string): boolean {
    const normalized = path.replace(/^\/+/, '');
    return normalized === DECKS_FOLDER || normalized.startsWith(`${DECKS_FOLDER}/`);
}

/** Media inside a deck bundle lives here, relative to the vault root. */
export const DECKS_FOLDER = 'spaceforge/decks';
/** Deck files themselves. */
export const DECKS_MEDIA_FOLDER = `${DECKS_FOLDER}/media`;
