/**
 * The deck document: `spaceforge/decks/<name>.md`.
 *
 * One markdown file holds one deck, and it is meant to be *read and edited by
 * a human* as well as parsed by the plugin. A learner can fix a typo in a
 * question, delete a card, reorder the sections or add one by hand; the plugin
 * can save along its own timers without trampling any of it.
 *
 * Layout
 * ------
 *
 * ```text
 * ---
 * sf-deck: 1                    format marker (this document)
 * id: "1700000000000"           the deck's Anki id (epoch ms, as a string)
 * name: "Cell Biology::Organelles"
 * created: 1700000000000        informational; the id already carries it
 * modified: 1700000000000
 * ankiWebId: "1234567"          when the deck came from AnkiWeb
 * sourceUrl: "https://…"        when known
 * parentId: null                when the deck was part of a hierarchy
 * scheduler: sm2                sm2 | fsrs
 * newPerDay: 20                 …every DeckOptions field, by its own name…
 * learningSteps: [1, 10]
 * leechAction: suspend          suspend | tagOnly
 * fsrs:                         only read when scheduler is fsrs
 *   desiredRetention: 0.9
 *   maximumInterval: 36500
 *   weights: []
 *   useOwnWeights: false
 * cards: 3                      a glance; the sections below are the truth
 * <any other key a human put here is preserved verbatim>
 * ---
 *
 * <!-- sf-deck-meta {"presets":[…],"media":[…],"deckPresetOf":{…}} -->
 *
 * # Cell Biology::Organelles
 *
 * ## 1700000000100
 * **Q**: What is the powerhouse of the cell?
 * **A**: The mitochondrion.
 * <!-- sf-card {"id":"1700000000100","nid":"1700000000090","ord":0,…} -->
 * ```
 *
 * What a human may safely do
 * --------------------------
 *
 * - Edit the `**Q**:` / `**A**:` text (both may run over several lines). The
 *   edit lands in the note's field values through the mapping documented below.
 * - Delete a card's section to drop the card.
 * - Reorder sections; a card is located by the id in its state line, not by
 *   its position, so ordering is free.
 * - Add a card by writing a `## <anything>` section with `**Q**:`/`**A**:` and
 *   no state line: it becomes a new card in the new queue, with fresh ids.
 * - Add, remove or retune any frontmatter option; a missing key falls back to
 *   Anki's default for that option.
 * - Write prose between sections, or a preamble under the deck title.
 *
 * What a human may not do without consequences
 * --------------------------------------------
 *
 * - A line starting with `## ` inside a card's text starts a new section (use
 *   `### ` for a heading inside an answer), and a line starting with
 *   `**Q**:`/`**A**:` inside a body is read as the next marker.
 * - The `sf-card` line is the card's schedule. Editing the JSON works, and
 *   keys this version does not know are carried through untouched; making the
 *   line invalid loses the schedule (the card becomes new) and is reported as
 *   a warning rather than thrown away.
 * - The heading is a label: the id on the state line is what identifies a
 *   card, and `cards:` is a count for the reader (the sections are the truth).
 * - A note with several cards shows the same fields in each of its sections.
 *   The first section is the one that is read back: edits there land, and the
 *   other sections are refreshed the next time the deck is written.
 *
 * The state line
 * --------------
 *
 * `id`, `nid`, `ord`, `type`, `queue`, `due` (epoch ms), `ivl`, `factor`
 * (permille), `reps`, `lapses`, `flag` are always written; `did` (only when
 * the card names a deck other than this file's), `npos` (absent means the card
 * has been introduced), `drd`, `mem` (`s`, `d`, `lr`, `sd`), `odue`, `opos`
 * and `time` only when they mean something. The note's own structure rides on
 * its first card's line under `note` (`model`, `fields`, `values`, `tags`,
 * `media`, `modified`) — only when the sections alone cannot rebuild it.
 *
 * Losslessness
 * ------------
 *
 * Anything the plugin does not model survives a round trip: unknown
 * frontmatter keys go back to the frontmatter (or, when the subset cannot
 * spell them, to the meta line's `deckExtra`), unknown keys in a card's state
 * line stay in that line, unknown keys in a note's payload stay with the note,
 * and anything else lives in `bundle.extra`. Notes and cards are written in
 * the bundle's own order and come back in that order; a note is assembled from
 * the cards that name it, so `cardIds` is always derived (a bundle whose
 * `cardIds` disagrees with its `cards` is not exactly representable), and a
 * note with no cards is not written at all.
 *
 * Note/card text mapping
 * ----------------------
 *
 * Each card section shows that card's own question and answer, rendered from
 * the note's field values:
 *
 * - a note with two or more fields: an even `ord` shows `values[0]` /
 *   `values[1]`, an odd `ord` shows `values[1]` / `values[0]` (so a
 *   Basic-and-reversed note reads naturally in both directions);
 * - a note with one field (a cloze): the question shows the text with the
 *   first deletion blanked as `[...]`, the answer shows the full text.
 *
 * The first section of a note is read back through the same mapping, so a hand
 * edit to its question or answer really does change the note.
 *
 * This module is deliberately pure: no Obsidian API, no vault, no IO. The
 * vault side lives in `services/deck-store.ts`. The YAML frontmatter is
 * parsed by a small subset reader (flat keys, flow lists, `- item` lists and
 * nested blocks) rather than by Obsidian's `parseYaml`, so the format can be
 * tested without an Obsidian instance; the matching writer always produces
 * something this reader reads back unchanged.
 */

import {
    AnkiCard,
    CardPresentation,
    AnkiCardQueue,
    AnkiCardType,
    AnkiDeck,
    AnkiId,
    AnkiNote,
    DeckBundle,
    DeckMediaFile,
    DeckOptions,
    DeckPreset,
    DeckScheduler,
    DEFAULT_DECK_OPTIONS,
    DECKS_FOLDER,
    LeechAction,
    newAnkiId,
} from './anki';
import { asBoolValue, asNumberValue, asRecordValue, asTextList, asTextValue } from '../utils/coerce';

/** The version of this document layout, written as `sf-deck: 1`. */
export const DECK_FORMAT_VERSION = 1;

/** The comment marker a card's machine state lives on. */
export const SF_CARD_MARKER = 'sf-card';

/** How a state line is recognised, tolerant of a hand-written spacing. */
const CARD_LINE_PATTERN = /<!--\s*sf-card\b/;

/** The comment marker the deck's machine-only metadata lives on. */
export const SF_META_MARKER = 'sf-deck-meta';

/** What a parse produced: the bundle, plus anything a human should know. */
export interface DeckParseResult {
    bundle: DeckBundle;
    /** Hand-edits the parser had to work around, in file order. */
    warnings: string[];
}

// ---------------------------------------------------------------- values

/** A value the frontmatter subset can hold. */
type YamlScalar = string | number | boolean | null;
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

/** Option fields that are numbers, in the order they are written. */
const OPTION_NUMBER_KEYS = [
    'newPerDay',
    'reviewsPerDay',
    'graduatingInterval',
    'easyInterval',
    'startingEase',
    'easyBonus',
    'intervalMultiplier',
    'lapseMultiplier',
    'hardMultiplier',
    'minimumInterval',
    'maximumInterval',
    'leechThreshold',
    'maxAnswerSeconds',
    'againDelayMinutes',
] as const;

/** Option fields that are lists of minutes. */
const OPTION_STEP_KEYS = ['learningSteps', 'relearningSteps'] as const;

/** Option fields that are switches. */
const OPTION_FLAG_KEYS = ['buryNewSiblings', 'buryReviewSiblings'] as const;

