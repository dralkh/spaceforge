import { ReviewHierarchy } from "../utils/link-analyzer";

/**
 * Represents a review session for a folder or group of files
 */
export interface ReviewSession {
    /**
     * Unique identifier for the session
     */
    id: string;
    
    /**
     * Name of the session (typically folder name)
     */
    name: string;
    
    /**
     * Path to the folder or starting file
     */
    path: string;
    
    /**
     * Review hierarchy for the session
     */
    hierarchy: ReviewHierarchy;
    
    /**
     * Current position in the traversal order
     */
    currentIndex: number;
    
    /**
     * Timestamp when the session was created
     */
    createdAt: number;
    
    /**
     * Timestamp when the session was last updated
     */
    updatedAt: number;
    
    /**
     * Whether this session is active (being reviewed)
     */
    isActive: boolean;
}

/**
 * Data store for review sessions
 */
export interface ReviewSessionStore {
    /**
     * All review sessions indexed by ID
     */
    sessions: Record<string, ReviewSession>;
    
    /**
     * ID of the currently active session
     */
    activeSessionId: string | null;
}

/**
 * Generate a unique ID for a review session
 * 
 * @param prefix Prefix for the ID
 * @returns Unique ID
 */
export function generateSessionId(prefix = 'session'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get the next file to review in a session
 * 
 * @param session Review session
 * @returns Path to the next file or null if done
 */
export function getNextFileInSession(session: ReviewSession): string | null {
    if (!session.hierarchy.traversalOrder.length) {
        return null;
    }
    
    if (session.currentIndex >= session.hierarchy.traversalOrder.length) {
        return null;
    }
    
    return session.hierarchy.traversalOrder[session.currentIndex];
}

/**
 * Advance to the next file in a session
 * 
 * @param session Review session
 * @returns Updated session
 */
export function advanceSession(session: ReviewSession): ReviewSession {
    return {
        ...session,
        currentIndex: session.currentIndex + 1,
        updatedAt: Date.now(),
    };
}

/**
 * Check if a session is complete
 * 
 * @param session Review session
 * @returns True if the session is complete
 */
export function isSessionComplete(session: ReviewSession): boolean {
    return session.currentIndex >= session.hierarchy.traversalOrder.length;
}
