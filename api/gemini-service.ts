import { Notice, requestUrl } from 'obsidian';
import SpaceforgePlugin from '../main';
import { MCQQuestion, MCQSet } from '../models/mcq';
import { IMCQGenerationService } from './mcq-generation-service';
import { SpaceforgeSettings, MCQQuestionAmountMode } from '../models/settings'; // Import MCQQuestionAmountMode

// Define a simple type for Gemini API parts, as it expects an array of these.
interface GeminiPart {
    text: string;
}

export class GeminiService implements IMCQGenerationService {
    plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    async generateMCQs(notePath: string, noteContent: string, settings: SpaceforgeSettings): Promise<MCQSet | null> {
        if (!settings.geminiApiKey) {
            new Notice('Gemini API key is not set. Please add it in the Spaceforge settings.');
            return null;
        }
        if (!settings.geminiModel) {
            new Notice('Gemini Model is not set. Please add it in the Spaceforge settings.');
            return null;
        }

        try {
            new Notice('Generating MCQs using Gemini...');

            // Determine the number of questions to generate
            let numQuestionsToGenerate: number;
            if (settings.mcqQuestionAmountMode === MCQQuestionAmountMode.WordsPerQuestion) {
                const wordCount = noteContent.split(/\s+/).filter(Boolean).length;
                numQuestionsToGenerate = Math.max(1, Math.ceil(wordCount / settings.mcqWordsPerQuestion));
                console.log(`Gemini: Calculated ${numQuestionsToGenerate} questions based on ${wordCount} words and ${settings.mcqWordsPerQuestion} words/question setting.`);
            } else { // Fixed mode
                numQuestionsToGenerate = settings.mcqQuestionsPerNote;
                console.log(`Gemini: Using fixed number of questions: ${numQuestionsToGenerate}`);
            }

            const prompt = this.generatePrompt(noteContent, settings, numQuestionsToGenerate);
            const response = await this.makeApiRequest(prompt, settings);
            const questions = this.parseResponse(response, settings, numQuestionsToGenerate);

            if (questions.length === 0) {
                new Notice('Failed to generate valid MCQs from Gemini. Please try again.');
                return null;
            }

            return {
                notePath,
                questions,
                generatedAt: Date.now()
            };
        } catch (error) {
            console.error('Error generating MCQs with Gemini:', error);
            new Notice('Failed to generate MCQs with Gemini. Please check console for details.');
            return null;
        }
    }

    private generatePrompt(noteContent: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): string {
        const questionCount = numQuestionsToGenerate; // Use calculated number
        const choiceCount = settings.mcqChoicesPerQuestion;
        const promptType = settings.mcqPromptType;
        const difficulty = settings.mcqDifficulty;

        let basePrompt = "";
        // Gemini prefers direct instructions. System prompts are handled differently or not at all in simpler SDKs.
        // For direct API calls, we include system-like instructions at the beginning of the user prompt.
        const systemInstruction = difficulty === 'basic' 
            ? settings.mcqBasicSystemPrompt 
            : settings.mcqAdvancedSystemPrompt;

        if (promptType === 'basic') {
            basePrompt = `${systemInstruction}\n\nGenerate ${questionCount} multiple-choice questions based on the following note content. Each question should have ${choiceCount} choices, with one correct answer. Format the output as a list of questions with bullet points for each answer choice. Mark the correct answer by putting [CORRECT] at the end of the line.`;
        } else {
            basePrompt = `${systemInstruction}\n\nGenerate ${questionCount} multiple-choice questions that test understanding of key concepts in the following note. Each question should have ${choiceCount} choices, with only one correct answer. Format the output as a numbered list of questions with lettered choices (A, B, C, etc.). Mark the correct answer by putting [CORRECT] at the end of the line.\n\nFor example:\n1. What is the capital of France?\n   A) London\n   B) Berlin\n   C) Paris [CORRECT]\n   D) Madrid\n   E) Rome`;
        }
        
        // Difficulty instructions are already prepended via systemInstruction.
        return `${basePrompt}\n\nNote Content:\n${noteContent}`;
    }

