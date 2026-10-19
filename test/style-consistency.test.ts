/**
 * The bar's stylesheet has to keep up with the bar's markup: a class that is
 * rendered but never styled shows up as a bare rectangle in Obsidian, and a
 * renamed class fails silently. These checks run against the real files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { gradeOptionsFor } from '../models/review-flow';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative: string) => fs.existsSync(path.join(root, relative));

test('every class the bar renders has a rule in its stylesheet', () => {
    const rendering = read('ui/review-strip.ts');
    const css = read('styles/review-strip.css');

    const tokens = new Set(
        [...rendering.matchAll(/sf-[a-z0-9-]+/g)]
            .map(match => match[0])
            // `sf-strip-grade-${variant}` is a prefix, covered by the variant check below.
            .filter(token => !token.endsWith('-'))
    );

    const missing = [...tokens].filter(token => !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(tokens.size > 8, `expected to find the bar's classes, found ${tokens.size}`);
});

test('every class the recovery dialog renders has a rule in its stylesheet', () => {
    const rendering = read('ui/data-recovery-modal.ts');
    const css = read('styles/data-recovery.css');

    const tokens = new Set([...rendering.matchAll(/sf-[a-z0-9-]+/g)].map(match => match[0]));
    const missing = [...tokens].filter(token => !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.match(read('styles/styles.css'), /@import url\('\.\/data-recovery\.css'\);/);
});

test('every grade variant an algorithm can produce is styled', () => {
    const css = read('styles/review-strip.css');
    const variants = new Set(
        [...gradeOptionsFor('fsrs'), ...gradeOptionsFor('sm2')].map(option => option.variant)
    );

    const missing = [...variants]
        .map(variant => `sf-strip-grade-${variant}`)
        .filter(cls => !css.includes(`.${cls}`));

    assert.deepEqual(missing, [], `grade buttons without colours: ${missing.join(', ')}`);
});

test('the stylesheet is part of what the plugin ships', () => {
    assert.match(read('styles/styles.css'), /@import url\('\.\/review-strip\.css'\);/);
});

test('the bar sits under the note rather than over it', () => {
    const css = read('styles/review-strip.css');
    // No fixed/absolute placement: the bar is laid out in the leaf's column.
    const stripRule = /\.sf-strip\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.ok(stripRule.includes('flex: 0 0 auto'), 'the bar takes its own band of the column');
    assert.ok(!/position:\s*(fixed|absolute)/.test(stripRule), 'the bar must not float over the note');
    assert.match(css, /\.workspace-leaf-content\.sf-strip-host\s*\{[^}]*flex-direction:\s*column/, 'the note pane is a column with the bar at the end');
});

test('every setting the settings tab touches really exists', () => {
    const settingsSource = read('models/settings.ts');
    const tabSource = read('ui/settings-tab.ts');

    const defaults = new Set(
        [...settingsSource.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(match => match[1])
    );
    const referenced = new Set(
        [...tabSource.matchAll(/settings\.([a-zA-Z][a-zA-Z0-9]*)/g)].map(match => match[1])
    );

    const unknown = [...referenced].filter(key => !defaults.has(key));
    assert.deepEqual(unknown, [], `settings read by the tab but missing from the settings model: ${unknown.join(', ')}`);
    assert.ok(referenced.size > 20, 'expected to find the settings tab reading settings');
});

test('the review flow settings are wired end to end', () => {
    const settingsSource = read('models/settings.ts');
    const tabSource = read('ui/settings-tab.ts');
    // reviewInterface is read where the routing happens; the rest drive the bar.
    const readers = read('controllers/review-flow-controller.ts') + read('controllers/review-controller-core.ts');

    for (const key of ['reviewStripIntervalPreviews', 'reviewStripGradeKeys', 'leechThreshold']) {
        assert.match(settingsSource, new RegExp(`${key}:`), `${key} missing from the settings model`);
        assert.match(tabSource, new RegExp(`settings\\.${key}`), `${key} is not exposed in the settings tab`);
        assert.match(readers, new RegExp(`settings\\.${key}`), `${key} is never read anywhere`);
    }

    // The review dialog is deprecated: reviewing is docked, always. The key
    // stays in the model so a legacy vault can be migrated, but nothing may
    // read it to choose an interface, and the tab must not offer one.
    assert.match(settingsSource, /reviewInterface:/, 'the key is still migrated, so it stays in the model');
    assert.ok(!/settings\.reviewInterface/.test(tabSource), 'the interface choice is gone from the settings tab');
    assert.ok(!/ReviewModal/.test(readers), 'the review dialog must not be reachable from the review flow');
    assert.ok(!exists('ui/review-modal.ts'), 'ui/review-modal.ts is deleted, not just unused');
});

test('every load path hands the scheduler and the saver the same history array', () => {
    const main = read('main.ts');
    // The scheduler appends to reviewScheduleService.history; savePluginData()
    // serialises reviewHistoryService.history. Rebind one without the other and
    // recorded reviews vanish on restart - so the counts must stay paired, and every
    // path that installs a loaded state must go through the one place that does it.
    const saverBindings = [...main.matchAll(/this\.reviewHistoryService\.history = /g)].length;
    const schedulerBindings = [...main.matchAll(/this\.reviewScheduleService\.history = /g)].length;
    assert.ok(saverBindings >= 1, 'the shared history array must be bound at all');
    assert.equal(
        schedulerBindings,
        saverBindings,
        'each place that rebinds the history service must also rebind the schedule service to the same array'
    );
    assert.match(main, /const sharedHistory = this\.pluginState\.history \|\| \[\];/, 'one array, shared');
    assert.ok(
        [...main.matchAll(/this\.applyLoadedState\(\)/g)].length >= 3,
        'the load paths (try, catch) and the recovery path must all install state through applyLoadedState()'
    );
});

test('every caller that grades says which scale its rating is in', () => {
    // The padding the scales overlap on is the whole bug: a caller that builds an
    // FsrsRating and does not say so gets it read as an SM-2 quality (Good -> Hard).
    const callers = [
        'controllers/review-flow-controller.ts',
        'controllers/review-controller-mcq.ts',
        'controllers/study-controller.ts',
    ];
    for (const file of callers) {
        const source = read(file);
        const sites = [...source.matchAll(/processReviewResponse\(/g)].map(match => match.index ?? 0);
        assert.ok(sites.length > 0, `${file}: expected at least one grading call`);
        for (const [index, at] of sites.entries()) {
            const next = sites[index + 1] ?? source.length;
            const snippet = source.slice(at, Math.min(next, at + 700));
            assert.match(snippet, /ratingKind/, `${file}: a grading call does not declare its rating scale`);
        }
    }
});

/** The rule body for a selector, so a variable can be asserted where it lands. */
function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at) + 1);
}

