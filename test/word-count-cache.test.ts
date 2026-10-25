import test from 'node:test';
import assert from 'node:assert/strict';

import { WordCountCache } from '../services/word-count-cache';
import { EstimationUtils } from '../utils/estimation';

/**
 * The calendar's day totals come from these counts, so what matters is that they
 * are the note's real words — not an approximation from its size — and that asking
 * twice does not read the file twice.
 */

interface FakeFile {
    text: string;
    mtime: number;
    size?: number;
}

const sourceOf = (files: Map<string, FakeFile>) => {
    const reads: string[] = [];
    let inFlight = 0;
    let peak = 0;
    return {
        reads,
        peak: () => peak,
        source: {
            async read(path: string): Promise<string | null> {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                reads.push(path);
                // Yield, so overlap is possible if the worker pool is too wide.
                await new Promise(resolve => setTimeout(resolve, 1));
                inFlight -= 1;
                return files.has(path) ? files.get(path)!.text : null;
            },
            stamp(path: string): string | null {
                const file = files.get(path);
                if (!file) return null;
                return `${file.mtime}:${file.size ?? file.text.length}`;
            },
        },
    };
};

const words = (count: number): string => Array.from({ length: count }, (_, index) => `w${index % 11}`).join(' ');

test('a note is read once, and every later question is free', async () => {
    const files = new Map([['a.md', { text: words(200), mtime: 1 }]]);
    const { source, reads } = sourceOf(files);
    const cache = new WordCountCache(source);

    assert.equal(cache.words('a.md'), null, 'nothing is known before the first read');
    assert.equal(await cache.prime(['a.md']), 1);
    assert.equal(cache.words('a.md'), 200);

    await cache.prime(['a.md']);
    await cache.prime(['a.md', 'a.md']);
    assert.deepEqual(reads, ['a.md'], 'three primes, one read');
});

test('a changed note is read again, an untouched one is not', async () => {
    const files = new Map([['a.md', { text: words(100), mtime: 1 }]]);
    const { source, reads } = sourceOf(files);
    const cache = new WordCountCache(source);
    await cache.prime(['a.md']);

    files.set('a.md', { text: words(140), mtime: 2 });
    assert.equal(cache.words('a.md'), null, 'a new stamp means the old count is not trusted');
    await cache.prime(['a.md']);
    assert.equal(cache.words('a.md'), 140);
    assert.deepEqual(reads, ['a.md', 'a.md']);
});

test('the estimate follows the words, not the size of the file', async () => {
    // Same byte count, wildly different reading time: this is the case a size-based
    // estimate cannot tell apart, and the reason it was removed.
    const long = `${words(900)} ${'x'.repeat(0)}`;
    const short = `${words(60)}${' '.repeat(long.length - words(60).length)}`;
    assert.equal(long.length, short.length, 'the two notes weigh the same');

    const files = new Map([
        ['long.md', { text: long, mtime: 1 }],
        ['short.md', { text: short, mtime: 1 }],
    ]);
    const { source } = sourceOf(files);
    const cache = new WordCountCache(source);
    await cache.prime(['long.md', 'short.md']);

    const longSeconds = EstimationUtils.estimateReviewTimeFromWords(cache.words('long.md')!);
    const shortSeconds = EstimationUtils.estimateReviewTimeFromWords(cache.words('short.md')!);
    assert.ok(longSeconds > shortSeconds * 5, `${longSeconds}s vs ${shortSeconds}s should differ by the text`);
});

test('markdown syntax is not counted as reading', async () => {
    const files = new Map([['a.md', { text: '```\nconst a = 1;\n```\n\n# Title\n\nsource text here', mtime: 1 }]]);
    const { source } = sourceOf(files);
    const cache = new WordCountCache(source);
    await cache.prime(['a.md']);
    // Title and the sentence: four words. The code block is not read aloud.
    assert.ok(cache.words('a.md')! < 8, `counted ${cache.words('a.md')} words`);
});

test('a note that vanished is forgotten, not remembered with a stale count', async () => {
    const files = new Map([['a.md', { text: words(50), mtime: 1 }]]);
    const { source } = sourceOf(files);
    const cache = new WordCountCache(source);
    await cache.prime(['a.md']);
    assert.equal(cache.words('a.md'), 50);

    files.delete('a.md');
    assert.equal(cache.words('a.md'), null);
    assert.equal(cache.known, 0);
});

test('reads overlap, but never wider than the cache allows', async () => {
    const files = new Map(Array.from({ length: 40 }, (_, index) => [`n${index}.md`, { text: words(30), mtime: 1 }]));
    const { source, peak } = sourceOf(files);
    const cache = new WordCountCache(source, 4);
    assert.equal(await cache.prime(Array.from(files.keys())), 40);
    assert.ok(peak() <= 4, `peak overlap was ${peak()}`);
    assert.ok(peak() > 1, 'reads should overlap at all');
});

test('an unreadable note leaves the cell unpriced instead of guessing', async () => {
    const files = new Map([['a.md', { text: words(10), mtime: 1 }]]);
    const { source } = sourceOf(files);
    const cache = new WordCountCache(source);
    assert.equal(await cache.prime(['missing.md']), 0);
    assert.equal(cache.words('missing.md'), null);
});
