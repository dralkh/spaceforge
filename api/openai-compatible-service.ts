import { Notice, requestUrl } from 'obsidian';
import { OPENAI_COMPATIBLE, API } from '../ui/constants';
import SpaceforgePlugin from '../main';
import { MCQSet } from '../models/mcq';
import { IMCQGenerationService } from './mcq-generation-service';
import { buildMcqPrompt, parseMcqResponse, questionsToGenerate } from './mcq-prompt';
import { SpaceforgeSettings, MCQDifficulty } from '../models/settings';

interface OpenAICompatibleResponse {
    choices: Array<{ message: { content: string } }>;
}

interface OpenAICompatibleErrorResponse {
    error?: { message?: string };
    message?: string;
}

export class OpenAICompatibleService implements IMCQGenerationService {
    plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    async generateMCQs(notePath: string, noteContent: string, settings: SpaceforgeSettings): Promise<MCQSet | null> {
        if (!settings.openaiCompatibleApiUrl) {
            new Notice(`${OPENAI_COMPATIBLE} ${API} URL not set in settings.`);
            return null;
        }
        if (!settings.openaiCompatibleModel) {
            new Notice(`${OPENAI_COMPATIBLE} model not set in settings.`);
            return null;
        }

        try {
            new Notice(`Generating questions using ${OPENAI_COMPATIBLE}...`);

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
        const apiUrl = settings.openaiCompatibleApiUrl.endsWith('/')
            ? settings.openaiCompatibleApiUrl.slice(0, -1)
            : settings.openaiCompatibleApiUrl;
        const apiKey = settings.openaiCompatibleApiKey;
        const model = settings.openaiCompatibleModel;
        const difficulty = settings.mcqDifficulty;

        const systemPrompt = difficulty === MCQDifficulty.Basic
            ? settings.mcqBasicSystemPrompt
            : settings.mcqAdvancedSystemPrompt;

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            const response = await requestUrl({
                url: `${apiUrl}/chat/completions`,
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: model,
                    max_tokens: 2048,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: prompt }
                    ]
                })
            });

            if (response.status !== 200) {
                const errorData = (response.json ?? { message: response.text }) as OpenAICompatibleErrorResponse;
                throw new Error(`API request failed (${response.status}): ${errorData.error?.message ?? errorData.message ?? 'Unknown error'}`);
            }

            const data = response.json as OpenAICompatibleResponse;
            if (!data.choices?.length || !data.choices[0]?.message?.content) {
                throw new Error('Invalid API response format - missing content');
            }
            return data.choices[0].message.content;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            new Notice(`OpenAI Compatible API error: ${msg}`);
            throw error;
        }
    }

}
