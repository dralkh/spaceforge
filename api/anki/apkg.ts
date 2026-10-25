/**
 * Reading Anki packages.
 *
 * A `.apkg` is a ZIP holding a SQLite collection (`collection.anki2`,
 * `collection.anki21`, or the zstd-compressed `collection.anki21b` Anki has
 * written since 2.1.50), a `media` map, the media files themselves under
 * numeric names, and a `meta` marker. `.colpkg` files are the same container
 * with a whole collection inside, and Anki will also hand you a bare
 * `.anki2`/`.anki21b` database. All three are accepted here.
 *
 * Everything in this file is read-only and filesystem-free: the bytes come in
 * from the vault, the media bytes go back out with the package. `fzstd` is the
 * only dependency, and only to inflate the newer collection format.
 */

import { decompress as zstdDecompress } from 'fzstd';

import {
    AnkiCard,
    AnkiCardQueue,
    AnkiCardType,
    AnkiDeck,
    AnkiNote,
    DeckMediaFile,
    DeckOptions,
    DeckPreset,
    DeckScheduler,
    LeechAction,
    DEFAULT_DECK_OPTIONS,
    DECKS_MEDIA_FOLDER,
    isDayBasedDue,
    isSecondBasedDue,
} from '../../models/anki';
import { isZip, readZipDirectory, readZipEntry } from './zip';
import { openSqlite, readTable, SqliteDatabase, SqliteTableData, SqlValue, tableInfo } from './sqlite-read';

/** The collection entry names Anki has used, newest first. */
const COLLECTION_NAMES = ['collection.anki21b', 'collection.anki21', 'collection.anki2'];

const MS_PER_SECOND = 1000;
/** Anki counts review due dates in days since the collection was created. */

/** A media file from a package: the metadata we model, plus its bytes. */
export interface AnkiPackageMedia extends DeckMediaFile {
    /** The name the entry travels under inside the package (Anki's numeric key). */
    packageName: string;
    /** The file's bytes, ready to be written into the vault. */
    bytes: Uint8Array;
}

/** Where the collection came from and what the package said about itself. */
export interface AnkiPackageMeta {
    /** 'zip' for an .apkg/.colpkg, 'bare' for a raw database file. */
    container: 'zip' | 'bare';
    /** The entry the collection was read from ('collection.anki2', …). */
    collectionName: string;
    /** True when the database arrived zstd-compressed. */
    zstd: boolean;
    /**
     * True for a container that carries a collection but no media map, which is
     * what a `.colpkg` looks like; both are read the same way.
     */
    colpkg: boolean;
    /** The package's own version marker, as the legacy JSON or protobuf meta states it. */
    version?: { major: number; minor: number };
    /** The package's modification stamp, when it carried one (ms). */
    modified?: number;
    /** `col.ver`: the Anki schema version of the collection. */
    schemaVersion: number;
    /** `col.crt`: the collection's creation stamp (seconds since the epoch). */
    created: number;
    /** `col.mod`: the collection's modification stamp (ms). */
    collectionModified: number;
    /** The raw JSON blobs from `col`, so an export can reproduce them. */
    raw: {
        models: Record<string, unknown>;
        decks: Record<string, unknown>;
        dconf: Record<string, unknown>;
        conf: Record<string, unknown>;
    };
    /** Deleted items the exporting client mentioned. */
    graves: { cards: number; notes: number; decks: number };
}

/** Everything one package yielded. */
export interface AnkiPackage {
    decks: AnkiDeck[];
    notes: AnkiNote[];
    cards: AnkiCard[];
    presets: DeckPreset[];
    /** deck id -> preset id. */
    deckPresetOf: Record<string, string>;
    media: AnkiPackageMedia[];
    /** Anything the package referenced but did not contain, and other losses. */
    warnings: string[];
    meta: AnkiPackageMeta;
}

/* ------------------------------------------------------------- small tools */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function numberOf(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return fallback;
}

function numberArray(value: unknown, fallback: number[]): number[] {
    if (!Array.isArray(value)) {
        return fallback.slice();
    }
    const out: number[] = [];
    for (const entry of value) {
        if (typeof entry === 'number' && Number.isFinite(entry)) {
            out.push(entry);
        }
    }
    return out.length > 0 ? out : fallback.slice();
}

function scalarToString(value: SqlValue | undefined): string {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    return '';
}

function scalarToNumber(value: SqlValue | undefined, fallback = 0): number {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return fallback;
}

