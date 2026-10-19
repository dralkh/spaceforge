import { Notice, TFile } from 'obsidian';
import SpaceforgePlugin from '../main';
import { MCQModal } from '../ui/mcq-modal';
import { ConsolidatedMCQModal } from '../ui/consolidated-mcq-modal'; // Import ConsolidatedMCQModal
import { MCQSet, MCQSession } from '../models/mcq';
import { ReviewSchedule, ReviewResponse, FsrsRating } from '../models/review-schedule'; // Import rating enums and ReviewSchedule
import { MCQService } from '../services/mcq-service';
import { IMCQGenerationService } from '../api/mcq-generation-service';
import { mapScoreToFsrsRating, mapScoreToSm2Response } from '../utils/rating';

/**
 * Controller for managing Multiple-Choice Question (MCQ) reviews
 */
export class MCQController {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /**
     * Reference to the MCQ data service
     */
    private mcqService: MCQService;

    /**
     * Reference to the MCQ generation service (e.g., OpenRouter, OpenAI)
     */
    private mcqGenerationService: IMCQGenerationService;

    /**
     * Initialize MCQ controller
     * 
     * @param plugin Reference to the main plugin
     * @param mcqService Reference to the MCQ data service
     * @param mcqGenerationService Reference to the MCQ generation service
     */
    constructor(plugin: SpaceforgePlugin, mcqService: MCQService, mcqGenerationService: IMCQGenerationService) {
        this.plugin = plugin;
        this.mcqService = mcqService;
        this.mcqGenerationService = mcqGenerationService;
    }

    /**
     * Start an MCQ review session for a note
     * 
     * @param notePath Path to the note
     * @param onCompleteCallback Optional callback when the modal closes
     */
    // Helper methods to map score to ratings (shared with the Study feature so
    // the two cannot drift apart in what a given score means).
    private mapScoreToSm2Response(score: number): ReviewResponse {
        return mapScoreToSm2Response(score);
    }

    private mapScoreToFsrsRating(score: number): FsrsRating {
        return mapScoreToFsrsRating(score);
    }

    /**
     * Question sets being prepared right now, one promise per note.
     *
     * The dock's panel and this controller's own window path both ask for a
     * note's questions, and they can ask in the same breath: two simultaneous
     * preparations would write two sets and leave two surfaces showing a
     * different set of questions. Concurrent callers share the first promise.
     */
    private mcqSetRequests = new Map<string, Promise<MCQSet | null>>();

    /**
     * The questions for a note, writing a set when there is none (or when the
     * existing one was flagged for regeneration).
     *
     * Split out of startMCQReview so a docked sitting can ask for the set
     * without anything opening a window over the note.
     *
     * Safe to call concurrently: N callers for one note get one preparation.
     */
    async ensureMcqSetForNote(notePath: string): Promise<MCQSet | null> {
        const inFlight = this.mcqSetRequests.get(notePath);
        if (inFlight) return inFlight;

        const request = this.prepareMcqSetForNote(notePath);
        const settle = (): void => {
            // Cleared when it settles, success or failure, so a retry after an
            // error starts a fresh preparation instead of joining a finished
            // one.
            if (this.mcqSetRequests.get(notePath) === request) this.mcqSetRequests.delete(notePath);
        };
        void request.then(settle, settle);
        this.mcqSetRequests.set(notePath, request);
        return request;
    }

    /** The actual preparation; the shared promise ensureMcqSetForNote() hands out. */
    private async prepareMcqSetForNote(notePath: string): Promise<MCQSet | null> {
        if (!this.plugin.settings.enableMCQ || !this.mcqGenerationService) {
            new Notice('Feature is disabled or the generation service is not available. Check API provider settings.');
            return null;
        }

        let mcqSet = this.mcqService.getMCQSetForNote(notePath);

        if (mcqSet && mcqSet.needsQuestionRegeneration) {
            new Notice('Questions flagged for regeneration. Generating new set...');
            mcqSet = await this.generateMCQs(notePath, true);
            if (mcqSet) {
                mcqSet.needsQuestionRegeneration = false;
                this.mcqService.saveMCQSet(mcqSet);
                await this.plugin.savePluginData();
            } else {
                new Notice('Failed to regenerate. Using existing set if available.');
                mcqSet = this.mcqService.getMCQSetForNote(notePath);
            }
        }

        if (!mcqSet || mcqSet.questions.length === 0) {
            new Notice('No questions found. Generating new set...');
            mcqSet = await this.generateMCQs(notePath);
        }

        return mcqSet ?? null;
    }