/** Keys the deck document owns; anything else in the frontmatter is extra. */
const KNOWN_FRONTMATTER_KEYS = new Set<string>([
    'sf-deck',
    'id',
    'name',
    'created',
    'modified',
    'ankiWebId',
    'sourceUrl',
    'parentId',
    'scheduler',
    'leechAction',
    'fsrs',
    'cards',
    ...OPTION_NUMBER_KEYS,
    ...OPTION_STEP_KEYS,
    ...OPTION_FLAG_KEYS,
]);

/** Keys the card state line owns; anything else is preserved as an extra. */
const KNOWN_CARD_KEYS = new Set<string>([
    'id',
    'nid',
    'did',
    'ord',
    'type',
    'queue',
    'due',
    'ivl',
    'factor',
    'reps',
    'lapses',
    'npos',
    'flag',
    'drd',
    'mem',
    'odue',
    'opos',
    'time',
    'note',
]);

/** Keys the note payload owns. */
const KNOWN_NOTE_KEYS = new Set<string>(['id', 'model', 'fields', 'values', 'tags', 'media', 'modified']);

/** Keys `sf-deck-meta` owns. */
const KNOWN_META_KEYS = new Set<string>(['presets', 'deckPresetOf', 'media', 'deckExtra']);

/** Reserved top-level names inside `bundle.extra`. */
const EXTRA_BUCKETS = new Set<string>(['deck', 'notes', 'cards']);

/**
 * An id for a note or card the parser had to invent, in Anki's own shape:
 * epoch milliseconds in the high digits and a sequence in the low ones, so two
 * cards created in the same millisecond never collide.
 */
let idSequence = Math.floor(Math.random() * 1000);
export function freshAnkiId(now: number = Date.now()): AnkiId {
    idSequence = (idSequence + 1) % 1000;
    return String(now * 1000 + idSequence);
}

// ---------------------------------------------------------------- paths

/**
 * The document path for a deck name.
 *
 * Anki names use `::` for hierarchy; a vault file cannot, so the separators
 * become ` - ` and the name stays readable in the file list. Characters that
 * are illegal in a file name are replaced by `-`, runs of whitespace collapse,
 * and a name that ends up empty becomes `deck`.
 *
 * The same name read twice yields the same path, so `takenPaths` (the vault
 * paths already in use) is how collisions are avoided: the second deck called
 * "Biology" is written as "Biology 2.md".
 */
export function deckDocumentPath(name: string, takenPaths?: Iterable<string>): string {
    const base = sanitizeDeckFileName(name) || 'deck';
    const taken = new Set(takenPaths ?? []);
    let candidate = `${DECKS_FOLDER}/${base}.md`;
    let counter = 2;
    while (taken.has(candidate)) {
        candidate = `${DECKS_FOLDER}/${base} ${counter}.md`;
        counter += 1;
    }
    return candidate;
}

/** The file-name-safe form of a deck (or media) name. */
export function sanitizeDeckFileName(name: string): string {
    let cleaned = name
        // Anki's hierarchy separator: flattened, and readable.
        .replace(/::/g, ' - ')
        // Windows' illegal set; ':' and '/' land here too. Runs collapse.
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/-{2,}/g, '-')
        .trim()
        // Windows also refuses a trailing dot or space, and a leading dot hides the file.
        .replace(/[.\s]+$/g, '')
        .replace(/^\.+/, '')
        .trim();
    cleaned = stripControlCharacters(cleaned);
    if (cleaned.length > 120) {
        cleaned = cleaned.slice(0, 120).replace(/[.\s-]+$/g, '');
    }
    return cleaned;
}

/** Control characters cannot be typed into a file name; they become dashes. */
function stripControlCharacters(value: string): string {
    let out = '';
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        out += code < 0x20 || code === 0x7f ? '-' : char;
    }
    return out;
}

/** True when the path is a deck document: a direct `spaceforge/decks/*.md` child. */
export function isDeckDocumentPath(path: string): boolean {
    const prefix = `${DECKS_FOLDER}/`;
    if (!path.startsWith(prefix) || !path.endsWith('.md')) return false;
    const rest = path.slice(prefix.length);
    return rest.length > 0 && !rest.includes('/');
}

// ---------------------------------------------------------------- media

/** One media reference found in card text, with where it sits in the string. */
export interface MediaReference {
    /** The reference exactly as written (a file name or a vault path). */
    reference: string;
    start: number;
    end: number;
}

/**
 * Every media reference in a piece of card text, in the order it appears:
 * markdown images and links, an Obsidian embed, a raw `<img src>`, and Anki's
 * `[sound:name]`. Absolute URLs are not media this deck owns and are skipped.
 */
export function findMediaReferences(text: string): MediaReference[] {
    const found: MediaReference[] = [];
    const push = (candidate: string | undefined, start: number, end: number): void => {
        const cleaned = (candidate ?? '').trim().replace(/^<|>$/g, '').trim();
        if (cleaned.length === 0) return;
        // http(s)://, data:, anchors, template placeholders: not files beside the deck.
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(cleaned)) return;
        found.push({ reference: cleaned, start, end });
    };

    for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*([^()]+?)(?:\s+["'(][^"')]*["')])?\s*\)/g)) {
        push(match[1], match.index ?? 0, (match.index ?? 0) + match[0].length);
    }
    for (const match of text.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
        push(match[1], match.index ?? 0, (match.index ?? 0) + match[0].length);
    }
    for (const match of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        push(match[1] ?? match[2] ?? match[3], match.index ?? 0, (match.index ?? 0) + match[0].length);
    }
    for (const match of text.matchAll(/\[sound:([^\]]+)\]/g)) {
        push(match[1], match.index ?? 0, (match.index ?? 0) + match[0].length);
    }

    return found.sort((a, b) => a.start - b.start);
}

/** Distinct media file names a piece of card text references, in order. */
export function deckMediaReferences(text: string): string[] {
    const seen = new Set<string>();
    const references: string[] = [];
    for (const match of findMediaReferences(text)) {
        if (seen.has(match.reference)) continue;
        seen.add(match.reference);
        references.push(match.reference);
    }
    return references;
}

/** Media a deck's text references, across every note field. */
export function bundleMediaReferences(bundle: DeckBundle): string[] {
    const references: string[] = [];
    const seen = new Set<string>();
    for (const note of bundle.notes) {
        for (const value of note.values) {
            for (const reference of deckMediaReferences(value)) {
                if (seen.has(reference)) continue;
                seen.add(reference);
                references.push(reference);
            }
        }
    }
    return references;
}

/**
 * Rewrite every media reference in the deck's text through `resolver`, which
 * is given the reference as written (and the note it was found on) and returns
 * the text to put in its place, or null to leave it alone. Note `mediaFiles`
 * entries go through the same resolver. The bundle is not modified; a new one
 * is returned, so a failed import cannot leave a half-rewritten deck behind.
 *
 * This is how a deck that moved folders (or an import landing its media in the
 * vault) keeps working: the text points at where the file is now.
 */
export function rewriteMediaPaths(
    bundle: DeckBundle,
    resolver: (reference: string, note: AnkiNote) => string | null
): DeckBundle {
    const notes = bundle.notes.map(note => {
        const values = note.values.map(value => rewriteText(value, reference => resolver(reference, note)));
        const mediaFiles = note.mediaFiles.map(name => resolver(name, note) ?? name);
        return { ...note, values, mediaFiles };
    });
    return { ...bundle, notes };
}

/** Apply a resolver to every media reference in one string. */
function rewriteText(text: string, resolver: (reference: string) => string | null): string {
    const matches = findMediaReferences(text);
    if (matches.length === 0) return text;
    let out = '';
    let cursor = 0;
    for (const match of matches) {
        if (match.start < cursor) continue; // a nested match; the outer one already covered it
        const replacement = resolver(match.reference);
        const inner = text.slice(match.start, match.end).indexOf(match.reference);
        out += text.slice(cursor, match.start);
        if (replacement === null || inner < 0) {
            out += text.slice(match.start, match.end);
        } else {
            // Only the reference moves: the image/link/embed syntax stays.
            const innerStart = match.start + inner;
            out += text.slice(match.start, innerStart);
            out += replacement;
            out += text.slice(innerStart + match.reference.length, match.end);
        }
        cursor = match.end;
    }
    return out + text.slice(cursor);
}

