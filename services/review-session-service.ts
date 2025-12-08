import { Notice, TFolder } from 'obsidian';
import { ReviewSession, ReviewSessionStore, generateSessionId, getNextFileInSession, advanceSession, isSessionComplete } from '../models/review-session';
import SpaceforgePlugin from '../main';
import { LinkAnalyzer } from '../utils/link-analyzer';

/**
 * Handles management of review sessions
 */
export class ReviewSessionService {
    /**
     * Reference to the main plugin
     */
    private plugin: SpaceforgePlugin;

    /**
     * Review sessions store (This will be a reference to the reviewSessions object in DataStorage)
     */
    reviewSessions: ReviewSessionStore;

    /**
     * Initialize Review Session Service
     *
     * @param plugin Reference to the main plugin
     * @param reviewSessions Reference to the reviewSessions object in DataStorage
     */
    constructor(plugin: SpaceforgePlugin, reviewSessions: ReviewSessionStore) {
        this.plugin = plugin;
        this.reviewSessions = reviewSessions; // Store reference to the shared reviewSessions object
    }

    /**
     * Create a new review session for a folder
     *
     * @param folderPath Path to the folder
     * @param name Name for the session
     * @returns Created review session or null if failed
     */
    async createReviewSession(folderPath: string, name: string): Promise<ReviewSession | null> {
        const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);

        if (!folder || !(folder instanceof TFolder)) {
            new Notice("Invalid folder for review session");
            return null;
        }

        try {
            // Analyze the folder to create a hierarchy
            const includeSubfolders = this.plugin.settings.includeSubfolders;
            const hierarchy = await LinkAnalyzer.analyzeFolder(
                this.plugin.app.vault,
                folder,
                includeSubfolders
            );

            // Generate a unique ID for the session
            const id = generateSessionId(folder.name);

            // Create the session
            const session: ReviewSession = {
                id,
                name: name || folder.name,
                path: folderPath,
                hierarchy,
                currentIndex: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                isActive: false
            };

            // Add to sessions store (using the shared reviewSessions object)
            this.reviewSessions.sessions[id] = session;

            // Data saving is now handled by main.ts after this method returns

            // Notify of update
            if (this.plugin.events) {
                this.plugin.events.emit('sidebar-update');
            }

            return session;
        } catch {
            new Notice("Failed to create review session");
            return null;
        }
    }

    /**
     * Set the active review session
     *
     * @param sessionId ID of the session to activate
     * @returns Whether the session was activated
     */
    setActiveSession(sessionId: string | null): boolean {
        if (sessionId === null) {
            this.reviewSessions.activeSessionId = null;
            // Data saving is now handled by main.ts after this method returns

            if (this.plugin.events) {
                this.plugin.events.emit('sidebar-update');
            }

            return true;
        }

        const session = this.reviewSessions.sessions[sessionId];
        if (!session) {
            return false;
        }

        // Update active session (using the shared reviewSessions object)
        this.reviewSessions.activeSessionId = sessionId;

        // Mark the session as active
        session.isActive = true;
        session.updatedAt = Date.now();

        // Data saving is now handled by main.ts after this method returns

        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update');
        }

        return true;
    }

    /**
     * Get the active review session
     *
     * @returns Active review session or null if none
     */
    getActiveSession(): ReviewSession | null {
        const id = this.reviewSessions.activeSessionId;
        if (!id) {
            return null;
        }

        return this.reviewSessions.sessions[id] || null;
    }

    /**
     * Get the next file to review in the active session
     *
     * @returns Path to the next file or null if done
     */
    getNextSessionFile(): string | null {
        const session = this.getActiveSession();
        if (!session) {
            return null;
        }

        return getNextFileInSession(session);
    }

    /**
     * Advance to the next file in the active session
     *
     * @returns Whether there are more files to review
     */
    advanceActiveSession(): boolean {
        const session = this.getActiveSession();
        if (!session) {
            return false;
        }

        // Update the session (using the shared reviewSessions object)
        const updatedSession = advanceSession(session);
        this.reviewSessions.sessions[session.id] = updatedSession;

        // If the session is complete, deactivate it
        if (isSessionComplete(updatedSession)) {
            updatedSession.isActive = false;
            this.reviewSessions.activeSessionId = null;

            // Show completion notification
            new Notice(`Completed review session: ${updatedSession.name}`);
        }

        // Data saving is now handled by main.ts after this method returns

        if (this.plugin.events) {
            this.plugin.events.emit('sidebar-update');
        }

        return !isSessionComplete(updatedSession);
    }

    /**
     * Schedule all files in a session for review
     * (This method depends on ReviewScheduleService, will need to pass it in or access via plugin)
     *
     * @param sessionId ID of the session
     * @returns Number of files scheduled
     */
    scheduleSessionForReview(sessionId: string): number {
        const session = this.reviewSessions.sessions[sessionId];
        if (!session) {
            return 0;
        }

        // Access ReviewScheduleService via plugin reference
        if (!this.plugin.reviewScheduleService) {
            return 0;
        }

        // Call the method on the ReviewScheduleService instance
        return this.plugin.reviewScheduleService.scheduleNotesInOrder(session.hierarchy.traversalOrder);
    }
}
