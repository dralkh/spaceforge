import { MCQQuestion } from '../models/mcq';
import { MCQDifficulty, MCQQuestionAmountMode, SpaceforgeSettings } from '../models/settings';

/**
 * How a note becomes questions, and how the answer comes back.
 *
 * Both halves used to live inside the OpenAI-compatible service, which meant the
 * prompt and the parser were the property of one provider. They are not: every
 * provider — and now every local CLI — is asked the same thing in the same
 * format, and the same parser reads the reply. That is the only reason a CLI can
 * answer MCQs at all without a second, drifting implementation.
 */

/** How many questions this note should get, under the current settings. */
export function questionsToGenerate(noteContent: string, settings: SpaceforgeSettings): number {
    if (settings.mcqQuestionAmountMode === MCQQuestionAmountMode.WordsPerQuestion) {
        const wordCount = noteContent.split(/\s+/).filter(Boolean).length;
        return Math.max(1, Math.ceil(wordCount / settings.mcqWordsPerQuestion));
    }
    return settings.mcqQuestionsPerNote;
}

/** The prompt every provider is sent, [CORRECT] marker and all. */
export function buildMcqPrompt(
    noteContent: string,
    settings: SpaceforgeSettings,
    numQuestionsToGenerate: number
): string {
    const questionCount = numQuestionsToGenerate;
    const choiceCount = settings.mcqChoicesPerQuestion;
    const promptType = settings.mcqPromptType;
    const difficulty = settings.mcqDifficulty;

    let basePrompt = '';
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

/**
 * Read the reply into questions. Tolerant on purpose: models wrap answers in
 * commentary, number them inconsistently, or answer with bullets instead of
 * numbers, and all of that is still usable. Returns [] when nothing could be
 * read; the caller decides what to say about that.
 */
export function parseMcqResponse(
    response: string,
    settings: SpaceforgeSettings,
    numQuestionsToGenerate: number
): MCQQuestion[] {
    const questions: MCQQuestion[] = [];
    try {
        let questionBlocks: string[] = response.split(/\n\d+\.\s+/).filter(block => block.trim().length > 0);

        if (questionBlocks.length > 0 && !/^\d+\.\s+/.test(response.trimStart())) {
            if (!/^\d+\.\s+/.test(questionBlocks[0])) {
                if (response.trimStart().length > 0 && questionBlocks.length === 1 && !response.includes('\n1.')) {
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

        if (questionBlocks.length === 0 || (questionBlocks.length < settings.mcqQuestionsPerNote / 2 && response.includes('1.'))) {
            const lines = response.split('\n');
            let currentQuestionBlock = '';
            const tempBlocks: string[] = [];
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
            questionText = questionText.replace(/ thinking/g, '').replace(/<\/think>/g, '');

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
                    if (choices[i].toLowerCase().includes('(correct answer)') || choices[i].toLowerCase().includes(' - correct')) {
                        choices[i] = choices[i].replace(/\(correct answer\)/gi, '').replace(/ - correct/gi, '').trim();
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
        return [];
    }
}
