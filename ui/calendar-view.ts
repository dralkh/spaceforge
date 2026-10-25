
import { Notice, setIcon } from "obsidian";
import SpaceforgePlugin from "../main";
import { ReviewSchedule } from "../models/review-schedule";
import { CalendarEvent } from "../models/calendar-event";
import { DateUtils, deckDayBase } from "../utils/dates";
import { AnkiCardQueue } from "../models/anki";

/** One day, in the only unit Anki's day numbers are counted in. */
const DAY_MS = 86_400_000;
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

/** What the decks owe on one day: how many cards, and from which decks. */
interface DateDeckCards {
    timestamp: number;
    cards: number;
    decks: string[];
}

/**
 * Interface for grouped events by date
 */
interface DateEvents {
    timestamp: number;
    events: CalendarEvent[];
}

/** "1 hr 30 min" as its numbers and its last unit: ["1 hr 30", "min"]. */
function splitDuration(text: string): [string, string] {
    const parts = text.split(' ');
    const unit = parts.length > 1 ? (parts.pop() as string) : '';
    return [parts.join(' '), unit];
}

/**
 * How the calendar answers a date the reader picked.
 *
 * The view that owns the calendar supplies this, and it is the only route: the
 * sidebar cannot be looked up through the workspace, because a reloaded plugin
 * leaves a live view of an older class in the leaf and the lookup returns null.
 */
export interface CalendarHost {
    /** The reader picked a day: show it as a list. */
    onDatePicked?: (date: Date) => void;
}

/**
 * Calendar view component for review schedule
 */
export class CalendarView {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;

    /** The sidebar that draws this calendar; a date pick goes through it. */
    private host: CalendarHost;

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

    /** Notes this render could not price: no word count since they last changed */
    private uncountedPaths: string[] = [];

    /**
     * Deck cards grouped by date, beside the notes: the two lanes are kept
     * apart everywhere, so the calendar says which is which rather than adding
     * them into one number the reader cannot take apart again.
     */
    deckCardsByDate: Map<string, DateDeckCards> = new Map();

    /** Deck files are read once per version; the calendar redraws often. */
    private deckDueCache = new Map<string, { modified: number; due: Map<string, DateDeckCards> }>();

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
     * @param host The sidebar this calendar is drawn inside. A date pick is
     *   answered by the view that owns it, never by looking the sidebar up in
     *   the workspace: after a plugin reload the live view belongs to the
     *   previous module load, so `getSidebarView()` answers null and the click
     *   ends in a notice about a sidebar that never updates.
     */
    constructor(containerEl: HTMLElement, plugin: SpaceforgePlugin, host: CalendarHost = {}) {
        this.containerEl = containerEl;
        this.plugin = plugin;
        this.host = host;
        this.currentDate = new Date();
    }

    /**
     * Render the calendar view
     */
    async render(): Promise<void> {
        this.ensureCalendarBaseStructure(); // Ensures header and grid containers exist

        this.updateCalendarHeader(); // Updates month title

        this.loadReviewsData(); // Preloads review data for the current view
        await this.loadDeckCardsData(); // And what the decks owe, day by day
        this.loadEventsData(); // Preloads event data for the current view

        if (this.calendarGridEl) {
            this.renderCalendarGridContent(this.calendarGridEl); // Renders/updates the grid
        }
        void this.fillMissingEstimates(); // and prices whatever this month has not read yet

        // Render upcoming events
        if (this.upcomingEventsComponent) {
            this.upcomingEventsComponent.render();
        }
    }

