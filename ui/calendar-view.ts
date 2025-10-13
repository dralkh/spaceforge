import { Notice, setIcon } from "obsidian";
import SpaceforgePlugin from "../main";
import { ReviewSchedule } from "../models/review-schedule";
import { CalendarEvent, EventCategory, EventRecurrence } from "../models/calendar-event";
import { DateUtils } from "../utils/dates";
import { EstimationUtils } from "../utils/estimation";
import { UpcomingEvents } from "./upcoming-events";
import { EventModal } from "./event-modal";

/**
 * Interface for grouped reviews by date
 */
interface DateReviews {
    timestamp: number;
    notes: ReviewSchedule[];
    totalTime: number;
}

/**
 * Interface for grouped events by date
 */
interface DateEvents {
    timestamp: number;
    events: CalendarEvent[];
}

/**
 * Calendar view component for review schedule
 */
export class CalendarView {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;
    
    /**
     * Calendar container element
     */
    containerEl: HTMLElement;
    
    /**
     * Current date being displayed
     */
    currentDate: Date;

    /**
     * Reviews grouped by date
     */
    reviewsByDate: Map<string, DateReviews> = new Map();

    /**
     * Events grouped by date
     */
    eventsByDate: Map<string, DateEvents> = new Map();

    // Persistent UI elements
    private calendarHeaderEl: HTMLElement | null = null;
    private monthTitleEl: HTMLElement | null = null;
    private calendarGridEl: HTMLElement | null = null;
    private upcomingEventsEl: HTMLElement | null = null;
    private upcomingEventsComponent: UpcomingEvents | null = null;
    
    // Tooltip elements
    private tooltipEl: HTMLElement | null = null;
    private tooltipTimeout: number | null = null;
    
    /**
     * Initialize calendar view
     * 
     * @param containerEl Container element
     * @param plugin Reference to the main plugin
     */
    constructor(containerEl: HTMLElement, plugin: SpaceforgePlugin) {
        this.containerEl = containerEl;
        this.plugin = plugin;
        this.currentDate = new Date();
    }
    
    /**
     * Render the calendar view
     */
    async render(): Promise<void> {
        this.ensureCalendarBaseStructure(); // Ensures header and grid containers exist
        
        this.updateCalendarHeader(); // Updates month title
        
        await this.loadReviewsData(); // Preloads review data for the current view
        await this.loadEventsData(); // Preloads event data for the current view
        
        if (this.calendarGridEl) {
            this.renderCalendarGridContent(this.calendarGridEl); // Renders/updates the grid
        }

        // Render upcoming events
        if (this.upcomingEventsComponent) {
            await this.upcomingEventsComponent.render();
        }
    }

    private ensureCalendarBaseStructure(): void {
        if (!this.containerEl) return;

        let calendarContainer = this.containerEl.querySelector(".calendar-container") as HTMLElement;
        if (!calendarContainer) {
            calendarContainer = this.containerEl.createDiv("calendar-container");
        }

        if (!this.calendarHeaderEl || !calendarContainer.contains(this.calendarHeaderEl)) {
            this.calendarHeaderEl?.remove();
            this.calendarHeaderEl = calendarContainer.createDiv("calendar-header");
        
            const prevMonthBtn = this.calendarHeaderEl.createDiv("calendar-nav-btn");
            setIcon(prevMonthBtn, "chevron-left");
            prevMonthBtn.addEventListener("click", () => {
                this.currentDate.setMonth(this.currentDate.getMonth() - 1);
                this.render(); 
            });
            
            this.monthTitleEl = this.calendarHeaderEl.createDiv("calendar-month-title");
            
            const nextMonthBtn = this.calendarHeaderEl.createDiv("calendar-nav-btn");
            setIcon(nextMonthBtn, "chevron-right");
            nextMonthBtn.addEventListener("click", () => {
                this.currentDate.setMonth(this.currentDate.getMonth() + 1);
                this.render(); 
            });
            
            const todayBtn = this.calendarHeaderEl.createDiv("calendar-today-btn");
            todayBtn.setText("Today");
            todayBtn.addEventListener("click", () => {
                this.currentDate = new Date();
                this.render(); 
            });
            
            const addEventBtn = this.calendarHeaderEl.createDiv("calendar-add-event-btn");
            setIcon(addEventBtn, "plus");
            addEventBtn.addEventListener("click", () => {
                this.openCreateEventModal();
            });
        }

        if (!this.calendarGridEl || !calendarContainer.contains(this.calendarGridEl)) {
            this.calendarGridEl?.remove();
            this.calendarGridEl = calendarContainer.createDiv("calendar-grid");
        }

        // Create or update upcoming events container
        if (!this.upcomingEventsEl || !calendarContainer.contains(this.upcomingEventsEl)) {
            this.upcomingEventsEl?.remove();
            this.upcomingEventsEl = calendarContainer.createDiv("upcoming-events-wrapper");
            this.upcomingEventsComponent = new UpcomingEvents(this.upcomingEventsEl, this.plugin);
        }
    }
    