/** The MIME types worth recording for the media a deck travels with. */
const MIME_BY_EXTENSION: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/opus',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    pdf: 'application/pdf',
};

function mimeForName(name: string): string | undefined {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? undefined : MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

/**
 * File names a field's HTML references: `[sound:clip.mp3]`, `src="…"`,
 * `data="…"` and CSS `url(…)`. Used to spot media a package forgot to carry.
 */
export function mediaNamesInHtml(html: string): string[] {
    const names = new Set<string>();
    const patterns = [/\[sound:([^\]\n]+)\]/g, /(?:src|data)\s*=\s*["']([^"']+)["']/gi, /url\(\s*["']?([^"')]+)["']?\s*\)/gi];
    for (const pattern of patterns) {
        let match = pattern.exec(html);
        while (match !== null) {
            const name = match[1].trim();
            if (name !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(name)) {
                names.add(name);
            }
            match = pattern.exec(html);
        }
    }
    return [...names];
}

/** True for names that look like a media file (rather than a template tag). */
function looksLikeMediaName(name: string): boolean {
    return /^[^<>{}]+\.(?:[a-z0-9]{2,5})$/i.test(name) && !name.includes('..');
}

/* --------------------------------------------------------- deck options */

/**
 * Anki's deck-config JSON becomes a `DeckOptions`. The scaling follows Anki's
 * own units: ease/bonus/multiplier values are fractions there and permille here,
 * intervals are days, delays are minutes.
 */
export function deckOptionsFromAnki(dconf: unknown, collectionConf?: unknown): DeckOptions {
    const config = asRecord(dconf);
    const newConfig = asRecord(config.new);
    const review = asRecord(config.rev);
    const lapse = asRecord(config.lapse);
    const defaults = DEFAULT_DECK_OPTIONS;
    const ints = numberArray(newConfig.ints, [defaults.graduatingInterval, defaults.easyInterval, 0]);
    const weights = numberArray(config.fsrsWeights ?? config.fsrsParams5, []);
    const desiredRetention = config.desiredRetention;
    const fsrsOn = Array.isArray(weights) && weights.length > 0;
    const fsrsFlagged = asRecord(collectionConf).fsrs === true;

    return {
        newPerDay: numberOf(newConfig.perDay, defaults.newPerDay),
        reviewsPerDay: numberOf(review.perDay, defaults.reviewsPerDay),
        learningSteps: numberArray(newConfig.delays, defaults.learningSteps),
        relearningSteps: numberArray(lapse.delays, defaults.relearningSteps),
        graduatingInterval: ints[0],
        easyInterval: ints.length > 1 ? ints[1] : defaults.easyInterval,
        startingEase: numberOf(newConfig.initialFactor, defaults.startingEase),
        easyBonus: Math.round(numberOf(review.ease4, defaults.easyBonus / 1000) * 1000),
        intervalMultiplier: Math.round(numberOf(review.ivlFct, defaults.intervalMultiplier / 1000) * 1000),
        lapseMultiplier: Math.round(numberOf(lapse.mult, defaults.lapseMultiplier / 1000) * 1000),
        hardMultiplier: Math.round(numberOf(review.hardFactor, defaults.hardMultiplier / 1000) * 1000),
        minimumInterval: numberOf(lapse.minInt, numberOf(review.minSpace, defaults.minimumInterval)),
        maximumInterval: numberOf(review.maxIvl, defaults.maximumInterval),
        leechThreshold: numberOf(lapse.leechFails, defaults.leechThreshold),
        leechAction: numberOf(lapse.leechAction, defaults.leechAction) === Number(LeechAction.TagOnly) ? LeechAction.TagOnly : LeechAction.Suspend,
        buryNewSiblings: newConfig.bury === undefined ? defaults.buryNewSiblings : newConfig.bury !== false,
        buryReviewSiblings: review.bury === true,
        maxAnswerSeconds: numberOf(config.maxTaken, defaults.maxAnswerSeconds),
        // Anki's deck config has no equivalent of the v3 "again" gap.
        againDelayMinutes: defaults.againDelayMinutes,
        scheduler: fsrsOn || fsrsFlagged || desiredRetention !== undefined ? DeckScheduler.Fsrs : DeckScheduler.Sm2,
        fsrs: {
            desiredRetention: numberOf(desiredRetention, defaults.fsrs.desiredRetention),
            maximumInterval: numberOf(config.fsrsMaxIvl, numberOf(review.maxIvl, defaults.fsrs.maximumInterval)),
            weights: weights.slice(),
            useOwnWeights: weights.length > 0,
        },
    };
}

