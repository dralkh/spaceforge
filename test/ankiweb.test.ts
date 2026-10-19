/**
 * The AnkiWeb client, exercised without a network.
 *
 * Fixtures in `test/fixtures/ankiweb/`, and exactly how real each one is:
 *
 *  - `search-biolog.html`        REAL, captured with curl on 2026-10-17 from
 *    https://ankiweb.net/shared/decks?search=biolog. It is the client-rendered
 *    SvelteKit shell — the live page no longer server-renders results (the
 *    site's own bundle sets `ssr: false`), so the plugin must read whatever
 *    HTML it gets and say honestly when there is nothing in it.
 *  - `search-results-sample.html` CONSTRUCTED, mirroring the results table the
 *    site's own client bundle renders (see the comment in the file). Deck ids
 *    and titles are real; only that table markup is assembled here.
 *  - `item-info-1196762551.bin`  REAL, captured with curl on 2026-10-17 from
 *    https://ankiweb.net/svc/shared/item-info?sharedId=1196762551 — protobuf
 *    bytes, as served to a signed-out visitor.
 *
 * What could NOT be verified without an AnkiWeb account:
 *
 *  - A download that actually succeeds. Anonymous downloads answer 429
 *    ("Please log in to download more decks.", captured live and used below),
 *    so the happy path is tested against a fake transport that returns ZIP
 *    bytes, and the real captured refusal is tested as the expected outcome.
 *  - Whether `download_key` (item-info field 10.5) means "this visitor may
 *    download". It is present in signed-out responses; the download endpoint
 *    still refused this visitor. Field meanings that ARE certain are listed in
 *    services/ankiweb-service.ts next to the decoder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    ANKIWEB_ITEM_INFO_URL,
    ANKIWEB_SEARCH_URL,
    AnkiWebService,
    AnkiWebTransport,
    ankiWebDownloadUrl,
    parseItemInfo,
    scanSearchResults,
} from '../services/ankiweb-service';
import { describeDeckMeta, describeSearchOutcome, moveHighlight } from '../ui/ankiweb-search-modal';

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/ankiweb/${name}`, import.meta.url));
const fixtureText = (name: string) => fixture(name).toString('utf8');
const encode = (text: string) => new TextEncoder().encode(text);

/** A transport that always answers with the same status and body. */
function fixedTransport(status: number, body: string | Uint8Array): AnkiWebTransport {
    const bytes = typeof body === 'string' ? encode(body) : body;
    return async () => ({ status, body: bytes });
}

/** A recording transport, so a test can see which URL was asked for. */
function recordingTransport(status: number, body: string): { transport: AnkiWebTransport; urls: string[] } {
    const urls: string[] = [];
    return {
        urls,
        transport: async (request) => {
            urls.push(request.url);
            return { status, body: encode(body) };
        },
    };
}

/* ------------------------------------------------------- the live search page */

test('the real live search page is read tolerantly: no results, no throw', () => {
    const html = fixtureText('search-biolog.html');
    const scan = scanSearchResults(html);
    assert.equal(scan.results.length, 0);
    assert.equal(scan.linksSeen, 0);
    assert.deepEqual(scan.warnings, []);
});

test('a client-rendered page is reported as unreadable, not as an empty search', async () => {
    const service = new AnkiWebService(fixedTransport(200, fixtureText('search-biolog.html')));
    const outcome = await service.searchDecks('biolog');
    assert.equal(outcome.status, 'unreadable');
    assert.equal(outcome.results.length, 0);
    assert.match(outcome.warning ?? '', /renders its search page in the browser/);
});

test('the search asks AnkiWeb the way the website does, with the query encoded', async () => {
    const { transport, urls } = recordingTransport(200, '<html><body><h1>Shared Decks</h1><p>No matches were found.</p></body></html>');
    const service = new AnkiWebService(transport);
    const outcome = await service.searchDecks('  biol ogy & 日本語 ');
    assert.deepEqual(urls, [`${ANKIWEB_SEARCH_URL}?search=${encodeURIComponent('biol ogy & 日本語')}`]);
    assert.equal(outcome.query, 'biol ogy & 日本語');
    assert.equal(outcome.status, 'empty');
    assert.equal(outcome.results.length, 0);
    assert.equal(outcome.warning, null);
});

/* ------------------------------------------------------- listing markup scan */

