import { MCQSet, MCQSession } from '../models/mcq';

/**
 * Handles management of Multiple-Choice Question (MCQ) data
 */
export class MCQService {
    /**
     * MCQ sets indexed by ID (notePath_timestamp) (This will be a reference to the mcqSets object in DataStorage)
     */
    mcqSets: Record<string, MCQSet>;

    /**
     * MCQ sessions by note path (This will be a reference to the mcqSessions object in DataStorage)
     */
    mcqSessions: Record<string, MCQSession[]>;

    /**
     * Initialize MCQ Service
     *
     * @param mcqSets Reference to the mcqSets object in DataStorage
     * @param mcqSessions Reference to the mcqSessions object in DataStorage
     */
    constructor(mcqSets: Record<string, MCQSet>, mcqSessions: Record<string, MCQSession[]>) {
        this.mcqSets = mcqSets; // Store reference to the shared mcqSets object
        this.mcqSessions = mcqSessions; // Store reference to the shared mcqSessions object
    }

    /**
     * Save an MCQ set
     *
     * @param mcqSet MCQ set to save
     * @returns The ID of the saved MCQ set
     */
    saveMCQSet(mcqSet: MCQSet): string {
        const id = `${mcqSet.notePath}_${mcqSet.generatedAt}`;
        this.mcqSets[id] = mcqSet;
        // Data saving is now handled by main.ts after this method returns
        return id;
    }

    /**
     * Get the latest MCQ set for a note
     *
     * @param notePath Path to the note
     * @returns MCQ set or null if none exists
     */
    getMCQSetForNote(notePath: string): MCQSet | null {
        try {
            // Verify parameters
            if (!notePath) {
                console.error('Invalid notePath provided to getMCQSetForNote');
                return null;
            }

            // Make sure we have mcqSets initialized
            if (!this.mcqSets) {
                console.warn('mcqSets not initialized');
                this.mcqSets = {};
                return null;
            }

            // Find the latest MCQ set for this note
            const sets = Object.values(this.mcqSets)
                .filter(set => set && set.notePath === notePath)
                .sort((a, b) => b.generatedAt - a.generatedAt);

            // Verify the set is valid before returning
            if (sets.length > 0 && sets[0].questions && sets[0].questions.length > 0) {
                return sets[0];
            } else if (sets.length > 0) {
                console.warn('Found MCQ set but it contains no valid questions:', sets[0]);
            }

            return null;
        } catch (error) {
            console.error('Error in getMCQSetForNote:', error);
            return null;
        }
    }

    /**
     * Save an MCQ session
     *
     * @param session MCQ session to save
     */
    saveMCQSession(session: MCQSession): void {
        try {
            // Validate session
            if (!session || !session.notePath || !session.mcqSetId) {
                console.error('Invalid MCQ session data:', session);
                return;
            }

            // Initialize sessions array if it doesn't exist
            if (!this.mcqSessions) {
                this.mcqSessions = {};
            }

            if (!this.mcqSessions[session.notePath]) {
                this.mcqSessions[session.notePath] = [];
            }

            // Update if exists, add if new
            const existingIndex = this.mcqSessions[session.notePath].findIndex(
                s => s && s.mcqSetId === session.mcqSetId && s.startedAt === session.startedAt
            );

            if (existingIndex >= 0) {
                this.mcqSessions[session.notePath][existingIndex] = session;
            } else {
                this.mcqSessions[session.notePath].push(session);
            }

            // Limit the number of stored sessions per note (keep the most recent 10)
            if (this.mcqSessions[session.notePath].length > 10) {
                this.mcqSessions[session.notePath].sort((a, b) => b.startedAt - a.startedAt);
                this.mcqSessions[session.notePath] = this.mcqSessions[session.notePath].slice(0, 10);
            }

            // Data saving is now handled by main.ts after this method returns
        } catch (error) {
            console.error('Error saving MCQ session:', error);
        }
    }

    /**
     * Get all MCQ sessions for a note
     *
     * @param notePath Path to the note
     * @returns Array of MCQ sessions
     */
    getMCQSessionsForNote(notePath: string): MCQSession[] {
        return this.mcqSessions[notePath] || [];
    }

    /**
     * Get the latest MCQ session for a note
     *
     * @param notePath Path to the note
     * @returns Latest MCQ session or null
     */
    getLatestMCQSessionForNote(notePath: string): MCQSession | null {
        const sessions = this.getMCQSessionsForNote(notePath)
            .sort((a, b) => b.startedAt - a.startedAt);

        return sessions.length > 0 ? sessions[0] : null;
    }

    /**
     * Flags an MCQ set for regeneration.
     * This is typically called when a note's review rating meets certain criteria.
     *
     * @param notePath Path to the note whose MCQ set should be flagged.
     */
    flagMCQSetForRegeneration(notePath: string): void {
        const mcqSet = this.getMCQSetForNote(notePath);
        if (mcqSet) {
            mcqSet.needsQuestionRegeneration = true;
            this.saveMCQSet(mcqSet); // Updates the in-memory reference; persistence handled by caller
            console.log(`MCQSet for ${notePath} flagged for regeneration.`);
        } else {
            console.log(`No MCQSet found for ${notePath} to flag for regeneration.`);
        }
    }
}
