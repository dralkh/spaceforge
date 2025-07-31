import { Notice } from 'obsidian';
import SpaceforgePlugin from '../main';
import { MCQQuestion, MCQSet } from '../models/mcq';
import { IMCQGenerationService } from './mcq-generation-service';
import { SpaceforgeSettings, MCQQuestionAmountMode } from '../models/settings'; // Import MCQQuestionAmountMode

export class OllamaService implements IMCQGenerationService {
    plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    async generateMCQs(notePath: string, noteContent: string, settings: SpaceforgeSettings): Promise<MCQSet | null> {
        if (!settings.ollamaApiUrl) {
            new Notice('Ollama API URL is not set. Please add it in the Spaceforge settings.');
            return null;
        }
        if (!settings.ollamaModel) {
            new Notice('Ollama Model is not set. Please add it in the Spaceforge settings.');
            return null;
        }

        try {
            new Notice('Generating MCQs using Ollama...');

            // Determine the number of questions to generate
            let numQuestionsToGenerate: number;
            if (settings.mcqQuestionAmountMode === MCQQuestionAmountMode.WordsPerQuestion) {
                const wordCount = noteContent.split(/\s+/).filter(Boolean).length;
                numQuestionsToGenerate = Math.max(1, Math.ceil(wordCount / settings.mcqWordsPerQuestion));
                console.log(`Ollama: Calculated ${numQuestionsToGenerate} questions based on ${wordCount} words and ${settings.mcqWordsPerQuestion} words/question setting.`);
            } else { // Fixed mode
                numQuestionsToGenerate = settings.mcqQuestionsPerNote;
                console.log(`Ollama: Using fixed number of questions: ${numQuestionsToGenerate}`);
            }

            const prompt = this.generatePrompt(noteContent, settings, numQuestionsToGenerate);
            const response = await this.makeApiRequest(prompt, settings);
            const questions = this.parseResponse(response, settings, numQuestionsToGenerate);

            if (questions.length === 0) {
                new Notice('Failed to generate valid MCQs from Ollama. Please try again.');
                return null;
            }

            return {
                notePath,
                questions,
                generatedAt: Date.now()
            };
        } catch (error) {
            console.error('Error generating MCQs with Ollama:', error);
            new Notice('Failed to generate MCQs with Ollama. Please check console for details.');
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

        if (difficulty === 'basic') {
            basePrompt += `\n\nCreate straightforward questions that focus on key facts and basic concepts. Make the questions clear and direct, suitable for beginners or initial review.`;
        } else {
            basePrompt += `\n\nCreate challenging questions that test deeper understanding and application of concepts. Make the incorrect choices plausible to encourage critical thinking.`;
        }
        return `${basePrompt}\n\nNote Content:\n${noteContent}`;
    }

    private async makeApiRequest(prompt: string, settings: SpaceforgeSettings): Promise<string> {
        const apiUrl = settings.ollamaApiUrl.endsWith('/') ? settings.ollamaApiUrl.slice(0, -1) : settings.ollamaApiUrl;
        const model = settings.ollamaModel;
        const difficulty = settings.mcqDifficulty;
        
        const systemPrompt = difficulty === 'basic' 
            ? settings.mcqBasicSystemPrompt 
            : settings.mcqAdvancedSystemPrompt;

        console.log(`Making API request to Ollama at ${apiUrl} using model: ${model} with difficulty: ${difficulty}`);

        try {
            const response = await fetch(`${apiUrl}/api/chat`, { // Common Ollama chat endpoint
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: prompt }
                    ],
                    stream: false // Ensure we get the full response, not a stream
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Ollama API error:', response.status, errorText);
                throw new Error(`API request failed (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            // Ollama's non-streaming chat response structure is typically { model, created_at, message: { role, content }, done }
            if (!data.message || !data.message.content) {
                console.error('Invalid API response format from Ollama:', data);
                throw new Error('Invalid API response format from Ollama - missing message content');
            }
            return data.message.content;
        } catch (error) {
            console.error('Error in Ollama API request:', error);
            new Notice(`Ollama API error: ${error.message}`);
            throw error;
        }
    }

    private parseResponse(response: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): MCQQuestion[] {
        const questions: MCQQuestion[] = [];
        try {
            console.log('Raw AI response from Ollama:', response);
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

            console.log(`Found ${questionBlocks.length} question blocks from Ollama`);
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
            console.log(`Successfully parsed ${questions.length} MCQ questions from Ollama`);
            return questions.slice(0, numQuestionsToGenerate); // Use calculated number
        } catch (error) {
            console.error('Error parsing MCQ response from Ollama:', error);
            new Notice('Error parsing MCQ response from Ollama. Please try again.');
            return [];
        }
    }
}
