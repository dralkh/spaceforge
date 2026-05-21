import { Notice, requestUrl } from 'obsidian';
import { OPENAI_COMPATIBLE, API } from '../ui/constants';
import SpaceforgePlugin from '../main';
import { MCQQuestion, MCQSet } from '../models/mcq';
import { IMCQGenerationService } from './mcq-generation-service';
import { SpaceforgeSettings, MCQQuestionAmountMode, MCQDifficulty } from '../models/settings';

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

            let numQuestionsToGenerate: number;
            if (settings.mcqQuestionAmountMode === MCQQuestionAmountMode.WordsPerQuestion) {
                const wordCount = noteContent.split(/\s+/).filter(Boolean).length;
                numQuestionsToGenerate = Math.max(1, Math.ceil(wordCount / settings.mcqWordsPerQuestion));
            } else {
                numQuestionsToGenerate = settings.mcqQuestionsPerNote;
            }

            const prompt = this.generatePrompt(noteContent, settings, numQuestionsToGenerate);
            const response = await this.makeApiRequest(prompt, settings);
            const questions = this.parseResponse(response, settings, numQuestionsToGenerate);

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

    private generatePrompt(noteContent: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): string {
        const questionCount = numQuestionsToGenerate;
        const choiceCount = settings.mcqChoicesPerQuestion;
        const promptType = settings.mcqPromptType;
        const difficulty = settings.mcqDifficulty;

        let basePrompt = "";
        if (promptType === 'basic') {
            basePrompt = `Generate ${questionCount} multiple-choice questions based on the following note content. Each question should have ${choiceCount} choices, with one correct answer. Format the output as a list of questions with bullet points for each answer choice. Mark the correct answer by putting [CORRECT] at the end of the line.`;
        } else {
            basePrompt = `Generate ${questionCount} multiple-choice questions that test understanding of key concepts in the following note. Each question should have ${choiceCount} choices, with only one correct answer. Format the output as a numbered list of questions with lettered choices (A, B, C, etc.). Mark the correct answer by putting [CORRECT] at the end of the line.\n\nFor example:\n1. What is the capital of France?\n   A) London\n   B) Berlin\n   C) Paris [CORRECT]\n   D) Madrid\n   E) Rome`;
        }

        if (difficulty === MCQDifficulty.Basic) {
            basePrompt += `\n\nCreate straightforward questions that focus on key facts and basic concepts. Make the questions clear and direct, suitable for beginners or initial review.`;
        } else {
            basePrompt += `\n\nCreate challenging questions that test deeper understanding and application of concepts. Make the incorrect choices plausible to encourage critical thinking.`;
        }
        return `${basePrompt}\n\nNote Content:\n${noteContent}`;
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
                const errorData: OpenAICompatibleErrorResponse = response.json ?? { message: response.text };
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

    private parseResponse(response: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): MCQQuestion[] {
        const questions: MCQQuestion[] = [];
        try {
            let questionBlocks: string[] = response.split(/\n\d+\.\s+/).filter(block => block.trim().length > 0);

            if (questionBlocks.length > 0 && !/^\d+\.\s+/.test(response.trimStart())) {
                if (!/^\d+\.\s+/.test(questionBlocks[0])) {
                    if (response.trimStart().length > 0 && questionBlocks.length === 1 && !response.includes("\n1.")) {
                        questionBlocks = response.split(/\n(?=\d+\.\s)/);
                        if (questionBlocks.length === 1 && !/^\d+\.\s/.test(questionBlocks[0])) {
                            const potentialBlocks = response.split(/\n\n+/);
                            if (potentialBlocks.some(pb => /^\d+\.\s/.test(pb.trimStart()))) {
                                questionBlocks = potentialBlocks;
                            }
                        }
                    }
                }
            }

            if (questionBlocks.length === 0 || (questionBlocks.length < settings.mcqQuestionsPerNote / 2 && response.includes("1."))) {
                const lines = response.split('\n');
                let currentQuestionBlock = '';
                const tempBlocks = [];
                for (const line of lines) {
                    if (/^\d+\.\s+/.test(line.trim())) {
                        if (currentQuestionBlock.trim().length > 0) {
                            tempBlocks.push(currentQuestionBlock.trim());
                        }
                        currentQuestionBlock = line + '\n';
                    } else if (currentQuestionBlock.length > 0) {
                        currentQuestionBlock += line + '\n';
                    } else if (tempBlocks.length === 0 && line.trim().length > 0) {
                        currentQuestionBlock = line + '\n';
                    }
                }
                if (currentQuestionBlock.trim().length > 0) {
                    tempBlocks.push(currentQuestionBlock.trim());
                }
                if (tempBlocks.length > 0) questionBlocks = tempBlocks;
            }

            for (const block of questionBlocks) {
                const lines = block.split('\n').filter(line => line.trim().length > 0);
                if (lines.length < 2) continue;

                let questionText = lines[0].replace(/^\d+\.\s*/, '').trim();
                questionText = questionText.replace(/<think>/g, '').replace(/<\/think>/g, '');

                const choices: string[] = [];
                let correctAnswerIndex = -1;

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    const isCorrect = line.includes('[CORRECT]');
                    const cleanedLine = line.replace(/\[CORRECT\]/gi, '')
                        .replace(/^([A-Z]\.|[A-Z]\)|\d+\.|\d+\)|-\s*|\*\s*)/, '')
                        .trim();
                    if (cleanedLine.length > 0) {
                        choices.push(cleanedLine);
                        if (isCorrect) correctAnswerIndex = choices.length - 1;
                    }
                }

                if (correctAnswerIndex === -1 && choices.length > 0) {
                    for (let i = 0; i < choices.length; i++) {
                        if (choices[i].toLowerCase().includes("(correct answer)") || choices[i].toLowerCase().includes(" - correct")) {
                            choices[i] = choices[i].replace(/\(correct answer\)/gi, "").replace(/ - correct/gi, "").trim();
                            correctAnswerIndex = i;
                            break;
                        }
                    }
                    if (correctAnswerIndex === -1) correctAnswerIndex = 0;
                }

                if (questionText && choices.length >= settings.mcqChoicesPerQuestion - 1 && choices.length > 0) {
                    questions.push({ question: questionText, choices, correctAnswerIndex });
                } else if (questionText && choices.length >= 2) {
                    questions.push({ question: questionText, choices, correctAnswerIndex });
                }
            }
            return questions.slice(0, numQuestionsToGenerate);
        } catch {
            new Notice(`Error parsing response from ${OPENAI_COMPATIBLE}. Try again.`);
            return [];
        }
    }
}