test('a listing in AnkiWeb\'s own results shape parses into decks with metadata', () => {
    const html = fixtureText('search-results-sample.html');
    const scan = scanSearchResults(html);
    assert.equal(scan.results.length, 3);
    assert.deepEqual(scan.warnings, []);

    for (const result of scan.results) {
        assert.match(result.id, /^\d+$/, `id is numeric: ${result.id}`);
        assert.ok(result.name.length > 0, 'name is non-empty');
        assert.equal(result.url, `https://ankiweb.net/shared/info/${result.id}`);
    }

    const kaishi = scan.results.find((result) => result.id === '1196762551');
    assert.ok(kaishi);
    assert.equal(kaishi.name, 'Kaishi 1.5k - Basic Japanese Vocabulary');
    // 318 thumbs up + 12 thumbs down, as the live deck page shows; the vote
    // bar's count is the one read from this markup.
    assert.equal(kaishi.ratings, 330);
    assert.equal(kaishi.downloads, undefined, 'this markup labels no downloads, so none are invented');
    assert.equal(kaishi.author, undefined, 'and no author either');

    const geography = scan.results.find((result) => result.id === '2109889812');
    assert.ok(geography);
    assert.equal(geography.name, 'Ultimate Geography v5.3');
    assert.equal(geography.ratings, 512);
});

test('labelled metadata is read when the page provides it', () => {
    const html = [
        '<table><tbody><tr>',
        '<td><a href="/shared/info/1196762551">Kaishi 1.5k</a></td>',
        '<td>318 ratings</td><td>45,120 downloads</td><td>by donkuri</td>',
        '</tr><tr>',
        '<td><a href="/shared/info/2109889812">Ultimate Geography</a></td>',
        '<td>4.8 stars</td>',
        '</tr></tbody></table>',
    ].join('');
    const scan = scanSearchResults(html);
    assert.equal(scan.results.length, 2);
    const kaishi = scan.results[0];
    assert.equal(kaishi.ratings, 318);
    assert.equal(kaishi.downloads, 45120);
    assert.equal(kaishi.author, 'donkuri');
    // Nothing labelled, nothing read.
    assert.equal(scan.results[1].ratings, undefined);
    assert.equal(scan.results[1].downloads, undefined);
    assert.equal(scan.results[1].author, undefined);
});

test('a truncated page warns and returns what it could read', () => {
    const html = fixtureText('search-results-sample.html');
    const cut = html.indexOf('<a href="/shared/info/521792878"');
    assert.ok(cut > 0, 'the second deck link is where it is expected');
    const truncated = html.slice(0, cut + 40); // Mid-way through the second row.

    const scan = scanSearchResults(truncated);
    assert.equal(scan.results.length, 1);
    assert.equal(scan.results[0].id, '1196762551');
    assert.equal(scan.linksSeen, 2);
    assert.ok(scan.warnings.length > 0, 'a truncated page is reported');
    assert.match(scan.warnings[0], /Only 1 of 2 deck links/);
});

test('a page whose links are in an unrecognised shape warns instead of throwing', async () => {
    const changed = '<div data-href="/shared/info/123456">A deck</div><a href="https://ankiweb.net/shared/info/not-a-number">x</a>';
    const scan = scanSearchResults(changed);
    assert.equal(scan.results.length, 0);
    assert.equal(scan.linksSeen, 1);
    assert.match(scan.warnings[0] ?? '', /markup may have changed/);

    const service = new AnkiWebService(fixedTransport(200, changed));
    const outcome = await service.searchDecks('x');
    assert.equal(outcome.status, 'unreadable');
    assert.equal(outcome.results.length, 0);
    assert.match(outcome.warning ?? '', /markup may have changed/);
});

test('duplicate links to one deck collapse to a single result', () => {
    const html = '<a href="/shared/info/42">Deck</a> ... <a href="https://ankiweb.net/shared/info/42">Deck again</a>';
    const scan = scanSearchResults(html);
    assert.equal(scan.results.length, 1);
    assert.equal(scan.results[0].name, 'Deck');
});

/* ---------------------------------------------------------------- refusals */

test('the live search refusal (429, captured verbatim) is a first-class outcome', async () => {
    // Captured 2026-10-17: GET /svc/shared/list-decks?search=biolog, and the
    // same text on the search page's own search, answered by a signed-out
    // visitor.
    const service = new AnkiWebService(fixedTransport(429, 'Please log in to perform more searches.'));
    const outcome = await service.searchDecks('biolog');
    assert.equal(outcome.status, 'needs-sign-in');
    assert.equal(outcome.results.length, 0);
    assert.match(outcome.warning ?? '', /log in to perform more searches/);
});

