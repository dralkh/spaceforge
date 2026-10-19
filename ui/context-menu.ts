import { Menu, Notice, TFile, TFolder, TAbstractFile } from "obsidian";
import { isDeckPath } from '../models/anki';
import SpaceforgePlugin from "../main";
import { LinkAnalyzer } from "../utils/link-analyzer";
import { ConfirmationModal } from "./confirmation-modal";

/**
 * Handles context menu integration
 */
export class ContextMenuHandler {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /**
     * Initialize context menu handler
     *
     * @param plugin Reference to the main plugin
     */
    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    /**
     * Register context menu handlers
     */
    register(): void {
        // Register for the 'file-menu' event, which handles both files and folders.
        this.plugin.registerEvent(
            this.plugin.app.workspace.on("file-menu", (menu: Menu, abstractFile: TAbstractFile) => {
                this.handleFileMenuEvent(menu, abstractFile);
            })
        );
    }

    /**
     * Handles the 'file-menu' event for TAbstractFile (could be TFile or TFolder).
     *
     * @param menu Context menu
     * @param abstractFile Target file or folder
     */
    handleFileMenuEvent(menu: Menu, abstractFile: TAbstractFile): void {
        if (abstractFile instanceof TFolder) {
            // Handle folder context menu
            this.addFolderMenuItems(menu, abstractFile);
        } else if (abstractFile instanceof TFile && abstractFile.extension === "md") {
            // Handle markdown file context menu
            this.addFileMenuItems(menu, abstractFile);
        }
    }

    /**
     * Adds context menu items for a TFile.
     *
     * @param menu Context menu
     * @param file Target file
     */
    private addFileMenuItems(menu: Menu, file: TFile): void {
        // Check if the file is already scheduled using the service
        const isScheduled = !!this.plugin.reviewScheduleService.schedules[file.path];

        menu.addItem((item) => {
            item.setTitle(isScheduled ? "Update review schedule" : "Add to review schedule")
                .setIcon("calendar-plus")
                .onClick(async () => {
                    this.plugin.reviewScheduleService.scheduleNoteForReview(file.path);
                    await this.plugin.savePluginData();
                    // Chart it now, in the background, so the Study panel is
                    // ready before the learner asks for it.
                    this.plugin.studyChartQueue?.enqueue(file.path);
                });
        });

        if (isScheduled) {
            menu.addItem((item) => {
                item.setTitle("Review now")
                    .setIcon("eye")
                    .onClick(() => this.plugin.reviewController.reviewNote(file.path));
            });

            menu.addItem((item) => {
                item.setTitle("Remove from review")
                    .setIcon("calendar-minus")
                    .onClick(async () => {
                        this.plugin.reviewScheduleService.removeFromReview(file.path);
                        await this.plugin.savePluginData();
                    });
            });
        }

        // Adaptive study: chart, study, or start over on the mastery state.
        if (this.plugin.settings?.studyEnabled !== false && this.plugin.studyController) {
            const badge = this.plugin.studyController.studyBadge(file.path);
            menu.addItem((item) => {
                item.setTitle(badge.hasPlan ? "Study this note" : "Study this note (chart it first)")
                    .setIcon("graduation-cap")
                    .onClick(() => this.plugin.studyController.openStudy(file.path));
            });

            if (badge.hasPlan) {
                menu.addItem((item) => {
                    item.setTitle("Chart again for Study")
                        .setIcon("git-compare")
                        .onClick(() => {
                            void this.plugin.studyController.chartNote(file.path, true);
                        });
                });

                if (badge.due > 0) {
                    menu.addItem((item) => {
                        item.setTitle(`Study ${badge.due} objective${badge.due === 1 ? '' : 's'} due`)
                            .setIcon("alarm-clock")
                            .onClick(() => this.plugin.studyController.openStudy(file.path));
                    });
                }

                menu.addItem((item) => {
                    item.setTitle("Reset Study progress")
                        .setIcon("rotate-ccw")
                        .onClick(() => {
                            new ConfirmationModal(
                                this.plugin.app,
                                'Reset study progress',
                                `Forget everything the tutor has recorded about your mastery of "${file.basename}"? The objectives stay; the progress does not.`,
                                () => {
                                    void this.plugin.studyController.resetProgress(file.path);
                                }
                            ).open();
                        });
                });
            }
        }

        // New item: Add current note's folder to review schedule
        if (file.parent) { // Ensure there is a parent folder
            menu.addItem((item) => {
                item.setTitle("Add note's folder to review schedule")
                    .setIcon("folder-plus") // Using a folder icon
                    .onClick(async () => {
                        if (file.parent) { // Parent already confirmed, but good for safety
                            new Notice(`Adding folder "${file.parent.name}" to review schedule...`);
                            // Ensure file.parent is indeed a TFolder before calling addFolderToReview
                            if (file.parent instanceof TFolder) {
                                await this.addFolderToReview(file.parent); // Call the existing folder logic
                            } else {
                                new Notice("Error: parent is not a folder.");
                            }
                        }
                    });
            });
        }
    }

