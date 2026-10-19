/**
 * The lab, and the arithmetic behind its answers, driven against the repo's
 * mini-dom.
 *
 * Two things are pinned here. The **evaluator** (`utils/expr.ts`) is where the
 * risk lives — it reads a model's expression and must be right about
 * precedence (`-2^2` is -4), about every function it claims, and about what it
 * refuses: an unknown identifier, an unbalanced parenthesis, empty input and a
 * division by zero are all `null`, never a number and never a throw. The
 * **lab** is checked the way a reader uses it: one control per parameter, every
 * answer recomputed on a real `input` event, a preset that names a state, a
 * Reset that gives the asset's own starting values back, and an answer that
 * cannot be computed saying so in words instead of showing `NaN`.
 *
 * The stylesheet's part is checked too, in the same suite: every class the lab
 * renders has a rule, and every size comes from the house type scale.
 *
 * Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { StudyLab, StudyLabOutput } from '../models/study-visuals';
import {
    GAUGE_MIN_ANGLE,
    LAB_SOLVED_TEXT,
    LAB_UNKNOWN_TEXT,
    StudyVisualLabView,
    bandRange,
    bandedOutputs,
    clampToParam,
    countInBand,
    formatLabValue,
    gaugeAngle,
    missionScoreText,
    missionText,
    motionAllowed,
    outputScale,
    percentAcross,
    stepFor,
    valueInBand,
    valueWithUnit,
} from '../ui/study-visual-lab';
import { evaluateExpression, evaluateNode, formatNumber, parseExpression } from '../utils/expr';

const repoRoot = process.cwd();
const CSS_PATH = 'styles/study-visual-lab.css';
const read = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

// The surfaces reach for no document of their own, but every mini-dom suite
// installs the element and document globals the UI code works against.
installMiniDocument();

/** The rule body for a selector, so the stylesheet can be asserted where it lands. */
function ruleBody(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at) + 1);
}

// ------------------------------------------------------------------- fixtures

function labFixture(): StudyLab {
    return {
        kind: 'lab',
        title: 'Fluid balance',
        teach: 'Widen the intake and watch the load climb.',
        params: [
            { id: 'sodium', label: 'Serum sodium', unit: 'mmol/L', min: 120, max: 150, value: 140 },
            { id: 'intake', label: 'Water intake', unit: 'L/day', min: 0, max: 4, step: 0.25, value: 1.5 },
        ],
        outputs: [
            { id: 'load', label: 'Daily sodium load', unit: 'mmol', expression: 'sodium * intake', note: 'Sodium times the volume it sits in.' },
            { id: 'gap', label: 'Room to the mid-range', unit: 'mmol/L', expression: 'sodium - 135' },
            { id: 'pearlBudget', label: 'Rounded load', unit: 'mmol', expression: 'round(sodium * intake)' },
        ],
        presets: [
            { label: 'Hyponatraemia', values: { sodium: 126, intake: 3.5 } },
            { label: 'More water', values: { intake: 3 } },
            { label: 'Off the scale', values: { sodium: 999 } },
        ],
        pearl: 'Sodium follows water.',
    };
}

/**
 * A lab whose answers cannot be read: one division by zero, one identifier no
 * parameter defines. The first output still computes, so the suite can prove
 * the uncomputable rows are the only ones that say so.
 */
function brokenLabFixture(): StudyLab {
    return {
        kind: 'lab',
        title: 'Broken arithmetic',
        teach: '',
        params: [{ id: 'dose', label: 'Dose', unit: 'mg', min: 0, max: 10, value: 5 }],
        outputs: [
            { id: 'ok', label: 'Twice the dose', unit: 'mg', expression: 'dose * 2' },
            { id: 'byZero', label: 'Divided by the change', expression: '10 / (dose - dose)' },
            { id: 'unknown', label: 'Reads a parameter that is not there', expression: 'weight * 2', note: 'There is no weight in this lab.' },
        ],
    };
}

/**
 * A lab whose answers are drawn: a bar with a normal band on a declared scale,
 * a gauge with a band of its own, and the rare answer that is printed because it
 * is genuinely a word — each drawn one carrying the band's own words for the two
 * places a value can be.
 */
function drawnLabFixture(): StudyLab {
    return {
        kind: 'lab',
        title: 'Dose and response',
        teach: 'Slide the dose and watch the drawings answer.',
        params: [{ id: 'dose', label: 'Dose', unit: 'mg', min: 0, max: 200, value: 40 }],
        outputs: [
            {
                id: 'effect',
                label: 'Effect',
                unit: 'units',
                expression: 'dose',
                render: 'bar',
                scaleMin: 0,
                scaleMax: 200,
                band: [50, 150],
                insideLabel: 'In the therapeutic window',
                outsideLabel: 'Outside the window',
            },
            {
                id: 'share',
                label: 'Share of the ceiling',
                expression: 'dose / 200',
                render: 'gauge',
                scaleMin: 0,
                scaleMax: 1,
                band: [0.25, 0.75],
                insideLabel: 'Steady',
                outsideLabel: 'Off steady',
            },
            { id: 'words', label: 'Fraction', expression: 'dose / 100', render: 'value', band: [0.5, 1] },
        ],
        presets: [
            { label: 'Full dose', values: { dose: 200 } },
            { label: 'Half dose', values: { dose: 100 } },
        ],
    };
}

// --------------------------------------------------------------------- setup

function host(): MiniElement {
    return new MiniElement('div');
}

function mountLab(lab: StudyLab, into: MiniElement = host()) {
    const view = new StudyVisualLabView();
    const teardown = view.mount(into as unknown as HTMLElement, lab);
    return { view, into, teardown };
}

const valuesOf = (into: MiniElement): string[] => into.byClass('sf-lab-output-value').map(value => value.textContent);

