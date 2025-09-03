import { Notice, requestUrl } from 'obsidian'; // Removed TFile as it wasn't used
import SpaceforgePlugin from '../main';
import { MCQQuestion, MCQSet } from '../models/mcq';
import { IMCQGenerationService } from './mcq-generation-service';
import { SpaceforgeSettings, MCQQuestionAmountMode } from '../models/settings'; // Import MCQQuestionAmountMode

/**
 * Service for generating MCQs using the OpenRouter API
 */
export class OpenRouterService implements IMCQGenerationService {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;
    
    /**
     * Initialize OpenRouter service
     * 
     * @param plugin Reference to the main plugin
     */
    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }
    
    /**
     * Generate MCQs for a note
     * 
     * @param notePath Path to the note
     * @param noteContent Content of the note
     * @param settings Current plugin settings
     * @returns Generated MCQ set or null if failed
     */
    async generateMCQs(notePath: string, noteContent: string, settings: SpaceforgeSettings): Promise<MCQSet | null> {
        // Check if API key is set
        if (!settings.openRouterApiKey) {
            new Notice('OpenRouter API key is not set. Please add it in the settings.');
            return null;
        }
        
        try {
            // Show loading notice
            new Notice('Generating MCQs using OpenRouter...');

            // Determine the number of questions to generate
            let numQuestionsToGenerate: number;
            if (settings.mcqQuestionAmountMode === MCQQuestionAmountMode.WordsPerQuestion) {
                const wordCount = noteContent.split(/\s+/).filter(Boolean).length;
                // Ensure at least 1 question, and use ceiling to round up slightly
                numQuestionsToGenerate = Math.max(1, Math.ceil(wordCount / settings.mcqWordsPerQuestion)); 
                // Optional: Add a reasonable upper limit if desired, e.g., Math.min(numQuestionsToGenerate, 15);
            } else { // Fixed mode
                numQuestionsToGenerate = settings.mcqQuestionsPerNote;
            }
            
            // Generate prompt based on settings and calculated question count
            const prompt = this.generatePrompt(noteContent, settings, numQuestionsToGenerate);
            
            // Make API request
            const response = await this.makeApiRequest(prompt, settings);
            
            // Parse response to extract MCQs, respecting the target number
            const questions = this.parseResponse(response, settings, numQuestionsToGenerate);
            
            // Ensure we have at least one question if requested
            if (questions.length === 0) {
                new Notice('Failed to generate valid MCQs from OpenRouter. Please try again.');
                return null;
            }
            
            // Create MCQ set
            const mcqSet: MCQSet = {
                notePath,
                questions,
                generatedAt: Date.now()
            };
            
            return mcqSet;
        } catch (error) {
            new Notice('Failed to generate MCQs with OpenRouter. Please check console for details.');
            return null;
        }
    }
    
    /**
     * Generate prompt for the AI
     * 
     * @param noteContent Content of the note
     * @param settings Current plugin settings
     * @param numQuestionsToGenerate The target number of questions to ask for
     * @returns Prompt for the AI
     */
    private generatePrompt(noteContent: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): string {
        // Use the passed numQuestionsToGenerate instead of settings.mcqQuestionsPerNote directly
        const questionCount = numQuestionsToGenerate; 
        const choiceCount = settings.mcqChoicesPerQuestion;
        const promptType = settings.mcqPromptType;
        const difficulty = settings.mcqDifficulty;
        
        // Base prompt template according to prompt type
        let basePrompt = "";
        
        if (promptType === 'basic') {
            basePrompt = `Generate ${questionCount} multiple-choice questions based on the following note content. Each question should have ${choiceCount} choices, with one correct answer. Format the output as a list of questions with bullet points for each answer choice. Mark the correct answer by putting [CORRECT] at the end of the line.`;
        } else {
            basePrompt = `Generate ${questionCount} multiple-choice questions that test understanding of key concepts in the following note. Each question should have ${choiceCount} choices, with only one correct answer. Format the output as a numbered list of questions with lettered choices (A, B, C, etc.). Mark the correct answer by putting [CORRECT] at the end of the line.

For example:
1. What is the capital of France?
   A) London
   B) Berlin
   C) Paris [CORRECT]
   D) Madrid
   E) Rome`;
        }
        
        // Add difficulty-specific instructions
        if (difficulty === 'basic') {
            basePrompt += `\n\nCreate straightforward questions that focus on key facts and basic concepts. Make the questions clear and direct, suitable for beginners or initial review.`;
        } else {
            basePrompt += `\n\nCreate challenging questions that test deeper understanding and application of concepts. Make the incorrect choices plausible to encourage critical thinking.`;
        }
        
        // Add note content
        return `${basePrompt}\n\nNote Content:\n${noteContent}`;
    }
    
    /**
     * Make API request to OpenRouter
     * 
     * @param prompt Prompt for the AI
     * @param settings Current plugin settings
     * @returns AI response text
     */
    private async makeApiRequest(prompt: string, settings: SpaceforgeSettings): Promise<string> {
        const apiKey = settings.openRouterApiKey; // Use key from settings argument
        const model = settings.openRouterModel;   // Use model from settings argument
        const difficulty = settings.mcqDifficulty;
        
        try {
            // Get the appropriate system prompt based on difficulty
            const systemPrompt = difficulty === 'basic' 
                ? settings.mcqBasicSystemPrompt 
                : settings.mcqAdvancedSystemPrompt;
            
            const response = await requestUrl({
                url: 'https://openrouter.ai/api/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'https://obsidian.md', // Required by OpenRouter
                    'X-Title': 'Spaceforge Plugin for Obsidian' // Identifying the app
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { 
                            role: 'system', 
                            content: systemPrompt
                        },
                        { 
                            role: 'user', 
                            content: prompt 
                        }
                    ]
                })
            });

            if (response.status !== 200) {
                throw new Error(`API request failed (${response.status}): ${response.text}`);
            }

            const data = response.json;

            if (!data.choices || !data.choices.length || !data.choices[0].message) {
                throw new Error('Invalid API response format from OpenRouter - missing choices');
            }

            return data.choices[0].message.content;
        } catch (error) {
            new Notice(`OpenRouter API error: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Parse the AI response to extract MCQs
     * 
     * @param response AI response text
     * @param settings Current plugin settings
     * @param numQuestionsToGenerate The target number of questions expected
     * @returns Array of parsed MCQ questions
     */
    private parseResponse(response: string, settings: SpaceforgeSettings, numQuestionsToGenerate: number): MCQQuestion[] {
        const questions: MCQQuestion[] = [];
        
        try {
            // Log the raw response for debugging
            // Check for common response formats
            let questionBlocks: string[] = [];
            
            // Method 1: Split by numbered questions (1., 2., etc.)
            questionBlocks = response.split(/\d+\.\s+/).filter(block => block.trim().length > 0);
            
            // If we didn't find questions, try another method
            if (questionBlocks.length === 0) {
                // Method 2: Look for line breaks with numbered patterns
                const lines = response.split('\n');
                let currentQuestion = '';
                
                for (const line of lines) {
                    if (/^\d+\./.test(line.trim())) {
                        if (currentQuestion) {
                            questionBlocks.push(currentQuestion);
                        }
                        currentQuestion = line.replace(/^\d+\.\s*/, '') + '\n';
                    } else if (currentQuestion) {
                        currentQuestion += line + '\n';
                    }
                }
                
                if (currentQuestion) {
                    questionBlocks.push(currentQuestion);
                }
            }
            
            for (const block of questionBlocks) {
                // Extract the question text and choices
                const lines = block.split('\n').filter(line => line.trim().length > 0);
                if (lines.length < 2) {
                    continue;
                }
                
                let questionText = lines[0].trim();
                // Remove <think> and </think> tags from the question text
                questionText = questionText.replace(/<think>/g, '').replace(/<\/think>/g, '');

                const choices: string[] = [];
                let correctAnswerIndex = -1;
                
                // Debug the question
                // Extract choices and identify the correct answer
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    const isCorrect = line.includes('[CORRECT]');
                    
                    // Remove the [CORRECT] marker and any leading identifiers (A), B., etc.)
                    const cleanedLine = line
                        .replace(/\[CORRECT\]/g, '')
                        .replace(/^[A-Z]\)\s*|^[A-Z]\.\s*|^\w+\)\s*|^\w+\.\s*/, '')
                        .trim();
                    
                    choices.push(cleanedLine);
                    
                    if (isCorrect) {
                        correctAnswerIndex = choices.length - 1;
                    }
                }
                
                // If no answer was marked as correct, try to check for other indicators
                if (correctAnswerIndex === -1) {
                    for (let i = 0; i < choices.length; i++) {
                        // Check for any other correct answer indicator
                        if (lines[i+1] && (
                            lines[i+1].toLowerCase().includes('correct') ||
                            lines[i+1].includes('✓') ||
                            lines[i+1].includes('✔️')
                        )) {
                            correctAnswerIndex = i;
                            break;
                        }
                    }
                }
                
                // If still no correct answer found, default to the first answer as a fallback
                if (correctAnswerIndex === -1 && choices.length > 0) {
                    correctAnswerIndex = 0;
                }
                
                // Only add if we found a valid question with choices
                if (questionText && choices.length >= 2) {
                    questions.push({
                        question: questionText,
                        choices,
                        correctAnswerIndex
                    });
                } else {
                }
            }
            
            // Log the parsed questions
            // Limit to the target number of questions calculated earlier
            // Use numQuestionsToGenerate instead of settings.mcqQuestionsPerNote
            return questions.slice(0, numQuestionsToGenerate); 
        } catch (error) {
            new Notice('Error parsing MCQ response from OpenRouter. Please try again.');
            return [];
        }
    }
}
