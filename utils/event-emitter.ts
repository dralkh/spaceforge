/**
 * Simple event emitter implementation
 */
export type EventMap = Record<string, any[]>;

export class EventEmitter<Events extends { [K in keyof Events]: any[] } = Record<string, any[]>> {
    /**
     * Event listeners by event name
     */
    private listeners: { [K in keyof Events]?: ((...args: Events[K]) => void)[] } = {};

    /**
     * Register a listener for an event
     * 
     * @param event Event name
     * @param callback Function to call when event is emitted
     */
    on<K extends keyof Events>(event: K, callback: (...args: Events[K]) => void): void {
        const key = event as string;
        if (!this.listeners[key as keyof Events]) {
            this.listeners[key as keyof Events] = [];
        }

        this.listeners[key as keyof Events]!.push(callback);
    }

    /**
     * Emit an event
     * 
     * @param event Event name
     * @param args Arguments to pass to listeners
     */
    emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
        const key = event as string;
        if (!this.listeners[key as keyof Events]) {
            return;
        }

        for (const callback of this.listeners[key as keyof Events]!) {
            callback(...args);
        }
    }

    /**
     * Remove a listener for an event
     * 
     * @param event Event name
     * @param callback Function to remove
     */
    off<K extends keyof Events>(event: K, callback: (...args: Events[K]) => void): void {
        const key = event as string;
        if (!this.listeners[key as keyof Events]) {
            return;
        }

        this.listeners[key as keyof Events] = this.listeners[key as keyof Events]!.filter(cb => cb !== callback);
    }

    /**
     * Remove all listeners for an event
     * 
     * @param event Event name
     */
    removeAllListeners<K extends keyof Events>(event?: K): void {
        if (event) {
            delete this.listeners[event as keyof Events];
        } else {
            this.listeners = {};
        }
    }
}