    private async makeApiRequest(prompt: string, settings: SpaceforgeSettings): Promise<string> {
        const apiKey = settings.geminiApiKey;
        const model = settings.geminiModel; // e.g., 'gemini-pro'

        console.log(`Making API request to Gemini using model: ${model}`);
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        try {
            const response = await requestUrl({
                url: apiUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    // Gemini API expects contents as an array of parts
                    contents: [{ parts: [{ text: prompt }] }],
                    // Optional: Add generationConfig if needed (e.g., temperature, maxOutputTokens)
                    // generationConfig: {
                    //   temperature: 0.7,
                    //   maxOutputTokens: 1024,
                    // }
                })
            });

            if (response.status !== 200) {
                const errorData = response.json;
                console.error('Gemini API error:', response.status, errorData);
                const errorMessage = errorData?.error?.message || errorData?.message || 'Unknown error';
                throw new Error(`API request failed (${response.status}): ${errorMessage}`);
            }

            const data = response.json;
            // Gemini response structure: data.candidates[0].content.parts[0].text
            if (!data.candidates || !data.candidates.length || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts.length || !data.candidates[0].content.parts[0].text) {
                console.error('Invalid API response format from Gemini:', data);
                throw new Error('Invalid API response format from Gemini - missing content');
            }
            return data.candidates[0].content.parts[0].text;
        } catch (error) {
            console.error('Error in Gemini API request:', error);
            new Notice(`Gemini API error: ${error.message}`);
            throw error;
        }
    }

    private parseResponse(response: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): MCQQuestion[] {
        const questions: MCQQuestion[] = [];
        try {
            console.log('Raw AI response from Gemini:', response);
            let questionBlocks: string[] = response.split(/\d+\.\s+/).filter(block => block.trim().length > 0);

            if (questionBlocks.length === 0) {
                const lines = response.split('\n');
                let currentQuestion = '';
                for (const line of lines) {
                    if (/^\d+\./.test(line.trim())) {
                        if (currentQuestion) questionBlocks.push(currentQuestion);
                        currentQuestion = line.replace(/^\d+\.\s*/, '') + '\n';
                    } else if (currentQuestion) {
                        currentQuestion += line + '\n';
                    }
                }
                if (currentQuestion) questionBlocks.push(currentQuestion);
            }

            console.log(`Found ${questionBlocks.length} question blocks from Gemini`);
            for (const block of questionBlocks) {
                const lines = block.split('\n').filter(line => line.trim().length > 0);
                if (lines.length < 2) continue;

                let questionText = lines[0].trim();
                // Remove <think> and </think> tags from the question text
                questionText = questionText.replace(/<think>/g, '').replace(/<\/think>/g, '');

                const choices: string[] = [];
                let correctAnswerIndex = -1;

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    const isCorrect = line.includes('[CORRECT]');
                    const cleanedLine = line.replace(/\[CORRECT\]/g, '').replace(/^[A-Z]\)\s*|^[A-Z]\.\s*|^\w+\)\s*|^\w+\.\s*/, '').trim();
                    choices.push(cleanedLine);
                    if (isCorrect) correctAnswerIndex = choices.length - 1;
                }

                if (correctAnswerIndex === -1) { 
                    for (let i = 0; i < choices.length; i++) {
                        if (lines[i+1] && (lines[i+1].toLowerCase().includes('correct') || lines[i+1].includes('✓') || lines[i+1].includes('✔️'))) {
                            correctAnswerIndex = i;
                            break;
                        }
                    }
                }
                if (correctAnswerIndex === -1 && choices.length > 0) correctAnswerIndex = 0;

                if (questionText && choices.length >= 2) {
                    questions.push({ question: questionText, choices, correctAnswerIndex });
                }
            }
            console.log(`Successfully parsed ${questions.length} MCQ questions from Gemini`);
            return questions.slice(0, numQuestionsToGenerate); // Use calculated number
        } catch (error) {
            console.error('Error parsing MCQ response from Gemini:', error);
            new Notice('Error parsing MCQ response from Gemini. Please try again.');
            return [];
        }
    }
}
