/**
 * The shipped artifact has to load. Obsidian requires the bundle, so anything
 * that only fails at require time (a bad import, a browser global touched at
 * module scope, a missing plugin method) would break the plugin for everyone.
 *
 * Runs only when main.js has been built; `npm test` alone still works in a clean
 * clone. The bundle-load check is deliberately last-word cheap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const bundlePath = path.join(root, 'main.js');

/**
 * Auto-vivifying stand-in for the Obsidian module: every named export becomes a
 * class, so `class ReviewModal extends Modal {}` at module scope still evaluates.
 */
const STUB_SOURCE = `
const makeClass = () => class ObsidianStub { constructor() {} };
module.exports = new Proxy({}, {
    get(target, prop) {
        if (prop === '__esModule') return true;
        if (prop === 'default') return target.default ?? (target.default = makeClass());
        if (!(prop in target)) target[prop] = makeClass();
        return target[prop];
    },
});
`;

test('the shipped bundle loads and carries the review flow', { skip: fs.existsSync(bundlePath) ? false : 'main.js has not been built' }, () => {
    const requireCjs = createRequire(import.meta.url);

    const stubPath = path.join(root, '.test-build', 'obsidian-permissive-stub.cjs');
    fs.mkdirSync(path.dirname(stubPath), { recursive: true });
    fs.writeFileSync(stubPath, STUB_SOURCE);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = requireCjs('module') as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request: string, parent?: unknown, isMain?: boolean) {
        if (request === 'obsidian' || request === 'electron') {
            return originalLoad.call(this, stubPath, parent, isMain);
        }
        return originalLoad.apply(this, [request, parent, isMain]);
    };

    try {
        const bundle = requireCjs(bundlePath) as { default?: unknown };
        assert.equal(typeof bundle.default, 'function', 'main.js must export the plugin class');

        const prototype = Object.getOwnPropertyNames((bundle.default as { prototype: object }).prototype);
        for (const method of ['onload', 'onunload', 'addCommands', 'getSidebarView']) {
            assert.ok(prototype.includes(method), `the plugin class lost ${method}()`);
        }

        const source = fs.readFileSync(bundlePath, 'utf8');
        for (const marker of ['sf-strip-grade', 'Review session complete', 'resolveLeech', 'previewReview', 'awaitDecision']) {
            assert.ok(source.includes(marker), `the shipped bundle is missing ${marker}`);
        }
    } finally {
        Module._load = originalLoad;
    }
});

test('the stylesheet that ships has the bar in it', { skip: fs.existsSync(path.join(root, 'styles.css')) ? false : 'styles.css has not been built' }, () => {
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    for (const rule of ['.sf-strip {', '.sf-strip-grade', '.workspace-leaf-content.sf-strip-host']) {
        assert.ok(css.includes(rule), `built styles.css is missing ${rule}`);
    }
});
