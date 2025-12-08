import { App, Modal, Notice, TFile, setIcon, Setting } from 'obsidian';
import SpaceforgePlugin from '../main';
import { ReviewResponse, FsrsRating } from '../models/review-schedule'; // Added FsrsRating
import { State as FsrsState } from 'ts-fsrs'; // For displaying FSRS state name


/**
 * Modal for reviewing a note
 */
export class ReviewModal extends Modal {
    plugin: SpaceforgePlugin;
    path: string;

    constructor(app: App, plugin: SpaceforgePlugin, path: string) {
        super(app);
        this.plugin = plugin;
        this.path = path;
    }

    onOpen(): void {
        const { contentEl } = this;
        new Setting(contentEl).setName("Review note").setHeading();

        const buttonsContainer = contentEl.createDiv("review-buttons-container");
        const schedule = this.plugin.reviewScheduleService.schedules[this.path];

        if (schedule && schedule.schedulingAlgorithm === 'fsrs') {
            // FSRS Buttons (1-4)
            const createFsrsButton = (text: string, clsSuffix: string, rating: FsrsRating) => {
                const button = buttonsContainer.createEl("button", { text, cls: `review-button review-button-fsrs-${clsSuffix}` });
                button.addEventListener("click", () => {
                    void this.plugin.reviewController.processReviewResponse(this.path, rating);
                    this.close();
                });
            };
            createFsrsButton("1: Again", "again", FsrsRating.Again);
            createFsrsButton("2: Hard", "hard", FsrsRating.Hard);
            createFsrsButton("3: Good", "good", FsrsRating.Good);
            createFsrsButton("4: Easy", "easy", FsrsRating.Easy);
        } else {
            // SM-2 Buttons (0-5) - Default if schedule not found or is SM-2
            const createSm2Button = (text: string, cls: string, response: ReviewResponse) => {
                const button = buttonsContainer.createEl("button", { text, cls });
                button.addEventListener("click", () => {
                    void this.plugin.reviewController.processReviewResponse(this.path, response);
                    this.close();
                });
            };
            createSm2Button("0: Complete blackout", "review-button review-button-complete-blackout", ReviewResponse.CompleteBlackout);
            createSm2Button("1: Incorrect response", "review-button review-button-incorrect", ReviewResponse.IncorrectResponse);
            createSm2Button("2: Incorrect but familiar", "review-button review-button-incorrect-familiar", ReviewResponse.IncorrectButFamiliar);
            createSm2Button("3: Correct with difficulty", "review-button review-button-correct-difficulty", ReviewResponse.CorrectWithDifficulty);
            createSm2Button("4: Correct with hesitation", "review-button review-button-correct-hesitation", ReviewResponse.CorrectWithHesitation);
            createSm2Button("5: Perfect recall", "review-button review-button-perfect-recall", ReviewResponse.PerfectRecall);
        }

        buttonsContainer.createEl("div", { cls: "review-button-separator" });

        // Postpone Button
        const postponeButton = buttonsContainer.createEl("button", { text: "Postpone to tomorrow", cls: "review-button review-button-postpone" });
        postponeButton.addEventListener("click", () => {
            void this.plugin.reviewController.skipReview(this.path); // skipReview handles postponement
            this.close();
        });

        // Skip/Next Button
        const skipButton = buttonsContainer.createEl("button", { text: "Skip/next", cls: "review-button review-button-skip" });
        skipButton.addEventListener("click", () => {
            this.close();
            if (this.plugin.navigationController) {
                void this.plugin.navigationController.navigateToNextNoteWithoutRating();
            }
        });

        // MCQ Buttons (if enabled)
        if (this.plugin.settings.enableMCQ) {
            buttonsContainer.createEl("div", { cls: "review-button-separator" });


            const mcqButton = buttonsContainer.createEl("button", { cls: "review-button review-button-mcq" });
            const mcqIconSpan = mcqButton.createSpan("mcq-button-icon"); setIcon(mcqIconSpan, "mcq-quiz");
            const textSpan = mcqButton.createSpan("mcq-button-text"); textSpan.setText("Test with MCQs"); // eslint-disable-line obsidianmd/ui/sentence-case

            mcqButton.addEventListener("click", () => {
                const mcqController = this.plugin.mcqController;
                if (mcqController) {
                    // Call startMCQReview without the callback
                    void mcqController.startMCQReview(this.path);
                    // The logic for handling completion should ideally be managed elsewhere,
                    // perhaps by observing an event or checking state after the modal closes,
                    // or the MCQModal itself could trigger the review processing upon completion.
                    // For now, we just close this modal.
                    this.close();
                } else {
                    // Attempt to initialize if not available (might happen on first load)
                    this.plugin.initializeMCQComponents();
                    const initializedMcqController = this.plugin.mcqController;
                    if (initializedMcqController) {
                        // Call startMCQReview without the callback
                        void initializedMcqController.startMCQReview(this.path);
                        this.close();
                    } else {
                        new Notice("MCQ feature could not be initialized. Please check settings."); // eslint-disable-line obsidianmd/ui/sentence-case
                    }
                }
            });

            // Refresh MCQ Button (if set exists)
            const mcqController = this.plugin.mcqController;
            if (mcqController && this.plugin.mcqService.getMCQSetForNote(this.path)) {
                const refreshMcqButton = buttonsContainer.createEl("button", { cls: "review-button review-button-mcq-refresh" });
                const refreshIconSpan = refreshMcqButton.createSpan("mcq-button-icon"); setIcon(refreshIconSpan, "refresh-cw");
                const refreshTextSpan = refreshMcqButton.createSpan("mcq-button-text"); refreshTextSpan.setText("Generate new MCQs"); // eslint-disable-line obsidianmd/ui/sentence-case

                refreshMcqButton.addEventListener("click", () => {
                    if (mcqController) {
                        new Notice("Generating new MCQs...");
                        void (async () => {
                            const success = await mcqController.generateMCQs(this.path, true); // Force regeneration
                            if (success) {
                                // Start review with the newly generated MCQs, without callback
                                void mcqController.startMCQReview(this.path);
                                this.close();
                            } else {
                                new Notice("Failed to generate new MCQs.");
                            }
                        })();
                    }
                });
            }
        }

        // Note Info Section
        const infoText = contentEl.createDiv("review-info-text");
        infoText.empty();
        // const schedule = this.plugin.reviewScheduleService.schedules[this.path]; // Already fetched

        if (schedule) {
            const file = this.app.vault.getAbstractFileByPath(this.path);
            const fileName = file instanceof TFile ? file.basename : this.path;
            infoText.createEl("p", { text: `Reviewing: ${fileName}` });

            const activeSession = this.plugin.reviewSessionService.getActiveSession();
            if (activeSession) {
                const currentIndex = activeSession.currentIndex;
                const totalFiles = activeSession.hierarchy.traversalOrder.length;
                infoText.createEl("p", { text: `Session: ${activeSession.name} (${currentIndex + 1}/${totalFiles})`, cls: "review-session-info" });
            }

            if (schedule.lastReviewDate) infoText.createEl("p", { text: `Last reviewed: ${new Date(schedule.lastReviewDate).toLocaleDateString()}` });

            if (schedule.schedulingAlgorithm === 'fsrs' && schedule.fsrsData) {
                infoText.createEl("p", { text: `Algorithm: FSRS`, cls: "review-phase-fsrs" }); // eslint-disable-line obsidianmd/ui/sentence-case
                infoText.createEl("p", { text: `Stability: ${schedule.fsrsData.stability.toFixed(2)}` });
                infoText.createEl("p", { text: `Difficulty: ${schedule.fsrsData.difficulty.toFixed(2)}` });
                infoText.createEl("p", { text: `State: ${FsrsState[schedule.fsrsData.state]}` }); // Display FSRS state name
                infoText.createEl("p", { text: `Interval: ${schedule.fsrsData.scheduled_days} days` });
            } else { // SM-2 or fallback
                infoText.createEl("p", { text: `Algorithm: SM-2`, cls: "review-phase-sm2" }); // eslint-disable-line obsidianmd/ui/sentence-case
                let phaseText: string; let phaseClass: string;
                if (schedule.scheduleCategory === 'initial') {
                    const totalInitialSteps = this.plugin.settings.initialScheduleCustomIntervals.length;
                    const currentStepDisplay = (schedule.reviewCount || 0) < totalInitialSteps ? (schedule.reviewCount || 0) + 1 : totalInitialSteps;
                    phaseText = `Initial phase (${currentStepDisplay}/${totalInitialSteps})`; phaseClass = "review-phase-initial";
                } else if (schedule.scheduleCategory === 'graduated') {
                    phaseText = "Graduated (Spaced Repetition)"; phaseClass = "review-phase-graduated";
                } else { phaseText = "Spaced Repetition"; phaseClass = "review-phase-spaced"; }
                infoText.createEl("p", { text: phaseText, cls: phaseClass });
                infoText.createEl("p", { text: `Current ease: ${schedule.ease}` });
                infoText.createEl("p", { text: `Current interval: ${schedule.interval} days` });
            }
        }
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}
