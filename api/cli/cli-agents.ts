import {
    CliAgentDef,
    CliInvokeOptions,
    CliModelEntry,
    CliParseResult,
    COMMON_AUTH_FAILURE_PATTERNS,
} from './cli-types';

/**
 * The agent CLIs this plugin can drive. Each entry is a promise about flags and
 * output shapes, so it is kept to what the CLI documents and (where possible)
 * verified against the installed binary.
 *
 * Nothing here is provider-specific plumbing: the CLI is the provider, it owns
 * the login, and the plugin only borrows a turn.
 */

function wantsModel(model: string | undefined): model is string {
    return typeof model === 'string' && model.trim() !== '' && model !== 'default';
}

function firstLine(text: string): string {
    return (text || '').split(/\r?\n/)[0]?.trim() ?? '';
}

/** Every CLI's plain-text fallback: whatever it printed is the answer. */
function rawTextResult(raw: string): CliParseResult {
    const text = (raw ?? '').trim();
    return text ? { kind: 'text', text } : { kind: 'error', message: 'The CLI returned nothing.' };
}

// ------------------------------------------------------------------ Claude Code

/**
 * `claude -p --output-format json` for one-shot turns; the prompt goes in on
 * stdin. Auth is whatever the user's Claude Code session already is (Pro/Max
 * subscription or API key).
 */
export const claudeAgent: CliAgentDef = {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    buildArgs: (options: CliInvokeOptions) => {
        const args = ['-p', '--output-format', 'json'];
        // Headless print mode has no approver, so tools must stay off for tasks
        // that only want text back (questions, objectives) — a permission prompt
        // would simply hang the turn.
        args.push('--permission-mode', 'default');
        if (wantsModel(options.model)) args.push('--model', options.model);
        return args;
    },
    versionArgs: ['--version'],
    streamFormat: 'raw-text',
    stdinPrompt: true,
    parseFinal: (raw: string): CliParseResult => {
        // `--output-format json` prints one document: { result, is_error, ... }
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const result = typeof parsed.result === 'string' ? parsed.result : '';
            if (parsed.is_error === true) {
                return { kind: 'error', message: firstLine(result) || 'Claude Code reported an error.' };
            }
            if (result.trim()) return { kind: 'text', text: result };
        } catch {
            // Older/newer formats that print the answer directly still work.
        }
        return rawTextResult(raw);
    },
    listModels: {
        // Claude Code accepts documented aliases, which is the honest list it
        // exposes offline; `--help` output is not stable enough to parse.
        args: ['--help'],
        parse: () => [],
    },
    authFailurePatterns: [
        ...COMMON_AUTH_FAILURE_PATTERNS,
        /invalid api key/i,
        /credit balance is too low/i,
    ],
    loginCommand: 'claude',
    loginGuidance:
        'Claude Code is not signed in. Run `claude` in a terminal and complete the sign-in, then Detect again. Spaceforge never sees those credentials.',
    notFoundGuidance:
        'The `claude` CLI was not found on your PATH. Install Claude Code, run `claude` once to sign in, then Detect again. Installing it after Obsidian started can hide it — restarting Obsidian picks up a new PATH.',
    // The aliases `claude --help` names, newest family first, plus the ones its
    // docs list. An alias tracks the CLI's own mapping, so it ages well; the field
    // stays free text for a full id like claude-opus-5-5.
    catalogModels: [
        { id: 'default', label: 'Default (as configured in Claude Code)' },
        { id: 'opus', label: 'Opus (alias, current flagship)' },
        { id: 'sonnet', label: 'Sonnet (alias)' },
        { id: 'haiku', label: 'Haiku (alias)' },
        { id: 'fable', label: 'Fable (alias, top tier where enabled)' },
    ],
};

// ----------------------------------------------------------------------- Codex