test('dynamically sized things are driven by the custom properties the code sets', () => {
    // The code stopped assigning inline styles and now sets --sf-dock-height and
    // --sf-fill. A stylesheet that does not read them looks fine in every unit
    // test and does nothing in the app, so the contract is asserted here: for
    // each property the code writes, the rule that decides that measurement has
    // to consume it.
    const study = read('styles/study.css');
    const sidebar = read('styles/sidebar.css');
    const dock = read('ui/review-dock.ts');
    const panel = read('ui/study-panel.ts');
    const list = read('ui/sidebar/list-view-renderer.ts');

    assert.match(dock, /setCssProps\(\{ '--sf-dock-height'/);
    assert.match(ruleBody(study, '.sf-dock-host.is-open .sf-dock-inner'), /height: var\(--sf-dock-height/,
        'the rule that decides the dock height must read --sf-dock-height');

    assert.match(panel, /setCssProps\(\{ '--sf-fill'/);
    for (const selector of ['.sf-study-meter-fill', '.sf-study-chartline-fill', '.sf-study-digest-fill']) {
        assert.match(ruleBody(study, selector), /width: var\(--sf-fill/, `${selector} must read --sf-fill`);
    }

    assert.match(list, /setCssProps\(\{ '--sf-session-progress'/);
    assert.match(ruleBody(sidebar, '.review-session-progress-bar'), /width: var\(--sf-session-progress/,
        'the sidebar progress bar must read --sf-session-progress');
});

test('no source file assigns an inline style directly', () => {
    // Plugin guideline: styling belongs in the stylesheet so themes can change
    // it. Custom properties are data; `el.style.foo = bar` is styling.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const rel = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (['styles', 'media'].includes(entry.name)) continue;
                walk(rel);
                continue;
            }
            if (!entry.name.endsWith('.ts')) continue;
            const source = read(rel);
            for (const match of source.matchAll(/^\s*\S*\.style\.[a-zA-Z]+\s*=/gm)) {
                offenders.push(`${rel}: ${match[0].trim()}`);
            }
        }
    };
    for (const dir of ['api', 'controllers', 'models', 'services', 'ui', 'utils']) walk(dir);
    const main = read('main.ts');
    for (const match of main.matchAll(/^\s*\S*\.style\.[a-zA-Z]+\s*=/gm)) offenders.push(`main.ts: ${match[0].trim()}`);
    assert.deepEqual(offenders, []);
});

/** Every rule block in a stylesheet, with the line its selector sits on. */
function styleRules(css: string): Array<{ line: number; selector: string; body: string }> {
    // Comments are blanked rather than removed so line numbers stay true.
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
    const rules: Array<{ line: number; selector: string; body: string }> = [];
    const stack: Array<{ selector: string; at: number }> = [];
    let last = 0;
    for (const brace of clean.matchAll(/[{}]/g)) {
        const segment = clean.slice(last, brace.index);
        last = (brace.index ?? 0) + 1;
        if (brace[0] === '{') {
            stack.push({ selector: segment.trim().replace(/\s+/g, ' '), at: brace.index ?? 0 });
        } else if (stack.length > 0) {
            const open = stack.pop() as { selector: string; at: number };
            rules.push({
                line: clean.slice(0, open.at).split('\n').length,
                selector: open.selector,
                body: clean.slice(open.at + 1, brace.index),
            });
        }
    }
    return rules;
}

/** The stylesheets the plugin ships, discovered rather than listed. */
const styleSheets = (): string[] =>
    fs.readdirSync(path.join(root, 'styles')).filter(file => file.endsWith('.css'));

test('every font size comes from the house type scale, never an absolute unit', () => {
    // A px (or rem/pt) font size is a size the reader cannot change, and it is
    // exactly how the same text ended up bigger on one surface than its
    // neighbour. The scale lives in styles/_variables.css (--sf-font-text /
    // -ui / -small / -title / -display), each token reading one of the app's own
    // font variables. A relative `em` is allowed: every surface that uses one
    // pins its root with a token first, so it still moves with the reader.
    //
    // No exemptions: every stylesheet in `styles/` now scales from the house
    // tokens, including the sidebar's own.
    const exempt: string[] = [];
    assert.deepEqual(exempt, [], 'the whole stylesheet set is on the house scale');

    const offenders: string[] = [];
    for (const file of styleSheets()) {
        if (exempt.includes(file)) continue;
        const css = read(`styles/${file}`);
        for (const match of css.matchAll(/font-size:\s*([^;{}]+)/g)) {
            if (!/\d(\.\d+)?(px|rem|pt|pc|cm|mm|in)\b/.test(match[1])) continue;
            const line = css.slice(0, match.index).split('\n').length;
            offenders.push(`${file}:${line} font-size: ${match[1].trim()}`);
        }
    }
    assert.deepEqual(offenders, [], 'hard-coded font sizes (use a --sf-font-* token)');
});

test('a rule that can cut text silently says so with an ellipsis', () => {
    // The pair is the defect: `overflow: hidden` clips, and `white-space:
    // nowrap` means the text cannot wrap, so a long line is guillotined
    // mid-phrase with nothing to say it continues. That is how long MCQ options
    // were being lost. `text-overflow: ellipsis` is the visible apology, and a
    // rule that wants one line but is not prepared to be cut simply omits the
    // `overflow: hidden` (it then overflows visibly, which is honest).
    const offenders: string[] = [];
    for (const file of styleSheets()) {
        for (const rule of styleRules(read(`styles/${file}`))) {
            const clips = /overflow(-[xy])?:\s*hidden/.test(rule.body);
            const nowrap = /white-space:\s*nowrap/.test(rule.body);
            const ellipsis = /text-overflow:\s*ellipsis/.test(rule.body);
            if (clips && nowrap && !ellipsis) offenders.push(`${file}:${rule.line} ${rule.selector}`);
        }
    }
    assert.deepEqual(offenders, [], 'clipped-and-nowrap rules without an ellipsis');
});

test('question and answer text is allowed to wrap, wherever it is drawn', () => {
    // Obsidian's own stylesheet sets `white-space: nowrap` on every button
    // (verified in app.css), and an MCQ option, a card choice and a study choice
    // are all buttons. Anything drawing a question or an answer has to say
    // `white-space: normal` itself, or the app's own rule turns the text into one
    // endless line that the panel's edge cuts mid-phrase.
    const surfaces: Array<[string, string]> = [
        ['styles/mcq-runner.css', '.sf-mcq-runner-question'],
        ['styles/mcq-runner.css', '.sf-mcq-runner-choice'],
        ['styles/mcq-runner.css', '.sf-mcq-runner-choice-text'],
        ['styles/deck-session.css', '.sf-deck-front'],
        ['styles/deck-session.css', '.sf-deck-back'],
        ['styles/deck-session.css', '.sf-deck-choice'],
        ['styles/deck-session.css', '.sf-deck-choice-text'],
        ['styles/mcq.css', '.mcq-choice-btn'],
        ['styles/mcq.css', '.mcq-choice-text'],
        ['styles/study.css', '.sf-study-choice'],
    ];
    for (const [file, selector] of surfaces) {
        assert.match(ruleBody(read(file), selector), /white-space:\s*normal/, `${selector} must wrap, not clip`);
    }
});

test('the type scale follows the reader, not a table of pixels', () => {
    // Every tier must derive from the size the reader's pane already has. A
    // pixel fallback is a promise the plugin does not keep: it looks right at
    // the default size and then refuses to move when the reader raises theirs,
    // so paragraphs grow and the labels stay behind. The only pixel allowed in
    // a fallback is the 12px floor under the smallest tier.
    const css = read('styles/_variables.css');
    for (const token of ['--sf-font-text', '--sf-font-ui', '--sf-font-small', '--sf-font-title', '--sf-font-display']) {
        const match = css.match(new RegExp(token + ':\\s*([^;]+);'));
        assert.ok(match, `${token} is defined`);
        const value = match[1];
        const fallback = value.includes(',') ? value.slice(value.indexOf(',') + 1) : '';
        const withoutFloor = fallback.replace(/max\(12px\s*,\s*/g, '').replace(/[)]/g, '');
        assert.ok(!/\d+px/.test(withoutFloor), `${token} must not fall back to fixed pixels: ${value}`);
        assert.ok(/(em|rem|%)/.test(fallback) || /calc\(/.test(value), `${token} falls back to a relative size: ${value}`);
    }
});
