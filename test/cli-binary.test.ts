/**
 * Finding a CLI where the shell's PATH cannot see it.
 *
 * The complaint this answers: every CLI was installed and working in the
 * reader's terminal, and detection still said none of them were there. The
 * cause is that a desktop app inherits a minimal PATH, and the normal install
 * locations for these tools — npm/bun/pnpm globals, and every version manager
 * (nvm, fnm, mise, asdf, n) — live outside it. These tests build a fake home on
 * disk, put real executable files in it, and ask the search to find them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearCliBinaryCache, cliPathDirs, findCliBinary, searchedLocationsNote } from '../api/cli/cli-binary';
import { detectCliAgent } from '../api/cli/cli-detection';

/** A home directory with executable files where a version manager would put them. */
function fakeHome(files: Array<{ dir: string; name: string; body: string }>): string {
    const home = mkdtempSync(join(tmpdir(), 'sf-cli-home-'));
    for (const file of files) {
        const dir = join(home, ...file.dir.split('/'));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, file.name);
        writeFileSync(path, file.body, { mode: 0o755 });
        chmodSync(path, 0o755);
    }
    return home;
}

const homes: string[] = [];
function withHome(files: Array<{ dir: string; name: string; body: string }>): string {
    const home = fakeHome(files);
    homes.push(home);
    return home;
}

test.after(() => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test('a CLI inside a version-manager bin is found, newest version first', () => {
    const home = withHome([
        { dir: '.nvm/versions/node/v20.0.0/bin', name: 'codex', body: '#!/bin/sh\necho old\n' },
        { dir: '.nvm/versions/node/v22.22.2/bin', name: 'codex', body: '#!/bin/sh\necho new\n' },
    ]);
    clearCliBinaryCache();

    const found = findCliBinary('codex', { home });
    assert.equal(found, join(home, '.nvm/versions/node/v22.22.2/bin/codex'), 'the newest install wins');
});

test('the agent CLIs an npm or bun global install leaves behind are found', () => {
    const home = withHome([
        { dir: '.local/bin', name: 'claude', body: '#!/bin/sh\n' },
        { dir: '.bun/bin', name: 'gemini', body: '#!/bin/sh\n' },
        { dir: '.local/share/mise/installs/node/24.1.0/bin', name: 'openclaw', body: '#!/bin/sh\n' },
        { dir: '.asdf/installs/nodejs/20.11.0/bin', name: 'codex', body: '#!/bin/sh\n' },
        { dir: 'bin', name: 'antigravity', body: '#!/bin/sh\n' },
    ]);
    clearCliBinaryCache();

    for (const [bin, expected] of [
        ['claude', '.local/bin/claude'],
        ['gemini', '.bun/bin/gemini'],
        ['openclaw', '.local/share/mise/installs/node/24.1.0/bin/openclaw'],
        ['codex', '.asdf/installs/nodejs/20.11.0/bin/codex'],
        ['antigravity', 'bin/antigravity'],
    ] as Array<[string, string]>) {
        assert.equal(findCliBinary(bin, { home }), join(home, ...expected.split('/')), bin);
    }
});

test('an unreadable or non-executable file is not a CLI', () => {
    const home = withHome([{ dir: '.local/bin', name: 'notexec', body: 'plain text\n' }]);
    // writeFileSync with mode + chmod above makes it executable; strip it again.
    chmodSync(join(home, '.local/bin/notexec'), 0o644);
    clearCliBinaryCache();

    assert.equal(findCliBinary('notexec', { home }), null, 'not executable, not a CLI');
    assert.equal(findCliBinary('absent', { home }), null);
});

test('the reader’s own extra path is searched before anything else', () => {
    const home = withHome([
        { dir: 'elsewhere/bin', name: 'mycli', body: '#!/bin/sh\n' },
        { dir: '.local/bin', name: 'mycli', body: '#!/bin/sh\n' },
    ]);
    clearCliBinaryCache();

    assert.equal(findCliBinary('mycli', { home }), join(home, '.local/bin/mycli'), 'the usual place, by default');
    clearCliBinaryCache();
    assert.equal(
        findCliBinary('mycli', { home, extra: `${join(home, 'elsewhere/bin')}:` }),
        join(home, 'elsewhere/bin/mycli'),
        'and their own folder when they name one',
    );
});

test('an absolute path is taken as given', () => {
    const home = withHome([{ dir: 'tools', name: 'agent', body: '#!/bin/sh\n' }]);
    const path = join(home, 'tools/agent');
    assert.equal(findCliBinary(path, { home }), path, 'a path is checked, not searched for');
    assert.equal(findCliBinary(join(home, 'tools/absent'), { home }), null);
});

test('the search says where it looked, so "not installed" is not the only answer', () => {
    assert.match(searchedLocationsNote(), /homebrew/);
    assert.match(searchedLocationsNote(), /nvm\/fnm\/mise\/asdf/);
});

test('detection finds a CLI in a version-manager bin and reports its path', async () => {
    // A real executable that answers like codex does: a version on stdout.
    const home = withHome([
        {
            dir: '.nvm/versions/node/v22.22.2/bin',
            name: 'codex',
            body: '#!/bin/sh\necho "codex-cli 0.159.1"\n',
        },
    ]);
    clearCliBinaryCache();

    const result = await detectCliAgent('codex', { home });
    assert.equal(result.installed, true, 'installed, though PATH would never have found it');
    assert.equal(result.resolvedPath, join(home, '.nvm/versions/node/v22.22.2/bin/codex'));
    assert.equal(result.version, 'codex-cli 0.159.1');
    assert.match(result.message, /at .*codex/, 'the message names the binary it will run');
});

test('a CLI that is nowhere is reported as missing, with where we looked', async () => {
    const home = withHome([]);
    clearCliBinaryCache();

    // The search also reads this process's PATH; the machine running the tests is not part of
    // what this case is about (a developer's own install must not decide the answer).
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
        const result = await detectCliAgent('gemini', { home });
        assert.equal(result.installed, false);
        assert.equal(result.resolvedPath, undefined);
        assert.match(result.message, /Searched .* for `gemini`/, 'it says what was searched');
        assert.match(result.message, /Local CLI extra path/, 'and how to point at an unusual install');
    } finally {
        process.env.PATH = savedPath;
        clearCliBinaryCache();
    }
});

