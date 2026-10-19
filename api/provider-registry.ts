import { requestUrl } from 'obsidian';
import { ApiProvider, ProviderId, SpaceforgeSettings } from '../models/settings';
import { CLI_AGENTS, getCliAgent } from './cli/cli-agents';
import { CliDetectionResult, detectCliAgent } from './cli/cli-detection';
import { fetchCliModels } from './cli/cli-models';
import { getEnvVar } from './cli/cli-runner';
import { CliModelEntry } from './cli/cli-types';

/**
 * One place that knows every way this plugin can reach a model.
 *
 * Two kinds live here. HTTP providers need a key, and each one will list its own
 * models if asked — so no model id in the settings has to be typed from memory
 * or left to rot (the shipped defaults, `gpt-3.5-turbo` and `gemini-pro`, were
 * exactly that rot). CLI providers need nothing at all: the agent CLI installed
 * on the machine already has a login, and it is the one that talks to the model.
 *
 * A provider counts as *detected* when it can actually be used right now: a key
 * in the settings, a key in the environment, a local daemon answering, or a CLI
 * on the PATH that says it is signed in. Detection is honest about which of
 * those it found, because "no models found" and "no credentials" are different
 * problems for the user to fix.
 *
 * Every provider also carries the **newest model it ships** (`latestModel`), so
 * it is usable the moment a key is pasted, and `rankModels` puts a live list into
 * the same order: chat models, newest first, the newest marked. Nothing here
 * claims a model exists — the mark reads as "newest in this list", and the field
 * that falls back to the known one says so.
 */

export interface DiscoveredModel {
    id: string;
    label?: string;
    /** Where the id came from, so the UI can be honest about staleness. */
    source: 'api' | 'catalog' | 'cli';
    /** The newest chat model in the list it came from. */
    latest?: boolean;
    /** Provider-reported creation time, when the list carries one. */
    created?: number;
}

export interface ProviderStatus {
    id: string;
    label: string;
    kind: 'http' | 'cli';
    /** Ready to use right now. */
    ready: boolean;
    /** A key was found, a daemon answered, or a CLI is signed in. */
    configured: boolean;
    level: 'ok' | 'warn' | 'error';
    message: string;
    /** Where the credential came from, when we found one. */
    credentialSource: 'settings' | 'environment' | 'local' | 'cli' | null;
    models: DiscoveredModel[];
    /** The model this provider would be asked for as things stand. */
    model?: string;
    /** Set for CLI providers. */
    detection?: CliDetectionResult;
}

export interface HttpProviderDescriptor {
    id: ApiProvider;
    label: string;
    /** Settings field holding the key — the original providers' own fields. */
    keyField?: keyof SpaceforgeSettings;
    /** …or the shared per-provider store (everyone added later). */
    keyInStore?: boolean;
    modelField?: keyof SpaceforgeSettings;
    modelInStore?: boolean;
    baseUrlField?: keyof SpaceforgeSettings;
    baseUrlInStore?: boolean;
    /**
     * Where this provider is spoken to when nothing overrides it. Empty for a
     * provider whose address is the reader's to supply (an OpenAI-compatible
     * server, an Azure resource) — those say "not set" until they have one.
     */
    endpoint: string;
    /** Environment variables that also count as "configured", in priority order. */
    envKeys: string[];
    /**
     * Environment variables that hold a base URL rather than a key. Kept apart
     * so a URL can never be picked up as a credential.
     */
    envBaseUrls?: string[];
    /** The newest chat model this provider ships right now. */
    latestModel: string;
    /**
     * Where the model list lives. OpenAI's own `${base}/models` by default. The
     * key is passed in because Gemini's list wants it in the query string rather
     * than a header — reading it from anywhere else is how a provider ends up
     * asked with another provider's key.
     */
    modelsUrl?(base: string, key: string | null): string;
    /** How to read that list. OpenAI-shaped by default. */
    parseModels?(json: unknown): CliModelEntry[];
    authHeaders?(key: string): Record<string, string>;
    /** The chat endpoint, when it is not simply `${base}/chat/completions`. */
    chatUrl?(base: string): string;
    /** A key is not required (a local daemon, or a public list). */
    keyOptional?: boolean;
    /** A local daemon: detected by answering, not by holding a key. */
    local?: boolean;
    /** A placeholder for the key field. */
    keyPlaceholder?: string;
    /** One line under the provider's rows: which URL a plan uses, what to replace. */
    note?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

const trimSlash = (value: string): string => value.replace(/\/+$/, '');

function parseOpenAiStyleList(json: unknown): CliModelEntry[] {
    const root = asRecord(json);
    const data = Array.isArray(root?.data) ? (root?.data as unknown[]) : [];
    const models: CliModelEntry[] = [];
    for (const entry of data) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = stringField(record, 'id', 'name', 'model');
        if (!id) continue;
        const label = stringField(record, 'display_name', 'displayName', 'name');
        const created = typeof record.created === 'number' ? record.created : undefined;
        models.push({
            id,
            ...(label && label !== id ? { label } : {}),
            ...(created !== undefined ? { created } : {}),
        });
    }
    return models;
}