// ---------------------------------------------------------------- the deck

/** A new, empty deck with Anki's default options, merged with any overrides. */
export function newDeck(name: string, options?: Partial<DeckOptions>, now: number = Date.now()): DeckBundle {
    const merged: DeckOptions = {
        ...DEFAULT_DECK_OPTIONS,
        ...(options ?? {}),
        fsrs: { ...DEFAULT_DECK_OPTIONS.fsrs, ...(options?.fsrs ?? {}) },
        learningSteps: options?.learningSteps ? [...options.learningSteps] : [...DEFAULT_DECK_OPTIONS.learningSteps],
        relearningSteps: options?.relearningSteps ? [...options.relearningSteps] : [...DEFAULT_DECK_OPTIONS.relearningSteps],
    };
    return {
        deck: { id: newAnkiId(now), name, modified: now, options: merged },
        notes: [],
        cards: [],
        media: [],
    };
}

// ---------------------------------------------------------------- serialize

/** Render a deck bundle into its markdown document. */
export function serializeDeck(bundle: DeckBundle): string {
    const lines: string[] = [];
    lines.push('---');
    lines.push(...formatYamlBlock(deckFrontmatter(bundle), ''));
    lines.push('---');
    lines.push('');

    const meta = documentMeta(bundle);
    if (meta) {
        lines.push(`<!-- ${SF_META_MARKER} ${JSON.stringify(meta)} -->`);
        lines.push('');
    }

    lines.push(`# ${bundle.deck.name}`);
    lines.push('');

    const notesById = new Map(bundle.notes.map(note => [note.id, note]));
    const anchored = new Set<AnkiId>();
    for (const card of bundle.cards) {
        const note = notesById.get(card.noteId) ?? null;
        // The note's structure rides on the first card section that mentions
        // it, so the file stays one section per card.
        const anchor = note && !anchored.has(note.id) ? note : null;
        if (note) anchored.add(note.id);

        const text = note ? renderCardText(note, card.ord) : { question: '', answer: '' };
        lines.push(`## ${card.id}`);
        lines.push(`**Q**: ${text.question}`);
        for (const [index, choice] of (card.presentation?.mode === 'mcq' ? card.presentation.choices ?? [] : []).entries()) {
            lines.push(`${index + 1}. ${choice}`);
        }
        lines.push(`**A**: ${text.answer}`);
        lines.push(`<!-- ${SF_CARD_MARKER} ${JSON.stringify(cardState(card, bundle, anchor))} -->`);
        lines.push('');
    }

    return lines.join('\n');
}

/** The frontmatter entries, in a fixed, readable order. */
function deckFrontmatter(bundle: DeckBundle): [string, YamlValue][] {
    const deck = bundle.deck;
    const options = deck.options;
    const entries: [string, YamlValue][] = [
        ['sf-deck', DECK_FORMAT_VERSION],
        ['id', deck.id],
        ['name', deck.name],
    ];

    const created = Number(deck.id);
    if (/^\d{10,}$/.test(deck.id) && Number.isSafeInteger(created)) entries.push(['created', created]);
    entries.push(['modified', deck.modified]);

    if (deck.ankiWebId !== undefined) entries.push(['ankiWebId', deck.ankiWebId]);
    if (deck.sourceUrl !== undefined) entries.push(['sourceUrl', deck.sourceUrl]);
    if (deck.parentId !== undefined) entries.push(['parentId', deck.parentId]);

    entries.push(['scheduler', options.scheduler === DeckScheduler.Fsrs ? DeckScheduler.Fsrs : DeckScheduler.Sm2]);
    for (const key of OPTION_NUMBER_KEYS) entries.push([key, options[key]]);
    for (const key of OPTION_STEP_KEYS) entries.push([key, [...options[key]]]);
    entries.push(['leechAction', options.leechAction === LeechAction.TagOnly ? 'tagOnly' : 'suspend']);
    for (const key of OPTION_FLAG_KEYS) entries.push([key, options[key]]);
    entries.push(['fsrs', {
        desiredRetention: options.fsrs.desiredRetention,
        maximumInterval: options.fsrs.maximumInterval,
        weights: [...options.fsrs.weights],
        useOwnWeights: options.fsrs.useOwnWeights,
    }]);
    entries.push(['cards', bundle.cards.length]);

    for (const [key, value] of extraFrontmatterEntries(bundle)) entries.push([key, value]);
    return entries;
}

/** The card's machine state, in the documented short-key shape. */
function cardState(card: AnkiCard, bundle: DeckBundle, note: AnkiNote | null): Record<string, unknown> {
    const state = writeCardStateInto({}, card, bundle.deck.id);

    // Keys this document does not model ride along untouched.
    for (const [key, value] of Object.entries(extraFor(bundle, 'cards', card.id))) {
        if (!(key in state)) state[key] = value;
    }

    if (note) {
        const payload = notePayload(note, extraFor(bundle, 'notes', note.id));
        if (payload) state.note = payload;
    }
    return state;
}

/**
 * Overwrite a state object's schedule fields from a card, leaving everything
 * else on it (the note payload, unknown keys) exactly as it was. `deckId`
 * decides whether `did` is worth spelling out; pass null to leave it alone.
 */
function writeCardStateInto(
    state: Record<string, unknown>,
    card: AnkiCard,
    deckId: AnkiId | null
): Record<string, unknown> {
    state.id = card.id;
    state.nid = card.noteId;
    if (deckId !== null) {
        if (card.deckId === deckId) delete state.did;
        else state.did = card.deckId;
    }
    state.ord = card.ord;
    state.type = card.type;
    state.queue = card.queue;
    state.due = card.due;
    state.ivl = card.interval;
    state.factor = card.easeFactor;
    state.reps = card.reviews;
    state.lapses = card.lapses;
    if (card.newPosition === null) delete state.npos;
    else state.npos = card.newPosition;
    state.flag = card.flag;
    const presentation = card.presentation;
    if (presentation === undefined || presentation.mode === 'flip' || presentation.mode === 'cloze') {
        delete state.mode;
        delete state.choices;
        delete state.answer;
        delete state.accept;
        delete state.ci;
        delete state.nc;
    } else {
        state.mode = presentation.mode;
        if (presentation.mode === 'mcq') {
            state.choices = [...(presentation.choices ?? [])];
            state.answer = presentation.answer ?? -1;
        } else {
            delete state.choices;
            delete state.answer;
        }
        if (presentation.mode === 'type') {
            if (presentation.accept && presentation.accept.length > 0) state.accept = [...presentation.accept];
            else delete state.accept;
            if (presentation.caseInsensitive === true) state.ci = true;
            else delete state.ci;
            if (presentation.ignoreDiacritics === true) state.nc = true;
            else delete state.nc;
        } else {
            delete state.accept;
            delete state.ci;
            delete state.nc;
        }
    }
    if (card.desiredRetentionDays === undefined) delete state.drd;
    else state.drd = card.desiredRetentionDays;
    if (card.memory === undefined) {
        delete state.mem;
    } else {
        state.mem = {
            s: card.memory.stability,
            d: card.memory.difficulty,
            lr: card.memory.lastReview,
            sd: card.memory.scheduledDays,
        };
    }
    if (card.originalDue === undefined) delete state.odue;
    else state.odue = card.originalDue;
    if (card.originalPosition === undefined) delete state.opos;
    else state.opos = card.originalPosition;
    if (card.timeTakenMs === undefined) delete state.time;
    else state.time = card.timeTakenMs;
    return state;
}

