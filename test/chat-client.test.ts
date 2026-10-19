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

import { createChatClient } from '../api/chat-client';
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
        assert.equal(body.max_completion_tokens, Math.max(6000, settings.studyMaxTokens * 4));
    } finally {
        setRequestUrlStub(null);
    }
});
