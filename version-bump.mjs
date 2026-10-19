import { readFileSync, writeFileSync } from "fs";

// `npm version <x>` sets npm_package_version and runs this script with no
// arguments. The argv form stays for a manual bump (`node version-bump.mjs
// 1.2.0`), and a run with neither fails loudly instead of writing an undefined
// version into the manifest, which is what shipped the release check a broken
// file the last time it was tried that way.
const targetVersion = process.env.npm_package_version || process.argv[2];
const minAppVersion = process.argv[3];
if (!targetVersion || !/^\d+\.\d+\.\d+/.test(targetVersion)) {
    console.error(
        "No target version. Run through `npm version <major|minor|patch|x.y.z>` " +
        "or pass one: `node version-bump.mjs 1.2.0`."
    );
    process.exit(1);
}

// Read minAppVersion from existing manifest.json if not provided
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion: currentMinAppVersion } = manifest;

// Write updated manifest.json
manifest.version = targetVersion;
manifest.minAppVersion = minAppVersion ?? currentMinAppVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// Update versions.json with the new version
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion ?? currentMinAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Updated to version ${targetVersion}`);
