import test from 'node:test';
import assert from 'node:assert/strict';

import { TFile } from 'obsidian';
import SpaceforgePlugin from '../main';
import { MCQController } from '../controllers/review-controller-mcq';
import { MCQSet } from '../models/mcq';

/**
 * Preparing a note's questions is one operation, however many surfaces ask for
 * it: the dock's questions panel, the review window and the consolidated run
 * all call ensureMcqSetForNote(), and they can call in the same breath. Without
 * the shared promise each caller would await its own generation, write its own
 * set, and show a different set of questions from the one on the screen next to
 * it. These tests drive the real controller against fakes, and count the
 * generations.
 */

interface Options {
    /** What the generation service does; the default returns a fresh set. */
    generate?: (notePath: string, content: string) => Promise<MCQSet | null>;
}

function makeController(options: Options = {}) {
    const calls = {
        /** Paths handed to the generation service, in order. */
        generated: [] as string[],
        /** How many times the store was read. */
        reads: 0,
        /** How many times a set was written back. */
        saves: 0,
    };

    const stored = new Map<string, MCQSet>();
    const plugin = {
        settings: { enableMCQ: true },
        app: {
            vault: {
                getAbstractFileByPath: (path: string) => {
                    const file = new TFile();
                    file.path = path;
                    file.basename = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
                    return file;
                },
                read: async () => 'the note, in full',
            },
        },
        savePluginData: async () => undefined,
    };
    const mcqService = {
        getMCQSetForNote: (path: string): MCQSet | undefined => {
            calls.reads += 1;
            return stored.get(path);
        },
        saveMCQSet: (saved: MCQSet): void => {
            calls.saves += 1;
            stored.set(saved.notePath, saved);
        },
    };
    const generation = {
        plugin: plugin as unknown as SpaceforgePlugin,
        generateMCQs: async (notePath: string, content: string): Promise<MCQSet | null> => {
            calls.generated.push(notePath);
            if (options.generate) return options.generate(notePath, content);
            return {
                notePath,
                generatedAt: 1,
                questions: [{ question: 'Question?', choices: ['first', 'second'], correctAnswerIndex: 0 }],
            };
        },
    };

    const controller = new MCQController(plugin as unknown as SpaceforgePlugin, mcqService as never, generation as never);
    return { controller, calls, stored };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('concurrent calls for one note share one generation and one set', async () => {
    let release: (() => void) | null = null;
    const { controller, calls } = makeController({
        generate: async (notePath: string) => {
            await new Promise<void>(resolve => { release = resolve; });
            return {
                notePath,
                generatedAt: 1,
                questions: [{ question: 'Question?', choices: ['first', 'second'], correctAnswerIndex: 0 }],
            };
        },
    });

    // Three surfaces ask in the same breath — a tab click, the window, a refresh.
    const first = controller.ensureMcqSetForNote('notes/a.md');
    const second = controller.ensureMcqSetForNote('notes/a.md');
    const third = controller.ensureMcqSetForNote('notes/a.md');
    await settle();

    assert.equal(calls.generated.length, 1, 'one generation for all three callers');

    (release as unknown as () => void)();
    const sets = await Promise.all([first, second, third]);

    assert.equal(calls.generated.length, 1, 'and still one when it lands');
    assert.ok(sets[0], 'every caller got a set');
    assert.equal(sets[1], sets[0], 'the same set, not three copies of it');
    assert.equal(sets[2], sets[0], 'all three of them');
    assert.equal(calls.saves, 1, 'written back once');
});

test('a later call for a note that already has questions reads them, and does not generate again', async () => {
    const { controller, calls } = makeController();

    const first = await controller.ensureMcqSetForNote('notes/a.md');
    assert.equal(calls.generated.length, 1);

    const again = await controller.ensureMcqSetForNote('notes/a.md');

    assert.equal(calls.generated.length, 1, 'the second look is a read');
    assert.equal(again, first, 'and hands back the set that is on disk');
});

test('different notes generate independently, at the same time', async () => {
    const { controller, calls } = makeController();

    const [a, b] = await Promise.all([
        controller.ensureMcqSetForNote('notes/a.md'),
        controller.ensureMcqSetForNote('notes/b.md'),
    ]);

    assert.deepEqual(calls.generated, ['notes/a.md', 'notes/b.md'], 'one generation each');
    assert.equal(a?.notePath, 'notes/a.md');
    assert.equal(b?.notePath, 'notes/b.md');
});

test('a failed preparation is cleared, so asking again retries it', async () => {
    let attempt = 0;
    const { controller, calls } = makeController({
        generate: async (notePath: string) => {
            attempt += 1;
            if (attempt === 1) throw new Error('the provider is down');
            return {
                notePath,
                generatedAt: 1,
                questions: [{ question: 'Question?', choices: ['first', 'second'], correctAnswerIndex: 0 }],
            };
        },
    });

    await assert.rejects(() => controller.ensureMcqSetForNote('notes/a.md'), /provider is down/);
    assert.equal(calls.generated.length, 1);

    const retried = await controller.ensureMcqSetForNote('notes/a.md');

    assert.ok(retried, 'the retry is served');
    assert.equal(calls.generated.length, 2, 'a fresh attempt, not the finished failure');
});
