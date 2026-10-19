/**
 * Bundle the test suites for Node.
 *
 * Two shims keep the domain code runnable outside Obsidian:
 *  - `obsidian` -> test/support/obsidian-shim.ts (Notice, TFile, ...)
 *  - `../main`  -> test/support/plugin-shim.ts (the plugin class is used for
 *    types only, but services still import it)
 */
import esbuild from 'esbuild';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const shim = (rel) => path.resolve(root, rel);

const stubs = {
    name: 'obsidian-stubs',
    setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: shim('test/support/obsidian-shim.ts') }));
        build.onResolve({ filter: /(^|\/)main$/ }, () => ({ path: shim('test/support/plugin-shim.ts') }));
    },
};

await esbuild.build({
    entryPoints: [
        'test/study.test.ts',
        'test/study-charting.test.ts',
        'test/scheduler-fidelity.test.ts',
        'test/review-flow.test.ts',
        'test/review-schedule-service.test.ts',
        'test/review-strip.test.ts',
        'test/review-dock.test.ts',
        'test/review-mcq-runner.test.ts',
        'test/review-mcq-controller.test.ts',
        'test/mcq-scoring.test.ts',
        'test/review-flow-controller.test.ts',
        'test/style-consistency.test.ts',
        'test/sidebar-review-tab.test.ts',
        'test/study-visuals.test.ts',
        'test/study-visual-lab.test.ts',
        'test/study-visual-graph.test.ts',
        'test/study-material-section.test.ts',
        'test/study-autopilot.test.ts',
        'test/study-briefing.test.ts',
        'test/study-session.test.ts',
        'test/study-visual-gallery.test.ts',
        'test/study-visual-diagram.test.ts',
        'test/study-visual-sequence.test.ts',
        'test/review-flow-fuzz.test.ts',
        'test/bundle-load.test.ts',
    'test/data-file.test.ts',
    'test/cli-providers.test.ts',
    'test/chat-client.test.ts',
    'test/cli-binary.test.ts',
    'test/upgrade-1-1-0.test.ts',
    'test/anki-package.test.ts',
    'test/anki-scheduler.test.ts',
    'test/deck-store.test.ts',
    'test/card-presentation.test.ts',
    'test/deck-session.test.ts',
    'test/deck-service.test.ts',
    'test/deck-list.test.ts',
    'test/ankiweb.test.ts',
    'test/settings-tab.test.ts',
    'test/study-mindmap.test.ts',
    'test/study-visual-board.test.ts',
    // Session visibility: a run started from the sidebar's list (its own suite,
    // appended last so a lane registering earlier keeps its anchor).
    'test/review-session-visibility.test.ts',
    // The list's run marker: the note row the run stands on, and the deck row
    // it stands on at a deck step (its own suite, appended after the lanes
    // above so each keeps the anchor it registered against).
    'test/list-view.test.ts',
    // The card editor, in place in the cards surface — no popups, and the
    // sitting's keys stay the sitting's (appended after the lanes above so
    // each keeps the anchor it registered against).
    'test/card-editor.test.ts',
    // The statistics lane: the service's day counters and reads, the dashboard
    // over the miniature DOM, and the chart layer's own arithmetic (appended
    // after the lanes above so each keeps the anchor it registered against).
    'test/stats-service.test.ts',
    'test/stats-view.test.ts',
    'test/stats-charts.test.ts',
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outdir: '.test-build',
    logLevel: 'warning',
    // A few scheduling helpers use window.setTimeout; Node has the same timer API.
    banner: { js: 'const window = globalThis;' },
    plugins: [stubs],
});

console.log('test bundles written to .test-build/');
