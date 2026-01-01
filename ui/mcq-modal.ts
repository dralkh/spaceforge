import { Modal, Notice, setIcon, TFile, Setting } from 'obsidian'; // Ensure TFile is imported, Added Setting
import SpaceforgePlugin from '../main';
import { MCQSet, MCQAnswer, MCQSession } from '../models/mcq';

/**
 * Modal for displaying and answering MCQs
 */
export class MCQModal extends Modal {
    plugin: SpaceforgePlugin;
    notePath: string;
    mcqSet: MCQSet;
    session: MCQSession;
    questionStartTime = 0;
    isFreshGeneration = false;
    // Modified callback to include score
    private onCompleteCallback: ((path: string, score: number, completed: boolean) => void) | null;
    private selectedAnswerIndex = -1;

    constructor(
        plugin: SpaceforgePlugin,
        notePath: string,
        mcqSet: MCQSet,
        onCompleteCallback: ((path: string, score: number, completed: boolean) => void) | null = null
    ) {
        super(plugin.app);
        this.plugin = plugin;
        this.notePath = notePath;
        this.mcqSet = mcqSet;
        this.onCompleteCallback = onCompleteCallback;
        this.isFreshGeneration = mcqSet.generatedAt > Date.now() - 60000;
        this.session = {
            mcqSetId: `${mcqSet.notePath}_${mcqSet.generatedAt}`,
            notePath,
            answers: [],
            score: 0,
            currentQuestionIndex: 0,
            completed: false,
            startedAt: Date.now(),
            completedAt: null
        };
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('spaceforge-mcq-modal');
        const headerContainer = contentEl.createDiv('mcq-header-container');
        new Setting(headerContainer).setName('Multiple choice review').setHeading();

        if (!this.isFreshGeneration) {
            const refreshBtn = headerContainer.createDiv('mcq-refresh-btn');
            setIcon(refreshBtn, 'refresh-cw');
            refreshBtn.setAttribute('aria-label', 'Generate new questions');
            refreshBtn.addEventListener('click', () => {
                this.close();
                void (async () => {
                    // Use mcqGenerationService
                    const mcqGenerationService = this.plugin.mcqGenerationService;
                    if (mcqGenerationService && this.plugin.mcqController) {
                        const file = this.plugin.app.vault.getAbstractFileByPath(this.notePath);
                        // Check if file is TFile before reading
                        if (file instanceof TFile) {
                            const content = await this.plugin.app.vault.read(file);
                            const newMcqSet = await mcqGenerationService.generateMCQs(this.notePath, content, this.plugin.settings);
                            if (newMcqSet) {
                                // Save via mcqService, then save plugin data
                                this.plugin.mcqService.saveMCQSet(newMcqSet);
                                await this.plugin.savePluginData();
                                const newModal = new MCQModal(this.plugin, this.notePath, newMcqSet, this.onCompleteCallback);
                                newModal.open();
                            } else {
                                new Notice('Failed to regenerate MCQs.');
                            }
                        } else {
                            new Notice('Could not find note file to regenerate MCQs.');
                        }
                    } else {
                        new Notice('MCQ generation service not available.');
                    }
                })();
            });
        }

        const questionIndex = this.session.currentQuestionIndex;
        const existingAnswer = this.session.answers.find(a => a.questionIndex === questionIndex);
        const progressEl = contentEl.createDiv('mcq-progress');
        const progressPercent = Math.round(((questionIndex + 1) / this.mcqSet.questions.length) * 100);
        contentEl.setAttribute('data-progress', progressPercent.toString());

        if (existingAnswer) {
            progressEl.setText(`Question ${questionIndex + 1} of ${this.mcqSet.questions.length} (Attempt ${existingAnswer.attempts + 1})`);
            if (existingAnswer.attempts === 1) {
                const warningEl = contentEl.createDiv('mcq-attempt-warning');
                const warningIcon = warningEl.createSpan(); warningIcon.setText('⚠️ ');
                const warningText = warningEl.createSpan(); warningText.setText('This is your last attempt before scoring 0 points for this question.');
                warningEl.addClass('mcq-warning');
            }
        } else {
            progressEl.setText(`Question ${questionIndex + 1} of ${this.mcqSet.questions.length}`);
        }

        this.questionStartTime = Date.now();
        this.displayCurrentQuestion(contentEl);
        this.registerKeyboardShortcuts();
    }

