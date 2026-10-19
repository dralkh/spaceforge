/**
 * Is this CLI on the machine, and is it signed in? The plugin never stores a
 * credential and never runs a login: it reports what the CLI says about itself
 * and points at the command that fixes it.
 *
 * The binary is resolved from disk *before* anything is spawned. That ordering
 * is the fix for the complaint this file kept getting: a CLI that works in the
 * reader's terminal looked missing here, because a desktop app inherits a
 * minimal PATH and every version manager (nvm, fnm, mise, asdf, n) and every
 * npm/bun/pnpm global bin lives outside it. `cli-binary.ts` searches the real
 * install locations; this file reports what it found, including the path, so
 * "not detected" and "not installed" stop meaning the same thing.
 */
import { CliAgentDef, isAuthFailureText } from './cli-types';
import { getCliAgent } from './cli-agents';
import { clearCliPathCaches, isCliExecAvailable, runCliCapture } from './cli-runner';
import { findCliBinary, searchedLocationsNote } from './cli-binary';

export interface CliDetectionResult {
    id: string;
    name: string;
    installed: boolean;
    authenticated: boolean;
    version?: string;
    /** Absolute path of the binary that will be run, when one was found. */
    resolvedPath?: string;
    /** Human-readable state, and what to do about it. */
    message: string;
    /** 'ok' when ready to use, 'warn' when the user must act, 'error' when broken. */
    level: 'ok' | 'warn' | 'error';
}

/** Tests point the search at a temporary home with the binaries they want found. */
export interface CliDetectionOptions {
    home?: string;
    extra?: string;
}

function looksLikeNotFound(text: string): boolean {
    return /command not found|not found|no such file|is not recognized|ENOENT/i.test(text);
}

function notFound(agent: CliAgentDef, resolved: string | null): CliDetectionResult {
    return {
        id: agent.id,
        name: agent.name,
        installed: false,
        authenticated: false,
        level: 'warn',
        // Say where we looked: "not installed" and "installed somewhere I did not
        // look" are different problems with different fixes.
        message:
            `${agent.notFoundGuidance} Searched ${searchedLocationsNote()} for \`${agent.bin}\`` +
            `${resolved ? ` (found ${resolved}, but it would not run)` : ''}. ` +
            'If it lives somewhere else, put that folder in “Local CLI extra path”.',
    };
}

export async function detectCliAgent(
    id: string | undefined,
    options: CliDetectionOptions = {}
): Promise<CliDetectionResult> {
    const agent = getCliAgent(id);
    if (!agent) {
        return {
            id: id ?? '',
            name: id ?? 'unknown',
            installed: false,
            authenticated: false,
            level: 'error',
            message: `Unknown local CLI: ${id ?? '(none chosen)'}`,
        };
    }

    if (!isCliExecAvailable()) {
        return {
            id: agent.id,
            name: agent.name,
            installed: false,
            authenticated: false,
            level: 'error',
            message: 'This build of Obsidian cannot launch local processes, so CLI providers cannot run here.',
        };
    }

    // A CLI installed a minute ago has to be found now, so the search results are
    // dropped on every detection rather than ageing out on their own.
    clearCliPathCaches();
    const search = { home: options.home, extra: options.extra };
    const resolved = findCliBinary(agent.bin, search);

    const probe = await runCliCapture(agent.bin, agent.versionArgs, 12_000, { search });
    const combined = `${probe.stdout}\n${probe.stderr}`;
    if (probe.notFound || looksLikeNotFound(combined)) {
        return notFound(agent, resolved);
    }
    if (probe.exitCode !== 0 && !probe.stdout.trim() && !probe.stderr.trim()) {
        return notFound(agent, resolved);
    }
    const version = (probe.stdout || probe.stderr || '').split('\n')[0]?.trim() || undefined;
    const where = resolved ? ` at ${resolved}` : '';

    if (agent.authProbe) {
        const status = await runCliCapture(agent.bin, agent.authProbe.args, 12_000, { search });
        const statusText = `${status.stdout}\n${status.stderr}`;
        const signedIn = status.exitCode === 0
            && !isAuthFailureText(agent, statusText)
            && (!agent.authProbe.requireOutput || statusText.trim().length > 0);
        if (!signedIn) {
            return {
                id: agent.id,
                name: agent.name,
                installed: true,
                authenticated: false,
                version,
                resolvedPath: resolved ?? undefined,
                level: 'warn',
                message: `${agent.name} is installed${where}${version ? ` (${version})` : ''}, but not signed in. ${agent.loginGuidance}`,
            };
        }
    }

    return {
        id: agent.id,
        name: agent.name,
        installed: true,
        authenticated: true,
        version,
        resolvedPath: resolved ?? undefined,
        level: 'ok',
        message: agent.authProbe
            ? `Signed in via ${agent.name}${version ? ` (${version})` : ''}${where}.`
            : `${agent.name} detected${version ? ` (${version})` : ''}${where}. It brings its own login; if a task fails with an auth error, run \`${agent.loginCommand}\`.`,
    };
}