    async startMCQReview(
        notePath: string,
        // Keep the external callback signature for now, but we'll use an internal one for our logic
        externalOnCompleteCallback?: (path: string, success: boolean) => void
    ): Promise<void> {
        if (!this.plugin.settings.enableMCQ) {
            new Notice('Feature is disabled in settings.');
            if (externalOnCompleteCallback) externalOnCompleteCallback(notePath, false);
            return;
        }
        if (!this.mcqGenerationService) {
            new Notice('Generation service is not available. Check API provider settings.');
            return;
        }

        try {
            const mcqSet = await this.ensureMcqSetForNote(notePath);
            if (!mcqSet) {
                new Notice('Failed to generate questions.');
                return;
            }

            // Define the internal callback for MCQModal that includes the score
            const internalOnComplete = (path: string, score: number, completed: boolean) => {
                void (async () => {
                    if (completed && this.plugin.settings.mcqGradingMode === 'ask') {
                        // The score is the sitting's to report; the grade is the
                        // learner's to give. Nothing is recorded here — the
                        // docked bar offers the grades next to the score.
                        new Notice(`MCQs complete: ${(score * 100).toFixed(0)}% — grade it from the review bar.`);
                        if (externalOnCompleteCallback) externalOnCompleteCallback(path, score >= 0.7);
                        return;
                    }
                    if (completed) {
                        const schedule = this.plugin.reviewScheduleService.schedules[path];
                        if (schedule) {
                            let rating: ReviewResponse | FsrsRating;
                            const ratingKind = schedule.schedulingAlgorithm === 'fsrs' ? 'fsrs' as const : 'auto' as const;
                            if (schedule.schedulingAlgorithm === 'fsrs') {
                                rating = this.mapScoreToFsrsRating(score);
                                new Notice(`MCQ complete for FSRS card.Score: ${(score * 100).toFixed(0)}%.Rating: ${FsrsRating[rating]} (${rating as number}).`);
                            } else {
                                rating = this.mapScoreToSm2Response(score);
                                new Notice(`MCQ complete for SM - 2 card.Score: ${(score * 100).toFixed(0)}%.Rating: ${ReviewResponse[rating]} (${rating as number}).`);
                            }
                            // Process the review using the determined rating
                            await this.plugin.reviewController.processReviewResponse(path, rating, { ratingKind, navigate: false });
                        } else {
                            new Notice(`MCQ complete.Score: ${(score * 100).toFixed(0)}%.Could not find schedule to update review status.`);
                        }
                    } else {
                        new Notice(`MCQ session for ${path} was not fully completed.Score(partial): ${(score * 100).toFixed(0)}%.Review not recorded.`);
                    }

                    // Call the original external callback if it was provided
                    if (externalOnCompleteCallback) {
                        externalOnCompleteCallback(path, completed && score >= 0.7);
                    }
                })();
            };

            // Pass the new internal callback to the modal constructor
            new MCQModal(this.plugin, notePath, mcqSet, internalOnComplete).open();
        } catch {
            new Notice('Error starting review. Please check console for details.');
            if (externalOnCompleteCallback) externalOnCompleteCallback(notePath, false);
        }
    }

    /**
     * Generate MCQs for a note
     * 
     * @param notePath Path to the note
     * @param forceRegeneration If true, will ignore existing fresh sets and generate new ones.
     * @returns Generated MCQ set or null if failed
     */
    async generateMCQs(notePath: string, forceRegeneration = false): Promise<MCQSet | null> {
        if (!this.plugin.settings.enableMCQ || !this.mcqGenerationService) {
            new Notice('Feature is disabled or the generation service is not available. Check API provider settings.');
            return null;
        }

        if (!forceRegeneration) {
            const existingSet = this.mcqService.getMCQSetForNote(notePath);
            if (existingSet) {
                const twentyFourHours = 24 * 60 * 60 * 1000;
                if ((Date.now() - existingSet.generatedAt) < twentyFourHours && !existingSet.needsQuestionRegeneration) {
                    new Notice('Using recently generated MCQs for this note.');
                    return existingSet;
                }
            }
        }

        const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) {
            new Notice('Cannot generate MCQs: file not found');
            return null;
        }
        const content = await this.plugin.app.vault.read(file);

        const mcqSet = await this.mcqGenerationService.generateMCQs(notePath, content, this.plugin.settings);

