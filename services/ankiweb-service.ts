/**
 * The AnkiWeb side of the Anki interoperability: finding shared decks, reading
 * one deck's details, and fetching its package.
 *
 * AnkiWeb has no public API. Everything here is read from the same endpoints
 * the website itself uses, and every network call takes an injectable
 * transport so the tests never touch the network:
 *
 *  - Search:    GET https://ankiweb.net/shared/decks?search=<query>
 *  - Details:   GET https://ankiweb.net/svc/shared/item-info?sharedId=<id>
 *               (protobuf bytes, decoded here by hand — see `parseItemInfo`)
 *  - Download:  GET https://ankiweb.net/svc/shared/download-deck/<id>?t=<key>
 *               (an .apkg ZIP, and only when AnkiWeb will let this visitor
 *               have it)
 *
 * Two things about the live site matter for this file:
 *
 *  1. The search page is a client-rendered SvelteKit app. Obsidian's
 *     `requestUrl` cannot run its JavaScript, so what actually arrives is the
 *     app shell — no results in the HTML. Any listing markup that *is* in the
 *     HTML is read tolerantly by `scanSearchResults`, and when the page
 *     carries no readable results the search comes back with an honest
 *     warning rather than a failure. (The shell is pinned by the
 *     `search-biolog.html` fixture.)
 *  2. AnkiWeb rate-limits anonymous visitors: searching and downloading both
 *     answer 429 "Please log in to perform more searches." / "... download
 *     more decks." for a visitor with no session. That is a first-class
 *     outcome here (`needs-sign-in`), never an exception: this plugin never
 *     asks for, stores or logs AnkiWeb credentials, so a signed-out reader
 *     is the normal case and the UI is expected to offer the browser instead.
 *
 * No `fetch`, no node builtins: this has to work in the Obsidian mobile
 * webviews too.
 */
import { requestUrl } from 'obsidian';

export const ANKIWEB_ORIGIN = 'https://ankiweb.net';
/** The search page, as the website itself calls it. */
export const ANKIWEB_SEARCH_URL = `${ANKIWEB_ORIGIN}/shared/decks`;
/** The protobuf endpoint behind a deck's detail page. */
export const ANKIWEB_ITEM_INFO_URL = `${ANKIWEB_ORIGIN}/svc/shared/item-info`;

/** The page a reader can open in their browser for one shared deck. */
export function ankiWebDeckPageUrl(id: string): string {
    return `${ANKIWEB_ORIGIN}/shared/info/${encodeURIComponent(id)}`;
}

/** The package endpoint; the key is what `item-info` handed out, if anything. */
export function ankiWebDownloadUrl(id: string, downloadKey: string): string {
    return `${ANKIWEB_ORIGIN}/svc/shared/download-deck/${encodeURIComponent(id)}?t=${encodeURIComponent(downloadKey)}`;
}

/* --------------------------------------------------------------- transport */

/** One GET, as the service needs it: a status and, when there is one, a body. */
export interface AnkiWebRequest {
    url: string;
}

export interface AnkiWebResponse {
    status: number;
    /** The body bytes, or null when the transport could not produce any. */
    body: Uint8Array | null;
}

/**
 * The seam the tests use. The default goes through Obsidian's `requestUrl`,
 * which is the only HTTP path that is safe on mobile, carries Obsidian's own
 * cookies/proxy story, and is what every other service in this plugin uses.
 */
export type AnkiWebTransport = (request: AnkiWebRequest) => Promise<AnkiWebResponse>;

export const obsidianAnkiWebTransport: AnkiWebTransport = async (request) => {
    const response = await requestUrl({ url: request.url, method: 'GET', throw: false });
    const shaped = response as { arrayBuffer?: ArrayBuffer; text?: string };
    if (shaped.arrayBuffer) return { status: response.status, body: new Uint8Array(shaped.arrayBuffer) };
    // The transport shim used by the tests answers with text instead of bytes.
    if (typeof shaped.text === 'string') return { status: response.status, body: new TextEncoder().encode(shaped.text) };
    return { status: response.status, body: null };
};

function decodeText(body: Uint8Array | null): string {
    if (!body) return '';
    return new TextDecoder('utf-8').decode(body);
}

/**
 * What AnkiWeb says when it wants a signed-in visitor. Anchored on a sentence
 * about signing in rather than the words "log in" alone, because every page's
 * navigation contains a "Log In" link.
 */
