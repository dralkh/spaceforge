import type { SpaceforgeSettings } from './settings';

/**
 * All 11 TTS endpoints supported by obsidian-aloud-tts.
 */
export type TtsProviderId =
    | 'openai'
    | 'openaicompat'
    | 'azure'
    | 'elevenlabs'
    | 'gemini'
    | 'hume'
    | 'minimax'
    | 'fish'
    | 'inworld'
    | 'polly'
    | 'speechify';

export type TtsChunkType = 'sentence' | 'paragraph';
export type TtsCacheType = 'local' | 'vault';
/**
 * Where saved audio goes. `cache` is the hidden `.tts/` folder at the vault
 * root — the same place Obsidian Aloud keeps its audio cache — so both
 * plugins' audio lives in one place Obsidian does not index as notes.
 */
export type TtsExportDestination = 'cache' | 'vault' | 'browser';

/** The hidden vault folder Obsidian Aloud caches into; Spaceforge shares it. */
export const TTS_HIDDEN_DIR = '.tts';
/** Saved (exported) audio inside the shared folder, apart from cache clips. */
export const TTS_EXPORT_DIR = `${TTS_HIDDEN_DIR}/exports`;
const LEGACY_AUDIO_FOLDER = 'spaceforge/tts-audio';

/** Aloud says "download" where Spaceforge says "browser"; an untouched old default reads as the new one. */
export function normalizeExportDestination(value: unknown, audioFolder?: unknown): TtsExportDestination {
    if (value === 'browser' || value === 'download') return 'browser';
    if (value === 'cache') return 'cache';
    if (value === 'vault') {
        const folder = typeof audioFolder === 'string' ? audioFolder.trim() : '';
        // 'vault' + the old built-in folder is the previous default, never a choice.
        return folder && folder !== LEGACY_AUDIO_FOLDER ? 'vault' : 'cache';
    }
    return 'cache';
}
export type TtsTargetSource = 'auto' | 'note' | 'mindmap' | 'visualize' | 'summary' | 'tutor';
export type TtsOpenAICompatFormat = 'mp3' | 'wav' | 'pcm';
export type TtsHumeSourceType = 'HUME_AI' | 'CUSTOM_VOICE';
export type TtsFishVoiceSource = 'my-voices' | 'custom';
export type TtsFishSentencePause = 'none' | 'short' | 'long';
export type TtsPollyEngine = 'neural' | 'standard';

export interface TtsSettings {
    provider: TtsProviderId;
    chunkType: TtsChunkType;
    playbackSpeed: number;
    autoScroll: boolean;
    defaultSource: TtsTargetSource;
    cacheType: TtsCacheType;
    cacheDurationMillis: number;
    audioFolder: string;
    audioExportDestination: TtsExportDestination;
    useVaultAloudSettingsPath: string;

    // OpenAI
    openai_apiKey: string;
    openai_ttsModel: string;
    openai_ttsVoice: string;
    openai_ttsInstructions: string;

    // OpenAI-Compatible
    openaicompat_apiKey: string;
    openaicompat_apiBase: string;
    openaicompat_ttsModel: string;
    openaicompat_ttsVoice: string;
    openaicompat_responseFormat: TtsOpenAICompatFormat;
    openaicompat_generationSpeed: number;

    // Gemini
    gemini_apiKey: string;
    gemini_ttsModel: string;
    gemini_ttsVoice: string;
    gemini_ttsInstructions: string;

    // ElevenLabs
    elevenlabs_apiKey: string;
    elevenlabs_model: string;
    elevenlabs_voice: string;
    elevenlabs_stability: number;
    elevenlabs_similarity: number;

    // Azure
    azure_apiKey: string;
    azure_region: string;
    azure_voice: string;
    azure_outputFormat: string;

    // Hume
    hume_apiKey: string;
    hume_ttsVoice: string;
    hume_sourceType: TtsHumeSourceType;
    hume_ttsInstructions: string;

    // MiniMax
    minimax_apiKey: string;
    minimax_groupId: string;
    minimax_ttsModel: string;
    minimax_ttsVoice: string;
    minimax_useChinaEndpoint: boolean;

    // Fish Audio
    fish_apiKey: string;
    fish_model: string;
    fish_voiceSource: TtsFishVoiceSource;
    fish_voiceId: string;
    fish_sentencePause: TtsFishSentencePause;