        if (mcqSet) {
            this.mcqService.saveMCQSet(mcqSet);
            await this.plugin.savePluginData();
            new Notice('MCQs generated and saved successfully.');
            return mcqSet;
        } else {
            return null;
        }
    }

    // Methods to access MCQ sessions, delegated to mcqService
    getMCQSessionsForNote(notePath: string): MCQSession[] {
        return this.mcqService.getMCQSessionsForNote(notePath);
    }

    getLatestMCQSessionForNote(notePath: string): MCQSession | null {
        return this.mcqService.getLatestMCQSessionForNote(notePath);
    }

    async saveMCQSession(session: MCQSession): Promise<void> {
        this.mcqService.saveMCQSession(session);
        await this.plugin.savePluginData();
    }

    /**
     * Starts a consolidated MCQ review session for all notes due on the currently selected review date.
     */
    async startConsolidatedMCQReviewForSelectedDate(): Promise<void> {
        if (!this.plugin.settings.enableMCQ) {
            new Notice('Feature is disabled in settings.');
            return;
        }
        if (!this.mcqGenerationService) {
            new Notice('Generation service is not available. Check API provider settings.');
            return;
        }

        const dueNotes: ReviewSchedule[] = this.plugin.reviewController.getTodayNotes();

        if (dueNotes.length === 0) {
            new Notice('No notes due for review on the selected date.');
            return;
        }

        const mcqSetsForReview: { path: string; mcqSet: MCQSet; fileName: string }[] = [];
        let notesWithMCQsCount = 0;

        new Notice(`Fetching questions for ${dueNotes.length} due note(s)...`);

        for (const noteSchedule of dueNotes) {
            const notePath = noteSchedule.path;
            let mcqSet = this.mcqService.getMCQSetForNote(notePath);

            // If MCQ set needs regeneration, attempt to regenerate it.
            if (mcqSet && mcqSet.needsQuestionRegeneration) {
                new Notice(`Regenerating flagged questions for ${notePath}...`);
                const regeneratedMcqSet = await this.generateMCQs(notePath, true); // forceRegeneration = true
                if (regeneratedMcqSet) {
                    mcqSet = regeneratedMcqSet; // Use the new set
                    mcqSet.needsQuestionRegeneration = false; // Clear the flag
                    this.mcqService.saveMCQSet(mcqSet);
                    // Overall plugin data save will happen once after the loop
                } else {
                    new Notice(`Failed to regenerate questions for ${notePath}. Using existing set if available (might be outdated or empty).`);
                    // mcqSet remains the old one, or null if it didn't exist.
                }
            }

            // If no MCQ set exists after potential regeneration, or if it's empty, try to generate one.
            if (!mcqSet || mcqSet.questions.length === 0) {
                new Notice(`No questions found or set is empty for ${notePath}. Attempting to generate new set...`);
                const newMcqSet = await this.generateMCQs(notePath, false); // forceRegeneration = false (respects cache if fresh)
                if (newMcqSet) {
                    mcqSet = newMcqSet;
                } else {
                    new Notice(`Failed to generate questions for ${notePath}. This note will be skipped.`);
                }
            }

            if (mcqSet && mcqSet.questions.length > 0) {
                const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
                mcqSetsForReview.push({
                    path: notePath,
                    mcqSet,
                    fileName: file instanceof TFile ? file.basename : notePath,
                });
                notesWithMCQsCount++;
            }
        }

        if (mcqSetsForReview.length === 0) {
            new Notice('No questions available for the due notes.');
            return;
        }

        await this.plugin.savePluginData(); // Save any changes from MCQ generation

        new Notice(`Starting consolidated review for ${notesWithMCQsCount} note(s) with ${mcqSetsForReview.reduce((sum, s) => sum + s.mcqSet.questions.length, 0)} questions.`);

        const onConsolidatedComplete = (
            results: Array<{ path: string; success: boolean; response: ReviewResponse; score?: number }>
        ) => {
            void (async () => {
                let reviewsProcessed = 0;
                for (const result of results) {
                    const schedule = this.plugin.reviewScheduleService.schedules[result.path];
                    if (schedule && typeof result.score === 'number') {
                        let rating: ReviewResponse | FsrsRating;
                        const ratingKind = schedule.schedulingAlgorithm === 'fsrs' ? 'fsrs' as const : 'auto' as const;
                        if (schedule.schedulingAlgorithm === 'fsrs') {
                            rating = this.mapScoreToFsrsRating(result.score);
                            new Notice(`MCQ for ${result.path}(FSRS) - Score: ${(result.score * 100).toFixed(0)}%, Rating: ${FsrsRating[rating]} (${rating as number})`);
                        } else { // SM-2
                            rating = this.mapScoreToSm2Response(result.score);
                            new Notice(`MCQ for ${result.path}(SM - 2) - Score: ${(result.score * 100).toFixed(0)}%, Rating: ${ReviewResponse[rating]} (${rating as number})`);
                        }
                        await this.plugin.reviewController.processReviewResponse(result.path, rating, { ratingKind });
                        reviewsProcessed++;
                    }
                }
                if (reviewsProcessed > 0) {
                    new Notice(`${reviewsProcessed} note review(s) updated based on consolidated MCQ session.`);
                } else {
                    new Notice("No reviews updated.");
                }
            })();
        };

        new ConsolidatedMCQModal(this.plugin, mcqSetsForReview, onConsolidatedComplete).open();
    }
}
