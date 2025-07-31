/**
 * Simple event emitter implementation
 */
export class EventEmitter {
    /**
     * Event listeners by event name
     */
    private listeners: Record<string, Function[]> = {};
    
    /**
     * Register a listener for an event
     * 
     * @param event Event name
     * @param callback Function to call when event is emitted
     */
    on(event: string, callback: Function): void {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        
        this.listeners[event].push(callback);
    }
    
    /**
     * Emit an event
     * 
     * @param event Event name
     * @param args Arguments to pass to listeners
     */
    emit(event: string, ...args: any[]): void {
        if (!this.listeners[event]) {
            return;
        }
        
        for (const callback of this.listeners[event]) {
            callback(...args);
        }
    }
    
    /**
     * Remove a listener for an event
     * 
     * @param event Event name
     * @param callback Function to remove
     */
    off(event: string, callback: Function): void {
        if (!this.listeners[event]) {
            return;
        }
        
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
    
    /**
     * Remove all listeners for an event
     * 
     * @param event Event name
     */
    removeAllListeners(event?: string): void {
        if (event) {
            delete this.listeners[event];
        } else {
            this.listeners = {};
        }
    }
}
