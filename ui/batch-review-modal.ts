import { App, Modal, Notice, TFile, Setting } from 'obsidian';
import SpaceforgePlugin from '../main';
import { ReviewResponse, ReviewSchedule } from '../models/review-schedule';
import { MCQSet } from '../models/mcq';
import { EstimationUtils } from '../utils/estimation';
import { sleep } from '../utils/sleep';
import { ConsolidatedMCQModal } from './consolidated-mcq-modal'; // Import ConsolidatedMCQModal

/**
 * Modal for batch reviewing multiple notes
 */
export class BatchReviewModal extends Modal {
    plugin: SpaceforgePlugin;
    notes: ReviewSchedule[];
    useMCQ: boolean;
    currentIndex = 0;
    results: Array<{
        path: string,
        success: boolean,
        response: ReviewResponse,
        score?: number
    }> = [];
    started = false;
    allMCQSets: {
        path: string;
        mcqSet: MCQSet;
        fileName: string;
    }[] = [];
    collectingMCQs = false;

    constructor(
        app: App,
        plugin: SpaceforgePlugin,
        notes: ReviewSchedule[],
        useMCQ = false
    ) {
        super(app);
        this.plugin = plugin;
        this.notes = notes;
        this.useMCQ = useMCQ;
    }

    onOpen(): void {
        const { contentEl } = this;
        this.renderStartScreen(contentEl);
    }

    renderStartScreen(contentEl: HTMLElement): void {
        contentEl.empty();
        new Setting(contentEl).setName("Batch review").setHeading();
        const infoEl = contentEl.createDiv("batch-review-info");
        infoEl.createEl("p", { text: `${this.notes.length} notes scheduled for review` });
        void this.estimateAndShowTime(infoEl); // Explicitly ignore promise to satisfy linter
        const buttonsEl = contentEl.createDiv("batch-review-buttons");
        const startButton = buttonsEl.createEl("button", {
            text: this.useMCQ ? "Start MCQ review" : "Start manual review",
            cls: "batch-review-start-button"
        });
        startButton.addEventListener("click", () => {
            void this.startBatchReview();
        });
        const toggleMCQButton = buttonsEl.createEl("button", {
            text: this.useMCQ ? "Switch to manual review" : "Switch to MCQ review",
            cls: "batch-review-toggle-button"
        });
        toggleMCQButton.addEventListener("click", () => {
            this.useMCQ = !this.useMCQ;
            this.renderStartScreen(contentEl);
        });
        if (this.useMCQ) {
            const regenerateButton = buttonsEl.createEl("button", {
                text: "Regenerate all MCQs",
                cls: "batch-review-regenerate-button"
            });
            regenerateButton.addEventListener("click", () => {
                this.close();
                if (this.plugin.batchController) {
                    void this.plugin.batchController.regenerateAllMCQs();
                }
            });
        }
        const cancelButton = buttonsEl.createEl("button", { text: "Cancel", cls: "batch-review-cancel-button" });
        cancelButton.addEventListener("click", () => this.close());
    }

    async estimateAndShowTime(containerEl: HTMLElement): Promise<void> {
        let totalTime = 0;
        for (const note of this.notes) {
            totalTime += await this.plugin.dataStorage.estimateReviewTime(note.path);
        }
        if (this.useMCQ) {
            totalTime += this.notes.length * 15; // Estimate for MCQ generation
        }
        containerEl.createEl("p", { text: `Estimated time: ${EstimationUtils.formatTime(totalTime)}`, cls: "batch-review-time" });
    }

    async startBatchReview(): Promise<void> {
        this.started = true;
        if (this.useMCQ) {
            this.collectingMCQs = true;
            await this.collectAllMCQs();
            if (this.allMCQSets.length > 0) {
                this.showConsolidatedMCQUI();
            } else {
                new Notice("Could not generate any MCQs. Falling back to manual review.");
                await this.processNextManual();
            }
        } else {
            await this.processNextManual();
        }
    }

