import { requestUrl } from 'obsidian';
import { ApiProvider, ProviderId, SpaceforgeSettings } from '../models/settings';
import { createCliChatClient } from './cli/cli-chat-client';
import { getCliAgent } from './cli/cli-agents';
import { CliAgentDef } from './cli/cli-types';
import {
    agentIdOfProvider,
    cliModelFor,
    describeProviderGap,
    getHttpProvider,
    HttpProviderDescriptor,
    httpProviderChatUrl,
    providerIsOpenAiShaped,
    providerModel,
    resolveHttpKey,
} from './provider-registry';
import { findJsonObject } from '../utils/tutor-protocol';
import { CLAUDE, GEMINI, OLLAMA, OPENAI, OPENAI_COMPATIBLE, OPENROUTER, TOGETHER_AI } from '../ui/constants';

/**
 * A single provider-agnostic chat client.
 *
 * The MCQ generator has one implementation per provider because it only ever
 * needs a single prompt/response round trip. Interactive tutoring needs real
 * multi-turn conversations, token limits, JSON modes and honest errors, and
 * duplicating that seven times would rot immediately. So this module holds the
 * one table that describes how each provider is spoken to, and everything
 * above it is provider-blind.
 */

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ChatRequest {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    /** Ask the backend for strict JSON output where it supports it. */
    json?: boolean;
    /** Context window hint for local backends (Ollama num_ctx). */
    contextWindow?: number;
}

export interface ChatResult {
    text: string;
    providerLabel: string;
    model: string;
    /** Wall-clock duration of the request in milliseconds. */
    durationMs: number;
    /** Provider's stop reason, e.g. 'stop' or 'length'. */
    finishReason: string | null;
    /**
     * True when the provider says it stopped because it ran out of room.
     * Callers should retry with less input rather than blame the content.
     */
    truncated: boolean;
}

export interface ChatClient {
    readonly providerLabel: string;
    readonly model: string;
    send(request: ChatRequest): Promise<ChatResult>;
}

/** Raised for any provider failure, with a message fit to show a user. */
export class ChatClientError extends Error {
    /** HTTP status when the failure came from the transport. */
    status: number | null;
    /** Raw response body, for the troubleshooting expander. */
    detail: string | null;

    constructor(message: string, status: number | null = null, detail: string | null = null) {
        super(message);
        this.name = 'ChatClientError';
        this.status = status;
        this.detail = detail;
    }
}

/** Build an error message from a provider error body. */
function describeError(status: number, body: string): string {
    let message = body;
    try {
        const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
        message = parsed.error?.message ?? parsed.message ?? body;
    } catch {
        // Body was not JSON; the raw text is the best we have.
    }
    const trimmed = (message || '').trim();
    return `Request failed (${status})${trimmed ? `: ${trimmed.slice(0, 400)}` : ''}`;
}

interface ProviderDescriptor {
    label: string;
    /**
     * True when the body is OpenAI's chat shape. Only there can the
     * token-limit fallback retry a rejected `max_tokens`: Gemini has no such
     * field, and Claude *requires* it, so stripping or renaming it would turn
     * a clear error into a confusing one.
     */
    openAiBody: boolean;
    /** Returns a human-readable reason when the provider is not usable. */
    missing(settings: SpaceforgeSettings): string | null;
    model(settings: SpaceforgeSettings): string;
    build(settings: SpaceforgeSettings, request: ChatRequest): {
        url: string;
        headers: Record<string, string>;
        body: Record<string, unknown>;
    };
    extract(response: Record<string, unknown>): string;
    /** Where the provider records why generation stopped. */
    finishReason?(response: Record<string, unknown>): string | null;
}

/**
 * Read the assistant message out of an OpenAI-shaped response.
 *
 * Thinking models (qwen3.x, deepseek-r1 style, and most local builds) can spend
 * the entire token budget inside `reasoning_content` and return an empty
 * `content`. That is not an empty response, it is a truncated one, and the
 * caller needs to be told which — so a JSON object found in the reasoning is
 * used as the answer, and otherwise the error says what to change.
 */