    /**
     * Adds context menu items for a TFolder.
     *
     * @param menu Context menu
     * @param folder Target folder
     */
    private addFolderMenuItems(menu: Menu, folder: TFolder): void {
        try {
            menu.addItem((item) => {
                item.setTitle("Add folder to review")
                    .setIcon("calendar-plus")
                    .onClick(() => {
                        void this.addFolderToReview(folder);
                    });
            });
        } catch {
            // no-op
        }
    }

    /**
     * Add all markdown files in a folder to the review schedule
     *
     * @param folder Target folder
     */
    async addFolderToReview(folder: TFolder): Promise<void> {

        if (isDeckPath(folder.path)) {
            new Notice('This is the deck folder. Decks are studied from the deck list, not added to the note schedule.');
            return;
        }

        // Show immediate notification
        new Notice(`Analyzing folder structure for "${folder.name}"...`);

        try {
            // Get all markdown files in the folder
            const allFiles = this.plugin.app.vault.getMarkdownFiles().filter(file => {
                // Deck files belong to the deck lane, never to the note schedule.
                if (isDeckPath(file.path)) return false;
                if (this.plugin.settings.includeSubfolders) {
                    // Add trailing slash to ensure we're matching folder path correctly
                    const folderPath = folder.path === "/" ? "/" : `${folder.path}/`;
                    return file.path.startsWith(folderPath);
                } else {
                    // Include only files directly in the folder
                    const parentPath = file.parent ? file.parent.path : "";
                    return parentPath === folder.path;
                }
            });

            if (allFiles.length === 0) {
                new Notice('No notes found in that folder.');
                return;
            }

            // Use the LinkAnalyzer to build a hierarchical structure with consistent main file selection
            // Use the LinkAnalyzer to build a hierarchical structure with consistent main file selection

            // First, identify a potential main file that should be used as the starting point
            let mainFilePath: string | null = null;

            // Priority 1: Check for a file with the same name as the folder
            // This should be the highest priority per the user's requirements
            for (const file of allFiles) {
                const fileName = file.basename.toLowerCase();
                const folderName = folder.name.toLowerCase();

                // Exact match first
                if (fileName === folderName) {
                    mainFilePath = file.path;
                    break;
                }
            }

            // If no exact match, try partial matches or index/main files
            if (!mainFilePath) {
                for (const file of allFiles) {
                    const fileName = file.basename.toLowerCase();
                    const folderName = folder.name.toLowerCase();

                    if (fileName.includes(folderName) ||
                        folderName.includes(fileName) ||
                        fileName === 'index' ||
                        fileName === 'main' ||
                        fileName.includes('index') ||
                        fileName.includes('main')) {
                        mainFilePath = file.path;
                        break;
                    }
                }
            }

            // Priority 2: Check if the active file is in this folder
            if (!mainFilePath) {
                const activeFile = this.plugin.app.workspace.getActiveFile();
                if (activeFile &&
                    activeFile.extension === "md" &&
                    allFiles.some(f => f.path === activeFile.path)) {
                    mainFilePath = activeFile.path;
                }
            }

            const traversalOrder: string[] = [];
            const visited = new Set<string>(); // Global visited set

            const processLinksRecursively = async (path: string) => {
                if (visited.has(path)) {
                    return; // Already processed
                }
                visited.add(path);
                traversalOrder.push(path);

                const links = await LinkAnalyzer.analyzeNoteLinks(
                    this.plugin.app.vault,
                    path,
                    false
                );

                for (const link of links) {
                    const linkFile = this.plugin.app.vault.getAbstractFileByPath(link);
                    if (!(linkFile instanceof TFile) || linkFile.extension !== 'md') {
                        continue;
                    }

                    if (allFiles.some(f => f.path === linkFile.path)) { // Is internal to the overall operation
                        await processLinksRecursively(linkFile.path);
                    } else { // Is external
                        if (!visited.has(linkFile.path)) {
                            visited.add(linkFile.path);
                            traversalOrder.push(linkFile.path);
                        }
                    }
                }
            };

            // If a mainFilePath was identified, process it first.
            if (mainFilePath) {
                await processLinksRecursively(mainFilePath);
            }

            // Then, iterate through all files (sorted for consistency) to catch other branches or unlinked files.
            // This ensures that if mainFilePath didn't cover everything, or if there wasn't one,
            // all top-level items and their linked children within allFiles are processed.
            const sortedAllFiles = [...allFiles].sort((a, b) => a.path.localeCompare(b.path));
            for (const file of sortedAllFiles) {
                if (!visited.has(file.path)) {
                    await processLinksRecursively(file.path);
                }
            }


            // Schedule notes in the traversal order using the service
            const count = this.plugin.reviewScheduleService.scheduleNotesInOrder(traversalOrder);
            if (count > 0) {
                await this.plugin.savePluginData(); // Add save call
            }

            // Show success message
            const startingFileName = traversalOrder.length > 0 ?
                traversalOrder[0].split('/').pop() : "unknown";

            new Notice(`Added ${count} notes from "${folder.name}" to review schedule, starting with ${startingFileName}`);

            // Update today's notes in the review controller using our same methodology
            this.plugin.reviewController.updateTodayNotes();

        } catch {
            new Notice("Error adding folder to review schedule");
        }
    }

