/**
 * Utility functions for date operations
 */
export class DateUtils {
    /**
     * Get start of day timestamp for a given date
     * 
     * @param date Date to get start of day for
     * @returns Timestamp for start of day
     */
    static startOfDay(date: Date = new Date()): number {
        const newDate = new Date(date);
        newDate.setHours(0, 0, 0, 0);
        return newDate.getTime();
    }

    /**
     * Add days to a timestamp
     * 
     * @param timestamp Base timestamp
     * @param days Number of days to add
     * @returns New timestamp
     */
    static addDays(timestamp: number, days: number): number {
        return timestamp + (days * 24 * 60 * 60 * 1000);
    }

    /**
     * Format a timestamp as a readable date string
     * 
     * @param timestamp Timestamp to format
     * @param format Format type ('short', 'medium', 'long', 'relative')
     * @param baseDateParam Optional base date for relative formatting
     * @returns Formatted date string
     */
    static formatDate(timestamp: number, format: 'short' | 'medium' | 'long' | 'relative' = 'medium', baseDateParam?: Date | null): string {
        const noteEventDate = new Date(timestamp); // The date of the note/event

        if (format === 'relative') {
            // Determine the reference date for relative calculations

            // Normalize dates to their start of day for accurate day-based comparison
            const normalizedNoteEventDate = this.startOfUTCDay(noteEventDate);
            const normalizedActualCurrentDate = this.startOfUTCDay(new Date()); // Actual current day, for "Due notes"

            // "Due notes" are always relative to the *actual* current day, regardless of baseDateParam
            if (normalizedNoteEventDate < normalizedActualCurrentDate) {
                return 'Due notes';
            }

            // If baseDateParam is set, we are in a calendar view for a specific day.
            // The label for the group of notes (which are all for baseDateParam's day)
            // should reflect how baseDateParam's day relates to the actual current day.
            if (baseDateParam) {
                const normalizedBaseDate = this.startOfUTCDay(new Date(baseDateParam)); // The day being viewed in the calendar

                if (normalizedBaseDate === normalizedActualCurrentDate) {
                    return 'Today'; // e.g., Calendar view is set to actual today
                } else if (normalizedBaseDate === this.startOfUTCDay(new Date(this.addDays(normalizedActualCurrentDate, 1)))) {
                    return 'Tomorrow'; // e.g., Calendar view is set to actual tomorrow
                } else {
                    // Calendar view is set to a specific day that is not actual today or actual tomorrow.
                    // This includes future days beyond tomorrow, or past days (which aren't "Due notes" but >= actualCurrentDate).
                    // Display the specific date of the calendar view.
                    return new Date(normalizedBaseDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                }
            } else {
                // No baseDateParam, so this is the default dashboard view.
                // Comparisons are relative to the actual current date.
                // We already know normalizedNoteEventDate >= normalizedActualCurrentDate from the "Due notes" check.
                const diffInDays = Math.floor((normalizedNoteEventDate - normalizedActualCurrentDate) / (24 * 60 * 60 * 1000));

                if (diffInDays === 0) {
                    return 'Today'; // Note is scheduled for actual today
                } else if (diffInDays === 1) {
                    return 'Tomorrow'; // Note is scheduled for actual tomorrow
                } else { // diffInDays > 1
                    return `In ${diffInDays} days`; // Note is scheduled further in the future
                }
            }
        } else if (format === 'short') {
            return noteEventDate.toLocaleDateString();
        } else if (format === 'long') {
            return noteEventDate.toLocaleDateString(undefined, {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        } else {
            // Medium format (default)
            return noteEventDate.toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric'
            });
        }
    }

    /**
     * Get the day difference between two timestamps
     * 
     * @param timestamp1 First timestamp
     * @param timestamp2 Second timestamp
     * @returns Difference in days
     */
    static dayDifference(timestamp1: number, timestamp2: number): number {
        const date1 = new Date(timestamp1);
        const date2 = new Date(timestamp2);

        // Reset to midnight
        date1.setHours(0, 0, 0, 0);
        date2.setHours(0, 0, 0, 0);

        // Calculate difference in days
        const diffTime = Math.abs(date2.getTime() - date1.getTime());
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        return diffDays;
    }

    /**
     * Get start of UTC day timestamp for a given date
     * 
     * @param date Date to get start of UTC day for
     * @returns Timestamp for start of UTC day (00:00:00.000Z)
     */
    static startOfUTCDay(date: Date = new Date()): number {
        const newDate = new Date(date.getTime()); // Create a new Date object from the timestamp
        newDate.setUTCHours(0, 0, 0, 0);
        return newDate.getTime();
    }

    /**
     * Get end of UTC day timestamp for a given date
     * 
     * @param date Date to get end of UTC day for
     * @returns Timestamp for end of UTC day (23:59:59.999Z)
     */
    static endOfUTCDay(date: Date = new Date()): number {
        const newDate = new Date(date.getTime()); // Create a new Date object from the timestamp
        newDate.setUTCHours(23, 59, 59, 999);
        return newDate.getTime();
    }

    /**
     * Get the day difference between two timestamps based on UTC days
     * 
     * @param timestamp1 First timestamp
     * @param timestamp2 Second timestamp
     * @returns Difference in UTC days
     */
    static dayDifferenceUTC(timestamp1: number, timestamp2: number): number {
        const date1UTCMidnight = this.startOfUTCDay(new Date(timestamp1));
        const date2UTCMidnight = this.startOfUTCDay(new Date(timestamp2));

        // Calculate difference in days
        const diffTime = Math.abs(date2UTCMidnight - date1UTCMidnight);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        return diffDays;
    }

    /**
     * Check if two dates are the same day, ignoring time.
     * @param date1 The first date.
     * @param date2 The second date.
     * @returns True if both dates fall on the same day, false otherwise.
     */
    static isSameDay(date1: Date, date2: Date): boolean {
        return date1.getFullYear() === date2.getFullYear() &&
            date1.getMonth() === date2.getMonth() &&
            date1.getDate() === date2.getDate();
    }
}
