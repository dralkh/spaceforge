import { Modal, Notice, TFile, setIcon } from 'obsidian';
import SpaceforgePlugin from '../main';
import { MCQSet } from '../models/mcq';
import { ReviewResponse } from '../models/review-schedule';

/**
 * Modal for consolidated MCQ review
 * This processes all questions from multiple notes in one series
 */
export class ConsolidatedMCQModal extends Modal {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;
    
    /**
     * Collection of all MCQ sets
     */
    mcqSets: {
        path: string;
        mcqSet: MCQSet;
        fileName: string;
    }[];
    
    /**
     * Callback for when review is completed
     */
    onComplete: (results: Array<{
        path: string,
        success: boolean,
        response: ReviewResponse,
        score?: number
    }>) => void;
    
    /**
     * All questions from all MCQ sets, flattened
     */
    allQuestions: {
        question: string;
        choices: string[];
        correctAnswerIndex: number;
        notePath: string;
        fileName: string;
        mcqSetId: string;
        originalIndex: number;
    }[] = [];
    
    /**
     * Current question index
     */
    currentQuestionIndex: number = 0;
    
    /**
     * User's answers
     */
    answers: {
        questionIndex: number;
        selectedAnswerIndex: number; // Stores the actual index selected by the user
        correct: boolean;
        timeToAnswer: number;
        attempts: number;
        notePath: string;
        fileName: string;
    }[] = [];
    
    /**
     * Start time for current question
     */
    questionStartTime: number = 0;
    
    /**
     * Initialize consolidated MCQ modal
     * 
     * @param plugin Reference to the main plugin
     * @param mcqSets Collection of all MCQ sets
     * @param onComplete Callback for when review is completed
     */
    constructor(
        plugin: SpaceforgePlugin,
        mcqSets: {
            path: string;
            mcqSet: MCQSet;
            fileName: string;
        }[],
        onComplete: (results: Array<{
            path: string,
            success: boolean,
            response: ReviewResponse,
            score?: number
        }>) => void
    ) {
        super(plugin.app);
        this.plugin = plugin;
        this.mcqSets = mcqSets;
        this.onComplete = onComplete;
        
        // Flatten all questions from all MCQ sets
        for (const set of mcqSets) {
            set.mcqSet.questions.forEach((question, index) => {
                this.allQuestions.push({
                    ...question,
                    notePath: set.path,
                    fileName: set.fileName,
                    mcqSetId: `${set.path}_${set.mcqSet.generatedAt}`,
                    originalIndex: index
                });
            });
        }
        
        // Optional: Shuffle questions for better learning
        // this.allQuestions = this.shuffleArray(this.allQuestions);
    }
    
    /**
     * Called when the modal is opened
     */
    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        
        // Add a unique class to the modal content for specific styling
        contentEl.addClass('spaceforge-mcq-modal');
        
        // Create header container
        const headerContainer = contentEl.createDiv('mcq-header-container');
        
        // Add title
        headerContainer.createEl('h2', { text: 'Multiple Choice Review' });
        
        // Display progress with questions from all notes, with enhanced styling
        const progressEl = contentEl.createDiv('mcq-progress');
        
        // Calculate progress percentage for dynamic styling
        const progressPercent = Math.round(((this.currentQuestionIndex + 1) / this.allQuestions.length) * 100);
        // Set data-progress for proper progress bar display
        contentEl.setAttribute('data-progress', progressPercent.toString());
        
        progressEl.setText(`Question ${this.currentQuestionIndex + 1} of ${this.allQuestions.length}`);
        
        // Display a progress counter badge
        const progressCounter = contentEl.createDiv('mcq-progress-counter');
        progressCounter.setText(`${this.allQuestions.length} questions from ${this.mcqSets.length} notes`);

        // Display note information with enhanced styling
        const noteInfoEl = contentEl.createDiv('mcq-note-info');
        noteInfoEl.setText(`Question from: ${this.allQuestions[this.currentQuestionIndex].fileName}`);
        
        // Start timing
        this.questionStartTime = Date.now();
        
        // Display current question
        this.displayCurrentQuestion(contentEl);
        
