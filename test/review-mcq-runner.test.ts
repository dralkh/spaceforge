import test from 'node:test';
import assert from 'node:assert/strict';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { McqRunner, McqRunSummary } from '../ui/review-mcq-runner';
import { MCQSet } from '../models/mcq';
import SpaceforgePlugin from '../main';

/**
 * The question loop is driven with a keyboard first: arrows point at a choice,
 * numbers and letters pick the choice they print, and a correct answer moves on
 * by itself after a beat. These tests pin that behaviour, because it is exactly
 * the sort of thing a CSS or refactor pass quietly breaks.
 *
 * The keys are delivered the way a browser delivers them — on the document, to
 * whatever element has focus — because that is where the loop listens: the panel
 * is not always the focused element, and a shortcut that only works after
 * clicking the panel first is a shortcut nobody finds.
 */

const AUTO_ADVANCE_MS = 30;

function makeSet(questions = 3): MCQSet {
    return {
        notePath: 'notes/a.md',
        generatedAt: 1,
        questions: Array.from({ length: questions }, (_, i) => ({
            question: `Question ${i + 1}?`,
            choices: ['first', 'second', 'third'],
            correctAnswerIndex: 1,
        })),
    };
}

function mount(set: MCQSet = makeSet(3)) {
    const doc = installMiniDocument();

    const summaries: McqRunSummary[] = [];
    const runner = new McqRunner({} as SpaceforgePlugin, set.notePath, set, {
        onSummary: summary => summaries.push(summary),
        autoAdvanceMs: AUTO_ADVANCE_MS,
    });
    const host = new MiniElement('div');
    runner.mount(host as unknown as HTMLElement);

    const highlighted = () =>
        host.byClass('sf-mcq-runner-choice').findIndex(choice => choice.hasClass('is-highlighted'));
    const progress = () => host.textOf('sf-mcq-runner-progress');

    return {
        runner,
        doc,
        host,
        summaries,
        highlighted,
        progress,
        press: (key: string, target?: unknown) => doc.press(key, target),
    };
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('the first choice is highlighted before any key is pressed', () => {
    const { highlighted } = mount();
    assert.equal(highlighted(), 0);
});

test('the keys are bound to the document, and let go on unmount', () => {
    const { doc, runner } = mount();
    assert.equal(doc.count(), 1, 'one keydown listener, bound while mounted');
    runner.unmount();
    assert.equal(doc.count(), 0, 'and nothing is left behind');
});

test('the arrows walk the choices and wrap at the ends', () => {
    const { press, highlighted } = mount();

    press('ArrowDown');
    assert.equal(highlighted(), 1);
    press('ArrowDown');
    assert.equal(highlighted(), 2);
    press('ArrowDown');
    assert.equal(highlighted(), 0, 'the last choice wraps to the first');

    press('ArrowUp');
    assert.equal(highlighted(), 2, 'and the first wraps back to the last');
    press('ArrowLeft');
    assert.equal(highlighted(), 1);
    press('ArrowRight');
    assert.equal(highlighted(), 2);
});

test('a number picks the choice it prints, wherever the keystroke lands', async () => {
    const { press, progress } = mount();

    press('2'); // the second choice is the correct one
    await wait(AUTO_ADVANCE_MS + 20);

    assert.match(progress(), /^2\/3$/, 'answered and moved on, with no click');
});

test('a letter picks the choice it prints, in either case', () => {
    const { host, press } = mount();

    press('C'); // third choice: wrong, so the loop stays put
    assert.match(host.textOf('sf-mcq-runner-feedback'), /Not quite/);

    press('a'); // first choice: also wrong, but it must be picked
    assert.equal(host.byClass('sf-mcq-runner-choice')[0].hasClass('is-wrong'), true);
});

test('a letter past the end of the row picks nothing', () => {
    const { press } = mount(makeSet(2));
    const event = press('e');
    assert.equal(event.defaultPrevented, false, 'the key is left for the editor');
});

test('a correct answer moves on by itself, after the beat', async () => {
    const { host, press, progress } = mount();

    press('2');
    assert.match(progress(), /^1\/3$/, 'still on the question it just answered');
    assert.match(host.textOf('sf-mcq-runner-feedback'), /Correct/);

    await wait(AUTO_ADVANCE_MS + 60);
    assert.match(progress(), /^2\/3$/, 'and then it is the next question');
});

test('a wrong answer waits for the reader instead of moving on', async () => {
    const { host, press, progress } = mount();

    press('3');
    await wait(AUTO_ADVANCE_MS + 60);

    assert.match(progress(), /^1\/3$/, 'still waiting');
    assert.match(host.textOf('sf-mcq-runner-feedback'), /Not quite/);
});

test('Enter answers the highlighted choice, and continues after feedback', async () => {
    const { host, press, highlighted, progress } = mount();

    press('ArrowDown'); // second choice, which is the correct one
    assert.equal(highlighted(), 1);
    press('Enter');
    assert.match(host.textOf('sf-mcq-runner-feedback'), /Correct/);

    press('Enter'); // and now it continues
    assert.match(progress(), /^2\/3$/);
    assert.equal(highlighted(), 0, 'the next question starts on its first choice');
    await wait(AUTO_ADVANCE_MS + 20);
});

test('keys meant for the note are left alone', () => {
    const { host, press } = mount();
    const editor = new MiniElement('div');
    editor.addClass('cm-editor');

    const event = press('2', editor);
    assert.equal(event.defaultPrevented, false, 'typing in the editor is not a shortcut');
    assert.equal(host.textOf('sf-mcq-runner-feedback'), '', 'and nothing was answered');
});

test('keys aimed at a field or a dialog are left alone', () => {
    const { press, highlighted } = mount();
    const field = new MiniElement('textarea');
    const dialog = new MiniElement('div');
    dialog.addClass('modal');

    press('ArrowDown', field);
    assert.equal(highlighted(), 0, 'a field keeps its arrow keys');
    press('1', dialog);
    assert.equal(highlighted(), 0, 'so does a dialog');
});

test('the hint prints the letters and numbers the row actually shows', () => {
    const { host } = mount(makeSet(3));
    const hint = host.textOf('sf-mcq-runner-keys');
    assert.match(hint, /A–C/, 'three choices: A to C');
    assert.match(hint, /1–3/);
});

test('answering is true only while a question is on screen', async () => {
    const { runner, press } = mount(makeSet(1));

    assert.equal(runner.answering, true);
    press('2');
    await wait(AUTO_ADVANCE_MS + 60);
    assert.equal(runner.answering, false, 'the sitting is over');
});

test('a sitting answered by keyboard alone reports every answer', async () => {
    const { press, summaries } = mount(makeSet(2));

    press('2'); // correct
    await wait(AUTO_ADVANCE_MS + 40);
    press('1'); // wrong
    press('2'); // corrected on the retry, which moves on
    await wait(AUTO_ADVANCE_MS + 40);

    assert.equal(summaries.length, 1);
    const [summary] = summaries;
    assert.equal(summary.completed, true);
    assert.equal(summary.answered, 2);
    assert.deepEqual(
        summary.answers.map(a => [a.selectedAnswerIndex, a.correct, a.attempts]),
        [
            [1, true, 1],
            [1, true, 2],
        ],
    );
});

test('a pending auto-advance dies with the runner', async () => {
    const { press, runner, summaries } = mount();

    press('2'); // correct, so a jump is scheduled
    runner.unmount();
    await wait(AUTO_ADVANCE_MS + 60);

    assert.equal(summaries.length, 0, 'unmounting is silent');
});

test('keys pressed after the sitting ends do nothing', async () => {
    const { press, summaries } = mount(makeSet(1));

    press('2');
    await wait(AUTO_ADVANCE_MS + 60);
    assert.equal(summaries.length, 1, 'one question: answered, done');

    const event = press('1');
    assert.equal(event.defaultPrevented, false);
    assert.equal(summaries.length, 1, 'and no second summary');
});

test('a hidden runner keeps its place and lets go of the keyboard', async () => {
    const { runner, doc, host, press, progress } = mount();

    press('1'); // a wrong pick: a state worth coming back to
    assert.match(host.textOf('sf-mcq-runner-feedback'), /Not quite/);

    // The dock hides the panel on a tab switch rather than unmounting it.
    runner.setVisible(false);
    assert.equal(doc.count(), 0, 'a hidden runner answers nothing');

    const ignored = press('2');
    assert.equal(ignored.defaultPrevented, false, 'the key belongs to the reader again');
    assert.match(host.textOf('sf-mcq-runner-feedback'), /Not quite/, 'and the question stands still');

    runner.setVisible(true);
    assert.equal(doc.count(), 1, 'shown again, it takes the keys back');
    assert.match(host.textOf('sf-mcq-runner-feedback'), /Not quite/, 'where the sitting was left');
    press('2');
    await wait(AUTO_ADVANCE_MS + 60);
    assert.match(progress(), /^2\/3$/, 'and it carries on from there');
});

test('showing and hiding a runner repeatedly leaves exactly one key listener', () => {
    const { runner, doc } = mount();

    runner.setVisible(false);
    runner.setVisible(false);
    runner.setVisible(true);
    runner.setVisible(true);
    assert.equal(doc.count(), 1, 'hiding and showing is not a second binding');

    runner.setVisible(false);
    runner.unmount();
    assert.equal(doc.count(), 0, 'and nothing is left behind');
});
