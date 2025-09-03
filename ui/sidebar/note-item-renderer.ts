import { Menu, Notice, TFile, setIcon } from "obsidian";
import SpaceforgePlugin from "../../main";
import { ReviewSchedule } from "../../models/review-schedule";
import { DateUtils } from "../../utils/dates";
import { EstimationUtils } from "../../utils/estimation";

export class NoteItemRenderer {
    private plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    private async _populateNoteItemDetails(
        noteEl: HTMLElement,
        note: ReviewSchedule,
        dateStr: string,
        selectedNotesArray: string[]
    ): Promise<void> {
        noteEl.dataset.notePath = note.path; // Ensure path is set/updated

        // Overdue status
        noteEl.removeClass("overdue-note");
        noteEl.removeAttribute("title");
        if (dateStr === "Due notes") {
            noteEl.addClass("overdue-note");
            const daysOverdue = Math.abs(Math.floor((note.nextReviewDate - DateUtils.startOfDay()) / (24 * 60 * 60 * 1000)));
            const originalDueDate = new Date(note.nextReviewDate).toLocaleDateString();
            noteEl.setAttribute("title", `Originally due: ${originalDueDate} (${daysOverdue} ${daysOverdue === 1 ? 'day' : 'days'} overdue)`);
        }

        // Selected status
        if (selectedNotesArray.includes(note.path)) {
            noteEl.addClass("selected");
        } else {
            noteEl.removeClass("selected");
        }

        // Title
        const titleEl = noteEl.querySelector(".review-note-title") as HTMLElement;
        if (titleEl) {
            const file = this.plugin.app.vault.getAbstractFileByPath(note.path);
            titleEl.setText(file instanceof TFile ? file.basename : note.path);
        }

        const estimatedTime = await this.plugin.reviewScheduleService.estimateReviewTime(note.path);
        const formattedTime = EstimationUtils.formatTime(estimatedTime);

        // Phase and Time
        const phaseEl = noteEl.querySelector(".review-note-phase") as HTMLElement;
        const timeElOld = noteEl.querySelector(".review-note-time") as HTMLElement; // For non-initial
        if (timeElOld) timeElOld.remove(); // Remove old time element if it exists from a previous state

        if (phaseEl) {
            phaseEl.empty(); // Clear previous phase content
            phaseEl.removeClass("review-phase-initial", "review-phase-graduated", "review-phase-spaced");

            if (note.scheduleCategory === 'initial') {
                const totalInitialSteps = this.plugin.settings.initialScheduleCustomIntervals.length;
                const currentStepDisplay = note.reviewCount < totalInitialSteps ? note.reviewCount + 1 : totalInitialSteps;
                phaseEl.createDiv({ title: "Initial", text: "Initial" });
                phaseEl.createDiv({ title: `${currentStepDisplay}/${totalInitialSteps}`, text: `${currentStepDisplay}/${totalInitialSteps}` });
                const phaseTimeEl = phaseEl.createDiv({ cls: "phase-time", title: formattedTime, text: formattedTime });
                phaseEl.addClass("review-phase-initial");
            } else {
                phaseEl.setText(note.scheduleCategory === 'graduated' ? "Graduated" : "Spaced");
                phaseEl.addClass(note.scheduleCategory === 'graduated' ? "review-phase-graduated" : "review-phase-spaced");
                // Create and append new time element for non-initial
                const timeElNew = noteEl.createDiv("review-note-time"); // Create it next to phaseEl or in a specific spot
                noteEl.insertBefore(timeElNew, phaseEl.nextSibling); // Example: insert after phaseEl
                EstimationUtils.formatTimeWithColor(estimatedTime, timeElNew);
            }
        }
        
        // Drag handle visibility (buttons are static, drag handle might change)
        const buttonsEl = noteEl.querySelector(".review-note-buttons") as HTMLElement;
        let dragHandleEl = buttonsEl?.querySelector(".review-note-drag-handle") as HTMLElement;
        if (dragHandleEl) { // If it exists, update its state or recreate if logic is complex
            const isDraggable = (dateStr === 'Due notes' || dateStr === 'Today');
            dragHandleEl.classList.toggle("is-disabled", !isDraggable);
            // Ensure draggable attribute is managed if it was set directly
            if (isDraggable && !dragHandleEl.hasAttribute("draggable")) {
                 // No need to set draggable here, mousedown does it.
            } else if (!isDraggable) {
                noteEl.removeAttribute("draggable"); // Ensure main element is not draggable
            }
        }

        // Advance button state
        const advanceBtn = noteEl.querySelector(".review-note-advance") as HTMLButtonElement | null;
        if (advanceBtn) {
            const todayStartTs = DateUtils.startOfDay(new Date()); // Returns timestamp
            const noteReviewDayStartTs = DateUtils.startOfDay(new Date(note.nextReviewDate)); // Returns timestamp
            const isEligibleForAdvance = noteReviewDayStartTs > todayStartTs;
            advanceBtn.disabled = !isEligibleForAdvance;
            advanceBtn.style.display = isEligibleForAdvance ? '' : 'none';
        }
    }