    private ensureCalendarBaseStructure(): void {
        if (!this.containerEl) return;

        let calendarContainer = this.containerEl.querySelector<HTMLElement>(".calendar-container");
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
                void this.render();
            });

            this.monthTitleEl = this.calendarHeaderEl.createDiv("calendar-month-title");

            const nextMonthBtn = this.calendarHeaderEl.createDiv("calendar-nav-btn");
            setIcon(nextMonthBtn, "chevron-right");
            nextMonthBtn.addEventListener("click", () => {
                this.currentDate.setMonth(this.currentDate.getMonth() + 1);
                void this.render();
            });

            const todayBtn = this.calendarHeaderEl.createDiv("calendar-today-btn");
            todayBtn.setText("Today");
            todayBtn.addEventListener("click", () => {
                this.currentDate = new Date();
                void this.render();
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
    loadReviewsData(): void {
        this.reviewsByDate = new Map();
        this.uncountedPaths = [];
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
                // Every scheduled note, every render — so the number comes from the
                // word count this note already has, never from the size of the file
                // and never from a read in this loop. A note that has not been read
                // since it last changed is collected, and the month is drawn again
                // once it has: a cell shows a real time or none, not an invented one.
                const seconds = this.plugin.reviewScheduleService.estimateReviewTimeCached(schedule.path);
                if (seconds === null) {
                    if (!this.uncountedPaths.includes(schedule.path)) this.uncountedPaths.push(schedule.path);
                } else {
                    dateReviews.totalTime += seconds;
                }
            }
        }
    }

    /**
     * Read the notes this month could not price, then draw it once more.
     *
     * The reads happen after the grid is on screen, several at a time, and only for
     * notes that have no count for their current contents — so the pane appears at
     * once and the times fill in, rather than the pane waiting on four hundred reads.
     */
    async fillMissingEstimates(): Promise<void> {
        if (this.uncountedPaths.length === 0) return;
        const missing = this.uncountedPaths.slice();
        const known = await this.plugin.wordCounts.prime(missing);
        if (known > 0 && this.containerEl.isConnected) await this.render();
    }

    /**
     * Load what the decks owe, grouped by day.
     *
     * A deck's cards keep Anki's own due conventions: a review card is due on a
     * day counted from the deck's creation, while a card in learning is due at
     * an exact moment. New cards are available now, so they belong to today —
     * which is what an Anki deck list would tell the reader too.
     */
    async loadDeckCardsData(): Promise<void> {
        this.deckCardsByDate = new Map();
        const store = this.plugin.deckStore;
        if (!store) return;

        let summaries;
        try {
            summaries = await store.listDecks();
        } catch (error) {
            console.error('spaceforge: could not list decks for the calendar', error);
            return;
        }

        const todayStart = DateUtils.startOfUTCDay(new Date());
        for (const summary of summaries) {
            const cached = this.deckDueCache.get(summary.path);
            if (cached && cached.modified === summary.modified) {
                this.mergeDeckDays(cached.due);
                continue;
            }

            let bundle;
            try {
                bundle = await store.readDeck(summary.path);
            } catch (error) {
                console.error(`spaceforge: could not read ${summary.path} for the calendar`, error);
                continue;
            }

            // The deck's own `crt` when it came from Anki, its id otherwise.
            const created = bundle.extra?.crt;
            const deckBase = deckDayBase(bundle.deck.id, typeof created === 'number' ? created : null);
            const due = new Map<string, DateDeckCards>();
            for (const card of bundle.cards) {
                if (
                    card.queue === AnkiCardQueue.Suspended ||
                    card.queue === AnkiCardQueue.SchedBuried ||
                    card.queue === AnkiCardQueue.UserBuried
                ) {
                    continue;
                }

                const dueAt = card.queue === AnkiCardQueue.New
                    ? Date.now()
                    : card.queue === AnkiCardQueue.Learning
                        ? card.due
                        : deckBase + card.due * DAY_MS;
                const dayStart = DateUtils.startOfUTCDay(new Date(dueAt));
                const key = dayStart.toString();
                const entry = due.get(key) ?? { timestamp: dayStart, cards: 0, decks: [] };
                entry.cards += 1;
                if (!entry.decks.includes(bundle.deck.name)) entry.decks.push(bundle.deck.name);
                due.set(key, entry);
            }

            this.deckDueCache.set(summary.path, { modified: summary.modified, due });
            this.mergeDeckDays(due);
        }

        // Cards that were due before today are still owed, so they are shown on
        // today's cell, where the reader can act on them.
        const todayKey = todayStart.toString();
        const owed = [...this.deckCardsByDate.entries()].filter(([, entry]) => entry.timestamp < todayStart);
        if (owed.length > 0) {
            const today = this.deckCardsByDate.get(todayKey) ?? { timestamp: todayStart, cards: 0, decks: [] };
            for (const [, entry] of owed) {
                today.cards += entry.cards;
                for (const name of entry.decks) if (!today.decks.includes(name)) today.decks.push(name);
                this.deckCardsByDate.delete(entry.timestamp.toString());
            }
            this.deckCardsByDate.set(todayKey, today);
        }
    }

    /** Fold one deck's days into the calendar's own map. */
    private mergeDeckDays(due: Map<string, DateDeckCards>): void {
        for (const [key, entry] of due) {
            const existing = this.deckCardsByDate.get(key) ?? { timestamp: entry.timestamp, cards: 0, decks: [] };
            existing.cards += entry.cards;
            for (const name of entry.decks) if (!existing.decks.includes(name)) existing.decks.push(name);
            this.deckCardsByDate.set(key, existing);
        }
    }

    /**
     * Load and organize event data by date
     */
    loadEventsData(): void {
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
        let dayCells = Array.from(gridEl.querySelectorAll<HTMLElement>(".calendar-day"));

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

                // The cell's own rows: the date with the day's counts beside it,
                // the events under them, then the time and the button that adds an
                // event. Every row is in the flow, so a cell too narrow for a row
                // wraps it (see the cell's own container query) instead of letting
                // the counts and the button land on top of the date and the time.
                const head = dayCell.createDiv({ cls: 'calendar-day-head' });
                const dayNumber = head.createDiv({ cls: 'calendar-day-number' });
                dayNumber.setText(dayOfMonth.toString());
                const chips = head.createDiv({ cls: 'calendar-day-chips' });
                const foot = dayCell.createDiv({ cls: 'calendar-day-foot' });

                if (this.isToday(year, month, dayOfMonth)) {
                    dayCell.addClass("today");
                }

                const dateReviews = this.reviewsByDate.get(dateKey);
                const dateEvents = this.eventsByDate.get(dateKey);

                // Render reviews
                if (dateReviews && dateReviews.notes.length > 0) {
                    dayCell.addClass("has-reviews");

                    const reviewCount = chips.createDiv("calendar-review-count");
                    reviewCount.setText(dateReviews.notes.length.toString());

                    const timeEstimate = foot.createDiv("calendar-time-estimate");
                    this.renderTimeEstimate(timeEstimate, dateReviews.totalTime);

                    // Assign the handler (instead of addEventListener) so repeated
                    // calendar renders replace it rather than stacking duplicate
                    // listeners, which would trigger a burst of concurrent refreshes.
                    dayCell.onclick = () => {
                        this.plugin.settings.sidebarViewType = 'list';
                        this.plugin.clickedDateFromCalendar = currentDateObj;
                        // The sidebar that owns this calendar answers, in the same
                        // instance that drew it. Looking it up through the
                        // workspace answered null after a reload, so the click
                        // wrote the mode, found no view, and told the reader the
                        // sidebar "will update" — forever.
                        this.host.onDatePicked?.(currentDateObj);
                    };

                    if (dateReviews.notes.length > 10) dayCell.addClass("heavy-load");
                    else if (dateReviews.notes.length > 5) dayCell.addClass("medium-load");
                    else dayCell.addClass("light-load");
                }

                // Render what the decks owe that day, beside the notes
                const deckDay = this.deckCardsByDate.get(dateKey);
                if (deckDay && deckDay.cards > 0) {
                    dayCell.addClass('has-deck-cards');
                    const deckCount = chips.createDiv('calendar-deck-count');
                    // The number and its word are separate spans: a cell too
                    // narrow for the word drops it and keeps the count.
                    deckCount.createSpan({ cls: 'calendar-deck-count-value', text: String(deckDay.cards) });
                    deckCount.createSpan({
                        cls: 'calendar-deck-count-unit',
                        text: ` card${deckDay.cards === 1 ? '' : 's'}`,
                    });
                    deckCount.setAttribute('title', `Cards due in ${deckDay.decks.join(', ')}`);
                }

                // Render events as small tabs
                if (dateEvents && dateEvents.events.length > 0) {
                    dayCell.addClass("has-events");

                    const eventsContainer = dayCell.createDiv("calendar-events-container");
                    // The events read between the date and the time, and the footer
                    // was made before them: this is where they belong.
                    dayCell.insertBefore(eventsContainer, foot);

                    // Show up to 3 event tabs
                    const eventsToShow = dateEvents.events.slice(0, 3);
                    eventsToShow.forEach(event => {
                        const eventTab = eventsContainer.createDiv("calendar-event-tab");
                        eventTab.setText(event.title.substring(0, 8) + (event.title.length > 8 ? "..." : ""));

                        // Set color based on event category or custom color using CSS custom property
                        const eventColor = this.plugin.calendarEventService?.getEventColor(event) || '#95A5A6';
                        // The colour is data, so it rides in as the custom property
                        // the stylesheet reads; nothing here writes styling.
                        eventTab.setCssProps({ '--event-color': eventColor });

                        // Add hover handler for tooltip
                        eventTab.addEventListener("mouseenter", (_e) => {
                            this.showEventTooltip(eventTab, event);
                        });

                        eventTab.addEventListener("mouseleave", (_e) => {
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
                        moreIndicator.setText(`+ ${dateEvents.events.length - 3} `);
                    }
                }

                // Add hover plus button for creating events
                // The button that adds an event keeps a column of its own in the
                // cell's footer; it used to float over the time estimate.
                const addEventBtn = foot.createDiv("calendar-day-add-event");
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
        // The full editor is ui/event-modal.ts; this is the quick look from the
        // calendar grid, where a modal would interrupt clicking through a month.
        const eventDate = new Date(event.date);
        const dateStr = eventDate.toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        let details = `📅 ${event.title} \n📆 ${dateStr} `;

        if (event.time) {
            details += `\n🕐 ${event.time} `;
        }

        if (event.description) {
            details += `\n📝 ${event.description} `;
        }

        if (event.location) {
            details += `\n📍 ${event.location} `;
        }

        details += `\n🏷️ ${event.category} `;

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
            (_savedEvent) => {
                // Refresh the calendar view after saving
                void this.render();
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
        const modal = new EventModal(
            this.plugin.app,
            this.plugin,
            null,
            (_savedEvent) => {
                // Refresh the calendar view after saving
                void this.render();
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
            (_savedEvent) => {
                // Refresh the calendar view after saving
                void this.render();
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
        this.tooltipEl = document.body.createDiv({ cls: 'sf-calendar-tooltip' });
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
        dateEl.textContent = `📅 ${dateStr} `;

        if (event.time) {
            const timeEl = this.tooltipEl.createDiv('tooltip-time');
            timeEl.textContent = `🕐 ${event.time} `;
        }

        if (event.description) {
            const descEl = this.tooltipEl.createDiv('tooltip-description');
            descEl.textContent = `📝 ${event.description} `;
        }

        if (event.location) {
            const locationEl = this.tooltipEl.createDiv('tooltip-location');
            locationEl.textContent = `📍 ${event.location} `;
        }

        const categoryEl = this.tooltipEl.createDiv('tooltip-category');
        categoryEl.textContent = `🏷️ ${event.category} `;

        // Position tooltip
        const rect = targetEl.getBoundingClientRect();

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

        // Where the tooltip sits is data (it follows the cursor); the stylesheet
        // decides what to do with the coordinates.
        this.tooltipEl.setCssProps({ '--sf-tip-x': `${left}px`, '--sf-tip-y': `${top}px` });

        // Add fade-in animation using CSS class
        this.tooltipEl.classList.remove('visible');

        window.requestAnimationFrame(() => {
            if (this.tooltipEl) {
                this.tooltipEl.classList.add('visible');
            }
        });
    }

    /**
     * A day's duration as the cell spells it: the numbers, then the unit.
     *
     * The unit's short form is a span of its own because "20 min" is wider than
     * a day cell in a sidebar: the cell's container query drops the word and
     * shows "20m", so the estimate is shortened rather than clipped away. The
     * whole string still rides in the title.
     */
    private renderTimeEstimate(el: HTMLElement, seconds: number): void {
        const text = EstimationUtils.formatTime(seconds);
        const [value, unit] = splitDuration(text);
        el.createSpan({ cls: 'calendar-time-estimate-value', text: value });
        if (unit !== '') {
            el.createSpan({ cls: 'calendar-time-estimate-unit', text: ` ${unit}` });
            el.createSpan({ cls: 'calendar-time-estimate-unit-short', text: unit.slice(0, 1) });
        }
        el.setAttribute('title', text);
    }
}