const openAiMessageExtract = (response: Record<string, unknown>): string => {
    const choices = response.choices as Array<{
        message?: { content?: string; reasoning_content?: string; reasoning?: string };
        finish_reason?: string;
    }> | undefined;
    const choice = choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim().length > 0) return content;

    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
        const salvage = findJsonObject(reasoning);
        if (salvage) return salvage;
        throw new ChatClientError(
            choice?.finish_reason === 'length'
                ? 'The model spent its whole token budget on reasoning before answering. Raise "Maximum output tokens per turn" in the Study settings (2000-4000 is reasonable for a thinking model).'
                : 'The model returned reasoning but no answer.'
        );
    }

    throw new ChatClientError('The provider returned an empty response.');
};

const trimSlash = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value);

/**
 * Provider/model pairs observed to reject every token-limit spelling.
 *
 * A router can serve one model from several upstreams, some of which reject
 * the cap while others accept it. Once the uncapped request has succeeded for
 * a model, retrying the rejected spellings on every later turn would only add
 * latency and failed requests; remember the fact for this session.
 */
const tokenLimitUnsupported = new Set<string>();

/** Identity of a provider/model pair, for the token-cap capability cache. */
export const chatModelKey = (label: string, model: string): string => `${label}\u0000${model}`;

/**
 * Whether the model belongs to an OpenAI reasoning family.
 *
 * o-series and GPT-5+ models replaced `max_tokens` with
 * `max_completion_tokens`, and reject a non-default temperature while they
 * reason. Routers keep the vendor prefix (`openai/gpt-6.1-sol`), so only the
 * last path segment is inspected.
 */
function isReasoningModel(model: string): boolean {
    const name = model.trim().toLowerCase().split('/').pop() ?? '';
    return /^(o[1-9]|gpt-[5-9])(?:[.\-_]|$)/.test(name);
}

/**
 * The sampling and output-limit fields a model accepts.
 *
 * Sending the wrong token-limit spelling rejects the whole request, so the
 * model id decides the shape rather than the provider: the same endpoint can
 * serve a model that wants each one.
 */
function openAiRequestFields(model: string, request: ChatRequest): Record<string, unknown> {
    const reasoning = isReasoningModel(model);
    const fields: Record<string, unknown> = {};
    if (typeof request.temperature === 'number' && !reasoning) {
        fields.temperature = request.temperature;
    }
    if (typeof request.maxTokens === 'number') {
        fields[reasoning ? 'max_completion_tokens' : 'max_tokens'] = request.maxTokens;
    }
    return fields;
}

/**
 * The same body with the other token-limit spelling, when the provider's
 * complaint names the one that was sent.
 *
 * `max_tokens` and `max_completion_tokens` express the same intent, and which
 * one a route accepts can differ from the endpoint's own documentation — a
 * router may hand the request to an upstream with different rules. One retry
 * costs a rejected request; refusing to retry costs the feature.
 */
function alternateTokenLimit(
    body: Record<string, unknown>,
    status: number,
    text: string
): Record<string, unknown> | null {
    if (status !== 400) return null;
    if (typeof body.max_tokens === 'number' && /max_tokens/i.test(text)) {
        const retry = { ...body };
        delete retry.max_tokens;
        retry.max_completion_tokens = body.max_tokens;
        return retry;
    }
    if (typeof body.max_completion_tokens === 'number' && /max_completion_tokens/i.test(text)) {
        const retry = { ...body };
        delete retry.max_completion_tokens;
        retry.max_tokens = body.max_completion_tokens;
        return retry;
    }
    return null;
}

/**
 * The same body with no token-limit field at all.
 *
 * Some routers forward requests to several upstreams, and only some of them
 * accept either spelling. The same endpoint can reject `max_tokens`, reject
 * `max_completion_tokens`, and then accept the identical request with no cap.
 * When that happens, dropping the cap is the difference between a working
 * feature and a 400; the provider's own default applies.
 */
function withoutTokenLimit(
    body: Record<string, unknown>,
    status: number,
    text: string
): Record<string, unknown> | null {
    if (status !== 400) return null;
    if (!/max_(completion_)?tokens/i.test(text)) return null;
    if (typeof body.max_tokens !== 'number' && typeof body.max_completion_tokens !== 'number') return null;
    const retry = { ...body };
    delete retry.max_tokens;
    delete retry.max_completion_tokens;
    return retry;
}