/** The card id a state line names, for scanning a file without parsing it. */
export function cardIdOfStateLine(line: string): string | null {
    if (!CARD_LINE_PATTERN.test(line)) return null;
    const match = /"id"\s*:\s*"?([^",}\s]+)"?/.exec(line);
    return match ? match[1] : null;
}

/**
 * Rewrite one card's state line in place. The schedule comes from `card`;
 * the note payload and any unknown keys on the line are kept as written, so a
 * save during review touches nothing a human can see. Returns null when the
 * line is not a state line or its JSON cannot be read.
 */
export function updateCardStateLine(line: string, card: AnkiCard, deckId: AnkiId | null = null): string | null {
    const open = /<!--\s*sf-card\s*/.exec(line);
    if (!open) return null;
    const end = line.lastIndexOf('-->');
    if (end <= open.index + open[0].length) return null;

    let payload = line.slice(open.index + open[0].length, end).trim();
    if (payload.startsWith('{')) payload = payload.slice(1);
    if (payload.endsWith('}')) payload = payload.slice(0, -1);
    let state: Record<string, unknown>;
    try {
        const parsed = asRecordValue(JSON.parse(`{${payload}}`));
        if (!parsed) return null;
        state = parsed;
    } catch {
        return null;
    }
    return `<!-- ${SF_CARD_MARKER} ${JSON.stringify(writeCardStateInto(state, card, deckId))} -->`;
}

/**
 * The note's structure, or null when the sections alone can rebuild it
 * (a plain Basic note with no tags, no media and two fields).
 */
function notePayload(note: AnkiNote, noteExtra: Record<string, unknown>): Record<string, unknown> | null {
    const payload: Record<string, unknown> = { id: note.id };
    let needed = Object.keys(noteExtra).length > 0;

    const plainFields = note.fields.length === 2 && note.fields[0] === 'Front' && note.fields[1] === 'Back';
    if (note.modelName !== 'Basic') {
        payload.model = note.modelName;
        needed = true;
    }
    if (!plainFields) {
        payload.fields = [...note.fields];
        needed = true;
    }
    if (note.fields.length !== 2) {
        // Two-field notes are rebuilt from the card text; anything else has to
        // be said out loud or fields beyond the first two would be lost.
        payload.values = [...note.values];
        needed = true;
    }
    if (note.tags.length > 0) {
        payload.tags = [...note.tags];
        needed = true;
    }
    if (note.mediaFiles.length > 0) {
        payload.media = [...note.mediaFiles];
        needed = true;
    }
    if (note.modified !== undefined) {
        payload.modified = note.modified;
        needed = true;
    }
    for (const [key, value] of Object.entries(noteExtra)) {
        if (!(key in payload)) payload[key] = value;
    }
    return needed ? payload : null;
}

/** The `sf-deck-meta` payload, or null when there is nothing machine-only. */
function documentMeta(bundle: DeckBundle): Record<string, unknown> | null {
    const meta: Record<string, unknown> = {};
    if (bundle.presets && bundle.presets.length > 0) meta.presets = bundle.presets;
    if (bundle.deckPresetOf && Object.keys(bundle.deckPresetOf).length > 0) meta.deckPresetOf = bundle.deckPresetOf;
    if (bundle.media.length > 0) {
        meta.media = bundle.media.map(entry => {
            const json: Record<string, unknown> = { path: entry.path, originalName: entry.originalName };
            if (entry.mime !== undefined) json.mime = entry.mime;
            if (entry.size !== undefined) json.size = entry.size;
            return json;
        });
    }
    const deckExtra = frontmatterRefusedExtras(bundle);
    if (Object.keys(deckExtra).length > 0) meta.deckExtra = deckExtra;
    for (const [key, value] of Object.entries(extraRest(bundle))) {
        if (!KNOWN_META_KEYS.has(key)) meta[key] = value;
    }
    return Object.keys(meta).length > 0 ? meta : null;
}

/** The deck's own extras, either as frontmatter entries or as meta fallback. */
function extraFrontmatterEntries(bundle: DeckBundle): [string, YamlValue][] {
    const entries: [string, YamlValue][] = [];
    for (const [key, value] of Object.entries(extraBucket(bundle, 'deck'))) {
        if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
        if (isYamlSubsetValue(value)) entries.push([key, value]);
    }
    return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Extras a field cannot express in the frontmatter go to the meta line. */
function extraBucket(bundle: DeckBundle, bucket: 'deck' | 'notes' | 'cards'): Record<string, unknown> {
    const extra = bundle.extra ?? {};
    return asRecordValue(extra[bucket]) ?? {};
}

/** The unknown keys recorded for one card or note. */
function extraFor(bundle: DeckBundle, bucket: 'notes' | 'cards', id: AnkiId): Record<string, unknown> {
    return asRecordValue(extraBucket(bundle, bucket)[id]) ?? {};
}

/** Everything in `bundle.extra` that is not one of the three reserved buckets. */
function extraRest(bundle: DeckBundle): Record<string, unknown> {
    const extra = bundle.extra ?? {};
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(extra)) {
        if (EXTRA_BUCKETS.has(key)) continue;
        rest[key] = value;
    }
    return rest;
}

/**
 * Deck extras the frontmatter cannot hold unchanged (deep nesting, a list of
 * objects, a key that would collide with a known one). They ride in the meta
 * line under `deckExtra` so they come back where they were written.
 */
function frontmatterRefusedExtras(bundle: DeckBundle): Record<string, unknown> {
    const refused: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(extraBucket(bundle, 'deck'))) {
        if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
        if (!isYamlSubsetValue(value)) refused[key] = value;
    }
    return refused;
}

/** The question/answer a card shows, given its note. */
export function renderCardText(note: AnkiNote, ord: number): { question: string; answer: string } {
    if (note.fields.length <= 1) {
        const text = note.values[0] ?? '';
        return { question: blankCloze(text), answer: text };
    }
    const questionIndex = ord % 2 === 0 ? 0 : 1;
    const answerIndex = questionIndex === 0 ? 1 : 0;
    return {
        question: note.values[questionIndex] ?? '',
        answer: note.values[answerIndex] ?? '',
    };
}

/** A cloze text as the question side shows it: the first deletion blanked. */
function blankCloze(text: string): string {
    return text
        .replace(/\{\{c\d+::[^{}]*?::[^{}]*\}\}/g, '[...]')
        .replace(/\{\{c\d+::[^{}]*\}\}/g, '[...]');
}

// ---------------------------------------------------------------- parse

/**
 * Parse a deck document. Never throws: a hand-edited file always yields the
 * best deck that can be read out of it, and anything odd comes back as a
 * warning on {@link parseDeckWithWarnings}.
 */
export function parseDeck(text: string, path: string): DeckBundle {
    return parseDeckWithWarnings(text, path).bundle;
}

/** One parsed card section, plus everything later steps need from the file. */
interface ParsedCard {
    card: AnkiCard;
    question: string;
    answer: string;
    /** Multiple-choice options, when the section listed them. */
    choices: string[];
    /** The raw state line object, when the section had one. */
    state: Record<string, unknown> | null;
    /** The note payload that rode on the section's state line. */
    payload: Record<string, unknown> | null;
}