test('a 403 with an HTML login page is a sign-in refusal, not an error', async () => {
    const service = new AnkiWebService(fixedTransport(403, '<html><body><h1>AnkiWeb</h1><p>You must log in to view this page.</p></body></html>'));
    const outcome = await service.searchDecks('biology');
    assert.equal(outcome.status, 'needs-sign-in');
    assert.match(outcome.warning ?? '', /log in/i);
});

test('a 200 page that asks for a sign-in reads as needs-sign-in too', async () => {
    const service = new AnkiWebService(fixedTransport(200, '<html><body><p>Please log in to search the shared decks.</p></body></html>'));
    const outcome = await service.searchDecks('biology');
    assert.equal(outcome.status, 'needs-sign-in');
});

test('a search that cannot be made at all is reported, not thrown', async () => {
    const service = new AnkiWebService(async () => { throw new Error('offline'); });
    const outcome = await service.searchDecks('biology');
    assert.equal(outcome.status, 'unreadable');
    assert.match(outcome.warning ?? '', /Could not reach AnkiWeb: offline/);
});

/* ------------------------------------------------- item-info protobuf reader */

function varintBytes(value: number): number[] {
    const out: number[] = [];
    let rest = value;
    do {
        const byte = rest % 128;
        rest = Math.floor(rest / 128);
        out.push(rest > 0 ? byte + 128 : byte);
    } while (rest > 0);
    return out;
}

function lengthField(field: number, payload: number[] | Uint8Array): number[] {
    const bytes = payload instanceof Uint8Array ? [...payload] : payload;
    return [...varintBytes(field * 8 + 2), ...varintBytes(bytes.length), ...bytes];
}

const varintField = (field: number, value: number): number[] => [...varintBytes(field * 8), ...varintBytes(value)];
const textBytes = (text: string): number[] => [...encode(text)];

test('the wire reader maps the fields it knows and skips what it does not', () => {
    const item = Uint8Array.from([
        ...lengthField(5, textBytes('Kaishi 1.5k ✓ 日本語')),      // title, multi-byte UTF-8
        ...lengthField(9, textBytes('<p>description</p>')),
        ...lengthField(30, lengthField(1, textBytes('nested message the reader must skip'))), // unknown field: skipped by number
        ...varintBytes(31 * 8 + 1), 1, 2, 3, 4, 5, 6, 7, 8,         // unknown field, wire type 1 (64-bit): skipped by wire type
        ...varintBytes(32 * 8 + 5), 9, 9, 9, 9,                     // unknown field, wire type 5 (32-bit): skipped
        ...varintField(7, 117268520),
        ...varintField(18, 318),
        ...varintField(19, 12),
        ...lengthField(10, [                                     // the deck message
            ...varintField(1, 1501),
            ...varintField(2, 2972),
            ...varintField(3, 1382),
            ...lengthField(5, textBytes('opaque-key-value')),
        ]),
    ]);
    const info = parseItemInfo(Uint8Array.from([...lengthField(1, item)]));

    assert.equal(info.title, 'Kaishi 1.5k ✓ 日本語');
    assert.equal(info.description, '<p>description</p>');
    assert.equal(info.sizeBytes, 117268520);
    assert.equal(info.thumbsUp, 318);
    assert.equal(info.thumbsDown, 12);
    assert.ok(info.deck);
    assert.equal(info.deck.notes, 1501);
    assert.equal(info.deck.audio, 2972);
    assert.equal(info.deck.images, 1382);
    assert.equal(info.deck.downloadKey, 'opaque-key-value');
    assert.equal(info.addon, false);
    assert.equal(info.missing, false);
    assert.equal(info.accessDenied, false);
    assert.deepEqual(info.warnings, []);
});