/**
 * POST an OpenAI-shaped chat request, retrying only the parts of the body the
 * provider has just told us it cannot take.
 *
 * Shared by the Study client and the multiple-choice generator so a router's
 * token-cap quirk is learned once for both, and a model that rejects the cap
 * does not keep failing on every feature.
 */
export async function postOpenAiChat(
    url: string,
    headers: Record<string, string>,
    requestBody: Record<string, unknown>,
    cacheKey: string | null = null,
    tokenFallback = true
): Promise<Awaited<ReturnType<typeof requestUrl>>> {
    const body = { ...requestBody };
    if (cacheKey && tokenLimitUnsupported.has(cacheKey)) {
        delete body.max_tokens;
        delete body.max_completion_tokens;
    }
    const post = (payload: Record<string, unknown>) => requestUrl({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        throw: false,
    });

    let response = await post(body);
    if (!tokenFallback) return response;

    // A model can reject the token-limit spelling its endpoint's
    // documentation promised (an upstream route with different rules). Ask
    // once more with the other spelling before failing.
    const retry = alternateTokenLimit(body, response.status, response.text ?? '');
    if (retry) {
        response = await post(retry);
        // The route may reject both spellings outright. The cap is an
        // optimisation, not part of the answer: drop it and let the
        // provider's default apply rather than lose the turn.
        const bare = withoutTokenLimit(retry, response.status, response.text ?? '');
        if (bare) {
            response = await post(bare);
            if (cacheKey && response.status >= 200 && response.status < 300) {
                tokenLimitUnsupported.add(cacheKey);
            }
        }
    }
    return response;
}

/** Stop reason out of an OpenAI-shaped response. */
const openAiFinishReason = (response: Record<string, unknown>): string | null => {
    const choices = response.choices as Array<{ finish_reason?: string }> | undefined;
    return choices?.[0]?.finish_reason ?? null;
};

/** Stop reason out of a Gemini response. */
const geminiFinishReason = (response: Record<string, unknown>): string | null => {
    const candidates = response.candidates as Array<{ finishReason?: string }> | undefined;
    return candidates?.[0]?.finishReason ?? null;
};

/** Stop reason out of a Claude response. */
const claudeFinishReason = (response: Record<string, unknown>): string | null => {
    const reason = response.stop_reason;
    return typeof reason === 'string' ? (reason === 'max_tokens' ? 'length' : reason) : null;
};

/**
 * Every provider that is spoken to over HTTP. The local-CLI provider is not in
 * here on purpose: it is not a request the plugin builds, it is a process the
 * CLI runs, and it is branched off before this table is consulted.
 */
