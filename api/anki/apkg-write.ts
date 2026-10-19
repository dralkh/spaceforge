/**
 * Writing Anki packages.
 *
 * The export format is the one every Anki version can read: a plain
 * `collection.anki2` (SQLite, schema 11), the legacy `media` JSON map, media
 * files stored under numeric names, and a `meta` marker. Anki migrates the
 * collection on import, which is exactly what it does with a deck exported by
 * an older client.
 *
 * Identifiers are Anki-shaped: epoch-millisecond integers as strings, distinct
 * across decks, notes and cards. Notes get a base91 guid derived from their id
 * (deterministic, so re-exporting a deck does not invent new identities), and
 * `sfld`/`csum` are computed the way Anki computes them.
 *
 * The bundle itself carries no media bytes (`DeckMediaFile` has no such field),
 * so the bytes arrive through `options.media` — a `readApkg()` result can be
 * passed straight back in — or through `bundle.extra.media`. Media without bytes
 * is reported in `warnings` and left out.
 *
 * `bundle.extra` is also where round-trip fidelity lives, all optional:
 *   `crt`, `mod`, `scm` — collection stamps (numbers);
 *   `models`, `decks`, `dconf`, `conf` — raw collection JSON, as `readApkg()`
 *     reports it in `meta.raw`, reused verbatim;
 *   `cards` — `{ [cardId]: { pos?, odid?, left?, data? } }` for the card
 *     columns Spaceforge does not model;
 *   `revlog`, `graves` — raw rows to carry over;
 *   `media` — `{ [originalName]: bytes }`;
 *   `now` — a fixed clock, for deterministic output.
 */

import { AnkiCard, AnkiCardType, AnkiId, DeckBundle, DeckMediaFile, DeckPreset } from '../../models/anki';
import { deckOptionsToAnki, dueToStorage } from './apkg';
import { SqliteWriteIndex, SqliteWriteTable, SqlValueIn, writeSqlite } from './sqlite-write';
import { ZipWriteEntry, writeZip } from './zip';

/** Media the caller can hand over, in addition to whatever the bundle lists. */
export interface AnkiMediaSource extends DeckMediaFile {
    bytes?: Uint8Array;
}

/** How the package identifies itself. */
export type ApkgMetaStyle = 'json' | 'protobuf' | 'none';

export interface WriteApkgOptions {
    /** Media bytes, matched to `bundle.media` by original name or path. */
    media?: readonly AnkiMediaSource[];
    /**
     * The `meta` entry. 'protobuf' is the default and the one to ship: Anki
     * protobuf-decodes this entry (`rslib/src/import_export/package/meta.rs`) and
     * *fails the import* when the decode does not fit, while a missing entry is
     * inferred from which collection file is inside. The default writes the
     * `PackageMetadata { version: VERSION_LEGACY_1 }` marker that goes with a
     * `collection.anki2` database. 'none' omits it (Anki then infers legacy 1),
     * and 'json' reproduces the marker older writers used, for old fixtures only.
     */
    meta?: ApkgMetaStyle;
    /** Fixed clock, for deterministic exports. Defaults to `Date.now()`. */
    now?: number;
}

export interface WriteApkgResult {
    bytes: Uint8Array;
    /** Media files written into the package. */
    media: number;
    notes: number;
    cards: number;
    warnings: string[];
}