test('the real captured item-info response decodes to what the live page shows', () => {
    const bytes = new Uint8Array(fixture('item-info-1196762551.bin'));
    const info = parseItemInfo(bytes);

    // Cross-checked against the live deck page on 2026-10-17: it renders the
    // same title, "318 12" for the rating, "111.84MB. 2972 audio & 1382
    // images. Updated 2026-09-15." for the statistics.
    assert.equal(info.title, 'Kaishi 1.5k - Basic Japanese Vocabulary');
    assert.equal(info.thumbsUp, 318);
    assert.equal(info.thumbsDown, 12);
    assert.equal(info.sizeBytes, 117268520);
    assert.equal(info.lastUpdatedSeconds, 1789494324);
    assert.match(info.tags ?? '', /Beginner/);
    assert.match(info.description ?? '', /Kaishi 1\.5k is a modern Japanese deck/);
    assert.ok(info.deck);
    assert.equal(info.deck.notes, 1501);
    assert.equal(info.deck.audio, 2972);
    assert.equal(info.deck.images, 1382);
    // A signed-out visitor DID receive a key; what AnkiWeb would accept it for
    // is the one thing this capture cannot answer (downloads still answered
    // "Please log in to download more decks.").
    assert.ok(typeof info.deck.downloadKey === 'string' && info.deck.downloadKey.length > 40);
    assert.equal(info.addon, false);
    assert.equal(info.missing, false);
    assert.equal(info.accessDenied, false);
    assert.deepEqual(info.warnings, []);
});

test('the real "no such item" response (two bytes) reads as missing', () => {
    // Captured 2026-10-17 from item-info?sharedId=1561013528 (an id that does
    // not exist): the whole body is 0x10 0x01, i.e. field 2 varint 1.
    const info = parseItemInfo(Uint8Array.from([0x10, 0x01]));
    assert.equal(info.missing, true);
    assert.equal(info.title, null);
    assert.deepEqual(info.warnings, []);
});

test('a truncated protobuf warns instead of throwing', () => {
    const bytes = new Uint8Array(fixture('item-info-1196762551.bin'));
    const half = bytes.slice(0, Math.floor(bytes.length / 2));
    const info = parseItemInfo(half);
    assert.ok(info.warnings.length > 0, 'the early end is reported');
    assert.equal(info.title, null, 'a container that never closed yields no fields');

    // And bytes that are not protobuf at all do not throw either.
    const nonsense = encode('this is not a protobuf response');
    const other = parseItemInfo(nonsense);
    assert.ok(other.warnings.length > 0);
    assert.equal(other.title, null);
});

test('fetchItemInfo asks the site endpoint and maps the real body through the service', async () => {
    const urls: string[] = [];
    const service = new AnkiWebService(async (request) => {
        urls.push(request.url);
        return { status: 200, body: new Uint8Array(fixture('item-info-1196762551.bin')) };
    });
    const outcome = await service.fetchItemInfo('1196762551');
    assert.deepEqual(urls, [`${ANKIWEB_ITEM_INFO_URL}?sharedId=1196762551`]);
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.info?.title, 'Kaishi 1.5k - Basic Japanese Vocabulary');
    assert.equal(outcome.warning, null);

    const missing = await new AnkiWebService(fixedTransport(200, Uint8Array.from([0x10, 0x01]))).fetchItemInfo('1561013528');
    assert.equal(missing.status, 'missing');
    assert.match(missing.warning ?? '', /no item with that id/);

    const failed = await new AnkiWebService(fixedTransport(500, 'boom')).fetchItemInfo('1');
    assert.equal(failed.status, 'unreadable');
    assert.equal(failed.info, null);

    const badId = await new AnkiWebService(fixedTransport(200, '')).fetchItemInfo('abc');
    assert.equal(badId.status, 'unreadable');
    assert.match(badId.warning ?? '', /not a numeric AnkiWeb deck id/);
});

/* ----------------------------------------------------------------- downloads */

test('downloadDeck accepts only a ZIP body and returns the bytes', async () => {
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const urls: string[] = [];
    const service = new AnkiWebService(async (request) => {
        urls.push(request.url);
        return { status: 200, body: zip };
    });
    const outcome = await service.downloadDeck('1196762551', 'key with +/= chars');
    assert.equal(outcome.kind, 'apkg');
    assert.deepEqual(urls, [ankiWebDownloadUrl('1196762551', 'key with +/= chars')]);
    assert.ok(urls[0].includes('t=key%20with%20%2B%2F%3D%20chars'), 'the key is URL-encoded');
    if (outcome.kind === 'apkg') assert.deepEqual([...outcome.bytes], [...zip]);
});