    /**
     * Update calendar header (month title)
     */
    updateCalendarHeader(): void {
        if (this.monthTitleEl) {
            this.monthTitleEl.setText(
                this.currentDate.toLocaleString('default', { 
                    month: 'long', 
                    year: 'numeric' 
                })
            );
        }
    }
    
    /**
     * Load and organize review data by date
     */
    async loadReviewsData(): Promise<void> {
        this.reviewsByDate = new Map();
        const allSchedules = Object.values(this.plugin.reviewScheduleService.schedules);
        
        for (const schedule of allSchedules) {
            const scheduleDueDayStart = DateUtils.startOfUTCDay(new Date(schedule.nextReviewDate));
            const dateKey = scheduleDueDayStart.toString(); // Use timestamp as a robust key

            if (!this.reviewsByDate.has(dateKey)) {
                this.reviewsByDate.set(dateKey, {
                    timestamp: scheduleDueDayStart, // Store the start of day timestamp
                    notes: [],
                    totalTime: 0
                });
            }
            
            const dateReviews = this.reviewsByDate.get(dateKey);
            if (dateReviews) {
                dateReviews.notes.push(schedule);
                dateReviews.totalTime += await this.plugin.reviewScheduleService.estimateReviewTime(schedule.path);
            }
        }
    }

    /**
     * Load and organize event data by date
     */
    async loadEventsData(): Promise<void> {
        this.eventsByDate = new Map();
        
        if (!this.plugin.settings.enableCalendarEvents || !this.plugin.calendarEventService) {
            return;
        }

        const { year, month } = this.getCalendarData();
        const startDate = new Date(year, month, 1);
        const endDate = new Date(year, month + 1, 0); // Last day of month
        
        const eventsInRange = this.plugin.calendarEventService.getEventsInRange(
            startDate.getTime(),
            endDate.getTime()
        );

        for (const event of eventsInRange) {
            const eventDayStart = DateUtils.startOfUTCDay(new Date(event.date));
            const dateKey = eventDayStart.toString();

            if (!this.eventsByDate.has(dateKey)) {
                this.eventsByDate.set(dateKey, {
                    timestamp: eventDayStart,
                    events: []
                });
            }
            
            const dateEvents = this.eventsByDate.get(dateKey);
            if (dateEvents) {
                dateEvents.events.push(event);
            }
        }
    }
    