    public async updateNoteItem(
        noteEl: HTMLElement,
        note: ReviewSchedule,
        dateStr: string,
        selectedNotesArray: string[]
    ): Promise<void> {
        // _populateNoteItemDetails will now also handle the advance button state
        await this._populateNoteItemDetails(noteEl, note, dateStr, selectedNotesArray);
    }

    public async renderNoteItem(
        notesContainer: HTMLElement,
        noteToRender: ReviewSchedule, // Renamed to avoid conflict with 'note' in event handlers
        dateStr: string,
        parentContainerForBulkActions: HTMLElement,
        selectedNotesArray: string[],
        lastSelectedNotePathRef: { current: string | null },
        onSelectionChange: () => void,
        onNoteAction: () => Promise<void>
    ): Promise<HTMLElement> {
        if (!parentContainerForBulkActions) {
            parentContainerForBulkActions = document.body; // Fallback
        }
        const noteEl = notesContainer.createDiv("review-note-item");
        // Basic structure is created here.
        // Data attributes and dynamic content will be set by _populateNoteItemDetails.

        // --- Create Static Structure ---
        const titleEl = noteEl.createDiv({ cls: ["review-note-title", "sf-pointer-cursor"] });

        noteEl.createDiv("review-note-phase"); // Placeholder, content filled by _populate...

        const buttonsEl = noteEl.createDiv("review-note-buttons");
        const actionBtnsEl = buttonsEl.createDiv("review-note-actions");

        // Using icons for buttons
        const reviewBtn = actionBtnsEl.createEl("button", { cls: "review-note-button review-note-review" });
        setIcon(reviewBtn, "play");
        reviewBtn.title = "Review";

        const advanceBtn = actionBtnsEl.createEl("button", { cls: "review-note-button review-note-advance" });
        setIcon(advanceBtn, "arrow-left-circle"); // Or 'chevrons-left', 'skip-back'
        advanceBtn.title = "Advance";
        
        const postponeBtn = actionBtnsEl.createEl("button", { cls: "review-note-button review-note-postpone" });
        setIcon(postponeBtn, "arrow-right-circle"); // Or 'chevrons-right', 'skip-forward'
        postponeBtn.title = "Postpone";

        const removeBtn = actionBtnsEl.createEl("button", { cls: "review-note-button review-note-remove" });
        setIcon(removeBtn, "trash-2");
        removeBtn.title = "Remove";
        
        const dragHandleEl = buttonsEl.createDiv("review-note-drag-handle"); // Create drag handle structure
        dragHandleEl.setAttribute('aria-label', 'Drag to reorder');
        for (let i = 0; i < 3; i++) {
            dragHandleEl.createDiv("drag-handle-line");
        }

        // --- Attach Event Listeners (once) ---
        // Note: these listeners will use 'noteToRender' from the outer scope at the time of creation.
        // If note data within the item needs to be fresh for these handlers, they might need to re-fetch it via noteEl.dataset.notePath
        
        titleEl.addEventListener("click", (e) => {
            e.stopPropagation();
            const path = noteEl.dataset.notePath; // Get current path from element
            if (path) this.plugin.reviewController.openNoteWithoutReview(path);
        });

        reviewBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const path = noteEl.dataset.notePath;
            if (path) {
                await this.plugin.reviewController.reviewNote(path);
                // onNoteAction is often called by the review process itself,
                // but calling here ensures refresh if reviewNote doesn't trigger it.
                await onNoteAction(); 
            }
        });

        advanceBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (advanceBtn.disabled) return;
            const path = noteEl.dataset.notePath;
            if (path) {
                await this.plugin.reviewController.advanceNote(path);
                // The controller's advanceNote method handles notices and sidebar refresh.
                // onNoteAction ensures this renderer's parent (ListViewRenderer) refreshes.
                await onNoteAction();
            }
        });

        postponeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const path = noteEl.dataset.notePath;
            if (path) {
                try {
                    await this.plugin.reviewController.postponeNote(path);
                    await this.plugin.savePluginData();
                    new Notice(`Note postponed`);
                    await onNoteAction();
                } catch (error) {
                    new Notice("Failed to postpone note.");
                    await onNoteAction();
                }
            }
        });

        removeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const path = noteEl.dataset.notePath;
            if (path) {
                const file = this.plugin.app.vault.getAbstractFileByPath(path);
                const confirmed = confirm(`Remove "${file instanceof TFile ? file.basename : path}" from review schedule?`);
                if (!confirmed) return;

                try {
                    await this.plugin.reviewScheduleService.removeFromReview(path);
                    await this.plugin.savePluginData();
                    new Notice(`Note removed from review schedule`);
                    await onNoteAction();
                } catch (error) {
                    new Notice("Failed to remove note from schedule.");
                    await onNoteAction();
                }
            }
        });
        
        dragHandleEl.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            // Only enable dragging if not disabled (checked by _populateNoteItemDetails via class)
            if (!dragHandleEl.classList.contains("is-disabled")) {
                noteEl.setAttribute("draggable", "true");
            }
        });
        noteEl.addEventListener("dragstart", (e) => {
            const path = noteEl.dataset.notePath;
            if (path && noteEl.getAttribute("draggable") === "true") { // Check if draggable
                 e.dataTransfer?.setData("text/plain", path);
            } else {
                e.preventDefault(); // Prevent drag if not supposed to be draggable
            }
        });
        noteEl.addEventListener("dragend", () => {
            noteEl.removeAttribute("draggable");
        });

        noteEl.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            const currentPath = noteEl.dataset.notePath;
            if (!currentPath) return;

            // Logic for selection (ctrl/meta/shift click)
            // This part uses selectedNotesArray and lastSelectedNotePathRef directly, which are passed in.
            // This is fine as they are managed by the calling ListViewRenderer.
            const allVisibleNoteElements = Array.from(parentContainerForBulkActions.querySelectorAll('.review-note-item[data-note-path]')) as HTMLElement[];
            const allVisibleNotePaths = allVisibleNoteElements.map(el => el.dataset.notePath).filter(p => p) as string[];
            const currentIndex = allVisibleNotePaths.indexOf(currentPath);

            if (e.shiftKey && lastSelectedNotePathRef.current && lastSelectedNotePathRef.current !== currentPath) {
                const lastClickedIndexInVisible = allVisibleNotePaths.indexOf(lastSelectedNotePathRef.current);
                if (lastClickedIndexInVisible !== -1 && currentIndex !== -1) {
                    const start = Math.min(lastClickedIndexInVisible, currentIndex);
                    const end = Math.max(lastClickedIndexInVisible, currentIndex);
                    const notesToSelectInRange = allVisibleNotePaths.slice(start, end + 1);
                    if (e.ctrlKey || e.metaKey) {
                        notesToSelectInRange.forEach(p => { if (p && !selectedNotesArray.includes(p)) selectedNotesArray.push(p); });
                    } else {
                        selectedNotesArray.length = 0;
                        selectedNotesArray.push(...notesToSelectInRange.filter(p => p) as string[]);
                    }
                } else {
                    selectedNotesArray.length = 0;
                    selectedNotesArray.push(currentPath);
                }
            } else if (e.ctrlKey || e.metaKey) {
                const indexInSelection = selectedNotesArray.indexOf(currentPath);
                if (indexInSelection > -1) {
                    selectedNotesArray.splice(indexInSelection, 1);
                } else {
                    selectedNotesArray.push(currentPath);
                }
            } else {
                selectedNotesArray.length = 0;
                selectedNotesArray.push(currentPath);
            }
            lastSelectedNotePathRef.current = currentPath;
            onSelectionChange();
        });
        
        noteEl.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const path = noteEl.dataset.notePath; // Get current path
            if (!path) return;

            const menu = new Menu();
            menu.addItem((item) => item
                .setTitle("Open note")
                .setIcon("file-text")
                .onClick(() => this.plugin.reviewController.openNoteWithoutReview(path)));
            menu.addItem((item) => item
                .setTitle("Review note")
                .setIcon("play-circle")
                .onClick(async () => {
                    this.plugin.reviewController.reviewNote(path);
                    await onNoteAction();
                }));
            menu.addItem((item) => item
                .setTitle("Postpone by 1 day")
                .setIcon("skip-forward")
                .onClick(async () => {
                    await this.plugin.reviewController.postponeNote(path, 1);
                    // savePluginData is handled by postponeNote in controller
                    // Notice is handled by postponeNote in service/controller
                    await onNoteAction();
                }));

            // Conditional "Advance note" context menu item
            const schedule = this.plugin.reviewScheduleService.schedules[path];
            if (schedule) {
                const todayStart = DateUtils.startOfDay(new Date()); // Returns timestamp
                const noteReviewDayStart = DateUtils.startOfDay(new Date(schedule.nextReviewDate)); // Returns timestamp
                if (noteReviewDayStart > todayStart) {
                    menu.addItem((item) => item
                        .setTitle("Advance note")
                        .setIcon("arrow-left-circle") // Match button icon
                        .onClick(async () => {
                            await this.plugin.reviewController.advanceNote(path);
                            // savePluginData and Notice are handled by advanceNote in controller
                            await onNoteAction();
                        }));
                }
            }

            menu.addItem((item) => item
                .setTitle("Remove from review")
                .setIcon("trash")
                .onClick(async () => {
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    const confirmed = confirm(`Remove "${file instanceof TFile ? file.basename : path}" from review schedule?`);
                    if (confirmed) {
                        await this.plugin.reviewScheduleService.removeFromReview(path);
                        await this.plugin.savePluginData();
                        new Notice("Note removed from review schedule.");
                        await onNoteAction();
                    }
                }));
            menu.showAtMouseEvent(e);
        });

        // Populate initial details, which now includes advance button state logic
        await this._populateNoteItemDetails(noteEl, noteToRender, dateStr, selectedNotesArray);

        return noteEl;
    }
}
