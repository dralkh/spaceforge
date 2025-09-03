import { Notice, setIcon } from "obsidian";
import SpaceforgePlugin from "../main";
import { ReviewSchedule } from "../models/review-schedule";
import { DateUtils } from "../utils/dates";
import { EstimationUtils } from "../utils/estimation";

/**
 * Interface for grouped reviews by date
 */
interface DateReviews {
    timestamp: number;
    notes: ReviewSchedule[];
    totalTime: number;
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

    // Persistent UI elements
    private calendarHeaderEl: HTMLElement | null = null;
    private monthTitleEl: HTMLElement | null = null;
    private calendarGridEl: HTMLElement | null = null;
    
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
        
        if (this.calendarGridEl) {
            this.renderCalendarGridContent(this.calendarGridEl); // Renders/updates the grid
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
        }

        if (!this.calendarGridEl || !calendarContainer.contains(this.calendarGridEl)) {
            this.calendarGridEl?.remove();
            this.calendarGridEl = calendarContainer.createDiv("calendar-grid");
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

                        if (isClickedDateToday) {
                            this.plugin.clickedDateFromCalendar = null;
                        } else {
                            this.plugin.clickedDateFromCalendar = currentDateObj;
                        }
                        
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
}