const SIGN_IN_HINT = /(?:please\s+)?(?:log|sign)\s*in\s+to\s+(?:view|search|perform|see|continue|download|browse)|please\s+(?:log|sign)\s*in\b|you\s+must\s+(?:log|sign)\s*in\b/i;

/** The SvelteKit shell, i.e. a page whose content this transport cannot see. */
const CLIENT_RENDERED_HINT = /JavaScript is required|_app\/immutable\//i;

/* ------------------------------------------------------------------ search */

/**
 * One deck as a search listing shows it. Only what the markup actually said:
 * a field is absent when the page did not label it, because inventing a rating
 * from some unlabelled number would be worse than showing none.
 */
export interface AnkiWebDeckResult {
    /** AnkiWeb's numeric shared id. */
    id: string;
    /** The deck title, as the link text reads. */
    name: string;
    /** The page to open in a browser: /shared/info/<id>. */
    url: string;
    /** Total ratings, when the listing labels them (or shows the vote bar). */
    ratings?: number;
    /** Downloads, when the listing labels them. */
    downloads?: number;
    /** The sharer, when the listing credits one with "by <name>". */
    author?: string;
}

/**
 * What a search came back with.
 *
 *  - `ok`            results were read (possibly with warnings about odd markup)
 *  - `empty`         the page was readable and listed nothing
 *  - `needs-sign-in` AnkiWeb refused: it wants a session before it will answer
 *  - `unreadable`    the page arrived but carried no listing this client can read
 */
export type AnkiWebSearchStatus = 'ok' | 'empty' | 'needs-sign-in' | 'unreadable';

export interface AnkiWebSearchOutcome {
    query: string;
    status: AnkiWebSearchStatus;
    results: AnkiWebDeckResult[];
    /** The honest explanation when something was refused or unreadable. */
    warning: string | null;
}

export interface AnkiWebSearchScan {
    results: AnkiWebDeckResult[];
    /** How many /shared/info/<id> links the page contained, readable or not. */
    linksSeen: number;
    warnings: string[];
}

