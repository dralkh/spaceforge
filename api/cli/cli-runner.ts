import { CliAgentDef, CliInvokeOptions, CliParseResult, isAuthFailureText } from './cli-types';
import { clearCliBinaryCache, CliSearchOptions, cliPathDirs, findCliBinary } from './cli-binary';

/**
 * Spawning agent CLIs from inside Obsidian.
 *
 * Two things make this work in a plugin rather than a terminal: the PATH a GUI
 * app inherits is usually not the one the user's shell has (so the login shell
 * is asked once and its PATH is remembered), and a headless spawn has no one to
 * answer a prompt (so every turn is built to run to completion on its own).
 *
 * Node is only present on desktop builds, so nothing here assumes it: the
 * availability check gates every entry point and the UI says so plainly.
 */

interface ChildProcessHandle {
    stdout: { on(event: 'data', handler: (chunk: Buffer | string) => void): void } | null;
    stderr: { on(event: 'data', handler: (chunk: Buffer | string) => void): void } | null;
    stdin: { write(text: string): void; end(): void } | null;
    on(event: string, handler: (...args: unknown[]) => void): void;
    kill(signal?: string): void;
}

interface ChildProcessModule {
    spawn(command: string, args: string[], options: {
        cwd?: string;
        env?: Record<string, string | undefined>;
    }): ChildProcessHandle;
}

let cachedNode: ChildProcessModule | null | undefined;

/** Node's child_process, or null on a build that has no Node (mobile). */
export function nodeChildProcess(): ChildProcessModule | null {
    if (cachedNode !== undefined) return cachedNode;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node is only reachable this way in a plugin bundle, and only on desktop.
        const req = eval('require') as (id: string) => unknown;
        cachedNode = req('child_process') as ChildProcessModule;
        return cachedNode;
    } catch {
        // Not every bundle has a `require` in scope: a test build (and any future
        // ESM-only host) reaches the same module through the Node API instead.
    }
    try {
        const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
        cachedNode = typeof getBuiltin === 'function'
            ? getBuiltin('child_process') as ChildProcessModule
            : null;
    } catch {
        cachedNode = null;
    }
    return cachedNode;
}

export function isCliExecAvailable(): boolean {
    return nodeChildProcess() !== null;
}

/** Directories the reader added themselves, so an odd install is still found. */
let extraPath = '';

/** Set from the settings; clears the caches so the next search uses it at once. */
export function setCliExtraPath(value: string | undefined): void {
    const next = (value ?? '').trim();
    if (next === extraPath) return;
    extraPath = next;
    clearCliPathCaches();
}

/**
 * Forget where things were found, and what PATH was built from them: a CLI the
 * reader installed a minute ago has to be picked up by the next Detect.
 */
export function clearCliPathCaches(): void {
    cachedPath = null;
    clearCliBinaryCache();
}

let cachedPath: string | null = null;

/**
 * The PATH every spawn gets: the install locations found on disk (newest
 * version-manager bins first — see cli-binary.ts for why a desktop launch
 * cannot rely on PATH), then whatever PATH this process was started with.
 */
export function resolveShellPath(): string | null {
    if (cachedPath !== null) return cachedPath;
    const base = (typeof process !== 'undefined' && process.env?.PATH) ? process.env.PATH : '/usr/bin:/bin';
    cachedPath = [...cliPathDirs({ extra: extraPath }), base].join(':');
    return cachedPath;
}

/**
 * The binary to actually spawn: the absolute path found on disk when there is
 * one, and the bare name otherwise (so the spawn's own PATH can still find it).
 * Resolving here, rather than trusting PATH, is the whole point of the search.
 */
export function resolveCliBinary(bin: string, search?: CliSearchOptions): string {
    return findCliBinary(bin, { extra: extraPath, ...search }) ?? bin;
}

export function getEnvVar(name: string): string | undefined {
    if (typeof process === 'undefined' || !process.env) return undefined;
    const value = process.env[name];
    return value && value.trim() !== '' ? value.trim() : undefined;
}

export interface CliCaptureResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    /** True when the binary itself is missing (ENOENT). */
    notFound: boolean;
    timedOut: boolean;
}

/** Run a CLI and collect everything it printed. Never throws for a bad exit. */
export async function runCliCapture(
    bin: string,
    args: string[],
    timeoutMs = 20_000,
    options: { cwd?: string; stdin?: string; search?: CliSearchOptions } = {}
): Promise<CliCaptureResult> {
    const cp = nodeChildProcess();
    if (!cp) {
        return { stdout: '', stderr: 'This build cannot launch local processes.', exitCode: -1, notFound: false, timedOut: false };
    }

    return new Promise<CliCaptureResult>(resolve => {
        let child: ChildProcessHandle;
        try {
            child = cp.spawn(resolveCliBinary(bin, options.search), args, { cwd: options.cwd, env: envWithPath() });
        } catch (error) {
            resolve({
                stdout: '',
                stderr: error instanceof Error ? error.message : String(error),
                exitCode: -1,
                notFound: true,
                timedOut: false,
            });
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        let notFound = false;
        let timedOut = false;

        const finish = (exitCode: number): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode, notFound, timedOut });
        };

        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
            finish(-1);
        }, timeoutMs);

        child.stdout?.on('data', chunk => { stdout += String(chunk); });
        child.stderr?.on('data', chunk => { stderr += String(chunk); });
        child.on('error', (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            notFound = /ENOENT|not found|no such file/i.test(message);
            stderr += `\n${message}`;
            finish(-1);
        });
        child.on('close', (code: unknown) => finish(typeof code === 'number' ? code : -1));

        // A prompt on stdin, then close it: some CLIs wait for EOF to start.
        const stdin = child.stdin;
        if (stdin) {
            if (options.stdin) stdin.write(options.stdin);
            stdin.end();
        }
    });
}

