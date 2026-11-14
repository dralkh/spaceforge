import { Notice } from 'obsidian';
import type SpaceforgePlugin from '../main';
import { MCQSet } from '../models/mcq';
import { MCQDifficulty, SpaceforgeSettings } from '../models/settings';
import { createChatClient, inspectChatProvider } from './chat-client';
import { IMCQGenerationService } from './mcq-generation-service';
import { buildMcqPrompt, parseMcqResponse, questionsToGenerate } from './mcq-prompt';

/**
 * Unified multiple-choice question generator backed by `createChatClient`.
 *
 * Every HTTP provider (built-in or registry-defined) shares this single path,
 * inheriting reasoning-model parameter handling, token-ceiling auto-retry, and
 * consistent error reporting from `api/chat-client.ts`.
 */
export class ChatClientMcqService implements IMCQGenerationService {
    plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    async generateMCQs(notePath: string, noteContent: string, settings: SpaceforgeSettings): Promise<MCQSet | null> {
        const info = inspectChatProvider(settings);
        if (!info.ready) {
            new Notice(info.reason || 'Selected AI provider is not configured.');
            return null;
        }

        const client = createChatClient(settings);
        if (!client) {
            new Notice(`Could not initialize ${info.label}. Check provider settings.`);
            return null;
        }

        try {
            new Notice(`Generating questions using ${info.label}...`);

            const numQuestions = questionsToGenerate(noteContent, settings);
            const prompt = buildMcqPrompt(noteContent, settings, numQuestions);
            const systemPrompt = settings.mcqDifficulty === MCQDifficulty.Basic
                ? settings.mcqBasicSystemPrompt
                : settings.mcqAdvancedSystemPrompt;

            const result = await client.send({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt },
                ],
            });

            const questions = parseMcqResponse(result.text, settings, numQuestions);
            if (questions.length === 0) {
                new Notice('Failed to generate valid questions. Try again.');
                return null;
            }

            return {
                notePath,
                questions,
                generatedAt: Date.now(),
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            new Notice(`${info.label} question generation error: ${msg}`);
            return null;
        }
    }
}