/** The schema Anki 2.1 writes, verbatim, so an import needs no repair. */
export const SCHEMA_SQL = {
    col: `CREATE TABLE col (
  id integer PRIMARY KEY,
  crt integer NOT NULL,
  mod integer NOT NULL,
  scm integer NOT NULL,
  ver integer NOT NULL,
  dty integer NOT NULL,
  usn integer NOT NULL,
  ls integer NOT NULL,
  conf text NOT NULL,
  models text NOT NULL,
  decks text NOT NULL,
  dconf text NOT NULL,
  tags text NOT NULL
)`,
    notes: `CREATE TABLE notes (
  id integer PRIMARY KEY,
  guid text NOT NULL,
  mid integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  tags text NOT NULL,
  flds text NOT NULL,
  sfld integer NOT NULL,
  csum integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
)`,
    cards: `CREATE TABLE cards (
  id integer PRIMARY KEY,
  nid integer NOT NULL,
  did integer NOT NULL,
  ord integer NOT NULL,
  mod integer NOT NULL,
  usn integer NOT NULL,
  type integer NOT NULL,
  queue integer NOT NULL,
  due integer NOT NULL,
  ivl integer NOT NULL,
  factor integer NOT NULL,
  reps integer NOT NULL,
  lapses integer NOT NULL,
  left integer NOT NULL,
  odue integer NOT NULL,
  odid integer NOT NULL,
  flags integer NOT NULL,
  data text NOT NULL
)`,
    revlog: `CREATE TABLE revlog (
  id integer PRIMARY KEY,
  cid integer NOT NULL,
  usn integer NOT NULL,
  ease integer NOT NULL,
  ivl integer NOT NULL,
  lastIvl integer NOT NULL,
  factor integer NOT NULL,
  time integer NOT NULL,
  type integer NOT NULL
)`,
    graves: `CREATE TABLE graves (
  usn integer NOT NULL,
  oid integer NOT NULL,
  type integer NOT NULL
)`,
};

const NOTES_COLUMNS = ['id', 'guid', 'mid', 'mod', 'usn', 'tags', 'flds', 'sfld', 'csum', 'flags', 'data'];
const CARDS_COLUMNS = ['id', 'nid', 'did', 'ord', 'mod', 'usn', 'type', 'queue', 'due', 'ivl', 'factor', 'reps', 'lapses', 'left', 'odue', 'odid', 'flags', 'data'];
const REVLOG_COLUMNS = ['id', 'cid', 'usn', 'ease', 'ivl', 'lastIvl', 'factor', 'time', 'type'];
const GRAVES_COLUMNS = ['usn', 'oid', 'type'];
const COL_COLUMNS = ['id', 'crt', 'mod', 'scm', 'ver', 'dty', 'usn', 'ls', 'conf', 'models', 'decks', 'dconf', 'tags'];

/** The indexes from Anki's own schema 11, so a fresh import is not slower. */
export const SCHEMA_INDEXES: readonly SqliteWriteIndex[] = [
    { name: 'ix_notes_usn', sql: 'CREATE INDEX ix_notes_usn ON notes (usn)', table: 'notes', columns: [4] },
    { name: 'ix_cards_usn', sql: 'CREATE INDEX ix_cards_usn ON cards (usn)', table: 'cards', columns: [5] },
    { name: 'ix_revlog_usn', sql: 'CREATE INDEX ix_revlog_usn ON revlog (usn)', table: 'revlog', columns: [2] },
    { name: 'ix_cards_nid', sql: 'CREATE INDEX ix_cards_nid ON cards (nid)', table: 'cards', columns: [1] },
    { name: 'ix_cards_sched', sql: 'CREATE INDEX ix_cards_sched ON cards (did, queue, due)', table: 'cards', columns: [2, 7, 8] },
    { name: 'ix_revlog_cid', sql: 'CREATE INDEX ix_revlog_cid ON revlog (cid)', table: 'revlog', columns: [1] },
    { name: 'ix_notes_csum', sql: 'CREATE INDEX ix_notes_csum ON notes (csum)', table: 'notes', columns: [8] },
];

/* --------------------------------------------------------------- sha-1 */

/**
 * SHA-1, because Anki's note checksum is the first four bytes of
 * `sha1(first field)`. Small and synchronous: `crypto.subtle` is async and not
 * available everywhere Obsidian runs.
 */
export function sha1(message: Uint8Array): Uint8Array {
    const padded = new Uint8Array((((message.length + 8) >> 6) + 1) << 6);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = message.length * 8;
    view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296), false);
    view.setUint32(padded.length - 4, bitLength >>> 0, false);

    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;
    const words = new Uint32Array(80);
    for (let block = 0; block < padded.length; block += 64) {
        for (let i = 0; i < 16; i++) {
            words[i] = view.getUint32(block + i * 4, false);
        }
        for (let i = 16; i < 80; i++) {
            const value = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
            words[i] = ((value << 1) | (value >>> 31)) >>> 0;
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        for (let i = 0; i < 80; i++) {
            let f: number;
            let k: number;
            if (i < 20) {
                f = (b & c) | (~b & d);
                k = 0x5a827999;
            } else if (i < 40) {
                f = b ^ c ^ d;
                k = 0x6ed9eba1;
            } else if (i < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdc;
            } else {
                f = b ^ c ^ d;
                k = 0xca62c1d6;
            }
            const temp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + words[i]) >>> 0;
            e = d;
            d = c;
            c = ((b << 30) | (b >>> 2)) >>> 0;
            b = a;
            a = temp;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, h0, false);
    outView.setUint32(4, h1, false);
    outView.setUint32(8, h2, false);
    outView.setUint32(12, h3, false);
    outView.setUint32(16, h4, false);
    return out;
}

