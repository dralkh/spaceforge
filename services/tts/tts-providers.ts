import { requestUrl } from 'obsidian';
import type { TtsProviderId, TtsSettings } from '../../models/tts';
import {
    base64ToArrayBuffer,
    hexToArrayBuffer,
    pcmToWavArrayBuffer,
    splitTextForLimit,
} from '../../utils/tts-text';

export type TtsAudioFormat = 'mp3' | 'wav';

export interface TtsSynthesizedAudio {
    data: ArrayBuffer;
    format: TtsAudioFormat;
}

export interface TtsVoiceOption {
    id: string;
    label: string;
}

export interface TtsHttpRequest {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
}

export interface TtsHttpResponse {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
    text: string;
    json: unknown;
}

export type TtsHttpTransport = (req: TtsHttpRequest) => Promise<TtsHttpResponse>;

export class TtsProviderError extends Error {
    readonly status: number;
    readonly provider: TtsProviderId;
    readonly retryable: boolean;

    constructor(provider: TtsProviderId, status: number, message: string) {
        super(message);
        this.name = 'TtsProviderError';
        this.provider = provider;
        this.status = status;
        this.retryable = status === 409 || status === 429 || status >= 500 || status === 0;
    }
}

export interface RawRequestUrlResponseLike {
    status: number;
    headers?: Record<string, string>;
    arrayBuffer?: ArrayBuffer;
    text?: string;
    json?: unknown;
}

/**
 * Safely convert Obsidian's lazy `RequestUrlResponse` (whose `.json` getter throws
 * `SyntaxError` on binary audio payloads) into a `TtsHttpResponse`.
 */
export function normalizeRequestUrlResponse(res: RawRequestUrlResponseLike): TtsHttpResponse {
    const headers = res.headers ?? {};
    const contentTypeKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type');
    const contentType = contentTypeKey ? headers[contentTypeKey].toLowerCase() : '';
    const isBinaryAudio =
        res.status >= 200 &&
        res.status < 300 &&
        (contentType.startsWith('audio/') || contentType.includes('application/octet-stream'));

    let buf: ArrayBuffer = res.arrayBuffer instanceof ArrayBuffer ? res.arrayBuffer : new ArrayBuffer(0);

    let rawText = '';
    if (!isBinaryAudio) {
        try {
            if (typeof res.text === 'string') {
                rawText = res.text;
            }
        } catch {
            rawText = '';
        }
    }
    if (!buf.byteLength && rawText) {
        buf = new TextEncoder().encode(rawText).buffer;
    }

    let parsedJson: unknown;
    if (!isBinaryAudio) {
        try {
            parsedJson = res.json;
        } catch {
            parsedJson = undefined;
        }
        if (parsedJson === undefined && rawText) {
            try {
                parsedJson = JSON.parse(rawText);
            } catch {
                parsedJson = undefined;
            }
        }
    }

    return {
        status: res.status,
        headers,
        arrayBuffer: buf,
        text: rawText,
        json: parsedJson,
    };
}

export const defaultTtsTransport: TtsHttpTransport = async (req: TtsHttpRequest): Promise<TtsHttpResponse> => {
    const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        throw: false,
    });
    return normalizeRequestUrlResponse(res);
};

function parseErrorMessage(res: TtsHttpResponse, fallback: string): string {
    if (res.json && typeof res.json === 'object') {
        const obj = res.json as Record<string, unknown>;
        if (typeof obj.message === 'string' && obj.message) return obj.message;
        if (typeof obj.detail === 'string' && obj.detail) return obj.detail;
        if (obj.error && typeof obj.error === 'object') {
            const inner = obj.error as Record<string, unknown>;
            if (typeof inner.message === 'string' && inner.message) return inner.message;
        }
        if (obj.base_resp && typeof obj.base_resp === 'object') {
            const br = obj.base_resp as Record<string, unknown>;
            if (typeof br.status_msg === 'string' && br.status_msg) return br.status_msg;
        }
    }
    if (res.text && res.text.trim()) {
        return res.text.trim().slice(0, 220);
    }
    return fallback;
}