const PROVIDERS: Partial<Record<ApiProvider, ProviderDescriptor>> = {
    [ApiProvider.OpenRouter]: {
        label: OPENROUTER,
        openAiBody: true,
        missing: s => (s.openRouterApiKey ? null : `${OPENROUTER} API key is not set`),
        model: s => s.openRouterModel,
        build: (s, r) => ({
            url: 'https://openrouter.ai/api/v1/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${s.openRouterApiKey}`,
                'HTTP-Referer': 'https://obsidian.md',
                'X-Title': 'Spaceforge Plugin for Obsidian',
            },
            body: {
                model: s.openRouterModel,
                messages: r.messages,
                ...openAiRequestFields(s.openRouterModel, r),
            },
        }),
        extract: openAiMessageExtract,
        finishReason: openAiFinishReason,
    },
    [ApiProvider.OpenAI]: {
        label: OPENAI,
        openAiBody: true,
        missing: s => (s.openaiApiKey ? null : `${OPENAI} API key is not set`),
        model: s => s.openaiModel,
        build: (s, r) => ({
            url: 'https://api.openai.com/v1/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${s.openaiApiKey}`,
            },
            body: {
                model: s.openaiModel,
                messages: r.messages,
                ...openAiRequestFields(s.openaiModel, r),
                ...(r.json ? { response_format: { type: 'json_object' } } : {}),
            },
        }),
        extract: openAiMessageExtract,
        finishReason: openAiFinishReason,
    },
    [ApiProvider.OpenAICompatible]: {
        label: OPENAI_COMPATIBLE,
        openAiBody: true,
        missing: s => {
            if (!s.openaiCompatibleApiUrl) return `${OPENAI_COMPATIBLE} API URL is not set`;
            if (!s.openaiCompatibleModel) return `${OPENAI_COMPATIBLE} model is not set`;
            return null;
        },
        model: s => s.openaiCompatibleModel,
        build: (s, r) => {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (s.openaiCompatibleApiKey) {
                headers['Authorization'] = `Bearer ${s.openaiCompatibleApiKey}`;
            }
            return {
                url: `${trimSlash(s.openaiCompatibleApiUrl)}/chat/completions`,
                headers,
                body: {
                    model: s.openaiCompatibleModel,
                    messages: r.messages,
                    ...openAiRequestFields(s.openaiCompatibleModel, r),
                },
            };
        },
        extract: openAiMessageExtract,
        finishReason: openAiFinishReason,
    },
    [ApiProvider.Ollama]: {
        label: OLLAMA,
        openAiBody: false,
        missing: s => {
            if (!s.ollamaApiUrl) return `${OLLAMA} URL is not set`;
            if (!s.ollamaModel) return `${OLLAMA} model is not set`;
            return null;
        },
        model: s => s.ollamaModel,
        build: (s, r) => ({
            url: `${trimSlash(s.ollamaApiUrl)}/api/chat`,
            headers: { 'Content-Type': 'application/json' },
            body: {
                model: s.ollamaModel,
                messages: r.messages,
                stream: false,
                // Small local models drift badly without a JSON constraint and
                // silently truncate long notes without an explicit context size.
                ...(r.json ? { format: 'json' } : {}),
                options: {
                    temperature: r.temperature,
                    num_predict: r.maxTokens,
                    ...(r.contextWindow ? { num_ctx: r.contextWindow } : {}),
                },
            },
        }),
        extract: response => {
            const message = response.message as { content?: string; thinking?: string } | undefined;
            if (typeof message?.content === 'string' && message.content.trim().length > 0) return message.content;
            // Think-style models expose the trace separately and may leave
            // content empty when the budget runs out mid-thought.
            if (typeof message?.thinking === 'string' && message.thinking.trim().length > 0) {
                const salvaged = findJsonObject(message.thinking);
                if (salvaged) return salvaged;
                throw new ChatClientError('Ollama used the whole token budget on reasoning. Raise "Maximum output tokens per turn" in the Study settings.');
            }
            throw new ChatClientError('Ollama returned an empty response.');
        },
        finishReason: response => {
            const reason = response.done_reason;
            return typeof reason === 'string' ? (reason === 'length' ? 'length' : reason) : null;
        },
    },
    [ApiProvider.Gemini]: {
        label: GEMINI,
        openAiBody: false,
        missing: s => {
            if (!s.geminiApiKey) return `${GEMINI} API key is not set`;
            if (!s.geminiModel) return `${GEMINI} model is not set`;
            return null;
        },
        model: s => s.geminiModel,
        build: (s, r) => {
            const system = r.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
            const contents = r.messages
                .filter(m => m.role !== 'system')
                .map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }],
                }));
            const generationConfig: Record<string, unknown> = {};
            if (typeof r.temperature === 'number') generationConfig.temperature = r.temperature;
            if (typeof r.maxTokens === 'number') generationConfig.maxOutputTokens = r.maxTokens;
            if (r.json) generationConfig.responseMimeType = 'application/json';

            return {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${s.geminiModel}:generateContent?key=${s.geminiApiKey}`,
                headers: { 'Content-Type': 'application/json' },
                body: {
                    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
                    contents,
                    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
                },
            };
        },
        extract: response => {
            const candidates = response.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
            const parts = candidates?.[0]?.content?.parts;
            const text = (parts ?? []).map(p => p.text ?? '').join('').trim();
            if (!text) throw new ChatClientError('Gemini returned an empty response.');
            return text;
        },
        finishReason: geminiFinishReason,
    },
    [ApiProvider.Claude]: {
        label: CLAUDE,
        openAiBody: false,
        missing: s => {
            if (!s.claudeApiKey) return `${CLAUDE} API key is not set`;
            if (!s.claudeModel) return `${CLAUDE} model is not set`;
            return null;
        },
        model: s => s.claudeModel,
        build: (s, r) => {
            const system = r.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
            const messages = r.messages
                .filter(m => m.role !== 'system')
                .map(m => ({ role: m.role, content: m.content }));
            return {
                url: 'https://api.anthropic.com/v1/messages',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': s.claudeApiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: {
                    model: s.claudeModel,
                    max_tokens: r.maxTokens ?? 2048,
                    ...(typeof r.temperature === 'number' ? { temperature: r.temperature } : {}),
                    ...(system ? { system } : {}),
                    messages,
                },
            };
        },
        extract: response => {
            const content = response.content as Array<{ text?: string }> | undefined;
            const text = (content ?? []).map(part => part.text ?? '').join('').trim();
            if (!text) throw new ChatClientError('Claude returned an empty response.');
            return text;
        },
        finishReason: claudeFinishReason,
    },
    [ApiProvider.Together]: {
        label: TOGETHER_AI,
        openAiBody: true,
        missing: s => {
            if (!s.togetherApiKey) return `${TOGETHER_AI} API key is not set`;
            if (!s.togetherModel) return `${TOGETHER_AI} model is not set`;
            return null;
        },
        model: s => s.togetherModel,
        build: (s, r) => ({
            url: 'https://api.together.xyz/v1/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${s.togetherApiKey}`,
            },
            body: {
                model: s.togetherModel,
                messages: r.messages,
                ...openAiRequestFields(s.togetherModel, r),
            },
        }),
        extract: openAiMessageExtract,
        finishReason: openAiFinishReason,
    },
};

