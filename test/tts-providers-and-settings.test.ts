import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_TTS_SETTINGS,
    detectAloudSettingsPreview,
    normalizeTtsSettings,
    parseAloudTtsSettings,
    shareSpaceforgeApiKeys,
    TTS_PROVIDER_IDS,
    TtsSettings,
} from '../models/tts';
import { DEFAULT_SETTINGS } from '../models/settings';
import {
    describeActiveTtsModel,
    listTtsVoices,
    normalizeRequestUrlResponse,
    synthesizeSpeech,
    TtsHttpRequest,
    TtsHttpTransport,
} from '../services/tts/tts-providers';
import { arrayBufferToBase64 } from '../utils/tts-text';

function makeSettings(overrides: Partial<TtsSettings> = {}): TtsSettings {
    return {
        ...normalizeTtsSettings(DEFAULT_TTS_SETTINGS),
        ...overrides,
    };
}

test('parses and previews full obsidian-aloud-tts data.json configuration', () => {
    const rawAloud = {
        version: 1,
        modelProvider: 'minimax',
        chunkType: 'paragraph',
        playbackSpeed: 1.4,
        autoScrollPlayerView: false,
        cacheType: 'vault',
        cacheDurationMillis: 3600000,
        audioFolder: 'Audio/TTS',
        audioExportDestination: 'browser',
        openai_apiKey: 'sk-openai',
        gemini_apiKey: 'AIza-gem',
        elevenlabs_apiKey: 'xi-el',
        elevenlabs_voice: 'voice-123',
        minimax_apiKey: 'mm-key',
        minimax_groupId: 'grp-42',
        minimax_useChinaEndpoint: true,
        polly_accessKeyId: 'AKIA123',
        polly_secretAccessKey: 'SECRET456',
        polly_region: 'eu-west-1',
    };

    const preview = detectAloudSettingsPreview(rawAloud);
    assert.ok(preview);
    assert.equal(preview.provider, 'minimax');
    assert.deepEqual(
        preview.configuredProviders,
        ['openai', 'gemini', 'elevenlabs', 'minimax', 'polly'],
    );

    const parsed = parseAloudTtsSettings(rawAloud);
    assert.ok(parsed);
    assert.equal(parsed.provider, 'minimax');
    assert.equal(parsed.chunkType, 'paragraph');
    assert.equal(parsed.playbackSpeed, 1.4);
    assert.equal(parsed.autoScroll, false);
    assert.equal(parsed.cacheType, 'vault');
    assert.equal(parsed.audioFolder, 'Audio/TTS');
    assert.equal(parsed.audioExportDestination, 'browser');
    assert.equal(parsed.minimax_useChinaEndpoint, true);
    assert.equal(parsed.polly_region, 'eu-west-1');
});

test('shares Spaceforge AI API keys into empty TTS slots without overwriting existing keys', () => {
    const tts = makeSettings({ gemini_apiKey: 'keep-existing' });
    const sfSettings = {
        ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
        openaiApiKey: 'sk-spaceforge',
        geminiApiKey: 'AIza-spaceforge',
        openaiCompatibleApiKey: 'compat-sf',
    };

    const changed = shareSpaceforgeApiKeys(tts, sfSettings);
    assert.equal(changed, true);
    assert.equal(tts.openai_apiKey, 'sk-spaceforge');
    assert.equal(tts.gemini_apiKey, 'keep-existing');
    assert.equal(tts.openaicompat_apiKey, 'compat-sf');
});

