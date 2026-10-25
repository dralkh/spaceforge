import test from 'node:test';
import assert from 'node:assert/strict';
import type { TFile } from 'obsidian';

import { EstimationUtils } from '../utils/estimation';

/**
 * Estimates are reading time, so they come from the words in the note.
 *
 * There is no size-based path any more, and no ceiling: a note costs what its text
 * costs. The same-size test below is the guard — if anyone reintroduces "bytes ÷
 * something", two notes of equal size stop being told apart and it fails.
 */

const fileOf = (size: number): TFile => ({ stat: { size } } as unknown as TFile);
const words = (count: number): string => Array.from({ length: count }, (_, index) => `w${index % 13}`).join(' ');

test('200 words take a minute at the default reading speed', () => {
    assert.equal(EstimationUtils.estimateReviewTime(fileOf(1_100), words(200)), 60);
});

test('400 words take two minutes, 1,200 words take six', () => {
    assert.equal(EstimationUtils.estimateReviewTime(fileOf(1), words(400)), 120);
    assert.equal(EstimationUtils.estimateReviewTime(fileOf(1), words(1_200)), 360);
});

test('a long note reports its own reading time, with no ceiling', () => {
    // 12,000 words: an hour at 200 wpm. Capping this would make every day total that
    // contains it wrong, which is the mistake 1.2.3 made.
    assert.equal(EstimationUtils.estimateReviewTime(fileOf(1), words(12_000)), 3_600);
});

test('an almost empty note is floored, never zero', () => {
    assert.equal(EstimationUtils.estimateReviewTime(fileOf(1), ''), 30);
    assert.equal(EstimationUtils.estimateReviewTimeFromWords(0), 30);
});

test('two notes of identical size get different estimates when their text differs', () => {
    // The proof that size is not consulted: same `stat.size`, one note ten times
    // longer in words.
    const sparse = `${words(50)}${' '.repeat(5_000)}`;
    const dense = words(900);
    const sparseSeconds = EstimationUtils.estimateReviewTime(fileOf(5_000), sparse);
    const denseSeconds = EstimationUtils.estimateReviewTime(fileOf(5_000), dense);
    assert.ok(denseSeconds > sparseSeconds * 5, `${denseSeconds}s vs ${sparseSeconds}s`);
});

test('the file argument does not influence the answer', () => {
    const text = words(300);
    const small = EstimationUtils.estimateReviewTime(fileOf(10), text);
    const large = EstimationUtils.estimateReviewTime(fileOf(10_000_000), text);
    assert.equal(small, large);
});

test('the reader’s speed setting scales every estimate', () => {
    const slower = EstimationUtils.estimateReviewTimeFromWords(400, 'technical'); // 100 wpm
    const normal = EstimationUtils.estimateReviewTimeFromWords(400, 'notes');     // 200 wpm
    assert.equal(slower, normal * 2);
});

test('more words never means less time', () => {
    let previous = 0;
    for (const count of [10, 100, 500, 2_000, 10_000]) {
        const seconds = EstimationUtils.estimateReviewTimeFromWords(count);
        assert.ok(seconds >= previous, `${count} words gave ${seconds}s after ${previous}s`);
        previous = seconds;
    }
});
