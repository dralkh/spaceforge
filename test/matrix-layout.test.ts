import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A matrix's first column is a name; it must not be allowed to collapse.
 *
 * The bug: `.sf-vb-th-label { width: 1% }` under `table-layout: auto` let the browser
 * shrink that column to its minimum content width, and `overflow-wrap: anywhere` on
 * the cell made that minimum one character. "Acute pericarditis" rendered as a column
 * of letters 25 px wide, and every row in the table grew to 336 px tall.
 *
 * The fix is a fixed layout with a real width for the name column, and a minimum table
 * width so a narrow pane scrolls instead of squeezing. This test reads the source
 * stylesheet, so a rebuild cannot quietly reintroduce it.
 */

const css = fs.readFileSync(path.join(process.cwd(), 'styles', 'study-visual-board.css'), 'utf8');

const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `styles/study-visual-board.css has no ${selector} rule`);
    const end = css.indexOf('}', start);
    return css.slice(start, end);
};

test('the matrix table lays its columns out from the header, not from its text', () => {
    const table = rule('.sf-vb-table');
    assert.match(table, /table-layout:\s*fixed/, 'auto layout shrinks the name column to one character');
    assert.match(table, /min-width:\s*\d+px/, 'a narrow pane should scroll sideways, not stack letters');
});

test('the name column is wide enough for a name', () => {
    const corner = rule('.sf-vb-th-label');
    const width = corner.match(/width:\s*(\d+(?:\.\d+)?)%/);
    assert.ok(width, `the corner cell should carry a percentage width, got: ${corner.trim()}`);
    assert.ok(Number(width[1]) >= 15, `a ${width[1]}% name column is too narrow to read`);
});

test('the name column wraps words, not letters', () => {
    const label = rule('.sf-vb-row-label');
    assert.equal(/overflow-wrap:\s*anywhere/.test(label), false, '`anywhere` is what allowed a 25 px column');
    assert.match(label, /overflow-wrap:\s*break-word/);
});
