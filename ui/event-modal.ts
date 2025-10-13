import { App, Modal, Setting, Notice, setIcon } from "obsidian";
import SpaceforgePlugin from "../main";
import { CalendarEvent, EventCategory, EventRecurrence, EVENT_CATEGORY_COLORS } from "../models/calendar-event";

/**
 * Modal for creating or editing calendar events
 */
export class EventModal extends Modal {
    plugin: SpaceforgePlugin;
    event: CalendarEvent | null;
    onSave: (event: CalendarEvent) => void;
    
    // Form elements
    titleInput: HTMLInputElement;
    descriptionInput: HTMLTextAreaElement;
    dateInput: HTMLInputElement;
    timeInput: HTMLInputElement;
    locationInput: HTMLInputElement;
    categorySelect: HTMLSelectElement;
    colorInput: HTMLInputElement;
    isAllDayToggle: HTMLInputElement;
    recurrenceSelect: HTMLSelectElement;
    recurrenceEndDateInput: HTMLInputElement;
    
    constructor(app: App, plugin: SpaceforgePlugin, event: CalendarEvent | null = null, onSave: (event: CalendarEvent) => void) {
        super(app);
        this.plugin = plugin;
        this.event = event;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("event-modal");
        
        // Compact header
        const header = contentEl.createDiv("event-modal-header");
        const headerIcon = header.createDiv("event-modal-header-icon");
        setIcon(headerIcon, this.event ? "edit" : "calendar-plus");
        
        const headerText = header.createDiv("event-modal-header-text");
        const titleSetting = new Setting(headerText)
            .setHeading()
            .setName(this.event ? "Edit Event" : "New Event");
        titleSetting.settingEl.addClass("event-modal-title");
        
        // Compact form container
        const formContainer = contentEl.createDiv("event-modal-form");
        
        // Title row
        const titleRow = formContainer.createDiv("event-modal-row");
        const titleGroup = titleRow.createDiv("event-modal-field-group");
        titleGroup.createEl("label", { text: "Title", cls: "event-modal-label required" });
        this.titleInput = titleGroup.createEl("input", { 
            type: "text",
            cls: "event-modal-input",
            placeholder: "Event title..."
        });
        if (this.event?.title) {
            this.titleInput.value = this.event.title;
        }
        this.titleInput.addEventListener("input", () => this.validateForm());

        // Date & Time row
        const dateTimeRow = formContainer.createDiv("event-modal-row");
        const dateGroup = dateTimeRow.createDiv("event-modal-field-group");
        dateGroup.createEl("label", { text: "Date", cls: "event-modal-label" });
        this.dateInput = dateGroup.createEl("input", { 
            type: "date",
            cls: "event-modal-input"
        });
        if (this.event?.date) {
            const date = new Date(this.event.date);
            this.dateInput.value = date.toISOString().split('T')[0];
        } else {
            this.dateInput.value = new Date().toISOString().split('T')[0];
        }
        this.dateInput.addEventListener("change", () => this.validateForm());
        
        const timeGroup = dateTimeRow.createDiv("event-modal-field-group");
        timeGroup.createEl("label", { text: "Time", cls: "event-modal-label" });
        this.timeInput = timeGroup.createEl("input", { 
            type: "time",
            cls: "event-modal-input"
        });
        if (this.event?.time) {
            this.timeInput.value = this.event.time;
        }
        this.timeInput.addEventListener("change", () => this.updateAllDayToggle());

        // All-day toggle row
        const allDayRow = formContainer.createDiv("event-modal-row");
        const allDayGroup = allDayRow.createDiv("event-modal-field-group");
        this.isAllDayToggle = allDayGroup.createEl("input", { 
            type: "checkbox",
            cls: "event-modal-checkbox"
        }) as HTMLInputElement;
        this.isAllDayToggle.checked = this.event?.isAllDay ?? false;
        this.isAllDayToggle.addEventListener("change", () => this.toggleTimeInput());
        
        const allDayLabel = allDayGroup.createEl("label", { 
            text: "All-day event",
            cls: "event-modal-checkbox-label"
        });

        // Location row
        const locationRow = formContainer.createDiv("event-modal-row");
        const locationGroup = locationRow.createDiv("event-modal-field-group");
        locationGroup.createEl("label", { text: "Location", cls: "event-modal-label" });
        this.locationInput = locationGroup.createEl("input", { 
            type: "text",
            cls: "event-modal-input",
            placeholder: "Location (optional)..."
        });
        if (this.event?.location) {
            this.locationInput.value = this.event.location;
        }

        // Category & Color row
        const categoryColorRow = formContainer.createDiv("event-modal-row");
        const categoryGroup = categoryColorRow.createDiv("event-modal-field-group");
        categoryGroup.createEl("label", { text: "Category", cls: "event-modal-label" });
        this.categorySelect = categoryGroup.createEl("select", { 
            cls: "event-modal-select"
        });
        
        Object.values(EventCategory).forEach(category => {
            const option = this.categorySelect.createEl("option", { 
                value: category,
                text: category.charAt(0).toUpperCase() + category.slice(1)
            });
            this.categorySelect.appendChild(option);
        });
        
        if (this.event?.category) {
            this.categorySelect.value = this.event.category;
        } else {
            this.categorySelect.value = this.plugin.settings.defaultEventCategory || 'personal';
        }
        
        this.categorySelect.addEventListener("change", () => this.updateColorFromCategory());
        
        const colorGroup = categoryColorRow.createDiv("event-modal-field-group");
        colorGroup.createEl("label", { text: "Color", cls: "event-modal-label" });
        const colorPickerContainer = colorGroup.createDiv("event-modal-color-picker-compact");
        this.colorInput = colorPickerContainer.createEl("input", { 
            type: "color",
            cls: "event-modal-color-input"
        }) as HTMLInputElement;
        
        if (this.event?.color) {
            this.colorInput.value = this.event.color;
        } else {
            this.updateColorFromCategory();
        }

        // Description row (full width)
        const descriptionRow = formContainer.createDiv("event-modal-row event-modal-full-width");
        const descriptionGroup = descriptionRow.createDiv("event-modal-field-group");
        descriptionGroup.createEl("label", { text: "Description", cls: "event-modal-label" });
        this.descriptionInput = descriptionGroup.createEl("textarea", { 
            cls: "event-modal-textarea",
            placeholder: "Event details (optional)..."
        });
        this.descriptionInput.rows = 2;
        if (this.event?.description) {
            this.descriptionInput.value = this.event.description;
        }

        // Recurrence row
        const recurrenceRow = formContainer.createDiv("event-modal-row");
        const recurrenceGroup = recurrenceRow.createDiv("event-modal-field-group");
        recurrenceGroup.createEl("label", { text: "Recurrence", cls: "event-modal-label" });
        this.recurrenceSelect = recurrenceGroup.createEl("select", { 
            cls: "event-modal-select"
        });
        
        Object.values(EventRecurrence).forEach(recurrence => {
            const option = this.recurrenceSelect.createEl("option", { 
                value: recurrence,
                text: this.getRecurrenceDisplayText(recurrence)
            });
            this.recurrenceSelect.appendChild(option);
        });
        
        if (this.event?.recurrence) {
            this.recurrenceSelect.value = this.event.recurrence;
        } else {
            this.recurrenceSelect.value = EventRecurrence.None;
        }
        
        this.recurrenceSelect.addEventListener("change", () => this.toggleRecurrenceEndDate());
        
        // Recurrence end date row (conditional)
        const recurrenceEndRow = formContainer.createDiv("event-modal-row event-modal-recurrence-end-row");
        const recurrenceEndGroup = recurrenceEndRow.createDiv("event-modal-field-group");
        recurrenceEndGroup.createEl("label", { text: "End Date", cls: "event-modal-label" });
        this.recurrenceEndDateInput = recurrenceEndGroup.createEl("input", { 
            type: "date",
            cls: "event-modal-input"
        });
        if (this.event?.recurrenceEndDate) {
            const date = new Date(this.event.recurrenceEndDate);
            this.recurrenceEndDateInput.value = date.toISOString().split('T')[0];
        }

        // Enhanced buttons section
        const buttonContainer = contentEl.createDiv("event-modal-actions");
        
        const cancelButton = buttonContainer.createEl("button", { 
            text: "Cancel",
            cls: "event-modal-btn event-modal-btn-secondary"
        });
        cancelButton.addEventListener("click", () => this.close());
        
        // Add delete button only for existing events
        if (this.event) {
            const deleteButton = buttonContainer.createEl("button", { 
                text: "Delete",
                cls: "event-modal-btn event-modal-btn-danger"
            });
            deleteButton.addEventListener("click", () => this.deleteEvent());
        }
        
        const saveButton = buttonContainer.createEl("button", { 
            text: this.event ? "Update Event" : "Create Event",
            cls: "event-modal-btn event-modal-btn-primary"
        });
        saveButton.addEventListener("click", () => this.saveEvent());

        // Initial setup
        this.validateForm();
        this.updateAllDayToggle();
        this.toggleTimeInput();
        this.toggleRecurrenceEndDate();
        this.updateColorPreview();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    /**
     * Validate form and enable/disable save button
     */
    private validateForm(): void {
        const saveButton = this.contentEl.querySelector(".event-modal-btn-primary") as HTMLButtonElement;
        const isValid = this.titleInput.value.trim() !== "" && this.dateInput.value !== "";
        
        if (saveButton) {
            saveButton.disabled = !isValid;
        }
    }

    /**
     * Update color based on selected category
     */
    private updateColorFromCategory(): void {
        const category = this.categorySelect.value as EventCategory;
        const categoryColor = EVENT_CATEGORY_COLORS[category];
        this.colorInput.value = categoryColor;
        this.updateColorPreview();
    }

    /**
     * Update color preview
     */
    private updateColorPreview(): void {
        const colorPreview = this.contentEl.querySelector(".event-modal-color-preview") as HTMLElement;
        if (colorPreview) {
            colorPreview.style.backgroundColor = this.colorInput.value;
        }
    }

    /**
     * Toggle time input based on all-day setting
     */
    private toggleTimeInput(): void {
        const isAllDay = this.isAllDayToggle.checked;
        const timeContainer = this.timeInput.closest(".event-modal-input-group") as HTMLElement;
        
        if (timeContainer) {
            timeContainer.style.display = isAllDay ? "none" : "block";
        }
        
        if (isAllDay) {
            this.timeInput.value = "";
        }
    }

    /**
     * Update all-day toggle based on time input
     */
    private updateAllDayToggle(): void {
        const hasTime = this.timeInput.value !== "";
        if (hasTime && this.isAllDayToggle.checked) {
            this.isAllDayToggle.checked = false;
            this.toggleTimeInput();
        }
    }

    /**
     * Toggle recurrence end date based on recurrence setting
     */
    private toggleRecurrenceEndDate(): void {
        const recurrence = this.recurrenceSelect.value as EventRecurrence;
        const endDateContainer = this.recurrenceEndDateInput.closest(".event-modal-recurrence-end-container") as HTMLElement;
        
        if (endDateContainer) {
            endDateContainer.style.display = recurrence === EventRecurrence.None ? "none" : "block";
        }
        
        if (recurrence === EventRecurrence.None) {
            this.recurrenceEndDateInput.value = "";
        }
    }

    /**
     * Get display text for recurrence option
     */
    private getRecurrenceDisplayText(recurrence: EventRecurrence): string {
        switch (recurrence) {
            case EventRecurrence.None: return "None";
            case EventRecurrence.Daily: return "Daily";
            case EventRecurrence.Weekly: return "Weekly";
            case EventRecurrence.Monthly: return "Monthly";
            case EventRecurrence.Yearly: return "Yearly";
            default: return recurrence;
        }
    }

    /**
     * Delete the event
     */
    private async deleteEvent(): Promise<void> {
        if (!this.event) return;
        
        try {
            const deleted = this.plugin.calendarEventService?.deleteEvent(this.event.id);
            
            if (deleted) {
                new Notice("Event deleted successfully");
                await this.plugin.savePluginData();
                
                // Trigger calendar refresh through the onSave callback
                this.onSave(this.event);
                
                this.close();
            } else {
                new Notice("Failed to delete event");
            }
        } catch (error) {
            console.error("Error deleting event:", error);
            new Notice("Error deleting event");
        }
    }

    /**
     * Save the event
     */
    private async saveEvent(): Promise<void> {
        try {
            const title = this.titleInput.value.trim();
            const description = this.descriptionInput.value.trim();
            const date = new Date(this.dateInput.value);
            const time = this.timeInput.value;
            const location = this.locationInput.value.trim();
            const category = this.categorySelect.value as EventCategory;
            const color = this.colorInput.value;
            const isAllDay = this.isAllDayToggle.checked;
            const recurrence = this.recurrenceSelect.value as EventRecurrence;
            const recurrenceEndDateText = this.recurrenceEndDateInput.value;
            const recurrenceEndDate = recurrenceEndDateText ? new Date(recurrenceEndDateText).getTime() : undefined;

            if (!title || !this.dateInput.value) {
                new Notice("Please fill in all required fields");
                return;
            }

            let eventData: Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'>;

            if (this.event) {
                // Update existing event
                eventData = {
                    ...this.event,
                    title,
                    description: description || undefined,
                    date: date.getTime(),
                    time: time || undefined,
                    location: location || undefined,
                    category,
                    color: color !== EVENT_CATEGORY_COLORS[category] ? color : undefined,
                    isAllDay,
                    recurrence,
                    recurrenceEndDate
                };
                
                const updatedEvent = this.plugin.calendarEventService?.updateEvent(this.event.id, eventData);
                if (updatedEvent) {
                    this.onSave(updatedEvent);
                    new Notice("Event updated successfully");
                }
            } else {
                // Create new event
                eventData = {
                    title,
                    description: description || undefined,
                    date: date.getTime(),
                    time: time || undefined,
                    location: location || undefined,
                    category,
                    color: color !== EVENT_CATEGORY_COLORS[category] ? color : undefined,
                    isAllDay,
                    recurrence,
                    recurrenceEndDate
                };
                
                const newEvent = this.plugin.calendarEventService?.createEvent(eventData);
                if (newEvent) {
                    this.onSave(newEvent);
                    new Notice("Event created successfully");
                }
            }

            // Save plugin data
            await this.plugin.savePluginData();
            
            this.close();
        } catch (error) {
            console.error("Error saving event:", error);
            new Notice("Error saving event");
        }
    }
}