function assertOk(provider: TtsProviderId, res: TtsHttpResponse, action: string): void {
    if (res.status >= 200 && res.status < 300) return;
    const detail = parseErrorMessage(res, `HTTP ${res.status}`);
    throw new TtsProviderError(provider, res.status, `${action} failed (${res.status}): ${detail}`);
}

export function normalizeOpenAiCompatEndpoint(apiBase: string): string {
    const clean = apiBase.trim().replace(/\/+$/, '');
    if (!clean) return '';
    if (clean.endsWith('/audio/speech')) return clean;
    if (clean.endsWith('/v1')) return `${clean}/audio/speech`;
    return `${clean}/v1/audio/speech`;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildAzureSsml(text: string, voice: string): string {
    const langMatch = /^([a-z]{2,3}-[A-Z]{2})/.exec(voice);
    const lang = langMatch ? langMatch[1] : 'en-US';
    return `<speak version="1.0" xml:lang="${lang}"><voice xml:lang="${lang}" name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
}

/**
 * Pure WebCrypto AWS SigV4 signing for Amazon Polly (zero AWS SDK dependency).
 */
async function signAwsPollyRequest(params: {
    method: 'GET' | 'POST';
    region: string;
    path: string;
    body: string;
    accessKeyId: string;
    secretAccessKey: string;
    contentType?: string;
    amzDate?: string;
}): Promise<{ url: string; headers: Record<string, string> }> {
    const cryptoApi = typeof window !== 'undefined' ? window.crypto : crypto;
    if (!cryptoApi?.subtle) {
        throw new TtsProviderError('polly', 0, 'WebCrypto subtle API is unavailable for Amazon Polly signing.');
    }

    const host = `polly.${params.region}.amazonaws.com`;
    const url = `https://${host}${params.path}`;

    const now = new Date();
    const amzDate =
        params.amzDate ??
        now
            .toISOString()
            .replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 'polly';

    const encoder = new TextEncoder();
    const toHex = (buf: ArrayBuffer): string =>
        Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

    const sha256Hex = async (data: string): Promise<string> => {
        const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(data));
        return toHex(digest);
    };

    const hmac = async (key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> => {
        const rawKey = key instanceof Uint8Array ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) : key;
        const cryptoKey = await cryptoApi.subtle.importKey(
            'raw',
            rawKey as ArrayBuffer,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        return cryptoApi.subtle.sign('HMAC', cryptoKey, encoder.encode(msg));
    };

    const payloadHash = await sha256Hex(params.body);
    const headerPairs: Array<[string, string]> = [
        ['host', host],
        ['x-amz-date', amzDate],
    ];
    if (params.contentType) {
        headerPairs.push(['content-type', params.contentType]);
    }
    headerPairs.sort((a, b) => a[0].localeCompare(b[0]));

    const canonicalHeaders = headerPairs.map(([k, v]) => `${k}:${v}\n`).join('');
    const signedHeaders = headerPairs.map(([k]) => k).join(';');
    const canonicalRequest = [
        params.method,
        params.path,
        '',
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${params.region}/${service}/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        await sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = await hmac(encoder.encode(`AWS4${params.secretAccessKey}`), dateStamp);
    const kRegion = await hmac(kDate, params.region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = toHex(await hmac(kSigning, stringToSign));

    const headers: Record<string, string> = {
        'X-Amz-Date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
    if (params.contentType) {
        headers['Content-Type'] = params.contentType;
    }

    return { url, headers };
}

/**
 * Identity cache fields for content-addressable audio caching across all 11 providers.
 */
export function describeActiveTtsModel(settings: TtsSettings): {
    provider: TtsProviderId;
    apiUri: string;
    model: string;
    voice: string;
    instructions: string;
    speed: number;
    format: TtsAudioFormat;
} {
    switch (settings.provider) {
        case 'openai':
            return {
                provider: 'openai',
                apiUri: 'https://api.openai.com/v1/audio/speech',
                model: settings.openai_ttsModel || 'gpt-4o-mini-tts',
                voice: settings.openai_ttsVoice || 'shimmer',
                instructions: settings.openai_ttsInstructions || '',
                speed: 1,
                format: 'mp3',
            };
        case 'openaicompat':
            return {
                provider: 'openaicompat',
                apiUri: normalizeOpenAiCompatEndpoint(settings.openaicompat_apiBase),
                model: settings.openaicompat_ttsModel,
                voice: settings.openaicompat_ttsVoice,
                instructions: '',
                speed: settings.openaicompat_generationSpeed || 1,
                format: settings.openaicompat_responseFormat === 'mp3' ? 'mp3' : 'wav',
            };
        case 'gemini':
            return {
                provider: 'gemini',
                apiUri: 'https://generativelanguage.googleapis.com/v1beta',
                model: settings.gemini_ttsModel || 'gemini-2.5-flash-preview-tts',
                voice: settings.gemini_ttsVoice || 'Zephyr',
                instructions: settings.gemini_ttsInstructions || '',
                speed: 1,
                format: 'wav',
            };
        case 'elevenlabs':
            return {
                provider: 'elevenlabs',
                apiUri: 'https://api.elevenlabs.io/v1/text-to-speech',
                model: settings.elevenlabs_model || 'eleven_multilingual_v2',
                voice: settings.elevenlabs_voice,
                instructions: `${settings.elevenlabs_stability}:${settings.elevenlabs_similarity}`,
                speed: 1,
                format: 'mp3',
            };
        case 'azure':
            return {
                provider: 'azure',
                apiUri: `https://${settings.azure_region || 'eastus'}.tts.speech.microsoft.com/cognitiveservices/v1`,
                model: settings.azure_outputFormat || 'audio-24khz-96kbitrate-mono-mp3',
                voice: settings.azure_voice || 'en-US-JennyNeural',
                instructions: '',
                speed: 1,
                format: (settings.azure_outputFormat || '').includes('riff') ? 'wav' : 'mp3',
            };
        case 'hume':
            return {
                provider: 'hume',
                apiUri: 'https://api.hume.ai/v0/tts',
                model: settings.hume_sourceType,
                voice: settings.hume_ttsVoice,
                instructions: settings.hume_ttsInstructions || '',
                speed: 1,
                format: 'mp3',
            };
        case 'minimax':
            return {
                provider: 'minimax',
                apiUri: settings.minimax_useChinaEndpoint
                    ? 'https://api.minimaxi.com/v1/t2a_v2'
                    : 'https://api.minimax.io/v1/t2a_v2',
                model: settings.minimax_ttsModel || 'speech-2.6-turbo',
                voice: settings.minimax_ttsVoice || 'English_Graceful_Lady',
                instructions: settings.minimax_groupId || '',
                speed: 1,
                format: 'mp3',
            };
        case 'fish':
            return {
                provider: 'fish',
                apiUri: 'https://api.fish.audio/v1/tts',
                model: settings.fish_model || 's1',
                voice: settings.fish_voiceId || '',
                instructions: settings.fish_sentencePause,
                speed: 1,
                format: 'mp3',
            };
        case 'inworld':
            return {
                provider: 'inworld',
                apiUri: 'https://api.inworld.ai/tts/v1/voice',
                model: settings.inworld_modelId || 'inworld-tts-1',
                voice: settings.inworld_voiceId || 'Ronald',
                instructions: '',
                speed: 1,
                format: 'mp3',
            };
        case 'polly':
            return {
                provider: 'polly',
                apiUri: `https://polly.${settings.polly_region || 'us-east-1'}.amazonaws.com/v1/speech`,
                model: settings.polly_engine || 'neural',
                voice: settings.polly_voiceId || 'Joanna',
                instructions: '',
                speed: 1,
                format: 'mp3',
            };
        case 'speechify':
            return {
                provider: 'speechify',
                apiUri: 'https://api.speechify.ai/v1/audio/speech',
                model: settings.speechify_model || 'simba-3.2',
                voice: settings.speechify_voice || 'dominic_32',
                instructions: '',
                speed: 1,
                format: 'mp3',
            };
    }
}

/**
 * Validate required provider credentials/settings before calling remote endpoints.
 */
export function validateTtsConfiguration(settings: TtsSettings): string | null {
    switch (settings.provider) {
        case 'openai':
            return settings.openai_apiKey.trim() ? null : 'OpenAI API key is required.';
        case 'openaicompat':
            return settings.openaicompat_apiBase.trim() ? null : 'OpenAI-compatible API base URL is required.';
        case 'gemini':
            return settings.gemini_apiKey.trim() ? null : 'Gemini API key is required.';
        case 'elevenlabs':
            if (!settings.elevenlabs_apiKey.trim()) return 'ElevenLabs API key is required.';
            if (!settings.elevenlabs_voice.trim()) return 'ElevenLabs voice ID is required.';
            return null;
        case 'azure':
            if (!settings.azure_apiKey.trim()) return 'Azure Speech API key is required.';
            if (!settings.azure_region.trim()) return 'Azure region is required.';
            return null;
        case 'hume':
            return settings.hume_apiKey.trim() ? null : 'Hume API key is required.';
        case 'minimax':
            if (!settings.minimax_apiKey.trim()) return 'MiniMax API key is required.';
            if (!settings.minimax_groupId.trim()) return 'MiniMax Group ID is required.';
            return null;
        case 'fish':
            return settings.fish_apiKey.trim() ? null : 'Fish Audio API key is required.';
        case 'inworld':
            return settings.inworld_apiKey.trim() ? null : 'Inworld API key is required.';
        case 'polly':
            if (!settings.polly_accessKeyId.trim() || !settings.polly_secretAccessKey.trim()) {
                return 'Amazon Polly Access Key ID and Secret Access Key are required.';
            }
            if (!settings.polly_region.trim()) return 'Amazon Polly AWS region is required.';
            return null;
        case 'speechify':
            return settings.speechify_apiKey.trim() ? null : 'Speechify API key is required.';
    }
}

/**
 * Synthesize spoken audio for `text` using whichever of the 11 Aloud TTS endpoints is active.
 */
export async function synthesizeSpeech(
    text: string,
    settings: TtsSettings,
    transport: TtsHttpTransport = defaultTtsTransport,
): Promise<TtsSynthesizedAudio> {
    const configError = validateTtsConfiguration(settings);
    if (configError) {
        throw new TtsProviderError(settings.provider, 400, configError);
    }

    switch (settings.provider) {
        case 'openai': {
            const payload: Record<string, unknown> = {
                model: settings.openai_ttsModel || 'gpt-4o-mini-tts',
                voice: settings.openai_ttsVoice || 'shimmer',
                input: text,
                response_format: 'mp3',
            };
            if (settings.openai_ttsModel === 'gpt-4o-mini-tts' && settings.openai_ttsInstructions.trim()) {
                payload.instructions = settings.openai_ttsInstructions.trim();
            }
            const res = await transport({
                url: 'https://api.openai.com/v1/audio/speech',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${settings.openai_apiKey.trim()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });
            assertOk('openai', res, 'OpenAI TTS');
            return { data: res.arrayBuffer, format: 'mp3' };
        }

        case 'openaicompat': {
            const endpoint = normalizeOpenAiCompatEndpoint(settings.openaicompat_apiBase);
            const format = settings.openaicompat_responseFormat || 'mp3';
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            if (settings.openaicompat_apiKey.trim()) {
                headers.Authorization = `Bearer ${settings.openaicompat_apiKey.trim()}`;
            }
            const res = await transport({
                url: endpoint,
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: settings.openaicompat_ttsModel,
                    voice: settings.openaicompat_ttsVoice,
                    input: text,
                    response_format: format,
                    speed: settings.openaicompat_generationSpeed || 1,
                }),
            });
            assertOk('openaicompat', res, 'OpenAI-Compatible TTS');
            if (format === 'pcm') {
                return { data: pcmToWavArrayBuffer(res.arrayBuffer, 24000, 1, 16), format: 'wav' };
            }
            return { data: res.arrayBuffer, format: format === 'wav' ? 'wav' : 'mp3' };
        }

        case 'gemini': {
            const model = encodeURIComponent(settings.gemini_ttsModel || 'gemini-2.5-flash-preview-tts');
            const voice = settings.gemini_ttsVoice || 'Zephyr';
            const promptText = settings.gemini_ttsInstructions.trim()
                ? `${settings.gemini_ttsInstructions.trim()}\n\n${text}`
                : text;
            const res = await transport({
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                method: 'POST',
                headers: {
                    'x-goog-api-key': settings.gemini_apiKey.trim(),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: promptText }] }],
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: {
                                    voiceName: voice,
                                },
                            },
                        },
                    },
                }),
            });
            assertOk('gemini', res, 'Gemini TTS');
            const json = res.json as {
                candidates?: Array<{
                    content?: {
                        parts?: Array<{
                            inlineData?: { data?: string; mimeType?: string };
                        }>;
                    };
                }>;
            } | undefined;
            const inline = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
            if (!inline?.data) {
                throw new TtsProviderError('gemini', 502, 'Gemini returned no inline audio data.');
            }
            const raw = base64ToArrayBuffer(inline.data);
            const mime = (inline.mimeType || '').toLowerCase();
            if (mime.includes('mp3') || mime.includes('mpeg')) {
                return { data: raw, format: 'mp3' };
            }
            if (mime.includes('wav')) {
                return { data: raw, format: 'wav' };
            }
            // Gemini returns linear PCM (L16) 24kHz mono by default
            const rateMatch = /rate=(\d+)/.exec(mime);
            const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
            return { data: pcmToWavArrayBuffer(raw, sampleRate, 1, 16), format: 'wav' };
        }

        case 'elevenlabs': {
            const voiceId = encodeURIComponent(settings.elevenlabs_voice.trim());
            const res = await transport({
                url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
                method: 'POST',
                headers: {
                    'xi-api-key': settings.elevenlabs_apiKey.trim(),
                    'Content-Type': 'application/json',
                    Accept: 'audio/mpeg',
                },
                body: JSON.stringify({
                    text,
                    model_id: settings.elevenlabs_model || 'eleven_multilingual_v2',
                    voice_settings: {
                        stability: settings.elevenlabs_stability,
                        similarity_boost: settings.elevenlabs_similarity,
                    },
                }),
            });
            assertOk('elevenlabs', res, 'ElevenLabs TTS');
            return { data: res.arrayBuffer, format: 'mp3' };
        }

        case 'azure': {
            const region = settings.azure_region.trim();
            const voice = settings.azure_voice.trim() || 'en-US-JennyNeural';
            const outputFormat = settings.azure_outputFormat || 'audio-24khz-96kbitrate-mono-mp3';
            const res = await transport({
                url: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
                method: 'POST',
                headers: {
                    'Ocp-Apim-Subscription-Key': settings.azure_apiKey.trim(),
                    'Content-Type': 'application/ssml+xml',
                    'X-Microsoft-OutputFormat': outputFormat,
                    'User-Agent': 'SpaceforgeTTS',
                },
                body: buildAzureSsml(text, voice),
            });
            assertOk('azure', res, 'Azure TTS');
            return {
                data: res.arrayBuffer,
                format: outputFormat.includes('riff') ? 'wav' : 'mp3',
            };
        }

        case 'hume': {
            const utterance: Record<string, unknown> = { text };
            if (settings.hume_ttsVoice.trim()) {
                utterance.voice = {
                    name: settings.hume_ttsVoice.trim(),
                    provider: settings.hume_sourceType || 'HUME_AI',
                };
            }
            if (settings.hume_ttsInstructions.trim()) {
                utterance.description = settings.hume_ttsInstructions.trim();
            }
            const res = await transport({
                url: 'https://api.hume.ai/v0/tts',
                method: 'POST',
                headers: {
                    'X-Hume-Api-Key': settings.hume_apiKey.trim(),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    utterances: [utterance],
                    format: { type: 'mp3' },
                }),
            });
            assertOk('hume', res, 'Hume TTS');
            const json = res.json as { generations?: Array<{ audio?: string }> } | undefined;
            const audioB64 = json?.generations?.[0]?.audio;
            if (!audioB64) {
                throw new TtsProviderError('hume', 502, 'Hume TTS returned no audio payload.');
            }
            return { data: base64ToArrayBuffer(audioB64), format: 'mp3' };
        }

        case 'minimax': {
            const host = settings.minimax_useChinaEndpoint ? 'https://api.minimaxi.com' : 'https://api.minimax.io';
            const groupId = encodeURIComponent(settings.minimax_groupId.trim());
            const res = await transport({
                url: `${host}/v1/t2a_v2?GroupId=${groupId}`,
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${settings.minimax_apiKey.trim()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: settings.minimax_ttsModel || 'speech-2.6-turbo',
                    text,
                    stream: false,
                    voice_setting: {
                        voice_id: settings.minimax_ttsVoice || 'English_Graceful_Lady',
                        speed: 1,
                        vol: 1,
                        pitch: 0,
                    },
                    audio_setting: {
                        sample_rate: 32000,
                        bitrate: 128000,
                        format: 'mp3',
                        channel: 1,
                    },
                }),
            });
            assertOk('minimax', res, 'MiniMax TTS');
            const json = res.json as {
                base_resp?: { status_code?: number; status_msg?: string };
                data?: { audio?: string };
            } | undefined;
            if (json?.base_resp?.status_code && json.base_resp.status_code !== 0) {
                throw new TtsProviderError(
                    'minimax',
                    400,
                    `MiniMax TTS error (${json.base_resp.status_code}): ${json.base_resp.status_msg || 'Request failed'}`,
                );
            }
            const audioHex = json?.data?.audio;
            if (!audioHex) {
                throw new TtsProviderError('minimax', 502, 'MiniMax returned no audio hex payload.');
            }
            return { data: hexToArrayBuffer(audioHex), format: 'mp3' };
        }

        case 'fish': {
            const body: Record<string, unknown> = {
                text,
                format: 'mp3',
                mp3_bitrate: 128,
            };
            if (settings.fish_voiceId.trim()) {
                body.reference_id = settings.fish_voiceId.trim();
            }
            if (settings.fish_sentencePause === 'none') {
                body.latency = 'balanced';
            } else if (settings.fish_sentencePause === 'long') {
                body.chunk_length = 200;
            }
            const res = await transport({
                url: 'https://api.fish.audio/v1/tts',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${settings.fish_apiKey.trim()}`,
                    'Content-Type': 'application/json',
                    model: settings.fish_model || 's1',
                },
                body: JSON.stringify(body),
            });
            assertOk('fish', res, 'Fish Audio TTS');
            return { data: res.arrayBuffer, format: 'mp3' };
        }

        case 'inworld': {
            const res = await transport({
                url: 'https://api.inworld.ai/tts/v1/voice',
                method: 'POST',
                headers: {
                    Authorization: `Basic ${settings.inworld_apiKey.trim()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text,
                    voiceId: settings.inworld_voiceId || 'Ronald',
                    modelId: settings.inworld_modelId || 'inworld-tts-1',
                    audioConfig: {
                        audioEncoding: 'MP3',
                    },
                }),
            });
            assertOk('inworld', res, 'Inworld TTS');
            const json = res.json as { audioContent?: string } | undefined;
            if (!json?.audioContent) {
                throw new TtsProviderError('inworld', 502, 'Inworld returned no audioContent.');
            }
            return { data: base64ToArrayBuffer(json.audioContent), format: 'mp3' };
        }

        case 'polly': {
            const body = JSON.stringify({
                Engine: settings.polly_engine || 'neural',
                OutputFormat: 'mp3',
                Text: text,
                VoiceId: settings.polly_voiceId || 'Joanna',
            });
            const signed = await signAwsPollyRequest({
                method: 'POST',
                region: settings.polly_region || 'us-east-1',
                path: '/v1/speech',
                body,
                accessKeyId: settings.polly_accessKeyId.trim(),
                secretAccessKey: settings.polly_secretAccessKey.trim(),
                contentType: 'application/json',
            });
            const res = await transport({
                url: signed.url,
                method: 'POST',
                headers: signed.headers,
                body,
            });
            assertOk('polly', res, 'Amazon Polly TTS');
            return { data: res.arrayBuffer, format: 'mp3' };
        }

        case 'speechify': {
            const pieces = splitTextForLimit(text, 1950);
            const parts: ArrayBuffer[] = [];
            for (const piece of pieces) {
                const res = await transport({
                    url: 'https://api.speechify.ai/v1/audio/speech',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${settings.speechify_apiKey.trim()}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        input: piece,
                        voice_id: settings.speechify_voice || 'dominic_32',
                        model: settings.speechify_model || 'simba-3.2',
                        audio_format: 'mp3',
                    }),
                });
                assertOk('speechify', res, 'Speechify TTS');
                const json = res.json as { audio_data?: string } | undefined;
                if (!json?.audio_data) {
                    throw new TtsProviderError('speechify', 502, 'Speechify returned no audio_data.');
                }
                parts.push(base64ToArrayBuffer(json.audio_data));
            }
            if (parts.length === 1) {
                return { data: parts[0], format: 'mp3' };
            }
            const totalLen = parts.reduce((sum, buf) => sum + buf.byteLength, 0);
            const combined = new Uint8Array(totalLen);
            let offset = 0;
            for (const buf of parts) {
                combined.set(new Uint8Array(buf), offset);
                offset += buf.byteLength;
            }
            return { data: combined.buffer, format: 'mp3' };
        }
    }
}

