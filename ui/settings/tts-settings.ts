import { Notice, Setting } from 'obsidian';
import type SpaceforgePlugin from '../../main';
import {
    getActiveVoiceLabel,
    ONE_HOUR_MS,
    shareSpaceforgeApiKeys,
    TTS_PROVIDERS,
    TtsCacheType,
    TtsChunkType,
    TtsExportDestination,
    TtsFishSentencePause,
    TtsFishVoiceSource,
    TtsHumeSourceType,
    TtsOpenAICompatFormat,
    TtsPollyEngine,
    TtsProviderId,
    TtsSettings,
    TtsTargetSource,
} from '../../models/tts';
import { validateTtsConfiguration } from '../../services/tts/tts-providers';

const CACHE_DURATION_OPTIONS: Array<{ value: string; label: string }> = [
    { value: String(ONE_HOUR_MS), label: '1 hour' },
    { value: String(24 * ONE_HOUR_MS), label: '24 hours' },
    { value: String(7 * 24 * ONE_HOUR_MS), label: '7 days' },
    { value: String(30 * 24 * ONE_HOUR_MS), label: '30 days' },
    { value: '0', label: 'Keep forever (until cleared)' },
];

const OPENAI_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const;
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const;
const OPENAI_COMPAT_FORMATS: TtsOpenAICompatFormat[] = ['mp3', 'wav', 'pcm'];
const GEMINI_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'] as const;
const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe'] as const;
const ELEVENLABS_MODELS = ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_monolingual_v1'] as const;
const FISH_MODELS = ['s1', 's2-pro'] as const;
const INWORLD_MODELS = ['inworld-tts-1', 'inworld-tts-1-max'] as const;
const SPEECHIFY_MODELS = ['simba-3.2', 'simba-3.0'] as const;