    registerKeyboardShortcuts(): void {
        const keyDownHandler = (event: KeyboardEvent) => {
            if (this.session.completed) return;
            const questionIndex = this.session.currentQuestionIndex;
            if (questionIndex >= this.mcqSet.questions.length) return;
            const question = this.mcqSet.questions[questionIndex];
            if (!question || !question.choices) return;
            const choiceButtons = this.contentEl.querySelectorAll('.mcq-choice-btn'); // Use this.contentEl
            if (choiceButtons.length === 0) return;

            if (this.selectedAnswerIndex !== -1 && this.selectedAnswerIndex < choiceButtons.length) {
                (choiceButtons[this.selectedAnswerIndex] as HTMLElement).classList.remove('mcq-choice-selected');
            }

            let processAnswer = false;
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                this.selectedAnswerIndex = (this.selectedAnswerIndex + 1) % question.choices.length;
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                this.selectedAnswerIndex = (this.selectedAnswerIndex - 1 + question.choices.length) % question.choices.length;
            } else if (event.key === 'ArrowRight' || event.key === 'Enter') { // Added Enter key
                event.preventDefault();
                if (this.selectedAnswerIndex !== -1) processAnswer = true;
            }

            const num = parseInt(event.key);
            if (!isNaN(num) && num >= 1 && num <= question.choices.length) {
                this.selectedAnswerIndex = num - 1;
                processAnswer = true;
            } else if (event.key.length === 1) {
                const letterCode = event.key.toUpperCase().charCodeAt(0);
                const index = letterCode - 65;
                if (index >= 0 && index < question.choices.length) {
                    this.selectedAnswerIndex = index;
                    processAnswer = true;
                }
            }

            if (this.selectedAnswerIndex !== -1 && this.selectedAnswerIndex < choiceButtons.length) {
                (choiceButtons[this.selectedAnswerIndex] as HTMLElement).classList.add('mcq-choice-selected');
            }

            if (processAnswer && this.selectedAnswerIndex !== -1) {
                if (this.selectedAnswerIndex < choiceButtons.length) {
                    const button = choiceButtons[this.selectedAnswerIndex] as HTMLElement;
                    button.classList.add('mcq-key-pressed');
                    window.setTimeout(() => {
                        button.classList.remove('mcq-key-pressed');
                        this.handleAnswer(this.selectedAnswerIndex);
                        this.selectedAnswerIndex = -1;
                    }, 150);
                } else {
                    this.handleAnswer(this.selectedAnswerIndex);
                    this.selectedAnswerIndex = -1;
                }
            }
        };

        // Use modal's scope for event listener management
        this.scope.register([], 'ArrowDown', keyDownHandler);
        this.scope.register([], 'ArrowUp', keyDownHandler);
        this.scope.register([], 'ArrowRight', keyDownHandler);
        this.scope.register([], 'Enter', keyDownHandler);
        for (let i = 1; i <= 9; i++) {
            this.scope.register([], i.toString(), keyDownHandler);
        }
        for (let i = 0; i < 9; i++) { // A-I
            this.scope.register([], String.fromCharCode(65 + i), keyDownHandler);
        }

