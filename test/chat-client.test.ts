/**
 * The chat client's provider plumbing, at the two seams that bit us:
 *
 *  - the output-token field is model-specific. OpenAI's o-series and GPT-5+
 *    models reject `max_tokens`, and a provider may reject it too when a
 *    router hands the request to such a model upstream;
 *  - the client is built from the settings, so a long-lived service must not
 *    cache one: changing the provider has to change where the next request goes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CLAUDE_UNCAPPED_MAX_TOKENS, createChatClient, statedTokenCeiling } from '../api/chat-client';
import { ApiProvider, DEFAULT_SETTINGS, SpaceforgeSettings } from '../models/settings';
import { getDomainProfile } from '../models/study-domains';
import { StudyVisualService } from '../services/study-visuals-service';
import { setRequestUrlStub, StubRequestUrlRequest } from './support/obsidian-shim';

function settingsWith(overrides: Partial<SpaceforgeSettings>): SpaceforgeSettings {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

/** The material answer, in the shape the visual service accepts. */
const VISUAL_REPLY = JSON.stringify({
    mindMap: {
        title: 'Map',
        root: { id: 'root', label: 'Root', children: [{ id: 'child', label: 'Child' }] },
    },
    visuals: [],
    summary: { title: 'Summary', bullets: [{ text: 'A fact worth keeping' }] },
});

test('OpenAI reasoning models get max_completion_tokens, and no sampling temperature', async () => {
    const seen: StubRequestUrlRequest[] = [];
    setRequestUrlStub(request => {
        seen.push(request);
        return { status: 200, json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } };
    });

    try {
        const client = createChatClient(settingsWith({
            mcqApiProvider: ApiProvider.OpenAI,
            openaiApiKey: 'test-key',
            openaiModel: 'gpt-6.1-sol',
        }));
        assert.ok(client);

        const result = await client.send({
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.2,
            maxTokens: 128,
        });

        assert.equal(result.text, 'ok');
        const body = JSON.parse(seen[0].body ?? '{}') as Record<string, unknown>;
        assert.equal(body.max_completion_tokens, 128);
        assert.equal(body.max_tokens, undefined, 'the rejected spelling is not sent');
        assert.equal(body.temperature, undefined, 'reasoning models reject non-default sampling');
    } finally {
        setRequestUrlStub(null);
    }
});

test('older OpenAI models keep max_tokens and temperature', async () => {
    const seen: StubRequestUrlRequest[] = [];
    setRequestUrlStub(request => {
        seen.push(request);
        return { status: 200, json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } };
    });

    try {
        const client = createChatClient(settingsWith({
            mcqApiProvider: ApiProvider.OpenAI,
            openaiApiKey: 'test-key',
            openaiModel: 'gpt-4.1',
        }));
        assert.ok(client);

        await client.send({
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.2,
            maxTokens: 128,
        });

        const body = JSON.parse(seen[0].body ?? '{}') as Record<string, unknown>;
        assert.equal(body.max_tokens, 128);
        assert.equal(body.max_completion_tokens, undefined);
        assert.equal(body.temperature, 0.2);
    } finally {
        setRequestUrlStub(null);
    }
});

test('a route that rejects max_tokens is retried with max_completion_tokens', async () => {
    const seen: StubRequestUrlRequest[] = [];
    setRequestUrlStub(request => {
        seen.push(request);
        if (seen.length === 1) {
            return {
                status: 400,
                text: JSON.stringify({
                    error: {
                        message: 'The requested parameter values are not supported for this model: max_tokens. Remove or change the listed parameters.',
                    },
                }),
            };
        }
        return { status: 200, json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } };
    });

    try {
        const client = createChatClient(settingsWith({
            mcqApiProvider: ApiProvider.OpenAICompatible,
            openaiCompatibleApiUrl: 'http://localhost:1234/v1',
            openaiCompatibleModel: 'mystery-1',
            openaiCompatibleApiKey: 'k',
        }));
        assert.ok(client);

        const result = await client.send({
            messages: [{ role: 'user', content: 'hi' }],
            maxTokens: 64,
        });

        assert.equal(result.text, 'ok');
        assert.equal(seen.length, 2, 'one rejected attempt, one successful retry');
        const first = JSON.parse(seen[0].body ?? '{}') as Record<string, unknown>;
        const second = JSON.parse(seen[1].body ?? '{}') as Record<string, unknown>;
        assert.equal(first.max_tokens, 64);
        assert.equal(second.max_completion_tokens, 64);
        assert.equal(second.max_tokens, undefined);
    } finally {
        setRequestUrlStub(null);
    }
});

