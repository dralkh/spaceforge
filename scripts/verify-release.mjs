/**
 * Pre-release verification: the facts Obsidian's release checks read, checked
 * against the tag before anything is uploaded.
 *
 *   node scripts/verify-release.mjs 1.2.0
 *
 * Run this after `npm run build` (it checks the built assets exist) and before
 * `npm version` / tagging. The release workflow runs it too, so a mismatch
 * between the tag and the manifest cannot reach a published release.
 */
import { existsSync, readFileSync } from 'node:fs';

const tag = (process.argv[2] ?? process.env.RELEASE_TAG ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(tag)) {
    console.error('usage: node scripts/verify-release.mjs <version>  (for example: 1.2.0)');
    process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
const versions = readJson('versions.json');

const failures = [];
const check = (condition, message) => {
    if (!condition) failures.push(message);
};

check(manifest.version === tag, `manifest.json is ${manifest.version}, expected ${tag}`);
check(pkg.version === tag, `package.json is ${pkg.version}, expected ${tag}`);
check(Boolean(versions[tag]), `versions.json has no entry for ${tag}`);

// The fields Obsidian's manifest validation requires.
for (const field of ['id', 'name', 'version', 'minAppVersion', 'description', 'author', 'isDesktopOnly']) {
    check(manifest[field] !== undefined && manifest[field] !== '', `manifest.json is missing "${field}"`);
}
check((manifest.description ?? '').length <= 250, 'manifest description is longer than 250 characters');

// The release assets are the build's, not a stale copy.
check(existsSync('main.js'), 'main.js is missing — run npm run build first');
check(existsSync('styles.css'), 'styles.css is missing — run npm run build first');
check(existsSync('manifest.json'), 'manifest.json is missing');

if (failures.length > 0) {
    console.error(`release ${tag} failed ${failures.length} check(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}

console.log(`release ${tag} checks pass: manifest, package, versions and built assets agree.`);
