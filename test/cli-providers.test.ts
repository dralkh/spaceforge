/**
 * Contract tests for the local-CLI provider layer.
 *
 * Three layers are exercised here, each with real execution:
 *  - the pure per-agent logic (argument building, output parsing, auth text),
 *  - the real spawn machinery in cli-runner (`runCliTurn`), driven through
 *    `process.execPath` as the agent binary so no paid CLI is ever invoked,
 *  - the registry half (search ranking, key resolution, model discovery via a
 *    canned `requestUrl` response).
 *
 * The test bundle runs as an ES module on Node 20+. `cli-runner` reaches
 * `child_process` through node-modules, which prefers Node's
 * `process.getBuiltinModule()` and falls back to Electron's `window.require`;
 * this runtime has the former, so every spawn test below runs the shipping
 * code path rather than a fallback. Without a Node module loader,
 * `isCliExecAvailable()` reports false and the spawn tests would silently test
 * the "cannot launch local processes" branch instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

(globalThis as unknown as { require: unknown }).require = createRequire(import.meta.url);

import type { CliAgentDef, CliInvokeOptions, CliParseResult } from '../api/cli/cli-types';
import { COMMON_AUTH_FAILURE_PATTERNS, isAuthFailureText } from '../api/cli/cli-types';
import {
    CLI_AGENTS,
    claudeAgent,
    codexAgent,
    cursorAgent,
    geminiAgent,
    getCliAgent,
    hermesAgent,
    listCliAgents,
    openclawAgent,
} from '../api/cli/cli-agents';
import { CliTurnError, isCliExecAvailable, parseCliOutput, runCliTurn } from '../api/cli/cli-runner';
import { CliChatClient, flattenMessages } from '../api/cli/cli-chat-client';
import {
    agentIdOfProvider,
    cliProviderId,
    DiscoveredModel,
    discoverHttpModels,
    discoverModels,
    detectProviders,
    getCliProviderRow,
    getHttpProvider,
    HTTP_PROVIDERS,
    listProviders,
    httpProviderChatUrl,
    httpProviderModelsUrl,
    describeProviderGap,
    providerIsOpenAiShaped,
    providerModel,
    providerNeedsUrl,
    providerStoredKey,
    providerStoredModel,
    rankModels,
    resolveHttpBaseUrl,
    resolveHttpKey,
    searchModels,
    setProviderBaseUrl,
    setProviderKey,
    setProviderModel,
    versionScore,
} from '../api/provider-registry';
import { buildOpenAiChatRequest, inspectChatProvider } from '../api/chat-client';
import { ApiProvider, DEFAULT_SETTINGS, migrateSettings, SpaceforgeSettings } from '../models/settings';
import { setRequestUrlStub, StubRequestUrlRequest } from './support/obsidian-shim';

// ------------------------------------------------------------------- helpers

/**
 * An agent that runs a Node one-liner instead of a real CLI: the binary is the
 * Node that is already running these tests, so the spawn is real but nothing
 * leaves the machine and no model is ever billed.
 */
function adhocAgent(overrides: Partial<CliAgentDef> = {}): CliAgentDef {
    return {
        id: 'adhoc',
        name: 'Ad-hoc test CLI',
        bin: process.execPath,
        buildArgs: () => [],
        versionArgs: ['--version'],
        streamFormat: 'raw-text',
        authFailurePatterns: COMMON_AUTH_FAILURE_PATTERNS,
        loginCommand: 'adhoc login',
        loginGuidance: 'ADHOC-LOGIN-GUIDANCE',
        notFoundGuidance: 'ADHOC-NOT-FOUND-GUIDANCE',
        catalogModels: [{ id: 'default' }],
        ...overrides,
    };
}

/** argv that makes the Node binary execute `source` via `-e`. */
function nodeScript(source: string): string[] {
    return ['-e', source];
}

/** Reads everything on stdin and answers with `GOT:` + that text. */
const ECHO_STDIN_SCRIPT =
    "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write('GOT:'+s.trim()))";