/* ------------------------------------------------------------ note text */

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '\u2013',
    mdash: '\u2014',
    hellip: '\u2026',
    copy: '\u00a9',
};

/** HTML entities, as far as a note's sort field is concerned. */
function decodeEntities(text: string): string {
    return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
        if (entity.startsWith('#')) {
            const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
        }
        return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

/**
 * The text Anki sorts a note by: tags removed, media file names kept (Anki
 * keeps them so the sort order does not change when a sound is added), comments
 * and scripts removed, entity references resolved.
 */
export function stripHtmlPreservingMedia(html: string): string {
    const withMedia = html.replace(/<\s*(?:img|audio|video|object|source)\b[^>]*>/gi, (tag) => {
        const match = /(?:\b(?:src|data)\s*=\s*)["']([^"']*)["']/i.exec(tag);
        return match ? ` ${match[1]} ` : ' ';
    });
    const stripped = withMedia
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\[sound:([^\]]+)\]/g, ' $1 ');
    return decodeEntities(stripped).replace(/\u00a0/g, ' ');
}

/** Anki's note checksum: the first four bytes of sha1(field 1), big-endian. */
export function noteChecksum(firstField: string): number {
    const digest = sha1(new TextEncoder().encode(stripHtmlPreservingMedia(firstField)));
    return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

/**
 * `sfld`. The column has integer affinity in Anki's schema, so a field that is
 * a plain integer is stored as one and sorts numerically — which is what Anki
 * itself ends up with.
 */
export function noteSortField(firstField: string): string | number {
    const stripped = stripHtmlPreservingMedia(firstField).trim();
    return /^-?\d{1,18}$/.test(stripped) ? Number(stripped) : stripped;
}

/* -------------------------------------------------------------- base91 */

/** The alphabet Anki's guids are drawn from, least significant digit first. */
const BASE91 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';

/**
 * Anki's base-91 encoding of a 64-bit value, split into `hi`/`lo` halves
 * because JavaScript numbers stop at 2^53. Reproduces Anki's own output,
 * including its short strings for small values (`anki_base91(1) == "b"`).
 */
export function ankiBase91FromParts(hi: number, lo: number): string {
    let high = hi >>> 0;
    let low = lo >>> 0;
    // Digits come out least significant first, as in Anki's own loop; the
    // string itself reads most significant first.
    const digits: string[] = [];
    while (high > 0 || low > 0) {
        const quotient = Math.floor(high / 91);
        const remainder = high - quotient * 91;
        const combined = remainder * 4294967296 + low; // below 91 * 2^32: exact
        const lowQuotient = Math.floor(combined / 91);
        digits.push(BASE91[combined - lowQuotient * 91]);
        high = quotient;
        low = lowQuotient;
    }
    return digits.reverse().join('');
}

/** Anki's base-91 encoding of a value small enough for a JS number. */
export function ankiBase91(value: number): string {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error('base91 needs a non-negative integer');
    }
    return ankiBase91FromParts(Math.floor(value / 4294967296), value >>> 0);
}

function fnv32(text: string, seed: number): number {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
}

/**
 * A guid for a note. Anki accepts any base-91 string, and deriving one from the
 * note's id keeps re-exports identical (so Anki sees the same note again rather
 * than a duplicate).
 */
export function guidForNote(noteId: string): string {
    const hi = fnv32(noteId, 0x811c9dc5);
    const lo = fnv32(`${noteId}#guid`, 0x01000193);
    const guid = ankiBase91FromParts(hi, lo);
    // Anki's own guids are ten characters; pad short ones out of the alphabet.
    return guid.length >= 10 ? guid : guid + BASE91.slice(1, 11 - guid.length);
}

