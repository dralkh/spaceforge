import { ReviewHistoryItem } from '../models/review-schedule';

/**
 * Handles management of review history data
 */
export class ReviewHistoryService {
    /**
     * Review history (This will be a reference to the history array in DataStorage)
     */
    history: ReviewHistoryItem[];

    /**
     * Initialize Review History Service
     *
     * @param history Reference to the history array in DataStorage
     */
    constructor(history: ReviewHistoryItem[]) {
        this.history = history; // Store reference to the shared history array
    }

    /**
     * Get review history for a specific note
     *
     * @param path Path to the note file
     * @returns Array of review history items for the note
     */
    getNoteHistory(path: string): ReviewHistoryItem[] {
        return this.history
            .filter(item => item.path === path)
            .sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Add a history item (used by ReviewScheduleService)
     * This method is here to centralize history management, even if called from another service.
     *
     * @param item The history item to add
     */
    addHistoryItem(item: ReviewHistoryItem): void {
        this.history.push(item);
        // Trim in place: rebinding would leave every other holder of this array
        // (the schedule service, pluginState) pointing at the old one.
        if (this.history.length > 1000) {
            this.history.splice(0, this.history.length - 1000);
        }
    }
}