    async collectAllMCQs(): Promise<void> {
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl).setName("Collecting MCQs").setHeading();
        const progressEl = contentEl.createDiv("batch-review-progress");
        progressEl.createEl("p", { text: `Preparing MCQs for ${this.notes.length} notes...` });
        const progressBar = contentEl.createDiv("mcq-collection-progress sf-progress-bar-container-batch");
        const progressFill = progressBar.createDiv({ cls: "sf-progress-bar-fill-batch" });
        const statusEl = contentEl.createDiv("batch-review-status");
        this.allMCQSets = [];

        for (let i = 0; i < this.notes.length; i++) {
            const note = this.notes[i];
            const file = this.plugin.app.vault.getAbstractFileByPath(note.path);
            const fileName = file instanceof TFile ? file.basename : note.path;
            progressFill.style.width = `${((i + 1) / this.notes.length) * 100}%`;
            statusEl.setText(`Processing ${i + 1}/${this.notes.length}: ${fileName}`);
            await sleep(10);

            let mcqSet = this.plugin.dataStorage.getMCQSetForNote(note.path);
            // Use mcqGenerationService instead of openRouterService
            if (!mcqSet && this.plugin.mcqGenerationService && this.plugin.mcqController) {
                statusEl.setText(`Generating MCQs for ${i + 1}/${this.notes.length}: ${fileName}...`);
                try {
                    // generateMCQs now returns the set or null
                    mcqSet = await this.plugin.mcqController.generateMCQs(note.path);
                } catch {
                    statusEl.setText(`Error generating MCQs for ${fileName}`);
                    await sleep(1000);
                }
            }
            if (mcqSet) {
                this.allMCQSets.push({ path: note.path, mcqSet, fileName });
            }
        }
        statusEl.setText(`Collected MCQs for ${this.allMCQSets.length}/${this.notes.length} notes`);
        await sleep(1000);
        this.collectingMCQs = false;
    }

    showConsolidatedMCQUI(): void {
        if (this.allMCQSets.length === 0) {
            this.showSummary();
            return;
        }
        if (this.plugin.mcqController) {
            try {
                this.close();
                const consolidatedModal = new ConsolidatedMCQModal(
                    this.plugin,
                    this.allMCQSets,
                    (results: Array<{ path: string, success: boolean, response: ReviewResponse, score?: number }>) => {
                        this.results = results;
                        this.recordAllReviews(results);
                        this.open();
                        this.showSummary();
                    }
                );
                consolidatedModal.open();
            } catch {
                new Notice("Error showing MCQ review. Falling back to manual review.");
                this.open();
                void this.processNextManual();
            }
        } else {
            new Notice("MCQ controller not available. Falling back to manual review.");
            this.open();
            void this.processNextManual();
        }
    }

    recordAllReviews(results: Array<{ path: string, success: boolean, response: ReviewResponse, score?: number }>): void {
        for (const result of results) {
            this.plugin.dataStorage.recordReview(result.path, result.response);
        }
    }

    // This method is likely unused now due to the consolidated modal approach, but kept for reference/potential fallback
    async processNextMCQ(): Promise<void> {
        if (this.currentIndex >= this.notes.length) {
            this.showSummary();
            return;
        }
        const note = this.notes[this.currentIndex];
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl).setName("MCQ review in progress").setHeading();
        const progressEl = contentEl.createDiv("batch-review-progress");
        progressEl.createEl("p", { text: `Processing note ${this.currentIndex + 1}/${this.notes.length}` });
        const file = this.plugin.app.vault.getAbstractFileByPath(note.path);
        const fileName = file instanceof TFile ? file.basename : note.path;
        progressEl.createEl("p", { text: `Current note: ${fileName}`, cls: "batch-review-current-note" });

        this.close(); // Close this modal to open the individual MCQ modal

        if (this.plugin.mcqController) {
            let mcqSet = this.plugin.dataStorage.getMCQSetForNote(note.path);
            // Use mcqGenerationService instead of openRouterService
            if (!mcqSet && this.plugin.mcqGenerationService) {
                new Notice(`Generating MCQs for ${fileName}...`);
                mcqSet = await this.plugin.mcqController.generateMCQs(note.path);
            }

            if (mcqSet) {
                // Update the call to startMCQReview - remove the callback argument
                void this.plugin.mcqController.startMCQReview(note.path /* Removed callback */);
                // NOTE: The logic to handle the result and move to the next note needs to be
                // re-implemented if this flow is used instead of the consolidated modal.
                // The original callback logic is commented out below for reference.
                /*
                , (path: string, success: boolean) => {
                    let response: ReviewResponse;
                    const score = this.getLatestMCQScore(note.path) || 0;
                    if (success) {
                        if (score >= 0.9) response = ReviewResponse.PerfectRecall;
                        else if (score >= 0.7) response = ReviewResponse.CorrectWithHesitation;
                        else response = ReviewResponse.CorrectWithDifficulty;
                    } else {
                        if (score >= 0.4) response = ReviewResponse.IncorrectButFamiliar;
                        else if (score >= 0.2) response = ReviewResponse.IncorrectResponse;
                        else response = ReviewResponse.CompleteBlackout;
                    }
                    this.results.push({ path: note.path, success: success, response: response, score: score });
                    this.plugin.dataStorage.recordReview(note.path, response);
                    this.currentIndex++;
                    this.open(); // Reopen this modal
                    this.processNextMCQ(); // Continue
                }
                */
                // Since the callback is removed, we need a way to know when the individual modal closes.
                // This flow is now broken and relies on the consolidated modal.
                // Fallback or error handling might be needed here if consolidated fails.
                this.open(); // Reopen immediately for now, but this won't wait for the MCQ modal.
                this.showSummary(); // Go to summary as the flow is broken.


            } else {
                new Notice(`Couldn't generate MCQs for ${fileName}, falling back to manual review.`);
                this.open();
                void this.processNextManual();
            }
        } else {
            new Notice("MCQ controller not available, falling back to manual review.");
            this.open();
            void this.processNextManual();
        }
    }

    getLatestMCQScore(path: string): number | undefined {
        const session = this.plugin.dataStorage.getLatestMCQSessionForNote(path);
        return session?.score;
    }

    async processNextManual(): Promise<void> {
        if (this.currentIndex >= this.notes.length) {
            this.showSummary();
            return;
        }
        const note = this.notes[this.currentIndex];
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl).setName("Manual review").setHeading();
        const progressEl = contentEl.createDiv("batch-review-progress");
        progressEl.createEl("p", { text: `Note ${this.currentIndex + 1}/${this.notes.length}` });
        const file = this.plugin.app.vault.getAbstractFileByPath(note.path);
        const fileName = file instanceof TFile ? file.basename : note.path;
        progressEl.createEl("p", { text: `Current note: ${fileName}`, cls: "batch-review-current-note" });

        if (this.plugin.navigationController) {
            await this.plugin.navigationController.openNoteWithoutReview(note.path);
        }

        const buttonsContainer = contentEl.createDiv("batch-review-buttons");
        const blackoutButton = buttonsContainer.createEl("button", { text: "0: Complete blackout", cls: "review-button review-button-complete-blackout" });
        blackoutButton.addEventListener("click", () => void this.recordManualResult(note.path, ReviewResponse.CompleteBlackout));
        const incorrectButton = buttonsContainer.createEl("button", { text: "1: Incorrect response", cls: "review-button review-button-incorrect" });
        incorrectButton.addEventListener("click", () => void this.recordManualResult(note.path, ReviewResponse.IncorrectResponse));
        const incorrectFamiliarButton = buttonsContainer.createEl("button", { text: "2: Incorrect but familiar", cls: "review-button review-button-incorrect-familiar" });
        incorrectFamiliarButton.addEventListener("click", () => void this.recordManualResult(note.path, ReviewResponse.IncorrectButFamiliar));
        const correctDifficultyButton = buttonsContainer.createEl("button", { text: "3: Correct with difficulty", cls: "review-button review-button-correct-difficulty" });
        correctDifficultyButton.addEventListener("click", () => void this.recordManualResult(note.path, ReviewResponse.CorrectWithDifficulty));
        const correctHesitationButton = buttonsContainer.createEl("button", { text: "4: Correct with hesitation", cls: "review-button review-button-correct-hesitation" });
        correctHesitationButton.addEventListener("click", () => void this.recordManualResult(note.path, ReviewResponse.CorrectWithHesitation));
        const perfectRecallButton = buttonsContainer.createEl("button", { text: "5: Perfect recall", cls: "review-button review-button-perfect-recall" });
        perfectRecallButton.addEventListener("click", () => void this.recordManualResult(note.path, ReviewResponse.PerfectRecall));
        const skipButton = buttonsContainer.createEl("button", { text: "Skip", cls: "review-button review-button-skip" });
        skipButton.addEventListener("click", () => {
            this.currentIndex++;
            void this.processNextManual();
        });
    }

    recordManualResult(path: string, response: ReviewResponse): void {
        this.results.push({ path, success: response >= ReviewResponse.CorrectWithDifficulty, response }); // Assuming 3+ is success

        // Use the data storage method to get the return value
        const wasRecorded = this.plugin.dataStorage.recordReview(path, response);

        if (!wasRecorded) {
            // Note was not due, this is just a preview
            new Notice("Note previewed, not recorded.");
        }

        this.currentIndex++;
        void this.processNextManual();
    }

    showSummary(): void {
        const { contentEl } = this;
        contentEl.empty();
        new Setting(contentEl).setName('MCQ review complete').setHeading().setClass('mcq-review-complete-header');
        const statsEl = contentEl.createDiv("batch-review-summary-stats");
        const totalNotes = this.results.length;
        const successfulNotes = this.results.filter(r => r.success).length;
        const successRate = totalNotes > 0 ? Math.round((successfulNotes / totalNotes) * 100) : 0;
        statsEl.createEl("p", { text: `Completed: ${totalNotes}/${this.notes.length} notes` });
        statsEl.createEl("p", { text: `Success rate: ${successRate}% (${successfulNotes}/${totalNotes})`, cls: successRate >= 70 ? "batch-review-success" : "batch-review-needs-improvement" });
        const resultsEl = contentEl.createDiv("batch-review-results");
        new Setting(resultsEl).setHeading().setName("Individual results");
        const resultsListEl = resultsEl.createDiv("batch-review-results-list");

        for (const result of this.results) {
            const resultItemEl = resultsListEl.createDiv("batch-review-result-item");
            const file = this.plugin.app.vault.getAbstractFileByPath(result.path);
            const fileName = file instanceof TFile ? file.basename : result.path;
            resultItemEl.createEl("div", { text: fileName, cls: "batch-review-result-filename" });
            let responseText: string; let responseClass: string;
            switch (result.response) {
                case ReviewResponse.CompleteBlackout: responseText = "Complete Blackout (0)"; responseClass = "batch-review-complete-blackout"; break;
                case ReviewResponse.IncorrectResponse: responseText = "Incorrect Response (1)"; responseClass = "batch-review-incorrect"; break;
                case ReviewResponse.IncorrectButFamiliar: responseText = "Incorrect but Familiar (2)"; responseClass = "batch-review-incorrect-familiar"; break;
                case ReviewResponse.CorrectWithDifficulty: responseText = "Correct with Difficulty (3)"; responseClass = "batch-review-correct-difficulty"; break;
                case ReviewResponse.CorrectWithHesitation: responseText = "Correct with Hesitation (4)"; responseClass = "batch-review-correct-hesitation"; break;
                case ReviewResponse.PerfectRecall: responseText = "Perfect Recall (5)"; responseClass = "batch-review-perfect-recall"; break;
                default: responseText = "Unknown"; responseClass = "";
            }
            resultItemEl.createEl("div", { text: responseText, cls: `batch-review-result-response ${responseClass}` });
            if (result.score !== undefined) {
                resultItemEl.createEl("div", { text: `MCQ Score: ${Math.round(result.score * 100)}%`, cls: "batch-review-result-mcq-score" });
            }
        }
        const closeButton = contentEl.createEl("button", { text: "Close", cls: "batch-review-close-button" });
        closeButton.addEventListener("click", () => {
            this.close();
            void this.plugin.getSidebarView()?.refresh();
        });
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
        if (this.started && this.currentIndex < this.notes.length && this.results.length > 0) {
            new Notice(`Batch review interrupted after ${this.results.length} notes.`);
        }
    }
}
