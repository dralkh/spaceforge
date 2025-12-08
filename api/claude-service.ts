import { Notice, requestUrl } from 'obsidian';
import SpaceforgePlugin from '../main';
import { MCQQuestion, MCQSet } from '../models/mcq';
import { IMCQGenerationService } from './mcq-generation-service';
import { SpaceforgeSettings, MCQQuestionAmountMode, MCQDifficulty } from '../models/settings'; // Import MCQQuestionAmountMode

export class ClaudeService implements IMCQGenerationService {
    plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    async generateMCQs(notePath: string, noteContent: string, settings: SpaceforgeSettings): Promise<MCQSet | null> {
        if (!settings.claudeApiKey) {
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            new Notice('Claude API key is not set, please add it in the Spaceforge settings');
            return null;
        }
        if (!settings.claudeModel) {
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            new Notice('Claude model is not set, please add it in the Spaceforge settings');
            return null;
        }

        try {
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            new Notice('Generating MCQs using Claude...');

            // Determine the number of questions to generate
            let numQuestionsToGenerate: number;
            if (settings.mcqQuestionAmountMode === MCQQuestionAmountMode.WordsPerQuestion) {
                const wordCount = noteContent.split(/\s+/).filter(Boolean).length;
                numQuestionsToGenerate = Math.max(1, Math.ceil(wordCount / settings.mcqWordsPerQuestion));
            } else { // Fixed mode
                numQuestionsToGenerate = settings.mcqQuestionsPerNote;
            }

            const prompt = this.generatePrompt(noteContent, settings, numQuestionsToGenerate);
            const response = await this.makeApiRequest(prompt, settings);
            const questions = this.parseResponse(response, settings, numQuestionsToGenerate);

            if (questions.length === 0) {
                // eslint-disable-next-line obsidianmd/ui/sentence-case
                new Notice('Failed to generate valid MCQs from Claude, please try again');
                return null;
            }

            return {
                notePath,
                questions,
                generatedAt: Date.now()
            };
        } catch {
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            new Notice('Failed to generate MCQs with Claude, please check console for details');
            return null;
        }
    }

    private generatePrompt(noteContent: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): string {
        const questionCount = numQuestionsToGenerate; // Use calculated number
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
        const apiKey = settings.claudeApiKey;
        const model = settings.claudeModel;
        const difficulty = settings.mcqDifficulty;

        const systemPrompt = difficulty === MCQDifficulty.Basic
            ? settings.mcqBasicSystemPrompt
            : settings.mcqAdvancedSystemPrompt;

        try {
            const response = await requestUrl({
                url: 'https://api.anthropic.com/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: model,
                    max_tokens: 2048, // Adjust as needed
                    system: systemPrompt,
                    messages: [
                        { role: 'user', content: prompt }
                    ]
                })
            });

            if (response.status !== 200) {
                const errorData = response.json || { message: response.text };
                throw new Error(`API request failed (${response.status}): ${errorData.error?.message || errorData.message || 'Unknown error'}`);
            }