    /**
     * Render or update the calendar grid content
     * 
     * @param gridEl The calendar grid element to populate
     */
    renderCalendarGridContent(gridEl: HTMLElement): void {
        // gridEl.empty(); // Clear only the grid content -- REMOVED

        // Ensure weekday headers exist (create once)
        if (!gridEl.querySelector(".calendar-weekday")) {
            const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
            weekdays.forEach(day => {
                const dayHeader = gridEl.createDiv("calendar-weekday");
                dayHeader.setText(day);
            });
        }
        
        const { year, month, firstDay, daysInMonth } = this.getCalendarData();
        const totalCells = 42; // Standard 6 weeks * 7 days grid
        let dayCells = Array.from(gridEl.querySelectorAll(".calendar-day")) as HTMLElement[];

        // Adjust number of day cell elements if necessary
        if (dayCells.length < totalCells) {
            for (let i = dayCells.length; i < totalCells; i++) {
                dayCells.push(gridEl.createDiv("calendar-day"));
            }
        } else if (dayCells.length > totalCells) {
            for (let i = totalCells; i < dayCells.length; i++) {
                dayCells[i].remove();
            }
            dayCells = dayCells.slice(0, totalCells);
        }

        let dayOfMonth = 1;
        for (let i = 0; i < totalCells; i++) {
            const dayCell = dayCells[i];
            dayCell.empty(); // Clear previous content of the cell before repopulating
            dayCell.className = 'calendar-day'; // Reset classes
            dayCell.removeAttribute("data-date-key");
            dayCell.onclick = null; // Remove previous click listener

            if (i >= firstDay && dayOfMonth <= daysInMonth) {
                const currentDateObj = new Date(Date.UTC(year, month, dayOfMonth));
                const cellDayStart = DateUtils.startOfUTCDay(currentDateObj);
                const dateKey = cellDayStart.toString(); // Use the same key format for lookup
                dayCell.dataset.dateKey = dateKey;

                const dayNumber = dayCell.createDiv("calendar-day-number");
                dayNumber.setText(dayOfMonth.toString());

                if (this.isToday(year, month, dayOfMonth)) {
                    dayCell.addClass("today");
                }

                const dateReviews = this.reviewsByDate.get(dateKey);
                const dateEvents = this.eventsByDate.get(dateKey);
                
                // Render reviews
                if (dateReviews && dateReviews.notes.length > 0) {
                    dayCell.addClass("has-reviews");
                    
                    const reviewCount = dayCell.createDiv("calendar-review-count");
                    reviewCount.setText(dateReviews.notes.length.toString());
                    
                    const timeEstimate = dayCell.createDiv("calendar-time-estimate");
                    timeEstimate.setText(EstimationUtils.formatTime(dateReviews.totalTime));
                    
                    dayCell.addEventListener("click", async () => {
                        const today = new Date();
                        const isClickedDateToday = DateUtils.isSameDay(currentDateObj, today);

                        this.plugin.settings.sidebarViewType = 'list';
                        this.plugin.clickedDateFromCalendar = currentDateObj;
                        
                        await this.plugin.savePluginData();
                        const sidebarView = this.plugin.getSidebarView();
                        if (sidebarView && typeof sidebarView.refresh === 'function') {
                            await sidebarView.refresh();
                        } else {
                            this.plugin.app.workspace.requestSaveLayout();
                            new Notice("Switched to list view. Sidebar will update.");
                        }
                    });

                    if (dateReviews.notes.length > 10) dayCell.addClass("heavy-load");
                    else if (dateReviews.notes.length > 5) dayCell.addClass("medium-load");
                    else dayCell.addClass("light-load");
                }

                // Render events as small tabs
                if (dateEvents && dateEvents.events.length > 0) {
                    dayCell.addClass("has-events");
                    
                    const eventsContainer = dayCell.createDiv("calendar-events-container");
                    
                    // Show up to 3 event tabs
                    const eventsToShow = dateEvents.events.slice(0, 3);
                    eventsToShow.forEach(event => {
                        const eventTab = eventsContainer.createDiv("calendar-event-tab");
                        eventTab.setText(event.title.substring(0, 8) + (event.title.length > 8 ? "..." : ""));
                        
                        // Set color based on event category or custom color using CSS custom property
                        const eventColor = this.plugin.calendarEventService?.getEventColor(event) || '#95A5A6';
                        eventTab.style.setProperty('--event-color', eventColor);
                        
                        // Add hover handler for tooltip
                        eventTab.addEventListener("mouseenter", (e) => {
                            this.showEventTooltip(eventTab, event);
                        });
                        
                        eventTab.addEventListener("mouseleave", (e) => {
                            this.hideEventTooltip();
                        });
                        
                        // Add click handler for event
                        eventTab.addEventListener("click", (e) => {
                            e.stopPropagation(); // Prevent day cell click
                            this.showEventDetails(event);
                        });
                        
                        // Add double-click handler for editing
                        eventTab.addEventListener("dblclick", (e) => {
                            e.stopPropagation(); // Prevent day cell click
                            this.openEditEventModal(event);
                        });
                    });
                    
                    // Show "more" indicator if there are more events
                    if (dateEvents.events.length > 3) {
                        const moreIndicator = eventsContainer.createDiv("calendar-events-more");
                        moreIndicator.setText(`+${dateEvents.events.length - 3}`);
                    }
                }

                // Add hover plus button for creating events
                const addEventBtn = dayCell.createDiv("calendar-day-add-event");
                setIcon(addEventBtn, "plus");
                addEventBtn.addEventListener("click", (e) => {
                    e.stopPropagation(); // Prevent day cell click
                    this.openCreateEventModalForDate(currentDateObj);
                });
                dayOfMonth++;
            } else {
                dayCell.addClass("empty");
            }
        }
    }
    
