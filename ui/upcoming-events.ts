import { Notice, setIcon } from "obsidian";
import SpaceforgePlugin from "../main";
import { UpcomingEvent } from "../models/calendar-event";
import { DateUtils } from "../utils/dates";

/**
 * Upcoming events component for calendar view
 */
export class UpcomingEvents {
    /**
     * Reference to the main plugin
     */
    plugin: SpaceforgePlugin;
    
    /**
     * Container element for upcoming events
     */
    containerEl: HTMLElement;
    
    /**
     * Upcoming events data
     */
    upcomingEvents: UpcomingEvent[] = [];

    /**
     * Initialize upcoming events component
     * 
     * @param containerEl Container element
     * @param plugin Reference to the main plugin
     */
    constructor(containerEl: HTMLElement, plugin: SpaceforgePlugin) {
        this.containerEl = containerEl;
        this.plugin = plugin;
    }

    /**
     * Render upcoming events list
     */
    async render(): Promise<void> {
        if (!this.plugin.settings.enableCalendarEvents || !this.plugin.settings.showUpcomingEvents) {
            this.containerEl.empty();
            return;
        }

        if (!this.plugin.calendarEventService) {
            this.containerEl.empty();
            return;
        }

        // Load upcoming events data
        await this.loadUpcomingEvents();

        // Clear container
        this.containerEl.empty();

        if (this.upcomingEvents.length === 0) {
            this.renderEmptyState();
            return;
        }

        this.renderEventsList();
    }

    /**
     * Load upcoming events data
     */
    async loadUpcomingEvents(): Promise<void> {
        this.upcomingEvents = this.plugin.calendarEventService.getUpcomingEvents(
            this.plugin.settings.upcomingEventsDays || 7
        );
    }

    /**
     * Render empty state when no upcoming events
     */
    private renderEmptyState(): void {
        const emptyState = this.containerEl.createDiv("upcoming-events-empty");
        
        const emptyIcon = emptyState.createDiv("upcoming-events-empty-icon");
        setIcon(emptyIcon, "calendar");
        
        const emptyText = emptyState.createDiv("upcoming-events-empty-text");
        emptyText.setText("No upcoming events");
        
        const emptySubtext = emptyState.createDiv("upcoming-events-empty-subtext");
        emptySubtext.setText("Events will appear here once you create them");
    }

    /**
     * Render the events list
     */
    private renderEventsList(): void {
        // Create header
        const header = this.containerEl.createDiv("upcoming-events-header");
        
        const headerTitle = header.createDiv("upcoming-events-title");
        headerTitle.setText("Upcoming Events");
        
        const headerSubtitle = header.createDiv("upcoming-events-subtitle");
        const daysText = this.plugin.settings.upcomingEventsDays || 7;
        headerSubtitle.setText(`Next ${daysText} days`);

        // Create events container
        const eventsContainer = this.containerEl.createDiv("upcoming-events-container");

        // Group events by day
        const eventsByDay = this.groupEventsByDay();

        // Render each day's events
        eventsByDay.forEach((dayEvents, dayKey) => {
            this.renderDaySection(eventsContainer, dayKey, dayEvents);
        });
    }

    /**
     * Group upcoming events by day
     */
    private groupEventsByDay(): Map<string, UpcomingEvent[]> {
        const eventsByDay = new Map<string, UpcomingEvent[]>();

        this.upcomingEvents.forEach(upcomingEvent => {
            let dayKey: string;
            
            if (upcomingEvent.isToday) {
                dayKey = "Today";
            } else if (upcomingEvent.isTomorrow) {
                dayKey = "Tomorrow";
            } else {
                const eventDate = new Date(upcomingEvent.event.date);
                dayKey = eventDate.toLocaleDateString(undefined, { 
                    weekday: 'short', 
                    month: 'short', 
                    day: 'numeric' 
                });
            }

            if (!eventsByDay.has(dayKey)) {
                eventsByDay.set(dayKey, []);
            }

            eventsByDay.get(dayKey)!.push(upcomingEvent);
        });

        return eventsByDay;
    }

    /**
     * Render a day section with its events
     */
    private renderDaySection(container: HTMLElement, dayKey: string, dayEvents: UpcomingEvent[]): void {
        const daySection = container.createDiv("upcoming-events-day-section");
        
        // Day header
        const dayHeader = daySection.createDiv("upcoming-events-day-header");
        
        const dayTitle = dayHeader.createDiv("upcoming-events-day-title");
        dayTitle.setText(dayKey);
        
        if (dayKey === "Today") {
            daySection.addClass("today");
        } else if (dayKey === "Tomorrow") {
            daySection.addClass("tomorrow");
        }

        // Events for this day
        const dayEventsContainer = daySection.createDiv("upcoming-events-day-events");
        
        dayEvents.forEach(upcomingEvent => {
            this.renderEventItem(dayEventsContainer, upcomingEvent);
        });
    }

    /**
     * Render a single event item
     */
    private renderEventItem(container: HTMLElement, upcomingEvent: UpcomingEvent): void {
        const event = upcomingEvent.event;
        const eventItem = container.createDiv("upcoming-events-event-item");
        
        // Event color indicator
        const colorIndicator = eventItem.createDiv("upcoming-events-event-color");
        const eventColor = this.plugin.calendarEventService?.getEventColor(event) || '#95A5A6';
        colorIndicator.style.backgroundColor = eventColor;
        
        // Event content
        const eventContent = eventItem.createDiv("upcoming-events-event-content");
        
        // Event title and time
        const eventHeader = eventContent.createDiv("upcoming-events-event-header");
        
        const eventTitle = eventHeader.createDiv("upcoming-events-event-title");
        eventTitle.setText(event.title);
        
        if (event.time) {
            const eventTime = eventHeader.createDiv("upcoming-events-event-time");
            eventTime.setText(event.time);
        } else if (event.isAllDay) {
            const eventTime = eventHeader.createDiv("upcoming-events-event-time");
            eventTime.setText("All day");
        }
        
        // Event details
        if (event.description || event.location) {
            const eventDetails = eventContent.createDiv("upcoming-events-event-details");
            
            if (event.location) {
                const eventLocation = eventDetails.createDiv("upcoming-events-event-location");
                setIcon(eventLocation, "map-pin");
                eventLocation.appendText(" " + event.location);
            }
            
            if (event.description) {
                const eventDescription = eventDetails.createDiv("upcoming-events-event-description");
                eventDescription.setText(event.description.substring(0, 100) + (event.description.length > 100 ? "..." : ""));
            }
        }
        
        // Event category
        const eventCategory = eventContent.createDiv("upcoming-events-event-category");
        eventCategory.setText(event.category);
        
        // Click handler to show event details
        eventItem.addEventListener("click", () => {
            this.showEventDetails(event);
        });
        
        // Add hover effect
        eventItem.addEventListener("mouseenter", () => {
            eventItem.addClass("hover");
        });
        
        eventItem.addEventListener("mouseleave", () => {
            eventItem.removeClass("hover");
        });
    }

    /**
     * Show event details modal
     * 
     * @param event Event to show details for
     */
    private showEventDetails(event: any): void {
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
     * Refresh the upcoming events display
     */
    async refresh(): Promise<void> {
        await this.render();
    }

    /**
     * Clean up the component
     */
    destroy(): void {
        this.containerEl.empty();
    }
}