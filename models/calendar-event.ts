/**
 * Event categories with predefined colors
 */
export enum EventCategory {
    Work = 'work',
    Personal = 'personal',
    Study = 'study',
    Meeting = 'meeting',
    Health = 'health',
    Social = 'social',
    Other = 'other'
}

/**
 * Event recurrence patterns
 */
export enum EventRecurrence {
    None = 'none',
    Daily = 'daily',
    Weekly = 'weekly',
    Monthly = 'monthly',
    Yearly = 'yearly'
}

/**
 * Default colors for event categories
 */
export const EVENT_CATEGORY_COLORS: Record<EventCategory, string> = {
    [EventCategory.Work]: '#4A90E2',
    [EventCategory.Personal]: '#7B68EE',
    [EventCategory.Study]: '#50C878',
    [EventCategory.Meeting]: '#FF6B6B',
    [EventCategory.Health]: '#FF9F40',
    [EventCategory.Social]: '#FF69B4',
    [EventCategory.Other]: '#95A5A6'
};

/**
 * Calendar event interface
 */
export interface CalendarEvent {
    /**
     * Unique identifier for the event
     */
    id: string;
    
    /**
     * Event title
     */
    title: string;
    
    /**
     * Event description (optional)
     */
    description?: string;
    
    /**
     * Event date (timestamp)
     */
    date: number;
    
    /**
     * Event time in HH:MM format (optional)
     */
    time?: string;
    
    /**
     * Event category
     */
    category: EventCategory;
    
    /**
     * Custom color (overrides category color if set)
     */
    color?: string;
    
    /**
     * Event recurrence pattern
     */
    recurrence: EventRecurrence;
    
    /**
     * End date for recurring events (optional)
     */
    recurrenceEndDate?: number;
    
    /**
     * Whether the event is all-day
     */
    isAllDay: boolean;
    
    /**
     * Event location (optional)
     */
    location?: string;
    
    /**
     * Creation timestamp
     */
    createdAt: number;
    
    /**
     * Last modification timestamp
     */
    updatedAt: number;
}

/**
 * Interface for grouped events by date
 */
export interface DateEvents {
    timestamp: number;
    events: CalendarEvent[];
}

/**
 * Interface for upcoming event display
 */
export interface UpcomingEvent {
    event: CalendarEvent;
    daysUntil: number;
    isToday: boolean;
    isTomorrow: boolean;
}