    // Inworld
    inworld_apiKey: string;
    inworld_modelId: string;
    inworld_voiceId: string;

    // Amazon Polly
    polly_accessKeyId: string;
    polly_secretAccessKey: string;
    polly_region: string;
    polly_voiceId: string;
    polly_engine: TtsPollyEngine;

    // Speechify
    speechify_apiKey: string;
    speechify_model: string;
    speechify_voice: string;
}

export interface TtsProviderMeta {
    id: TtsProviderId;
    label: string;
    shortLabel: string;
    endpointHint: string;
}

export const TTS_PROVIDERS: readonly TtsProviderMeta[] = [
    { id: 'openai', label: 'OpenAI', shortLabel: 'OpenAI', endpointHint: 'https://api.openai.com/v1/audio/speech' },
    { id: 'openaicompat', label: 'OpenAI-Compatible', shortLabel: 'OpenAI Compat', endpointHint: 'Custom /v1/audio/speech' },
    { id: 'gemini', label: 'Google Gemini', shortLabel: 'Gemini', endpointHint: 'generativelanguage.googleapis.com' },
    { id: 'elevenlabs', label: 'ElevenLabs', shortLabel: 'ElevenLabs', endpointHint: 'https://api.elevenlabs.io/v1/text-to-speech' },
    { id: 'azure', label: 'Microsoft Azure Speech', shortLabel: 'Azure', endpointHint: 'https://{region}.tts.speech.microsoft.com' },
    { id: 'hume', label: 'Hume AI', shortLabel: 'Hume', endpointHint: 'https://api.hume.ai/v0/tts' },
    { id: 'minimax', label: 'MiniMax', shortLabel: 'MiniMax', endpointHint: 'https://api.minimax.io/v1/t2a_v2' },
    { id: 'fish', label: 'Fish Audio', shortLabel: 'Fish', endpointHint: 'https://api.fish.audio/v1/tts' },
    { id: 'inworld', label: 'Inworld AI', shortLabel: 'Inworld', endpointHint: 'https://api.inworld.ai/tts/v1/voice' },
    { id: 'polly', label: 'Amazon Polly', shortLabel: 'Polly', endpointHint: 'https://polly.{region}.amazonaws.com/v1/speech' },
    { id: 'speechify', label: 'Speechify', shortLabel: 'Speechify', endpointHint: 'https://api.speechify.ai/v1/audio/speech' },
] as const;

export const TTS_PROVIDER_IDS: readonly TtsProviderId[] = TTS_PROVIDERS.map(p => p.id);

export const ONE_HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
    provider: 'openai',
    chunkType: 'sentence',
    playbackSpeed: 1.0,
    autoScroll: true,
    defaultSource: 'auto',
    cacheType: 'local',
    cacheDurationMillis: 24 * ONE_HOUR_MS,
    audioFolder: 'spaceforge/tts-audio',
    audioExportDestination: 'cache',
    useVaultAloudSettingsPath: 'plugins/aloud-tts/data.json',

    openai_apiKey: '',
    openai_ttsModel: 'gpt-4o-mini-tts',
    openai_ttsVoice: 'shimmer',
    openai_ttsInstructions: '',

    openaicompat_apiKey: '',
    openaicompat_apiBase: '',
    openaicompat_ttsModel: '',
    openaicompat_ttsVoice: '',
    openaicompat_responseFormat: 'mp3',
    openaicompat_generationSpeed: 1.0,

    gemini_apiKey: '',
    gemini_ttsModel: 'gemini-2.5-flash-preview-tts',
    gemini_ttsVoice: 'Zephyr',
    gemini_ttsInstructions: '',

    elevenlabs_apiKey: '',
    elevenlabs_model: 'eleven_multilingual_v2',
    elevenlabs_voice: '',
    elevenlabs_stability: 0.5,
    elevenlabs_similarity: 0.75,

    azure_apiKey: '',
    azure_region: 'eastus',
    azure_voice: 'en-US-JennyNeural',
    azure_outputFormat: 'audio-24khz-96kbitrate-mono-mp3',

    hume_apiKey: '',
    hume_ttsVoice: '',
    hume_sourceType: 'HUME_AI',
    hume_ttsInstructions: '',

    minimax_apiKey: '',
    minimax_groupId: '',
    minimax_ttsModel: 'speech-2.6-turbo',
    minimax_ttsVoice: 'English_Graceful_Lady',
    minimax_useChinaEndpoint: false,

    fish_apiKey: '',
    fish_model: 's1',
    fish_voiceSource: 'my-voices',
    fish_voiceId: '',
    fish_sentencePause: 'short',

    inworld_apiKey: '',
    inworld_modelId: 'inworld-tts-1',
    inworld_voiceId: 'Ronald',

    polly_accessKeyId: '',
    polly_secretAccessKey: '',
    polly_region: 'us-east-1',
    polly_voiceId: 'Joanna',
    polly_engine: 'neural',

    speechify_apiKey: '',
    speechify_model: 'simba-3.2',
    speechify_voice: 'dominic_32',
};