// =============================================================== the evaluator

test('the evaluator reads an expression at the precedence a reader expects', () => {
    const cases: Array<[string, number]> = [
        ['1 + 2 * 3', 7],
        ['(1 + 2) * 3', 9],
        ['10 / 4', 2.5],
        ['3 - -2', 5],
        ['+4', 4],
        ['2e3', 2000],
        ['1.5 + .5', 2],
        [' 7 ', 7],
        // The trap: unary minus binds looser than the power above it, and the
        // power is right associative.
        ['-2^2', -4],
        ['-3 * 2', -6],
        ['(-2)^2', 4],
        ['2^3^2', 512],
        ['2^-1', 0.5],
        ['-2^2 + 10', 6],
    ];
    for (const [expression, expected] of cases) {
        assert.equal(evaluateExpression(expression), expected, expression);
    }

    // Constants, and the parameters the lab supplies.
    assert.equal(evaluateExpression('2 * pi'), 2 * Math.PI);
    assert.equal(evaluateExpression('e'), Math.E);
    assert.equal(evaluateExpression('x * 2 + 1', { x: 4 }), 9);
});

test('the evaluator computes every function it documents', () => {
    const cases: Array<[string, number]> = [
        ['min(3, 7)', 3],
        ['max(3, 7)', 7],
        ['min(5, 7, 2, 9)', 2],
        ['max(5, 7, 2, 9)', 9],
        ['abs(-4)', 4],
        ['abs(4)', 4],
        ['round(2.6)', 3],
        ['round(-2.6)', -3],
        ['sqrt(9)', 3],
        ['sqrt(0)', 0],
        ['ln(e)', 1],
        ['log10(1000)', 3],
        ['exp(0)', 1],
        // Functions nest into each other the way an output line does.
        ['round(max(2.2, min(9.8, 4.4)))', 4],
    ];
    for (const [expression, expected] of cases) {
        assert.equal(evaluateExpression(expression), expected, expression);
    }
});

test('the evaluator refuses anything it cannot read, with null and no throw', () => {
    const refused: string[] = [
        // Nothing to read.
        '',
        '   ',
        // Unbalanced parentheses, either way.
        '(',
        '1 + 2)',
        '((1 + 2)',
        'min(1, 2',
        // A dangling or doubled operator.
        '1 + ',
        '2 * / 3',
        '* 2',
        // Unknown identifiers: neither a constant nor a parameter.
        'weight * 2',
        'NaN',
        'null',
        'Infinity',
        // Calls that could never compute.
        'min()',
        'abs(1, 2)',
        'foo(1)',
        'sqrt',
        // Not arithmetic at all.
        '2 % 3',
        '2 3',
        '"4"',
        'one two',
        '=4',
        // Numbers that are not numbers.
        '1.2.3',
        '1e999',
    ];
    for (const expression of refused) {
        assert.equal(evaluateExpression(expression, { k: 1 }), null, `should refuse: ${JSON.stringify(expression)}`);
    }
});

test('the evaluator refuses what it cannot compute, rather than returning a non-number', () => {
    const uncomputable: string[] = [
        '1 / 0',
        '0 / 0',
        '-1 / 0',
        '10 / (x - x)',
        'sqrt(-1)',
        'ln(0)',
        'ln(-1)',
        'log10(0)',
        'exp(1000)',
        '2^10000',
    ];
    for (const expression of uncomputable) {
        const value = evaluateExpression(expression, { x: 5 });
        assert.equal(value, null, `should not compute: ${expression}`);
    }

    // A parameter that holds a non-number is not a number either.
    assert.equal(evaluateExpression('x + 1', { x: Number.NaN }), null);
    assert.equal(evaluateExpression('x + 1', { x: Number.POSITIVE_INFINITY }), null);
    assert.equal(evaluateExpression('x + 1', {}), null, 'a missing parameter is an unknown identifier');
});

test('parsing is a stage of its own, and the tree it returns is the arithmetic it read', () => {
    const node = parseExpression('2 * x + 1');
    assert.deepEqual(node, {
        kind: 'binary',
        operator: '+',
        left: { kind: 'binary', operator: '*', left: { kind: 'number', value: 2 }, right: { kind: 'name', name: 'x' } },
        right: { kind: 'number', value: 1 },
    });
    assert.equal(parseExpression('2 +'), null);
    assert.equal(parseExpression(''), null);
    // A call to something that is not a function can never compute, so it does
    // not even parse; an identifier might be a parameter, so it parses and is
    // resolved at evaluation instead.
    assert.equal(parseExpression('foo(1)'), null);
    assert.notEqual(parseExpression('weight'), null);
    assert.equal(evaluateExpression('weight'), null);

    const constant = parseExpression('e');
    assert.equal(constant && constant.kind, 'name');
    assert.equal(evaluateNode({ kind: 'name', name: 'e' }, { e: 5 }), Math.E, 'a constant is not shadowed by a parameter');
    assert.equal(evaluateNode({ kind: 'number', value: -0 }, {}), 0, '-0 is normalised, so a readout never shows it');
    assert.equal(evaluateNode({ kind: 'number', value: 3 }, {}), 3);
});

test('numbers are formatted the way a reader should read them', () => {
    assert.equal(formatNumber(1 / 3), '0.333');
    assert.equal(formatNumber(2), '2');
    assert.equal(formatNumber(-0), '0');
    assert.equal(formatNumber(0.1 + 0.2, 1), '0.3');
    assert.equal(formatNumber(210), '210');
    assert.equal(formatNumber(-5), '-5');
    assert.equal(formatNumber(0.0000123), '1.23e-5');
    assert.equal(formatNumber(Number.POSITIVE_INFINITY), '');
    assert.equal(formatNumber(Number.NaN), '');
});