function settingsWith(overrides: Partial<SpaceforgeSettings>): SpaceforgeSettings {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

// ------------------------------------------------- 1. argument building (pure)

test('claudeAgent.buildArgs: json print mode, default permission mode, model flag, prompt never in argv', () => {
    assert.deepEqual(claudeAgent.buildArgs({ prompt: 'write me questions' }), [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'default',
    ]);
    assert.deepEqual(claudeAgent.buildArgs({ prompt: 'write me questions', model: 'sonnet' }), [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'default',
        '--model',
        'sonnet',
    ]);
    // The prompt travels on stdin, so it must never leak into argv (the OS
    // exposes argv to other processes; stdin is private).
    assert.equal(claudeAgent.stdinPrompt, true);
    assert.ok(!claudeAgent.buildArgs({ prompt: 'write me questions' }).includes('write me questions'));
    // 'default' is the CLI's own default and must not be passed as a model id.
    assert.deepEqual(claudeAgent.buildArgs({ prompt: 'x', model: 'default' }), [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'default',
    ]);
});

test('codexAgent.buildArgs: exec json mode with read-only sandbox, model appended with -m', () => {
    assert.deepEqual(codexAgent.buildArgs({ prompt: 'x' }), [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
    ]);
    assert.deepEqual(codexAgent.buildArgs({ prompt: 'x', model: 'gpt-5' }), [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '-m',
        'gpt-5',
    ]);
    assert.equal(codexAgent.stdinPrompt, true);
});

test('cursorAgent.buildArgs: one-shot ask mode, --model appended when set', () => {
    const bare = cursorAgent.buildArgs({ prompt: 'x' });
    const modeAt = bare.indexOf('--mode');
    assert.ok(modeAt >= 0, 'asks in a mode that cannot edit the vault');
    assert.deepEqual(bare.slice(modeAt, modeAt + 2), ['--mode', 'ask']);
    assert.ok(!bare.includes('--model'));

    const withModel = cursorAgent.buildArgs({ prompt: 'x', model: 'claude-4.5-sonnet' });
    assert.deepEqual(withModel.slice(-2), ['--model', 'claude-4.5-sonnet']);
});

test('hermesAgent.buildArgs: -z one-shot with the prompt in argv and stdinPrompt false', () => {
    assert.deepEqual(hermesAgent.buildArgs({ prompt: 'the prompt' }), ['-z', 'the prompt']);
    assert.equal(hermesAgent.stdinPrompt, false);
});

test('geminiAgent.buildArgs: prompt in argv after -p, wrapped by -o json', () => {
    const args = geminiAgent.buildArgs({ prompt: 'the prompt' });
    assert.deepEqual(args, ['-p', 'the prompt', '-o', 'json']);
    assert.equal(args.includes('the prompt'), true);
});

test('openclawAgent.buildArgs: prompt in argv after --message, --json on', () => {
    const args = openclawAgent.buildArgs({ prompt: 'the prompt' });
    assert.ok(args.includes('--message'), 'the prompt is delivered as a flag');
    assert.equal(args[args.indexOf('--message') + 1], 'the prompt');
    assert.ok(args.includes('--json'), 'stdout stays machine-readable');
});

// ------------------------------------------------------- 2. agent registry

test('getCliAgent/listCliAgents: unique ids, complete guidance, catalog models, unknown ids rejected', () => {
    const agents = listCliAgents();
    assert.ok(agents.length >= 6, `expected the known CLIs, got ${agents.length}`);
    assert.equal(new Set(agents.map(agent => agent.id)).size, agents.length, 'ids are unique');

    for (const agent of agents) {
        assert.ok(agent.loginCommand.trim().length > 0, `${agent.id}: has a login command`);
        assert.ok(agent.loginGuidance.trim().length > 0, `${agent.id}: has login guidance`);
        assert.ok(agent.notFoundGuidance.trim().length > 0, `${agent.id}: has not-found guidance`);
        assert.ok(agent.catalogModels.length >= 1, `${agent.id}: has at least one catalog model`);
        assert.ok(
            agent.catalogModels.every(model => model.id.trim().length > 0),
            `${agent.id}: every catalog model has an id`
        );
        assert.equal(getCliAgent(agent.id), agent, `${agent.id}: resolves back from the registry`);
    }

    assert.equal(CLI_AGENTS.length, agents.length);
    assert.equal(getCliAgent('nope'), undefined);
    assert.equal(getCliAgent(undefined), undefined);
});

// ------------------------------------------------------ 3. auth failure text

test('isAuthFailureText matches login failures reported by CLIs', () => {
    const def = codexAgent; // a shared COMMON_AUTH_FAILURE_PATTERNS consumer
    assert.equal(isAuthFailureText(def, 'Not logged in'), true);
    assert.equal(isAuthFailureText(def, 'Error: invalid api key'), true);
    assert.equal(isAuthFailureText(def, '401 unauthorized'), true);
});

test('isAuthFailureText leaves ordinary answers and empty output alone', () => {
    assert.equal(isAuthFailureText(codexAgent, 'Here are your questions:'), false);
    assert.equal(isAuthFailureText(claudeAgent, 'Here are your questions:'), false);
    assert.equal(isAuthFailureText(codexAgent, ''), false);
    assert.equal(isAuthFailureText(codexAgent, '   '), false);
});

// ----------------------------------------------------------- 4. output parsing

test('parseCliOutput: codex json-lines yields the item text, error lines become CliTurnError', () => {
    const text: CliParseResult | string | null = parseCliOutput(
        codexAgent,
        '{"type":"item.completed","item":{"text":"hello"}}'
    );
    assert.equal(text, 'hello');

    assert.throws(
        () => parseCliOutput(codexAgent, '{"type":"error","message":"boom"}'),
        (error: unknown) => error instanceof CliTurnError && error.message === 'boom'
    );
});

test('parseCliOutput: claude final JSON result, error results, and plain text', () => {
    assert.equal(parseCliOutput(claudeAgent, '{"result":"answer","is_error":false}'), 'answer');
    assert.throws(
        () => parseCliOutput(claudeAgent, '{"result":"denied","is_error":true}'),
        (error: unknown) => error instanceof CliTurnError && error.message === 'denied'
    );
    assert.equal(parseCliOutput(claudeAgent, 'just text'), 'just text');
});

test('parseCliOutput: gemini final JSON response', () => {
    assert.equal(parseCliOutput(geminiAgent, '{"response":"hi"}'), 'hi');
});

// ------------------------------------------------- 5. spawn, end to end (real)

test('runCliTurn spawns the real binary and returns exactly its stdout', async () => {
    assert.equal(isCliExecAvailable(), true, 'the test host must be able to spawn processes');
    const agent = adhocAgent({
        buildArgs: () => ['-e', 'process.stdout.write("hello from cli")', '--input-type=module'],
    });
    const text = await runCliTurn(agent, { prompt: 'this should not reach argv', timeoutMs: 20_000 });
    assert.equal(text, 'hello from cli');
});

test('runCliTurn delivers the prompt on stdin when the agent wants stdin', async () => {
    const agent = adhocAgent({
        stdinPrompt: true,
        // The answer can only contain the prompt if it really arrived on stdin.
        buildArgs: () => nodeScript(ECHO_STDIN_SCRIPT),
    });
    const prompt = 'the prompt travels on stdin';
    const text = await runCliTurn(agent, { prompt, timeoutMs: 20_000 });
    assert.equal(text, `GOT:${prompt}`);
});

test('runCliTurn rejects with notFoundGuidance when the binary does not exist', async () => {
    const agent = adhocAgent({ bin: 'definitely-not-a-real-binary-xyz' });
    await assert.rejects(runCliTurn(agent, { prompt: 'x', timeoutMs: 10_000 }), (error: unknown) => {
        assert.ok(error instanceof CliTurnError);
        assert.equal((error as Error).message, 'ADHOC-NOT-FOUND-GUIDANCE');
        return true;
    });
});

test('runCliTurn rejects with loginGuidance when the CLI reports an auth failure', async () => {
    const agent = adhocAgent({
        buildArgs: () => nodeScript('console.error("Error: not logged in"); process.exit(1)'),
    });
    await assert.rejects(runCliTurn(agent, { prompt: 'x', timeoutMs: 10_000 }), (error: unknown) => {
        assert.ok(error instanceof CliTurnError);
        assert.equal((error as Error).message, 'ADHOC-LOGIN-GUIDANCE');
        return true;
    });
});

test('runCliTurn stops a CLI that outlives its timeout, well before the child would end', async () => {
    const agent = adhocAgent({
        // Sleeps for 5s; the turn's budget is 300ms, so passing this test means
        // the runner killed it rather than waiting it out.
        buildArgs: () => nodeScript('setTimeout(() => {}, 5000)'),
    });
    const started = Date.now();
    await assert.rejects(runCliTurn(agent, { prompt: 'x', timeoutMs: 300 }), (error: unknown) => {
        assert.ok(error instanceof CliTurnError);
        assert.match((error as Error).message, /was stopped/);
        return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000, `turn returned in ${elapsed}ms, well under the child's 5s sleep`);
});

// --------------------------------------------------- 6. searchModels ranking

/** ids engineered so each query below exercises exactly one ranking step. */
const SEARCH_MODELS: DiscoveredModel[] = [
    { id: 'alpha', label: 'The first', source: 'catalog' },
    { id: 'alphav2', label: 'Second', source: 'api' },
    { id: 'x-alpha-y', label: 'Third', source: 'api' },
    { id: 'axlpxhxa', label: 'Scattered letters', source: 'cli' },
    { id: 'nebula-core', label: 'Nebula Core', source: 'api' },
    { id: 'other-model', label: 'Nebula Blue', source: 'api' },
];

test('searchModels ranks exact id, then prefix, then substring, then subsequence', () => {
    const ids = searchModels(SEARCH_MODELS, 'alpha').map(model => model.id);
    assert.deepEqual(ids, ['alpha', 'alphav2', 'x-alpha-y', 'axlpxhxa']);
});

test('searchModels is case-insensitive and ranks an id match above the same text in a label', () => {
    const upper = searchModels(SEARCH_MODELS, 'ALPHA').map(model => model.id);
    const lower = searchModels(SEARCH_MODELS, 'alpha').map(model => model.id);
    assert.deepEqual(upper, lower);
    assert.deepEqual(upper, ['alpha', 'alphav2', 'x-alpha-y', 'axlpxhxa']);

    // 'nebula' prefixes both an id and a label; the id comes first.
    const nebula = searchModels(SEARCH_MODELS, 'nebula').map(model => model.id);
    assert.deepEqual(nebula, ['nebula-core', 'other-model']);
});

test('searchModels: empty query returns the list up to the limit, nothing matched returns []', () => {
    assert.deepEqual(searchModels(SEARCH_MODELS, ''), SEARCH_MODELS);
    assert.deepEqual(searchModels(SEARCH_MODELS, '  '), SEARCH_MODELS);
    assert.deepEqual(
        searchModels(SEARCH_MODELS, '', 2).map(model => model.id),
        ['alpha', 'alphav2'],
        'the limit is respected'
    );
    assert.deepEqual(searchModels(SEARCH_MODELS, 'zzqq'), []);
});

// ------------------------------------------------------ 7. resolveHttpKey

test('resolveHttpKey prefers the key stored in settings', () => {
    const openai = getHttpProvider(ApiProvider.OpenAI);
    const openrouter = getHttpProvider(ApiProvider.OpenRouter);
    assert.ok(openai && openrouter);

    const settings = settingsWith({ openaiApiKey: 'sk-openai-settings', openRouterApiKey: 'sk-or-settings' });
    assert.equal(resolveHttpKey(openai, settings), 'sk-openai-settings');
    assert.equal(resolveHttpKey(openrouter, settings), 'sk-or-settings');
    // Whitespace-only is not a key; a real environment value would be next in
    // line, so prove the empty branch by clearing the environment too.
    const blank = settingsWith({ openaiApiKey: '   ', openRouterApiKey: '' });
    assert.notEqual(resolveHttpKey(openai, blank), '   ');
});

test('resolveHttpKey falls back to the environment, and is null with neither', () => {
    const openai = getHttpProvider(ApiProvider.OpenAI);
    const openrouter = getHttpProvider(ApiProvider.OpenRouter);
    assert.ok(openai && openrouter);

    const names = [...openai.envKeys, ...openrouter.envKeys];
    const saved = new Map(names.map(name => [name, process.env[name]]));
    try {
        for (const name of names) delete process.env[name];
        const empty = settingsWith({
            openaiApiKey: '',
            openRouterApiKey: '',
            geminiApiKey: '',
            claudeApiKey: '',
            togetherApiKey: '',
        });
        assert.equal(resolveHttpKey(openai, empty), null, 'no key anywhere -> null');
        assert.equal(resolveHttpKey(openrouter, empty), null, 'no key anywhere -> null');

        process.env.OPENAI_API_KEY = 'sk-openai-env';
        assert.equal(resolveHttpKey(openai, empty), 'sk-openai-env');
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

// --------------------------------------------- 8. discoverHttpModels via requestUrl

test('discoverHttpModels parses OpenRouter\'s OpenAI-style list', async () => {
    const requests: StubRequestUrlRequest[] = [];
    setRequestUrlStub(request => {
        requests.push(request);
        return { status: 200, json: { data: [{ id: 'a/b', name: 'A B' }] } };
    });
    try {
        const result = await discoverHttpModels(
            ApiProvider.OpenRouter,
            settingsWith({ openRouterApiKey: 'sk-or-test' })
        );
        assert.equal(result.error, null);
        // The list leads with its newest chat model, and marks it as such.
        assert.deepEqual(result.models, [{ id: 'a/b', label: 'A B', source: 'api', latest: true }]);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/models');
        assert.equal(requests[0].headers?.Authorization, 'Bearer sk-or-test');
    } finally {
        setRequestUrlStub(null);
    }
});

test('discoverHttpModels reports a rejected key on 401', async () => {
    setRequestUrlStub(() => ({ status: 401, json: { error: { message: 'Incorrect API key provided' } } }));
    try {
        const result = await discoverHttpModels(
            ApiProvider.OpenAI,
            settingsWith({ openaiApiKey: 'sk-openai-bad' })
        );
        assert.equal(result.models.length, 0);
        assert.ok(result.error, 'a 401 is an error, not an empty list');
        assert.match(result.error as string, /401/);
        assert.match(result.error as string, /key was rejected/i);
    } finally {
        setRequestUrlStub(null);
    }
});

test('discoverHttpModels: the OpenAI-compatible provider without a URL errors without a request', async () => {
    const requests: StubRequestUrlRequest[] = [];
    setRequestUrlStub(request => {
        requests.push(request);
        return { status: 200, json: { data: [] } };
    });
    try {
        const result = await discoverHttpModels(
            ApiProvider.OpenAICompatible,
            settingsWith({ openaiCompatibleApiUrl: '', openaiCompatibleApiKey: '' })
        );
        assert.equal(result.models.length, 0);
        assert.match(result.error as string, /No URL configured for OpenAI-compatible server/i);
        assert.equal(requests.length, 0, 'the URL check happens before any fetch');
    } finally {
        setRequestUrlStub(null);
    }
});

test('discoverHttpModels parses a Gemini model list and strips the models/ prefix', async () => {
    setRequestUrlStub(() => ({
        status: 200,
        json: { models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] },
    }));
    try {
        const result = await discoverHttpModels(
            ApiProvider.Gemini,
            settingsWith({ geminiApiKey: 'test-gemini-key' })
        );
        assert.equal(result.error, null);
        assert.equal(result.models.length, 1);
        assert.equal(result.models[0].id, 'gemini-2.5-pro');
        assert.equal(result.models[0].label, 'Gemini 2.5 Pro');
    } finally {
        setRequestUrlStub(null);
    }
});

// ------------------------------------------------------------ 9. CliChatClient

test('CliChatClient.send folds the system message into the prompt and reports (CLI)', async () => {
    const agent = adhocAgent({
        stdinPrompt: true,
        buildArgs: () => nodeScript(ECHO_STDIN_SCRIPT),
    });
    const client = new CliChatClient(agent, 'sonnet');
    assert.equal(client.providerLabel, 'Ad-hoc test CLI (CLI)');

    const result = await client.send({
        messages: [
            { role: 'system', content: 'be terse' },
            { role: 'user', content: 'hi' },
        ],
    });
    assert.ok(result.text.includes('be terse'), `system part missing from ${JSON.stringify(result.text)}`);
    assert.ok(result.text.includes('hi'), `user part missing from ${JSON.stringify(result.text)}`);
    assert.ok(result.providerLabel.endsWith('(CLI)'));
    assert.equal(result.model, 'sonnet');
    assert.equal(result.finishReason, 'stop');
});

test('flattenMessages joins the turns and appends the JSON instruction when json is requested', () => {
    const messages = [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
    ] as const;
    assert.equal(flattenMessages({ messages: [...messages] }), 'be terse\n\nhi');
    assert.equal(
        flattenMessages({ messages: [{ role: 'user', content: 'hi' }], json: true }),
        'hi\n\nRespond with a single valid JSON object. No prose, no code fences.'
    );
});

// --- the rules the tests above forced out of the runner ---------------------

/** Read a source file, so a fix that is structural can be asserted where it lives. */
function readSource(path: string): string {
    return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('a real answer that merely mentions an error is still the answer', async () => {
    // Exit code decides whether a turn succeeded. A model explaining a 401, or
    // quoting an error message back, is doing its job — scolding it would throw
    // the work away.
    const answer = 'A 401 unauthorized response means the key was rejected. Not logged in errors look similar.';
    const agent = adhocAgent({ buildArgs: () => nodeScript(`process.stdout.write(${JSON.stringify(answer)})`) });

    const text = await runCliTurn(agent, { prompt: 'explain', timeoutMs: 20_000 });
    assert.equal(text, answer);
});

test('a non-zero exit reports the complaint, and an auth complaint reports the guidance', async () => {
    const grumbling = adhocAgent({ buildArgs: () => nodeScript('process.stderr.write("Error: model unavailable"); process.exit(3)') });
    await assert.rejects(
        () => runCliTurn(grumbling, { prompt: 'hi', timeoutMs: 20_000 }),
        (error: unknown) => error instanceof CliTurnError
            && /exit code 3/.test(error.message)
            && /model unavailable/.test(error.message),
    );

    const signedOut = adhocAgent({ buildArgs: () => nodeScript('process.stderr.write("Error: not logged in"); process.exit(1)') });
    await assert.rejects(
        () => runCliTurn(signedOut, { prompt: 'hi', timeoutMs: 20_000 }),
        (error: unknown) => error instanceof CliTurnError && error.message === signedOut.loginGuidance,
    );
});

test('a sub-second timeout is not reported as "0s"', async () => {
    const slow = adhocAgent({ buildArgs: () => nodeScript('setTimeout(() => process.stdout.write("late"), 4000)') });
    await assert.rejects(
        () => runCliTurn(slow, { prompt: 'hi', timeoutMs: 250 }),
        (error: unknown) => error instanceof CliTurnError && /within 250ms/.test(error.message),
    );
});

test('the search finds CLIs wherever they are installed, not just where PATH points', async () => {
    // Detection resolves the binary from disk before spawning anything, and drops
    // the cache first: a CLI installed a minute ago — or living in an nvm bin that
    // no PATH this process inherited has ever seen — must be found by the next
    // Detect. This is the fix for "every CLI is installed and none is detected".
    const detection = await readSource('api/cli/cli-detection.ts');
    assert.match(detection, /clearCliPathCaches\(\);/);
    assert.match(detection, /findCliBinary\(agent\.bin/);

    // The runner spawns what the search found, rather than a bare name it hopes
    // PATH can resolve.
    const runner = await readSource('api/cli/cli-runner.ts');
    assert.match(runner, /cp\.spawn\(resolveCliBinary\(bin/);

    // And the search knows the placements a desktop launch cannot see.
    const binary = await readSource('api/cli/cli-binary.ts');
    for (const where of ['\\.nvm', 'fnm', 'mise', 'asdf', '\\.bun', '\\.local/bin', 'homebrew', 'npm-global']) {
        assert.match(binary, new RegExp(where), `it searches ${where}`);
    }

    // The string form is what matters: a quoted '$HOME/…' in an array never
    // expands (the comments that mention it are only telling the story).
    for (const source of [runner, binary]) {
        assert.doesNotMatch(source, /['"]\$HOME/, 'a literal $HOME in a path string never expands in a spawn');
    }
});

test('a provider is asked with the key that belongs to it: Gemini is named, not indexed', async () => {
    const source = await readSource('api/provider-registry.ts');
    assert.doesNotMatch(source, /HTTP_PROVIDERS\[\d+\]/, 'no provider is found by position in the table');

    // Gemini takes its key in the URL rather than a header, so the provider that
    // builds its own list URL must read its own key: asking with another
    // provider's (or none) is what "found by position" used to cause.
    const asked: string[] = [];
    setRequestUrlStub(request => {
        asked.push(request.url);
        return { status: 200, json: { models: [{ name: 'models/gemini-2.5-pro' }] } };
    });
    try {
        const result = await discoverHttpModels(
            ApiProvider.Gemini,
            settingsWith({ geminiApiKey: 'AIza-gemini-key' })
        );
        assert.equal(result.error, null);
        assert.equal(asked.length, 1);
        assert.match(asked[0], /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?key=AIza-gemini-key$/);
    } finally {
        setRequestUrlStub(null);
    }
});

test('a base URL is never handed out as a credential', () => {
    // OPENAI_BASE_URL used to sit in the key list, so a user with it exported got
    // "Authorization: Bearer http://localhost:8000/v1" sent to their server and a
    // settings line claiming the key came from a URL.
    const descriptor = getHttpProvider(ApiProvider.OpenAICompatible);
    assert.ok(descriptor);
    const settings = { ...DEFAULT_SETTINGS } as SpaceforgeSettings;
    settings.openaiCompatibleApiUrl = '';
    settings.openaiCompatibleApiKey = '';

    const seen: string[] = [];
    const originalEnv = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'http://localhost:8000/v1';
    try {
        assert.equal(resolveHttpKey(descriptor!, settings), null, 'the URL must not be read as a key');
        assert.equal(resolveHttpBaseUrl(descriptor!, settings), 'http://localhost:8000/v1',
            'the URL is still usable as the server address');

        // A real key is still a key, and the settings field still wins.
        process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-compatible';
        assert.equal(resolveHttpKey(descriptor!, settings), 'sk-compatible');
        settings.openaiCompatibleApiKey = 'sk-from-settings';
        assert.equal(resolveHttpKey(descriptor!, settings), 'sk-from-settings');
        settings.openaiCompatibleApiUrl = 'http://192.168.1.9:1234/v1/';
        assert.equal(resolveHttpBaseUrl(descriptor!, settings), 'http://192.168.1.9:1234/v1',
            'a stored URL wins over the environment, trailing slashes trimmed');
    } finally {
        delete process.env.OPENAI_COMPATIBLE_API_KEY;
        if (originalEnv === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = originalEnv;
        seen.push('restored');
    }
    assert.equal(seen.length, 1);
});

// ------------------------------------- 9. every company, reached the same way

test('every provider the plugin can be pointed at has a registry row', () => {
    const ids = HTTP_PROVIDERS.map(provider => provider.id);
    assert.equal(new Set(ids).size, ids.length, 'provider ids are unique');

    for (const id of Object.values(ApiProvider)) {
        if (id === ApiProvider.Cli) continue; // a CLI is not an HTTP endpoint
        assert.ok(ids.includes(id as ApiProvider), `${id} has no row in HTTP_PROVIDERS`);
    }

    for (const provider of HTTP_PROVIDERS) {
        assert.ok(provider.label.trim(), `${provider.id}: a label for the dropdown`);
        assert.ok(
            provider.endpoint.length > 0 || providerNeedsUrl(provider),
            `${provider.id}: either a fixed endpoint or one the reader supplies`,
        );
        for (const field of [provider.keyField, provider.modelField, provider.baseUrlField]) {
            assert.ok(field === undefined || field in DEFAULT_SETTINGS, `${provider.id}: ${String(field)} is not a setting`);
        }
    }
});

test('every hosted provider names its newest model; the ones that cannot are listed', () => {
    // These decide for themselves: a gateway whose catalogue is the only truth, a
    // local server, the generic OpenAI-compatible row, or a deployment whose name
    // the account owner chooses.
    const noCuratedNewest = new Set<string>([
        ApiProvider.OpenCode,
        ApiProvider.NanoGpt,
        ApiProvider.LmStudio,
        ApiProvider.AzureOpenai,
        ApiProvider.OpenAICompatible,
    ]);

    const missing = HTTP_PROVIDERS
        .filter(provider => !provider.latestModel && !noCuratedNewest.has(provider.id))
        .map(provider => provider.id);
    assert.deepEqual(missing, [], `a provider was added without its newest model: ${missing.join(', ')}`);

    for (const provider of HTTP_PROVIDERS.filter(entry => noCuratedNewest.has(entry.id))) {
        assert.equal(provider.latestModel, '', `${provider.id} is expected to let its own list decide`);
    }
});

test('the shared store holds the providers added later, and the original fields keep working', () => {
    const settings = settingsWith({});
    const xai = getHttpProvider(ApiProvider.Xai);
    assert.ok(xai);
    setProviderKey(xai, settings, 'xai-key');
    setProviderModel(xai, settings, xai.latestModel);
    assert.equal(providerStoredKey(xai, settings), 'xai-key');
    assert.equal(providerStoredModel(xai, settings), xai.latestModel);
    assert.equal(resolveHttpKey(xai, settings), 'xai-key');
    assert.deepEqual(settings.providerKeys, { xai: 'xai-key' }, 'one store, keyed by provider id');
    assert.equal(settings.openaiApiKey, '', 'and nothing leaks into the original fields');

    const openai = getHttpProvider(ApiProvider.OpenAI);
    assert.ok(openai);
    setProviderKey(openai, settings, 'sk-openai');
    setProviderModel(openai, settings, openai.latestModel);
    assert.equal(settings.openaiApiKey, 'sk-openai', 'the original six keep their own fields');
    assert.equal(settings.openaiModel, openai.latestModel);
});

test('a provider with no model chosen uses the newest one it ships', () => {
    const settings = settingsWith({});
    const deepseek = getHttpProvider(ApiProvider.Deepseek);
    assert.ok(deepseek);
    assert.equal(providerStoredModel(deepseek, settings), '', 'nothing stored');
    assert.ok(deepseek.latestModel, 'DeepSeek pins a newest model');
    assert.equal(providerModel(deepseek, settings), deepseek.latestModel, 'so the newest it ships is used');
    assert.equal(describeProviderGap(deepseek, settings), 'No key for DeepSeek: add one here, or put DEEPSEEK_API_KEY in your environment.');
    setProviderKey(deepseek, settings, 'sk-deepseek');
    assert.equal(describeProviderGap(deepseek, settings), null, 'a key is all it is missing');
});

test('a provider whose endpoint is the reader\u2019s says so, and works once given one', () => {
    const settings = settingsWith({});
    const azure = getHttpProvider(ApiProvider.AzureOpenai);
    assert.ok(azure);
    assert.equal(describeProviderGap(azure, settings), 'Azure OpenAI needs a URL.');
    assert.equal(resolveHttpBaseUrl(azure, settings), '', 'no URL, no endpoint');

    setProviderBaseUrl(azure, settings, 'https://my-resource.openai.azure.com/openai/deployments/gpt-5-mini/');
    assert.equal(resolveHttpBaseUrl(azure, settings), 'https://my-resource.openai.azure.com/openai/deployments/gpt-5-mini');
    assert.equal(
        httpProviderModelsUrl(azure, settings),
        'https://my-resource.openai.azure.com/openai/deployments?api-version=2024-10-21',
        'the list is the account\u2019s deployments',
    );
    assert.equal(
        httpProviderChatUrl(azure, settings),
        'https://my-resource.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2024-10-21',
        'a chat goes to the deployment, with the API version',
    );
});

test('an environment key counts for a provider added later, and detection names its newest model', async () => {
    const xai = getHttpProvider(ApiProvider.Xai);
    assert.ok(xai);
    const settings = settingsWith({});
    const saved = new Map(xai.envKeys.map(name => [name, process.env[name]]));
    try {
        for (const name of xai.envKeys) delete process.env[name];
        assert.equal(resolveHttpKey(xai, settings), null, 'nothing in the settings, nothing in the environment');

        process.env.XAI_API_KEY = 'xai-from-env';
        assert.equal(resolveHttpKey(xai, settings), 'xai-from-env');

        const status = (await detectProviders(settings)).find(entry => entry.id === ApiProvider.Xai);
        assert.ok(status);
        assert.equal(status.ready, true);
        assert.equal(status.credentialSource, 'environment');
        assert.match(status.message, /XAI_API_KEY/, 'detection says where the key came from');
        assert.ok(status.message.includes(xai.latestModel), 'and names the newest model');
        assert.equal(status.model, xai.latestModel, 'the model it would be asked for');
    } finally {
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('discovery reads each provider\u2019s own list shape', async () => {
    const asked: string[] = [];
    const lists: Record<string, unknown> = {
        'api.x.ai': { data: [{ id: 'grok-3-mini', created: 100 }, { id: 'grok-4.1-fast', created: 200 }, { id: 'grok-embed', created: 300 }] },
        'api.cohere.com': { models: [{ name: 'command-r-plus' }, { name: 'command-light' }] },
    };
    setRequestUrlStub(request => {
        asked.push(request.url);
        for (const [fragment, json] of Object.entries(lists)) {
            if (request.url.includes(fragment)) return { status: 200, json };
        }
        return { status: 404, json: {} };
    });
    try {
        const settings = settingsWith({ providerKeys: { xai: 'xai-key', cohere: 'co-key' } });

        const xai = await discoverHttpModels(ApiProvider.Xai, settings);
        assert.equal(xai.error, null);
        assert.equal(asked[0], 'https://api.x.ai/v1/models');
        assert.deepEqual(
            xai.models.map(model => model.id),
            ['grok-4.1-fast', 'grok-3-mini', 'grok-embed'],
            'newest first, and a non-chat model last',
        );
        assert.equal(xai.models[0].latest, true);
        assert.equal(xai.models.filter(model => model.latest).length, 1, 'exactly one newest');

        const cohere = await discoverHttpModels(ApiProvider.Cohere, settings);
        assert.equal(cohere.error, null);
        assert.equal(asked.at(-1), 'https://api.cohere.com/v1/models?page_size=1000');
        assert.deepEqual(cohere.models.map(model => model.id).sort(), ['command-light', 'command-r-plus']);
    } finally {
        setRequestUrlStub(null);
    }
});

test('a discovered list leads with the newest chat model, and only one is marked', () => {
    const ranked = rankModels([
        { id: 'text-embedding-3-large', source: 'api' },
        { id: 'gpt-4.1', source: 'api' },
        { id: 'gpt-5.1', source: 'api' },
        { id: 'whisper-1', source: 'api' },
        { id: 'gpt-5', source: 'api' },
    ], 'gpt-5.1');
    assert.deepEqual(
        ranked.map(model => model.id),
        ['gpt-5.1', 'gpt-5', 'gpt-4.1', 'text-embedding-3-large', 'whisper-1'],
    );
    assert.equal(ranked.filter(model => model.latest).length, 1, 'exactly one is marked newest');
    assert.equal(ranked[0].latest, true);

    // The provider has renamed its models since the registry was written: the top
    // chat model is marked instead, and the order still holds.
    const renamed = rankModels(
        [{ id: 'embed-x', source: 'api' }, { id: 'model-b', source: 'api' }, { id: 'model-a', source: 'api' }],
        'a-model-that-is-gone',
    );
    assert.deepEqual(renamed.map(model => model.id), ['model-a', 'model-b', 'embed-x']);
    assert.equal(renamed[0].latest, true);

    // A timestamp from the provider wins over any numbering in the id.
    const stamped = rankModels([
        { id: 'v1', source: 'api', created: 100 },
        { id: 'v2', source: 'api', created: 300 },
    ], '');
    assert.deepEqual(stamped.map(model => model.id), ['v2', 'v1']);
});

test('versionScore reads numbering and ignores date stamps', () => {
    assert.ok(versionScore('gpt-5.1') > versionScore('gpt-5'));
    assert.ok(versionScore('MiniMax-M3') > versionScore('MiniMax-M2'));
    assert.ok(versionScore('glm-5.1') > versionScore('glm-4.5'));
    assert.equal(versionScore('claude-3-sonnet-20240229'), versionScore('claude-3-sonnet'), 'a date is not a version');
    assert.equal(versionScore('llama'), 0);
});

test('a provider added later is spoken to in OpenAI\u2019s shape, with its own auth', () => {
    const settings = settingsWith({ providerKeys: { mistral: 'ms-key' } });
    const mistral = getHttpProvider(ApiProvider.Mistral);
    assert.ok(mistral);
    const request = buildOpenAiChatRequest(mistral, settings, {
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 64,
    });
    assert.equal(request.url, 'https://api.mistral.ai/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer ms-key');
    assert.equal(request.body.model, mistral.latestModel, 'the newest it ships, when none was chosen');
    assert.deepEqual((request.body.messages as unknown[]).length, 1);

    // Azure takes its key in its own header and adds the API version.
    const azureSettings = settingsWith({
        providerKeys: { 'azure-openai': 'az-key' },
        providerUrls: { 'azure-openai': 'https://res.openai.azure.com/openai/deployments/dep' },
    });
    const azure = getHttpProvider(ApiProvider.AzureOpenai);
    assert.ok(azure);
    const azureRequest = buildOpenAiChatRequest(azure, azureSettings, { messages: [] });
    assert.equal(azureRequest.url, 'https://res.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2024-10-21');
    assert.equal(azureRequest.headers['api-key'], 'az-key');
    assert.equal(azureRequest.headers.Authorization, undefined, 'not a bearer token');
});

test('Study reads a provider added later, and says what is missing', () => {
    const unconfigured = inspectChatProvider(settingsWith({ mcqApiProvider: ApiProvider.Moonshot }));
    assert.equal(unconfigured.label, 'Moonshot AI (Kimi)');
    assert.equal(unconfigured.ready, false);
    assert.match(unconfigured.reason ?? '', /No key for Moonshot/);

    const configured = inspectChatProvider(settingsWith({
        mcqApiProvider: ApiProvider.Moonshot,
        providerKeys: { moonshot: 'k' },
    }));
    assert.equal(configured.ready, true);
    const moonshot = getHttpProvider(ApiProvider.Moonshot);
    assert.ok(moonshot);
    assert.equal(configured.model, moonshot.latestModel, 'the newest model, with none chosen');
});

test('the non-OpenAI shapes are still the ones written by hand', () => {
    // Gemini, Claude and Ollama do not take OpenAI's body, so they must keep the
    // hand-written rows rather than fall through to the generic one.
    for (const id of [ApiProvider.Gemini, ApiProvider.Claude, ApiProvider.Ollama]) {
        const descriptor = getHttpProvider(id);
        assert.ok(descriptor);
        assert.equal(providerIsOpenAiShaped(descriptor), false, `${id} has its own shape`);
    }
    for (const id of [ApiProvider.Xai, ApiProvider.Groq, ApiProvider.Zai, ApiProvider.OpenCode, ApiProvider.HermesAgent]) {
        const descriptor = getHttpProvider(id);
        assert.ok(descriptor);
        assert.equal(providerIsOpenAiShaped(descriptor), true, `${id} speaks OpenAI's shape`);
    }
});

// ------------------------------- 10. every CLI is its own provider row

test('every CLI agent is offered as its own provider, with no second choice', () => {
    const choices = listProviders();
    const cliRows = choices.filter(choice => choice.kind === 'cli');
    assert.deepEqual(
        cliRows.map(row => row.id),
        CLI_AGENTS.map(agent => `cli:${agent.id}`),
        'one row per CLI agent, in the agents\u2019 own order',
    );
    for (const agent of CLI_AGENTS) {
        assert.equal(getCliProviderRow(`cli:${agent.id}`)?.label, agent.name, `${agent.id} is offered by name`);
        assert.equal(agentIdOfProvider(`cli:${agent.id}`), agent.id);
    }
    assert.equal(getCliProviderRow('openai'), undefined, 'a company is not a CLI');
    assert.equal(agentIdOfProvider('openai'), null);
    // The old converged row is gone: it exists only to migrate a saved vault.
    assert.equal(choices.some(choice => choice.id === ApiProvider.Cli), false);
    assert.deepEqual(
        choices.slice(0, cliRows.length).map(choice => choice.id),
        CLI_AGENTS.map(agent => `cli:${agent.id}`),
        'the CLIs come first: they need no key, so they are the shortest path',
    );
    assert.deepEqual(
        choices.slice(cliRows.length).map(choice => choice.id),
        HTTP_PROVIDERS.map(provider => provider.id),
        'and every company follows, in registry order',
    );
});

test('a saved single-CLI choice moves onto that CLI\u2019s own row, model and all', () => {
    const settings = settingsWith({
        mcqApiProvider: ApiProvider.Cli,
        cliAgent: 'codex',
        cliModel: 'gpt-5.5',
        providerModels: {},
    } as Partial<SpaceforgeSettings>);

    migrateSettings(settings);

    assert.equal(settings.mcqApiProvider, 'cli:codex', 'the row it now belongs to');
    assert.deepEqual(settings.providerModels, { 'cli:codex': 'gpt-5.5' }, 'and the model travels with it');
    assert.equal(settings.cliModel, '', 'the shared field is no longer read');
});

test('detection, model listing and Study all read a CLI by its provider id', async () => {
    const settings = settingsWith({ mcqApiProvider: 'cli:hermes' });

    const status = (await detectProviders(settings)).find(entry => entry.id === 'cli:hermes');
    assert.ok(status, 'the CLI reports under the id the settings store');
    assert.equal(status.kind, 'cli');

    // Study reads the CLI as a provider like any other.
    const inspected = inspectChatProvider(settings);
    assert.match(inspected.label, /\(CLI\)$/);
    assert.equal(inspected.ready, true, 'a CLI is usable: it brings its own login');
    assert.equal(inspected.model, 'default', 'and its own default, until one is chosen');

    // A model chosen for that CLI is the one reported, and only for that CLI.
    const chosen = settingsWith({
        mcqApiProvider: 'cli:hermes',
        providerModels: { 'cli:hermes': 'hermes-4-70b' },
    });
    assert.equal(inspectChatProvider(chosen).model, 'hermes-4-70b');

    // Model listing goes through the CLI\u2019s own catalog when it has no list endpoint.
    const listed = await discoverModels('cli:hermes', settings);
    assert.deepEqual(listed.models.map(model => model.id), ['default']);
});

test('no provider suggests a model from a generation that has been superseded', () => {
    // The shipped suggestion is what a reader sees first, and it is used when the
    // model field is left empty — so an ancient id here is a real failure, not a
    // cosmetic one. These markers are generations that have since been replaced;
    // the check is deliberately about families, not exact ids, because ids change
    // every few weeks and the registry is meant to be edited when they do.
    // A separator, escaped once: '/' inside a regex literal would end it.
    const sep = '(?:[.\\-/_:]|$)';
    const superseded = [
        new RegExp(`^gpt-[0-5]${sep}`, 'i'),
        new RegExp(`^gpt-3\\.5`, 'i'),
        new RegExp(`^text-davinci${sep}`, 'i'),
        new RegExp(`^o[1-4]${sep}`, 'i'),
        new RegExp(`^claude-[12]${sep}`, 'i'),
        new RegExp(`^claude-3${sep}`, 'i'),
        new RegExp(`^gemini-[12]${sep}`, 'i'),
        new RegExp(`^llama-?[123]${sep}`, 'i'),
        new RegExp(`^meta-llama/Llama-[123]${sep}`, 'i'),
        new RegExp(`^grok-[123]${sep}`, 'i'),
        new RegExp(`^command-r${sep}`, 'i'),
        new RegExp(`^deepseek-v[123]${sep}`, 'i'),
        /^deepseek-(chat|reasoner)$/i,
        new RegExp(`^mistral-(small|medium|large)-[123]${sep}`, 'i'),
        new RegExp(`^mixtral${sep}`, 'i'),
        new RegExp(`^qwen[12]${sep}`, 'i'),
        new RegExp(`^glm-[1-4]${sep}`, 'i'),
        new RegExp(`^MiniMax-M[12]${sep}`, 'i'),
        new RegExp(`^mimo-v2\\.[1-5]${sep}`, 'i'),
    ];

    const offenders: string[] = [];
    for (const provider of HTTP_PROVIDERS) {
        if (!provider.latestModel) continue;
        for (const pattern of superseded) {
            if (pattern.test(provider.latestModel)) {
                offenders.push(`${provider.id}: ${provider.latestModel}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `these providers ship a superseded model as their newest:\n${offenders.join('\n')}`);

    // The same for the plugin's own defaults, which a fresh install starts with.
    for (const [field, value] of Object.entries(DEFAULT_SETTINGS) as Array<[string, unknown]>) {
        if (!/Model$/.test(field) || typeof value !== 'string' || !value) continue;
        for (const pattern of superseded) {
            assert.doesNotMatch(value, pattern, `DEFAULT_SETTINGS.${field} is a superseded model`);
        }
    }
});

test('each CLI names the models it actually takes today', () => {
    const idsOf = (agent: CliAgentDef): string[] => agent.catalogModels.map(model => model.id);

    // Claude Code takes aliases, which track its own mapping — the newest family
    // included — so the catalog is families, not pinned ids.
    for (const alias of ['default', 'opus', 'sonnet', 'haiku', 'fable']) {
        assert.ok(idsOf(claudeAgent).includes(alias), `Claude Code offers ${alias}`);
    }

    // Codex takes real ids, and older ones are retired on the sign-in side.
    assert.ok(idsOf(codexAgent).includes('gpt-6.1-sol'), 'Codex offers the current model');
    assert.ok(idsOf(codexAgent).includes('default'));

    // Gemini CLI has its own set: the newest it is optimised for is 3.8 Flash, and
    // Gemini 4 Argon is deliberately absent — Google points at Antigravity for it.
    assert.ok(idsOf(geminiAgent).includes('gemini-3.8-flash'));
    assert.equal(idsOf(geminiAgent).some(id => /argon/i.test(id)), false, 'not a Gemini CLI model');

    // Cursor prints its own list at run time (`--list-models`), so it needs no
    // curated ids: the default is enough, and the live list is the truth.
    assert.deepEqual(idsOf(cursorAgent), ['default']);
    assert.ok(cursorAgent.listModels, 'Cursor is asked for its list rather than guessed at');
});

// ------------------------------------------ 11. Antigravity, the Gemini successor

test('Antigravity is offered like every other CLI, and driven over stream-json', () => {
    const agent = getCliAgent('antigravity');
    assert.ok(agent, 'Antigravity is one of the agents');
    assert.equal(agent.bin, 'agy');
    assert.ok(listProviders().some(choice => choice.id === 'cli:antigravity'), 'and offered as a provider');
    assert.ok(CLI_AGENTS.includes(agent), 'it is in the list the settings read');

    // The protocol is explicit: `agy -p -` silently breaks from 1.2.7 on, so the
    // prompt travels as an NDJSON turn instead.
    assert.deepEqual(
        agent.buildArgs({ prompt: 'write me questions' }),
        ['--input-format', 'stream-json', '--output-format', 'stream-json'],
    );
    assert.deepEqual(
        agent.buildArgs({ prompt: 'x', model: 'gemini-3.8-flash-high' }),
        ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-high'],
    );

    const payload = agent.wrapStdin?.('write me questions');
    assert.ok(payload);
    assert.equal(payload.endsWith('\n'), true, 'one line');
    assert.deepEqual(JSON.parse(payload.trim()), {
        event: 'user',
        message: { content: 'write me questions' },
    });
});

test('Antigravity’s event stream is read into the answer', () => {
    const agent = getCliAgent('antigravity');
    const parse = (line: string): string[] => {
        const result = agent?.parseLine?.(line);
        const list = Array.isArray(result) ? result : [result];
        return list.flatMap(one => (one && one.kind === 'text' ? [one.text] : []));
    };

    assert.deepEqual(parse('{"event":"init","session":{}}'), [], 'init says nothing to us');
    assert.deepEqual(
        parse('{"event":"step_update","step_update":{"step_type":"agent_response","state":"ACTIVE","text_delta":"1. What is "}}'),
        ['1. What is '],
        'a text delta is part of the answer',
    );
    assert.deepEqual(
        parse('{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"grep"}}'),
        [],
        'tool activity is the CLI’s business, not the answer',
    );
    assert.deepEqual(
        parse('{"event":"result","result":{"status":"SUCCESS","response":"1. What is ATP?"}}'),
        ['1. What is ATP?'],
        'the result carries the final text',
    );
    // A failed post-turn step can still carry the answer, so it is not thrown away.
    const errorLine = agent?.parseLine?.('{"event":"result","result":{"status":"ERROR","error":"checkpoint failed","response":"1. What is ATP?"}}');
    assert.deepEqual(Array.isArray(errorLine) ? errorLine : [errorLine], [{ kind: 'text', text: '1. What is ATP?' }]);

    const failed = agent?.parseLine?.('{"event":"result","result":{"status":"FAILED","error":"quota"}}');
    assert.deepEqual(Array.isArray(failed) ? failed : [failed], [{ kind: 'error', message: 'quota' }]);
});

test('Antigravity’s own model list is read from `agy models`', () => {
    const agent = getCliAgent('antigravity');
    assert.deepEqual(agent?.listModels?.args, ['models'], 'the CLI is asked, not guessed at');
    const parsed = agent?.listModels?.parse(
        'gemini-3.8-flash-high   Gemini 3.8 Flash (High)\n' +
        'claude-opus-5-thinking-high   Claude Opus 5 Thinking\n' +
        'fetching models...\n' +
        'gemini-3.8-flash-high   Gemini 3.8 Flash (High)\n'
    );
    assert.deepEqual(parsed, [
        { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
        { id: 'claude-opus-5-thinking-high', label: 'Claude Opus 5 Thinking' },
    ], 'two columns, deduplicated, diagnostics skipped');
});