/** Cohere's own list shape: `{ models: [{ name }] }`. */
function parseCohereList(json: unknown): CliModelEntry[] {
    const root = asRecord(json);
    const list = Array.isArray(root?.models) ? (root?.models as unknown[]) : [];
    const models: CliModelEntry[] = [];
    for (const entry of list) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = stringField(record, 'name', 'id');
        if (id) models.push({ id });
    }
    return models;
}

/** Azure lists *deployments*; the deployment name is what a request needs. */
function parseAzureDeployments(json: unknown): CliModelEntry[] {
    const root = asRecord(json);
    const data = Array.isArray(root?.data) ? (root?.data as unknown[]) : [];
    const models: CliModelEntry[] = [];
    for (const entry of data) {
        const record = asRecord(entry);
        if (!record) continue;
        const id = stringField(record, 'id', 'name');
        if (id) models.push({ id });
    }
    return models;
}

function ollamaBase(settings: SpaceforgeSettings): string {
    const configured = (settings.ollamaApiUrl ?? '').trim();
    const base = configured || getEnvVar('OLLAMA_HOST') || 'http://localhost:11434';
    // OLLAMA_HOST may be a bare host:port; the API needs a scheme.
    const withScheme = /^https?:\/\//i.test(base) ? base : `http://${base}`;
    return trimSlash(withScheme);
}

/** Bearer auth, which is what most of these APIs take. */
const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

/** Azure takes the key in its own header, not as a bearer token. */
const azureAuth = (key: string): Record<string, string> => ({ 'api-key': key });

/** The API version Azure OpenAI's data plane is called with. */
const AZURE_API_VERSION = '2024-10-21';

/** Azure's resource root, from a deployment URL. */
function azureRoot(base: string): string {
    const trimmed = trimSlash(base.trim());
    const at = trimmed.indexOf('/openai/');
    return at >= 0 ? trimmed.slice(0, at + '/openai'.length) : trimmed;
}

/**
 * The OpenAI-compatible server: its endpoint is the reader's to supply. Named,
 * not inline, because its model URL is built from the descriptor.
 */
const openAiCompatibleDescriptor: HttpProviderDescriptor = {
    id: ApiProvider.OpenAICompatible,
    label: 'OpenAI-compatible server',
    keyField: 'openaiCompatibleApiKey',
    modelField: 'openaiCompatibleModel',
    baseUrlField: 'openaiCompatibleApiUrl',
    endpoint: '',
    envKeys: ['OPENAI_COMPATIBLE_API_KEY'],
    envBaseUrls: ['OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_API_URL'],
    latestModel: '',
    authHeaders: key => (key ? bearer(key) : {}),
    keyOptional: true,
    keyPlaceholder: 'Key, if the server wants one',
};

/**
 * Gemini's descriptor, named rather than found by position: reordering the table
 * below must not hand another provider's field to its model URL.
 */