        // Cleanup handled by Modal's onClose automatically if using this.scope.register
        // Original onClose logic for saving partial progress:
        const originalOnClose = this.onClose;
        this.onClose = () => {
            originalOnClose.call(this);
            if (!this.session.completed && this.session.answers.length > 0) {
                // Session was closed prematurely but some answers were given
                this.session.completedAt = Date.now();
                this.calculateScore(); // Calculate score based on answers so far
                this.plugin.mcqService.saveMCQSession(this.session);
                void this.plugin.savePluginData();
                if (this.onCompleteCallback) {
                    // Indicate it was not fully completed if onCompleteCallback expects a 'completed' flag
                    this.onCompleteCallback(this.notePath, this.session.score, false);
                }
            } else if (!this.session.completed && this.onCompleteCallback) {
                // Closed before any answers or completion
                this.onCompleteCallback(this.notePath, 0, false);
            }
        };
    }

    displayCurrentQuestion(containerEl: HTMLElement): void {
        const questionIndex = this.session.currentQuestionIndex;
        if (questionIndex >= this.mcqSet.questions.length) {
            this.completeSession();
            return;
        }
        const question = this.mcqSet.questions[questionIndex];
        if (!question || !question.choices || question.choices.length < 2) {
            new Notice('Error: Invalid question data. Moving to next question.');
            this.session.currentQuestionIndex++;
            if (this.session.currentQuestionIndex < this.mcqSet.questions.length) {
                this.displayCurrentQuestion(containerEl);
            } else {
                this.completeSession();
            }
            return;
        }

        const existingQuestionContainer = containerEl.querySelector('.mcq-question-container');
        if (existingQuestionContainer) existingQuestionContainer.remove();
        const newQuestionContainer = containerEl.createDiv('mcq-question-container');
        const questionEl = newQuestionContainer.createDiv('mcq-question-text');
        questionEl.setText(question.question);

        const existingAnswer = this.session.answers.find(a => a.questionIndex === questionIndex);
        if (existingAnswer && existingAnswer.attempts >= 2) {
            const skipContainer = newQuestionContainer.createDiv('mcq-skip-container');
            const skipButton = skipContainer.createEl('button', { text: 'Show answer & continue', cls: 'mcq-skip-button' });
            skipButton.addEventListener('click', () => {
                const correctIndex = question.correctAnswerIndex;
                const correctAnswerDisplay = newQuestionContainer.createDiv('mcq-correct-answer-display');
                const correctLabel = correctAnswerDisplay.createDiv({ cls: 'sf-mcq-correct-label' });
                correctLabel.setText('Correct answer:');
                const correctText = correctAnswerDisplay.createDiv({ cls: 'sf-mcq-correct-text' });
                correctText.setText(String.fromCharCode(65 + correctIndex) + ') ' + question.choices[correctIndex]);

                if (existingAnswer) {
                    existingAnswer.selectedAnswerIndex = -1;
                    existingAnswer.correct = false;
                    existingAnswer.attempts += 1;
                } else {
                    this.session.answers.push({
                        questionIndex,
                        selectedAnswerIndex: -1,
                        correct: false,
                        timeToAnswer: (Date.now() - this.questionStartTime) / 1000,
                        attempts: 3
                    });
                }

                const continueBtn = correctAnswerDisplay.createEl('button', {
                    text: 'Continue to next question',
                    cls: 'mcq-continue-button'
                });
                continueBtn.addEventListener('click', () => {
                    this.session.currentQuestionIndex++;
                    this.questionStartTime = Date.now();
                    const { contentEl } = this;
                    const progressEl = contentEl.querySelector('.mcq-progress');
                    if (progressEl instanceof HTMLElement) progressEl.textContent = `Question ${this.session.currentQuestionIndex + 1} of ${this.mcqSet.questions.length}`;
                    if (this.session.currentQuestionIndex < this.mcqSet.questions.length) {
                        this.displayCurrentQuestion(contentEl);
                    } else {
                        this.completeSession();
                    }
                });
                const choicesContainer = this.contentEl.querySelector('.mcq-choices-container'); // Use this.contentEl
                if (choicesContainer instanceof HTMLElement) choicesContainer.classList.add('sf-hidden'); // Use CSS class for hiding
                skipButton.classList.add('sf-hidden'); // Use CSS class for hiding
            });
        }

        const choicesContainer = newQuestionContainer.createDiv('mcq-choices-container');
        question.choices.forEach((choice, index) => {
            const choiceEl = choicesContainer.createDiv('mcq-choice');
            const choiceBtn = choiceEl.createEl('button', { cls: 'mcq-choice-btn' });
            const letterLabel = choiceBtn.createSpan('mcq-choice-letter'); letterLabel.setText(String.fromCharCode(65 + index) + ') ');
            const textSpan = choiceBtn.createSpan('mcq-choice-text'); textSpan.setText(choice || '(Empty choice)');
            const shortcutHint = choiceBtn.createSpan('mcq-shortcut-hint');
            shortcutHint.setText(`${String.fromCharCode(65 + index)} or ${index + 1}`);
            choiceBtn.addEventListener('click', () => this.handleAnswer(index));
        });
        this.selectedAnswerIndex = -1;
    }

    handleAnswer(selectedIndex: number): void {
        const questionIndex = this.session.currentQuestionIndex;
        const question = this.mcqSet.questions[questionIndex];
        const isCorrect = selectedIndex === question.correctAnswerIndex;
        const timeToAnswer = (Date.now() - this.questionStartTime) / 1000;
        const existingAnswerIndex = this.session.answers.findIndex(a => a.questionIndex === questionIndex);
        let answer: MCQAnswer;

        if (existingAnswerIndex >= 0) {
            answer = this.session.answers[existingAnswerIndex];
            if (isCorrect) { answer.selectedAnswerIndex = selectedIndex; answer.correct = true; }
            answer.timeToAnswer = timeToAnswer; answer.attempts += 1;
            if (answer.attempts >= 2 && !answer.correct) {
                answer.selectedAnswerIndex = -1; // Mark as failed but eventually correct
            }
        } else {
            answer = { questionIndex, selectedAnswerIndex: isCorrect ? selectedIndex : -1, correct: isCorrect, timeToAnswer, attempts: 1 };
            this.session.answers.push(answer);
        }

        this.highlightAnswer(selectedIndex, isCorrect);
        window.setTimeout(() => {
            if (isCorrect) {
                this.session.currentQuestionIndex++;
                this.questionStartTime = Date.now();
                const { contentEl } = this;
                const progressEl = contentEl.querySelector('.mcq-progress');
                if (progressEl instanceof HTMLElement) progressEl.textContent = `Question ${this.session.currentQuestionIndex + 1} of ${this.mcqSet.questions.length}`;
                const newProgressPercent = Math.round(((this.session.currentQuestionIndex + 1) / this.mcqSet.questions.length) * 100);
                contentEl.setAttribute('data-progress', newProgressPercent.toString());
                if (this.session.currentQuestionIndex < this.mcqSet.questions.length) {
                    this.displayCurrentQuestion(contentEl);
                } else {
                    this.completeSession();
                }
            }
        }, 1000);
    }

    highlightAnswer(selectedIndex: number, isCorrect: boolean): void {
        const choiceButtons = this.contentEl.querySelectorAll('.mcq-choice-btn'); // Use this.contentEl
        choiceButtons.forEach(button => button.classList.remove('mcq-choice-correct', 'mcq-choice-incorrect', 'mcq-choice-selected'));
        if (selectedIndex < choiceButtons.length) {
            const selectedBtn = choiceButtons[selectedIndex] as HTMLElement;
            selectedBtn.classList.add(isCorrect ? 'mcq-choice-correct' : 'mcq-choice-incorrect');
        }
    }

    completeSession(): void {
        const { contentEl } = this;
        contentEl.empty();
        try {
            this.calculateScore();
            this.session.completed = true;
            this.session.completedAt = Date.now();
            // Save via mcqService
            this.plugin.mcqService.saveMCQSession(this.session);
            void this.plugin.savePluginData(); // Persist

            new Setting(contentEl).setName('Review complete').setHeading();
            const scoreEl = contentEl.createDiv('mcq-score');
            const scoreTextEl = scoreEl.createDiv('mcq-score-text');
            const scorePercentage = this.session.score; // Score is 0-1

            const reviewSchedule = this.plugin.reviewScheduleService.schedules[this.notePath];
            let ratingText = '';
            let ratingDetails = '';

            if (reviewSchedule?.schedulingAlgorithm === 'fsrs') {
                let fsrsRating = 1; // Default to Again
                if (scorePercentage === 1.0) fsrsRating = 4; // Easy - only if perfect
                else if (scorePercentage >= 0.75) fsrsRating = 3; // Good
                else if (scorePercentage >= 0.50) fsrsRating = 2; // Hard
                // else fsrsRating remains 1 (Again) for scores < 0.50
                ratingText = `FSRS Rating: ${getFsrsRatingText(fsrsRating)} (${fsrsRating}/4)`;
                if (reviewSchedule.fsrsData) {
                    const fsrs = reviewSchedule.fsrsData;
                    ratingDetails += `Stability: ${fsrs.stability.toFixed(2)}, Difficulty: ${fsrs.difficulty.toFixed(2)}, Interval: ${fsrs.scheduled_days}d, State: ${mapFsrsStateToString(fsrs.state)}, Reps: ${fsrs.reps}, Lapses: ${fsrs.lapses}`;
                    if (fsrs.last_review) {
                        const nextDueDate = new Date(fsrs.last_review);
                        nextDueDate.setDate(nextDueDate.getDate() + fsrs.scheduled_days);
                        ratingDetails += `, Next Due: ${nextDueDate.toLocaleDateString()}`;
                    }
                }
            } else if (reviewSchedule?.schedulingAlgorithm === 'sm2') {
                let sm2Rating = 0;
                if (scorePercentage >= 0.90) sm2Rating = 5; // Perfect Recall
                else if (scorePercentage >= 0.80) sm2Rating = 4; // Correct With Hesitation
                else if (scorePercentage >= 0.60) sm2Rating = 3; // Correct With Difficulty
                else if (scorePercentage >= 0.40) sm2Rating = 2; // Incorrect But Familiar
                else if (scorePercentage >= 0.20) sm2Rating = 1; // Incorrect Response
                // else sm2Rating = 0; // Complete Blackout (default)
                ratingText = `SM-2 Rating: ${getSm2RatingText(sm2Rating)} (${sm2Rating}/5)`;
                if (reviewSchedule) {
                    ratingDetails += `Ease: ${(reviewSchedule.ease / 100).toFixed(2)}, Interval: ${reviewSchedule.interval}d, Next Due: ${new Date(reviewSchedule.nextReviewDate).toLocaleDateString()}`;
                    if (reviewSchedule.repetitionCount !== undefined) ratingDetails += `, Reps: ${reviewSchedule.repetitionCount}`;
                }
            } else {
                // Fallback if no schedule or unknown algorithm
                ratingText = `Score: ${Math.round(scorePercentage * 100)}%`;
            }

            scoreTextEl.setText(ratingText);
            if (ratingDetails) {
                const detailsEl = scoreEl.createDiv('mcq-score-details');
                detailsEl.setText(ratingDetails);
            }

            // Removed the old score indicator text (🎯 Excellent, etc.)

            const resultsEl = contentEl.createDiv('mcq-results');
            new Setting(resultsEl).setHeading().setName('Question results');
            if (this.session.answers.length === 0) {
                resultsEl.createDiv({ cls: 'mcq-no-answers', text: 'No questions were answered in this session.' });
            } else {
                this.session.answers.forEach(answer => {
                    try {
                        const question = this.mcqSet.questions[answer.questionIndex];
                        if (!question || !question.choices) return;
                        const resultItem = resultsEl.createDiv('mcq-result-item');
                        resultItem.createDiv({ cls: 'mcq-result-question', text: question.question || 'Question text missing' });
                        if (answer.attempts > 1) {
                            if (answer.selectedAnswerIndex !== -1) {
                                const yourAnswer = resultItem.createDiv('mcq-result-your-answer');
                                yourAnswer.createSpan({ cls: 'mcq-result-label', text: 'Your final answer (correct after multiple attempts): ' });
                                yourAnswer.createSpan({ cls: 'mcq-result-correct', text: question.choices[answer.selectedAnswerIndex] || '(invalid choice)' });
                            } else {
                                const yourAnswer = resultItem.createDiv('mcq-result-your-answer');
                                yourAnswer.createSpan({ cls: 'mcq-result-label', text: 'Your answer: ' });
                                yourAnswer.createSpan({ cls: 'mcq-result-incorrect', text: '(Incorrect - used "Show Answer" option)' });
                            }
                            const correctAnswer = resultItem.createDiv('mcq-result-correct-answer');
                            correctAnswer.createSpan({ cls: 'mcq-result-label', text: 'Correct answer: ' });
                            correctAnswer.createSpan({ cls: 'mcq-result-correct', text: question.choices[question.correctAnswerIndex] || '(invalid choice)' });
                        } else {
                            const yourAnswer = resultItem.createDiv('mcq-result-your-answer');
                            yourAnswer.createSpan({ cls: 'mcq-result-label', text: 'Your answer: ' });
                            yourAnswer.createSpan({ cls: answer.correct ? 'mcq-result-correct' : 'mcq-result-incorrect', text: question.choices[answer.selectedAnswerIndex] || '(invalid choice)' });
                            if (!answer.correct) {
                                const correctAnswer = resultItem.createDiv('mcq-result-correct-answer');
                                correctAnswer.createSpan({ cls: 'mcq-result-label', text: 'Correct answer: ' });
                                correctAnswer.createSpan({ cls: 'mcq-result-correct', text: question.choices[question.correctAnswerIndex] || '(invalid choice)' });
                            }
                        }
                        resultItem.createDiv({ cls: 'mcq-result-attempts', text: `Attempts: ${answer.attempts}` });
                        resultItem.createDiv({ cls: 'mcq-result-time', text: `Time: ${Math.round(answer.timeToAnswer)} seconds` });

                        // FSRS/SM-2 data per question removed from here
                    } catch { /* Error displaying answer result: ${error} */ }
                });
            }
            const closeBtn = contentEl.createEl('button', { cls: 'mcq-close-btn', text: 'Close' });
            closeBtn.addEventListener('click', () => {
                if (this.onCompleteCallback) {
                    // Pass the actual score and completion status
                    this.onCompleteCallback(this.notePath, this.session.score, true);
                }
                this.close();
            });
        } catch {
            new Setting(contentEl).setName('Error completing session').setHeading();
            contentEl.createEl('p', { text: 'There was an error completing the MCQ session. Please try again.' });
            const errorCloseBtn = contentEl.createEl('button', { cls: 'mcq-close-btn', text: 'Close' });
            errorCloseBtn.addEventListener('click', () => this.close());
        }
    }

    calculateScore(): void {
        let totalScore = 0;
        this.session.answers.forEach(answer => {
            let questionScore = 0;

            if (this.plugin.settings.mcqDeductFullMarkOnFirstFailure) {
                // With this setting, you only get points if you're correct on the first try.
                if (answer.attempts === 1 && answer.correct) {
                    questionScore = 1.0;
                } else {
                    questionScore = 0; // 0 for multiple attempts or for a single incorrect attempt.
                }
            } else {
                // Original scoring logic
                if (answer.correct && answer.selectedAnswerIndex !== -1) {
                    if (answer.attempts === 1) {
                        questionScore = 1.0;
                    } else if (answer.attempts === 2) {
                        questionScore = 0.5;
                    }
                }
            }

            // Apply time deduction only if points were scored.
            if (questionScore > 0 && answer.timeToAnswer > this.plugin.settings.mcqTimeDeductionSeconds) {
                questionScore -= this.plugin.settings.mcqTimeDeductionAmount;
                questionScore = Math.max(0, questionScore);
            }
            totalScore += questionScore;
        });
        this.session.score = this.mcqSet.questions.length > 0 ? totalScore / this.mcqSet.questions.length : 0;
    }

    // onClose is now handled by the keyboard shortcut registration cleanup
}

// Helper function to map FSRS state number to a string
function mapFsrsStateToString(state: number): string {
    switch (state) {
        case 0: return "New";
        case 1: return "Learning";
        case 2: return "Review";
        case 3: return "Relearning";
        default: return "Unknown";
    }
}

// Helper function to map FSRS rating number to text
function getFsrsRatingText(rating: number): string {
    switch (rating) {
        case 1: return "Again";
        case 2: return "Hard";
        case 3: return "Good";
        case 4: return "Easy";
        default: return "Unknown";
    }
}

// Helper function to map SM-2 rating number to text
function getSm2RatingText(rating: number): string {
    switch (rating) {
        case 0: return "Complete blackout";
        case 1: return "Incorrect response";
        case 2: return "Incorrect but familiar";
        case 3: return "Correct with difficulty";
        case 4: return "Correct with hesitation";
        case 5: return "Perfect recall";
        default: return "Unknown";
    }
}