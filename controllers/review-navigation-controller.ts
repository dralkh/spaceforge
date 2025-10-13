import { Notice, TFile } from 'obsidian';
import SpaceforgePlugin from '../main';
import { IReviewNavigationController } from './interfaces';
import { LinkAnalyzer } from '../utils/link-analyzer';
import { DateUtils } from '../utils/dates';

/**
 * Controller for navigating between notes in review
 */
export class ReviewNavigationController implements IReviewNavigationController {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /**
     * Initialize navigation controller
     *
     * @param plugin Reference to the main plugin
     */
    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    /**
     * Navigate to the current note without showing review modal
     */
    async navigateToCurrentNoteWithoutModal(): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        const todayNotes = reviewController.getTodayNotes();
        const currentNoteIndex = reviewController.getCurrentNoteIndex();

        if (todayNotes.length === 0) {
            await reviewController.updateTodayNotes();
            if (todayNotes.length === 0) {
                new Notice("No notes due for review today!");
                return;
            }
        }

        const note = todayNotes[currentNoteIndex];
        await this.openNoteWithoutReview(note.path);
    }

    /**
     * Navigate to the next note following the current order
     */
    async navigateToNextNote(): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        const todayNotes = reviewController.getTodayNotes();
        let currentNoteIndex = reviewController.getCurrentNoteIndex();

        if (todayNotes.length === 0) {
            // Force update notes regardless of custom order
            await reviewController.updateTodayNotes(false);
            if (todayNotes.length === 0) {
                new Notice("No notes due for review today!");
                return;
            }
        }

        if (todayNotes.length === 1) {
            // Only one note, nothing to navigate to
            await this.navigateToCurrentNoteWithoutModal();
            return;
        }

        // Simple circular navigation through todayNotes which already has the correct order
        const nextIndex = (currentNoteIndex + 1) % todayNotes.length;
        const nextNote = todayNotes[nextIndex];
        const nextPath = nextNote.path;

        // Check the traversal order structure
        // Display appropriate message
        let messageType = "next note";

        // Get file information for context message
        const currentFile = this.plugin.app.vault.getAbstractFileByPath(todayNotes[currentNoteIndex].path);
        const nextFile = this.plugin.app.vault.getAbstractFileByPath(nextPath);

        if (currentFile instanceof TFile && nextFile instanceof TFile) {
            const currentFolder = currentFile.parent ? currentFile.parent.path : null;
            const nextFolder = nextFile.parent ? nextFile.parent.path : null;

            if (this.plugin.sessionController && 
                this.plugin.sessionController.getDueLinkedNotes(todayNotes[currentNoteIndex].path).includes(nextPath)) {
                messageType = "linked note";
            } else if (currentFolder === nextFolder) {
                messageType = "next note in folder";
            } else {
                messageType = "next note in different folder";
            }
        }

        // Update core controller current index
        if (this.plugin.reviewController) {
            // Set the index directly in the core controller
            this.plugin.reviewController.setCurrentNoteIndex(nextIndex);
        }

        // Navigate to the note
        await this.openNoteWithoutReview(nextPath);

        if (this.plugin.settings.showNavigationNotifications) {
            new Notice(`Navigated to ${messageType} (${nextIndex + 1}/${todayNotes.length})`);
        }

        if (this.plugin.settings.enableNavigationCommands && this.plugin.settings.navigationCommand.key) {
            window.setTimeout(() => this.executeCommand(), this.plugin.settings.navigationCommandDelay);
        }
    }

    /**
     * Navigate to the next note without recording a review
     * Uses the same traversal logic as navigateToNextNote
     */
    async navigateToNextNoteWithoutRating(): Promise<void> {
        // First navigate to the next note
        await this.navigateToNextNote();

        // Then automatically open the review modal for the next note
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        const todayNotes = reviewController.getTodayNotes();
        const currentNoteIndex = reviewController.getCurrentNoteIndex();

        if (todayNotes.length > 0) {
            const nextNote = todayNotes[currentNoteIndex];
            reviewController.showReviewModal(nextNote.path);
        }
    }

    /**
     * Navigate to the previous note in the current order
     */
    async navigateToPreviousNote(): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        const todayNotes = reviewController.getTodayNotes();
        let currentNoteIndex = reviewController.getCurrentNoteIndex();

        if (todayNotes.length === 0) {
            // Check for custom order when updating notes
            const hasCustomOrder = this.plugin.reviewScheduleService.customNoteOrder.length > 0;
            await reviewController.updateTodayNotes(hasCustomOrder);
            if (todayNotes.length === 0) {
                new Notice("No notes due for review today!");
                return;
            }
        }

        if (todayNotes.length === 1) {
            // Only one note, nothing to navigate to
            await this.navigateToCurrentNoteWithoutModal();
            return;
        }

        // Simple circular navigation through todayNotes which already has the correct order
        const prevIndex = (currentNoteIndex - 1 + todayNotes.length) % todayNotes.length;
        const prevNote = todayNotes[prevIndex];
        const prevPath = prevNote.path;

        // Update core controller current index
        if (this.plugin.reviewController) {
            // Set the index directly in the core controller
            this.plugin.reviewController.setCurrentNoteIndex(prevIndex);
        }

        // Navigate to the note
        await this.openNoteWithoutReview(prevPath);

        if (this.plugin.settings.showNavigationNotifications) {
            new Notice(`Navigated to previous note (${prevIndex + 1}/${todayNotes.length})`);
        }

        if (this.plugin.settings.enableNavigationCommands && this.plugin.settings.navigationCommand.key) {
            window.setTimeout(() => this.executeCommand(), this.plugin.settings.navigationCommandDelay);
        }
    }

    /**
     * Open a note without showing the review modal
     *
     * @param path Path to the note file
     */
    async openNoteWithoutReview(path: string): Promise<void> {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            new Notice("Cannot navigate: file not found");
            return;
        }

        // Open the file without showing review modal
        await this.plugin.app.workspace.getLeaf().openFile(file);
    }

    /**
     * Swap two notes in the traversal order
     *
     * @param path1 Path to the first note
     * @param path2 Path to the second note
     */
    async swapNotes(path1: string, path2: string): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        const todayNotes = reviewController.getTodayNotes();
        let currentNoteIndex = reviewController.getCurrentNoteIndex();

        // Find the indices of these notes in todayNotes
        const index1 = todayNotes.findIndex((n) => n.path === path1);
        const index2 = todayNotes.findIndex((n) => n.path === path2);

        // If either note is not found, do nothing
        if (index1 < 0 || index2 < 0) return;

        // Create a new array with swapped notes
        const newTodayNotes = [...todayNotes];
        const temp = newTodayNotes[index1];
        newTodayNotes[index1] = newTodayNotes[index2];
        newTodayNotes[index2] = temp;

        // Update the custom note order in persistent storage
        const newOrder = newTodayNotes.map(note => note.path);
        await this.plugin.reviewScheduleService.updateCustomNoteOrder(newOrder);
        await this.plugin.savePluginData(); // Add save call

        // Force refresh the core controller state
        await reviewController.updateTodayNotes(true);

        // Debug log
    }
    private executeCommand(): void {
        const command = this.plugin.settings.navigationCommand;
        if (!command || !command.key) return;

        const eventOptions: KeyboardEventInit = {
            key: command.key,
            ctrlKey: command.modifiers.includes('Ctrl'),
            altKey: command.modifiers.includes('Alt'),
            shiftKey: command.modifiers.includes('Shift'),
            metaKey: command.modifiers.includes('Meta'),
            bubbles: true,
            cancelable: true,
        };

        const event = new KeyboardEvent('keydown', eventOptions);
        window.dispatchEvent(event);

    }
}