export function renderTtsSettingsSection(container: HTMLElement, plugin: SpaceforgePlugin): void {
    const tts: TtsSettings = plugin.settings.tts;
    const save = () => void plugin.savePluginData();

    const statusBox = container.createDiv({ cls: 'sf-info-box sf-tts-settings-status sf-hidden' });
    const showStatus = (message: string, level: 'ok' | 'warn' | 'error' = 'ok') => {
        statusBox.removeClass('sf-hidden', 'is-ok', 'is-warn', 'is-error');
        statusBox.addClass(`is-${level}`);
        statusBox.setText(message);
    };

    // --- Test & Validation Row ---
    new Setting(container)
        .setName('Test TTS voice')
        .setDesc('Synthesize a short sample phrase using the selected TTS provider and voice.')
        .addButton(btn =>
            btn.setButtonText('Play sample').setCta().onClick(async () => {
                const err = validateTtsConfiguration(tts);
                if (err) {
                    showStatus(err, 'warn');
                    return;
                }
                if (!plugin.ttsService) return;
                showStatus(`Synthesizing sample with ${tts.provider} (${getActiveVoiceLabel(tts)})…`, 'ok');
                await plugin.ttsService.testVoice();
                const snap = plugin.ttsService.getSnapshot();
                if (snap.status === 'error' && snap.errorMessage) {
                    showStatus(snap.errorMessage, 'error');
                } else {
                    showStatus(`Playing sample with ${tts.provider} (${getActiveVoiceLabel(tts)}).`, 'ok');
                }
            }),
        );

    // --- Provider selector + dynamic endpoint fields ---
    new Setting(container)
        .setName('TTS provider')
        .setDesc('Select any of the 11 supported text-to-speech endpoints.')
        .addDropdown(dd => {
            for (const p of TTS_PROVIDERS) {
                dd.addOption(p.id, p.label);
            }
            dd.setValue(tts.provider);
            dd.onChange(value => {
                tts.provider = value as TtsProviderId;
                save();
                renderProviderFields();
            });
        });

    const providerSlot = container.createDiv({ cls: 'sf-settings-subsection sf-tts-provider-slot' });

    const addTextField = (
        name: string,
        value: string,
        onChange: (val: string) => void,
        opts: { desc?: string; placeholder?: string; secret?: boolean; trim?: boolean } = {},
    ): void => {
        const row = new Setting(providerSlot).setName(name);
        if (opts.desc) row.setDesc(opts.desc);
        row.addText(t => {
            if (opts.secret) {
                t.inputEl.type = 'password';
                t.inputEl.autocomplete = 'off';
            }
            if (opts.placeholder) t.setPlaceholder(opts.placeholder);
            t.setValue(value).onChange(v => {
                onChange(opts.trim === false ? v : v.trim());
                save();
            });
        });
    };

    const addTextAreaField = (
        name: string,
        value: string,
        onChange: (val: string) => void,
        opts: { desc?: string; placeholder?: string } = {},
    ): void => {
        const row = new Setting(providerSlot).setName(name);
        if (opts.desc) row.setDesc(opts.desc);
        row.addTextArea(t => {
            if (opts.placeholder) t.setPlaceholder(opts.placeholder);
            t.setValue(value).onChange(v => {
                onChange(v);
                save();
            });
        });
    };

    const addListDropdownField = (
        name: string,
        options: ReadonlyArray<string | { value: string; label: string }>,
        value: string,
        onChange: (val: string) => void,
        opts: { desc?: string; rerender?: boolean } = {},
    ): void => {
        const row = new Setting(providerSlot).setName(name);
        if (opts.desc) row.setDesc(opts.desc);
        row.addDropdown(dd => {
            for (const opt of options) {
                if (typeof opt === 'string') dd.addOption(opt, opt);
                else dd.addOption(opt.value, opt.label);
            }
            dd.setValue(value).onChange(v => {
                onChange(v);
                save();
                if (opts.rerender) renderProviderFields();
            });
        });
    };

    const addSliderField = (
        name: string,
        min: number,
        max: number,
        step: number,
        value: number,
        onChange: (val: number) => void,
    ): void => {
        new Setting(providerSlot)
            .setName(name)
            .addSlider(s =>
                s.setLimits(min, max, step).setValue(value).setDynamicTooltip().onChange(v => {
                    onChange(v);
                    save();
                }),
            );
    };

    const addVoiceDiscoveryRow = (parent: HTMLElement, currentVoice: string, onSelect: (voiceId: string) => void) => {
        const row = new Setting(parent)
            .setName('Discover TTS voices')
            .setDesc('Fetch available voice IDs directly from this provider endpoint.');
        let selectEl: HTMLSelectElement | null = null;
        row.addDropdown(dd => {
            selectEl = dd.selectEl;
            dd.addOption('', currentVoice ? `Current: ${currentVoice}` : 'Click "Fetch voices" to load…');
            dd.onChange(val => {
                if (!val) return;
                onSelect(val);
                save();
                renderProviderFields();
            });
        });
        row.addButton(btn =>
            btn.setButtonText('Fetch voices').onClick(async () => {
                if (!plugin.ttsService) return;
                try {
                    const voices = await plugin.ttsService.fetchVoices();
                    if (!selectEl) return;
                    selectEl.empty();
                    if (voices.length === 0) {
                        selectEl.createEl('option', { value: '', text: 'No remote voices returned' });
                        return;
                    }
                    selectEl.createEl('option', { value: '', text: `Select (${voices.length} voices)…` });
                    for (const v of voices) {
                        const opt = selectEl.createEl('option', { value: v.id, text: v.label });
                        if (v.id === currentVoice) opt.selected = true;
                    }
                    showStatus(`Loaded ${voices.length} voice options for ${tts.provider}.`, 'ok');
                } catch (err) {
                    showStatus(err instanceof Error ? err.message : String(err), 'error');
                }
            }),
        );
    };

    const renderProviderFields = (): void => {
        providerSlot.empty();
        const meta = TTS_PROVIDERS.find(p => p.id === tts.provider);
        new Setting(providerSlot)
            .setName(`${meta?.label ?? tts.provider} endpoint`)
            .setDesc(`Endpoint: ${meta?.endpointHint ?? ''}`)
            .setHeading();

        switch (tts.provider) {
            case 'openai': {
                addTextField('TTS API key', tts.openai_apiKey, v => { tts.openai_apiKey = v; }, {
                    desc: 'OpenAI API key for /v1/audio/speech.',
                    placeholder: 'Enter OpenAI API key',
                    secret: true,
                });
                addListDropdownField('TTS model', OPENAI_MODELS, tts.openai_ttsModel || 'gpt-4o-mini-tts', v => { tts.openai_ttsModel = v; }, {
                    desc: 'Select an OpenAI speech model.',
                    rerender: true,
                });
                addListDropdownField('TTS voice', OPENAI_VOICES, tts.openai_ttsVoice || 'shimmer', v => { tts.openai_ttsVoice = v; }, {
                    desc: 'OpenAI voice preset.',
                });
                if (tts.openai_ttsModel === 'gpt-4o-mini-tts') {
                    addTextAreaField('TTS voice instructions', tts.openai_ttsInstructions, v => { tts.openai_ttsInstructions = v; }, {
                        desc: 'Optional tone and cadence instructions for this model.',
                        placeholder: 'Speak clearly and calmly at a teaching pace...',
                    });
                }
                break;
            }

            case 'openaicompat': {
                addTextField('TTS custom base URL', tts.openaicompat_apiBase, v => { tts.openaicompat_apiBase = v; }, {
                    desc: 'Base URL for an OpenAI-compatible speech server (e.g. Kokoro, LocalAI, AllTalk, Speaches).',
                    placeholder: 'Enter server base URL',
                });
                addTextField('TTS API key', tts.openaicompat_apiKey, v => { tts.openaicompat_apiKey = v; }, {
                    desc: 'Optional bearer API key if required by the custom server.',
                    placeholder: 'Optional key',
                    secret: true,
                });
                addTextField('TTS model', tts.openaicompat_ttsModel, v => { tts.openaicompat_ttsModel = v; }, {
                    placeholder: 'Enter model name',
                });
                addTextField('TTS voice', tts.openaicompat_ttsVoice, v => { tts.openaicompat_ttsVoice = v; }, {
                    placeholder: 'Enter voice name',
                });
                addListDropdownField('Response audio format', OPENAI_COMPAT_FORMATS, tts.openaicompat_responseFormat, v => {
                    tts.openaicompat_responseFormat = v as TtsOpenAICompatFormat;
                });
                addSliderField('Server generation speed', 0.25, 2.5, 0.05, tts.openaicompat_generationSpeed, v => {
                    tts.openaicompat_generationSpeed = v;
                });
                break;
            }

            case 'gemini': {
                addTextField('TTS API key', tts.gemini_apiKey, v => { tts.gemini_apiKey = v; }, {
                    desc: 'Google Gemini API key.',
                    placeholder: 'Enter Gemini API key',
                    secret: true,
                });
                addListDropdownField('TTS model', GEMINI_MODELS, tts.gemini_ttsModel || 'gemini-2.5-flash-preview-tts', v => {
                    tts.gemini_ttsModel = v;
                });
                addListDropdownField('TTS voice', GEMINI_VOICES, tts.gemini_ttsVoice || 'Zephyr', v => {
                    tts.gemini_ttsVoice = v;
                });
                addTextAreaField('TTS style instructions', tts.gemini_ttsInstructions, v => { tts.gemini_ttsInstructions = v; }, {
                    desc: 'Optional prompt guidance prepended to Gemini TTS requests.',
                    placeholder: 'Read in a clear educational tone...',
                });
                break;
            }

            case 'elevenlabs': {
                addTextField('TTS API key', tts.elevenlabs_apiKey, v => { tts.elevenlabs_apiKey = v; }, {
                    placeholder: 'Enter ElevenLabs API key',
                    secret: true,
                });
                addListDropdownField('TTS model', ELEVENLABS_MODELS, tts.elevenlabs_model || 'eleven_multilingual_v2', v => {
                    tts.elevenlabs_model = v;
                });
                addTextField('TTS voice ID', tts.elevenlabs_voice, v => { tts.elevenlabs_voice = v; }, {
                    placeholder: 'Voice ID',
                });
                addVoiceDiscoveryRow(providerSlot, tts.elevenlabs_voice, v => { tts.elevenlabs_voice = v; });
                addSliderField('Voice stability', 0, 1, 0.05, tts.elevenlabs_stability, v => { tts.elevenlabs_stability = v; });
                addSliderField('Voice similarity boost', 0, 1, 0.05, tts.elevenlabs_similarity, v => { tts.elevenlabs_similarity = v; });
                break;
            }

            case 'azure': {
                addTextField('TTS API key', tts.azure_apiKey, v => { tts.azure_apiKey = v; }, {
                    placeholder: 'Enter Azure speech key',
                    secret: true,
                });
                addTextField('Azure region', tts.azure_region, v => { tts.azure_region = v; }, {
                    placeholder: 'Enter Azure region',
                });
                addTextField('TTS voice', tts.azure_voice, v => { tts.azure_voice = v; }, {
                    placeholder: 'Enter Azure voice ID',
                });
                addVoiceDiscoveryRow(providerSlot, tts.azure_voice, v => { tts.azure_voice = v; });
                addTextField('Azure output format', tts.azure_outputFormat, v => { tts.azure_outputFormat = v; }, {
                    placeholder: 'Enter audio output format',
                });
                break;
            }

            case 'hume': {
                addTextField('TTS API key', tts.hume_apiKey, v => { tts.hume_apiKey = v; }, {
                    placeholder: 'Enter Hume API key',
                    secret: true,
                });
                addListDropdownField(
                    'Hume voice source',
                    [
                        { value: 'HUME_AI', label: 'Hume library' },
                        { value: 'CUSTOM_VOICE', label: 'Custom voice' },
                    ],
                    tts.hume_sourceType,
                    v => { tts.hume_sourceType = v as TtsHumeSourceType; },
                );
                addTextField('TTS voice', tts.hume_ttsVoice, v => { tts.hume_ttsVoice = v; }, {
                    placeholder: 'Voice name',
                });
                addVoiceDiscoveryRow(providerSlot, tts.hume_ttsVoice, v => { tts.hume_ttsVoice = v; });
                addTextAreaField('Hume acting instructions', tts.hume_ttsInstructions, v => { tts.hume_ttsInstructions = v; }, {
                    placeholder: 'Optional voice description...',
                });
                break;
            }

            case 'minimax': {
                addTextField('TTS API key', tts.minimax_apiKey, v => { tts.minimax_apiKey = v; }, {
                    placeholder: 'Enter MiniMax API key',
                    secret: true,
                });
                addTextField('MiniMax group ID', tts.minimax_groupId, v => { tts.minimax_groupId = v; }, {
                    placeholder: 'Group ID',
                });
                addTextField('TTS model', tts.minimax_ttsModel, v => { tts.minimax_ttsModel = v; }, {
                    placeholder: 'Enter model ID',
                });
                addTextField('TTS voice', tts.minimax_ttsVoice, v => { tts.minimax_ttsVoice = v; }, {
                    placeholder: 'Enter voice ID',
                });
                new Setting(providerSlot)
                    .setName('Use China endpoint (api.minimaxi.com)')
                    .addToggle(tg =>
                        tg.setValue(tts.minimax_useChinaEndpoint).onChange(v => {
                            tts.minimax_useChinaEndpoint = v;
                            save();
                        }),
                    );
                break;
            }

            case 'fish': {
                addTextField('TTS API key', tts.fish_apiKey, v => { tts.fish_apiKey = v; }, {
                    placeholder: 'Enter Fish Audio key',
                    secret: true,
                });
                addListDropdownField('TTS model', FISH_MODELS, tts.fish_model || 's1', v => { tts.fish_model = v; });
                addListDropdownField(
                    'Fish voice source',
                    [
                        { value: 'my-voices', label: 'My voices' },
                        { value: 'custom', label: 'Custom reference ID' },
                    ],
                    tts.fish_voiceSource,
                    v => { tts.fish_voiceSource = v as TtsFishVoiceSource; },
                );
                addTextField('Fish voice ID', tts.fish_voiceId, v => { tts.fish_voiceId = v; }, {
                    placeholder: 'Reference model ID',
                });
                addVoiceDiscoveryRow(providerSlot, tts.fish_voiceId, v => { tts.fish_voiceId = v; });
                addListDropdownField(
                    'Sentence pause',
                    [
                        { value: 'none', label: 'None' },
                        { value: 'short', label: 'Short' },
                        { value: 'long', label: 'Long' },
                    ],
                    tts.fish_sentencePause,
                    v => { tts.fish_sentencePause = v as TtsFishSentencePause; },
                );
                break;
            }

            case 'inworld': {
                addTextField('TTS API key (basic token)', tts.inworld_apiKey, v => { tts.inworld_apiKey = v; }, {
                    placeholder: 'Enter Inworld Base64 key',
                    secret: true,
                });
                addListDropdownField('TTS model', INWORLD_MODELS, tts.inworld_modelId || 'inworld-tts-1', v => {
                    tts.inworld_modelId = v;
                });
                addTextField('TTS voice', tts.inworld_voiceId, v => { tts.inworld_voiceId = v; }, {
                    placeholder: 'Enter voice ID',
                });
                addVoiceDiscoveryRow(providerSlot, tts.inworld_voiceId, v => { tts.inworld_voiceId = v; });
                break;
            }

            case 'polly': {
                addTextField('AWS access key ID', tts.polly_accessKeyId, v => { tts.polly_accessKeyId = v; }, {
                    placeholder: 'Enter AWS access key ID',
                    secret: true,
                });
                addTextField('AWS secret access key', tts.polly_secretAccessKey, v => { tts.polly_secretAccessKey = v; }, {
                    placeholder: 'Secret key',
                    secret: true,
                });
                addTextField('AWS region', tts.polly_region, v => { tts.polly_region = v; }, {
                    placeholder: 'Enter AWS region',
                });
                addListDropdownField(
                    'Polly engine',
                    [
                        { value: 'neural', label: 'Neural' },
                        { value: 'standard', label: 'Standard' },
                    ],
                    tts.polly_engine,
                    v => { tts.polly_engine = v as TtsPollyEngine; },
                );
                addTextField('TTS voice', tts.polly_voiceId, v => { tts.polly_voiceId = v; }, {
                    placeholder: 'Enter voice ID',
                });
                addVoiceDiscoveryRow(providerSlot, tts.polly_voiceId, v => { tts.polly_voiceId = v; });
                break;
            }

            case 'speechify': {
                addTextField('TTS API key', tts.speechify_apiKey, v => { tts.speechify_apiKey = v; }, {
                    placeholder: 'Enter Speechify API key',
                    secret: true,
                });
                addListDropdownField('TTS model', SPEECHIFY_MODELS, tts.speechify_model || 'simba-3.2', v => {
                    tts.speechify_model = v;
                });
                addTextField('TTS voice', tts.speechify_voice, v => { tts.speechify_voice = v; }, {
                    placeholder: 'Enter voice ID',
                });
                addVoiceDiscoveryRow(providerSlot, tts.speechify_voice, v => { tts.speechify_voice = v; });
                break;
            }
        }
    };

    renderProviderFields();

    // --- Playback, Highlighting & Auto-scroll ---
    new Setting(container).setName('Playback & highlighting').setHeading();

    new Setting(container)
        .setName('Default read aloud source')
        .setDesc('Auto detects an editor selection, active Study material surface (mind map / visualize / summary / tutor), or falls back to the review note.')
        .addDropdown(dd =>
            dd
                .addOption('auto', 'Auto (context-aware)')
                .addOption('note', 'Review note')
                .addOption('summary', 'Study summary')
                .addOption('mindmap', 'Study mind map')
                .addOption('visualize', 'Study visualize boards')
                .addOption('tutor', 'Study tutor')
                .setValue(tts.defaultSource)
                .onChange(v => {
                    tts.defaultSource = v as TtsTargetSource;
                    save();
                }),
        );

    new Setting(container)
        .setName('Chunking mode')
        .setDesc('Split text into sentences for crisp synchronized highlighting, or paragraphs for longer continuous spans.')
        .addDropdown(dd =>
            dd
                .addOption('sentence', 'Sentence')
                .addOption('paragraph', 'Paragraph')
                .setValue(tts.chunkType)
                .onChange(v => {
                    tts.chunkType = v as TtsChunkType;
                    save();
                }),
        );

    new Setting(container)
        .setName('Playback speed')
        .setDesc('Speed multiplier applied during audio playback (0.5x – 2.5x).')
        .addSlider(s =>
            s
                .setLimits(0.5, 2.5, 0.05)
                .setValue(tts.playbackSpeed)
                .setDynamicTooltip()
                .onChange(v => {
                    tts.playbackSpeed = v;
                    plugin.ttsService?.setPlaybackRate?.(v);
                    save();
                }),
        );

    new Setting(container)
        .setName('Auto-scroll to active highlight')
        .setDesc('Automatically scroll the active note, summary, mind map node, or visual card into view while reading aloud.')
        .addToggle(tg =>
            tg.setValue(tts.autoScroll).onChange(v => {
                tts.autoScroll = v;
                save();
            }),
        );

    // --- Object Cache & Audio Storage ---
    new Setting(container).setName('Audio cache & storage').setHeading();

    new Setting(container)
        .setName('Audio cache')
        .setDesc('Where spoken audio is kept so a passage is never paid for twice. Both options are the same places Obsidian Aloud uses: its local cache on this device, or its hidden .tts folder in the vault (which syncs, and never shows among your notes).')
        .addDropdown(dd =>
            dd
                .addOption('local', 'On this device (shared with Aloud TTS)')
                .addOption('vault', 'Hidden .tts folder in the vault')
                .setValue(tts.cacheType)
                .onChange(v => {
                    tts.cacheType = v as TtsCacheType;
                    save();
                }),
        );

    new Setting(container)
        .setName('Cache retention')
        .addDropdown(dd => {
            for (const opt of CACHE_DURATION_OPTIONS) {
                dd.addOption(opt.value, opt.label);
            }
            dd.setValue(String(tts.cacheDurationMillis)).onChange(v => {
                tts.cacheDurationMillis = Number(v) || 0;
                save();
            });
        });

    const folderRow = new Setting(container)
        .setName('Vault folder for saved audio')
        .setDesc('Used when saved audio goes to a vault folder.')
        .addText(t =>
            t.setPlaceholder('Enter vault folder path').setValue(tts.audioFolder).onChange(v => {
                tts.audioFolder = v.trim() || 'spaceforge/tts-audio';
                save();
            }),
        );
    const showFolder = () => folderRow.settingEl.toggleClass('sf-hidden', tts.audioExportDestination !== 'vault');

    new Setting(container)
        .setName('Save audio to')
        .setDesc('Where the save button in the player puts the audio it has read.')
        .addDropdown(dd =>
            dd
                .addOption('cache', 'Hidden .tts folder in the vault')
                .addOption('vault', 'A vault folder')
                .addOption('browser', 'Downloads')
                .setValue(tts.audioExportDestination)
                .onChange(v => {
                    tts.audioExportDestination = v as TtsExportDestination;
                    showFolder();
                    save();
                }),
        );
    // The folder row follows the destination, so it sits under it.
    container.appendChild(folderRow.settingEl);
    showFolder();

    const cacheRow = new Setting(container)
        .setName('Spaceforge audio in the cache')
        .setDesc('Calculating cache usage…');

    const updateCacheDesc = async () => {
        if (!plugin.ttsService) {
            cacheRow.setDesc('TTS cache unavailable.');
            return;
        }
        const bytes = await plugin.ttsService.getCacheSize();
        const mb = (bytes / (1024 * 1024)).toFixed(2);
        cacheRow.setDesc(`Currently stored: ${mb} MB`);
    };
    void updateCacheDesc();

    cacheRow.addButton(btn =>
        btn.setButtonText('Clear Spaceforge audio').onClick(async () => {
            await plugin.ttsService?.clearCache();
            await updateCacheDesc();
            showStatus('Cleared Spaceforge\'s cached audio. Aloud\'s own audio was left alone.', 'ok');
        }),
    );

    // --- Bring settings in from elsewhere: last, since it is done once ---
    new Setting(container).setName('Import').setHeading();
    const aloudSetting = new Setting(container)
        .setName('Import from Aloud TTS')
        .setDesc('Check the vault for Aloud TTS settings (data.json) and copy its endpoints, keys, voices, cache, and chunking preferences.');

    aloudSetting.addButton(btn =>
        btn.setButtonText('Import Aloud TTS settings').onClick(async () => {
            const svc = plugin.ttsService;
            if (!svc) {
                showStatus('TTS service is unavailable in this session.', 'warn');
                return;
            }
            const res = await svc.importFromAloudSettings();
            if (!res.imported) {
                showStatus('No Aloud TTS data.json found under plugins/aloud-tts/.', 'warn');
                return;
            }
            container.empty();
            renderTtsSettingsSection(container, plugin);
            new Notice(`Imported Aloud TTS settings (${res.provider ?? 'OpenAI'}).`);
        }),
    );

    aloudSetting.addButton(btn =>
        btn.setButtonText('Reuse Spaceforge AI keys').onClick(() => {
            const copied = shareSpaceforgeApiKeys(tts, plugin.settings);
            if (!copied) {
                showStatus('No empty OpenAI, Gemini, or custom API key slots to fill.', 'warn');
                return;
            }
            save();
            renderProviderFields();
            showStatus('Copied matching API keys from Spaceforge AI settings into TTS.', 'ok');
        }),
    );

    void plugin.ttsService?.detectAloudSettings?.().then(detected => {
        if (!detected) return;
        const providers = detected.preview.configuredProviders.join(', ') || detected.preview.provider;
        aloudSetting.setDesc(
            `Detected Aloud TTS configuration at ${detected.path} (active: ${detected.preview.provider}; configured: ${providers}).`,
        );
    }).catch(() => undefined);
}