/** The reverse: `DeckOptions` become the deck-config JSON Anki stores. */
export function deckOptionsToAnki(options: DeckOptions, id: number, name: string): Record<string, unknown> {
    const config: Record<string, unknown> = {
        id,
        name,
        mod: 0,
        usn: 0,
        maxTaken: options.maxAnswerSeconds,
        autoplay: true,
        timer: 0,
        replayq: true,
        new: {
            delays: options.learningSteps.slice(),
            ints: [options.graduatingInterval, options.easyInterval, 0],
            initialFactor: options.startingEase,
            bury: options.buryNewSiblings,
            order: 1,
            perDay: options.newPerDay,
        },
        rev: {
            perDay: options.reviewsPerDay,
            ease4: options.easyBonus / 1000,
            ivlFct: options.intervalMultiplier / 1000,
            maxIvl: options.maximumInterval,
            bury: options.buryReviewSiblings,
            hardFactor: options.hardMultiplier / 1000,
            minSpace: options.minimumInterval,
        },
        lapse: {
            delays: options.relearningSteps.slice(),
            mult: options.lapseMultiplier / 1000,
            minInt: options.minimumInterval,
            leechFails: options.leechThreshold,
            leechAction: options.leechAction,
        },
        dyn: false,
        newMix: 0,
        newPerDayMinimum: 0,
        interdayLearningMix: 0,
        reviewOrder: 0,
        newSortOrder: 0,
    };
    if (options.scheduler === DeckScheduler.Fsrs) {
        config.desiredRetention = options.fsrs.desiredRetention;
        config.fsrsMaxIvl = options.fsrs.maximumInterval;
        if (options.fsrs.weights.length > 0) {
            config.fsrsWeights = options.fsrs.weights.slice();
        }
    }
    return config;
}

/* ------------------------------------------------------------- protobuf */

interface ProtoField {
    field: number;
    wireType: number;
    varint: number;
    bytes: Uint8Array;
}

/**
 * A tolerant protobuf field reader. Newer Anki packages store their media map
 * and notetypes as protobuf messages; only a flat walk is needed to pull the
 * strings and numbers out of them.
 */
function readProtoFields(bytes: Uint8Array): ProtoField[] {
    const fields: ProtoField[] = [];
    let at = 0;
    const readVarint = (): number => {
        let value = 0;
        for (let i = 0; i < 8; i++) {
            const byte = bytes[at];
            if (byte === undefined) {
                throw new Error('truncated protobuf message');
            }
            at++;
            value = value * 128 + (byte & 0x7f);
            if ((byte & 0x80) === 0) {
                return value;
            }
        }
        const last = bytes[at];
        if (last === undefined) {
            throw new Error('truncated protobuf message');
        }
        at++;
        return value * 256 + last;
    };
    while (at < bytes.length) {
        const tag = readVarint();
        const field = Math.floor(tag / 8);
        const wireType = tag % 8;
        if (field === 0) {
            break;
        }
        if (wireType === 0) {
            fields.push({ field, wireType, varint: readVarint(), bytes: new Uint8Array(0) });
        } else if (wireType === 2) {
            const length = readVarint();
            if (at + length > bytes.length) {
                throw new Error('truncated protobuf message');
            }
            fields.push({ field, wireType, varint: 0, bytes: bytes.subarray(at, at + length) });
            at += length;
        } else if (wireType === 5) {
            at += 4;
        } else if (wireType === 1) {
            at += 8;
        } else {
            // Groups and the like are not used by the messages we read.
            throw new Error(`unsupported protobuf wire type ${wireType}`);
        }
    }
    return fields;
}

function protoSubmessages(fields: readonly ProtoField[], field: number): ProtoField[] {
    return fields.filter((entry) => entry.field === field && entry.wireType === 2);
}

function protoString(fields: readonly ProtoField[], field: number): string | undefined {
    const found = fields.find((entry) => entry.field === field && entry.wireType === 2);
    return found ? new TextDecoder('utf-8').decode(found.bytes) : undefined;
}

function protoNumber(fields: readonly ProtoField[], field: number): number | undefined {
    const found = fields.find((entry) => entry.field === field && entry.wireType === 0);
    return found ? found.varint : undefined;
}

