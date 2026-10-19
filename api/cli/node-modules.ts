import { Platform } from 'obsidian';

/**
 * The Node.js side of the desktop app, reached without a static import.
 *
 * A plugin bundle is one file for desktop and mobile, and a top-level
 * `import 'fs'` makes the whole bundle unloadable where Node does not exist.
 * These helpers load the built-ins only on desktop, and only when something
 * actually asks for one, so the mobile build stays free of Node entirely.
 *
 * Nothing here depends on Node's global types or on the bare `process`
 * binding: `window.process` (and `window.require('process')` when only the
 * loader is exposed) are read structurally, so the module type-checks the same
 * whether or not the host's declaration files are around.
 */

export interface NodeProcessLike {
    env?: Record<string, string | undefined>;
    platform?: string;
    getBuiltinModule?: (id: string) => unknown;
}

type NodeRequire = (id: string) => unknown;

interface DesktopWindow {
    process?: NodeProcessLike;
    require?: NodeRequire;
}

function desktopWindow(): DesktopWindow | null {
    return typeof window !== 'undefined' ? window : null;
}

let cachedProcess: NodeProcessLike | null | undefined;

/** The desktop process object, or null where the host has none. */
export function nodeProcess(): NodeProcessLike | null {
    if (cachedProcess !== undefined) return cachedProcess;
    const win = desktopWindow();
    if (!win) {
        cachedProcess = null;
        return cachedProcess;
    }
    if (win.process) {
        cachedProcess = win.process;
        return cachedProcess;
    }
    const requireModule = win.require;
    if (typeof requireModule === 'function') {
        try {
            cachedProcess = requireModule('process') as NodeProcessLike;
        } catch {
            cachedProcess = null;
        }
    } else {
        cachedProcess = null;
    }
    return cachedProcess;
}

let cachedRequire: NodeRequire | null | undefined;

function desktopRequire(): NodeRequire | null {
    if (cachedRequire !== undefined) return cachedRequire;
    if (!Platform.isDesktop) {
        cachedRequire = null;
        return cachedRequire;
    }
    const proc = nodeProcess();
    if (proc?.getBuiltinModule) {
        cachedRequire = id => proc.getBuiltinModule?.(id);
        return cachedRequire;
    }
    // Electron's renderer still exposes CommonJS `require`; older Obsidian
    // builds need it because their Node predates process.getBuiltinModule().
    const requireModule = desktopWindow()?.require;
    cachedRequire = typeof requireModule === 'function' ? id => requireModule(id) : null;
    return cachedRequire;
}

/** A Node built-in module, or null on mobile or when it is not available. */
export function loadNodeModule<T>(id: string): T | null {
    const requireModule = desktopRequire();
    if (!requireModule) return null;
    try {
        return requireModule(id) as T;
    } catch {
        return null;
    }
}