            const data = response.json;
            if (!data.content || !data.content.length || !data.content[0].text) {
                throw new Error('Invalid API response format from Claude - missing content');
            }
            return data.content[0].text;
        } catch (error) {
            new Notice(`Claude API error: ${error.message}`);
            throw error;
        }
    }

    private parseResponse(response: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): MCQQuestion[] {
        const questions: MCQQuestion[] = [];
        try {
            // Claude might not start with "1. ", so we adjust the split logic if needed.
            // The current logic tries to split by number then newline, which might be robust enough.
            let questionBlocks: string[] = response.split(/\n\d+\.\s+/).filter(block => block.trim().length > 0);

            // If the first block doesn't start with a number, prepend "1. " to it if it's not empty
            if (questionBlocks.length > 0 && !/^\d+\.\s+/.test(response.trimStart())) {
                // If the original response starts with a question directly (no "1. ")
                if (!/^\d+\.\s+/.test(questionBlocks[0])) {
                    // Check if the first block is the start of the first question
                    if (response.trimStart().length > 0 && questionBlocks.length === 1 && !response.includes("\n1.")) {
                        // This means the entire response is treated as a single block without "1."
                        // We might need a different splitting strategy or assume the first block is the first question
                        // For now, let's try to process it as is, or re-split differently.
                        // A common pattern is just a list of questions.
                        questionBlocks = response.split(/\n(?=\d+\.\s)/); // Split on newline only if followed by "number."
                        if (questionBlocks.length === 1 && !/^\d+\.\s/.test(questionBlocks[0])) {
                            // If still one block and no number, try splitting by double newline as a fallback for less structured lists
                            const potentialBlocks = response.split(/\n\n+/);
                            if (potentialBlocks.some(pb => /^\d+\.\s/.test(pb.trimStart()))) {
                                questionBlocks = potentialBlocks;
                            } else {
                                // If no numbered list, assume each paragraph could be a question block
                                // This is a very loose fallback.
                            }
                        }
                    }
                }
            }
            // If initial split by "\n\d+." fails or gives few blocks, try splitting by "\d+." then handling newlines
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
                    } else if (currentQuestionBlock.length > 0) { // only add to current block if it has started
                        currentQuestionBlock += line + '\n';
                    } else if (tempBlocks.length === 0 && line.trim().length > 0) {
                        // Handle case where the first question doesn't start with "1." but is the first content
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
                if (lines.length < 2) continue; // Need at least a question and one choice

                // Remove the leading "X. " from the question text if present
                let questionText = lines[0].replace(/^\d+\.\s*/, '').trim();
                // Remove <think> and </think> tags from the question text
                questionText = questionText.replace(/<think>/g, '').replace(/<\/think>/g, '');

                const choices: string[] = [];
                let correctAnswerIndex = -1;

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    const isCorrect = line.includes('[CORRECT]');
                    // More robustly remove common choice markers (A., A), 1., 1), -, *)
                    const cleanedLine = line.replace(/\[CORRECT\]/gi, '') // Case-insensitive removal
                        .replace(/^([A-Z]\.|[A-Z]\)|\d+\.|\d+\)|-\s*|\*\s*)/, '')
                        .trim();
                    if (cleanedLine.length > 0) { // Only add non-empty choices
                        choices.push(cleanedLine);
                        if (isCorrect) correctAnswerIndex = choices.length - 1;
                    }
                }

                // Fallback for [CORRECT] if not found (e.g. if model forgets)
                if (correctAnswerIndex === -1 && choices.length > 0) {
                    // A simple heuristic: if a choice text itself contains "correct" (less likely for Claude)
                    for (let i = 0; i < choices.length; i++) {
                        if (choices[i].toLowerCase().includes("(correct answer)") || choices[i].toLowerCase().includes(" - correct")) {
                            choices[i] = choices[i].replace(/\(correct answer\)/gi, "").replace(/ - correct/gi, "").trim();
                            correctAnswerIndex = i;
                            break;
                        }
                    }
                    // If still not found, default to the first choice as per original logic
                    if (correctAnswerIndex === -1) correctAnswerIndex = 0;
                }


                if (questionText && choices.length >= settings.mcqChoicesPerQuestion - 1 && choices.length > 0) { // Allow slightly fewer choices if parsing is tricky
                    questions.push({ question: questionText, choices, correctAnswerIndex });
                } else if (questionText && choices.length >= 2) { // Absolute minimum of 2 choices
                    questions.push({ question: questionText, choices, correctAnswerIndex });
                }
            }
            return questions.slice(0, numQuestionsToGenerate); // Use calculated number
        } catch {
            // eslint-disable-next-line obsidianmd/ui/sentence-case
            new Notice('Error parsing MCQ response from Claude, please try again');
            return [];
        }
    }
}