/* ------------------------------------------------------------ the package */

interface ParsedCollection {
    collection: Uint8Array;
    name: string;
    zstd: boolean;
}

async function extractCollection(bytes: Uint8Array): Promise<{
    parsed: ParsedCollection;
    meta: { version?: { major: number; minor: number }; modified?: number; colpkg: boolean };
    readEntry: (name: string) => Promise<Uint8Array | undefined>;
    hasMediaMap: boolean;
}> {
    if (!isZip(bytes)) {
        // A bare database, or a bare zstd-compressed one.
        if (bytes.length > 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
            return {
                parsed: { collection: zstdDecompress(bytes), name: 'collection.anki21b', zstd: true },
                meta: { colpkg: false },
                readEntry: () => Promise.resolve(undefined),
                hasMediaMap: false,
            };
        }
        return {
            parsed: { collection: bytes, name: 'collection.anki2', zstd: false },
            meta: { colpkg: false },
            readEntry: () => Promise.resolve(undefined),
            hasMediaMap: false,
        };
    }

    const directory = readZipDirectory(bytes);
    const byName = new Map(directory.entries.map((entry) => [entry.name, entry]));
    const name = COLLECTION_NAMES.find((candidate) => byName.has(candidate));
    if (!name) {
        throw new Error('not an Anki package: no collection database inside the archive');
    }
    const entry = byName.get(name);
    if (!entry) {
        throw new Error(`not an Anki package: ${name} is missing`);
    }
    let collection = await readZipEntry(bytes, entry);
    let zstd = name === 'collection.anki21b';
    if (!zstd && collection.length > 4 && collection[0] === 0x28 && collection[1] === 0xb5 && collection[2] === 0x2f && collection[3] === 0xfd) {
        zstd = true;
    }
    if (zstd) {
        try {
            collection = zstdDecompress(collection);
        } catch (error) {
            throw new Error(`the collection inside the package could not be decompressed: ${(error as Error).message}`);
        }
    }

    // A collection package (.colpkg) is the same container; what distinguishes
    // it is the absence of a media map, which is all we need to record.
    const metaEntry = byName.get('meta');
    let meta: { version?: { major: number; minor: number }; modified?: number; colpkg: boolean } = {
        colpkg: !byName.has('media'),
    };
    if (metaEntry) {
        const rawMeta = await readZipEntry(bytes, metaEntry);
        meta = { ...parsePackageMeta(rawMeta), colpkg: !byName.has('media') };
    }

    return {
        parsed: { collection, name, zstd },
        meta,
        readEntry: async (wanted: string) => {
            const found = byName.get(wanted);
            if (!found) {
                return undefined;
            }
            return readZipEntry(bytes, found);
        },
        hasMediaMap: byName.has('media'),
    };
}

function parsePackageMeta(bytes: Uint8Array): { version?: { major: number; minor: number }; modified?: number } {
    const text = new TextDecoder('utf-8').decode(bytes).trim();
    if (text.startsWith('{')) {
        try {
            const parsed = asRecord(JSON.parse(text));
            const ver = asRecord(parsed.ver);
            const version = {
                major: numberOf(ver.major, numberOf(parsed.version, 2)),
                minor: numberOf(ver.minor, 1),
            };
            const modified = parsed.mod === undefined ? undefined : numberOf(parsed.mod, 0);
            return { version, modified };
        } catch {
            return {};
        }
    }
    try {
        const fields = readProtoFields(bytes);
        const version = protoNumber(fields, 1);
        if (version === undefined) {
            return {};
        }
        // 1 = legacy (collection.anki2), 2 = legacy with collection.anki21,
        // 3 = the current format.
        return { version: version >= 3 ? { major: 3, minor: 0 } : { major: 2, minor: version } };
    } catch {
        return {};
    }
}

/** The media map, as either the legacy JSON object or the newer protobuf one. */
function parseMediaMap(bytes: Uint8Array): Map<string, string> {
    const out = new Map<string, string>();
    const text = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 64))).trim();
    if (text.startsWith('{')) {
        const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string') {
                out.set(key, value);
            }
        }
        return out;
    }
    const entries = protoSubmessages(readProtoFields(bytes), 1);
    entries.forEach((entry, index) => {
        const inner = readProtoFields(entry.bytes);
        const name = protoString(inner, 1);
        if (name === undefined) {
            return;
        }
        const legacyIndex = protoNumber(inner, 255);
        out.set(String(legacyIndex ?? index), name);
    });
    return out;
}