test('a route that rejects both token spellings is retried without a cap', async () => {
    const seen: StubRequestUrlRequest[] = [];
    setRequestUrlStub(request => {
        seen.push(request);
        if (seen.length <= 2) {
            const token = seen.length === 1 ? 'max_tokens' : 'max_completion_tokens';
            return {
                status: 400,
                text: JSON.stringify({
                    error: {
                        message: `The requested parameter values are not supported for this model: ${token}. Remove or change the listed parameters.`,
                    },
                }),
            };
        }
        return { status: 200, json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } };
    });

    try {
        const client = createChatClient(settingsWith({
            mcqApiProvider: ApiProvider.OpenAICompatible,
            openaiCompatibleApiUrl: 'http://localhost:1234/v1',
            openaiCompatibleModel: 'mystery-1',
            openaiCompatibleApiKey: 'k',
        }));
        assert.ok(client);

        const result = await client.send({
            messages: [{ role: 'user', content: 'hi' }],
            maxTokens: 64,
        });

        assert.equal(result.text, 'ok');
        assert.equal(seen.length, 3, 'two rejected spellings, then an uncapped request');
        const bare = JSON.parse(seen[2].body ?? '{}') as Record<string, unknown>;
        assert.equal(bare.max_tokens, undefined);
        assert.equal(bare.max_completion_tokens, undefined);

        // The capability is remembered: the next turn goes straight to the
        // uncapped request instead of paying for the same two 400s.
        assert.equal((await client.send({ messages: [{ role: 'user', content: 'again' }], maxTokens: 64 })).text, 'ok');
        assert.equal(seen.length, 4, 'one request, with no token-cap probes');
        const cached = JSON.parse(seen[3].body ?? '{}') as Record<string, unknown>;
        assert.equal(cached.max_tokens, undefined);
        assert.equal(cached.max_completion_tokens, undefined);
    } finally {
        setRequestUrlStub(null);
    }
});

test('Study material reads the provider again after the settings change', async () => {
    const seen: StubRequestUrlRequest[] = [];
    setRequestUrlStub(request => {
        seen.push(request);
        return { status: 200, json: { choices: [{ message: { content: VISUAL_REPLY }, finish_reason: 'stop' }] } };
    });

    const settings = settingsWith({
        mcqApiProvider: ApiProvider.OpenAICompatible,
        openaiCompatibleApiUrl: 'http://first.test/v1',
        openaiCompatibleModel: 'first-model',
        openaiCompatibleApiKey: 'k',
    });
    const service = new StudyVisualService({ settings } as never);
    const request = {
        notePath: 'notes/one.md',
        content: 'Some content worth drawing',
        objectives: [],
        fingerprint: 'one',
        profile: getDomainProfile('general'),
    };

    try {
        assert.ok(await service.generate(request));
        assert.match(seen[0].url, /first\.test/);

        // The reader picks another provider while the plugin is still running.
        settings.mcqApiProvider = ApiProvider.OpenAI;
        settings.openaiApiKey = 'k';
        settings.openaiModel = 'gpt-6.1-sol';

        assert.ok(await service.generate({ ...request, notePath: 'notes/two.md', fingerprint: 'two' }));
        assert.equal(seen.length, 2);
        assert.match(seen[1].url, /api\.openai\.com/, 'the next generation uses the new provider');
        const body = JSON.parse(seen[1].body ?? '{}') as Record<string, unknown>;
        assert.equal(body.model, 'gpt-6.1-sol');
        // Material is never capped: a cut-off answer is invalid JSON, a lost pack.
        assert.equal(body.max_completion_tokens, undefined);
        assert.equal(body.max_tokens, undefined);
    } finally {
        setRequestUrlStub(null);
    }
});

test('Claude with no cap asks for the longest answer, then retries at the ceiling the model names', async () => {
    const seen: Array<Record<string, unknown>> = [];
    setRequestUrlStub(request => {
        const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
        seen.push(body);
        if ((body.max_tokens as number) > 32000) {
            return {
                status: 400,
                text: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${String(body.max_tokens)} > 32000, which is the maximum allowed number of output tokens for claude-ceiling-test` } }),
            };
        }
        return { status: 200, json: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } };
    });
    try {
        const client = createChatClient(settingsWith({
            mcqApiProvider: ApiProvider.Claude,
            claudeApiKey: 'k',
            claudeModel: 'claude-ceiling-test',
        }));
        assert.ok(client);
        assert.equal((await client.send({ messages: [{ role: 'user', content: 'hi' }] })).text, 'ok');
        assert.equal(seen[0].max_tokens, CLAUDE_UNCAPPED_MAX_TOKENS, 'the first ask is uncapped in effect');
        assert.equal(seen[1].max_tokens, 32000, 'the retry uses the model\'s own ceiling');

        // The ceiling is remembered: the next turn does not fail first.
        await client.send({ messages: [{ role: 'user', content: 'again' }] });
        assert.equal(seen.length, 3);
        assert.equal(seen[2].max_tokens, 32000);
    } finally {
        setRequestUrlStub(null);
    }
});

test('a refusal is read for the ceiling it names, in both vendors\' wording', () => {
    assert.equal(statedTokenCeiling('max_tokens: 64000 > 8192, which is the maximum allowed number of output tokens for claude-3-5-haiku'), 8192);
    assert.equal(statedTokenCeiling('max_tokens is too large: 100000. This model supports at most 16384 completion tokens, whereas you provided 100000.'), 16384);
    assert.equal(statedTokenCeiling('This model\'s maximum context length is 128000 tokens.'), null, 'a context limit is not an output ceiling');
});