/**
 * One OpenAI-shaped request, built from the registry row for a provider.
 *
 * Shared with the multiple-choice path (api/openai-http-service.ts): both speak
 * to the same endpoint with the same auth and the same body, and a second copy
 * of this would be the copy that goes stale. `response_format` is deliberately
 * not sent here — the hand-written OpenAI and OpenRouter rows ask for it, and a
 * provider that does not know the field would refuse the whole request.
 */
export function buildOpenAiChatRequest(
    descriptor: HttpProviderDescriptor,
    settings: SpaceforgeSettings,
    request: ChatRequest
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const key = resolveHttpKey(descriptor, settings);
    const model = providerModel(descriptor, settings);
    return {
        url: httpProviderChatUrl(descriptor, settings),
        headers: {
            'Content-Type': 'application/json',
            ...(key && descriptor.authHeaders ? descriptor.authHeaders(key) : {}),
        },
        body: {
            model,
            messages: request.messages,
            ...openAiRequestFields(model, request),
        },
    };
}

/**
 * The registry row as a chat provider, for every OpenAI-shaped endpoint there
 * is. That covers the companies added after the original six — xAI, Mistral,
 * DeepSeek, Groq, Fireworks, Cohere, MiniMax, Xiaomi's MiMo, Z.AI, Moonshot,
 * OpenCode, NanoGPT, LM Studio, a local Hermes gateway, Azure deployments — so a
 * new company needs a row in the registry and no code here.
 */
function registryDescriptor(id: ApiProvider): ProviderDescriptor | null {
    const http = getHttpProvider(id);
    if (!http || !providerIsOpenAiShaped(http)) return null;
    return {
        label: http.label,
        openAiBody: true,
        missing: settings => describeProviderGap(http, settings),
        model: settings => providerModel(http, settings),
        build: (settings, request) => buildOpenAiChatRequest(http, settings, request),
        extract: openAiMessageExtract,
        finishReason: openAiFinishReason,
    };
}

/**
 * The local CLI a provider id names: `cli:claude` is Claude Code, and a vault
 * that still holds the old single `cli` choice is read as the agent it stored.
 */
function cliAgentFor(settings: SpaceforgeSettings): CliAgentDef | null {
    const provider = settings.mcqApiProvider;
    const agentId = agentIdOfProvider(provider)
        ?? (provider === ApiProvider.Cli ? settings.cliAgent : null);
    return agentId ? getCliAgent(agentId) ?? null : null;
}