/** Parse a deck document, keeping the warnings for the reader. */
export function parseDeckWithWarnings(text: string, path: string): DeckParseResult {
    const warnings: string[] = [];
    try {
        const lines = text.split(/\r?\n/);

        let frontmatter: Record<string, YamlValue> = {};
        let bodyStart = 0;
        if ((lines[0] ?? '').trim() === '---') {
            let end = -1;
            for (let i = 1; i < lines.length; i++) {
                if (lines[i].trim() === '---') {
                    end = i;
                    break;
                }
            }
            if (end < 0) {
                warnings.push(`${path}: the frontmatter block is never closed; the deck was rebuilt from the cards.`);
            } else {
                frontmatter = parseYamlSubset(lines.slice(1, end).join('\n'));
                bodyStart = end + 1;
            }
        } else if (text.includes('## ')) {
            warnings.push(`${path}: no frontmatter found; the deck was rebuilt from the cards.`);
        }

        const deck = deckFromFrontmatter(frontmatter, path);
        const meta = metaFromText(text);

        const sections = splitSections(lines.slice(bodyStart), path, warnings);
        const cards: AnkiCard[] = [];
        const parsed: ParsedCard[] = [];

        for (const section of sections) {
            const question = section.question;
            const answer = section.answer;
            const state = section.state;
            if (!state) {
                // A section a human wrote: it is a new card, in the new queue.
                const card: AnkiCard = {
                    id: freshAnkiId(),
                    noteId: freshAnkiId(),
                    deckId: deck.id,
                    ord: 0,
                    type: AnkiCardType.New,
                    queue: AnkiCardQueue.New,
                    interval: 0,
                    easeFactor: deck.options.startingEase,
                    reviews: 0,
                    lapses: 0,
                    due: Date.now(),
                    newPosition: null,
                    flag: 0,
                };
                applyPresentation(card, section.choices, state, warnings);
                parsed.push({ card, question, answer, choices: section.choices, state: null, payload: null });
                cards.push(card);
                continue;
            }

            const card = cardFromState(state, deck, warnings);
            card.deckId = asTextValue(state.did) ?? deck.id;
            applyPresentation(card, section.choices, state, warnings);
            parsed.push({ card, question, answer, choices: section.choices, state, payload: asRecordValue(state.note) });
            cards.push(card);
        }

        const notes = notesFromSections(parsed, deck, warnings);
        const cardsOfNote = new Map<AnkiId, AnkiId[]>();
        for (const card of cards) {
            const ids = cardsOfNote.get(card.noteId) ?? [];
            ids.push(card.id);
            cardsOfNote.set(card.noteId, ids);
        }
        for (const note of notes) note.cardIds = cardsOfNote.get(note.id) ?? [];

        const extra = extrasFrom(parsed, meta, {
            ...frontmatterExtras(frontmatter),
            ...(asRecordValue(meta.deckExtra) ?? {}),
        });
        const bundle: DeckBundle = {
            deck,
            notes,
            cards,
            media: mediaFromMeta(meta, deck, warnings),
        };
        const presets = meta.presets;
        if (Array.isArray(presets) && presets.length > 0) bundle.presets = presets as DeckPreset[];
        if (asRecordValue(meta.deckPresetOf)) bundle.deckPresetOf = meta.deckPresetOf as Record<AnkiId, string>;
        if (Object.keys(extra).length > 0) bundle.extra = extra;

        return { bundle, warnings };
    } catch (error) {
        warnings.push(`${path}: the deck file could not be read (${String(error)}); it was treated as empty.`);
        return { bundle: emptyBundle(path), warnings };
    }
}

function emptyBundle(path: string): DeckBundle {
    const name = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
    return newDeck(name);
}

/** Build the deck record from the frontmatter, filling in Anki defaults. */
function deckFromFrontmatter(frontmatter: Record<string, YamlValue>, path: string): AnkiDeck {
    const fileName = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
    const id = asTextValue(frontmatter.id) ?? newAnkiId();
    const deck: AnkiDeck = {
        id,
        name: asTextValue(frontmatter.name) ?? fileName,
        modified: asNumberValue(frontmatter.modified) ?? 0,
        options: optionsFromFrontmatter(frontmatter),
    };
    const ankiWebId = asTextValue(frontmatter.ankiWebId);
    if (ankiWebId !== null) deck.ankiWebId = ankiWebId;
    const sourceUrl = asTextValue(frontmatter.sourceUrl);
    if (sourceUrl !== null) deck.sourceUrl = sourceUrl;
    if ('parentId' in frontmatter) {
        const parent = frontmatter.parentId;
        deck.parentId = parent === null ? null : asTextValue(parent);
    }
    return deck;
}

/** Read every option key that is present, falling back to the default. */
function optionsFromFrontmatter(frontmatter: Record<string, YamlValue>): DeckOptions {
    const options: DeckOptions = {
        ...DEFAULT_DECK_OPTIONS,
        learningSteps: [...DEFAULT_DECK_OPTIONS.learningSteps],
        relearningSteps: [...DEFAULT_DECK_OPTIONS.relearningSteps],
        fsrs: { ...DEFAULT_DECK_OPTIONS.fsrs, weights: [...DEFAULT_DECK_OPTIONS.fsrs.weights] },
    };

    for (const key of OPTION_NUMBER_KEYS) {
        const value = asNumberValue(frontmatter[key]);
        if (value !== null) options[key] = value;
    }
    for (const key of OPTION_STEP_KEYS) {
        const steps = numberList(frontmatter[key]);
        if (steps) options[key] = steps;
    }
    for (const key of OPTION_FLAG_KEYS) {
        const flag = asBoolValue(frontmatter[key]);
        if (flag !== null) options[key] = flag;
    }

    const scheduler = asTextValue(frontmatter.scheduler);
    if (scheduler !== null) options.scheduler = scheduler.toLowerCase() === 'fsrs' ? DeckScheduler.Fsrs : DeckScheduler.Sm2;

    const leechAction = asTextValue(frontmatter.leechAction);
    if (leechAction !== null) {
        options.leechAction = /tag/i.test(leechAction) ? LeechAction.TagOnly : LeechAction.Suspend;
    }

    const fsrs = asRecordValue(frontmatter.fsrs);
    if (fsrs) {
        const retention = asNumberValue(fsrs.desiredRetention);
        if (retention !== null) options.fsrs.desiredRetention = retention;
        const maximum = asNumberValue(fsrs.maximumInterval);
        if (maximum !== null) options.fsrs.maximumInterval = maximum;
        const weights = numberList(fsrs.weights);
        if (weights) options.fsrs.weights = weights;
        const useOwn = asBoolValue(fsrs.useOwnWeights);
        if (useOwn !== null) options.fsrs.useOwnWeights = useOwn;
    }
    return options;
}

/** A list of numbers from a number, a numeric string, or a list of either. */
function numberList(value: unknown): number[] | null {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
        const numbers = value.map(item => asNumberValue(item)).filter((item): item is number => item !== null);
        return numbers;
    }
    const single = asNumberValue(value);
    if (single !== null) return [single];
    const text = asTextValue(value);
    if (text === null) return null;
    const parts = text.split(/[,;]/).map(part => asNumberValue(part)).filter((part): part is number => part !== null);
    return parts.length > 0 ? parts : null;
}

/** One parsed card section, before notes are assembled. */
interface ParsedSection {
    heading: string;
    question: string;
    answer: string;
    /**
     * Multiple-choice options, written as a list between the question and the
     * answer. Empty for every other kind of card.
     */
    choices: string[];
    state: Record<string, unknown> | null;
}

/** Split the body into `## ` sections and read each one's text and state. */
function splitSections(lines: string[], path: string, warnings: string[]): ParsedSection[] {
    const sections: ParsedSection[] = [];
    let current: { heading: string; body: string[] } | null = null;

    const flush = (): void => {
        if (!current) return;
        const section = readSection(current, path, warnings);
        if (section) sections.push(section);
        current = null;
    };

    for (const line of lines) {
        const heading = /^##(?!#)\s*(.*)$/.exec(line);
        if (heading) {
            flush();
            current = { heading: heading[1].trim(), body: [] };
            continue;
        }
        if (current) current.body.push(line);
    }
    flush();
    return sections;
}

