/**
 * Finding an agent CLI on disk when PATH does not have it.
 *
 * The problem this exists for: a desktop app is launched by the window manager,
 * not by the reader's shell, so it inherits a minimal PATH. Anything installed
 * where an interactive rc would have added it — and that is the normal case for
 * npm/bun/pnpm global bins and for every version manager (nvm, fnm, mise, asdf,
 * n) — is invisible to a plain `which`. A CLI can be installed and working in
 * the reader's terminal and still look absent to the plugin, which is exactly
 * the complaint this answers.
 *
 * So the search does not depend on PATH at all: the usual install locations are
 * read from disk, newest version-manager bins first, and PATH is consulted last
 * (if the reader has already arranged a working PATH, their arrangement should
 * win over our guess). The resolved absolute path is then handed to the spawn,
 * so the run works for the same reason the search did.
 */
import { loadNodeModule, nodeProcess } from './node-modules';

/** The fs surface this file uses, so no Node declaration file is required. */
interface StatLike {
    isFile(): boolean;
    mode: number;
}

interface FsModuleLike {
    existsSync(path: string): boolean;
    readdirSync(path: string): string[];
    statSync(path: string): StatLike;
}

interface OsModuleLike {
    homedir(): string;
}

interface PathModuleLike {
    join(...parts: string[]): string;
}

interface NodeModules {
    fs: FsModuleLike;
    os: OsModuleLike;
    path: PathModuleLike;
}

let cachedNodeModules: NodeModules | null | undefined;

/** fs/os/path on desktop; null on mobile, where a CLI cannot run anyway. */
function nodeModules(): NodeModules | null {
    if (cachedNodeModules !== undefined) return cachedNodeModules;
    const fs = loadNodeModule<FsModuleLike>('fs');
    const os = loadNodeModule<OsModuleLike>('os');
    const path = loadNodeModule<PathModuleLike>('path');
    cachedNodeModules = fs && os && path ? { fs, os, path } : null;
    return cachedNodeModules;
}

/** A home to search, and extra directories to try before anything else. */
export interface CliSearchOptions {
    /** Overridden in tests, and by nothing else. */
    home?: string;
    /** Directories the reader added themselves, colon- or semicolon-separated. */
    extra?: string;
}

const IS_WINDOWS = nodeProcess()?.platform === 'win32';

/** Relative to the home directory: npm/yarn/bun/deno/cargo/pnpm installs and shims. */
const HOME_BIN_DIRS = [
    '.local/bin',
    'bin',
    '.npm-global/bin',
    '.npm-packages/bin',
    '.yarn/bin',
    '.config/yarn/global/node_modules/.bin',
    '.bun/bin',
    '.pnpm/bin',
    '.local/share/pnpm',
    'Library/pnpm',
    '.deno/bin',
    '.volta/bin',
    '.cargo/bin',
    'go/bin',
    '.asdf/shims',
    '.nodenv/shims',
    '.anyenv/envs/nodenv/shims',
    '.local/share/mise/shims',
    'n/bin',
];

/** Absolute locations a desktop launch will never have on PATH. */
const ABSOLUTE_BIN_DIRS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/snap/bin',
];

/**
 * Version managers keep one bin directory per installed version. These are read
 * newest first, because a CLI the reader just installed lands in the newest one.
 */
const VERSION_MANAGER_LAYOUTS: string[][] = [
    ['.nvm', 'versions', 'node'],
    ['.local', 'share', 'fnm', 'node-versions', 'installation'],
    ['Library', 'Application Support', 'fnm', 'node-versions', 'installation'],
    ['n', 'versions', 'node'],
    ['.local', 'share', 'mise', 'installs', 'node'],
    ['.asdf', 'installs', 'nodejs'],
];