/** The model a CLI provider was given, or '' for the CLI's own default. */
function cliModelForProvider(settings: SpaceforgeSettings, agent: CliAgentDef): string {
    const fromRow = cliModelFor(settings, agent.id);
    return fromRow || (settings.mcqApiProvider === ApiProvider.Cli ? settings.cliModel : '');
}

/** The hand-written rows first, then the registry's generic shape. */
function descriptorFor(provider: ProviderId): ProviderDescriptor | undefined {
    if (agentIdOfProvider(provider)) return undefined;
    const id = provider as ApiProvider;
    return PROVIDERS[id] ?? registryDescriptor(id) ?? undefined;
}

/** Which provider the Study feature will use, and why not if it cannot. */
export function inspectChatProvider(settings: SpaceforgeSettings): {
    provider: ProviderId;
    label: string;
    model: string;
    ready: boolean;
    reason: string | null;
} {
    const provider = settings.mcqApiProvider;
    const agent = cliAgentFor(settings);
    if (agent) {
        // Whether the CLI is *installed* is a question for the detection probe in
        // the settings screen; here the only failure worth naming is "none chosen".
        return {
            provider,
            label: `${agent.name} (CLI)`,
            model: cliModelForProvider(settings, agent) || 'default',
            ready: true,
            reason: null,
        };
    }
    if (agentIdOfProvider(provider) || provider === ApiProvider.Cli) {
        return { provider, label: 'Local CLI', model: '', ready: false, reason: 'No local CLI chosen yet' };
    }
    const descriptor = descriptorFor(provider);
    if (!descriptor) {
        return { provider, label: 'Unknown', model: '', ready: false, reason: 'Unsupported API provider selected' };
    }
    const reason = descriptor.missing(settings);
    return {
        provider,
        label: descriptor.label,
        model: descriptor.model(settings),
        ready: reason === null,
        reason,
    };
}

/**
 * Create a chat client for the configured provider.
 *
 * Returns null when the provider is not usable yet; `inspectChatProvider`
 * carries the reason so callers can explain it in the UI.
 */
export function createChatClient(settings: SpaceforgeSettings): ChatClient | null {
    const provider = settings.mcqApiProvider;
    const agent = cliAgentFor(settings);
    if (agent) {
        // The whole task path — questions, tutoring, charting — runs through the
        // CLI exactly as it would through an HTTP provider; only the transport
        // differs, and the CLI brings its own credentials.
        return createCliChatClient(agent.id, cliModelForProvider(settings, agent));
    }
    const descriptor = descriptorFor(provider);
    if (!descriptor || descriptor.missing(settings) !== null) return null;

    const label = descriptor.label;
    const model = descriptor.model(settings);

    return {
        providerLabel: label,
        model,
        send: async (request: ChatRequest): Promise<ChatResult> => {
            const started = Date.now();
            const built = descriptor.build(settings, request);

            let response;
            try {
                response = await postOpenAiChat(
                    built.url,
                    built.headers,
                    built.body,
                    chatModelKey(label, model),
                    descriptor.openAiBody
                );
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                throw new ChatClientError(`${label} could not be reached: ${msg}`);
            }

            if (response.status < 200 || response.status >= 300) {
                throw new ChatClientError(describeError(response.status, response.text), response.status, response.text?.slice(0, 2000) ?? null);
            }

            let parsed: Record<string, unknown>;
            try {
                parsed = response.json as Record<string, unknown>;
            } catch {
                throw new ChatClientError(`${label} returned a response that was not valid JSON.`, response.status, response.text?.slice(0, 2000) ?? null);
            }

            let text: string;
            try {
                text = descriptor.extract(parsed);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                throw new ChatClientError(`${label}: ${msg}`, response.status, response.text?.slice(0, 2000) ?? null);
            }

            const finishReason = descriptor.finishReason ? descriptor.finishReason(parsed) : null;
            return {
                text,
                providerLabel: label,
                model,
                durationMs: Date.now() - started,
                finishReason,
                truncated: finishReason === 'length' || finishReason === 'max_tokens' || finishReason === 'MAX_TOKENS',
            };
        },
    };
}
