import { CalendarEvent, DateEvents, UpcomingEvent, EventCategory, EventRecurrence } from '../models/calendar-event';
import { DateUtils } from '../utils/dates';

/**
 * Service for managing calendar events
 */
export class CalendarEventService {
    /**
     * Storage for calendar events
     */
    private events: Map<string, CalendarEvent> = new Map();

    /**
     * Initialize the service with existing events
     * 
     * @param events Array of existing events
     */
    initialize(events: CalendarEvent[] = []): void {
        this.events.clear();
        events.forEach(event => {
            this.events.set(event.id, event);
        });
    }

    /**
     * Get all events
     * 
     * @returns Array of all events
     */
    getAllEvents(): CalendarEvent[] {
        return Array.from(this.events.values());
    }

    /**
     * Get event by ID
     * 
     * @param id Event ID
     * @returns Event or null if not found
     */
    getEventById(id: string): CalendarEvent | null {
        return this.events.get(id) || null;
    }

    /**
     * Create a new event
     * 
     * @param eventData Event data (without id, createdAt, updatedAt)
     * @returns Created event
     */
    createEvent(eventData: Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'>): CalendarEvent {
        const now = Date.now();
        const event: CalendarEvent = {
            ...eventData,
            id: this.generateId(),
            createdAt: now,
            updatedAt: now
        };

        this.events.set(event.id, event);
        return event;
    }

    /**
     * Update an existing event
     * 
     * @param id Event ID
     * @param updates Partial event data to update
     * @returns Updated event or null if not found
     */
    updateEvent(id: string, updates: Partial<CalendarEvent>): CalendarEvent | null {
        const existingEvent = this.events.get(id);
        if (!existingEvent) {
            return null;
        }

        const updatedEvent: CalendarEvent = {
            ...existingEvent,
            ...updates,
            id, // Ensure ID doesn't change
            createdAt: existingEvent.createdAt, // Preserve creation time
            updatedAt: Date.now()
        };

        this.events.set(id, updatedEvent);
        return updatedEvent;
    }

    /**
     * Delete an event
     * 
     * @param id Event ID
     * @returns True if deleted, false if not found
     */
    deleteEvent(id: string): boolean {
        return this.events.delete(id);
    }

    /**
     * Get events for a specific date range
     * 
     * @param startDate Start date timestamp
     * @param endDate End date timestamp
     * @returns Array of events in the date range
     */
    getEventsInRange(startDate: number, endDate: number): CalendarEvent[] {
        return this.getAllEvents().filter(event => {
            const eventDate = DateUtils.startOfDay(new Date(event.date));
            const start = DateUtils.startOfDay(new Date(startDate));
            const end = DateUtils.startOfDay(new Date(endDate));

            return eventDate >= start && eventDate <= end;
        });
    }

    /**
     * Get events for a specific date
     * 
     * @param date Date timestamp
     * @returns Array of events for the date
     */
    getEventsForDate(date: number): CalendarEvent[] {
        const targetDate = DateUtils.startOfDay(new Date(date));
        return this.getAllEvents().filter(event => {
            const eventDate = DateUtils.startOfDay(new Date(event.date));
            return eventDate === targetDate;
        });
    }

    /**
     * Get events grouped by date for a date range
     * 
     * @param startDate Start date timestamp
     * @param endDate End date timestamp
     * @returns Map of date keys to DateEvents
     */
    getEventsGroupedByDate(startDate: number, endDate: number): Map<string, DateEvents> {
        const eventsByDate = new Map<string, DateEvents>();
        const eventsInRange = this.getEventsInRange(startDate, endDate);

        eventsInRange.forEach(event => {
            const eventDateStart = DateUtils.startOfDay(new Date(event.date));
            const dateKey = eventDateStart.toString();

            if (!eventsByDate.has(dateKey)) {
                eventsByDate.set(dateKey, {
                    timestamp: eventDateStart,
                    events: []
                });
            }

            const dateEvents = eventsByDate.get(dateKey);
            if (dateEvents) {
                dateEvents.events.push(event);
            }
        });

        return eventsByDate;
    }