    /**
     * Get calendar data for the current month
     * 
     * @returns Calendar data object
     */
    getCalendarData(): { year: number, month: number, firstDay: number, daysInMonth: number } {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();
        
        // First day of month (0-6, where 0 is Sunday)
        const firstDay = new Date(year, month, 1).getDay();
        
        // Days in month
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        
        return { year, month, firstDay, daysInMonth };
    }
    
    /**
     * Check if a date is today
     * 
     * @param year Year
     * @param month Month
     * @param day Day
     * @returns True if the date is today
     */
    isToday(year: number, month: number, day: number): boolean {
        const today = new Date();
        return (
            today.getFullYear() === year &&
            today.getMonth() === month &&
            today.getDate() === day
        );
    }

    /**
     * Show event details modal
     * 
     * @param event Event to show details for
     */
    showEventDetails(event: CalendarEvent): void {
        // For now, just show a notice with event details
        // TODO: Create a proper modal for event details
        const eventDate = new Date(event.date);
        const dateStr = eventDate.toLocaleDateString(undefined, { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
        
        let details = `📅 ${event.title}\n📆 ${dateStr}`;
        
        if (event.time) {
            details += `\n🕐 ${event.time}`;
        }
        
        if (event.description) {
            details += `\n📝 ${event.description}`;
        }
        
        if (event.location) {
            details += `\n📍 ${event.location}`;
        }
        
        details += `\n🏷️ ${event.category}`;
        
        new Notice(details, 8000);
    }

    /**
     * Open create event modal
     */
    openCreateEventModal(): void {
        const modal = new EventModal(
            this.plugin.app,
            this.plugin,
            null,
            async (savedEvent) => {
                // Refresh the calendar view after saving
                await this.render();
            }
        );
        modal.open();
    }

    /**
     * Open create event modal for a specific date
     * 
     * @param date Date to pre-fill in the modal
     */
    openCreateEventModalForDate(date: Date): void {
        // Create a default event with the selected date
        const defaultEvent = {
            title: "",
            date: date.getTime(),
            isAllDay: true,
            category: (this.plugin.settings.defaultEventCategory as EventCategory) || EventCategory.Personal,
            recurrence: EventRecurrence.None
        };

        const modal = new EventModal(
            this.plugin.app,
            this.plugin,
            null,
            async (savedEvent) => {
                // Refresh the calendar view after saving
                await this.render();
            }
        );
        modal.open();
        
        // Pre-fill the date in the modal after it opens
        window.setTimeout(() => {
            const dateInput = modal.contentEl.querySelector('input[type="date"]') as HTMLInputElement;
            if (dateInput) {
                dateInput.value = date.toISOString().split('T')[0];
            }
        }, 100);
    }

    /**
     * Open edit event modal
     * 
     * @param event Event to edit
     */
    openEditEventModal(event: CalendarEvent): void {
        const modal = new EventModal(
            this.plugin.app,
            this.plugin,
            event,
            async (savedEvent) => {
                // Refresh the calendar view after saving
                await this.render();
            }
        );
        modal.open();
    }

    /**
     * Clean up resources when the calendar view is destroyed
     */
    destroy(): void {
        this.hideEventTooltip();
        
        // Clear other references
        this.calendarHeaderEl = null;
        this.monthTitleEl = null;
        this.calendarGridEl = null;
        this.upcomingEventsEl = null;
        this.upcomingEventsComponent = null;
    }

    /**
     * Show event tooltip
     * 
     * @param targetEl Element to show tooltip for
     * @param event Event to show details for
     */
    showEventTooltip(targetEl: HTMLElement, event: CalendarEvent): void {
        // Clear any existing timeout
        if (this.tooltipTimeout) {
            window.clearTimeout(this.tooltipTimeout);
        }

        // Small delay before showing tooltip to avoid flickering
        this.tooltipTimeout = window.setTimeout(() => {
            this.createEventTooltip(targetEl, event);
        }, 300);
    }

    /**
     * Hide event tooltip
     */
    hideEventTooltip(): void {
        // Clear any pending tooltip
        if (this.tooltipTimeout) {
            window.clearTimeout(this.tooltipTimeout);
            this.tooltipTimeout = null;
        }

        // Remove existing tooltip
        if (this.tooltipEl) {
            this.tooltipEl.remove();
            this.tooltipEl = null;
        }
    }

    /**
     * Create and show the tooltip element
     * 
     * @param targetEl Element to position tooltip relative to
     * @param event Event to show details for
     */
    private createEventTooltip(targetEl: HTMLElement, event: CalendarEvent): void {
        // Remove existing tooltip if any
        this.hideEventTooltip();

        // Create tooltip element
        this.tooltipEl = document.body.createEl("div");
        this.tooltipEl.className = "calendar-event-tooltip";
        
        // Format event details
        const eventDate = new Date(event.date);
        const dateStr = eventDate.toLocaleDateString(undefined, { 
            weekday: 'short', 
            month: 'short', 
            day: 'numeric' 
        });
        
        // Clear existing content
        this.tooltipEl.empty();
        
        // Create tooltip content safely
        const titleEl = this.tooltipEl.createDiv('tooltip-title');
        titleEl.textContent = event.title;
        
        const dateEl = this.tooltipEl.createDiv('tooltip-date');
        dateEl.textContent = `📅 ${dateStr}`;
        
        if (event.time) {
            const timeEl = this.tooltipEl.createDiv('tooltip-time');
            timeEl.textContent = `🕐 ${event.time}`;
        }
        
        if (event.description) {
            const descEl = this.tooltipEl.createDiv('tooltip-description');
            descEl.textContent = `📝 ${event.description}`;
        }
        
        if (event.location) {
            const locationEl = this.tooltipEl.createDiv('tooltip-location');
            locationEl.textContent = `📍 ${event.location}`;
        }
        
        const categoryEl = this.tooltipEl.createDiv('tooltip-category');
        categoryEl.textContent = `🏷️ ${event.category}`;
        
        // Position tooltip
        const rect = targetEl.getBoundingClientRect();
        const tooltipRect = this.tooltipEl.getBoundingClientRect();
        
        // Add to DOM temporarily to get dimensions
        document.body.appendChild(this.tooltipEl);
        
        // Calculate position
        let left = rect.left + (rect.width / 2) - (this.tooltipEl.offsetWidth / 2);
        let top = rect.bottom + 8;
        
        // Adjust if tooltip goes off screen
        if (left < 8) left = 8;
        if (left + this.tooltipEl.offsetWidth > window.innerWidth - 8) {
            left = window.innerWidth - this.tooltipEl.offsetWidth - 8;
        }
        if (top + this.tooltipEl.offsetHeight > window.innerHeight - 8) {
            top = rect.top - this.tooltipEl.offsetHeight - 8;
        }
        
        this.tooltipEl.style.left = `${left}px`;
        this.tooltipEl.style.top = `${top}px`;
        
        // Add fade-in animation using CSS class
        this.tooltipEl.classList.remove('visible');
        
        requestAnimationFrame(() => {
            if (this.tooltipEl) {
                this.tooltipEl.classList.add('visible');
            }
        });
    }
}
