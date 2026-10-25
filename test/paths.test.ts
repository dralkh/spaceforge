/**
 * `utils/paths.ts` — the separator question, which only has a wrong answer on a
 * machine this test is not running on, so the Windows case is spelled out here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { absolutePath, pathSeparator } from '../utils/paths';

test('a POSIX root keeps forward slashes', () => {
    assert.equal(pathSeparator('/home/reader/Vault'), '/');
    assert.equal(
        absolutePath('/home/reader/Vault', 'spaceforge/sync/anki/1.apkg'),
        '/home/reader/Vault/spaceforge/sync/anki/1.apkg'
    );
});

test('a Windows root gets backslashes throughout, not a mixture', () => {
    assert.equal(pathSeparator('C:\\Users\\reader\\My Vault'), '\\');
    assert.equal(
        absolutePath('C:\\Users\\reader\\My Vault', 'spaceforge/sync/anki/1.apkg'),
        'C:\\Users\\reader\\My Vault\\spaceforge\\sync\\anki\\1.apkg'
    );
});

test('a trailing separator on the root is not doubled', () => {
    assert.equal(absolutePath('/home/reader/Vault/', 'a/b.apkg'), '/home/reader/Vault/a/b.apkg');
    assert.equal(absolutePath('C:\\Vault\\', 'a/b.apkg'), 'C:\\Vault\\a\\b.apkg');
});

test('a relative path with either separator is accepted', () => {
    assert.equal(absolutePath('/v', 'a\\b/c.apkg'), '/v/a/b/c.apkg');
    assert.equal(absolutePath('C:\\v', 'a\\b/c.apkg'), 'C:\\v\\a\\b\\c.apkg');
});

test('the root alone is returned unchanged', () => {
    assert.equal(absolutePath('/home/reader/Vault', ''), '/home/reader/Vault');
    assert.equal(absolutePath('C:\\Vault', '/'), 'C:\\Vault');
});
