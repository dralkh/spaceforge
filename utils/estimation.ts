import { TFile } from 'obsidian';
import SpaceforgePlugin from '../main';

/**
 * Utility functions for time estimation
 */
export class EstimationUtils {
    /**
     * Reading speeds for different content types (words per minute)
     * Used as fallback and for content-specific adjustments
     */
    private static readonly READING_SPEEDS = {
        notes: 200,      // General notes
        technical: 100,  // Technical content
        fiction: 250,    // Fiction/prose
        simple: 300      // Simple content
    };

    /**
     * Average English word length in characters (including spaces)
     */
    private static readonly AVG_WORD_LENGTH = 5.5;

    /**
     * Minimum review time in seconds
     */
    private static readonly MIN_REVIEW_TIME = 30;


    /**
     * Reference to the plugin (for access to settings)
     */
    private static plugin: SpaceforgePlugin;

    /**
     * Set the plugin reference
     * 
     * @param plugin Reference to the main plugin
     */
    static setPlugin(plugin: SpaceforgePlugin): void {
        this.plugin = plugin;
    }

    /**
     * Get the user's reading speed from settings
     * 
     * @param contentType Optional content type for adjustment
     * @returns Reading speed in words per minute
     */
    static getReadingSpeed(contentType?: keyof typeof EstimationUtils.READING_SPEEDS): number {
        // Get base reading speed from settings
        const baseSpeed = this.plugin?.settings.readingSpeed || 200;

        // Apply content-specific adjustment if specified
        if (contentType) {
            const baseContentSpeed = this.READING_SPEEDS.notes;
            const contentSpeed = this.READING_SPEEDS[contentType];
            return baseSpeed * (contentSpeed / baseContentSpeed);
        }

        return baseSpeed;
    }

    /**
     * Estimate review time for a file based on its content
     * 
     * @param file The file to estimate review time for
     * @param fileContent Optional file content (to avoid reading file again)
     * @param contentType Type of content for reading speed adjustment
     * @returns Estimated review time in seconds
     */
    static estimateReviewTime(
        file: TFile,
        fileContent?: string,
        contentType: keyof typeof EstimationUtils.READING_SPEEDS = 'notes'
    ): number {
        if (!file) {
            return this.MIN_REVIEW_TIME;
        }

        // Use file size as a rough proxy if content is not available
        if (!fileContent) {
            // Bytes are not minutes. A note of `size` bytes holds about
            // `size / AVG_WORD_LENGTH` words, and words are read at the reader's
            // speed per minute — the old arithmetic divided bytes by 38.5 and
            // called the quotient *minutes*, i.e. seven words a minute, which is
            // how nine notes came to claim fifty-three hours. The arithmetic was
            // the whole bug; nothing about the answer needed truncating.
            const words = Math.max(1, Math.round(file.stat.size / this.AVG_WORD_LENGTH));
            const readingSpeed = this.getReadingSpeed(contentType);
            return this.atLeastOneNote((words / readingSpeed) * 60);
        }

        // Count words in content
        const wordCount = this.countWords(fileContent);

        // Calculate reading time based on words and reading speed
        const readingSpeed = this.getReadingSpeed(contentType);
        const readingTimeMinutes = wordCount / readingSpeed;

        // Add some buffer time for actual review (thinking, interacting)
        return this.atLeastOneNote(readingTimeMinutes * 60);
    }

    /**
     * Floor only. A note is never worth less than the moment it takes to open it,
     * and it is never worth less than its own text: a 400 KB note really is a six
     * hour read, and saying twenty minutes would make every total that contains it
     * wrong. There is no ceiling — the estimate reports, it does not negotiate.
     */
    private static atLeastOneNote(seconds: number): number {
        if (!Number.isFinite(seconds) || seconds <= 0) return this.MIN_REVIEW_TIME;
        return Math.max(this.MIN_REVIEW_TIME, Math.ceil(seconds));
    }

    /**
     * Calculate aggregate review time for multiple notes
     * 
     * @param paths Array of note paths
     * @returns Total estimated review time in seconds
     */
    static async calculateTotalReviewTime(paths: string[]): Promise<number> {
        if (!this.plugin) {
            return paths.length * this.MIN_REVIEW_TIME;
        }

        let totalTime = 0;
        for (const path of paths) {
            totalTime += await this.plugin.dataStorage.estimateReviewTime(path);
        }

        return totalTime;
    }

    /**
     * Count words in text
     * 
     * @param text Text to count words in
     * @returns Number of words
     */
    static countWords(text: string): number {
        // Remove Markdown formatting
        const cleanText = text
            .replace(/```[\s\S]*?```/g, '') // Remove code blocks
            .replace(/`.*?`/g, '') // Remove inline code
            .replace(/\[.*?\]\(.*?\)/g, '') // Remove links
            .replace(/\*\*.*?\*\*/g, '$1') // Bold to plain text
            .replace(/\*.*?\*/g, '$1') // Italic to plain text
            .replace(/~~.*?~~/g, '$1'); // Strikethrough to plain text

        // Count words (sequences of non-whitespace characters)
        const words = cleanText.match(/\S+/g) || [];
        return words.length;
    }

    /**
     * Format seconds as a readable time string
     * 
     * @param seconds Time in seconds
     * @returns Formatted time string (e.g., "5 min" or "1 hr 30 min")
     */
    static formatTime(seconds: number): string {
        const minutes = Math.floor(seconds / 60);

        if (minutes < 60) {
            return `${minutes} min`;
        } else {
            const hours = Math.floor(minutes / 60);
            const remainingMinutes = minutes % 60;

            if (remainingMinutes === 0) {
                return `${hours} hr`;
            } else {
                return `${hours} hr ${remainingMinutes} min`;
            }
        }
    }

    /**
     * Format a time estimate with color coding based on duration
     * 
     * @param seconds Time in seconds
     * @param element HTML element to update
     * @returns Formatted HTML time string with color coding
     */
    static formatTimeWithColor(seconds: number, element: HTMLElement): void {
        const formattedTime = this.formatTime(seconds);
        element.setText(formattedTime);

        // Color code based on duration
        if (seconds < 5 * 60) { // Less than 5 minutes
            element.addClass("review-time-short");
            element.removeClass("review-time-medium");
            element.removeClass("review-time-long");
        } else if (seconds < 15 * 60) { // 5-15 minutes
            element.addClass("review-time-medium");
            element.removeClass("review-time-short");
            element.removeClass("review-time-long");
        } else { // More than 15 minutes
            element.addClass("review-time-long");
            element.removeClass("review-time-short");
            element.removeClass("review-time-medium");
        }
    }
}
