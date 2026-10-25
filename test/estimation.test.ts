import test from 'node:test';
import assert from 'node:assert/strict';
import type { TFile } from 'obsidian';

import { EstimationUtils } from '../utils/estimation';

/**
 * The calendar draws a day's total from the file's *size*, because reading every
 * note to draw a month cost seconds. That number and the one a note row shows (which
 * does read the text) have to agree — the reader sees both.
 *
 * The size branch used to divide bytes by 38.5 and call the quotient minutes: seven
 * words a minute, so a 9-note day read as 53 hours. These tests pin the arithmetic.
 */

const fileOf = (size: number): TFile => ({ stat: { size } } as unknown as TFile);

/**
 * A note of `words` words whose byte size is what prose of that length weighs
 * (AVG_WORD_LENGTH bytes a word). The padding is spaces, which `countWords`
 * ignores, so both estimates should land on the same number.
 */
const noteOf = (words: number): { file: TFile; text: string } => {
    const text = Array.from({ length: words }, (_, index) => `w${index % 9}`).join(' ')
        .padEnd(Math.round(words * 5.5), ' ');
    return { file: fileOf(text.length), text };
};

test('a kilobyte of note is about a minute of reading, not an hour', () => {
    const seconds = EstimationUtils.estimateReviewTime(fileOf(1_100));
    assert.ok(seconds >= 50 && seconds <= 70, `expected about 60 s for 1.1 KB, got ${seconds}`);
});

test('reading speed setting moves the size estimate in the right direction', () => {
    const file = fileOf(4_400);
    const normal = EstimationUtils.estimateReviewTime(file);
    // 200 wpm by default: 800 words ≈ 4 minutes.
    assert.ok(normal >= 225 && normal <= 255, `expected about 240 s, got ${normal}`);
});

test('a day of notes adds up to minutes, which is the number that was wrong', () => {
    // Nine average notes — the reader's screenshot showed 53 hr 34 min for nine.
    const day = Array.from({ length: 9 }, () => EstimationUtils.estimateReviewTime(fileOf(1_640)))
        .reduce((total, seconds) => total + seconds, 0);
    assert.ok(day < 15 * 60, `nine notes should be minutes, got ${Math.round(day / 60)} min`);
});

test('an enormous file is capped at something a person could sit through', () => {
    const seconds = EstimationUtils.estimateReviewTime(fileOf(400_000));
    assert.equal(seconds, 20 * 60);
});

test('an almost empty note is floored, never zero', () => {
    assert.equal(EstimationUtils.estimateReviewTime(fileOf(10)), 30);
});

test('the size estimate and the text estimate describe the same note', () => {
    for (const words of [40, 120, 400, 1_200]) {
        const { file, text } = noteOf(words);
        const fromSize = EstimationUtils.estimateReviewTime(file);
        const fromText = EstimationUtils.estimateReviewTime(file, text);
        const drift = Math.abs(fromSize - fromText) / fromText;
        assert.ok(drift < 0.1, `${words} words: size said ${fromSize}s, text said ${fromText}s`);
    }
});

test('more text never means less time', () => {
    let previous = 0;
    for (const size of [200, 800, 3_200, 12_800, 51_200]) {
        const seconds = EstimationUtils.estimateReviewTime(fileOf(size));
        assert.ok(seconds >= previous, `${size} bytes gave ${seconds}s after ${previous}s`);
        previous = seconds;
    }
});