/** Read one section: its state line (if any) and its question/answer text. */
function readSection(source: { heading: string; body: string[] }, path: string, warnings: string[]): ParsedSection | null {
    const body = [...source.body];

    let state: Record<string, unknown> | null = null;
    const stateLine = body.findIndex(line => CARD_LINE_PATTERN.test(line));
    if (stateLine >= 0) {
        state = readStateLine(body[stateLine], path, warnings);
        body.splice(stateLine, 1);
    }

    const questionAt = body.findIndex(line => /^\s*\*\*q\*\*:\s?/i.test(line));
    const answerAt = body.findIndex(line => /^\s*\*\*a\*\*:\s?/i.test(line));
    if (state === null && questionAt < 0 && answerAt < 0) {
        // Free prose under a heading, not a card.
        return null;
    }

    const question = questionAt >= 0
        ? [body[questionAt].replace(/^\s*\*\*q\*\*:\s?/i, ''), ...body.slice(questionAt + 1, answerAt > questionAt ? answerAt : undefined)].join('\n')
        : '';
    const answer = answerAt >= 0
        ? [body[answerAt].replace(/^\s*\*\*a\*\*:\s?/i, ''), ...body.slice(answerAt + 1)].join('\n')
        : '';

    // A multiple-choice card lists its options between the question and the
    // answer: `1. …` or `- …`, one per line. They are pulled out of the text so
    // the question stays the question, and go back in on the next write.
    const choiceLines = question.split('\n');
    const choices: string[] = [];
    const questionLines: string[] = [];
    for (const line of choiceLines) {
        const choice = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(line);
        if (choice && answer.length > 0) choices.push(choice[1].trim());
        else questionLines.push(line);
    }

    return {
        heading: source.heading,
        question: questionLines.join('\n').replace(/^\s+|\s+$/g, ''),
        answer: answer.replace(/^\s+|\s+$/g, ''),
        choices,
        state,
    };
}

/**
 * The JSON on a card's state line. A malformed line is a warning, not a
 * failure: the card keeps its text and comes back as a new card.
 */
function readStateLine(line: string, path: string, warnings: string[]): Record<string, unknown> | null {
    const label = sectionLabel(line, path);
    const open = /<!--\s*sf-card\s*/.exec(line);
    const end = line.lastIndexOf('-->');
    const candidate = open && end > open.index + open[0].length
        ? line.slice(open.index + open[0].length, end).trim()
        : '';
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
        warnings.push(`${path}: the state line of section "${label}" is not a {...} block; the card was read as new.`);
        return null;
    }
    try {
        const record = asRecordValue(JSON.parse(candidate));
        if (!record) throw new Error('the state is not an object');
        return record;
    } catch (error) {
        warnings.push(`${path}: the state line of section "${label}" is not valid JSON (${String(error)}); the card was read as new.`);
        return null;
    }
}

function sectionLabel(line: string, path: string): string {
    const id = /"id"\s*:\s*"?([^",}\s]+)"?/.exec(line);
    return id ? id[1] : path.split('/').pop() ?? 'card';
}

/** A card from its state line; a missing id gets a fresh one. */
function cardFromState(state: Record<string, unknown>, deck: AnkiDeck, warnings: string[]): AnkiCard {
    const card: AnkiCard = {
        id: asTextValue(state.id) ?? freshAnkiId(),
        noteId: asTextValue(state.nid) ?? freshAnkiId(),
        deckId: deck.id,
        ord: asNumberValue(state.ord) ?? 0,
        type: (asNumberValue(state.type) ?? AnkiCardType.New),
        queue: (asNumberValue(state.queue) ?? AnkiCardQueue.New),
        interval: asNumberValue(state.ivl) ?? 0,
        easeFactor: asNumberValue(state.factor) ?? deck.options.startingEase,
        reviews: asNumberValue(state.reps) ?? 0,
        lapses: asNumberValue(state.lapses) ?? 0,
        due: asNumberValue(state.due) ?? Date.now(),
        newPosition: asNumberValue(state.npos),
        flag: asNumberValue(state.flag) ?? 0,
    };
    if (state.npos !== undefined && state.npos !== null && card.newPosition === null) {
        warnings.push(`card ${card.id}: "npos" is not a number.`);
    }
    const drd = asNumberValue(state.drd);
    if (drd !== null) card.desiredRetentionDays = drd;
    const mem = asRecordValue(state.mem);
    if (mem) {
        card.memory = {
            stability: asNumberValue(mem.s) ?? 0,
            difficulty: asNumberValue(mem.d) ?? 0,
            lastReview: asNumberValue(mem.lr) ?? 0,
            scheduledDays: asNumberValue(mem.sd) ?? 0,
        };
    }
    const originalDue = asNumberValue(state.odue);
    if (originalDue !== null) card.originalDue = originalDue;
    const originalPosition = asNumberValue(state.opos);
    if (originalPosition !== null) card.originalPosition = originalPosition;
    const timeTaken = asNumberValue(state.time);
    if (timeTaken !== null) card.timeTakenMs = timeTaken;
    return card;
}

/**
 * How the card asks its question.
 *
 * Read from the state line's short keys — `mode`, `choices`, `answer`,
 * `accept`, `ci`, `nc` — and, when a section listed its options as a numbered
 * or bulleted list, from that list as well. A card with options listed but no
 * `mode` is a multiple-choice card, because writing the options out is the
 * plainest way a person can say so. Anything unrecognised leaves the card on
 * its default reading (flip, or cloze when the text carries {{c1::…}}).
 */
function applyPresentation(
    card: AnkiCard,
    sectionChoices: string[],
    state: Record<string, unknown> | null,
    warnings: string[]
): void {
    const mode = asTextValue(state?.mode)?.toLowerCase() ?? null;
    const choices = asTextList(state?.choices);
    const listed = choices.length > 0 ? choices : sectionChoices;
    const answer = asNumberValue(state?.answer);
    const accept = asTextList(state?.accept);

    if (mode !== null && mode !== 'flip' && mode !== 'mcq' && mode !== 'type' && mode !== 'cloze') {
        warnings.push(`card ${card.id}: unknown mode "${mode}"; the card was read as a flip card.`);
    }

    const wanted = mode === 'flip' || mode === 'mcq' || mode === 'type' || mode === 'cloze' ? mode : null;
    const effective: typeof wanted = wanted ?? (listed.length > 0 ? 'mcq' : null);
    if (effective === null) return;

    const presentation: CardPresentation = { mode: effective };
    if (effective === 'mcq') {
        presentation.choices = listed;
        presentation.answer = answer ?? -1;
        if (listed.length > 0 && (answer === null || answer < 0 || answer >= listed.length)) {
            // Left to the reader to settle: the runner shows every choice and the
            // reveal lists the card's own answer text.
            presentation.answer = -1;
        }
    }
    if (effective === 'type') {
        if (accept.length > 0) presentation.accept = accept;
        if (state?.ci === true) presentation.caseInsensitive = true;
        if (state?.nc === true) presentation.ignoreDiacritics = true;
    }
    card.presentation = presentation;
}