export function isTtsProviderId(value: unknown): value is TtsProviderId {
    return typeof value === 'string' && (TTS_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Normalize partial/loaded TTS settings with defaults.
 */
export function normalizeTtsSettings(raw: unknown): TtsSettings {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<TtsSettings>;
    const merged: TtsSettings = {
        ...DEFAULT_TTS_SETTINGS,
        ...src,
        provider: isTtsProviderId(src.provider) ? src.provider : DEFAULT_TTS_SETTINGS.provider,
        chunkType: src.chunkType === 'paragraph' ? 'paragraph' : 'sentence',
        playbackSpeed:
            typeof src.playbackSpeed === 'number' && Number.isFinite(src.playbackSpeed)
                ? Math.min(2.5, Math.max(0.5, src.playbackSpeed))
                : DEFAULT_TTS_SETTINGS.playbackSpeed,
        autoScroll: typeof src.autoScroll === 'boolean' ? src.autoScroll : DEFAULT_TTS_SETTINGS.autoScroll,
        defaultSource: isTargetSource(src.defaultSource) ? src.defaultSource : DEFAULT_TTS_SETTINGS.defaultSource,
        cacheType: src.cacheType === 'vault' ? 'vault' : 'local',
        cacheDurationMillis:
            typeof src.cacheDurationMillis === 'number' && Number.isFinite(src.cacheDurationMillis) && src.cacheDurationMillis >= 0
                ? src.cacheDurationMillis
                : DEFAULT_TTS_SETTINGS.cacheDurationMillis,
        audioFolder: typeof src.audioFolder === 'string' && src.audioFolder.trim()
            ? src.audioFolder.trim()
            : DEFAULT_TTS_SETTINGS.audioFolder,
        audioExportDestination: normalizeExportDestination(src.audioExportDestination, src.audioFolder),
        openaicompat_responseFormat:
            src.openaicompat_responseFormat === 'wav' || src.openaicompat_responseFormat === 'pcm'
                ? src.openaicompat_responseFormat
                : 'mp3',
        openaicompat_generationSpeed:
            typeof src.openaicompat_generationSpeed === 'number' && Number.isFinite(src.openaicompat_generationSpeed)
                ? Math.min(4.0, Math.max(0.25, src.openaicompat_generationSpeed))
                : DEFAULT_TTS_SETTINGS.openaicompat_generationSpeed,
        hume_sourceType: src.hume_sourceType === 'CUSTOM_VOICE' ? 'CUSTOM_VOICE' : 'HUME_AI',
        fish_voiceSource: src.fish_voiceSource === 'custom' ? 'custom' : 'my-voices',
        fish_sentencePause:
            src.fish_sentencePause === 'none' || src.fish_sentencePause === 'long'
                ? src.fish_sentencePause
                : 'short',
        polly_engine: src.polly_engine === 'standard' ? 'standard' : 'neural',
        elevenlabs_stability:
            typeof src.elevenlabs_stability === 'number' && Number.isFinite(src.elevenlabs_stability)
                ? Math.min(1, Math.max(0, src.elevenlabs_stability))
                : DEFAULT_TTS_SETTINGS.elevenlabs_stability,
        elevenlabs_similarity:
            typeof src.elevenlabs_similarity === 'number' && Number.isFinite(src.elevenlabs_similarity)
                ? Math.min(1, Math.max(0, src.elevenlabs_similarity))
                : DEFAULT_TTS_SETTINGS.elevenlabs_similarity,
    };
    return merged;
}

function isTargetSource(value: unknown): value is TtsTargetSource {
    return (
        value === 'auto' ||
        value === 'note' ||
        value === 'mindmap' ||
        value === 'visualize' ||
        value === 'summary' ||
        value === 'tutor'
    );
}

/**
 * Inspect whether raw JSON looks like obsidian-aloud-tts `data.json`.
 */
export interface AloudImportPreview {
    provider: TtsProviderId;
    configuredProviders: TtsProviderId[];
    version?: number;
}

const ALOUD_PROVIDER_FIELDS: readonly (keyof TtsSettings)[] = [
    'openai_apiKey', 'openai_ttsModel', 'openai_ttsVoice', 'openai_ttsInstructions',
    'openaicompat_apiKey', 'openaicompat_apiBase', 'openaicompat_ttsModel', 'openaicompat_ttsVoice', 'openaicompat_responseFormat', 'openaicompat_generationSpeed',
    'gemini_apiKey', 'gemini_ttsModel', 'gemini_ttsVoice', 'gemini_ttsInstructions',
    'elevenlabs_apiKey', 'elevenlabs_model', 'elevenlabs_voice', 'elevenlabs_stability', 'elevenlabs_similarity',
    'azure_apiKey', 'azure_region', 'azure_voice', 'azure_outputFormat',
    'hume_apiKey', 'hume_ttsVoice', 'hume_sourceType', 'hume_ttsInstructions',
    'minimax_apiKey', 'minimax_groupId', 'minimax_ttsModel', 'minimax_ttsVoice', 'minimax_useChinaEndpoint',
    'fish_apiKey', 'fish_model', 'fish_voiceSource', 'fish_voiceId', 'fish_sentencePause',
    'inworld_apiKey', 'inworld_modelId', 'inworld_voiceId',
    'polly_accessKeyId', 'polly_secretAccessKey', 'polly_region', 'polly_voiceId', 'polly_engine',
    'speechify_apiKey', 'speechify_model', 'speechify_voice',
];

/**
 * Parse an obsidian-aloud-tts `data.json` payload into Spaceforge `Partial<TtsSettings>`.
 * Supports every endpoint field, chunking, speed, cache duration/type, autoscroll, and export prefs.
 */
export function parseAloudTtsSettings(raw: unknown): Partial<TtsSettings> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const src = raw as Record<string, unknown>;

    const looksLikeAloud =
        'modelProvider' in src ||
        'openai_apiKey' in src ||
        'gemini_apiKey' in src ||
        'elevenlabs_apiKey' in src ||
        'azure_apiKey' in src ||
        'polly_accessKeyId' in src ||
        'openaicompat_apiBase' in src;

    if (!looksLikeAloud) return null;

    const imported: Partial<TtsSettings> = {};
    if (isTtsProviderId(src.modelProvider)) {
        imported.provider = src.modelProvider;
    }
    if (src.chunkType === 'sentence' || src.chunkType === 'paragraph') {
        imported.chunkType = src.chunkType;
    }
    if (typeof src.playbackSpeed === 'number' && Number.isFinite(src.playbackSpeed)) {
        imported.playbackSpeed = Math.min(2.5, Math.max(0.5, src.playbackSpeed));
    }
    if (typeof src.autoScrollPlayerView === 'boolean') {
        imported.autoScroll = src.autoScrollPlayerView;
    }
    if (src.cacheType === 'local' || src.cacheType === 'vault') {
        imported.cacheType = src.cacheType;
    }
    if (typeof src.cacheDurationMillis === 'number' && Number.isFinite(src.cacheDurationMillis)) {
        imported.cacheDurationMillis = Math.max(0, src.cacheDurationMillis);
    }
    if (typeof src.audioFolder === 'string' && src.audioFolder.trim()) {
        imported.audioFolder = src.audioFolder.trim();
    }
    // Aloud's "download" is Spaceforge's "browser"; its "vault" means its own audio folder.
    if (src.audioExportDestination === 'download' || src.audioExportDestination === 'browser') {
        imported.audioExportDestination = 'browser';
    } else if (src.audioExportDestination === 'vault') {
        imported.audioExportDestination = 'vault';
    }

    for (const key of ALOUD_PROVIDER_FIELDS) {
        if (key in src && src[key] !== undefined) {
            (imported as Record<string, unknown>)[key] = src[key];
        }
    }

    return imported;
}

/**
 * Summarize which providers have credentials configured in an Aloud `data.json` object.
 */
export function detectAloudSettingsPreview(raw: unknown): AloudImportPreview | null {
    const parsed = parseAloudTtsSettings(raw);
    if (!parsed) return null;
    const src = raw as Record<string, unknown>;
    const configured: TtsProviderId[] = [];
    if (parsed.openai_apiKey) configured.push('openai');
    if (parsed.openaicompat_apiBase) configured.push('openaicompat');
    if (parsed.gemini_apiKey) configured.push('gemini');
    if (parsed.elevenlabs_apiKey) configured.push('elevenlabs');
    if (parsed.azure_apiKey) configured.push('azure');
    if (parsed.hume_apiKey) configured.push('hume');
    if (parsed.minimax_apiKey) configured.push('minimax');
    if (parsed.fish_apiKey) configured.push('fish');
    if (parsed.inworld_apiKey) configured.push('inworld');
    if (parsed.polly_accessKeyId && parsed.polly_secretAccessKey) configured.push('polly');
    if (parsed.speechify_apiKey) configured.push('speechify');

    return {
        provider: parsed.provider ?? 'openai',
        configuredProviders: configured,
        version: typeof src.version === 'number' ? src.version : undefined,
    };
}

/**
 * Apply already-configured Spaceforge AI keys (OpenAI / Gemini) to empty TTS key slots.
 */
export function shareSpaceforgeApiKeys(tts: TtsSettings, settings: SpaceforgeSettings): boolean {
    let changed = false;
    const openaiKey = settings.openaiApiKey || settings.providerKeys?.openai || '';
    const geminiKey = settings.geminiApiKey || settings.providerKeys?.gemini || '';
    const compatKey = settings.openaiCompatibleApiKey || settings.providerKeys?.['openai-compatible'] || '';
    if (!tts.openai_apiKey && openaiKey) {
        tts.openai_apiKey = openaiKey;
        changed = true;
    }
    if (!tts.gemini_apiKey && geminiKey) {
        tts.gemini_apiKey = geminiKey;
        changed = true;
    }
    if (!tts.openaicompat_apiKey && compatKey) {
        tts.openaicompat_apiKey = compatKey;
        changed = true;
    }
    return changed;
}

export function resolveTtsApiKey(tts: TtsSettings, provider: TtsProviderId = tts.provider): string {
    switch (provider) {
        case 'openai': return tts.openai_apiKey;
        case 'openaicompat': return tts.openaicompat_apiKey;
        case 'gemini': return tts.gemini_apiKey;
        case 'elevenlabs': return tts.elevenlabs_apiKey;
        case 'azure': return tts.azure_apiKey;
        case 'hume': return tts.hume_apiKey;
        case 'minimax': return tts.minimax_apiKey;
        case 'fish': return tts.fish_apiKey;
        case 'inworld': return tts.inworld_apiKey;
        case 'polly': return tts.polly_accessKeyId;
        case 'speechify': return tts.speechify_apiKey;
    }
}

export function getActiveVoiceLabel(tts: TtsSettings): string {
    switch (tts.provider) {
        case 'openai': return tts.openai_ttsVoice || 'shimmer';
        case 'openaicompat': return tts.openaicompat_ttsVoice || tts.openaicompat_ttsModel || 'custom';
        case 'gemini': return tts.gemini_ttsVoice || 'Zephyr';
        case 'elevenlabs': return tts.elevenlabs_voice || 'elevenlabs';
        case 'azure': return tts.azure_voice || 'en-US-JennyNeural';
        case 'hume': return tts.hume_ttsVoice || 'default';
        case 'minimax': return tts.minimax_ttsVoice || 'minimax';
        case 'fish': return tts.fish_voiceId || 'default';
        case 'inworld': return tts.inworld_voiceId || 'Ronald';
        case 'polly': return tts.polly_voiceId || 'Joanna';
        case 'speechify': return tts.speechify_voice || 'dominic_32';
    }
}