        // Add keyboard shortcuts
        this.registerKeyboardShortcuts();
    }
    
    /**
     * Register keyboard shortcuts for answering questions
     */
    registerKeyboardShortcuts(): void {
        const keyDownHandler = (event: KeyboardEvent) => {
            // Get the current question
            const questionIndex = this.currentQuestionIndex;
            if (questionIndex >= this.allQuestions.length) return;
            
            const question = this.allQuestions[questionIndex];
            if (!question || !question.choices) return;
            
            // Handle number keys 1-9 (for choices)
            const num = parseInt(event.key);
            if (!isNaN(num) && num >= 1 && num <= question.choices.length) {
                this.handleAnswer(num - 1);
                return;
            }
            
            // Handle letter keys A-I (for choices)
            if (event.key.length === 1) {
                const letterCode = event.key.toUpperCase().charCodeAt(0);
                const index = letterCode - 65; // A=0, B=1, etc.
                if (index >= 0 && index < question.choices.length) {
                    this.handleAnswer(index);
                    return;
                }
            }
        };
        
        // Add event listener
        document.addEventListener('keydown', keyDownHandler);
        
        // Clean up when modal is closed
        this.onClose = () => {
            document.removeEventListener('keydown', keyDownHandler);
            const { contentEl } = this;
            contentEl.empty();
        };
    }
    
    /**
     * Display the current question
     * 
     * @param containerEl Container element
     */
    displayCurrentQuestion(containerEl: HTMLElement): void {
        const questionIndex = this.currentQuestionIndex;
        
        if (questionIndex >= this.allQuestions.length) {
            this.completeReview();
            return;
        }
        
        const question = this.allQuestions[questionIndex];
        
        // Verify we have a valid question
        if (!question || !question.choices || question.choices.length < 2) {
            console.error('Invalid question data:', question);
            new Notice('Error: Invalid question data. Moving to next question.');
            
            // Skip to next question
            this.currentQuestionIndex++;
            if (this.currentQuestionIndex < this.allQuestions.length) {
                this.displayCurrentQuestion(containerEl);
            } else {
                this.completeReview();
            }
            return;
        }
        
        // Clear previous question
        const questionContainer = containerEl.querySelector('.mcq-question-container');
        if (questionContainer) {
            questionContainer.remove();
        }
        
        // Update note info
        const noteInfoEl = containerEl.querySelector('.mcq-note-info');
        if (noteInfoEl instanceof HTMLElement) {
            noteInfoEl.setText(`Question from: ${question.fileName}`);
        }
        
        // Create question container
        const newQuestionContainer = containerEl.createDiv('mcq-question-container');
        
        // Display question text
        const questionEl = newQuestionContainer.createDiv('mcq-question-text');
        questionEl.setText(question.question);
        
        // Display choices
        const choicesContainer = newQuestionContainer.createDiv('mcq-choices-container');
        
        question.choices.forEach((choice, index) => {
            const choiceEl = choicesContainer.createDiv('mcq-choice');
            
            // Create choice button
            const choiceBtn = choiceEl.createEl('button', {
                cls: 'mcq-choice-btn'
            });
            
            // Add letter label
            const letterLabel = choiceBtn.createSpan('mcq-choice-letter');
            letterLabel.setText(String.fromCharCode(65 + index) + ') ');
            
            // Add choice text
            const textSpan = choiceBtn.createSpan('mcq-choice-text');
            textSpan.setText(choice || '(Empty choice)'); // Handle empty choices
            
            choiceBtn.addEventListener('click', () => {
                this.handleAnswer(index);
            });
        });
    }
    
    /**
     * Handle user's answer selection
     * 
     * @param selectedIndex Index of the selected answer
     */
    handleAnswer(selectedIndex: number): void {
        const questionIndex = this.currentQuestionIndex;
        const question = this.allQuestions[questionIndex];
        const isCorrect = selectedIndex === question.correctAnswerIndex;
        
        // Calculate time to answer
        const timeToAnswer = (Date.now() - this.questionStartTime) / 1000;
        
        // Check if this question has been answered before
        const existingAnswerIndex = this.answers.findIndex(
            a => a.questionIndex === questionIndex
        );
        
        let answer: {
            questionIndex: number;
            selectedAnswerIndex: number;
            correct: boolean;
            timeToAnswer: number;
            attempts: number;
            notePath: string;
            fileName: string;
        };
        
        if (existingAnswerIndex >= 0) {
            // Update existing answer
            answer = this.answers[existingAnswerIndex];
            
            // Always update selected index and correctness based on the current attempt
            answer.selectedAnswerIndex = selectedIndex;
            answer.correct = isCorrect; 
            
            // Always update the timing and attempts
            answer.timeToAnswer = timeToAnswer;
            answer.attempts += 1;
        } else {
            // Create new answer
            answer = {
                questionIndex,
                selectedAnswerIndex: selectedIndex, // Always record the selected index
                correct: isCorrect,
                timeToAnswer,
                attempts: 1,
                notePath: question.notePath,
                fileName: question.fileName
            };
            this.answers.push(answer);
        }
        
        // Highlight the selected answer
        this.highlightAnswer(selectedIndex, isCorrect);
        
        // Wait a moment before proceeding
        setTimeout(() => {
            if (isCorrect) {
                // Move to next question if correct
                this.currentQuestionIndex++;
                this.questionStartTime = Date.now();
                
                const { contentEl } = this;
                
                // Update progress
                const progressEl = contentEl.querySelector('.mcq-progress');
                if (progressEl instanceof HTMLElement) {
                    progressEl.textContent = `Question ${this.currentQuestionIndex + 1} of ${this.allQuestions.length} (${this.allQuestions.length} questions from ${this.mcqSets.length} notes)`;
                }
                
                // Update progress percentage for the progress bar
                const newProgressPercent = Math.round(((this.currentQuestionIndex + 1) / this.allQuestions.length) * 100);
                contentEl.setAttribute('data-progress', newProgressPercent.toString());
                
                // Show next question or complete review
                if (this.currentQuestionIndex < this.allQuestions.length) {
                    this.displayCurrentQuestion(contentEl);
                } else {
                    this.completeReview();
                }
            } else {
                // For incorrect answers, show a hint
                new Notice("Incorrect answer. Try again to proceed to the next question.");
                
                // Remove the highlight after a short delay
                setTimeout(() => {
                    const choiceButtons = document.querySelectorAll('.mcq-choice-btn');
                    if (choiceButtons.length <= selectedIndex) return;
                    
                    const selectedBtn = choiceButtons[selectedIndex] as HTMLElement;
                    selectedBtn.classList.remove('mcq-choice-incorrect');
                }, 500);
            }
        }, 1000);
    }
    
    /**
     * Highlight the selected answer
     * 
     * @param selectedIndex Index of the selected answer
     * @param isCorrect Whether the answer is correct
     */
    highlightAnswer(selectedIndex: number, isCorrect: boolean): void {
        const choiceButtons = document.querySelectorAll('.mcq-choice-btn');
        
        if (choiceButtons.length <= selectedIndex) return;
        
        const selectedBtn = choiceButtons[selectedIndex] as HTMLElement;
        
        // Add highlight to selected answer
        if (isCorrect) {
            // For correct answers, highlight it green
            selectedBtn.classList.add('mcq-choice-correct');
        } else {
            // For incorrect answers, only highlight the selected one red
            selectedBtn.classList.add('mcq-choice-incorrect');
        }
    }
    
    /**
     * Complete the review and show results
     */
    completeReview(): void {
        // Calculate scores by note
        const noteScores: Record<string, {
            totalQuestions: number;
            correctAnswers: number;
            score: number;
            notePath: string;
            fileName: string;
        }> = {};
        
        // Ensure all questions have an answer entry, even if not attempted or skipped
        // This is important for the detailed breakdown later.
        // We assume that if a question is in allQuestions but not in this.answers,
        // it means it wasn't answered (e.g., if the modal was closed prematurely).
        // For the purpose of score calculation, only answered questions count.
        // However, for display, we might want to show all.
        // For now, the existing logic for noteScores only considers `this.answers`.

        for (const answer of this.answers) {
            if (!noteScores[answer.notePath]) {
                noteScores[answer.notePath] = {
                    totalQuestions: 0,
                    correctAnswers: 0,
                    score: 0,
                    notePath: answer.notePath,
                    fileName: answer.fileName
                };
            }
            
            // Each answer corresponds to one question attempt from that note
            // We need to count unique questions from each note that were answered.
            // The current logic for totalQuestions in noteScores might be slightly off
            // if a question is answered multiple times. Let's refine.

            // This loop iterates through recorded answers.
            // To get total questions *from the original set* for a note:
            // const questionsFromThisNote = this.allQuestions.filter(q => q.notePath === answer.notePath).length;
            // noteScores[answer.notePath].totalQuestions = questionsFromThisNote; // This should be set once per note.
        }

        // Recalculate totalQuestions per note based on allQuestions
        for (const question of this.allQuestions) {
            if (!noteScores[question.notePath]) {
                 noteScores[question.notePath] = {
                    totalQuestions: 0,
                    correctAnswers: 0,
                    score: 0,
                    notePath: question.notePath,
                    fileName: question.fileName // Assuming fileName is consistent for the notePath
                };
            }
            noteScores[question.notePath].totalQuestions++;
        }
        
        // Calculate correct answers based on the final recorded answer for each question
        const finalAnswersCorrectCount: Record<string, number> = {};
        for (const question of this.allQuestions) {
            finalAnswersCorrectCount[question.notePath] = 0;
        }

        for (const answer of this.answers) {
            // Only count as correct if the *final* state of the answer for that questionIndex is correct
            // and it was correct on the first attempt for scoring purposes.
            // The `answer.correct` here reflects the status of the *last attempt* for that question during the session.
            // For scoring, we usually care about first-attempt correctness.
            // The current logic `answer.correct && answer.attempts <= 1` is fine for scoring.
            if (answer.correct && answer.attempts <= 1) {
                 if (noteScores[answer.notePath]) { // Ensure noteScore entry exists
                    noteScores[answer.notePath].correctAnswers++;
                }
            }
        }
        
        // Calculate scores
        for (const notePath in noteScores) {
            const noteScore = noteScores[notePath];
            // Ensure totalQuestions is not zero to avoid division by zero
            if (noteScore.totalQuestions > 0) {
                noteScore.score = noteScore.correctAnswers / noteScore.totalQuestions;
            } else {
                noteScore.score = 0; // No questions for this note, or no answers recorded
            }
        }
        
        // Convert note scores to results for the callback
        const results: Array<{
            path: string;
            success: boolean;
            response: ReviewResponse;
            score?: number;
        }> = [];
        
        for (const notePath in noteScores) {
            const noteScore = noteScores[notePath];
            const score = noteScore.score;
            
            // Determine success and response based on score
            let success = false;
            let response = ReviewResponse.Hard;
            
            if (score >= 0.9) {
                success = true;
                response = ReviewResponse.Perfect;
            } else if (score >= 0.7) {
                success = true;
                response = ReviewResponse.Good;
            } else if (score >= 0.5) {
                success = true;
                response = ReviewResponse.Fair;
            } else {
                success = false;
                response = ReviewResponse.Hard;
            }
            
            results.push({
                path: notePath,
                success,
                response,
                score
            });
        }
        
        // Call the completion callback
        this.onComplete(results);
        
        // Show results
        const { contentEl } = this;
        contentEl.empty();
        
        // Display results header with stylized heading
        const headerEl = contentEl.createEl('h2', { text: 'MCQ Review Complete', cls: 'mcq-review-complete-header' });

        // Display overall score with enhanced styling
        const totalCorrectOverall = this.answers.filter(a => a.correct && a.attempts <= 1).length;
        const totalQuestionsOverall = this.allQuestions.length;
        const overallScore = totalQuestionsOverall > 0 ? totalCorrectOverall / totalQuestionsOverall : 0;
        const scorePercentOverall = Math.round(overallScore * 100);
        
        const scoreEl = contentEl.createDiv('mcq-score');
        const scoreTextEl = scoreEl.createDiv('mcq-score-text');
        scoreTextEl.setText(`Overall Score: ${scorePercentOverall}%`);
        
        // Add performance indicator based on score
        const performanceIndicator = scoreEl.createDiv('mcq-performance-indicator');

        if (scorePercentOverall >= 90) {
            performanceIndicator.setText('🎓 Excellent Performance!');
            performanceIndicator.addClass('excellent');
        } else if (scorePercentOverall >= 70) {
            performanceIndicator.setText('👍 Good Work!');
            performanceIndicator.addClass('good');
        } else if (scorePercentOverall >= 50) {
            performanceIndicator.setText('🔄 Keep Practicing');
            performanceIndicator.addClass('needs-improvement');
        } else {
            performanceIndicator.setText('📚 More Review Recommended');
            performanceIndicator.addClass('review-recommended');
        }

        // Add stats summary
        const statsEl = scoreEl.createDiv('mcq-stats-summary');
        statsEl.setText(`${totalCorrectOverall} correct out of ${totalQuestionsOverall} questions`);

        // Display note scores with enhanced styling
        const noteScoresEl = contentEl.createDiv('mcq-note-scores');
        const scoreHeading = noteScoresEl.createEl('h3', { text: 'Scores by Note', cls: 'mcq-note-scores-heading' });
        
        // Sort notes by score for better visualization (highest first)
        const sortedNotes = Object.keys(noteScores).sort((a, b) => noteScores[b].score - noteScores[a].score);
        
        for (const notePath of sortedNotes) {
            const noteScore = noteScores[notePath];
            if (noteScore.totalQuestions === 0) continue; // Skip notes with no questions in the review set

            const noteScoreEl = noteScoresEl.createDiv('mcq-note-score');
            
            noteScoreEl.createEl('div', {
                text: noteScore.fileName,
                cls: 'mcq-note-score-title'
            });
            
            const scorePercent = Math.round(noteScore.score * 100);
            const scoreTextValueEl = noteScoreEl.createEl('div', {
                text: `Score: ${scorePercent}% (${noteScore.correctAnswers}/${noteScore.totalQuestions})`,
                cls: 'mcq-note-score-value'
            });

            // Style score badge based on performance
            if (noteScore.score >= 0.7) {
                scoreTextValueEl.addClass('high-score');
            } else if (noteScore.score >= 0.5) {
                scoreTextValueEl.addClass('medium-score');
            } else {
                scoreTextValueEl.addClass('low-score');
            }

            // Add a visual progress bar
            const progressBar = noteScoreEl.createDiv('mcq-progress-bar');
            const progressFill = progressBar.createDiv('mcq-progress-fill');
            progressFill.style.width = `${scorePercent}%`;

            if (noteScore.score >= 0.7) {
                progressFill.addClass('high-score');
            } else if (noteScore.score >= 0.5) {
                progressFill.addClass('medium-score');
            } else {
                progressFill.addClass('low-score');
            }
        }

        // --- Detailed Question Breakdown ---
        const breakdownContainer = contentEl.createDiv('mcq-detailed-breakdown');
        breakdownContainer.createEl('h3', { text: 'Detailed Question Breakdown' });

        this.allQuestions.forEach((question, index) => {
            const questionEl = breakdownContainer.createDiv('mcq-breakdown-item');

            const questionHeader = questionEl.createDiv();
            questionHeader.createSpan({ text: `Q${index + 1} (from ${question.fileName}): `, cls: 'mcq-breakdown-q-header' });
            questionHeader.createSpan({ text: question.question });

            const userAnswer = this.answers.find(a => a.questionIndex === index);

            const userAnswerTextEl = questionEl.createDiv('mcq-user-answer-text');
            let userAnswerDisplay = "Not answered";
            if (userAnswer && userAnswer.selectedAnswerIndex !== -1 && userAnswer.selectedAnswerIndex < question.choices.length) {
                userAnswerDisplay = question.choices[userAnswer.selectedAnswerIndex];
            } else if (userAnswer && userAnswer.selectedAnswerIndex === -1) {
                // This case should ideally not happen with the new logic in handleAnswer
                // but good to have a fallback.
                userAnswerDisplay = "Attempted, but no valid choice recorded";
            }


            if (userAnswer) {
                const correctnessText = userAnswer.correct ? ' (Correct)' : ' (Incorrect)';
                userAnswerTextEl.createSpan({ text: 'Your answer: ' });
                const userAnswerSpan = userAnswerTextEl.createSpan({ text: userAnswerDisplay });
                const correctnessSpan = userAnswerTextEl.createSpan({ text: correctnessText, cls: 'mcq-correctness-indicator' });
                if (userAnswer.correct) {
                    userAnswerSpan.addClass('correct');
                    correctnessSpan.addClass('correct');
                } else {
                    userAnswerSpan.addClass('incorrect');
                    correctnessSpan.addClass('incorrect');
                }
            } else {
                userAnswerTextEl.createSpan({ text: 'Your answer: ' + userAnswerDisplay });
                userAnswerTextEl.style.fontStyle = 'italic';
            }

            const correctAnswerEl = questionEl.createDiv('mcq-correct-answer');
            correctAnswerEl.createSpan({ text: 'Correct answer: ' });
            correctAnswerEl.createSpan({ text: question.choices[question.correctAnswerIndex], cls: 'mcq-correct-answer-text' });
        });
        
        // Create close button
        const closeBtn = contentEl.createEl('button', {cls: 'mcq-close-btn', text: 'Close'});

        closeBtn.addEventListener('click', () => {
            this.close();
        });
    }
    
    /**
     * Shuffle an array
     * 
     * @param array Array to shuffle
     * @returns Shuffled array
     */
    shuffleArray<T>(array: T[]): T[] {
        const newArray = [...array];
        for (let i = newArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
        }
        return newArray;
    }
}