/** Notetype definitions: which fields (in order) each note type has. */
interface NotetypeInfo {
    id: string;
    name: string;
    fields: string[];
}

function notetypesFromModels(models: Record<string, unknown>, warnings: string[]): Map<string, NotetypeInfo> {
    const out = new Map<string, NotetypeInfo>();
    for (const [id, value] of Object.entries(models)) {
        const model = asRecord(value);
        const fields = Array.isArray(model.flds) ? model.flds : [];
        const named = fields
            .map((field, index) => {
                const entry = asRecord(field);
                return { name: typeof entry.name === 'string' ? entry.name : `Field ${index + 1}`, ord: numberOf(entry.ord, index) };
            })
            .sort((a, b) => a.ord - b.ord);
        out.set(id, {
            id,
            name: typeof model.name === 'string' ? model.name : `Notetype ${id}`,
            fields: named.map((field) => field.name),
        });
        if (fields.length === 0) {
            const name = typeof model.name === 'string' ? model.name : String(id);
            warnings.push(`notetype "${name}" declares no fields`);
        }
    }
    return out;
}

/**
 * Newer collections (schema 15 and up) keep notetypes in their own table:
 * `notetypes(id, name, …)` plus `fields(ntid, ord, name, …)` — both real
 * columns, so the names come out exactly. Everything else about a notetype
 * (templates, CSS) still lives in protobuf blobs, which this layer does not
 * model.
 */
function notetypesFromTables(db: SqliteDatabase, warnings: string[]): Map<string, NotetypeInfo> | null {
    const notetypeTable = tableInfo(db, 'notetypes');
    if (!notetypeTable) {
        return null;
    }
    const fieldNames = new Map<string, { ord: number; name: string }[]>();
    if (tableInfo(db, 'fields')) {
        for (const row of readTable(db, 'fields').rows) {
            const id = scalarToString(row.ntid);
            const list = fieldNames.get(id) ?? [];
            list.push({ ord: scalarToNumber(row.ord, list.length), name: scalarToString(row.name) });
            fieldNames.set(id, list);
        }
    }

    const out = new Map<string, NotetypeInfo>();
    for (const row of readTable(db, 'notetypes').rows) {
        const id = scalarToString(row.id);
        const name = scalarToString(row.name) || `Notetype ${id}`;
        const named = (fieldNames.get(id) ?? []).slice().sort((a, b) => a.ord - b.ord);
        out.set(id, { id, name, fields: named.map((field) => field.name).filter((field) => field !== '') });
    }
    if (out.size > 0 && [...out.values()].every((notetype) => notetype.fields.length === 0)) {
        warnings.push('notetype field names could not be read from the collection; the fields are numbered instead');
    }
    return out;
}

/**
 * A package's stored `due` becomes the deck document's value.
 *
 * A day-based card is already a day number relative to the *package's* `crt`,
 * which is what the document stores too; re-basing it on the deck's own `crt` is
 * the importer's job, because only it knows both. A learning card's value is
 * absolute seconds, so it becomes milliseconds here and back again on export.
 */
export function dueFromStorage(raw: number, type: number, queue: number): number {
    if (isDayBasedDue(type, queue)) {
        return raw;
    }
    if (isSecondBasedDue(type, queue)) {
        return raw * MS_PER_SECOND;
    }
    // New cards hold a queue position, not a date.
    return 0;
}

/** The document's value becomes what Anki stores in the package. */
export function dueToStorage(due: number, type: number, queue: number, newPosition: number | null | undefined): number {
    if (isDayBasedDue(type, queue)) {
        return Math.round(due);
    }
    if (isSecondBasedDue(type, queue)) {
        return Math.floor(due / MS_PER_SECOND);
    }
    return Math.max(0, Math.floor(newPosition ?? 0));
}

/* --------------------------------------------------------------- reading */

/**
 * Reads a `.apkg`, `.colpkg` or bare collection.
 *
 * Anything the package referenced but could not supply is reported in
 * `warnings` rather than throwing: a deck with a missing image is still worth
 * importing.
 */