function envWithPath(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...(typeof process !== 'undefined' ? process.env : {}) };
    if (cachedPath) env.PATH = cachedPath;
    // Keep CLI output machine-readable: no colour codes, no spinners.
    env.NO_COLOR = '1';
    env.TERM = 'dumb';
    return env;
}

/** Raised when a CLI turn cannot be completed, with a message fit to show. */
export class CliTurnError extends Error {
    constructor(message: string, readonly detail: string | null = null) {
        super(message);
        this.name = 'CliTurnError';
    }
}

/**
 * One prompt in, one answer out, through an installed CLI. This is the whole
 * task path: whatever the plugin asks a model to do — write questions, chart a
 * note into objectives — arrives here, and the CLI's own login does the rest.
 */
export async function runCliTurn(def: CliAgentDef, options: CliInvokeOptions): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    resolveShellPath();

    const args = def.buildArgs(options);
    const prompt = options.prompt ?? '';
    const capture = await runCliCapture(def.bin, args, timeoutMs, {
        cwd: options.cwd,
        stdin: def.stdinPrompt === false
            ? undefined
            : def.wrapStdin ? def.wrapStdin(prompt) : prompt,
    });

    const combined = `${capture.stdout}\n${capture.stderr}`;

    if (capture.notFound) {
        throw new CliTurnError(def.notFoundGuidance, capture.stderr.trim() || null);
    }
    if (capture.timedOut) {
        throw new CliTurnError(
            `${def.name} did not answer within ${formatDuration(timeoutMs)} and was stopped.`,
            combined.trim().slice(0, 2000) || null
        );
    }

    // Parse first — a CLI's own error event (Codex's `error`, a Claude result with
    // is_error) is a signal the caller must hear, and it arrives as one.
    const fromStdout = capture.stdout ? parseCliOutput(def, capture.stdout) : null;
    const fromStderr = capture.stderr ? parseCliOutput(def, capture.stderr) : null;

    // Whether a turn *succeeded* is the exit code's business, not the words in
    // it. Scolding an answer for mentioning a 401 would throw away good work;
    // trusting a non-zero exit would hand back a half-finished reply. So: zero
    // means the text is the answer, non-zero means something went wrong and the
    // complaint (on stderr, where CLIs put complaints) is what to report.
    if (capture.exitCode === 0) {
        const text = fromStdout ?? fromStderr;
        if (text) return text;
        throw new CliTurnError(`${def.name} returned nothing.`, combined.trim().slice(0, 2000) || null);
    }

    if (isAuthFailureText(def, capture.stderr || combined)) {
        throw new CliTurnError(def.loginGuidance, combined.trim().slice(0, 2000) || null);
    }
    // A raw-text CLI has no error channel of its own, so its stdout complaint is
    // the only explanation available.
    const complaint = (capture.stderr || fromStdout || '').trim().split(/\r?\n/)[0] ?? '';
    throw new CliTurnError(
        `${def.name} failed (exit code ${capture.exitCode})${complaint ? `: ${complaint}` : ' and said nothing about why.'}`,
        combined.trim().slice(0, 2000) || null
    );
}

/** Seconds read badly below a second; the timeout the caller set is what to say. */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

/** Apply the agent's own parser to a chunk of output, or null when there is none. */
export function parseCliOutput(def: CliAgentDef, raw: string): string | null {
    if (!raw.trim()) return null;

    if (def.streamFormat === 'json-lines' && def.parseLine) {
        let text = '';
        let error: string | null = null;
        for (const line of raw.split(/\r?\n/)) {
            const result = def.parseLine(line);
            for (const one of Array.isArray(result) ? result : [result]) {
                if (one.kind === 'text') text += one.text;
                else if (one.kind === 'error') error = one.message;
            }
        }
        if (text.trim()) return text;
        if (error) throw new CliTurnError(error, raw.trim().slice(0, 2000));
        return null;
    }

    if (def.parseFinal) {
        const result = def.parseFinal(raw);
        if (result.kind === 'text') return result.text;
        if (result.kind === 'error') throw new CliTurnError(result.message, raw.trim().slice(0, 2000));
        return null;
    }

    return raw.trim() || null;
}

/** Re-exported so callers can pattern-match without importing two modules. */
export type { CliParseResult };
