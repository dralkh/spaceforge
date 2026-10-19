import { Notice } from 'obsidian';
import { API } from '../ui/constants';
import SpaceforgePlugin from '../main';
import { MCQSet } from '../models/mcq';
import { IMCQGenerationService } from './mcq-generation-service';
import { buildMcqPrompt, parseMcqResponse, questionsToGenerate } from './mcq-prompt';
import { MCQDifficulty, SpaceforgeSettings } from '../models/settings';
import { buildOpenAiChatRequest, chatModelKey, postOpenAiChat } from './chat-client';
import { describeProviderGap, HttpProviderDescriptor } from './provider-registry';

/**
 * The multiple-choice generator for every provider that speaks OpenAI's chat
 * shape. The original six each have a hand-written service (they predate the
 * registry); everyone added since comes through here, so a new company needs a
 * row in `api/provider-registry.ts` and nothing else.
 *
 * The request itself is built by `buildOpenAiChatRequest`, the same function the
 * Study tutor uses — one description of how to reach a provider, not two that
 * can disagree the day one is edited.
 */
export class OpenAIHttpService implements IMCQGenerationService {
    plugin: SpaceforgePlugin;
    private descriptor: HttpProviderDescriptor;

    constructor(plugin: SpaceforgePlugin, descriptor: HttpProviderDescriptor) {
        this.plugin = plugin;
        this.descriptor = descriptor;
    }

    async generateMCQs(notePath: string, noteContent: string, settings: SpaceforgeSettings): Promise<MCQSet | null> {
        const gap = describeProviderGap(this.descriptor, settings);
        if (gap) {
            new Notice(gap);
            return null;
        }

        try {
            new Notice(`Generating questions using ${this.descriptor.label}...`);

            const numQuestionsToGenerate = questionsToGenerate(noteContent, settings);
            const prompt = buildMcqPrompt(noteContent, settings, numQuestionsToGenerate);
            const response = await this.makeApiRequest(prompt, settings);
            const questions = parseMcqResponse(response, settings, numQuestionsToGenerate);

            if (questions.length === 0) {
                new Notice('Failed to generate valid questions. Try again.');
                return null;
            }

            return {
                notePath,
                questions,
                generatedAt: Date.now()
            };
        } catch {
            new Notice('Failed to generate questions. Check console for details.');
            return null;
        }
    }

    private async makeApiRequest(prompt: string, settings: SpaceforgeSettings): Promise<string> {
        const difficulty = settings.mcqDifficulty;
        const systemPrompt = difficulty === MCQDifficulty.Basic
            ? settings.mcqBasicSystemPrompt
            : settings.mcqAdvancedSystemPrompt;

        const request = buildOpenAiChatRequest(this.descriptor, settings, {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt },
            ],
            maxTokens: 2048,
        });

        try {
            const response = await postOpenAiChat(
                request.url,
                request.headers,
                request.body,
                chatModelKey(this.descriptor.label, String(request.body.model ?? ''))
            );

            if (response.status < 200 || response.status >= 300) {
                const detail = response.text?.slice(0, 400) ?? '';
                throw new Error(`${this.descriptor.label} ${API} request failed (${response.status})${detail ? `: ${detail}` : ''}`);
            }

            const data = response.json as { choices?: Array<{ message?: { content?: string } }> };
            const content = data.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error('Invalid API response format - missing content');
            }
            return content;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            new Notice(`${this.descriptor.label} ${API} error: ${msg}`);
            throw error;
        }
    }
}