export async function readApkg(bytes: Uint8Array): Promise<AnkiPackage> {
    const warnings: string[] = [];
    const extracted = await extractCollection(bytes);
    const db = openSqlite(extracted.parsed.collection);
    if (!tableInfo(db, 'col')) {
        throw new Error('not an Anki collection: the col table is missing');
    }

    const col = readTable(db, 'col');
    const colRow = col.rows[0] ?? {};
    const created = scalarToNumber(colRow.crt, 0);
    const models = parseJsonColumn<Record<string, unknown>>(colRow.models, {}, warnings, 'models');
    const decksJson = parseJsonColumn<Record<string, unknown>>(colRow.decks, {}, warnings, 'decks');
    const dconfJson = parseJsonColumn<Record<string, unknown>>(colRow.dconf, {}, warnings, 'dconf');
    const conf = parseJsonColumn<Record<string, unknown>>(colRow.conf, {}, warnings, 'conf');

    // Deck presets first: decks point at them.
    const presets: DeckPreset[] = [];
    const presetById = new Map<string, DeckPreset>();
    for (const [id, value] of Object.entries(dconfJson)) {
        const preset: DeckPreset = {
            id,
            name: typeof asRecord(value).name === 'string' ? String(asRecord(value).name) : `Preset ${id}`,
            options: deckOptionsFromAnki(value, conf),
        };
        presets.push(preset);
        presetById.set(id, preset);
    }
    if (presets.length === 0 && Object.keys(decksJson).length > 0) {
        presets.push({ id: 'default', name: 'Default', options: deckOptionsFromAnki({}, conf) });
    }

    const decks: AnkiDeck[] = [];
    const deckPresetOf: Record<string, string> = {};
    for (const [id, value] of Object.entries(decksJson)) {
        const deck = asRecord(value);
        const confId = deck.conf === undefined ? 'default' : String(numberOf(deck.conf, 1));
        deckPresetOf[id] = confId;
        const preset = presetById.get(confId) ?? presets[0];
        const description = typeof deck.desc === 'string' ? deck.desc : '';
        decks.push({
            id,
            name: typeof deck.name === 'string' ? deck.name : `Deck ${id}`,
            modified: numberOf(deck.mod, 0) * MS_PER_SECOND,
            options: preset ? { ...preset.options, fsrs: { ...preset.options.fsrs } } : deckOptionsFromAnki({}, conf),
            parentId: null,
            sourceUrl: /^https?:\/\//i.test(description) ? description : undefined,
        });
    }

    let notetypes = notetypesFromModels(models, warnings);
    if (notetypes.size === 0) {
        const fromTables = notetypesFromTables(db, warnings);
        if (fromTables) {
            notetypes = fromTables;
            warnings.push('the collection uses a newer Anki schema; notetypes came from the notetypes/fields tables and deck options may be approximated');
        }
    }
    if (decks.length === 0 && tableInfo(db, 'decks')) {
        for (const row of readTable(db, 'decks').rows) {
            const id = scalarToString(row.id);
            decks.push({
                id,
                name: scalarToString(row.name) || `Deck ${id}`,
                modified: scalarToNumber(row.mtime_secs, 0) * MS_PER_SECOND,
                options: deckOptionsFromAnki({}, conf),
                parentId: null,
            });
            deckPresetOf[id] = 'default';
        }
        warnings.push('the collection uses a newer Anki schema; deck options were taken from Anki\'s defaults');
    }

    const noteRows = readOptionalTable(db, 'notes', warnings);
    const cardRows = readOptionalTable(db, 'cards', warnings);
    const revlogRows = readOptionalTable(db, 'revlog', warnings);
    const graveRows = readOptionalTable(db, 'graves', warnings);

    // Per-card review time and the last review's interval, from the revlog.
    const timeByCard = new Map<string, number>();
    const lastLogByCard = new Map<string, { id: number; interval: number; lastInterval: number }>();
    for (const row of revlogRows.rows) {
        const cardId = scalarToString(row.cid);
        if (cardId === '') {
            continue;
        }
        timeByCard.set(cardId, (timeByCard.get(cardId) ?? 0) + scalarToNumber(row.time, 0));
        const logId = scalarToNumber(row.id, 0);
        const previous = lastLogByCard.get(cardId);
        if (!previous || logId >= previous.id) {
            lastLogByCard.set(cardId, { id: logId, interval: scalarToNumber(row.ivl, 0), lastInterval: scalarToNumber(row.lastIvl, 0) });
        }
    }

    const cards: AnkiCard[] = [];
    const cardIdsByNote = new Map<string, string[]>();
    for (const row of cardRows.rows) {
        const id = scalarToString(row.id);
        const noteId = scalarToString(row.nid);
        const type = scalarToNumber(row.type, AnkiCardType.New);
        const queue = scalarToNumber(row.queue, AnkiCardQueue.New);
        const rawDue = scalarToNumber(row.due, 0);
        const memory = readCardMemory(row.data);
        const lastLog = lastLogByCard.get(id);
        const card: AnkiCard = {
            id,
            noteId,
            deckId: scalarToString(row.did),
            ord: scalarToNumber(row.ord, 0),
            type,
            queue,
            interval: scalarToNumber(row.ivl, 0),
            easeFactor: scalarToNumber(row.factor, 0),
            reviews: scalarToNumber(row.reps, 0),
            lapses: scalarToNumber(row.lapses, 0),
            due: dueFromStorage(rawDue, type, queue),
            newPosition: isDayBasedDue(type, queue) || isSecondBasedDue(type, queue) ? null : rawDue,
            flag: scalarToNumber(row.flags, 0) & 7,
            originalDue: scalarToNumber(row.odue, 0) === 0 ? undefined : dueFromStorage(scalarToNumber(row.odue, 0), type, queue),
            originalPosition: memory.position,
            timeTakenMs: timeByCard.get(id),
        };
        if (memory.stability !== undefined && memory.difficulty !== undefined) {
            card.memory = {
                stability: memory.stability,
                difficulty: memory.difficulty,
                lastReview: memory.lastReview ?? (lastLog ? lastLog.id : 0),
                scheduledDays: lastLog ? lastLog.interval : card.interval,
            };
            card.desiredRetentionDays = card.interval;
        }
        // Anki's `cards.mod` is in seconds; the model keeps every stamp in ms.
        // A card that has never been touched leaves it unset rather than 0, so
        // the merge can tell "no stamp" from "stamped at the epoch".
        const modified = scalarToNumber(row.mod, 0);
        if (modified > 0) card.mod = modified * MS_PER_SECOND;
        cards.push(card);
        const list = cardIdsByNote.get(noteId);
        if (list) {
            list.push(id);
        } else {
            cardIdsByNote.set(noteId, [id]);
        }
    }

    const notes: AnkiNote[] = [];
    const referencedMedia = new Set<string>();
    for (const row of noteRows.rows) {
        const id = scalarToString(row.id);
        const mid = scalarToString(row.mid);
        const notetype = notetypes.get(mid);
        if (!notetype) {
            warnings.push(`note ${id} uses notetype ${mid}, which the package does not define`);
        }
        const values = scalarToString(row.flds).split('\x1f');
        const names = notetype?.fields ?? [];
        const fields: string[] = [];
        for (let index = 0; index < values.length; index++) {
            fields.push(names[index] ?? `Field ${index + 1}`);
        }
        if (names.length > 0 && names.length !== values.length) {
            warnings.push(`note ${id} has ${values.length} fields but its notetype defines ${names.length}`);
        }
        const mediaFiles: string[] = [];
        for (const value of values) {
            for (const name of mediaNamesInHtml(value)) {
                if (!mediaFiles.includes(name)) {
                    mediaFiles.push(name);
                }
                if (looksLikeMediaName(name)) {
                    referencedMedia.add(name);
                }
            }
        }
        const tags = scalarToString(row.tags).trim();
        const note: AnkiNote = {
            id,
            modelName: notetype?.name ?? `Notetype ${mid}`,
            fields,
            values,
            tags: tags === '' ? [] : tags.split(/\s+/),
            cardIds: cardIdsByNote.get(id) ?? [],
            mediaFiles,
        };
        const modified = scalarToNumber(row.mod, 0);
        if (modified > 0) note.modified = modified * MS_PER_SECOND;
        notes.push(note);
    }

    const media = await readMedia(extracted, referencedMedia, warnings);

    const graves = { cards: 0, notes: 0, decks: 0 };
    for (const row of graveRows.rows) {
        // 0 = card, 1 = note, 2 = deck in Anki's graves table.
        const kind = scalarToNumber(row.type, -1);
        if (kind === 0) {
            graves.cards += 1;
        } else if (kind === 1) {
            graves.notes += 1;
        } else if (kind === 2) {
            graves.decks += 1;
        }
    }
    if (graves.cards > 0 || graves.notes > 0 || graves.decks > 0) {
        const parts: string[] = [];
        if (graves.cards > 0) {
            parts.push(`${graves.cards} deleted card${graves.cards === 1 ? '' : 's'}`);
        }
        if (graves.notes > 0) {
            parts.push(`${graves.notes} deleted note${graves.notes === 1 ? '' : 's'}`);
        }
        if (graves.decks > 0) {
            parts.push(`${graves.decks} deleted deck${graves.decks === 1 ? '' : 's'}`);
        }
        warnings.push(`the package reports deletions that are not part of it: ${parts.join(', ')}`);
    }

    return {
        decks,
        notes,
        cards,
        presets,
        deckPresetOf,
        media,
        warnings,
        meta: {
            container: isZip(bytes) ? 'zip' : 'bare',
            collectionName: extracted.parsed.name,
            zstd: extracted.parsed.zstd,
            colpkg: extracted.meta.colpkg,
            version: extracted.meta.version,
            modified: extracted.meta.modified,
            schemaVersion: scalarToNumber(colRow.ver, 0),
            created,
            collectionModified: scalarToNumber(colRow.mod, 0),
            raw: { models, decks: decksJson, dconf: dconfJson, conf },
            graves,
        },
    };
}

