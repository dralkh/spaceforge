/**
 * Build the opt-in live Study test.
 *
 * Unlike `test/build-tests.mjs`, this is not run by `npm test`: the test makes
 * real, paid model calls. It reuses the same Obsidian shims so the shipping
 * services run unchanged.
 */
import esbuild from 'esbuild';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const shim = rel => path.resolve(root, rel);

const stubs = {
    name: 'obsidian-stubs',
    setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: shim('test/support/obsidian-shim.ts') }));
        build.onResolve({ filter: /(^|\/)main$/ }, () => ({ path: shim('test/support/plugin-shim.ts') }));
    },
};

await esbuild.build({
    entryPoints: [
        'test/live/nanogpt-study.test.ts',
        'test/live/cli-agents.test.ts',
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outdir: '.test-build/live',
    entryNames: '[name]',
    logLevel: 'warning',
    banner: { js: 'const window = globalThis;' },
    plugins: [stubs],
});

console.log('live test bundles written to .test-build/live/');