/** Assemble the notes the card sections belong to, in first-appearance order. */
function notesFromSections(
    parsed: ParsedCard[],
    deck: AnkiDeck,
    warnings: string[]
): AnkiNote[] {
    const groups = new Map<AnkiId, ParsedCard[]>();
    for (const entry of parsed) {
        const group = groups.get(entry.card.noteId) ?? [];
        group.push(entry);
        groups.set(entry.card.noteId, group);
    }

    const notes: AnkiNote[] = [];
    for (const [noteId, group] of groups) {
        const payload = group.map(entry => entry.payload).find((entry): entry is Record<string, unknown> => entry !== null) ?? null;

        const fields = payload ? asTextList(payload.fields) : [];
        const noteFields = fields.length > 0 ? fields : ['Front', 'Back'];
        const values = payload ? asTextList(payload.values) : [];
        const note: AnkiNote = {
            id: asTextValue(payload?.id) ?? noteId,
            modelName: asTextValue(payload?.model) ?? 'Basic',
            fields: noteFields,
            values: values.length >= noteFields.length ? padValues(values, noteFields.length) : valuesFromText(group, noteFields),
            tags: payload ? asTextList(payload.tags) : [],
            cardIds: group.map(entry => entry.card.id),
            mediaFiles: payload ? asTextList(payload.media) : mediaFilesFromText(group),
        };

        // A hand edit is read from the note's first section — the same section
        // its payload rides on. Later sections render the same fields, so if
        // one of them disagrees it is a stale view of a field the first section
        // already settled, and the next full write refreshes it.
        const anchor = group[0];
        if (noteFields.length <= 1) {
            const text = anchor.answer.length > 0 ? anchor.answer : anchor.question;
            if (text.length > 0) note.values = [text];
        } else {
            const rendered = renderCardValues(note.values, noteFields, anchor.card.ord);
            const questionIndex = anchor.card.ord % 2 === 0 ? 0 : 1;
            if (anchor.question !== rendered.question) note.values[questionIndex] = anchor.question;
            if (anchor.answer !== rendered.answer) note.values[questionIndex === 0 ? 1 : 0] = anchor.answer;
        }

        const modified = payload ? asNumberValue(payload.modified) : null;
        if (modified !== null) note.modified = modified;

        if (!payload && note.values.length === 0) {
            warnings.push(`note ${note.id}: it has no readable text.`);
        }
        notes.push(note);
    }
    return notes;
}

/** The question/answer a card's values render to, for a note's field shape. */
function renderCardValues(values: string[], fields: string[], ord: number): { question: string; answer: string } {
    if (fields.length <= 1) {
        const text = values[0] ?? '';
        return { question: blankCloze(text), answer: text };
    }
    const questionIndex = ord % 2 === 0 ? 0 : 1;
    const answerIndex = questionIndex === 0 ? 1 : 0;
    return { question: values[questionIndex] ?? '', answer: values[answerIndex] ?? '' };
}

/** Grow a short value list to the note's field count. */
function padValues(values: string[], count: number): string[] {
    const padded = values.slice(0, count);
    while (padded.length < count) padded.push('');
    return padded;
}

/** Values for a note whose sections carry the text (no payload). */
function valuesFromText(
    group: { card: AnkiCard; question: string; answer: string }[],
    fields: string[]
): string[] {
    const first = group[0];
    if (fields.length <= 1) {
        const text = first.answer.length > 0 ? first.answer : first.question;
        return text.length > 0 ? [text] : [];
    }
    const inverted = first.card.ord % 2 !== 0;
    return inverted ? [first.answer, first.question] : [first.question, first.answer];
}

/** Media names a note's sections reference, when the note has no payload. */
function mediaFilesFromText(group: { question: string; answer: string }[]): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of group) {
        for (const reference of deckMediaReferences(`${entry.question}\n${entry.answer}`)) {
            if (seen.has(reference)) continue;
            seen.add(reference);
            names.push(reference);
        }
    }
    return names;
}

/** The `sf-deck-meta` object, or an empty record. */
function metaFromText(text: string): Record<string, unknown> {
    const at = text.indexOf(`<!-- ${SF_META_MARKER}`);
    if (at < 0) return {};
    const end = text.indexOf('-->', at);
    if (end < 0) return {};
    const body = text.slice(at + `<!-- ${SF_META_MARKER}`.length, end).trim();
    try {
        return asRecordValue(JSON.parse(body)) ?? {};
    } catch {
        return {};
    }
}

/** The media list out of the meta line. */
function mediaFromMeta(meta: Record<string, unknown>, deck: AnkiDeck, warnings: string[]): DeckMediaFile[] {
    const raw = meta.media;
    if (!Array.isArray(raw)) return [];
    const media: DeckMediaFile[] = [];
    for (const entry of raw) {
        if (typeof entry === 'string') {
            media.push({ path: entry, originalName: entry.split('/').pop() ?? entry });
            continue;
        }
        const record = asRecordValue(entry);
        if (!record) continue;
        const path = asTextValue(record.path);
        if (path === null) {
            warnings.push(`deck ${deck.id}: a media entry has no path and was dropped.`);
            continue;
        }
        const file: DeckMediaFile = {
            path,
            originalName: asTextValue(record.originalName) ?? path.split('/').pop() ?? path,
        };
        const mime = asTextValue(record.mime);
        if (mime !== null) file.mime = mime;
        const size = asNumberValue(record.size);
        if (size !== null) file.size = size;
        media.push(file);
    }
    return media;
}

/** Everything a round trip has to keep but the document does not model. */
function extrasFrom(
    parsed: ParsedCard[],
    meta: Record<string, unknown>,
    deck: Record<string, unknown>
): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    if (Object.keys(deck).length > 0) extra.deck = deck;

    // Unknown keys in a card's state line and in a note's payload.
    const cards: Record<string, unknown> = {};
    const notes: Record<string, unknown> = {};
    for (const entry of parsed) {
        if (entry.state) {
            const unknown: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(entry.state)) {
                if (KNOWN_CARD_KEYS.has(key)) continue;
                unknown[key] = value;
            }
            if (Object.keys(unknown).length > 0) cards[entry.card.id] = unknown;
        }
        if (entry.payload) {
            const unknown: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(entry.payload)) {
                if (KNOWN_NOTE_KEYS.has(key)) continue;
                unknown[key] = value;
            }
            const noteId = asTextValue(entry.payload.id);
            if (Object.keys(unknown).length > 0 && noteId !== null) notes[noteId] = unknown;
        }
    }
    if (Object.keys(cards).length > 0) extra.cards = cards;
    if (Object.keys(notes).length > 0) extra.notes = notes;

    // Anything else the meta line carried is kept verbatim.
    for (const [key, value] of Object.entries(meta)) {
        if (KNOWN_META_KEYS.has(key) || EXTRA_BUCKETS.has(key)) continue;
        extra[key] = value;
    }
    return extra;
}

/** Frontmatter keys this document does not model, kept for the round trip. */
function frontmatterExtras(frontmatter: Record<string, YamlValue>): Record<string, unknown> {
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
        if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
        extras[key] = value;
    }
    return extras;
}

// ---------------------------------------------------------------- yaml subset

/** Format a scalar the way the subset reader reads it back. */
function formatYamlScalar(value: YamlScalar): string {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (value.length === 0) return '""';
    // A bare word stays readable; anything that could be read as a number,
    // a boolean, or that contains punctuation is quoted instead.
    if (/^[A-Za-z_][A-Za-z0-9 _./+-]*$/.test(value) && !/^(true|false|null|yes|no|on|off)$/i.test(value)) {
        return value;
    }
    return JSON.stringify(value);
}

function formatYamlKey(key: string): string {
    return /^[A-Za-z_][A-Za-z0-9 _-]*$/.test(key) ? key : JSON.stringify(key);
}

/** Write a block mapping (and any nested blocks) as YAML-subset lines. */
function formatYamlBlock(entries: [string, YamlValue][], indent: string): string[] {
    const lines: string[] = [];
    for (const [key, value] of entries) {
        const name = formatYamlKey(key);
        if (Array.isArray(value)) {
            if (value.length === 0) {
                lines.push(`${indent}${name}: []`);
                continue;
            }
            if (value.every(item => item === null || typeof item !== 'object')) {
                const scalars = value.filter((item): item is YamlScalar => item === null || typeof item !== 'object');
                lines.push(`${indent}${name}: [${scalars.map(item => formatYamlScalar(item)).join(', ')}]`);
                continue;
            }
            lines.push(`${indent}${name}:`);
            for (const item of value) {
                if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
                    const child = formatYamlBlock(Object.entries(item), `${indent}  `);
                    const [first, ...rest] = child;
                    if (first !== undefined) lines.push(`${indent}  - ${first.trimStart()}`, ...rest);
                } else {
                    lines.push(`${indent}  - ${formatYamlScalar(item as YamlScalar)}`);
                }
            }
            continue;
        }
        if (value !== null && typeof value === 'object') {
            const child = formatYamlBlock(Object.entries(value), `${indent}  `);
            if (child.length === 0) {
                lines.push(`${indent}${name}: {}`);
                continue;
            }
            lines.push(`${indent}${name}:`, ...child);
            continue;
        }
        lines.push(`${indent}${name}: ${formatYamlScalar(value)}`);
    }
    return lines;
}