function parseJsonColumn<T>(value: SqlValue | undefined, fallback: T, warnings: string[], what: string): T {
    if (typeof value !== 'string' || value.trim() === '') {
        if (value !== undefined && !(typeof value === 'string' && value.trim() === '')) {
            warnings.push(`the collection's ${what} column is not text`);
        }
        return fallback;
    }
    try {
        return JSON.parse(value) as T;
    } catch {
        warnings.push(`the collection's ${what} column is not valid JSON and was ignored`);
        return fallback;
    }
}

function readOptionalTable(db: SqliteDatabase, name: string, warnings: string[]): SqliteTableData {
    try {
        return readTable(db, name);
    } catch {
        warnings.push(`the collection has no ${name} table`);
        return { name, columns: [], rows: [] };
    }
}

/** The FSRS numbers Anki keeps in a card's `data` column. */
function readCardMemory(data: SqlValue | undefined): {
    stability?: number;
    difficulty?: number;
    lastReview?: number;
    position?: number;
} {
    if (typeof data !== 'string' || data.trim() === '' || !data.trim().startsWith('{')) {
        return {};
    }
    try {
        const parsed = asRecord(JSON.parse(data));
        const out: { stability?: number; difficulty?: number; lastReview?: number; position?: number } = {};
        if (typeof parsed.s === 'number') {
            out.stability = parsed.s;
        }
        if (typeof parsed.d === 'number') {
            out.difficulty = parsed.d;
        }
        if (typeof parsed.lrt === 'number') {
            out.lastReview = parsed.lrt * MS_PER_SECOND;
        }
        if (typeof parsed.pos === 'number') {
            out.position = parsed.pos;
        }
        return out;
    } catch {
        return {};
    }
}