    /**
     * Get upcoming events
     * 
     * @param daysAhead Number of days ahead to look
     * @param fromDate Optional start date (defaults to today)
     * @returns Array of upcoming events
     */
    getUpcomingEvents(daysAhead = 7, fromDate: Date = new Date()): UpcomingEvent[] {
        const today = DateUtils.startOfDay(fromDate);
        const endDate = DateUtils.addDays(today, daysAhead);
        const eventsInRange = this.getEventsInRange(today, endDate);

        return eventsInRange
            .map(event => {
                const eventDate = DateUtils.startOfDay(new Date(event.date));
                const daysUntil = Math.floor((eventDate - today) / (24 * 60 * 60 * 1000));

                return {
                    event,
                    daysUntil,
                    isToday: daysUntil === 0,
                    isTomorrow: daysUntil === 1
                };
            })
            .sort((a, b) => {
                // Sort by days until, then by time
                if (a.daysUntil !== b.daysUntil) {
                    return a.daysUntil - b.daysUntil;
                }

                // If same day, sort by time (all-day events first)
                if (a.event.isAllDay && !b.event.isAllDay) return -1;
                if (!a.event.isAllDay && b.event.isAllDay) return 1;

                // If both have times, sort by time
                if (a.event.time && b.event.time) {
                    return a.event.time.localeCompare(b.event.time);
                }

                return 0;
            });
    }

    /**
     * Generate recurring event instances
     * 
     * @param event Recurring event
     * @param startDate Start date for generating instances
     * @param endDate End date for generating instances
     * @returns Array of event instances
     */
    generateRecurringInstances(event: CalendarEvent, startDate: number, endDate: number): CalendarEvent[] {
        if (event.recurrence === EventRecurrence.None) {
            return [event];
        }

        const instances: CalendarEvent[] = [];
        const start = DateUtils.startOfDay(new Date(startDate));
        const end = DateUtils.startOfDay(new Date(endDate));
        const eventDate = DateUtils.startOfDay(new Date(event.date));
        const recurrenceEnd = event.recurrenceEndDate ? DateUtils.startOfDay(new Date(event.recurrenceEndDate)) : end;

        const currentDate = new Date(eventDate);

        while (currentDate.getTime() <= Math.min(end, recurrenceEnd)) {
            if (currentDate.getTime() >= start) {
                const instance: CalendarEvent = {
                    ...event,
                    date: currentDate.getTime(),
                    id: `${event.id}-${currentDate.getTime()}` // Unique ID for instance
                };
                instances.push(instance);
            }

            // Move to next occurrence
            switch (event.recurrence) {
                case EventRecurrence.Daily:
                    currentDate.setDate(currentDate.getDate() + 1);
                    break;
                case EventRecurrence.Weekly:
                    currentDate.setDate(currentDate.getDate() + 7);
                    break;
                case EventRecurrence.Monthly:
                    currentDate.setMonth(currentDate.getMonth() + 1);
                    break;
                case EventRecurrence.Yearly:
                    currentDate.setFullYear(currentDate.getFullYear() + 1);
                    break;
            }
        }

        return instances;
    }

    /**
     * Get events by category
     * 
     * @param category Event category
     * @returns Array of events in the category
     */
    getEventsByCategory(category: EventCategory): CalendarEvent[] {
        return this.getAllEvents().filter(event => event.category === category);
    }

    /**
     * Search events by title or description
     * 
     * @param query Search query
     * @returns Array of matching events
     */
    searchEvents(query: string): CalendarEvent[] {
        const lowerQuery = query.toLowerCase();
        return this.getAllEvents().filter(event =>
            event.title.toLowerCase().includes(lowerQuery) ||
            (event.description && event.description.toLowerCase().includes(lowerQuery))
        );
    }

    /**
     * Export events to JSON
     * 
     * @returns JSON string of all events
     */
    exportEvents(): string {
        return JSON.stringify(this.getAllEvents(), null, 2);
    }

    /**
     * Import events from JSON
     * 
     * @param json JSON string of events
     * @returns Number of imported events
     */
    importEvents(json: string): number {
        try {
            const events: CalendarEvent[] = JSON.parse(json);
            let importedCount = 0;

            events.forEach(event => {
                if (event.id && event.title && event.date) {
                    this.events.set(event.id, event);
                    importedCount++;
                }
            });

            return importedCount;
        } catch (error) {
            console.error('Failed to import events:', error);
            return 0;
        }
    }

    /**
     * Generate a unique ID for new events
     * 
     * @returns Unique ID string
     */
    private generateId(): string {
        return `event-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    }

    /**
     * Get event color (custom color or category color)
     * 
     * @param event Event
     * @returns Color hex code
     */
    getEventColor(event: CalendarEvent): string {
        return event.color || this.getCategoryColor(event.category);
    }

    /**
     * Get category color
     * 
     * @param category Event category
     * @returns Color hex code
     */
    getCategoryColor(category: EventCategory): string {
        const colors = {
            [EventCategory.Work]: '#4A90E2',
            [EventCategory.Personal]: '#7B68EE',
            [EventCategory.Study]: '#50C878',
            [EventCategory.Meeting]: '#FF6B6B',
            [EventCategory.Health]: '#FF9F40',
            [EventCategory.Social]: '#FF69B4',
            [EventCategory.Other]: '#95A5A6'
        };

        return colors[category] || colors[EventCategory.Other];
    }
}