interface YamlToken {
    indent: number;
    content: string;
}

/**
 * The frontmatter reader: a documented subset of YAML —
 *
 * - `key: value` scalars: plain strings, `"quoted"` strings (JSON escapes),
 *   `'single quoted'`, numbers, `true`/`false`/`yes`/`no`/`on`/`off`,
 *   `null`/`~`;
 * - `key: [a, b]` flow lists and `- item` block lists of scalars;
 * - one nested block per key, to any depth (`fsrs:` and hand-written maps);
 * - `#` comment lines and trailing ` #` comments.
 *
 * Not supported (and not written): anchors, aliases, multi-line scalars, tags,
 * documents. A value the writer cannot express in the subset is kept in the
 * `sf-deck-meta` line instead, so nothing is lost by the limit.
 */
function parseYamlSubset(text: string): Record<string, YamlValue> {
    const tokens: YamlToken[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\t/g, '  ');
        const content = line.trim();
        if (content.length === 0 || content.startsWith('#')) continue;
        tokens.push({ indent: line.length - line.trimStart().length, content });
    }
    if (tokens.length === 0) return {};
    const [record] = parseYamlBlock(tokens, 0, tokens[0].indent);
    return record;
}

function parseYamlBlock(tokens: YamlToken[], index: number, indent: number): [Record<string, YamlValue>, number] {
    const record: Record<string, YamlValue> = {};
    let i = index;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.indent < indent) break;
        if (token.indent > indent) {
            i += 1;
            continue;
        }
        if (token.content.startsWith('- ') || token.content === '-') break;

        const split = splitYamlLine(token.content);
        if (!split) {
            i += 1;
            continue;
        }
        const next = tokens[i + 1];
        if (split.rest.length === 0 && next && next.indent > indent) {
            if (next.content.startsWith('- ') || next.content === '-') {
                const [list, after] = parseYamlSequence(tokens, i + 1, next.indent);
                record[split.key] = list;
                i = after;
            } else {
                const [child, after] = parseYamlBlock(tokens, i + 1, next.indent);
                record[split.key] = child;
                i = after;
            }
            continue;
        }
        record[split.key] = split.rest.length === 0 ? null : parseYamlScalar(split.rest);
        i += 1;
    }
    return [record, i];
}

function parseYamlSequence(tokens: YamlToken[], index: number, indent: number): [YamlValue[], number] {
    const list: YamlValue[] = [];
    let i = index;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.indent < indent) break;
        if (token.indent > indent) {
            i += 1;
            continue;
        }
        if (!token.content.startsWith('- ') && token.content !== '-') break;
        const item = token.content.replace(/^-\s?/, '');
        list.push(item.length === 0 ? null : parseYamlScalar(item));
        i += 1;
    }
    return [list, i];
}

/** Split `key: rest` at the first colon outside quotes. */
function splitYamlLine(content: string): { key: string; rest: string } | null {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (char === '\\' && inDouble) {
            i += 1;
            continue;
        }
        if (char === '"' && !inSingle) inDouble = !inDouble;
        else if (char === "'" && !inDouble) inSingle = !inSingle;
        else if (char === ':' && !inSingle && !inDouble) {
            const rest = content.slice(i + 1);
            if (rest.length === 0 || /^\s/.test(rest)) {
                return { key: unquoteKey(content.slice(0, i).trim()), rest: rest.trim() };
            }
        }
    }
    return null;
}

function unquoteKey(key: string): string {
    if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(key);
            if (typeof parsed === 'string') return parsed;
        } catch {
            return key.slice(1, -1);
        }
    }
    if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
    return key;
}

/** Read one scalar, with the subset's number/boolean/null rules. */
function parseYamlScalar(raw: string): YamlValue {
    const value = raw.trim();
    if (value.length === 0) return null;
    const quoted = readQuotedScalar(value);
    if (quoted) return quoted.value;
    // An unquoted value can carry a trailing comment, so text that only looked
    // like a list or a number does not.
    const bare = stripInlineComment(value);
    if (bare.length === 0) return null;
    if (bare.startsWith('[') && bare.endsWith(']')) {
        const inner = bare.slice(1, -1).trim();
        if (inner.length === 0) return [];
        return splitFlowItems(inner).map(item => parseYamlScalar(item));
    }
    if (/^[-+]?\d+$/.test(bare)) {
        const parsed = Number.parseInt(bare, 10);
        return Number.isSafeInteger(parsed) ? parsed : bare;
    }
    if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(bare)) return Number.parseFloat(bare);
    if (/^(?:true|yes|on)$/i.test(bare)) return true;
    if (/^(?:false|no|off)$/i.test(bare)) return false;
    if (/^(?:null|~)$/i.test(bare)) return null;
    return bare;
}

/**
 * A quoted scalar, plus whatever follows it (which may only be a comment).
 * Returns null when the value is not one quoted scalar, leaving it to the
 * unquoted path.
 */
function readQuotedScalar(value: string): { value: YamlValue } | null {
    const quote = value[0];
    if (quote !== '"' && quote !== "'") return null;
    let i = 1;
    let end = -1;
    while (i < value.length) {
        const char = value[i];
        if (quote === '"' && char === '\\') {
            i += 2;
            continue;
        }
        if (char === quote) {
            if (quote === "'" && value[i + 1] === "'") {
                i += 2;
                continue;
            }
            end = i;
            break;
        }
        i += 1;
    }
    if (end < 0) return null;
    const rest = value.slice(end + 1).trim();
    if (rest.length > 0 && !rest.startsWith('#')) return null;
    const raw = value.slice(0, end + 1);
    if (quote === "'") return { value: raw.slice(1, -1).replace(/''/g, "'") };
    try {
        const parsed: unknown = JSON.parse(raw);
        return { value: parsed === undefined ? raw : (parsed as YamlValue) };
    } catch {
        return { value: raw.slice(1, -1) };
    }
}

/** Drop a trailing ` # comment` that is not inside quotes. */
function stripInlineComment(value: string): string {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char === '\\' && inDouble) {
            i += 1;
            continue;
        }
        if (char === '"' && !inSingle) inDouble = !inDouble;
        else if (char === "'" && !inDouble) inSingle = !inSingle;
        else if (char === '#' && !inSingle && !inDouble && i > 0 && /\s/.test(value[i - 1])) {
            return value.slice(0, i).trim();
        }
    }
    return value;
}

function splitFlowItems(inner: string): string[] {
    const items: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < inner.length; i++) {
        const char = inner[i];
        if (char === '\\' && inDouble) {
            current += char + (inner[i + 1] ?? '');
            i += 1;
            continue;
        }
        if (char === '"' && !inSingle) inDouble = !inDouble;
        else if (char === "'" && !inDouble) inSingle = !inSingle;
        if (char === ',' && !inSingle && !inDouble) {
            items.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim().length > 0) items.push(current.trim());
    return items;
}

/** True when the value survives a frontmatter write and read unchanged. */
function isYamlSubsetValue(value: unknown, depth = 0): value is YamlValue {
    if (value === null || value === undefined) return value === null;
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return true;
    if (type === 'number') return Number.isFinite(value);
    if (depth > 4) return false;
    if (Array.isArray(value)) {
        // Scalar lists only: the subset reader does not rebuild objects in a list.
        return value.every(item => item === null || typeof item !== 'object');
    }
    if (type === 'object') {
        return Object.values(value as Record<string, unknown>).every(item => isYamlSubsetValue(item, depth + 1));
    }
    return false;
}