test('downloadDeck rejects a body that is not an .apkg', async () => {
    const service = new AnkiWebService(fixedTransport(200, '<html>you are not allowed here</html>'));
    const outcome = await service.downloadDeck('1196762551', 'some-key');
    assert.equal(outcome.kind, 'unreadable');
    if (outcome.kind === 'unreadable') assert.match(outcome.message, /not an \.apkg archive/);

    // One byte of the ZIP magic is not the ZIP magic.
    const almost = await new AnkiWebService(fixedTransport(200, Uint8Array.from([0x50]))).downloadDeck('1', 'k');
    assert.equal(almost.kind, 'unreadable');
});

test('the live download refusal (429, captured verbatim) is the expected signed-out outcome', async () => {
    // Captured 2026-10-17: GET /svc/shared/download-deck/1196762551?t=<key>.
    const service = new AnkiWebService(fixedTransport(429, 'Please log in to download more decks.'));
    const outcome = await service.downloadDeck('1196762551', 'whatever-key');
    assert.equal(outcome.kind, 'needs-sign-in');
    if (outcome.kind === 'needs-sign-in') {
        assert.match(outcome.message, /log in to download more decks/);
        assert.ok(!outcome.message.includes('whatever-key'), 'the key is never echoed back');
    }
});

test('a download refused with an HTML 403 offers the sign-in story, not a crash', async () => {
    const service = new AnkiWebService(fixedTransport(403, '<html><body><p>Please log in to continue.</p></body></html>'));
    const outcome = await service.downloadDeck('1196762551', 'some-key');
    assert.equal(outcome.kind, 'needs-sign-in');

    const serverError = await new AnkiWebService(fixedTransport(500, 'boom')).downloadDeck('1196762551', 'some-key');
    assert.equal(serverError.kind, 'refused');
    if (serverError.kind === 'refused') {
        assert.equal(serverError.status, 500);
        assert.equal(serverError.message, 'boom');
    }
});

test('a download without a key never asks AnkiWeb and says why', async () => {
    let called = false;
    const service = new AnkiWebService(async () => {
        called = true;
        return { status: 200, body: null };
    });
    for (const key of [null, '', '   ']) {
        const outcome = await service.downloadDeck('1196762551', key);
        assert.equal(outcome.kind, 'needs-sign-in');
    }
    assert.equal(called, false, 'no request is made without a key');
});

/* --------------------------------------------------------------- modal logic */

test('the highlight walks the list and clamps at both ends', () => {
    assert.equal(moveHighlight(-1, 1, 3), 0);
    assert.equal(moveHighlight(-1, -1, 3), 2);
    assert.equal(moveHighlight(0, 1, 3), 1);
    assert.equal(moveHighlight(2, 1, 3), 2, 'clamps at the end');
    assert.equal(moveHighlight(0, -1, 3), 0, 'clamps at the start');
    assert.equal(moveHighlight(-1, 1, 0), -1, 'an empty list has no highlight');
    assert.equal(moveHighlight(0, 1, 0), -1);
});

test('the modal says what happened, including when AnkiWeb refused', () => {
    assert.equal(
        describeSearchOutcome({ query: 'x', status: 'ok', results: [{ id: '1', name: 'A', url: 'u' }], warning: null }),
        '1 deck found.'
    );
    assert.equal(
        describeSearchOutcome({ query: 'x', status: 'ok', results: [{ id: '1', name: 'A', url: 'u' }, { id: '2', name: 'B', url: 'u' }], warning: null }),
        '2 decks found.'
    );
    assert.equal(describeSearchOutcome({ query: 'x', status: 'empty', results: [], warning: null }), 'No decks matched.');
    assert.match(describeSearchOutcome({ query: 'x', status: 'needs-sign-in', results: [], warning: 'Please log in to perform more searches.' }), /signed-in/);
    assert.match(describeSearchOutcome({ query: 'x', status: 'unreadable', results: [], warning: 'x' }), /could not be read/);
});

test('the metadata line only mentions what the page said', () => {
    assert.equal(describeDeckMeta({ id: '1', name: 'A', url: 'u' }), '');
    assert.equal(describeDeckMeta({ id: '1', name: 'A', url: 'u', ratings: 330 }), '330 ratings');
    assert.equal(
        describeDeckMeta({ id: '1', name: 'A', url: 'u', ratings: 318, downloads: 45120, author: 'donkuri' }),
        '318 ratings · 45,120 downloads · by donkuri'
    );
});