test('the small arithmetic the lab itself does is in its own helpers', () => {
    assert.equal(valueWithUnit(210, 'mmol'), '210 mmol');
    assert.equal(valueWithUnit(210), '210', 'no trailing space when the asset declares no unit');
    assert.equal(formatLabValue(-0), '0');
    assert.equal(formatLabValue(1.50000001), '1.5');

    const withStep = { id: 'a', label: 'A', min: 0, max: 4, step: 0.25, value: 1 };
    const withoutStep = { id: 'b', label: 'B', min: 0, max: 4, value: 1 };
    const tiny = { id: 'c', label: 'C', min: 0, max: 0.0000001, value: 0 };
    assert.equal(stepFor(withStep), 0.25);
    assert.equal(stepFor(withoutStep), 0.04, 'a hundred positions when the asset names no step');
    assert.ok(stepFor(tiny) > 0, 'a tiny range still has a step that moves');
    assert.equal(stepFor({ id: 'd', label: 'D', min: 0, max: 10, step: -1, value: 1 }), 0.1, 'a nonsense step is ignored');
    assert.equal(stepFor({ id: 'e', label: 'E', min: 0, max: 10, step: Number.NaN, value: 1 }), 0.1);

    assert.equal(clampToParam(withStep, 9), 4);
    assert.equal(clampToParam(withStep, -9), 0);
    assert.equal(clampToParam(withStep, 2), 2);
    assert.equal(clampToParam(withStep, Number.NaN), 1, 'a value that is not a number leaves the parameter alone');
});

// ======================================================================= the lab

test('a lab is one labelled control per parameter, showing its value and unit', () => {
    const lab = labFixture();
    const { into } = mountLab(lab);

    assert.equal(into.textOf('sf-lab-teach'), lab.teach, 'the lead-in is the thing the lab should show');
    assert.equal(into.textOf('sf-lab-pearl-text'), lab.pearl);
    assert.equal(into.textOf('sf-lab-pearl-tag'), 'Pearl');

    const rows = into.byClass('sf-lab-param');
    assert.equal(rows.length, lab.params.length, 'one row per parameter');
    assert.deepEqual(rows.map(row => row.attrs['data-param-id']), lab.params.map(param => param.id), 'in the asset’s own order');
    assert.deepEqual(rows.map(row => row.textOf('sf-lab-param-label')), lab.params.map(param => param.label));

    const inputs = into.byClass('sf-lab-range');
    assert.equal(inputs.length, lab.params.length, 'each parameter has a control');
    assert.ok(inputs.every(input => input.tag === 'input'));
    assert.ok(inputs.every(input => input.attrs.type === 'range'), 'the control is a range');
    assert.deepEqual(inputs.map(input => input.attrs.min), ['120', '0']);
    assert.deepEqual(inputs.map(input => input.attrs.max), ['150', '4']);
    assert.deepEqual(inputs.map(input => input.attrs.step), ['0.3', '0.25']);
    assert.deepEqual(inputs.map(input => input.value), ['140', '1.5'], 'each control starts at the value the asset declared');
    assert.deepEqual(inputs.map(input => input.attrs.value), ['140', '1.5']);
    assert.deepEqual(inputs.map(input => input.attrs['aria-label']), ['Serum sodium (mmol/L)', 'Water intake (L/day)']);

    // The number beside each control: the value, then its unit.
    assert.deepEqual(rows.map(row => row.textOf('sf-lab-param-readout')), ['140 mmol/L', '1.5 L/day']);
});

test('every answer is computed from the parameters on the first paint', () => {
    const { into } = mountLab(labFixture());
    const outputs = into.byClass('sf-lab-output');
    assert.equal(outputs.length, 3, 'one row per output');
    assert.deepEqual(outputs.map(row => row.attrs['data-output-id']), ['load', 'gap', 'pearlBudget']);
    assert.deepEqual(outputs.map(row => row.textOf('sf-lab-output-label')), ['Daily sodium load', 'Room to the mid-range', 'Rounded load']);
    // 140 * 1.5 = 210; 140 - 135 = 5; round(210) = 210.
    assert.deepEqual(valuesOf(into), ['210 mmol', '5 mmol/L', '210 mmol']);
    assert.equal(outputs[0].textOf('sf-lab-output-note'), 'Sodium times the volume it sits in.');
    assert.equal(into.byClass('sf-lab-output-note').length, 1, 'only the output that carries a note shows one');
});

test('moving a control recomputes every answer, and the number beside it', () => {
    const { into } = mountLab(labFixture());
    const inputs = into.byClass('sf-lab-range');

    inputs[0].value = '130';
    inputs[0].dispatch('input');
    assert.deepEqual(into.byClass('sf-lab-param-readout').map(readout => readout.textContent), ['130 mmol/L', '1.5 L/day']);
    // 130 * 1.5 = 195; 130 - 135 = -5.
    assert.deepEqual(valuesOf(into), ['195 mmol', '-5 mmol/L', '195 mmol']);

    // The other control moves every answer that reads it too, so two answers
    // that share a parameter can never disagree.
    inputs[1].value = '2';
    inputs[1].dispatch('input');
    assert.deepEqual(valuesOf(into), ['260 mmol', '-5 mmol/L', '260 mmol']);

    // A value that is not a number leaves the lab where it was.
    inputs[1].value = '';
    inputs[1].dispatch('input');
    assert.deepEqual(valuesOf(into), ['260 mmol', '-5 mmol/L', '260 mmol']);

    assert.ok(into.byClass('sf-lab-output-value').every(value => !/NaN|Infinity/.test(value.textContent)), 'nothing leaks a non-number');
});