const geminiDescriptor: HttpProviderDescriptor = {
    id: ApiProvider.Gemini,
    label: 'Gemini',
    keyField: 'geminiApiKey',
    modelField: 'geminiModel',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    latestModel: 'gemini-4-argon',
    keyPlaceholder: 'AIza…',
    modelsUrl: (base, key) => `${base}/models${key ? `?key=${encodeURIComponent(key)}` : ''}`,
    parseModels: json => {
        const root = asRecord(json);
        const list = Array.isArray(root?.models) ? (root?.models as unknown[]) : [];
        const models: CliModelEntry[] = [];
        for (const entry of list) {
            const record = asRecord(entry);
            if (!record) continue;
            const raw = stringField(record, 'name');
            if (!raw) continue;
            // The API returns "models/gemini-2.5-pro"; the SDKs take the tail.
            const id = raw.replace(/^models\//, '');
            const label = stringField(record, 'displayName');
            models.push(label ? { id, label } : { id });
        }
        return models;
    },
};

/**
 * The HTTP half of the registry: every endpoint this plugin can be pointed at.
 * The original six read their key and model from their own settings fields (no
 * vault needs a migration); everyone added since keeps them in the shared
 * per-provider store, so a new company is a row here and nothing else.
 */
export const HTTP_PROVIDERS: HttpProviderDescriptor[] = [
    {
        id: ApiProvider.OpenRouter,
        label: 'OpenRouter',
        keyField: 'openRouterApiKey',
        modelField: 'openRouterModel',
        endpoint: 'https://openrouter.ai/api/v1',
        envKeys: ['OPENROUTER_API_KEY'],
        latestModel: 'openai/gpt-6.1-sol',
        keyPlaceholder: 'sk-or-…',
        authHeaders: bearer,
        note: 'One key for the models of every company OpenRouter carries.',
    },
    {
        id: ApiProvider.OpenAI,
        label: 'OpenAI',
        keyField: 'openaiApiKey',
        modelField: 'openaiModel',
        endpoint: 'https://api.openai.com/v1',
        envKeys: ['OPENAI_API_KEY'],
        latestModel: 'gpt-6.1-sol',
        keyPlaceholder: 'sk-…',
        authHeaders: bearer,
    },
    {
        id: ApiProvider.Ollama,
        label: 'Ollama (local)',
        modelField: 'ollamaModel',
        baseUrlField: 'ollamaApiUrl',
        endpoint: 'http://localhost:11434',
        envKeys: [],
        envBaseUrls: ['OLLAMA_HOST'],
        latestModel: 'qwen3.8:27b',
        keyOptional: true,
        local: true,
        modelsUrl: base => `${base}/api/tags`,
        parseModels: json => {
            const root = asRecord(json);
            const list = Array.isArray(root?.models) ? (root?.models as unknown[]) : [];
            const models: CliModelEntry[] = [];
            for (const entry of list) {
                const record = asRecord(entry);
                if (!record) continue;
                const id = stringField(record, 'model', 'name');
                if (id) models.push({ id });
            }
            return models;
        },
    },
    geminiDescriptor,
    {
        id: ApiProvider.Claude,
        label: 'Claude (API)',
        keyField: 'claudeApiKey',
        modelField: 'claudeModel',
        endpoint: 'https://api.anthropic.com/v1',
        envKeys: ['ANTHROPIC_API_KEY'],
        latestModel: 'claude-opus-5-5',
        keyPlaceholder: 'sk-ant-…',
        authHeaders: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
        parseModels: json => {
            const root = asRecord(json);
            const list = Array.isArray(root?.data) ? (root?.data as unknown[]) : [];
            const models: CliModelEntry[] = [];
            for (const entry of list) {
                const record = asRecord(entry);
                if (!record) continue;
                const id = stringField(record, 'id');
                if (!id) continue;
                const label = stringField(record, 'display_name');
                models.push(label ? { id, label } : { id });
            }
            return models;
        },
    },
    {
        id: ApiProvider.Together,
        label: 'Together AI',
        keyField: 'togetherApiKey',
        modelField: 'togetherModel',
        endpoint: 'https://api.together.xyz/v1',
        envKeys: ['TOGETHER_API_KEY'],
        latestModel: 'Qwen/Qwen3.8-2.4T-A95B',
        authHeaders: bearer,
    },
    {
        id: ApiProvider.Xai,
        label: 'xAI (Grok)',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.x.ai/v1',
        envKeys: ['XAI_API_KEY', 'GROK_API_KEY'],
        latestModel: 'grok-4.7',
        // No Fast variant exists on the public API, so grok-4.7 is the id to send.
        note: 'Grok 4.7 Fast runs only in Cursor and Grok Build: the public API takes grok-4.7.',
        keyPlaceholder: 'xai-…',
        authHeaders: bearer,
    },
    {
        id: ApiProvider.Mistral,
        label: 'Mistral AI',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.mistral.ai/v1',
        envKeys: ['MISTRAL_API_KEY'],
        latestModel: 'mistral-large-4',
        // Pinned rather than mistral-large-latest: the alias still points at Large 3.
        note: 'Mistral Large 4 runs as mistral-large-4. The -latest alias still points at Large 3.',
        authHeaders: bearer,
    },
    {
        id: ApiProvider.Deepseek,
        label: 'DeepSeek',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.deepseek.com/v1',
        envKeys: ['DEEPSEEK_API_KEY'],
        latestModel: 'deepseek-flash',
        // The old deepseek-chat / deepseek-reasoner names were retired in July 2026.
        note: 'DeepSeek-V4.1-Flash answers as deepseek-flash. The old deepseek-chat and deepseek-reasoner names are gone.',
        keyPlaceholder: 'sk-…',
        authHeaders: bearer,
    },
    {
        id: ApiProvider.Groq,
        label: 'Groq',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.groq.com/openai/v1',
        envKeys: ['GROQ_API_KEY'],
        latestModel: 'qwen/qwen3.8-27b',
        keyPlaceholder: 'gsk_…',
        authHeaders: bearer,
    },
    {
        id: ApiProvider.Fireworks,
        label: 'Fireworks AI',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.fireworks.ai/inference/v1',
        envKeys: ['FIREWORKS_API_KEY'],
        latestModel: 'accounts/fireworks/models/ember-1',
        keyPlaceholder: 'fw_…',
        authHeaders: bearer,
        note: 'Model ids are full paths: accounts/fireworks/models/…',
    },
    {
        id: ApiProvider.Cohere,
        label: 'Cohere',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.cohere.com/compatibility/v1',
        envKeys: ['COHERE_API_KEY', 'CO_API_KEY'],
        latestModel: 'command-a-plus-05-2026',
        authHeaders: bearer,
        modelsUrl: () => 'https://api.cohere.com/v1/models?page_size=1000',
        parseModels: parseCohereList,
        note: 'Chat runs through Cohere’s OpenAI-compatible endpoint.',
    },
    {
        id: ApiProvider.Minimax,
        label: 'MiniMax',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.minimax.io/v1',
        envKeys: ['MINIMAX_API_KEY'],
        latestModel: 'MiniMax-M3',
        keyPlaceholder: 'sk-… or sk-cp-…',
        authHeaders: bearer,
        note: 'The pay-as-you-go API and a coding token plan share this URL.',
    },
    {
        id: ApiProvider.Mimo,
        label: 'Xiaomi MiMo',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.xiaomimimo.com/v1',
        envKeys: ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY'],
        latestModel: 'mimo-v2.6-pro',
        keyPlaceholder: 'sk-…',
        authHeaders: bearer,
        note: 'Pay-as-you-go API. A token plan uses the base URL on its own page.',
    },
    {
        id: ApiProvider.Zai,
        label: 'Z.AI (GLM)',
        keyInStore: true,
        modelInStore: true,
        baseUrlInStore: true,
        endpoint: 'https://api.z.ai/api/paas/v4',
        envKeys: ['ZAI_API_KEY', 'Z_AI_API_KEY', 'GLM_API_KEY'],
        latestModel: 'glm-5.3',
        authHeaders: bearer,
        note: 'A GLM Coding Plan subscription uses the same key at https://api.z.ai/api/coding/paas/v4 — put that in the URL field.',
    },
    {
        id: ApiProvider.Moonshot,
        label: 'Moonshot AI (Kimi)',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://api.moonshot.ai/v1',
        envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
        latestModel: 'kimi-k3',
        authHeaders: bearer,
    },
    {
        id: ApiProvider.OpenCode,
        label: 'OpenCode (Zen, Go, local)',
        keyInStore: true,
        modelInStore: true,
        baseUrlInStore: true,
        endpoint: 'https://opencode.ai/zen/v1',
        envKeys: ['OPENCODE_API_KEY'],
        latestModel: '',
        keyOptional: true,
        keyPlaceholder: 'OpenCode key, unless you run a local server',
        authHeaders: bearer,
        note: 'Zen is the endpoint here, Go is https://opencode.ai/inference/go/v1, and a local server answers at http://localhost:3000/v1 with no key. Each tier serves a different set, so press Find models rather than typing an id.',
    },
    {
        id: ApiProvider.NanoGpt,
        label: 'NanoGPT',
        keyInStore: true,
        modelInStore: true,
        endpoint: 'https://nano-gpt.com/api/v1',
        envKeys: ['NANOGPT_API_KEY', 'NANO_GPT_API_KEY'],
        latestModel: '',
        keyPlaceholder: 'nano-…',
        authHeaders: bearer,
        // Its catalogue is a live list that changes daily (669 models today), so
        // pinning one would be stale within the week: Find models reads the truth.
        note: 'A router: its model list changes daily, so press Find models and pick from what it serves today.',
    },
    {
        id: ApiProvider.LmStudio,
        label: 'LM Studio (local)',
        keyInStore: true,
        modelInStore: true,
        baseUrlInStore: true,
        endpoint: 'http://localhost:1234/v1',
        envKeys: [],
        envBaseUrls: ['LM_STUDIO_URL', 'LMSTUDIO_HOST'],
        latestModel: '',
        keyOptional: true,
        local: true,
        keyPlaceholder: 'Any key, if you set one in LM Studio',
        authHeaders: bearer,
        note: 'Start LM Studio with a model loaded; no key is needed.',
    },
    {
        id: ApiProvider.HermesAgent,
        label: 'Hermes agent (local)',
        keyInStore: true,
        modelInStore: true,
        baseUrlInStore: true,
        endpoint: 'http://localhost:8642/v1',
        envKeys: ['HERMES_API_KEY'],
        envBaseUrls: ['HERMES_API_URL'],
        latestModel: 'hermes-agent',
        keyOptional: true,
        local: true,
        keyPlaceholder: 'change-me-local-dev',
        authHeaders: bearer,
        note: 'A Hermes gateway on this machine, OpenAI-compatible. A keyless install answers without one.',
    },
    {
        id: ApiProvider.AzureOpenai,
        label: 'Azure OpenAI',
        keyInStore: true,
        modelInStore: true,
        baseUrlInStore: true,
        endpoint: '',
        envKeys: ['AZURE_OPENAI_API_KEY'],
        envBaseUrls: ['AZURE_OPENAI_ENDPOINT'],
        // A deployment name is the account owner's to choose, so there is no
        // newest id to pin; the URL field carries the deployment.
        latestModel: '',
        keyPlaceholder: 'Azure key 1 or 2',
        authHeaders: azureAuth,
        modelsUrl: base => `${azureRoot(base)}/deployments?api-version=${AZURE_API_VERSION}`,
        parseModels: parseAzureDeployments,
        chatUrl: base => `${trimSlash(base)}/chat/completions?api-version=${AZURE_API_VERSION}`,
        note: 'Set the URL to https://<resource>.openai.azure.com/openai/deployments/<deployment>; the model is that deployment name.',
    },
    openAiCompatibleDescriptor,
];

// ------------------------------------------------------------------- the CLIs

/** Every local agent CLI is a provider of its own: `cli:claude`, `cli:codex`, … */
export const CLI_PROVIDER_PREFIX = 'cli:';

export function cliProviderId(agentId: string): ProviderId {
    return `${CLI_PROVIDER_PREFIX}${agentId}`;
}

/** The CLI agent behind a provider id, or null when it is an HTTP provider. */
export function agentIdOfProvider(id: string | undefined): string | null {
    return id && id.startsWith(CLI_PROVIDER_PREFIX) ? id.slice(CLI_PROVIDER_PREFIX.length) : null;
}

/** One local CLI, as the settings offer it. */
export interface CliProviderRow {
    id: ProviderId;
    label: string;
    agentId: string;
}

export function cliProviderRows(): CliProviderRow[] {
    return CLI_AGENTS.map(agent => ({ id: cliProviderId(agent.id), label: agent.name, agentId: agent.id }));
}

export function getCliProviderRow(id: string | undefined): CliProviderRow | undefined {
    const agentId = agentIdOfProvider(id);
    if (!agentId) return undefined;
    const labels = cliProviderRows();
    return labels.find(row => row.agentId === agentId);
}

/**
 * One row per provider the reader can choose, in the order they are offered: the
 * local CLIs first — the ones that need no key and no account, so they are the
 * shortest path to a working provider — then the companies.
 */
export interface ProviderChoice {
    id: ProviderId;
    label: string;
    kind: 'http' | 'cli';
}

export function listProviders(): ProviderChoice[] {
    return [
        ...cliProviderRows().map(row => ({ id: row.id, label: row.label, kind: 'cli' as const })),
        ...HTTP_PROVIDERS.map(provider => ({ id: provider.id as ProviderId, label: provider.label, kind: 'http' as const })),
    ];
}

/** The label of any provider id, for a status line or a model cache. */
export function providerLabel(id: string): string {
    return getHttpProvider(id)?.label ?? getCliProviderRow(id)?.label ?? id;
}

/** The model a local CLI was given; its own default when nothing is stored. */
export function cliModelFor(settings: SpaceforgeSettings, agentId: string): string {
    return (settings.providerModels?.[cliProviderId(agentId)] ?? '').trim();
}

export function setCliModelFor(settings: SpaceforgeSettings, agentId: string, value: string): void {
    settings.providerModels = { ...settings.providerModels, [cliProviderId(agentId)]: value };
}

// ------------------------------------------------------------------ settings

/** The key stored for a provider (not the environment's). */
function storedKey(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings): string {
    if (descriptor.keyInStore) return (settings.providerKeys?.[descriptor.id] ?? '').trim();
    if (descriptor.keyField) {
        const stored = settings[descriptor.keyField];
        if (typeof stored === 'string') return stored.trim();
    }
    return '';
}

/** The model stored for a provider, with nothing filled in. */
function storedModel(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings): string {
    if (descriptor.modelInStore) return (settings.providerModels?.[descriptor.id] ?? '').trim();
    if (descriptor.modelField) {
        const stored = settings[descriptor.modelField];
        if (typeof stored === 'string') return stored.trim();
    }
    return '';
}

function storedBaseUrl(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings): string {
    if (descriptor.baseUrlInStore) return (settings.providerUrls?.[descriptor.id] ?? '').trim();
    if (descriptor.baseUrlField) {
        const stored = settings[descriptor.baseUrlField];
        if (typeof stored === 'string') return stored.trim();
    }
    return '';
}

/**
 * What is stored for a provider, exactly as stored: the settings fields show
 * these, so an empty field reads as "nothing here" rather than "the default is
 * in force". The environment and the registry's own defaults are applied by the
 * `resolve*` functions instead.
 */
export const providerStoredKey = storedKey;
export const providerStoredModel = storedModel;
export const providerStoredUrl = storedBaseUrl;

/**
 * The model this provider will be asked for: what the reader chose, else the
 * newest model the provider ships. The fallback is what makes "paste a key and
 * go" work, and the model field names it rather than leaving it a surprise.
 */
export function providerModel(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings): string {
    return storedModel(descriptor, settings) || descriptor.latestModel;
}

export function setProviderModel(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings, value: string): void {
    if (descriptor.modelInStore) {
        settings.providerModels = { ...settings.providerModels, [descriptor.id]: value };
        return;
    }
    if (descriptor.modelField) {
        (settings as unknown as Record<string, string>)[descriptor.modelField] = value;
    }
}

export function setProviderKey(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings, value: string): void {
    if (descriptor.keyInStore) {
        settings.providerKeys = { ...settings.providerKeys, [descriptor.id]: value };
        return;
    }
    if (descriptor.keyField) {
        (settings as unknown as Record<string, string>)[descriptor.keyField] = value;
    }
}

export function setProviderBaseUrl(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings, value: string): void {
    if (descriptor.baseUrlInStore) {
        settings.providerUrls = { ...settings.providerUrls, [descriptor.id]: value };
        return;
    }
    if (descriptor.baseUrlField) {
        (settings as unknown as Record<string, string>)[descriptor.baseUrlField] = value;
    }
}

/** True when this provider's endpoint is the reader's to supply. */
export function providerNeedsUrl(descriptor: HttpProviderDescriptor): boolean {
    return Boolean(descriptor.baseUrlField || descriptor.baseUrlInStore);
}

/**
 * The base URL for a provider: the settings field when it is filled in, else the
 * first environment variable that names one, else the endpoint it ships with
 * (empty for a provider whose address only the reader knows). Never a key.
 */
export function resolveHttpBaseUrl(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings): string {
    const stored = storedBaseUrl(descriptor, settings);
    if (stored) return trimSlash(stored);
    for (const name of descriptor.envBaseUrls ?? []) {
        const value = getEnvVar(name);
        if (value) return trimSlash(value.trim());
    }
    if (descriptor.id === ApiProvider.Ollama) return ollamaBase(settings);
    return trimSlash(descriptor.endpoint);
}

export function getHttpProvider(id: string | undefined): HttpProviderDescriptor | undefined {
    return HTTP_PROVIDERS.find(provider => provider.id === id);
}

/** A key from the settings, else from the environment. */
export function resolveHttpKey(
    descriptor: HttpProviderDescriptor,
    settings: SpaceforgeSettings
): string | null {
    const stored = storedKey(descriptor, settings);
    if (stored) return stored;
    for (const name of descriptor.envKeys) {
        const value = getEnvVar(name);
        if (value) return value;
    }
    return null;
}

/** Why this provider cannot be used as things stand, or null when it can. */
export function describeProviderGap(
    descriptor: HttpProviderDescriptor,
    settings: SpaceforgeSettings
): string | null {
    if (providerNeedsUrl(descriptor) && !resolveHttpBaseUrl(descriptor, settings)) {
        return `${descriptor.label} needs a URL.`;
    }
    const key = resolveHttpKey(descriptor, settings);
    if (!key && !descriptor.keyOptional) {
        return `No key for ${descriptor.label}: add one here, or put ${descriptor.envKeys[0] ?? 'a key'} in your environment.`;
    }
    if (!providerModel(descriptor, settings)) {
        return `${descriptor.label} needs a model id.`;
    }
    return null;
}

function keySource(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings): ProviderStatus['credentialSource'] {
    if (storedKey(descriptor, settings)) return 'settings';
    for (const name of descriptor.envKeys) {
        if (getEnvVar(name)) return 'environment';
    }
    return null;
}

/** Gemini, Claude and Ollama each have their own request shape. */
const NATIVE_SHAPES = new Set<ApiProvider>([ApiProvider.Gemini, ApiProvider.Claude, ApiProvider.Ollama]);

/** True when this provider is spoken to in OpenAI's chat shape. */
export function providerIsOpenAiShaped(descriptor: HttpProviderDescriptor): boolean {
    return !NATIVE_SHAPES.has(descriptor.id);
}

/** The URL a provider's model list lives at. */
export function httpProviderModelsUrl(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings): string {
    const base = resolveHttpBaseUrl(descriptor, settings);
    if (descriptor.modelsUrl) return descriptor.modelsUrl(base, resolveHttpKey(descriptor, settings));
    return `${base}/models`;
}

/** The URL a chat request is sent to. */
export function httpProviderChatUrl(descriptor: HttpProviderDescriptor, settings: SpaceforgeSettings): string {
    const base = resolveHttpBaseUrl(descriptor, settings);
    if (descriptor.chatUrl) return descriptor.chatUrl(base);
    return `${base}/chat/completions`;
}

// ------------------------------------------------------------------ ordering

/** Models that are not chat models: they never answer a tutoring turn. */
const NON_CHAT = /embed|whisper|tts|audio|image|dall-e|davinci|moderation|rerank|transcri|voice|speech|ocr|vision-encoder/i;

/**
 * A rough recency score read out of a model id: the first major(.minor) run,
 * with date stamps removed so `claude-3-sonnet-20240229` does not read as
 * version 2024. Only ever used to order a list; nothing is chosen by it.
 */
export function versionScore(id: string): number {
    const withoutDates = id.replace(/\d{8}/g, '').replace(/-\d{4}-\d{2}-\d{2}/g, '');
    const match = /(\d+)(?:[._](\d+))?/.exec(withoutDates);
    if (!match) return 0;
    return Number(match[1]) * 100 + Number(match[2] ?? 0);
}

/**
 * The provider's own list, ordered the way a reader wants it: the newest chat
 * model first. A `created` timestamp wins when the provider gives one, and the
 * numbering in the id is the fallback (`gpt-5.1` above `gpt-4.1`, `M3` above
 * `M2`); non-chat models (embeddings, speech, image) go to the end. The model
 * the registry knows as newest is pinned first when the list carries it, and the
 * top chat model is marked `latest` either way — read as "newest in this list",
 * nothing more.
 */
export function rankModels(models: DiscoveredModel[], latestModel?: string): DiscoveredModel[] {
    const ranked = models.map(model => ({
        model,
        known: Boolean(latestModel) && model.id === latestModel,
        chat: !NON_CHAT.test(model.id),
        created: model.created ?? 0,
        version: versionScore(model.id),
    }));

    ranked.sort((a, b) =>
        Number(b.known) - Number(a.known) ||
        Number(b.chat) - Number(a.chat) ||
        (b.created - a.created) ||
        (b.version - a.version) ||
        a.model.id.localeCompare(b.model.id));

    const ordered = ranked.map(entry => ({ ...entry.model }));
    const top = ordered.find(model => !NON_CHAT.test(model.id)) ?? ordered[0];
    if (top) top.latest = true;
    return ordered;
}

// ---------------------------------------------------------------- discovery

export interface DiscoveryResult {
    models: DiscoveredModel[];
    error: string | null;
}

/**
 * Ask one provider for its models. Only the JSON shape differs between them, so
 * the request itself is shared; failures come back as a message rather than an
 * exception, because a settings screen must be able to show "could not reach"
 * without falling over.
 */
export async function discoverHttpModels(
    id: string,
    settings: SpaceforgeSettings
): Promise<DiscoveryResult> {
    const descriptor = getHttpProvider(id);
    if (!descriptor) return { models: [], error: `Unknown provider: ${id}` };

    const key = resolveHttpKey(descriptor, settings);
    if (!key && !descriptor.keyOptional) {
        return { models: [], error: `No API key for ${descriptor.label} — add one, or set ${descriptor.envKeys[0] ?? 'a key'} in your environment.` };
    }
    if (providerNeedsUrl(descriptor) && !resolveHttpBaseUrl(descriptor, settings)) {
        return { models: [], error: `No URL configured for ${descriptor.label}.` };
    }

    let response;
    try {
        response = await requestUrl({
            url: httpProviderModelsUrl(descriptor, settings),
            method: 'GET',
            headers: { ...(key && descriptor.authHeaders ? descriptor.authHeaders(key) : {}) },
            throw: false,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { models: [], error: `${descriptor.label} could not be reached: ${message}` };
    }

    if (response.status < 200 || response.status >= 300) {
        const hint = response.status === 401 || response.status === 403
            ? ' The key was rejected.'
            : '';
        return { models: [], error: `${descriptor.label} answered ${response.status}.${hint}` };
    }

    let models: CliModelEntry[];
    try {
        const parse = descriptor.parseModels ?? parseOpenAiStyleList;
        models = parse(response.json);
    } catch {
        return { models: [], error: `${descriptor.label} returned a model list this plugin could not read.` };
    }
    if (models.length === 0) {
        return { models: [], error: `${descriptor.label} accepted the request but listed no models.` };
    }

    const discovered: DiscoveredModel[] = models.map(model => ({
        id: model.id,
        label: model.label,
        source: 'api' as const,
        ...(model.created !== undefined ? { created: model.created } : {}),
    }));
    return { models: rankModels(discovered, descriptor.latestModel), error: null };
}

/** Models for any provider id, HTTP or CLI. */
export async function discoverModels(
    id: string,
    settings: SpaceforgeSettings
): Promise<DiscoveryResult> {
    const cli = getCliAgent(agentIdOfProvider(id) ?? id);
    if (cli) {
        const models = await fetchCliModels(cli.id);
        return {
            models: models.map(model => ({
                id: model.id,
                label: model.label,
                source: model.label ? ('cli' as const) : ('catalog' as const),
            })),
            error: null,
        };
    }
    return discoverHttpModels(id, settings);
}

// -------------------------------------------------------------------- search

/**
 * Rank models against what the user typed. Ordering is deliberate: something
 * they typed exactly is what they meant, a prefix is usually it, and a
 * scattering of letters across an id is a last resort — but it is still worth
 * something, because model ids are exactly the kind of string people half
 * remember.
 */
export function searchModels(models: DiscoveredModel[], query: string, limit = 40): DiscoveredModel[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return models.slice(0, limit);

    const scored: Array<{ model: DiscoveredModel; rank: number; length: number }> = [];
    for (const model of models) {
        const id = model.id.toLowerCase();
        const label = (model.label ?? '').toLowerCase();
        let rank = -1;

        // Ids outrank labels at every step: 'sonnet' is what the user must type in
        // the end, so a model whose *id* is that is a better answer than one that
        // merely mentions it in a display name.
        if (id === needle) rank = 0;
        else if (id.startsWith(needle)) rank = 1;
        else if (label === needle) rank = 2;
        else if (label.startsWith(needle)) rank = 3;
        else if (id.includes(needle)) rank = 4;
        else if (label.includes(needle)) rank = 5;
        else if (isSubsequence(needle, id)) rank = 6;
        else if (isSubsequence(needle, label)) rank = 7;

        if (rank >= 0) scored.push({ model, rank, length: id.length });
    }

    scored.sort((a, b) => (a.rank - b.rank) || (a.length - b.length) || a.model.id.localeCompare(b.model.id));
    return scored.slice(0, limit).map(entry => entry.model);
}

/** True when every character of `needle` appears in `haystack`, in order. */
export function isSubsequence(needle: string, haystack: string): boolean {
    let cursor = 0;
    for (const character of haystack) {
        if (character === needle[cursor]) cursor += 1;
        if (cursor >= needle.length) return true;
    }
    return needle.length === 0;
}

// ------------------------------------------------------------------ detection

/** What a provider's message should say once its own newest model is known. */
function newestNote(descriptor: HttpProviderDescriptor): string {
    return descriptor.latestModel ? ` Newest: ${descriptor.latestModel}.` : '';
}

/**
 * Every provider, with what it can actually do right now. A CLI is asked, an
 * HTTP provider is judged by whether a key exists (listing its models would
 * mean a network call per provider on every settings render), and a local
 * daemon is probed because it needs no key at all.
 */
export async function detectProviders(
    settings: SpaceforgeSettings,
    options: { listModels?: boolean } = {}
): Promise<ProviderStatus[]> {
    const statuses: ProviderStatus[] = [];

    for (const descriptor of HTTP_PROVIDERS) {
        const key = resolveHttpKey(descriptor, settings);
        const source = keySource(descriptor, settings);
        // One rule decides both: what the run itself would refuse, and what this
        // line says. A provider is never called ready for something it would fail.
        const gap = describeProviderGap(descriptor, settings);
        const configured = gap === null;
        let ready = configured && (Boolean(key) || Boolean(descriptor.keyOptional));
        let level: ProviderStatus['level'] = ready ? 'ok' : 'warn';
        let message: string;
        let models: DiscoveredModel[] = [];

        if (descriptor.local) {
            const base = resolveHttpBaseUrl(descriptor, settings);
            const probe = await requestJson(
                httpProviderModelsUrl(descriptor, settings),
                key && descriptor.authHeaders ? descriptor.authHeaders(key) : {}
            );
            // A local daemon is judged by answering at all: a server that has the
            // chat endpoint but no model list is usable, and saying "nothing is
            // answering" about it would be wrong.
            const reachable = probe.status > 0;
            const listed = probe.status >= 200 && probe.status < 300;
            ready = reachable && configured;
            level = listed ? 'ok' : 'warn';
            message = !reachable
                ? `Nothing is answering at ${base || 'its endpoint'}. Start it, or set its URL.`
                : listed
                    ? `${descriptor.label} answered at ${base || 'its endpoint'}.${newestNote(descriptor)}`
                    : `${descriptor.label} answered at ${base || 'its endpoint'}, but its model list could not be read (${probe.status}). Type a model id, or point the URL at the right place.`;
            if (listed) {
                const parse = descriptor.parseModels ?? parseOpenAiStyleList;
                models = rankModels(
                    parse(probe.json).map(model => ({ ...model, source: 'api' as const })),
                    descriptor.latestModel
                );
            }
        } else if (gap) {
            // What it is missing, in the words the run itself would use.
            message = gap;
        } else if (source === 'environment') {
            message = `Using the key from your environment (${descriptor.envKeys.find(name => getEnvVar(name))}).${newestNote(descriptor)}`;
        } else if (key) {
            message = `Key present.${newestNote(descriptor)}`;
        } else {
            // A provider that wants no key must not be told it has one.
            message = `No key needed.${newestNote(descriptor)}`;
        }

        if (options.listModels && ready && models.length === 0) {
            const discovery = await discoverHttpModels(descriptor.id, settings);
            models = discovery.models;
            if (discovery.error) {
                level = 'warn';
                message = discovery.error;
                ready = false;
            }
        }

        statuses.push({
            id: descriptor.id,
            label: descriptor.label,
            kind: 'http',
            ready,
            configured: configured || Boolean(key) || Boolean(descriptor.keyOptional) || models.length > 0,
            level,
            message: message ?? '',
            credentialSource: source ?? (descriptor.local && ready ? 'local' : null),
            models,
            model: providerModel(descriptor, settings) || undefined,
        });
    }

    for (const agent of CLI_AGENTS) {
        const detection = await detectCliAgent(agent.id);
        const ready = detection.installed && detection.authenticated;
        statuses.push({
            id: cliProviderId(agent.id),
            label: agent.name,
            kind: 'cli',
            ready,
            configured: detection.installed,
            level: detection.level,
            message: detection.message,
            credentialSource: ready ? 'cli' : null,
            models: options.listModels && ready
                ? (await fetchCliModels(agent.id)).map(model => ({ id: model.id, label: model.label, source: model.label ? 'cli' as const : 'catalog' as const }))
                : agent.catalogModels.map(model => ({ ...model, source: 'catalog' as const })),
            model: cliModelFor(settings, agent.id) || undefined,
            detection,
        });
    }

    return statuses;
}

/**
 * One GET, with the status kept: 0 means nothing answered at all, and anything
 * else means something is listening there — a distinction a local daemon probe
 * has to make (`requestUrl` throws only when the request never got anywhere).
 */
async function requestJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    try {
        const response = await requestUrl({ url, method: 'GET', headers, throw: false });
        return { status: response.status, json: response.json };
    } catch {
        return { status: 0, json: null };
    }
}