/**
 * Fetch available voices from provider discovery endpoints (returns static curated fallback when offline/unsupported).
 */
export async function listTtsVoices(
    settings: TtsSettings,
    transport: TtsHttpTransport = defaultTtsTransport,
): Promise<TtsVoiceOption[]> {
    switch (settings.provider) {
        case 'openai':
            return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']
                .map(id => ({ id, label: id }));

        case 'gemini':
            return ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe']
                .map(id => ({ id, label: id }));

        case 'elevenlabs': {
            if (!settings.elevenlabs_apiKey.trim()) return [];
            const res = await transport({
                url: 'https://api.elevenlabs.io/v2/voices',
                method: 'GET',
                headers: { 'xi-api-key': settings.elevenlabs_apiKey.trim() },
            });
            assertOk('elevenlabs', res, 'ElevenLabs list voices');
            const voices = (res.json as { voices?: Array<{ voice_id: string; name: string }> } | undefined)?.voices ?? [];
            return voices.map(v => ({ id: v.voice_id, label: v.name }));
        }

        case 'azure': {
            if (!settings.azure_apiKey.trim() || !settings.azure_region.trim()) return [];
            const res = await transport({
                url: `https://${settings.azure_region.trim()}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
                method: 'GET',
                headers: { 'Ocp-Apim-Subscription-Key': settings.azure_apiKey.trim() },
            });
            assertOk('azure', res, 'Azure list voices');
            const list = Array.isArray(res.json) ? (res.json as Array<{ ShortName: string; DisplayName: string; Locale: string }>) : [];
            return list.slice(0, 120).map(v => ({ id: v.ShortName, label: `${v.DisplayName} (${v.Locale})` }));
        }

        case 'hume': {
            if (!settings.hume_apiKey.trim()) return [];
            const res = await transport({
                url: `https://api.hume.ai/v0/tts/voices?provider=${encodeURIComponent(settings.hume_sourceType || 'HUME_AI')}&page_size=50`,
                method: 'GET',
                headers: { 'X-Hume-Api-Key': settings.hume_apiKey.trim() },
            });
            assertOk('hume', res, 'Hume list voices');
            const voices = (res.json as { voices_page?: Array<{ name: string }> } | undefined)?.voices_page ?? [];
            return voices.map(v => ({ id: v.name, label: v.name }));
        }

        case 'inworld': {
            if (!settings.inworld_apiKey.trim()) return [];
            const res = await transport({
                url: 'https://api.inworld.ai/tts/v1/voices',
                method: 'GET',
                headers: { Authorization: `Basic ${settings.inworld_apiKey.trim()}` },
            });
            assertOk('inworld', res, 'Inworld list voices');
            const voices = (res.json as { voices?: Array<{ voiceId: string; displayName?: string }> } | undefined)?.voices ?? [];
            return voices.map(v => ({ id: v.voiceId, label: v.displayName || v.voiceId }));
        }

        case 'fish': {
            if (!settings.fish_apiKey.trim()) return [];
            const res = await transport({
                url: 'https://api.fish.audio/model?page_size=20&self=true',
                method: 'GET',
                headers: { Authorization: `Bearer ${settings.fish_apiKey.trim()}` },
            });
            assertOk('fish', res, 'Fish list voices');
            const items = (res.json as { items?: Array<{ _id: string; title: string }> } | undefined)?.items ?? [];
            return items.map(v => ({ id: v._id, label: v.title }));
        }

        case 'polly': {
            if (!settings.polly_accessKeyId.trim() || !settings.polly_secretAccessKey.trim()) return [];
            const signed = await signAwsPollyRequest({
                method: 'GET',
                region: settings.polly_region || 'us-east-1',
                path: '/v1/voices',
                body: '',
                accessKeyId: settings.polly_accessKeyId.trim(),
                secretAccessKey: settings.polly_secretAccessKey.trim(),
            });
            const res = await transport({
                url: signed.url,
                method: 'GET',
                headers: signed.headers,
            });
            assertOk('polly', res, 'Polly list voices');
            const voices = (res.json as { Voices?: Array<{ Id: string; Name: string; LanguageCode: string }> } | undefined)?.Voices ?? [];
            return voices.map(v => ({ id: v.Id, label: `${v.Name} (${v.LanguageCode})` }));
        }

        case 'speechify': {
            if (!settings.speechify_apiKey.trim()) return [];
            const res = await transport({
                url: 'https://api.speechify.ai/v1/voices',
                method: 'GET',
                headers: { Authorization: `Bearer ${settings.speechify_apiKey.trim()}` },
            });
            assertOk('speechify', res, 'Speechify list voices');
            const voices = Array.isArray(res.json) ? (res.json as Array<{ id: string; display_name?: string; locale?: string }>) : [];
            return voices.slice(0, 100).map(v => ({
                id: v.id,
                label: v.display_name ? `${v.display_name} (${v.locale || ''})` : v.id,
            }));
        }

        case 'openaicompat':
        case 'minimax':
            return [];
    }
}
