#!/usr/bin/env node
/**
 * Run the two-device progress soak for longer than CI does.
 *
 *   node scripts/soak-progress.mjs              # 20 seeds x 500 steps (~5s)
 *   node scripts/soak-progress.mjs 60 2000      # a proper soak, ~1 min
 *
 * The soak is the real merge code from `services/progress-mirror.ts` driving two
 * devices into one shared folder, including the conflicted copies a sync tool
 * leaves behind. It is the same suite CI runs, with the knobs turned up; a
 * second Obsidian cannot share a vault (SingletonLock), and no sync daemon is
 * assumed, so this is the honest two-device check that can run unattended.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const seeds = process.argv[2] ?? '20';
const steps = process.argv[3] ?? '500';

const build = spawnSync('node', ['test/build-tests.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const bundle = '.test-build/progress-merge-soak.test.js';
if (!existsSync(bundle)) {
    console.error(`the soak bundle was not built (${bundle} missing)`);
    process.exit(1);
}

console.log(`soak: ${seeds} seeds x ${steps} steps`);
const run = spawnSync('node', ['--test', bundle], {
    stdio: 'inherit',
    env: { ...process.env, SF_SOAK_SEEDS: seeds, SF_SOAK_STEPS: steps },
});
process.exit(run.status ?? 1);
