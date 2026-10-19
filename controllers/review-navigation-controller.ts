import { Notice, TFile } from 'obsidian';
import SpaceforgePlugin from '../main';
import { IReviewNavigationController } from './interfaces';

/**
 * Walk the due list when nobody is sitting — the fallback half of navigation.
 *
 * A live review run *is* the navigation state: its queue and cursor are the one
 * remembered position, and the sidebar list's Previous/Next, the bar's Skip and
 * a press on a note row all read and move that one place. So this controller
 * asks the run to take the step whenever a run is walking (see
 * {@link ReviewFlowController.stepForward} / `stepBack`), and keeps the
 * original due-list walk for the moments where there is no run at all — which
 * is still the common case for a reader skimming a list that is not a sitting.
 *
 * The public methods are unchanged, so the palette commands, the sidebar's
 * session menu and the list's own buttons all inherit the unified behaviour
 * without knowing about it.
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
            void reviewController.updateTodayNotes();
            if (todayNotes.length === 0) {
                if (this.plugin.settings.showNavigationNotifications) new Notice("No notes due for review today!");
                return;
            }
        }

        const note = todayNotes[currentNoteIndex];
        await this.openNoteWithoutReview(note.path);
    }

    /**
     * Navigate to the next note following the current order.
     *
     * While a run is walking, "the current order" is the run's own queue and
     * this takes the very step the bar's Skip takes — one cursor, so the list
     * and the dock can never be showing two different notes. With no run
     * walking it is the due list's own circular walk, exactly as before.
     */
    async navigateToNextNote(): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        const run = this.plugin.reviewFlowController;
        const fromRun = run ? run.currentPath() : null;
        if (run && await run.stepForward()) {
            const path = run.currentPath();
            if (path) {
                const position = run.runPosition();
                this.announceStep(this.describeStep(fromRun, path, 'next'), position.index, position.total);
            }
            return;
        }

        const todayNotes = reviewController.getTodayNotes();
        const currentNoteIndex = reviewController.getCurrentNoteIndex();

        if (todayNotes.length === 0) {
            // Force update notes regardless of custom order
            void reviewController.updateTodayNotes(false);
            if (todayNotes.length === 0) {
                if (this.plugin.settings.showNavigationNotifications) new Notice("No notes due for review today!");
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
        const nextPath = todayNotes[nextIndex].path;

        // Update core controller current index
        reviewController.setCurrentNoteIndex(nextIndex);

        // Navigate to the note
        await this.openNoteWithoutReview(nextPath);

        this.announceStep(
            this.describeStep(todayNotes[currentNoteIndex].path, nextPath, 'next'),
            nextIndex,
            todayNotes.length
        );
    }

    /**
     * Navigate to the next note without recording a review
     * Uses the same traversal logic as navigateToNextNote
     */
    async navigateToNextNoteWithoutRating(): Promise<void> {
        // Whichever walk takes the step, it is taken once: with a run walking,
        // that is the run's own step, and the bar then opens on the note the
        // run's cursor landed on rather than on a due-list guess.
        const run = this.plugin.reviewFlowController;
        const fromRun = run ? run.currentPath() : null;
        if (run && await run.stepForward()) {
            const path = run.currentPath();
            if (path) {
                const position = run.runPosition();
                this.announceStep(this.describeStep(fromRun, path, 'next'), position.index, position.total);
                this.plugin.reviewController.openDockedReview(path);
            }
            return;
        }

        // First navigate to the next note
        await this.navigateToNextNote();

        // Then automatically open the review modal for the next note
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        const todayNotes = reviewController.getTodayNotes();
        const currentNoteIndex = reviewController.getCurrentNoteIndex();

        if (todayNotes.length > 0) {
            const nextNote = todayNotes[currentNoteIndex];
            reviewController.openDockedReview(nextNote.path);
        }
    }

    /**
     * Navigate to the previous note in the current order.
     *
     * With a run walking, that order is the run's queue: the cursor steps back
     * one place and nothing is un-handled, so a look-back never resurrects a
     * note the sitting has already passed. Without a run it is the due list's
     * own circular walk, exactly as before.
     */
    async navigateToPreviousNote(): Promise<void> {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return;

        const run = this.plugin.reviewFlowController;
        const fromRun = run ? run.currentPath() : null;
        if (run && await run.stepBack()) {
            const path = run.currentPath();
            if (path) {
                const position = run.runPosition();
                this.announceStep(this.describeStep(fromRun, path, 'previous'), position.index, position.total);
            }
            return;
        }

        const todayNotes = reviewController.getTodayNotes();
        const currentNoteIndex = reviewController.getCurrentNoteIndex();

        if (todayNotes.length === 0) {
            // Check for custom order when updating notes
            const hasCustomOrder = this.plugin.reviewScheduleService.customNoteOrder.length > 0;
            void reviewController.updateTodayNotes(hasCustomOrder);
            if (todayNotes.length === 0) {
                if (this.plugin.settings.showNavigationNotifications) new Notice("No notes due for review today!");
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
        const prevPath = todayNotes[prevIndex].path;

        // Update core controller current index
        reviewController.setCurrentNoteIndex(prevIndex);

        // Navigate to the note
        await this.openNoteWithoutReview(prevPath);

        this.announceStep('previous note', prevIndex, todayNotes.length);
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
        this.plugin.reviewScheduleService.updateCustomNoteOrder(newOrder);
        await this.plugin.savePluginData(); // Add save call

        // Force refresh the core controller state
        void reviewController.updateTodayNotes(true);

        // Debug log
    }
    /**
     * A step in the reader's own terms: a next note, a linked note, a move
     * within a folder or out of one. Previous has always read as just
     * "previous note", and it still does.
     */
    private describeStep(fromPath: string | null, toPath: string, direction: 'next' | 'previous'): string {
        if (direction === 'previous') return 'previous note';
        const currentFile = fromPath ? this.plugin.app.vault.getAbstractFileByPath(fromPath) : null;
        const nextFile = this.plugin.app.vault.getAbstractFileByPath(toPath);
        if (!(currentFile instanceof TFile) || !(nextFile instanceof TFile)) return 'next note';
        const currentFolder = currentFile.parent ? currentFile.parent.path : null;
        const nextFolder = nextFile.parent ? nextFile.parent.path : null;
        if (this.plugin.sessionController?.getDueLinkedNotes(currentFile.path).includes(toPath)) {
            return 'linked note';
        }
        return currentFolder === nextFolder ? 'next note in folder' : 'next note in different folder';
    }

    /**
     * Say where the reader landed, and fire the optional follow-up command.
     *
     * One place for both walks, so a step the run took and a step the due list
     * took read identically: same wording, same position, same settings.
     */
    private announceStep(description: string, index: number, total: number): void {
        if (this.plugin.settings.showNavigationNotifications && total > 0) {
            new Notice(`Navigated to ${description} (${index + 1}/${total})`);
        }
        if (this.plugin.settings.enableNavigationCommands && this.plugin.settings.navigationCommand.key) {
            window.setTimeout(() => this.executeCommand(), this.plugin.settings.navigationCommandDelay);
        }
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
