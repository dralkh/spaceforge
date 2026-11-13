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

export function renderTtsSettingsSection(container: HTMLElement, plugin: SpaceforgePlugin): void {
    const tts: TtsSettings = plugin.settings.tts;
    const save = () => void plugin.savePluginData();

    const statusBox = container.createDiv({ cls: 'sf-info-box sf-tts-settings-status sf-hidden' });
    const showStatus = (message: string, level: 'ok' | 'warn' | 'error' = 'ok') => {
        statusBox.removeClass('sf-hidden', 'is-ok', 'is-warn', 'is-error');
        statusBox.addClass(`is-${level}`);
        statusBox.setText(message);
    };

    // --- Porting / Sharing with Aloud TTS & Spaceforge AI keys ---
    const aloudSetting = new Setting(container)
        .setName('Import from Aloud TTS')
        .setDesc('Check the vault for obsidian-aloud-tts settings (data.json) and copy its endpoints, keys, voices, cache, and chunking preferences.');

    aloudSetting.addButton(btn =>
        btn.setButtonText('Import Aloud settings').onClick(async () => {
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
            new Notice(`Imported Aloud TTS settings (${res.provider ?? 'openai'}).`);
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
        .setDesc('Select any of the 11 Aloud-compatible text-to-speech endpoints.')
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

    const maskInput = (el: HTMLInputElement) => {
        el.type = 'password';
        el.autocomplete = 'off';
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
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .setDesc('OpenAI API key for /v1/audio/speech.')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('sk-...').setValue(tts.openai_apiKey).onChange(v => {
                            tts.openai_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('TTS model')
                    .setDesc('Model ID (gpt-4o-mini-tts, tts-1, or tts-1-hd).')
                    .addDropdown(dd =>
                        dd
                            .addOption('gpt-4o-mini-tts', 'gpt-4o-mini-tts')
                            .addOption('tts-1', 'tts-1')
                            .addOption('tts-1-hd', 'tts-1-hd')
                            .setValue(tts.openai_ttsModel || 'gpt-4o-mini-tts')
                            .onChange(v => {
                                tts.openai_ttsModel = v;
                                save();
                                renderProviderFields();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .setDesc('OpenAI voice preset.')
                    .addDropdown(dd => {
                        for (const voice of ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']) {
                            dd.addOption(voice, voice);
                        }
                        dd.setValue(tts.openai_ttsVoice || 'shimmer').onChange(v => {
                            tts.openai_ttsVoice = v;
                            save();
                        });
                    });
                if (tts.openai_ttsModel === 'gpt-4o-mini-tts') {
                    new Setting(providerSlot)
                        .setName('TTS voice instructions')
                        .setDesc('Optional tone/cadence instructions for gpt-4o-mini-tts.')
                        .addTextArea(t =>
                            t
                                .setPlaceholder('Speak clearly and calmly at a teaching pace...')
                                .setValue(tts.openai_ttsInstructions)
                                .onChange(v => {
                                    tts.openai_ttsInstructions = v;
                                    save();
                                }),
                        );
                }
                break;
            }

            case 'openaicompat': {
                new Setting(providerSlot)
                    .setName('TTS custom base URL')
                    .setDesc('Base URL for OpenAI-compatible speech server (e.g. Kokoro, LocalAI, AllTalk, Speaches).')
                    .addText(t =>
                        t
                            .setPlaceholder('http://localhost:8880')
                            .setValue(tts.openaicompat_apiBase)
                            .onChange(v => {
                                tts.openaicompat_apiBase = v.trim();
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .setDesc('Optional bearer API key if required by the custom server.')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('Optional key').setValue(tts.openaicompat_apiKey).onChange(v => {
                            tts.openaicompat_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('TTS model')
                    .addText(t =>
                        t.setPlaceholder('kokoro').setValue(tts.openaicompat_ttsModel).onChange(v => {
                            tts.openaicompat_ttsModel = v.trim();
                            save();
                        }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .addText(t =>
                        t.setPlaceholder('af_bella').setValue(tts.openaicompat_ttsVoice).onChange(v => {
                            tts.openaicompat_ttsVoice = v.trim();
                            save();
                        }),
                    );
                new Setting(providerSlot)
                    .setName('Response audio format')
                    .addDropdown(dd =>
                        dd
                            .addOption('mp3', 'mp3')
                            .addOption('wav', 'wav')
                            .addOption('pcm', 'pcm')
                            .setValue(tts.openaicompat_responseFormat)
                            .onChange(v => {
                                tts.openaicompat_responseFormat = v as TtsOpenAICompatFormat;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('Server generation speed')
                    .addSlider(s =>
                        s
                            .setLimits(0.25, 2.5, 0.05)
                            .setValue(tts.openaicompat_generationSpeed)
                            .setDynamicTooltip()
                            .onChange(v => {
                                tts.openaicompat_generationSpeed = v;
                                save();
                            }),
                    );
                break;
            }

            case 'gemini': {
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .setDesc('Google Gemini API key.')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('AIza...').setValue(tts.gemini_apiKey).onChange(v => {
                            tts.gemini_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('TTS model')
                    .addDropdown(dd =>
                        dd
                            .addOption('gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-preview-tts')
                            .addOption('gemini-2.5-pro-preview-tts', 'gemini-2.5-pro-preview-tts')
                            .setValue(tts.gemini_ttsModel || 'gemini-2.5-flash-preview-tts')
                            .onChange(v => {
                                tts.gemini_ttsModel = v;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .addDropdown(dd => {
                        for (const voice of ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe']) {
                            dd.addOption(voice, voice);
                        }
                        dd.setValue(tts.gemini_ttsVoice || 'Zephyr').onChange(v => {
                            tts.gemini_ttsVoice = v;
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('TTS style instructions')
                    .setDesc('Optional prompt guidance prepended to Gemini TTS requests.')
                    .addTextArea(t =>
                        t
                            .setPlaceholder('Read in a clear educational tone...')
                            .setValue(tts.gemini_ttsInstructions)
                            .onChange(v => {
                                tts.gemini_ttsInstructions = v;
                                save();
                            }),
                    );
                break;
            }

            case 'elevenlabs': {
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('xi-...').setValue(tts.elevenlabs_apiKey).onChange(v => {
                            tts.elevenlabs_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('TTS model')
                    .addDropdown(dd =>
                        dd
                            .addOption('eleven_multilingual_v2', 'eleven_multilingual_v2')
                            .addOption('eleven_flash_v2_5', 'eleven_flash_v2_5')
                            .addOption('eleven_turbo_v2_5', 'eleven_turbo_v2_5')
                            .addOption('eleven_monolingual_v1', 'eleven_monolingual_v1')
                            .setValue(tts.elevenlabs_model || 'eleven_multilingual_v2')
                            .onChange(v => {
                                tts.elevenlabs_model = v;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice ID')
                    .addText(t =>
                        t.setPlaceholder('Voice ID').setValue(tts.elevenlabs_voice).onChange(v => {
                            tts.elevenlabs_voice = v.trim();
                            save();
                        }),
                    );
                addVoiceDiscoveryRow(providerSlot, tts.elevenlabs_voice, v => {
                    tts.elevenlabs_voice = v;
                });
                new Setting(providerSlot)
                    .setName('Voice stability')
                    .addSlider(s =>
                        s
                            .setLimits(0, 1, 0.05)
                            .setValue(tts.elevenlabs_stability)
                            .setDynamicTooltip()
                            .onChange(v => {
                                tts.elevenlabs_stability = v;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('Voice similarity boost')
                    .addSlider(s =>
                        s
                            .setLimits(0, 1, 0.05)
                            .setValue(tts.elevenlabs_similarity)
                            .setDynamicTooltip()
                            .onChange(v => {
                                tts.elevenlabs_similarity = v;
                                save();
                            }),
                    );
                break;
            }

            case 'azure': {
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('Azure Speech Key').setValue(tts.azure_apiKey).onChange(v => {
                            tts.azure_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('Azure region')
                    .addText(t =>
                        t.setPlaceholder('eastus').setValue(tts.azure_region).onChange(v => {
                            tts.azure_region = v.trim();
                            save();
                        }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .addText(t =>
                        t.setPlaceholder('en-US-JennyNeural').setValue(tts.azure_voice).onChange(v => {
                            tts.azure_voice = v.trim();
                            save();
                        }),
                    );
                addVoiceDiscoveryRow(providerSlot, tts.azure_voice, v => {
                    tts.azure_voice = v;
                });
                new Setting(providerSlot)
                    .setName('Azure output format')
                    .addText(t =>
                        t
                            .setPlaceholder('audio-24khz-96kbitrate-mono-mp3')
                            .setValue(tts.azure_outputFormat)
                            .onChange(v => {
                                tts.azure_outputFormat = v.trim();
                                save();
                            }),
                    );
                break;
            }

            case 'hume': {
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('Hume API Key').setValue(tts.hume_apiKey).onChange(v => {
                            tts.hume_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('Hume voice source')
                    .addDropdown(dd =>
                        dd
                            .addOption('HUME_AI', 'Hume AI library')
                            .addOption('CUSTOM_VOICE', 'Custom voice')
                            .setValue(tts.hume_sourceType)
                            .onChange(v => {
                                tts.hume_sourceType = v as TtsHumeSourceType;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .addText(t =>
                        t.setPlaceholder('Voice name').setValue(tts.hume_ttsVoice).onChange(v => {
                            tts.hume_ttsVoice = v.trim();
                            save();
                        }),
                    );
                addVoiceDiscoveryRow(providerSlot, tts.hume_ttsVoice, v => {
                    tts.hume_ttsVoice = v;
                });
                new Setting(providerSlot)
                    .setName('Hume acting instructions')
                    .addTextArea(t =>
                        t.setPlaceholder('Optional voice description...').setValue(tts.hume_ttsInstructions).onChange(v => {
                            tts.hume_ttsInstructions = v;
                            save();
                        }),
                    );
                break;
            }

            case 'minimax': {
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('MiniMax API Key').setValue(tts.minimax_apiKey).onChange(v => {
                            tts.minimax_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('MiniMax Group ID')
                    .addText(t =>
                        t.setPlaceholder('Group ID').setValue(tts.minimax_groupId).onChange(v => {
                            tts.minimax_groupId = v.trim();
                            save();
                        }),
                    );
                new Setting(providerSlot)
                    .setName('TTS model')
                    .addText(t =>
                        t.setPlaceholder('speech-2.6-turbo').setValue(tts.minimax_ttsModel).onChange(v => {
                            tts.minimax_ttsModel = v.trim();
                            save();
                        }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .addText(t =>
                        t.setPlaceholder('English_Graceful_Lady').setValue(tts.minimax_ttsVoice).onChange(v => {
                            tts.minimax_ttsVoice = v.trim();
                            save();
                        }),
                    );
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
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('Fish Audio Key').setValue(tts.fish_apiKey).onChange(v => {
                            tts.fish_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('TTS model')
                    .addDropdown(dd =>
                        dd
                            .addOption('s1', 's1')
                            .addOption('s2-pro', 's2-pro')
                            .setValue(tts.fish_model || 's1')
                            .onChange(v => {
                                tts.fish_model = v;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('Fish voice source')
                    .addDropdown(dd =>
                        dd
                            .addOption('my-voices', 'My voices')
                            .addOption('custom', 'Custom reference ID')
                            .setValue(tts.fish_voiceSource)
                            .onChange(v => {
                                tts.fish_voiceSource = v as TtsFishVoiceSource;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('Fish voice ID')
                    .addText(t =>
                        t.setPlaceholder('Reference model ID').setValue(tts.fish_voiceId).onChange(v => {
                            tts.fish_voiceId = v.trim();
                            save();
                        }),
                    );
                addVoiceDiscoveryRow(providerSlot, tts.fish_voiceId, v => {
                    tts.fish_voiceId = v;
                });
                new Setting(providerSlot)
                    .setName('Sentence pause')
                    .addDropdown(dd =>
                        dd
                            .addOption('none', 'None')
                            .addOption('short', 'Short')
                            .addOption('long', 'Long')
                            .setValue(tts.fish_sentencePause)
                            .onChange(v => {
                                tts.fish_sentencePause = v as TtsFishSentencePause;
                                save();
                            }),
                    );
                break;
            }

            case 'inworld': {
                new Setting(providerSlot)
                    .setName('TTS API key (Basic token)')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('Inworld Base64 key').setValue(tts.inworld_apiKey).onChange(v => {
                            tts.inworld_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('TTS model')
                    .addDropdown(dd =>
                        dd
                            .addOption('inworld-tts-1', 'inworld-tts-1')
                            .addOption('inworld-tts-1-max', 'inworld-tts-1-max')
                            .setValue(tts.inworld_modelId || 'inworld-tts-1')
                            .onChange(v => {
                                tts.inworld_modelId = v;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .addText(t =>
                        t.setPlaceholder('Ronald').setValue(tts.inworld_voiceId).onChange(v => {
                            tts.inworld_voiceId = v.trim();
                            save();
                        }),
                    );
                addVoiceDiscoveryRow(providerSlot, tts.inworld_voiceId, v => {
                    tts.inworld_voiceId = v;
                });
                break;
            }

            case 'polly': {
                new Setting(providerSlot)
                    .setName('AWS Access Key ID')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('AKIA...').setValue(tts.polly_accessKeyId).onChange(v => {
                            tts.polly_accessKeyId = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('AWS Secret Access Key')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('Secret key').setValue(tts.polly_secretAccessKey).onChange(v => {
                            tts.polly_secretAccessKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('AWS region')
                    .addText(t =>
                        t.setPlaceholder('us-east-1').setValue(tts.polly_region).onChange(v => {
                            tts.polly_region = v.trim();
                            save();
                        }),
                    );
                new Setting(providerSlot)
                    .setName('Polly engine')
                    .addDropdown(dd =>
                        dd
                            .addOption('neural', 'Neural')
                            .addOption('standard', 'Standard')
                            .setValue(tts.polly_engine)
                            .onChange(v => {
                                tts.polly_engine = v as TtsPollyEngine;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .addText(t =>
                        t.setPlaceholder('Joanna').setValue(tts.polly_voiceId).onChange(v => {
                            tts.polly_voiceId = v.trim();
                            save();
                        }),
                    );
                addVoiceDiscoveryRow(providerSlot, tts.polly_voiceId, v => {
                    tts.polly_voiceId = v;
                });
                break;
            }

            case 'speechify': {
                new Setting(providerSlot)
                    .setName('TTS API key')
                    .addText(t => {
                        maskInput(t.inputEl);
                        t.setPlaceholder('Speechify API Key').setValue(tts.speechify_apiKey).onChange(v => {
                            tts.speechify_apiKey = v.trim();
                            save();
                        });
                    });
                new Setting(providerSlot)
                    .setName('TTS model')
                    .addDropdown(dd =>
                        dd
                            .addOption('simba-3.2', 'simba-3.2')
                            .addOption('simba-3.0', 'simba-3.0')
                            .setValue(tts.speechify_model || 'simba-3.2')
                            .onChange(v => {
                                tts.speechify_model = v;
                                save();
                            }),
                    );
                new Setting(providerSlot)
                    .setName('TTS voice')
                    .addText(t =>
                        t.setPlaceholder('dominic_32').setValue(tts.speechify_voice).onChange(v => {
                            tts.speechify_voice = v.trim();
                            save();
                        }),
                    );
                addVoiceDiscoveryRow(providerSlot, tts.speechify_voice, v => {
                    tts.speechify_voice = v;
                });
                break;
            }
        }
    };

    renderProviderFields();

    // --- Playback, Highlighting & Auto-scroll ---
    new Setting(container).setName('Playback & highlighting').setHeading();

    new Setting(container)
        .setName('Default read aloud source')
        .setDesc('Auto detects an editor selection, active study material surface (Mind map / Visualize / Summary / Tutor), or falls back to the review note.')
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
        .setName('Audio cache backend')
        .setDesc('Store synthesized audio locally in IndexedDB or in a vault folder for cross-device / offline reuse.')
        .addDropdown(dd =>
            dd
                .addOption('local', 'Local IndexedDB cache')
                .addOption('vault', 'Vault folder cache')
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

    new Setting(container)
        .setName('Vault audio folder')
        .setDesc('Vault path used for vault-cached clips and exported audio files.')
        .addText(t =>
            t.setPlaceholder('spaceforge/tts-audio').setValue(tts.audioFolder).onChange(v => {
                tts.audioFolder = v.trim() || 'spaceforge/tts-audio';
                save();
            }),
        );

    new Setting(container)
        .setName('Audio export destination')
        .addDropdown(dd =>
            dd
                .addOption('vault', 'Save into vault folder')
                .addOption('browser', 'Download file')
                .setValue(tts.audioExportDestination)
                .onChange(v => {
                    tts.audioExportDestination = v as TtsExportDestination;
                    save();
                }),
        );

    const cacheRow = new Setting(container)
        .setName('Cached audio size')
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
        btn.setButtonText('Clear TTS cache').onClick(async () => {
            await plugin.ttsService?.clearCache();
            await updateCacheDesc();
            showStatus('Cleared TTS audio cache.', 'ok');
        }),
    );
}