function tryInfoId(href: string): string | null {
    const match = /^(?:https?:\/\/ankiweb\.net)?\/shared\/info\/(\d+)(?:[?#][^"']*)?$/i.exec(href.trim());
    return match ? match[1] : null;
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    '#39': "'",
};

/** Tags stripped, entities decoded, whitespace collapsed — listing text. */
function readText(html: string): string {
    const withoutTags = html.replace(/<[^>]*>/g, ' ');
    const decoded = withoutTags.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
        const key = name.toLowerCase();
        const named = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[key];
        if (named !== undefined) return named;
        if (key.startsWith('#x')) {
            const code = Number.parseInt(key.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        if (key.startsWith('#')) {
            const code = Number.parseInt(key.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return whole;
    });
    return decoded.replace(/\s+/g, ' ').trim();
}

function readCount(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const digits = value.replace(/[^\d]/g, '');
    if (digits.length === 0) return undefined;
    const parsed = Number.parseInt(digits, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

interface ListingMeta {
    ratings?: number;
    downloads?: number;
    author?: string;
}

/**
 * The metadata that follows a result link, read only from labelled text:
 * "45,120 downloads", "318 ratings", a "by <name>" credit. The one structural
 * exception is the vote bar the site renders next to a deck (its total vote
 * count is the number that follows the bar's markup) — that shape is taken
 * from AnkiWeb's own rendering code, not guessed.
 */
function readListingMeta(windowHtml: string): ListingMeta {
    const text = readText(windowHtml);
    const meta: ListingMeta = {};

    const labelledRatings = /(\d[\d,]*)\s*(?:ratings?|votes?|thumbs\s*up)/i.exec(text);
    if (labelledRatings) {
        meta.ratings = readCount(labelledRatings[1]);
    } else {
        const barAt = windowHtml.search(/class="likebar\b/);
        if (barAt >= 0) {
            const afterBar = readText(windowHtml.slice(barAt));
            const barCount = /(\d[\d,]*)/.exec(afterBar);
            meta.ratings = barCount ? readCount(barCount[1]) : undefined;
        }
    }

    const downloads = /(\d[\d,]*)\s*downloads?\b/i.exec(text);
    if (downloads) meta.downloads = readCount(downloads[1]);

    const author = /\b(?:by|author)\s*:?\s+([^|·•<>\n]{2,60})/i.exec(text);
    if (author) {
        const name = (author[1] ?? '').replace(/[\s,;:.·•-]+$/, '').replace(/\s+/g, ' ').trim();
        if (name.length > 0 && /\p{L}/u.test(name)) meta.author = name;
    }

    return meta;
}

/**
 * Read a search page's listing, tolerantly.
 *
 * The page is a server-rendered template this client does not control, so the
 * scan is deliberately loose: every `<a>` whose href points at
 * `/shared/info/<digits>` becomes a result, its link text becomes the name,
 * and the markup up to the next result supplies the metadata. Anything the
 * scan could not account for (a link with no readable name, a page that stops
 * mid-row because it was truncated) is reported in `warnings` — this function
 * never throws, and never invents a result that the page does not contain.
 */
export function scanSearchResults(html: string): AnkiWebSearchScan {
    const results: AnkiWebDeckResult[] = [];
    const warnings: string[] = [];
    const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi;

    const found: { id: string; name: string; start: number; end: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = anchor.exec(html)) !== null) {
        const href = match[1] ?? match[2] ?? '';
        const id = tryInfoId(href);
        if (id === null) continue;
        found.push({
            id,
            name: readText(match[3] ?? ''),
            start: match.index,
            end: anchor.lastIndex,
        });
    }

    const seen = new Set<string>();
    for (let index = 0; index < found.length; index++) {
        const entry = found[index];
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const windowEnd = index + 1 < found.length
            ? found[index + 1].start
            : Math.min(entry.end + 2000, html.length);
        const meta = readListingMeta(html.slice(entry.end, windowEnd));
        results.push({
            id: entry.id,
            name: entry.name.length > 0 ? entry.name : `Deck ${entry.id}`,
            url: ankiWebDeckPageUrl(entry.id),
            ...meta,
        });
    }

    const linksSeen = (html.match(/\/shared\/info\/\d+/g) ?? []).length;
    const unread = linksSeen - results.length;
    if (linksSeen > 0 && results.length === 0) {
        warnings.push('AnkiWeb\'s page holds deck links this client could not read; its markup may have changed.');
    } else if (unread > 0) {
        warnings.push(`Only ${results.length} of ${linksSeen} deck links on the page could be read; the rest may be cut off or in a changed format.`);
    }

    return { results, linksSeen, warnings };
}

/* -------------------------------------------------------- item-info protobuf */

/**
 * A deck's details, as far as this client is sure of them.
 *
 * The field numbers come from the site's own client bundle (`item-info` is
 * answered with the `SharedItemInfo` message the website decodes with
 * protobuf-es) and were checked against real captured responses:
 *
 *  - 1  reviews (repeated; skipped here)
 *  - 5  title                                (string)   — certain
 *  - 6  tags, space-padded                   (string)   — certain
 *  - 7  size in bytes                        (varint)   — certain
 *  - 8  last updated, unix seconds           (varint)   — certain: the page
 *       renders the same number as "Updated <date>"
 *  - 9  description, as HTML                 (string)   — certain
 *  - 10 deck info (oneof)                    (message)
 *  - 11 add-on info (oneof)                  (message)  — set for shared
 *       add-ons instead of decks
 *  - 18 thumbs up                            (varint)   — certain: the page
 *       shows exactly this count
 *  - 19 thumbs down                          (varint)   — certain
 *  - 12 support URL, 13 items shared by the uploader, and fields 2/3 at the
 *       response level carry names this client has no use for; they are
 *       skipped deliberately.
 *
 * Inside the deck message: 1 notes, 2 audio, 3 images, 5 the opaque download
 * key. Fields are read by number and wire type only — this is not a general
 * protobuf decoder, and unknown fields are skipped rather than interpreted.
 */
export interface DecksItemDeckInfo {
    notes: number | null;
    audio: number | null;
    images: number | null;
    /**
     * An opaque signed token, present on responses we captured as a signed-out
     * visitor. What it means to AnkiWeb is not documented anywhere; treat it
     * as "fetch the package with this, if AnkiWeb will let you".
     */
    downloadKey: string | null;
}

export interface DecksItemInfo {
    title: string | null;
    description: string | null;
    tags: string | null;
    sizeBytes: number | null;
    lastUpdatedSeconds: number | null;
    thumbsUp: number | null;
    thumbsDown: number | null;
    deck: DecksItemDeckInfo | null;
    /** The item is a shared add-on, not a deck. */
    addon: boolean;
    /** AnkiWeb answered that the item does not exist (response field 2). */
    missing: boolean;
    /** AnkiWeb answered that this visitor may not see the item (field 3). */
    accessDenied: boolean;
    /** Anything the decoder could not fully account for. */
    warnings: string[];
}

interface WireField {
    field: number;
    wireType: number;
    /** Set for wire type 0. */
    value: number;
    /** Set for wire type 2. */
    bytes: Uint8Array | null;
    /** Set for wire types 1 and 5. */
    other: number | null;
}

interface WireRead {
    fields: WireField[];
    /** True when the buffer ended inside a field. */
    truncated: boolean;
    /** A note when a field could not be walked at all (deprecated groups). */
    note: string | null;
}

/**
 * The minimal wire-format reader this client needs: varints (wire type 0),
 * length-delimited fields (2), and the two fixed-width shapes (1 and 5) so a
 * field of either kind can be skipped safely. Values are plain numbers: the
 * fields read here (sizes, timestamps, counts) are far below 2^53, and a
 * varint beyond that would lose precision rather than throw.
 */
function readWireFields(bytes: Uint8Array): WireRead {
    const fields: WireField[] = [];
    let cursor = 0;
    let truncated = false;
    let note: string | null = null;

    const readVarint = (): number | null => {
        let value = 0;
        let shift = 0;
        while (cursor < bytes.length && shift < 64) {
            const byte = bytes[cursor++];
            value += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) return value;
            shift += 7;
        }
        return null;
    };

    while (cursor < bytes.length) {
        const key = readVarint();
        if (key === null) {
            truncated = true;
            break;
        }
        const field = Math.floor(key / 8);
        const wireType = key & 0x07;
        if (wireType === 0) {
            const value = readVarint();
            if (value === null) {
                truncated = true;
                break;
            }
            fields.push({ field, wireType, value, bytes: null, other: null });
        } else if (wireType === 2) {
            const length = readVarint();
            if (length === null || cursor + length > bytes.length) {
                truncated = true;
                break;
            }
            fields.push({ field, wireType, value: 0, bytes: bytes.subarray(cursor, cursor + length), other: null });
            cursor += length;
        } else if (wireType === 5) {
            if (cursor + 4 > bytes.length) {
                truncated = true;
                break;
            }
            const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 4);
            fields.push({ field, wireType, value: 0, bytes: null, other: view.getUint32(0, true) });
            cursor += 4;
        } else if (wireType === 1) {
            if (cursor + 8 > bytes.length) {
                truncated = true;
                break;
            }
            const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 8);
            fields.push({ field, wireType, value: 0, bytes: null, other: view.getUint32(0, true) });
            cursor += 8;
        } else {
            // Wire types 3/4 are the deprecated groups; there is no safe way to
            // skip one without a schema, so stop and say so.
            note = `field ${field} uses the deprecated group wire type, so the rest of the response was not read`;
            truncated = true;
            break;
        }
    }

    return { fields, truncated, note };
}

function fieldText(field: WireField): string | null {
    if (field.wireType !== 2 || !field.bytes) return null;
    return new TextDecoder('utf-8').decode(field.bytes);
}

/**
 * Decode an `item-info` response.
 *
 * The response is a oneof: field 1 carries the item (the `SharedItemInfo`
 * message documented above), field 2 says the item is missing, field 3 says
 * access was denied. This decoder returns an info object either way — the
 * caller decides what to do with `missing`/`accessDenied` — and reports
 * truncation rather than throwing, so a half-read response cannot take the
 * plugin down.
 */
export function parseItemInfo(bytes: Uint8Array): DecksItemInfo {
    const info: DecksItemInfo = {
        title: null,
        description: null,
        tags: null,
        sizeBytes: null,
        lastUpdatedSeconds: null,
        thumbsUp: null,
        thumbsDown: null,
        deck: null,
        addon: false,
        missing: false,
        accessDenied: false,
        warnings: [],
    };

    const top = readWireFields(bytes);
    if (top.truncated) {
        info.warnings.push(top.note ?? 'The item-info response ended early; only part of it was read.');
    }

    let item: WireField | null = null;
    for (const field of top.fields) {
        if (field.field === 1 && field.wireType === 2) item = field;
        else if (field.field === 2 && field.wireType === 0 && field.value !== 0) info.missing = true;
        else if (field.field === 3 && field.wireType === 0 && field.value !== 0) info.accessDenied = true;
    }
    if (!item || !item.bytes) {
        if (!info.missing && !info.accessDenied && info.warnings.length === 0) {
            info.warnings.push('The item-info response carried no item.');
        }
        return info;
    }

    const inner = readWireFields(item.bytes);
    if (inner.truncated) {
        info.warnings.push(inner.note ?? 'The item information ended early; only part of it was read.');
    }

    for (const field of inner.fields) {
        switch (field.field) {
            case 5: {
                const title = fieldText(field);
                if (title !== null) info.title = title;
                break;
            }
            case 6: {
                const tags = fieldText(field);
                if (tags !== null) info.tags = tags;
                break;
            }
            case 7:
                if (field.wireType === 0) info.sizeBytes = field.value;
                break;
            case 8:
                if (field.wireType === 0) info.lastUpdatedSeconds = field.value;
                break;
            case 9: {
                const description = fieldText(field);
                if (description !== null) info.description = description;
                break;
            }
            case 10:
                if (field.wireType === 2 && field.bytes) info.deck = parseDeckInfo(field.bytes, info.warnings);
                break;
            case 11:
                info.addon = true;
                break;
            case 18:
                if (field.wireType === 0) info.thumbsUp = field.value;
                break;
            case 19:
                if (field.wireType === 0) info.thumbsDown = field.value;
                break;
            default:
                // Fields this client has no use for (reviews, sample notes,
                // support URL, counters) are skipped by number/wire type.
                break;
        }
    }

    return info;
}

function parseDeckInfo(bytes: Uint8Array, warnings: string[]): DecksItemDeckInfo {
    const deck: DecksItemDeckInfo = { notes: null, audio: null, images: null, downloadKey: null };
    const read = readWireFields(bytes);
    if (read.truncated) warnings.push('Part of the deck information could not be read.');
    for (const field of read.fields) {
        if (field.wireType === 0) {
            if (field.field === 1) deck.notes = field.value;
            else if (field.field === 2) deck.audio = field.value;
            else if (field.field === 3) deck.images = field.value;
        } else if (field.wireType === 2 && field.field === 5) {
            deck.downloadKey = fieldText(field);
        }
    }
    return deck;
}

/* ------------------------------------------------------------------ service */

export type AnkiWebItemInfoStatus = 'ok' | 'missing' | 'access-denied' | 'unreadable';

export interface AnkiWebItemInfoOutcome {
    id: string;
    status: AnkiWebItemInfoStatus;
    info: DecksItemInfo | null;
    warning: string | null;
}

/**
 * What a download attempt produced.
 *
 *  - `apkg`         the bytes arrived and begin with the ZIP magic
 *  - `needs-sign-in` AnkiWeb refused because this visitor has no session (the
 *                    ordinary case for a logged-out reader, and rate-limited
 *                    anonymous downloads land here too)
 *  - `refused`      AnkiWeb answered with an error that is not about signing in
 *  - `unreadable`   something arrived that is not an .apkg
 */
export type AnkiWebDownloadOutcome =
    | { kind: 'apkg'; bytes: Uint8Array }
    | { kind: 'needs-sign-in'; message: string }
    | { kind: 'refused'; status: number; message: string }
    | { kind: 'unreadable'; message: string };

function tidyMessage(text: string, fallback: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) return fallback;
    return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

function looksLikeSignIn(text: string): boolean {
    return SIGN_IN_HINT.test(text);
}

/** The one place the three read paths share: make one GET, never throw. */
async function get(transport: AnkiWebTransport, url: string): Promise<AnkiWebResponse | { error: string }> {
    try {
        return await transport({ url });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: tidyMessage(message, 'the request could not be made') };
    }
}

export class AnkiWebService {
    private transport: AnkiWebTransport;

    constructor(transport: AnkiWebTransport = obsidianAnkiWebTransport) {
        this.transport = transport;
    }

    /**
     * Search the shared decks. Never throws; a refusal, a shell page or a
     * changed layout all come back as a status with an honest warning.
     */
    async searchDecks(query: string): Promise<AnkiWebSearchOutcome> {
        const trimmed = query.trim();
        const outcome: AnkiWebSearchOutcome = { query: trimmed, status: 'empty', results: [], warning: null };
        const response = await get(this.transport, `${ANKIWEB_SEARCH_URL}?search=${encodeURIComponent(trimmed)}`);
        if ('error' in response) {
            outcome.status = 'unreadable';
            outcome.warning = `Could not reach AnkiWeb: ${response.error}`;
            return outcome;
        }

        const text = decodeText(response.body);
        if (response.status < 200 || response.status >= 300) {
            if (response.status === 401 || response.status === 403 || response.status === 429) {
                outcome.status = 'needs-sign-in';
                outcome.warning = looksLikeSignIn(text)
                    ? tidyMessage(text, 'AnkiWeb wants a signed-in visitor before it will search.')
                    : 'AnkiWeb refused the search for a visitor with no session.';
                return outcome;
            }
            outcome.status = 'unreadable';
            outcome.warning = `AnkiWeb answered with HTTP ${response.status}.`;
            return outcome;
        }

        const scan = scanSearchResults(text);
        outcome.results = scan.results;
        if (scan.results.length > 0) {
            outcome.status = 'ok';
            outcome.warning = scan.warnings.length > 0 ? scan.warnings.join(' ') : null;
            return outcome;
        }

        if (CLIENT_RENDERED_HINT.test(text)) {
            outcome.status = 'unreadable';
            outcome.warning = 'AnkiWeb renders its search page in the browser now, so the page as downloaded carries no results. Open the search on AnkiWeb instead.';
            return outcome;
        }
        if (looksLikeSignIn(text)) {
            outcome.status = 'needs-sign-in';
            outcome.warning = 'AnkiWeb is asking for a sign-in before it will show search results.';
            return outcome;
        }
        if (scan.warnings.length > 0) {
            // The page carried deck links this scan could not turn into
            // results — say so rather than report a clean empty search.
            outcome.status = 'unreadable';
            outcome.warning = scan.warnings.join(' ');
            return outcome;
        }
        outcome.status = 'empty';
        outcome.warning = null;
        return outcome;
    }

    /** Read one deck's details. Never throws. */
    async fetchItemInfo(id: string): Promise<AnkiWebItemInfoOutcome> {
        const outcome: AnkiWebItemInfoOutcome = { id, status: 'unreadable', info: null, warning: null };
        if (!/^\d+$/.test(id)) {
            outcome.warning = 'That is not a numeric AnkiWeb deck id.';
            return outcome;
        }

        const response = await get(this.transport, `${ANKIWEB_ITEM_INFO_URL}?sharedId=${encodeURIComponent(id)}`);
        if ('error' in response) {
            outcome.warning = `Could not reach AnkiWeb: ${response.error}`;
            return outcome;
        }
        if (response.status < 200 || response.status >= 300 || !response.body) {
            outcome.warning = `AnkiWeb answered with HTTP ${response.status}.`;
            return outcome;
        }

        const info = parseItemInfo(response.body);
        outcome.info = info;
        if (info.missing) {
            outcome.status = 'missing';
            outcome.warning = 'AnkiWeb has no item with that id.';
        } else if (info.accessDenied) {
            outcome.status = 'access-denied';
            outcome.warning = 'AnkiWeb will not show this item to a signed-out visitor.';
        } else {
            outcome.status = 'ok';
            outcome.warning = info.warnings.length > 0 ? info.warnings.join(' ') : null;
        }
        return outcome;
    }

    /**
     * Ask for the package itself.
     *
     * `downloadKey` comes from `fetchItemInfo`; there is no other source for
     * it, and this client has no way to sign in, so a refusal is a normal
     * answer here, not an error. The key is used in the URL and nowhere else —
     * it is never logged, stored or shown.
     */
    async downloadDeck(id: string, downloadKey: string | null): Promise<AnkiWebDownloadOutcome> {
        if (!/^\d+$/.test(id)) {
            return { kind: 'unreadable', message: 'That is not a numeric AnkiWeb deck id.' };
        }
        const key = (downloadKey ?? '').trim();
        if (key.length === 0) {
            return {
                kind: 'needs-sign-in',
                message: 'AnkiWeb did not offer a download key for this deck; signing in on AnkiWeb is required before it will hand one out.',
            };
        }

        const response = await get(this.transport, ankiWebDownloadUrl(id, key));
        if ('error' in response) {
            return { kind: 'unreadable', message: `Could not reach AnkiWeb: ${response.error}` };
        }
        const text = decodeText(response.body);
        if (response.status >= 400) {
            const message = tidyMessage(text, `AnkiWeb answered with HTTP ${response.status}.`);
            if (response.status === 401 || response.status === 403 || response.status === 429 || looksLikeSignIn(text)) {
                return { kind: 'needs-sign-in', message };
            }
            return { kind: 'refused', status: response.status, message };
        }

        const bytes = response.body;
        if (!bytes || bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
            return { kind: 'unreadable', message: 'AnkiWeb answered with something that is not an .apkg archive.' };
        }
        return { kind: 'apkg', bytes };
    }
}