async function readMedia(
    extracted: { readEntry: (name: string) => Promise<Uint8Array | undefined>; hasMediaMap: boolean },
    referenced: ReadonlySet<string>,
    warnings: string[],
): Promise<AnkiPackageMedia[]> {
    const media: AnkiPackageMedia[] = [];
    const names = new Set<string>();
    if (extracted.hasMediaMap) {
        const raw = await extracted.readEntry('media');
        if (raw) {
            let map: Map<string, string> | null = null;
            try {
                map = parseMediaMap(stripZstd(raw));
            } catch (error) {
                warnings.push(`the package's media map could not be read: ${(error as Error).message}`);
            }
            if (map) {
                for (const [packageName, originalName] of map) {
                    const bytes = await extracted.readEntry(packageName);
                    if (!bytes) {
                        warnings.push(`the package lists media "${originalName}" but entry ${packageName} is missing from the zip`);
                        continue;
                    }
                    names.add(originalName);
                    media.push({
                        packageName,
                        originalName,
                        path: `${DECKS_MEDIA_FOLDER}/${originalName}`,
                        mime: mimeForName(originalName),
                        size: bytes.length,
                        bytes,
                    });
                }
            }
        }
    }
    for (const name of referenced) {
        if (!names.has(name) && !media.some((entry) => entry.originalName === name)) {
            warnings.push(`the notes reference media "${name}", which the package does not carry`);
        }
    }
    return media;
}

/** The newer packages zstd-compress the media map as well as the collection. */
function stripZstd(bytes: Uint8Array): Uint8Array {
    if (bytes.length > 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
        return zstdDecompress(bytes);
    }
    return bytes;
}