test('a CLI that exists but will not run is reported, not silently called missing', async () => {
    // Executable, but exits 127 with nothing on either stream: present on disk
    // while behaving like a broken install.
    const home = withHome([
        { dir: '.local/bin', name: 'claude', body: '#!/bin/sh\nexit 127\n' },
    ]);
    clearCliBinaryCache();

    const result = await detectCliAgent('claude', { home });
    assert.equal(result.installed, false);
    assert.match(result.message, /found .*claude.*would not run/, 'the path is reported even so');
});

test('the search prefers a deliberate install, then the newest version manager', () => {
    const home = withHome([
        { dir: '.nvm/versions/node/v22.22.2/bin', name: 'x', body: '#!/bin/sh\n' },
        { dir: '.nvm/versions/node/v20.0.0/bin', name: 'x', body: '#!/bin/sh\n' },
    ]);
    clearCliBinaryCache();

    const dirs = cliPathDirs({ home });
    const nvm22 = dirs.indexOf(join(home, '.nvm/versions/node/v22.22.2/bin'));
    const nvm20 = dirs.indexOf(join(home, '.nvm/versions/node/v20.0.0/bin'));
    const local = dirs.indexOf(join(home, '.local/bin'));
    assert.ok(nvm22 >= 0 && nvm20 >= 0, 'both versions are searched');
    assert.ok(nvm22 < nvm20, 'newest version first');
    // A CLI kept in ~/.local/bin is usually the newer, deliberately-updated copy;
    // the version-manager bins are the fallback this search exists to add.
    assert.ok(local < nvm22, 'the home bin the reader manages comes first');
});

test('the same CLI in both a managed bin and a version manager resolves to the managed one', () => {
    // The case that showed this up: `claude` in ~/.local/bin was 2.1.217 while an
    // older 2.1.91 copy sat in an nvm bin. Picking the version manager's copy
    // would quietly hand the reader a stale CLI.
    const home = withHome([
        { dir: '.local/bin', name: 'claude', body: '#!/bin/sh\necho newer\n' },
        { dir: '.nvm/versions/node/v22.11.0/bin', name: 'claude', body: '#!/bin/sh\necho older\n' },
    ]);
    clearCliBinaryCache();

    assert.equal(findCliBinary('claude', { home }), join(home, '.local/bin/claude'));
});