test('a preset sets the values it names, clamps the ones out of range, and leaves the rest alone', () => {
    const { into } = mountLab(labFixture());
    const presets = into.byClass('sf-lab-preset');
    assert.deepEqual(presets.map(preset => preset.textContent), ['Hyponatraemia', 'More water', 'Off the scale']);
    assert.ok(presets.every(preset => preset.tag === 'button' && preset.attrs.type === 'button'));

    // The reader moves one control away from its starting value first.
    const inputs = into.byClass('sf-lab-range');
    inputs[0].value = '130';
    inputs[0].dispatch('input');

    // A preset that names both parameters moves both.
    presets[0].click();
    assert.deepEqual(inputs.map(input => input.value), ['126', '3.5']);
    assert.deepEqual(into.byClass('sf-lab-param-readout').map(readout => readout.textContent), ['126 mmol/L', '3.5 L/day']);
    // 126 * 3.5 = 441; 126 - 135 = -9.
    assert.deepEqual(valuesOf(into), ['441 mmol', '-9 mmol/L', '441 mmol']);

    // One that names a single parameter leaves the other where it is.
    presets[1].click();
    assert.deepEqual(inputs.map(input => input.value), ['126', '3']);
    assert.deepEqual(valuesOf(into), ['378 mmol', '-9 mmol/L', '378 mmol']);

    // A value outside the parameter's own range cannot put the control outside it.
    presets[2].click();
    assert.equal(inputs[0].value, '150', 'clamped to the range the asset declared');
    assert.equal(inputs[0].attrs.max, '150');
    assert.deepEqual(valuesOf(into), ['450 mmol', '15 mmol/L', '450 mmol']);
});

test('Reset puts the asset’s own starting values back', () => {
    const lab = labFixture();
    const { into } = mountLab(lab);
    const starting = ['210 mmol', '5 mmol/L', '210 mmol'];
    assert.deepEqual(valuesOf(into), starting);

    into.byClass('sf-lab-preset')[0].click();
    assert.notDeepEqual(valuesOf(into), starting);

    const reset = into.byClass('sf-lab-reset')[0];
    assert.equal(reset.tag, 'button');
    assert.equal(reset.textContent, 'Reset');
    reset.click();

    assert.deepEqual(into.byClass('sf-lab-range').map(input => input.value), ['140', '1.5']);
    assert.deepEqual(into.byClass('sf-lab-param-readout').map(readout => readout.textContent), ['140 mmol/L', '1.5 L/day']);
    assert.deepEqual(valuesOf(into), starting);

    // Reset is idempotent: pressing it again changes nothing.
    reset.click();
    assert.deepEqual(valuesOf(into), starting);
});

test('an answer that cannot be computed says so, and the ones that can still answer', () => {
    const { into } = mountLab(brokenLabFixture());
    const rows = into.byClass('sf-lab-output');
    assert.equal(rows.length, 3);

    assert.equal(rows[0].textOf('sf-lab-output-value'), '10 mg');
    assert.equal(rows[0].hasClass('is-unknown'), false);
    for (const row of [rows[1], rows[2]]) {
        assert.equal(row.textOf('sf-lab-output-value'), LAB_UNKNOWN_TEXT);
        assert.equal(row.hasClass('is-unknown'), true, 'the row says it could not be computed');
        assert.ok(!/NaN|Infinity|undefined/.test(row.textContent), 'and never shows a non-number');
    }
    assert.equal(rows[2].textOf('sf-lab-output-note'), 'There is no weight in this lab.', 'the note still explains the row');

    // Moving the control cannot turn an unreadable expression into a number,
    // and the readable one keeps following it.
    const input = into.byClass('sf-lab-range')[0];
    input.value = '7';
    input.dispatch('input');
    assert.deepEqual(valuesOf(into), ['14 mg', LAB_UNKNOWN_TEXT, LAB_UNKNOWN_TEXT]);
});

test('a lab with parameters but no computable answer still renders its controls', () => {
    const lab: StudyLab = {
        kind: 'lab',
        title: 'Nothing computes',
        teach: 'Science',
        params: [
            { id: 'a', label: 'First', min: 0, max: 1, value: 0.5 },
            { id: 'b', label: 'Second', unit: 's', min: 0, max: 10, value: 2 },
        ],
        outputs: [{ id: 'x', label: 'Nothing', expression: 'missing / 0' }],
    };
    const { into } = mountLab(lab);
    assert.equal(into.byClass('sf-lab-range').length, 2, 'every control is there');
    assert.equal(into.byClass('sf-lab-param').length, 2);
    assert.equal(into.byClass('sf-lab-output-value').length, 1);
    assert.equal(into.textOf('sf-lab-output-value'), LAB_UNKNOWN_TEXT);
    // No pearl and no presets: neither is invented.
    assert.equal(into.byClass('sf-lab-pearl').length, 0);
    assert.equal(into.byClass('sf-lab-preset').length, 0);
    // The empty teach line is not drawn as an empty row either.
    assert.equal(lab.teach, 'Science');
    const noTeach = mountLab({ ...lab, teach: '' });
    assert.equal(noTeach.into.byClass('sf-lab-teach').length, 0);
});

// ------------------------------------------------------------------- teardown

test('mounting again replaces the lab instead of stacking a second one', () => {
    const { view, into } = mountLab(labFixture());
    assert.equal(into.byClass('sf-lab').length, 1);
    view.mount(into as unknown as HTMLElement, brokenLabFixture());
    assert.equal(into.byClass('sf-lab').length, 1, 'one lab, redrawn');
    assert.equal(into.byClass('sf-lab-range').length, 1, 'holding the new material');
    assert.equal(into.byClass('sf-lab-preset').length, 0);
});