/* ------------------------------------------------------------- assembly */

interface MediaInput {
    originalName: string;
    bytes?: Uint8Array;
}

function collectMedia(bundle: DeckBundle, options: WriteApkgOptions, warnings: string[]): MediaInput[] {
    const byName = new Map<string, Uint8Array>();
    const addBytes = (name: string, bytes: unknown): void => {
        if (bytes instanceof Uint8Array) {
            byName.set(name, bytes);
        } else if (typeof bytes === 'string') {
            // Extra media may arrive base64-encoded if it was persisted as text.
            try {
                byName.set(name, Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0)));
            } catch {
                /* not base64: reported as missing below */
            }
        } else if (Array.isArray(bytes)) {
            byName.set(name, new Uint8Array(bytes as number[]));
        }
    };
    for (const source of options.media ?? []) {
        if (source.bytes) {
            byName.set(source.originalName, new Uint8Array(source.bytes));
        }
    }
    const extraMedia = bundle.extra?.media;
    if (extraMedia && typeof extraMedia === 'object' && !Array.isArray(extraMedia)) {
        for (const [name, bytes] of Object.entries(extraMedia as Record<string, unknown>)) {
            addBytes(name, bytes);
        }
    }

    const out: MediaInput[] = [];
    const seen = new Set<string>();
    for (const file of bundle.media ?? []) {
        const name = file.originalName || file.path;
        if (name === '' || seen.has(name)) {
            continue;
        }
        seen.add(name);
        // A `readApkg()` result can be handed back in as-is: its entries carry
        // the bytes even though `DeckMediaFile` does not declare them.
        const carried = (file as AnkiMediaSource).bytes;
        if (!byName.has(name) && carried) {
            byName.set(name, new Uint8Array(carried));
        }
        const bytes = byName.get(name);
        if (!bytes) {
            warnings.push(`media "${name}" has no bytes in the bundle and was left out of the package`);
        }
        out.push({ originalName: name, bytes });
    }
    for (const [name, bytes] of byName) {
        if (!seen.has(name)) {
            seen.add(name);
            out.push({ originalName: name, bytes });
        }
    }
    return out;
}

function numberArg(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        return Number(value);
    }
    return undefined;
}

