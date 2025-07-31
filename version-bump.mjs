import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.argv[2];
const minAppVersion = process.argv[3];

// Read minAppVersion from existing manifest.json if not provided
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion: currentMinAppVersion } = manifest;

// Write updated manifest.json
manifest.version = targetVersion;
manifest.minAppVersion = minAppVersion ?? currentMinAppVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2));

// Update versions.json with the new version
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion ?? currentMinAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2));

console.log(`Updated to version ${targetVersion}`);
