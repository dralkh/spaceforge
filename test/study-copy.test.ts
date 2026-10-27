import test from 'node:test';
import assert from 'node:assert/strict';
import { stripRestatedQuestion } from '../ui/study-copy';

const question = 'Why is the citrate synthase step effectively irreversible, and what pays for it?';

test('a closing line that restates the question is dropped, the teaching stays', () => {
    const say = 'Acetyl-CoA condenses with oxaloacetate, and the thioester is spent.\n\n**Your turn:** why is this step effectively one-way, and what actually pays for it?';
    assert.equal(stripRestatedQuestion(say, question), 'Acetyl-CoA condenses with oxaloacetate, and the thioester is spent.');
});

test('the only copy of an explanation is never removed, even if it says “your turn”', () => {
    const say = '**Your turn:** why is the citrate synthase step effectively irreversible, and what pays for it?';
    assert.equal(stripRestatedQuestion(say, question), say, 'with no separate teaching paragraph there is nothing safe to drop');
});

test('a “your turn” that introduces different work is kept', () => {
    const say = 'The cycle is catalytic.\n\nYour turn: draw the eight steps from memory before we continue.';
    assert.equal(stripRestatedQuestion(say, question), say);
});

test('without a protocol question nothing is trimmed', () => {
    const say = 'Teaching.\n\nYour turn: explain it back.';
    assert.equal(stripRestatedQuestion(say, null), say);
});