function recordArg(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** An Anki-shaped id: an epoch-millisecond integer, unique in the package. */
function idNumber(value: AnkiId | undefined, fallback: number, used: Set<number>): number {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    let candidate = /^\d{1,18}$/.test(trimmed) ? Number(trimmed) : fallback;
    if (!Number.isFinite(candidate) || candidate <= 0) {
        candidate = fallback;
    }
    while (used.has(candidate)) {
        candidate += 1;
    }
    used.add(candidate);
    return candidate;
}

interface NotetypeWrite {
    id: number;
    name: string;
    fields: string[];
    ords: number[];
    raw?: Record<string, unknown>;
}

function notetypeId(name: string, used: Set<number>): number {
    return idNumber(undefined, 1700000000000 + (fnv32(name, 0x9e3779b9) % 100000000), used);
}

function templateFor(fields: readonly string[], ord: number): Record<string, unknown> {
    const front = fields[Math.min(ord, fields.length - 1)] ?? fields[0] ?? 'Front';
    const backIndex = ord === 0 ? Math.min(1, fields.length - 1) : 0;
    const back = fields[backIndex] ?? front;
    return {
        name: `Card ${ord + 1}`,
        ord,
        qfmt: `{{${front}}}`,
        afmt: `{{FrontSide}}<hr id=answer>{{${back}}}`,
        bqfmt: '',
        bafmt: '',
    };
}

/**
 * The notetypes the bundle's notes need. Raw model JSON from a previous read
 * (in `extra.models`) is reused verbatim; otherwise a notetype is synthesised
 * per model name, with one template per card ordinal the notes use.
 */
function notetypesFor(
    bundle: DeckBundle,
    extraModels: Record<string, unknown>,
    used: Set<number>,
): { list: NotetypeWrite[]; byName: Map<string, NotetypeWrite> } {
    const byName = new Map<string, NotetypeWrite>();
    for (const [id, value] of Object.entries(extraModels)) {
        const model = recordArg(value);
        if (!model) {
            continue;
        }
        const name = typeof model.name === 'string' ? model.name : `Notetype ${id}`;
        const flds = Array.isArray(model.flds) ? model.flds : [];
        const tmpls = Array.isArray(model.tmpls) ? model.tmpls : [];
        const fields = flds.map((field, index) => {
            const entry = recordArg(field);
            return typeof entry?.name === 'string' ? entry.name : `Field ${index + 1}`;
        });
        const ords = tmpls.length > 0
            ? tmpls.map((template, index) => {
                const entry = recordArg(template);
                return typeof entry?.ord === 'number' ? entry.ord : index;
            })
            : [0];
        if (!byName.has(name)) {
            byName.set(name, { id: Number(id), name, fields, ords: [...new Set(ords)].sort((a, b) => a - b), raw: model });
            used.add(Number(id));
        }
    }

    const ordsOf = (noteId: string): number[] => {
        const ords = bundle.cards.filter((card) => card.noteId === noteId).map((card) => card.ord);
        return ords.length > 0 ? [...new Set(ords)].sort((a, b) => a - b) : [0];
    };

    for (const note of bundle.notes) {
        const fields = note.fields.length > 0 ? note.fields.slice() : note.values.map((_, index) => `Field ${index + 1}`);
        if (fields.length === 0) {
            fields.push('Front');
        }
        const existing = byName.get(note.modelName);
        if (existing) {
            if (existing.fields.length === 0) {
                existing.fields = fields;
            }
            for (const ord of ordsOf(note.id)) {
                if (!existing.ords.includes(ord)) {
                    existing.ords.push(ord);
                }
            }
            existing.ords.sort((a, b) => a - b);
            continue;
        }
        byName.set(note.modelName, {
            id: notetypeId(note.modelName, used),
            name: note.modelName,
            fields,
            ords: ordsOf(note.id),
        });
    }
    return { list: [...byName.values()], byName };
}

function modelJson(notetype: NotetypeWrite, now: number, deckId: number): Record<string, unknown> {
    if (notetype.raw) {
        return notetype.raw;
    }
    return {
        id: notetype.id,
        name: notetype.name,
        type: 0,
        mod: Math.floor(now / 1000),
        usn: 0,
        sortf: 0,
        did: deckId,
        tmpls: notetype.ords.map((ord) => templateFor(notetype.fields, ord)),
        flds: notetype.fields.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
        css: '.card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n',
        latexPre: '',
        latexPost: '',
        req: notetype.ords.map((ord) => [ord, 'any', [ord]]),
    };
}

/** The `data` column: FSRS memory state and Anki's original position. */
function cardDataJson(card: AnkiCard, raw: Record<string, unknown> | undefined): string {
    if (typeof raw?.data === 'string') {
        return raw.data;
    }
    const data: Record<string, unknown> = {};
    const position = typeof raw?.pos === 'number' ? raw.pos : card.originalPosition;
    if (typeof position === 'number' && Number.isFinite(position)) {
        data.pos = position;
    }
    if (card.memory) {
        data.s = card.memory.stability;
        data.d = card.memory.difficulty;
        if (card.memory.lastReview > 0) {
            data.lrt = Math.floor(card.memory.lastReview / 1000);
        }
    }
    if (typeof raw?.cd === 'string' && raw.cd !== '') {
        data.cd = raw.cd;
    }
    return Object.keys(data).length === 0 ? '' : JSON.stringify(data);
}

function rowsFromExtra(value: unknown, columns: readonly string[]): SqlValueIn[][] {
    if (!Array.isArray(value)) {
        return [];
    }
    const rows: SqlValueIn[][] = [];
    for (const entry of value) {
        if (Array.isArray(entry)) {
            rows.push(entry.map((cell) => (cell === null || cell === undefined ? null : (cell as SqlValueIn))));
            continue;
        }
        const record = recordArg(entry);
        if (record) {
            rows.push(columns.map((column) => (record[column] === undefined ? null : (record[column] as SqlValueIn))));
        }
    }
    return rows;
}

/**
 * Builds the `.apkg` for a bundle.
 *
 * The result round-trips through `readApkg()`: decks, presets, notes, cards and
 * their scheduling state come back unchanged, and the package opens in Anki.
 */
export async function writeApkg(bundle: DeckBundle, options: WriteApkgOptions = {}): Promise<WriteApkgResult> {
    const warnings: string[] = [];
    const extra = bundle.extra ?? {};
    const now = options.now ?? numberArg(extra.now) ?? Date.now();
    const usedIds = new Set<number>();

    const crt = numberArg(extra.crt) ?? Math.floor(now / 1000);
    const mod = numberArg(extra.mod) ?? now;
    const scm = numberArg(extra.scm) ?? now;

    const deckId = idNumber(bundle.deck.id, now, usedIds);
    const notetypes = notetypesFor(bundle, recordArg(extra.models) ?? {}, usedIds);

    // Presets: the bundle's own, or one built from the deck's options.
    const presets: DeckPreset[] = bundle.presets && bundle.presets.length > 0
        ? bundle.presets
        : [{ id: '1', name: `${bundle.deck.name} options`, options: { ...bundle.deck.options } }];
    const presetNumbers = new Map<string, number>();
    const rawDconf = recordArg(extra.dconf) ?? {};
    const dconf: Record<string, unknown> = {};
    presets.forEach((preset, index) => {
        const numeric = idNumber(preset.id, index + 1, usedIds);
        presetNumbers.set(preset.id, numeric);
        const raw = recordArg(rawDconf[preset.id]);
        dconf[String(numeric)] = raw ?? deckOptionsToAnki(preset.options, numeric, preset.name);
    });
    const wantedPreset = bundle.deckPresetOf?.[bundle.deck.id];
    const deckConf = (wantedPreset !== undefined ? presetNumbers.get(wantedPreset) : undefined) ?? presetNumbers.get(presets[0].id) ?? 1;

    const rawDecks = recordArg(extra.decks) ?? {};
    const decks: Record<string, unknown> = {};
    const deckIds = new Set<string>();
    const writeDeck = (id: number, name: string, conf: number, description: string, modified: number): void => {
        const raw = recordArg(rawDecks[String(id)]) ?? recordArg(rawDecks[name]);
        decks[String(id)] = raw
            ? { ...raw, id, name, conf }
            : { id, name, mod: modified, usn: 0, collapsed: false, conf, desc: description, dyn: 0 };
        deckIds.add(String(id));
    };
    if (deckId !== 1) {
        // A Default deck keeps the file looking like an ordinary collection.
        writeDeck(1, 'Default', presetNumbers.get(presets[0].id) ?? 1, '', 0);
    }
    writeDeck(deckId, bundle.deck.name, deckConf, bundle.deck.sourceUrl ?? '', Math.floor((bundle.deck.modified || 0) / 1000));

    // Notes.
    const noteNumbers = new Map<string, number>();
    const notes: SqlValueIn[][] = [];
    for (const note of bundle.notes) {
        const numeric = idNumber(note.id, now + notes.length, usedIds);
        noteNumbers.set(note.id, numeric);
        const notetype = notetypes.byName.get(note.modelName);
        if (!notetype) {
            warnings.push(`note ${note.id} has notetype "${note.modelName}", which could not be resolved`);
            continue;
        }
        const values = note.values.length > 0 ? note.values.slice() : [''];
        const tags = note.tags.join(' ');
        const first = values[0];
        notes.push([
            numeric,
            guidForNote(note.id !== '' ? note.id : String(numeric)),
            notetype.id,
            Math.floor(now / 1000),
            0,
            tags === '' ? '' : ` ${tags} `,
            values.join('\x1f'),
            noteSortField(first),
            noteChecksum(first),
            0,
            '',
        ]);
    }
    if (notes.length !== bundle.notes.length) {
        warnings.push(`${bundle.notes.length - notes.length} note(s) were left out because their notetype could not be resolved`);
    }

    // Cards.
    const rawCards = recordArg(extra.cards) ?? {};
    const cards: SqlValueIn[][] = [];
    const missingDeckWarned = new Set<string>();
    for (const card of bundle.cards) {
        const numeric = idNumber(card.id, now + notes.length + cards.length, usedIds);
        const noteId = noteNumbers.get(card.noteId);
        if (noteId === undefined) {
            warnings.push(`card ${card.id} was left out: its note ${card.noteId} is not in the bundle`);
            continue;
        }
        let cardDeck = card.deckId;
        if (!deckIds.has(cardDeck)) {
            if (cardDeck !== '' && !missingDeckWarned.has(cardDeck)) {
                missingDeckWarned.add(cardDeck);
                warnings.push(`cards reference deck ${cardDeck}, which the bundle does not define; they were placed in "${bundle.deck.name}"`);
            }
            cardDeck = String(deckId);
        }
        const raw = recordArg(rawCards[card.id]);
        const isLearning = card.type === AnkiCardType.Learning || card.type === AnkiCardType.Relearning;
        const left = typeof raw?.left === 'number' ? raw.left : isLearning ? 1 : 0;
        const odid = typeof raw?.odid === 'number' ? raw.odid : 0;
        const originalDue = card.originalDue === undefined ? 0 : dueToStorage(card.originalDue, card.type, card.queue, crt, card.newPosition);
        cards.push([
            numeric,
            noteId,
            Number(cardDeck),
            card.ord,
            Math.floor(now / 1000),
            0,
            card.type,
            card.queue,
            dueToStorage(card.due, card.type, card.queue, crt, card.newPosition),
            card.interval,
            card.easeFactor,
            card.reviews,
            card.lapses,
            left,
            originalDue,
            odid,
            card.flag & 7,
            cardDataJson(card, raw),
        ]);
    }

    const revlog = rowsFromExtra(extra.revlog, REVLOG_COLUMNS);
    const graves = rowsFromExtra(extra.graves, GRAVES_COLUMNS);

    // The database, then the package around it.
    const models: Record<string, unknown> = {};
    for (const notetype of notetypes.list) {
        models[String(notetype.id)] = modelJson(notetype, now, deckId);
    }
    const conf = recordArg(extra.conf) ?? {};
    const tables: SqliteWriteTable[] = [
        {
            name: 'col',
            sql: SCHEMA_SQL.col,
            columns: COL_COLUMNS,
            rows: [[1, crt, mod, scm, 11, 0, 0, 0, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}']],
        },
        { name: 'notes', sql: SCHEMA_SQL.notes, columns: NOTES_COLUMNS, rows: notes },
        { name: 'cards', sql: SCHEMA_SQL.cards, columns: CARDS_COLUMNS, rows: cards },
        { name: 'revlog', sql: SCHEMA_SQL.revlog, columns: REVLOG_COLUMNS, rows: revlog },
        { name: 'graves', sql: SCHEMA_SQL.graves, columns: GRAVES_COLUMNS, rows: graves },
    ];
    const database = writeSqlite({ tables, indexes: SCHEMA_INDEXES, schemaCookie: Math.floor(now / 1000) });

    const mediaInputs = collectMedia(bundle, options, warnings);
    const mediaMap: Record<string, string> = {};
    const zipEntries: ZipWriteEntry[] = [{ name: 'collection.anki2', data: database }];
    const included = mediaInputs.filter((file) => file.bytes);
    included.forEach((file, index) => {
        mediaMap[String(index)] = file.originalName;
    });
    zipEntries.push({ name: 'media', data: new TextEncoder().encode(JSON.stringify(mediaMap)) });
    included.forEach((file, index) => {
        zipEntries.push({ name: String(index), data: file.bytes as Uint8Array, store: true });
    });

    const metaStyle = options.meta ?? 'protobuf';
    if (metaStyle === 'protobuf') {
        // PackageMetadata { version: VERSION_LEGACY_1 } = 0x08 0x01. A collection
        // without a version is rejected as "too new", so this byte matters.
        zipEntries.push({ name: 'meta', data: new Uint8Array([0x08, 0x01]) });
    } else if (metaStyle === 'json') {
        zipEntries.push({
            name: 'meta',
            data: new TextEncoder().encode(JSON.stringify({ ver: { major: 2, minor: 1 }, mod: now })),
        });
        warnings.push('the package carries the JSON meta older writers used; current Anki protobuf-decodes this entry and rejects what it cannot decode, so only use this to reproduce an old package');
    }

    return {
        bytes: await writeZip(zipEntries),
        media: included.length,
        notes: notes.length,
        cards: cards.length,
        warnings,
    };
}
