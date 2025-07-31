import { Notice } from 'obsidian';
import SpaceforgePlugin from '../main';
import { IReviewSessionController } from './interfaces';
import { LinkAnalyzer } from '../utils/link-analyzer';

/**
 * Controller for managing review sessions
 */
export class ReviewSessionController implements IReviewSessionController {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /**
     * Cache of linked notes to improve performance
     */
    private linkedNoteCache: Map<string, string[]> = new Map();

    /**
     * Initialize session controller
     *
     * @param plugin Reference to the main plugin
     */
    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    /**
     * Get linked notes that are due today
     *
     * @param notePath Path of the note to get links from
     * @returns Array of paths to linked notes that are due today
     */
    getDueLinkedNotes(notePath: string): string[] {
        const reviewController = this.plugin.reviewController;
        if (!reviewController) return [];

        const todayNotes = reviewController.getTodayNotes();
        const links = this.linkedNoteCache.get(notePath) || [];
        const duePaths = todayNotes.map(n => n.path);

        // If we don't have links cached, try to analyze them
        if (links.length === 0) {
            this.analyzeNoteLinks(notePath).then(newLinks => {
                if (newLinks.length > 0) {
                    this.linkedNoteCache.set(notePath, newLinks);
                }
            });

            // For now, return an empty array since we're still analyzing
            return [];
        }

        // Filter to only include links to notes that are due today
        return links.filter(link => duePaths.includes(link));
    }

    /**
     * Analyze links in a note and cache the results
     * 
     * @param notePath Path to the note
     * @returns Array of linked note paths
     */
    private async analyzeNoteLinks(notePath: string): Promise<string[]> {
        try {
            // Only use regular wiki links (not embeds) for navigation
            const links = await LinkAnalyzer.analyzeNoteLinks(
                this.plugin.app.vault,
                notePath,
                true // regularOnly = true - only include regular wiki links, not embeds
            );

            // Store in cache for future use
            this.linkedNoteCache.set(notePath, links);
            
            return links;
        } catch (error) {
            console.error(`Error analyzing links for ${notePath}:`, error);
            return [];
        }
    }

    /**
     * Clear the link cache for a specific note or all notes
     * 
     * @param notePath Optional path to clear cache for specific note
     */
    clearLinkCache(notePath?: string): void {
        if (notePath) {
            this.linkedNoteCache.delete(notePath);
        } else {
            this.linkedNoteCache.clear();
        }
    }
}