test('supports synthesis across all 11 Aloud TTS endpoints with expected URLs, headers, and payloads', async () => {
    const sampleBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const sampleB64 = arrayBufferToBase64(sampleBytes);

    const seen: Record<string, TtsHttpRequest> = {};

    const cases: Array<{
        provider: TtsSettings['provider'];
        settings: Partial<TtsSettings>;
        response: { status: number; json?: unknown; arrayBuffer?: ArrayBuffer };
        expectedUrlPart: string;
        expectedFormat: 'mp3' | 'wav';
        checkReq: (req: TtsHttpRequest) => void;
    }> = [
        {
            provider: 'openai',
            settings: { openai_apiKey: 'sk-1', openai_ttsModel: 'gpt-4o-mini-tts', openai_ttsVoice: 'nova', openai_ttsInstructions: 'Calm pace' },
            response: { status: 200, arrayBuffer: sampleBytes },
            expectedUrlPart: 'https://api.openai.com/v1/audio/speech',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.equal(req.headers?.Authorization, 'Bearer sk-1');
                const body = JSON.parse(req.body ?? '{}');
                assert.equal(body.model, 'gpt-4o-mini-tts');
                assert.equal(body.instructions, 'Calm pace');
            },
        },
        {
            provider: 'openaicompat',
            settings: {
                openaicompat_apiBase: 'http://localhost:8880',
                openaicompat_apiKey: 'secret',
                openaicompat_ttsModel: 'kokoro',
                openaicompat_ttsVoice: 'af_bella',
                openaicompat_responseFormat: 'pcm',
            },
            response: { status: 200, arrayBuffer: new Uint8Array([0, 0, 1, 0]).buffer },
            expectedUrlPart: 'http://localhost:8880/v1/audio/speech',
            expectedFormat: 'wav',
            checkReq: req => {
                const body = JSON.parse(req.body ?? '{}');
                assert.equal(body.response_format, 'pcm');
            },
        },
        {
            provider: 'gemini',
            settings: { gemini_apiKey: 'gem-1', gemini_ttsModel: 'gemini-2.5-flash-preview-tts', gemini_ttsVoice: 'Kore' },
            response: {
                status: 200,
                json: {
                    candidates: [{ content: { parts: [{ inlineData: { data: sampleB64, mimeType: 'audio/L16;rate=24000' } }] } }],
                },
            },
            expectedUrlPart: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
            expectedFormat: 'wav',
            checkReq: req => {
                assert.equal(req.headers?.['x-goog-api-key'], 'gem-1');
                const body = JSON.parse(req.body ?? '{}');
                assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
            },
        },
        {
            provider: 'elevenlabs',
            settings: { elevenlabs_apiKey: 'el-1', elevenlabs_voice: 'v-99' },
            response: { status: 200, arrayBuffer: sampleBytes },
            expectedUrlPart: 'https://api.elevenlabs.io/v1/text-to-speech/v-99',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.equal(req.headers?.['xi-api-key'], 'el-1');
            },
        },
        {
            provider: 'azure',
            settings: { azure_apiKey: 'az-1', azure_region: 'westus2', azure_voice: 'en-US-AriaNeural' },
            response: { status: 200, arrayBuffer: sampleBytes },
            expectedUrlPart: 'https://westus2.tts.speech.microsoft.com/cognitiveservices/v1',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.equal(req.headers?.['Ocp-Apim-Subscription-Key'], 'az-1');
                assert.match(req.body ?? '', /en-US-AriaNeural/);
            },
        },
        {
            provider: 'hume',
            settings: { hume_apiKey: 'hm-1', hume_ttsVoice: 'ITO' },
            response: { status: 200, json: { generations: [{ audio: sampleB64 }] } },
            expectedUrlPart: 'https://api.hume.ai/v0/tts',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.equal(req.headers?.['X-Hume-Api-Key'], 'hm-1');
            },
        },
        {
            provider: 'minimax',
            settings: { minimax_apiKey: 'mm-1', minimax_groupId: 'grp-1', minimax_useChinaEndpoint: false },
            response: { status: 200, json: { base_resp: { status_code: 0 }, data: { audio: '0a0b0c0d' } } },
            expectedUrlPart: 'https://api.minimax.io/v1/t2a_v2?GroupId=grp-1',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.equal(req.headers?.Authorization, 'Bearer mm-1');
            },
        },
        {
            provider: 'fish',
            settings: { fish_apiKey: 'fs-1', fish_model: 's2-pro', fish_voiceId: 'ref-7' },
            response: { status: 200, arrayBuffer: sampleBytes },
            expectedUrlPart: 'https://api.fish.audio/v1/tts',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.equal(req.headers?.model, 's2-pro');
                assert.equal(JSON.parse(req.body ?? '{}').reference_id, 'ref-7');
            },
        },
        {
            provider: 'inworld',
            settings: { inworld_apiKey: 'iw-b64', inworld_voiceId: 'Ronald' },
            response: { status: 200, json: { audioContent: sampleB64 } },
            expectedUrlPart: 'https://api.inworld.ai/tts/v1/voice',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.equal(req.headers?.Authorization, 'Basic iw-b64');
            },
        },
        {
            provider: 'polly',
            settings: { polly_accessKeyId: 'AKIA', polly_secretAccessKey: 'SECRET', polly_region: 'us-east-1', polly_voiceId: 'Joanna' },
            response: { status: 200, arrayBuffer: sampleBytes },
            expectedUrlPart: 'https://polly.us-east-1.amazonaws.com/v1/speech',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.match(req.headers?.Authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKIA\//);
                assert.ok(req.headers?.['X-Amz-Date']);
            },
        },
        {
            provider: 'speechify',
            settings: { speechify_apiKey: 'sp-1', speechify_voice: 'dominic_32' },
            response: { status: 200, json: { audio_data: sampleB64 } },
            expectedUrlPart: 'https://api.speechify.ai/v1/audio/speech',
            expectedFormat: 'mp3',
            checkReq: req => {
                assert.equal(req.headers?.Authorization, 'Bearer sp-1');
            },
        },
    ];

    assert.equal(cases.length, TTS_PROVIDER_IDS.length);

    for (const c of cases) {
        const s = makeSettings({ provider: c.provider, ...c.settings });
        const transport: TtsHttpTransport = async req => {
            seen[c.provider] = req;
            return {
                status: c.response.status,
                headers: {},
                arrayBuffer: c.response.arrayBuffer ?? new ArrayBuffer(0),
                text: c.response.json ? JSON.stringify(c.response.json) : '',
                json: c.response.json,
            };
        };

        const out = await synthesizeSpeech('Hello spaced repetition.', s, transport);
        assert.equal(out.format, c.expectedFormat, `${c.provider} format`);
        assert.ok(out.data.byteLength > 0, `${c.provider} audio non-empty`);
        assert.ok(seen[c.provider].url.includes(c.expectedUrlPart), `${c.provider} URL matched`);
        c.checkReq(seen[c.provider]);

        const desc = describeActiveTtsModel(s);
        assert.equal(desc.provider, c.provider);
    }
});