function isExecutableFile(path: string): boolean {
    const modules = nodeModules();
    if (!modules) return false;
    try {
        const stat = modules.fs.statSync(path);
        if (!stat.isFile()) return false;
        // Windows has no execute bit: an existing .cmd/.exe is runnable.
        return IS_WINDOWS ? true : (stat.mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

/** Newest first, so a two-part version like 22.22.2 sorts above 22.11.0. */
function compareVersionsDesc(a: string, b: string): number {
    const parse = (value: string): number[] =>
        value
            .replace(/^v/i, '')
            .split(/[.+-]/)
            .map(part => parseInt(part, 10) || 0);
    const left = parse(a);
    const right = parse(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (right[i] || 0) - (left[i] || 0);
        if (diff !== 0) return diff;
    }
    return b.localeCompare(a);
}

function versionManagerBins(home: string): string[] {
    const modules = nodeModules();
    if (!modules) return [];
    const dirs: string[] = [];
    for (const parts of VERSION_MANAGER_LAYOUTS) {
        const root = modules.path.join(home, ...parts);
        if (!modules.fs.existsSync(root)) continue;
        let versions: string[];
        try {
            versions = modules.fs.readdirSync(root)
                .filter(name => /^v?\d/.test(name))
                .sort(compareVersionsDesc);
        } catch {
            continue;
        }
        for (const version of versions) {
            dirs.push(modules.path.join(root, version, 'bin'));
        }
    }
    return dirs;
}

interface CachedDirs {
    at: number;
    key: string;
    dirs: string[];
}

let cached: CachedDirs | null = null;
const CACHE_MS = 30_000;

/**
 * Every directory searched for a CLI, before PATH. The order is the reader's own
 * choice first (their extra path), then the home install locations they manage
 * themselves — `~/.local/bin` and the npm/bun/pnpm globals — and only then the
 * version-manager bins, newest version first, which are the "hidden" places this
 * search exists to cover. A deliberate single install beats a version manager's
 * copy: the same CLI lives in both often enough, and the deliberate one is the
 * one the reader keeps up to date.
 */
export function cliPathDirs(options: CliSearchOptions = {}): string[] {
    const modules = nodeModules();
    if (!modules) return [];
    const home = options.home ?? safeHomeDir();
    const extra = options.extra ?? '';
    const key = `${home}\u0000${extra}`;
    const now = Date.now();
    if (cached && cached.key === key && now - cached.at < CACHE_MS) return cached.dirs;

    const dirs: string[] = [];
    for (const part of extra.split(IS_WINDOWS ? ';' : ':')) {
        const trimmed = part.trim();
        if (trimmed) dirs.push(trimmed.replace(/[/\\]+$/, ''));
    }
    if (home) {
        dirs.push(...HOME_BIN_DIRS.map(relative => modules.path.join(home, ...relative.split('/'))));
        dirs.push(...versionManagerBins(home));
    }
    if (!IS_WINDOWS) dirs.push(...ABSOLUTE_BIN_DIRS);
    if (IS_WINDOWS) {
        const appData = getEnvVar('APPDATA');
        if (appData) dirs.push(modules.path.join(appData, 'npm'));
        const localAppData = getEnvVar('LOCALAPPDATA');
        if (localAppData) dirs.push(modules.path.join(localAppData, 'Programs'));
    }

    const seen = new Set<string>();
    const unique = dirs.filter(dir => {
        if (!dir || seen.has(dir)) return false;
        seen.add(dir);
        return true;
    });
    cached = { at: now, key, dirs: unique };
    return unique;
}

/** Forget the search results, so a just-installed CLI is picked up at once. */
export function clearCliBinaryCache(): void {
    cached = null;
}

function safeHomeDir(): string {
    const modules = nodeModules();
    if (!modules) return '';
    try {
        return modules.os.homedir();
    } catch {
        return '';
    }
}

function getEnvVar(name: string): string | undefined {
    const env = nodeProcess()?.env;
    if (!env) return undefined;
    const value = env[name];
    return value && value.trim() !== '' ? value.trim() : undefined;
}

/** The names a binary can have on this platform, in the order to try them. */
function binaryNames(bin: string): string[] {
    if (!IS_WINDOWS) return [bin];
    // npm installs the shim as .cmd; a packaged tool may be .exe.
    return [`${bin}.cmd`, `${bin}.exe`, `${bin}.bat`, bin];
}

/**
 * The absolute path of a CLI, or null when nothing executable is found. An
 * absolute or relative path is checked as given; a bare name is searched for in
 * the directories above and then on PATH.
 */
export function findCliBinary(bin: string, options: CliSearchOptions = {}): string | null {
    if (!bin) return null;
    if (bin.includes('/') || (IS_WINDOWS && bin.includes('\\'))) {
        return isExecutableFile(bin) ? bin : null;
    }

    const modules = nodeModules();
    if (!modules) return null;
    const names = binaryNames(bin);
    const dirs = [...cliPathDirs(options)];
    const pathValue = getEnvVar('PATH');
    if (pathValue) dirs.push(...pathValue.split(IS_WINDOWS ? ';' : ':'));

    const seen = new Set<string>();
    for (const dir of dirs) {
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        for (const name of names) {
            const candidate = modules.path.join(dir, name);
            if (isExecutableFile(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * Where we looked, said the way a person would say it — used when a CLI is not
 * found, so the reader can tell "not installed" from "installed somewhere I did
 * not think to look".
 */
export function searchedLocationsNote(): string {
    return IS_WINDOWS
        ? 'homebrew, npm/yarn/bun/pnpm, nvm/fnm/mise/asdf and %APPDATA%\\npm'
        : 'homebrew, ~/.local/bin, npm/yarn/bun/pnpm, nvm/fnm/mise/asdf/n';
}
