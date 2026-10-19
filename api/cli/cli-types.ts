/**
 * The contract for delegating one of the plugin's AI tasks to an agent CLI that
 * is already installed and already signed in on this machine (Claude Code,
 * Codex, Cursor, Hermes, …).
 *
 * The shape is borrowed from the iktinah plugin, which learned the hard way that
 * every harness needs the same four things spelled out per CLI: how to build the
 * arguments for a one-shot turn, how to read its output, how to tell whether it
 * is signed in, and what to tell the user when it is not. Credentials are never
 * stored here — the CLI brings its own session, and this only reports on it.
 */

/** Per-turn context for a CLI invocation. */
export interface CliInvokeOptions {
    /** The CLI's own model id, or undefined/'default' to let it choose. */
    model?: string;
    /** The whole prompt. Most CLIs read it from stdin; some take it in argv. */
    prompt?: string;
    /** Working directory for the spawn (the vault by default). */
    cwd?: string;
    /** Hard stop, in milliseconds. */
    timeoutMs?: number;
}

export type CliParseResult =
    | { kind: 'text'; text: string }
    | { kind: 'error'; message: string }
    | { kind: 'ignore' };

export interface CliModelEntry {
    id: string;
    label?: string;
    /** Provider-reported creation time, when its list carries one. */
    created?: number;
}

export interface CliAgentDef {
    /** Stable id, also what the settings store as the chosen agent. */
    id: string;
    name: string;
    /** Binary, resolved on the login-shell PATH. */
    bin: string;
    /** Arguments for a one-shot, non-interactive turn. */
    buildArgs(options: CliInvokeOptions): string[];
    versionArgs: string[];
    /** A cheap command whose failure means "not signed in", when one exists. */
    authProbe?: {
        args: string[];
        /**
         * The probe must also print something. A command that lists
         * credentials exits 0 and prints nothing when the list is empty, which
         * would otherwise read as "signed in".
         */
        requireOutput?: boolean;
    };
    /** How to read stdout: one JSON document per line, or the final text as-is. */
    streamFormat: 'json-lines' | 'raw-text';
    /**
     * For 'json-lines' without a `parseFinal`: one stdout line -> one or more
     * results. Ignored when `parseFinal` is set.
     */
    parseLine?(line: string): CliParseResult | CliParseResult[];
    /**
     * A parser for the whole output, for a CLI that prints a single JSON
     * document at the end, or one whose stream repeats the same text in deltas
     * and in a final result event. Takes precedence over `parseLine` and over
     * using stdout verbatim.
     */
    parseFinal?(raw: string): CliParseResult;
    /**
     * Whether the prompt goes on stdin (default true). False means buildArgs has
     * already put it in argv, and stdin is closed empty.
     */
    stdinPrompt?: boolean;
    /**
     * Wrap the prompt before it is written to stdin, for a CLI that expects an
     * envelope rather than raw text (Antigravity takes one NDJSON user event).
     */
    wrapStdin?(prompt: string): string;
    /** Live model listing, when the CLI can print one. */
    listModels?: {
        args: string[];
        parse(output: string): CliModelEntry[];
    };
    /** Patterns that mean "this CLI is not signed in". */
    authFailurePatterns: RegExp[];
    /** What the user runs to sign in. */
    loginCommand: string;
    loginGuidance: string;
    notFoundGuidance: string;
    /**
     * Models to offer before (or instead of) a live listing. Kept deliberately
     * small and factual — an alias the CLI documents, or nothing but 'default'
     * — because a guessed model id is worse than an empty list: the user can
     * always type one, and Detect can ask the CLI itself.
     */
    catalogModels: CliModelEntry[];
}

export function isAuthFailureText(def: CliAgentDef, text: string): boolean {
    const value = String(text ?? '');
    if (!value.trim()) return false;
    return def.authFailurePatterns.some(pattern => pattern.test(value));
}

/** Shared by every agent that has no better guidance of its own. */
export const COMMON_AUTH_FAILURE_PATTERNS: RegExp[] = [
    /not logged in/i,
    /not authenticated/i,
    /not signed in/i,
    /unauthorized/i,
    /no api key/i,
    /missing.*api key/i,
    /invalid api key/i,
    /please.*(log ?in|authenticate|sign in)/i,
    /\b401\b/,
];