test('lists voices for providers with remote discovery endpoints', async () => {
    const s = makeSettings({ provider: 'elevenlabs', elevenlabs_apiKey: 'el-1' });
    const voices = await listTtsVoices(s, async req => ({
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: '',
        json: { voices: [{ voice_id: 'v1', name: 'Rachel' }] },
    }));
    assert.deepEqual(voices, [{ id: 'v1', label: 'Rachel' }]);
});

test('normalizeRequestUrlResponse ignores lazy .json/.text getter errors on binary audio payloads', () => {
    const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x64, 0x00, 0x00, 0x00, 0x54]).buffer;

    const fakeBinaryRes = {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
        arrayBuffer: mp3Bytes,
        get text(): string {
            return new TextDecoder().decode(mp3Bytes);
        },
        get json(): unknown {
            return JSON.parse(this.text);
        },
    };
    const normalizedBinary = normalizeRequestUrlResponse(fakeBinaryRes);
    assert.equal(normalizedBinary.status, 200);
    assert.equal(normalizedBinary.arrayBuffer.byteLength, mp3Bytes.byteLength);
    assert.equal(normalizedBinary.json, undefined);
    assert.equal(normalizedBinary.text, '');

    const fakeNoHeaderBinaryRes = {
        status: 200,
        headers: {},
        arrayBuffer: mp3Bytes,
        get text(): string {
            return new TextDecoder().decode(mp3Bytes);
        },
        get json(): unknown {
            return JSON.parse(this.text);
        },
    };
    const normalizedFallback = normalizeRequestUrlResponse(fakeNoHeaderBinaryRes);
    assert.equal(normalizedFallback.arrayBuffer.byteLength, mp3Bytes.byteLength);
    assert.equal(normalizedFallback.json, undefined);
});


test('saved audio defaults to the hidden .tts folder Aloud shares, and Aloud\'s choices map across', async () => {
    const { normalizeExportDestination, normalizeTtsSettings, DEFAULT_TTS_SETTINGS, TTS_EXPORT_DIR } = await import('../models/tts');
    assert.equal(DEFAULT_TTS_SETTINGS.audioExportDestination, 'cache');
    assert.equal(TTS_EXPORT_DIR, '.tts/exports');
    assert.equal(normalizeExportDestination('download'), 'browser', 'Aloud says download');
    assert.equal(normalizeExportDestination('browser'), 'browser');
    assert.equal(normalizeExportDestination('vault', 'spaceforge/tts-audio'), 'cache', 'the old untouched default moves to the shared folder');
    assert.equal(normalizeExportDestination('vault', 'Audio/Lectures'), 'vault', 'a folder the reader chose is kept');
    assert.equal(normalizeExportDestination(undefined), 'cache');
    assert.equal(normalizeTtsSettings({ audioExportDestination: 'vault', audioFolder: 'Audio' }).audioExportDestination, 'vault');
});