    /**
     * Create a hierarchical review session for a folder
     *
     * @param folder Target folder
     */
    async createHierarchicalSession(folder: TFolder): Promise<void> {
        new Notice("Analyzing folder structure and links...");

        // Create a review session for the folder using the service
        const session = await this.plugin.reviewSessionService.createReviewSession(
            folder.path,
            folder.name
        );
        // Save after session creation
        if (session) {
            await this.plugin.savePluginData(); // Add save call
        }

        if (!session) {
            new Notice("Failed to create review session");
            return;
        }

        // Count files in the hierarchy
        const fileCount = session.hierarchy.traversalOrder.length;

        // Activate the session using the service
        this.plugin.reviewSessionService.setActiveSession(session.id);
        await this.plugin.savePluginData(); // Add save call

        // Get the first file to review using the service
        const firstFilePath = this.plugin.reviewSessionService.getNextSessionFile();

        if (firstFilePath) {
            // Also schedule all files in the session for future review using the service
            // scheduleSessionForReview calls scheduleNotesInOrder, which now requires a save call after it completes.
            // We'll add the save call here after scheduleSessionForReview returns.
            const scheduledCount = this.plugin.reviewSessionService.scheduleSessionForReview(session.id);
            if (scheduledCount > 0) {
                await this.plugin.savePluginData(); // Add save call
            }

            // Show success message
            new Notice(`Created hierarchical review session with ${fileCount} files.`);

            // Open the first file for review
            const file = this.plugin.app.vault.getAbstractFileByPath(firstFilePath);
            if (file instanceof TFile) {
                void this.plugin.reviewController.reviewNote(firstFilePath);
            }
        } else {
            new Notice("No files found for review in this folder.");
            // Deactivate session using the service
            this.plugin.reviewSessionService.setActiveSession(null);
            await this.plugin.savePluginData(); // Add save call
        }
    }
}