export const codexAgent: CliAgentDef = {
    id: 'codex',
    name: 'Codex CLI (ChatGPT)',
    bin: 'codex',
    buildArgs: (options: CliInvokeOptions) => {
        // `exec` is the non-interactive subcommand; read-only sandbox keeps a
        // text-only task from touching the vault.
        const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only'];
        if (wantsModel(options.model)) args.push('-m', options.model);
        return args;
    },
    versionArgs: ['--version'],
    authProbe: { args: ['login', 'status'] },
    streamFormat: 'json-lines',
    stdinPrompt: true,
    parseLine: (line: string): CliParseResult => {
        const trimmed = line.trim();
        if (!trimmed) return { kind: 'ignore' };
        try {
            const event = JSON.parse(trimmed) as Record<string, unknown>;
            const type = typeof event.type === 'string' ? event.type : '';
            if (type === 'item.completed' || type === 'item.failed') {
                const item = (event.item ?? {}) as Record<string, unknown>;
                const text = typeof item.text === 'string' ? item.text : '';
                if (text.trim()) {
                    return type === 'item.failed' ? { kind: 'error', message: firstLine(text) } : { kind: 'text', text };
                }
            }
            if (type === 'error') {
                const message = typeof event.message === 'string' ? event.message : 'Codex reported an error.';
                return { kind: 'error', message: firstLine(message) };
            }
        } catch {
            // A CLI that printed plain text anyway: keep it.
            return { kind: 'text', text: trimmed };
        }
        return { kind: 'ignore' };
    },
    listModels: {
        args: ['debug', 'models'],
        parse: (output: string): CliModelEntry[] => {
            const models: CliModelEntry[] = [];
            const seen = new Set<string>();
            for (const line of output.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || /^(error|usage|available|models?)\b/i.test(trimmed)) continue;
                const id = trimmed.split(/\s+/)[0] ?? '';
                if (!id || id.startsWith('-') || seen.has(id)) continue;
                seen.add(id);
                models.push({ id });
            }
            return models;
        },
    },
    authFailurePatterns: COMMON_AUTH_FAILURE_PATTERNS,
    loginCommand: 'codex login',
    loginGuidance:
        'Codex is not signed in. Run `codex login` in a terminal, then Detect again; Spaceforge never sees those credentials.',
    notFoundGuidance:
        'The `codex` CLI was not found on your PATH. Install it (`npm install -g @openai/codex`), run `codex login`, then Detect again.',
    // Codex takes real model ids (`codex --model gpt-6.1-sol`), so the current
    // ones are worth naming; anything older is retired on the sign-in side.
    catalogModels: [
        { id: 'default', label: 'Default (as configured in Codex)' },
        { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (newest)' },
        { id: 'gpt-6-astra', label: 'GPT-6 Astra (most capable)' },
        { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
        { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    ],
};

// ------------------------------------------------------------------ Cursor Agent

export const cursorAgent: CliAgentDef = {
    id: 'cursor',
    name: 'Cursor Agent',
    bin: 'cursor-agent',
    buildArgs: (options: CliInvokeOptions) => {
        // -p = one-shot print, --trust skips the workspace prompt, and the ask
        // mode keeps a text task from editing anything.
        const args = ['-p', '--trust', '--output-format', 'text', '--mode', 'ask'];
        if (wantsModel(options.model)) args.push('--model', options.model);
        return args;
    },
    versionArgs: ['--version'],
    authProbe: { args: ['about'] },
    streamFormat: 'raw-text',
    stdinPrompt: false,
    listModels: {
        args: ['--list-models'],
        parse: (output: string): CliModelEntry[] => {
            const models: CliModelEntry[] = [];
            const seen = new Set<string>();
            for (const line of output.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (/^(no models|available models|error|usage|cli version)/i.test(trimmed)) continue;
                const id = trimmed.split(/\s+/)[0] ?? '';
                if (!id || id.startsWith('-') || seen.has(id)) continue;
                seen.add(id);
                const label = trimmed.slice(id.length).replace(/^[\s\-–—:]+/, '').trim();
                models.push(label ? { id, label } : { id });
            }
            return models;
        },
    },
    authFailurePatterns: COMMON_AUTH_FAILURE_PATTERNS,
    loginCommand: 'cursor-agent login',
    loginGuidance:
        'Cursor Agent is not signed in. Run `cursor-agent login` in a terminal, then Detect again.',
    notFoundGuidance:
        'The `cursor-agent` CLI was not found on your PATH. Install Cursor Agent, run `cursor-agent login`, then Detect again.',
    catalogModels: [{ id: 'default', label: 'Default (as configured in Cursor)' }],
};

// ------------------------------------------------------------------------- Hermes

export const hermesAgent: CliAgentDef = {
    id: 'hermes',
    name: 'Hermes (Nous Research)',
    bin: 'hermes',
    buildArgs: (options: CliInvokeOptions) => {
        // -z is the scripted one-shot: prompt as an argument, only the final
        // reply on stdout. Upstream Hermes picks its own model, so no --model.
        return ['-z', options.prompt ?? ''];
    },
    versionArgs: ['--version'],
    streamFormat: 'raw-text',
    stdinPrompt: false,
    authFailurePatterns: COMMON_AUTH_FAILURE_PATTERNS,
    loginCommand: 'hermes',
    loginGuidance:
        'Hermes is not configured. Run `hermes` in a terminal to finish setup and sign-in, then Detect again.',
    notFoundGuidance:
        'The `hermes` CLI was not found on your PATH. Install Hermes, run `hermes` once to finish setup, then Detect again.',
    catalogModels: [{ id: 'default', label: 'Default (Hermes chooses from its own config)' }],
};

// ------------------------------------------------------------------------- Gemini

export const geminiAgent: CliAgentDef = {
    id: 'gemini',
    name: 'Gemini CLI',
    bin: 'gemini',
    buildArgs: (options: CliInvokeOptions) => {
        // The prompt is an argument here, and -o json wraps the reply.
        const args = ['-p', options.prompt ?? '', '-o', 'json'];
        if (wantsModel(options.model)) args.push('--model', options.model);
        return args;
    },
    versionArgs: ['--version'],
    streamFormat: 'raw-text',
    stdinPrompt: false,
    parseFinal: (raw: string): CliParseResult => {
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const response = typeof parsed.response === 'string' ? parsed.response : '';
            if (response.trim()) return { kind: 'text', text: response };
        } catch {
            // fall through to the raw text
        }
        return rawTextResult(raw);
    },
    authFailurePatterns: COMMON_AUTH_FAILURE_PATTERNS,
    loginCommand: 'gemini',
    loginGuidance:
        'Gemini CLI is not signed in. Run `gemini` in a terminal and complete the sign-in (Google account or API key), then Detect again.',
    notFoundGuidance:
        'The `gemini` CLI was not found on your PATH. Install Gemini CLI (`npm install -g @google/gemini-cli`), run `gemini` once, then Detect again.',
    // The CLI's own active set. Gemini 4 Argon is deliberately absent: Google
    // says the CLI is not optimised for it and points at Antigravity instead.
    catalogModels: [
        { id: 'default', label: 'Default (Gemini CLI chooses)' },
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (newest for this CLI)' },
        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
        { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
    ],
};

// ---------------------------------------------------------------------- OpenClaw

export const openclawAgent: CliAgentDef = {
    id: 'openclaw',
    name: 'OpenClaw',
    bin: 'openclaw',
    buildArgs: (options: CliInvokeOptions) => {
        // --json keeps stdout for the answer; the prompt travels as a flag.
        const agentId = wantsModel(options.model) ? options.model : 'default';
        return ['agent', '--agent', agentId, '--message', options.prompt ?? '', '--json'];
    },
    versionArgs: ['--version'],
    streamFormat: 'raw-text',
    stdinPrompt: false,
    parseFinal: (raw: string): CliParseResult => {
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const text = [parsed.response, parsed.message, parsed.text, parsed.output]
                .find((value): value is string => typeof value === 'string' && value.trim() !== '');
            if (text) return { kind: 'text', text };
        } catch {
            // fall through
        }
        return rawTextResult(raw);
    },
    authFailurePatterns: COMMON_AUTH_FAILURE_PATTERNS,
    loginCommand: 'openclaw onboard',
    loginGuidance:
        'OpenClaw is not set up. Run `openclaw onboard` in a terminal, then Detect again.',
    notFoundGuidance:
        'The `openclaw` CLI was not found on your PATH. Install OpenClaw, run `openclaw onboard`, then Detect again.',
    catalogModels: [{ id: 'default', label: 'Default agent' }],
};

// ---------------------------------------------------------------------- registry

/**
 * Order matters only for presentation: the CLIs a learner is most likely to
 * already have come first.
 */
// ------------------------------------------------------------------- Antigravity

/**
 * Antigravity (`agy`) — Google's successor to the now-deprecated Gemini CLI for
 * individuals. It is driven over its headless stream-json protocol: the process
 * is started with `--input-format stream-json --output-format stream-json`, the
 * prompt goes to stdin as one NDJSON user event, and the reply arrives as typed
 * events (text deltas, then a result). `agy -p -` used to be the way to do this
 * and silently breaks from 1.2.7 on, which is why the envelope is explicit here.
 *
 * Auth comes from `agy`'s own Google sign-in (system keyring), so it cannot be
 * completed headlessly: the reader runs `agy` once in a terminal. `agy models`
 * prints the account's model slugs, so the list is read live rather than guessed.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringField(record: Record<string, unknown> | null, ...keys: string[]): string {
    if (!record) return '';
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

/** One line of `agy --output-format stream-json`: init / step_update / result. */
export function parseAntigravityEventLine(line: string): CliParseResult | CliParseResult[] {
    const trimmed = line.trim();
    if (!trimmed) return { kind: 'ignore' };
    let event: Record<string, unknown> | null;
    try {
        event = asRecord(JSON.parse(trimmed));
    } catch {
        return { kind: 'ignore' };
    }
    const kind = stringField(event, 'event');

    if (kind === 'step_update') {
        const step = asRecord(event?.step_update);
        if (!step) return { kind: 'ignore' };
        const stepType = stringField(step, 'step_type');
        if (stepType === 'agent_response') {
            // Deliberately untrimmed: a delta is a fragment, and its leading and
            // trailing spaces are what join it to the fragments around it.
            const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
            return delta ? { kind: 'text', text: delta } : { kind: 'ignore' };
        }
        // Tool activity is the CLI's business, not ours: this plugin asks for an
        // answer, and the answer is what it reads.
        return { kind: 'ignore' };
    }

    if (kind === 'result') {
        const result = asRecord(event?.result);
        if (!result) return { kind: 'ignore' };
        const status = stringField(result, 'status');
        const response = stringField(result, 'response');
        if (status === 'SUCCESS' || response) return response ? { kind: 'text', text: response } : { kind: 'ignore' };
        // A failed post-turn step can still carry the answer; report it either way.
        return {
            kind: 'error',
            message: stringField(result, 'error') || `Antigravity ended with status ${status || 'UNKNOWN'}`,
        };
    }

    return { kind: 'ignore' };
}

/** `agy models` prints one `slug   Display Label` pair per line. */
export function parseAntigravityModels(output: string): CliModelEntry[] {
    const models: CliModelEntry[] = [];
    const seen = new Set<string>();
    for (const raw of String(output || '').split(/\r?\n/)) {
        const line = raw.trim();
        const match = /^([A-Za-z0-9][A-Za-z0-9._/-]*)\s+(.+)$/.exec(line);
        if (!match) continue;
        const id = match[1];
        const label = match[2].trim();
        if (!id || seen.has(id) || /^(fetching|error|warning|usage)/i.test(id)) continue;
        seen.add(id);
        models.push({ id, label });
    }
    return models;
}

export const antigravityAgent: CliAgentDef = {
    id: 'antigravity',
    name: 'Antigravity',
    bin: 'agy',
    buildArgs: (options: CliInvokeOptions) => {
        // Prompts travel as NDJSON on stdin, so argv is just the protocol and the
        // model — no length limit on the note being turned into questions.
        const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
        if (wantsModel(options.model)) args.push('--model', options.model);
        return args;
    },
    // The one NDJSON envelope agy accepts as a user turn.
    wrapStdin: (prompt: string) => `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
    versionArgs: ['--version'],
    streamFormat: 'json-lines',
    parseLine: parseAntigravityEventLine,
    listModels: { args: ['models'], parse: parseAntigravityModels },
    authFailurePatterns: [
        /not logged into antigravity/i,
        /authentication (required|timed out)/i,
        /not authenticated/i,
        /please.*(login|sign in|authenticate)/i,
        /unauthorized/i,
        /\b401\b/,
    ],
    loginCommand: 'agy',
    loginGuidance:
        'Antigravity is not signed in. Run `agy` once in a terminal: it opens Google sign-in in your browser and keeps the token in your system keyring, which headless mode cannot do for you.',
    notFoundGuidance:
        'The `agy` (Antigravity) CLI was not found. Install it from https://antigravity.google/cli, run `agy` once to sign in, then Detect again.',
    // A fallback only: `agy models` lists the account's real slugs, and this is
    // what to offer if that call fails.
    catalogModels: [
        { id: 'default', label: 'Default (Antigravity chooses)' },
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (high effort)' },
        { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (medium)' },
        { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (high effort)' },
        { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (medium)' },
    ],
};

export const CLI_AGENTS: CliAgentDef[] = [
    antigravityAgent,
    claudeAgent,
    codexAgent,
    cursorAgent,
    geminiAgent,
    hermesAgent,
    openclawAgent,
];

const BY_ID = new Map(CLI_AGENTS.map(agent => [agent.id, agent]));

export function getCliAgent(id: string | undefined): CliAgentDef | undefined {
    return id ? BY_ID.get(id) : undefined;
}

export function listCliAgents(): CliAgentDef[] {
    return CLI_AGENTS;
}