test('teardown takes the lab down and lets go of every listener', () => {
    const into = host();
    into.createDiv('someone-elses-box');
    const { teardown } = mountLab(labFixture(), into);

    const input = into.byClass('sf-lab-range')[0];
    const preset = into.byClass('sf-lab-preset')[0];
    const reset = into.byClass('sf-lab-reset')[0];
    assert.equal(input.listenerCount('input'), 1, 'one handler while it is mounted');
    assert.equal(preset.listenerCount('click'), 1);
    assert.equal(reset.listenerCount('click'), 1);

    teardown();
    assert.equal(input.listenerCount('input'), 0);
    assert.equal(preset.listenerCount('click'), 0);
    assert.equal(reset.listenerCount('click'), 0);
    assert.equal(into.byClass('sf-lab').length, 0);
    assert.equal(into.children.length, 1, 'only what was there before is left');
    assert.equal(into.byClass('someone-elses-box').length, 1);

    // The detached controls are inert: nothing reacts to them any more.
    input.value = '130';
    input.dispatch('input');
    preset.click();
    assert.equal(into.byClass('sf-lab').length, 0);
});

// ------------------------------------------------------- the stylesheet's part

test('every class the lab renders has a rule in its stylesheet', () => {
    const source = read('ui/study-visual-lab.ts');
    const css = read(CSS_PATH);
    const tokens = new Set([...source.replace(/--sf-[a-z0-9-]+/g, ' ').matchAll(/sf-[a-z0-9-]+/g)].map(match => match[0]));

    const missing = [...tokens].filter(token => !css.includes(`.${token}`));
    assert.deepEqual(missing, [], `rendered but unstyled: ${missing.join(', ')}`);
    assert.ok(tokens.size >= 18, `expected to find the lab's classes, found ${tokens.size}`);

    // The state the lab puts a row into is a rule too.
    assert.ok(css.includes('.is-unknown'), 'no rule for is-unknown');
    assert.match(ruleBody(css, '.sf-lab-output.is-unknown'), /border-style/);
});

test('the lab’s stylesheet sizes text from the house scale and clips nothing in silence', () => {
    const css = read(CSS_PATH);
    const sized = [...css.matchAll(/font-size:\s*([^;{}]+)/g)].map(match => match[1].trim());
    assert.ok(sized.length > 0, 'the stylesheet sizes text');
    assert.deepEqual(sized.filter(value => /\d(\.\d+)?(px|rem|pt)/.test(value)), [], 'every size comes from a --sf-font-* token');

    // A control the reader drives takes the width it is given.
    assert.match(ruleBody(css, '.sf-lab-range'), /width:\s*100%/);
    assert.match(ruleBody(css, '.sf-lab'), /min-width:\s*0/, 'the lab may be squeezed to its host');
});

test('the lab sets data the way the house sets it, never an inline style', () => {
    const source = read('ui/study-visual-lab.ts');
    assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(source), 'no inline style assignments');
    // A *call* to a dynamic evaluator is what is refused; the evaluator's own
    // documentation is allowed to name one.
    assert.ok(!/eval\s*\(|new\s+Function\s*\(/.test(source), 'no dynamic evaluation anywhere near the lab');
    assert.ok(!/eval\s*\(|new\s+Function\s*\(/.test(read('utils/expr.ts')), 'the evaluator parses rather than evaluates');
    assert.equal(evaluateExpression('2 + 2'), 4, 'and it still computes');
});

// ------------------------------------------------------- the drawings' arithmetic

test('a drawing’s scale is the asset’s own, else its band padded, else 0–100', () => {
    assert.deepEqual(outputScale({ id: 'a', label: 'A', expression: 'x', scaleMin: 0, scaleMax: 200 }), [0, 200]);
    assert.deepEqual(outputScale({ id: 'b', label: 'B', expression: 'x', scaleMin: 20, scaleMax: 40 }), [20, 40]);
    // One declared end pairs with the default other end rather than being ignored.
    assert.deepEqual(outputScale({ id: 'c', label: 'C', expression: 'x', scaleMax: 10 }), [0, 10]);
    assert.deepEqual(outputScale({ id: 'd', label: 'D', expression: 'x', scaleMin: 5 }), [5, 100]);
    // No scale: the band, with half a band-width of room either side.
    assert.deepEqual(outputScale({ id: 'e', label: 'E', expression: 'x', band: [40, 60] }), [30, 70]);
    // Neither: a plain hundred.
    assert.deepEqual(outputScale({ id: 'f', label: 'F', expression: 'x' }), [0, 100]);
    // A scale with no width, or declared the wrong way round, still draws.
    assert.deepEqual(outputScale({ id: 'g', label: 'G', expression: 'x', scaleMin: 50, scaleMax: 50 }), [49, 51]);
    assert.deepEqual(outputScale({ id: 'h', label: 'H', expression: 'x', scaleMin: 200, scaleMax: 0 }), [0, 200]);
});

test('the percentages and angles a drawing is made of are clamped to its scale', () => {
    assert.equal(percentAcross(40, 0, 200), 20, 'a fifth of the track is a fifth of the way across');
    assert.equal(percentAcross(0, 0, 200), 0);
    assert.equal(percentAcross(200, 0, 200), 100);
    assert.equal(percentAcross(300, 0, 200), 100, 'past the end of the scale is the end of the track');
    assert.equal(percentAcross(-30, 0, 200), 0, 'and below it is the other end');
    assert.equal(percentAcross(5, 10, 10), 0, 'a scale with no width is not a division by zero');

    assert.deepEqual(bandRange([50, 150], 0, 200), { start: 25, width: 50 });
    assert.deepEqual(bandRange([-50, 250], 0, 200), { start: 0, width: 100 }, 'a band wider than the scale fills it');
    assert.deepEqual(bandRange([250, 350], 0, 200), { start: 100, width: 0 }, 'a band past the end is an empty region, never a negative one');

    assert.equal(gaugeAngle(0, 0, 200), -90, 'the low end is the start of the sweep');
    assert.equal(gaugeAngle(100, 0, 200), 0, 'halfway is straight up');
    assert.equal(gaugeAngle(200, 0, 200), 90);
    assert.equal(gaugeAngle(999, 0, 200), 90, 'past the end is the end of the sweep');
    assert.equal(gaugeAngle(-5, 0, 200), GAUGE_MIN_ANGLE);

    assert.equal(valueInBand(50, [50, 150]), true, 'the band includes its own edges');
    assert.equal(valueInBand(150, [50, 150]), true);
    assert.equal(valueInBand(151, [50, 150]), false);
    assert.equal(valueInBand(49, [50, 150]), false);
});

// ---------------------------------------------------------------- the drawings

test('every answer is drawn, and only an answer that is words is printed', () => {
    const { into } = mountLab(drawnLabFixture());
    const rows = into.byClass('sf-lab-output');
    assert.equal(rows.length, 3);
    assert.equal(into.byClass('sf-lab-bar').length, 1, 'the bar answer gets a track');
    assert.equal(into.byClass('sf-lab-bar-fill').length, 1);
    assert.equal(into.byClass('sf-lab-gauge-svg').length, 1, 'the gauge answer gets an arc');
    assert.deepEqual(rows.map(row => row.attrs['data-render']), ['bar', 'gauge', 'value']);

    // The number stays on a drawn answer: it is the drawing's caption.
    assert.equal(rows[0].textOf('sf-lab-output-value'), '40 units');
    assert.equal(rows[1].textOf('sf-lab-output-value'), '0.2');

    // A printed answer draws nothing, and has no drawing to carry a verdict.
    const words = rows[2];
    assert.equal(words.byClass('sf-lab-draw').length, 0, 'a printed answer draws no bar');
    assert.equal(words.textOf('sf-lab-output-value'), '0.4', 'it prints the answer');
    assert.equal(words.byClass('sf-lab-verdict').length, 0, 'and there is no drawing to say where it sits');

    // The gauge carries the scale's own ends, so the needle has something to mean.
    assert.deepEqual(into.byClass('sf-lab-gauge-min').map(el => el.textContent), ['0']);
    assert.deepEqual(into.byClass('sf-lab-gauge-max').map(el => el.textContent), ['1']);
});

test('the bar’s fill sits at the value’s own place in the scale, and moves with the control', () => {
    const { into } = mountLab(drawnLabFixture());
    const fill = (): MiniElement => {
        const found = into.byClass('sf-lab-bar-fill');
        assert.equal(found.length, 1, 'the bar has a fill');
        return found[0];
    };
    // 40 of a 0–200 scale is a fifth of the track.
    assert.equal(fill().style['--sf-lab-fill'], '20%');

    const input = into.byClass('sf-lab-range')[0];
    input.value = '100';
    input.dispatch('input');
    assert.equal(fill().style['--sf-lab-fill'], '50%', 'the fill follows the control');

    input.value = '200';
    input.dispatch('input');
    assert.equal(fill().style['--sf-lab-fill'], '100%', 'and stops at the end of the track');

    input.value = '0';
    input.dispatch('input');
    assert.equal(fill().style['--sf-lab-fill'], '0%');
});

test('the band is drawn where the asset put it, as the region the value is judged against', () => {
    const { into } = mountLab(drawnLabFixture());
    const band = into.byClass('sf-lab-bar-band');
    assert.equal(band.length, 1, 'a band was declared, so a band is drawn');
    // 50–150 on a 0–200 scale: a quarter in, half the track wide.
    assert.equal(band[0].style['--sf-lab-band-start'], '25%');
    assert.equal(band[0].style['--sf-lab-band-width'], '50%');

    // A lab with no band declared gets no band drawn.
    const plain = mountLab({
        kind: 'lab',
        title: 'No band',
        teach: '',
        params: [{ id: 'x', label: 'X', min: 0, max: 10, value: 5 }],
        outputs: [{ id: 'y', label: 'Y', expression: 'x' }],
    });
    assert.equal(plain.into.byClass('sf-lab-bar').length, 1, 'the answer is still drawn');
    assert.equal(plain.into.byClass('sf-lab-bar-band').length, 0, 'but no band is invented');
    assert.equal(plain.into.byClass('sf-lab-verdict').length, 0, 'and there is no verdict to give');
});

test('inside the band the drawing says the band’s own word; outside it switches tone', () => {
    const { into } = mountLab(drawnLabFixture());
    const tuned = into.byClass('sf-lab-output')[0];
    const input = into.byClass('sf-lab-range')[0];

    assert.equal(tuned.hasClass('is-out-of-band'), true, '40 is below the 50–150 window');
    assert.equal(tuned.hasClass('is-in-band'), false);
    assert.equal(tuned.textOf('sf-lab-verdict'), 'Outside the window');

    input.value = '100';
    input.dispatch('input');
    assert.equal(tuned.hasClass('is-in-band'), true);
    assert.equal(tuned.hasClass('is-out-of-band'), false, 'one tone at a time');
    assert.equal(tuned.textOf('sf-lab-verdict'), 'In the therapeutic window');

    input.value = '180';
    input.dispatch('input');
    assert.equal(tuned.hasClass('is-out-of-band'), true, 'above the window is out of it too');
    assert.equal(tuned.textOf('sf-lab-verdict'), 'Outside the window');

    // The gauge carries its own band's words, and answers on its own scale.
    const gauge = into.byClass('sf-lab-output')[1];
    assert.equal(gauge.hasClass('is-out-of-band'), true, '180 of 200 is past the steady band');
    assert.equal(gauge.textOf('sf-lab-verdict'), 'Off steady');
    input.value = '100';
    input.dispatch('input');
    assert.equal(gauge.hasClass('is-in-band'), true);
    assert.equal(gauge.textOf('sf-lab-verdict'), 'Steady');
});

// -------------------------------------------------------------- the mission

test('a lab with bands is a mission: the reader is scored, and can solve it', () => {
    const lab = drawnLabFixture();
    const { into } = mountLab(lab);
    const score = (): string => into.textOf('sf-lab-mission-score');
    const root = (): MiniElement => into.byClass('sf-lab')[0];

    // The goal is derived when the asset gave none: every drawn answer home.
    assert.equal(into.textOf('sf-lab-mission-text'), 'Bring every reading into its band.');
    assert.equal(score(), '0 of 2 in range', 'the two drawn readings carry bands; the printed one is not a target');
    assert.equal(root().hasClass('is-solved'), false);

    const input = into.byClass('sf-lab-range')[0];
    input.value = '100';
    input.dispatch('input');
    assert.equal(score(), LAB_SOLVED_TEXT, 'both readings home is the solved line');
    assert.equal(root().hasClass('is-solved'), true, 'both readings home solves the lab');
    assert.equal(into.byClass('sf-lab-mission-score')[0].hasClass('is-solved'), true, 'and the score says so as a state');

    // Success is not a trophy: leaving the band takes it away again.
    input.value = '40';
    input.dispatch('input');
    assert.equal(score(), '0 of 2 in range');
    assert.equal(root().hasClass('is-solved'), false, 'the state is the truth about where the controls are');

    input.value = '100';
    input.dispatch('input');
    assert.equal(score(), LAB_SOLVED_TEXT, 'and the solved line is the one the reader was promised');
    assert.equal(root().hasClass('is-solved'), true);
});

test('a lab with no band has no mission: it is a sandbox, and says nothing about success', () => {
    const { into } = mountLab(labFixture());
    assert.equal(into.byClass('sf-lab-mission').length, 0, 'no bands, no goal to miss');
});

test('the mission uses the asset’s own line when it wrote one', () => {
    const lab: StudyLab = { ...drawnLabFixture(), mission: 'Keep the dose inside the window.' };
    const { into } = mountLab(lab);
    assert.equal(into.textOf('sf-lab-mission-text'), 'Keep the dose inside the window.');
});

test('the mission’s arithmetic and words are pure', () => {
    const lab = drawnLabFixture();
    assert.deepEqual(bandedOutputs(lab.outputs).map(output => output.id), ['effect', 'share'], 'only drawn bands are targets');
    assert.equal(missionText(lab), 'Bring every reading into its band.');
    const one: StudyLab = { ...lab, outputs: [lab.outputs[0]] };
    assert.equal(missionText(one), 'Bring Effect into its band.', 'one target is named');
    assert.equal(missionText({ ...lab, outputs: lab.outputs.filter(output => !output.band) }), null, 'no bands, no mission');

    const effect = lab.outputs[0];
    const share = lab.outputs[1];
    assert.equal(countInBand([{ output: effect, value: 100 }, { output: share, value: 0.5 }]), 2);
    assert.equal(countInBand([{ output: effect, value: 10 }, { output: share, value: null }]), 0, 'an unreadable answer is not a success');
    assert.equal(missionScoreText(2, 2), LAB_SOLVED_TEXT);
    assert.equal(missionScoreText(1, 2), '1 of 2 in range');
    assert.equal(missionScoreText(0, 0), '0 of 0 in range', 'and an empty mission is not accidentally solved');
});

test('a gauge draws an arc across the scale and a needle that swings to the value', () => {
    const { into } = mountLab(drawnLabFixture());
    const needle = (): MiniElement => {
        const found = into.byClass('sf-lab-gauge-needle');
        assert.equal(found.length, 1);
        return found[0];
    };
    // The track is the whole arc: left end, over the top, right end.
    assert.equal(into.byClass('sf-lab-gauge-track')[0].attrs.d, 'M 24 120 A 96 96 0 0 1 216 120');
    // The band 0.25–0.75 of the scale is the middle half of that arc.
    assert.equal(into.byClass('sf-lab-gauge-band')[0].attrs.d, 'M 52.12 52.12 A 96 96 0 0 1 187.88 52.12');

    // 40 of 0–200 is a fifth: −90° + 36°.
    assert.equal(needle().style['--sf-lab-needle-angle'], '-54deg');
    assert.equal(needle().attrs.transform, 'rotate(-54 120 120)', 'the same angle, for a host that does not animate');
    assert.equal(needle().style['--sf-lab-needle-origin'], '120px 120px', 'the pivot the needle turns about');

    const input = into.byClass('sf-lab-range')[0];
    input.value = '100';
    input.dispatch('input');
    assert.equal(needle().style['--sf-lab-needle-angle'], '0deg', 'half the scale is straight up');
    assert.equal(needle().attrs.transform, 'rotate(0 120 120)');

    input.value = '200';
    input.dispatch('input');
    assert.equal(needle().style['--sf-lab-needle-angle'], '90deg');
    assert.equal(needle().attrs.transform, 'rotate(90 120 120)');
});

test('an answer that cannot be computed blanks its drawing instead of holding a stale one', () => {
    const lab: StudyLab = {
        kind: 'lab',
        title: 'Division by the dose',
        teach: '',
        params: [{ id: 'dose', label: 'Dose', unit: 'mg', min: 0, max: 10, value: 5 }],
        outputs: [
            {
                id: 'effect',
                label: 'Effect',
                expression: 'dose / (dose - 1)',
                scaleMin: 0,
                scaleMax: 10,
                band: [0, 3],
                insideLabel: 'Inside',
                outsideLabel: 'Outside',
            },
        ],
    };
    const { into } = mountLab(lab);
    const row = into.byClass('sf-lab-output')[0];
    assert.equal(row.textOf('sf-lab-output-value'), '1.25');
    assert.equal(into.byClass('sf-lab-bar-fill')[0].style['--sf-lab-fill'], '12.5%');

    // The control moves to the one value the expression cannot compute.
    const input = into.byClass('sf-lab-range')[0];
    input.value = '1';
    input.dispatch('input');

    assert.equal(row.hasClass('is-unknown'), true);
    assert.equal(row.textOf('sf-lab-output-value'), LAB_UNKNOWN_TEXT);
    assert.equal(into.byClass('sf-lab-bar-fill')[0].style['--sf-lab-fill'], '0%', 'the drawing is blanked');
    assert.equal(row.hasClass('is-in-band'), false, 'an answer that is not a number is not in any band');
    assert.equal(row.hasClass('is-out-of-band'), false);
    assert.equal(row.byClass('sf-lab-verdict')[0].hasClass('is-hidden'), true, 'and the band has nothing to say');
});

test('a preset moves the drawings, not only the numbers', () => {
    const lab = drawnLabFixture();
    const { into } = mountLab(lab);
    const fill = (): MiniElement => into.byClass('sf-lab-bar-fill')[0];
    const needle = (): MiniElement => into.byClass('sf-lab-gauge-needle')[0];
    assert.equal(fill().style['--sf-lab-fill'], '20%');
    assert.equal(needle().style['--sf-lab-needle-angle'], '-54deg');

    const presets = into.byClass('sf-lab-preset');
    assert.deepEqual(presets.map(preset => preset.textContent), ['Full dose', 'Half dose']);

    presets[0].click();
    assert.equal(fill().style['--sf-lab-fill'], '100%', 'the preset moves the drawing too');
    assert.equal(needle().style['--sf-lab-needle-angle'], '90deg');
    assert.equal(into.byClass('sf-lab-output')[0].textOf('sf-lab-verdict'), 'Outside the window', 'and its verdict follows');

    presets[1].click();
    assert.equal(fill().style['--sf-lab-fill'], '50%');
    assert.equal(needle().style['--sf-lab-needle-angle'], '0deg');

    // Reset hands the drawings back their starting state as well.
    into.byClass('sf-lab-reset')[0].click();
    assert.equal(fill().style['--sf-lab-fill'], '20%');
    assert.equal(needle().style['--sf-lab-needle-angle'], '-54deg');
    assert.equal(into.byClass('sf-lab-range')[0].value, '40');
});

test('the drawings move only where the host allows motion, and never at the reader’s expense', () => {
    const globals = globalThis as Record<string, unknown>;
    const previous = globals.matchMedia;
    try {
        // No matchMedia at all: a plain no, and no throw on the way there.
        delete globals.matchMedia;
        assert.equal(motionAllowed(), false, 'a host with no matchMedia never animates');
        assert.equal(mountLab(drawnLabFixture()).into.byClass('sf-lab')[0].hasClass('is-motion'), false);

        // Reduced motion: the drawings are there, they just do not travel.
        globals.matchMedia = ((query: string) => ({ matches: query.includes('reduced-motion'), media: query })) as unknown;
        assert.equal(motionAllowed(), false);
        assert.equal(mountLab(drawnLabFixture()).into.byClass('sf-lab')[0].hasClass('is-motion'), false);

        // Motion allowed: the class that starts the movement is added, and
        // moving a control still recomputes everything it recomputed before.
        globals.matchMedia = (() => ({ matches: false })) as unknown;
        assert.equal(motionAllowed(), true);
        const moving = mountLab(drawnLabFixture());
        assert.equal(moving.into.byClass('sf-lab')[0].hasClass('is-motion'), true);
        const input = moving.into.byClass('sf-lab-range')[0];
        input.value = '100';
        input.dispatch('input');
        assert.equal(moving.into.byClass('sf-lab-bar-fill')[0].style['--sf-lab-fill'], '50%');
    } finally {
        if (previous === undefined) delete globals.matchMedia;
        else globals.matchMedia = previous;
    }
});

test('the drawings are driven by the custom properties the code sets, and the stylesheet reads them', () => {
    const css = read(CSS_PATH);
    assert.match(ruleBody(css, '.sf-lab-bar-fill'), /width:\s*var\(--sf-lab-fill/);
    assert.match(ruleBody(css, '.sf-lab-bar-band'), /left:\s*var\(--sf-lab-band-start/);
    assert.match(ruleBody(css, '.sf-lab-bar-band'), /width:\s*var\(--sf-lab-band-width/);
    const needle = ruleBody(css, '.sf-lab-gauge-needle');
    assert.match(needle, /transform-origin:\s*var\(--sf-lab-needle-origin/);
    assert.match(needle, /transform:\s*rotate\(var\(--sf-lab-needle-angle/);

    const source = read('ui/study-visual-lab.ts');
    assert.match(source, /setCssProps\(\{ '--sf-lab-fill'/, 'the fill is placed through a custom property');
    assert.match(source, /'--sf-lab-band-start'/);
    assert.match(source, /'--sf-lab-needle-angle'/);
});

test('the lab animates only where the host allows motion, and says which state it is in', () => {
    const css = read(CSS_PATH);
    for (const state of ['is-in-band', 'is-out-of-band', 'is-motion', 'is-hidden']) {
        assert.ok(css.includes(`.${state}`), `no rule for ${state}`);
    }
    assert.match(ruleBody(css, '.sf-lab.is-motion .sf-lab-bar-fill'), /transition:\s*width/);
    assert.match(ruleBody(css, '.sf-lab.is-motion .sf-lab-gauge-needle'), /transition:\s*transform/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'and the setting can change while the lab is open');
    // An answer out of band changes the drawing, not just the badge beside it.
    assert.match(ruleBody(css, '.sf-lab-output.is-out-of-band .sf-lab-bar-fill'), /background:\s*var\(--sf-warning/);
});
