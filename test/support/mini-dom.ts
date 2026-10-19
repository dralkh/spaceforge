/**
 * A very small DOM stand-in that understands the Obsidian element helpers the
 * strip uses (createDiv, createEl, addClass, empty, setText, ...). Enough to
 * assert what the bar renders and which handlers its controls call.
 */

export interface MiniEvent {
    preventDefault(): void;
    stopPropagation(): void;
}

export class MiniElement {
    tag: string;
    tagName: string;
    children: MiniElement[] = [];
    parent: MiniElement | null = null;
    classes = new Set<string>();
    attrs: Record<string, string> = {};
    text = '';
    disabled = false;
    /** Inline styles, as a plain bag: enough for code that writes one. */
    style: Record<string, string> = {};
    isConnected = true;
    /** Mirrors the DOM flag so `isEditableTarget` can be exercised. */
    isContentEditable = false;

    private listeners: Record<string, ((event: MiniEvent) => void)[]> = {};

    constructor(tag: string) {
        this.tag = tag;
        this.tagName = tag.toUpperCase();
    }

    /** Supports the subset used by the plugin: tag, .class and [attr="value"]. */
    matches(selector: string): boolean {
        const part = selector.trim();
        if (part.startsWith('.')) return this.hasClass(part.slice(1));
        const attrMatch = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(part);
        if (attrMatch) {
            const [, name, value] = attrMatch;
            if (!(name in this.attrs)) return false;
            return value === undefined || this.attrs[name] === value;
        }
        return this.tag === part.toLowerCase();
    }

    closest(selector: string): MiniElement | null {
        const parts = selector.split(',').map(part => part.trim()).filter(Boolean);
        let node: MiniElement | null = this;
        while (node) {
            if (parts.some(part => node!.matches(part))) return node;
            node = node.parent;
        }
        return null;
    }

    /**
     * Obsidian's setCssProps: custom properties written onto the element, an
     * empty value meaning "remove it". Mirrored here because the plugin uses it
     * instead of assigning inline styles directly.
     */
    setCssProps(props: Record<string, string>): void {
        for (const [name, value] of Object.entries(props)) {
            if (value === '') delete this.style[name];
            else this.style[name] = value;
        }
    }

    // --- Obsidian helpers ---

    createDiv(options?: string | { cls?: string; text?: string }): MiniElement {
        return this.appendChild(new MiniElement('div'), options);
    }

    createSpan(options?: string | { cls?: string; text?: string }): MiniElement {
        return this.appendChild(new MiniElement('span'), options);
    }

    createEl(tag: string, options?: { cls?: string; text?: string }): MiniElement {
        return this.appendChild(new MiniElement(tag), options);
    }

    // Table helpers, as Obsidian's DOM extensions provide them: the settings
    // tab's explanation boxes are tables.
    createTHead(): MiniElement {
        return this.createEl('thead');
    }

    createTBody(): MiniElement {
        return this.createEl('tbody');
    }

    insertRow(): MiniElement {
        return this.createEl('tr');
    }

    /**
     * Append, with the DOM's move semantics: a node that already has a parent
     * (this one included) is detached first, so re-appending reorders instead of
     * duplicating. The plugin re-appends its dock under the bar on every mount.
     */
    appendChild(child: MiniElement, options?: string | { cls?: string; text?: string }): MiniElement {
        if (child.parent) {
            const previous = child.parent.children.indexOf(child);
            if (previous >= 0) child.parent.children.splice(previous, 1);
        } else {
            const duplicate = this.children.indexOf(child);
            if (duplicate >= 0) this.children.splice(duplicate, 1);
        }
        if (typeof options === 'string') {
            child.addClass(options);
        } else if (options) {
            if (options.cls) child.addClass(options.cls);
            if (options.text) child.text = options.text;
        }
        child.parent = this;
        this.children.push(child);
        return child;
    }

    /** Insert before a sibling, with the same bookkeeping as appendChild. */
    insertBefore(child: MiniElement, reference: MiniElement | null): MiniElement {
        if (child.parent) {
            const previous = child.parent.children.indexOf(child);
            if (previous >= 0) child.parent.children.splice(previous, 1);
        }
        const index = reference ? this.children.indexOf(reference) : -1;
        if (index >= 0) this.children.splice(index, 0, child);
        else this.children.push(child);
        child.parent = this;
        child.isConnected = this.isConnected;
        return child;
    }

    addClass(cls: string): void {
        // Real classList.add accepts space-separated tokens.
        for (const token of cls.split(/\s+/).filter(Boolean)) this.classes.add(token);
    }

    /** The value of an input/select, kept as a plain string. */
    value = '';

    /** Scroll offset, so code that restores a position has somewhere to read it. */
    scrollTop = 0;

    /** The DOM's parentElement, which the settings tab reads to find its scroller. */
    get parentElement(): MiniElement | null {
        return this.parent;
    }

    /** The DOM's textContent: every text node under the element, in order. */
    get textContent(): string {
        return flatten(this);
    }

    set textContent(text: string) {
        this.setText(text);
    }

    /**
     * `classList` as the code uses it: `add`, `remove`, `toggle` (with the
     * optional force) and `contains`. Kept in step with the methods above so a
     * surface can be written against the DOM API it will really meet.
     */
    readonly classList = {
        add: (cls: string): void => this.addClass(cls),
        remove: (cls: string): void => this.removeClass(cls),
        toggle: (cls: string, force?: boolean): boolean => {
            this.toggleClass(cls, force);
            return this.hasClass(cls);
        },
        contains: (cls: string): boolean => this.hasClass(cls),
    };

    addClasses(classes: string[]): void {
        classes.forEach(cls => this.addClass(cls));
    }

    /** The DOM's `prepend`: put a child in front of the ones already there. */
    prepend(child: MiniElement): MiniElement {
        this.appendChild(child);
        this.children = [child, ...this.children.filter(candidate => candidate !== child)];
        return child;
    }

    removeClass(cls: string): void {
        this.classes.delete(cls);
    }

    toggleClass(cls: string, value?: boolean): void {
        const on = value ?? !this.classes.has(cls);
        if (on) this.classes.add(cls);
        else this.classes.delete(cls);
    }

    hasClass(cls: string): boolean {
        return this.classes.has(cls);
    }

    empty(): void {
        this.children = [];
        this.text = '';
    }

    setText(text: string): void {
        this.empty();
        this.text = text;
    }

    setAttribute(name: string, value: string): void {
        this.attrs[name] = value;
    }

    removeAttribute(name: string): void {
        delete this.attrs[name];
    }

    getAttribute(name: string): string | null {
        return this.attrs[name] ?? null;
    }

    addEventListener(type: string, handler: (event: MiniEvent) => void): void {
        (this.listeners[type] ??= []).push(handler);
    }



    removeEventListener(type: string, handler: (event: MiniEvent) => void): void {
        const handlers = this.listeners[type];
        if (!handlers) return;
        this.listeners[type] = handlers.filter(candidate => candidate !== handler);
    }

    /** How many handlers are attached: lets tests prove nothing is left behind. */
    listenerCount(type: string): number {
        return this.listeners[type]?.length ?? 0;
    }

    remove(): void {
        if (this.parent) {
            this.parent.children = this.parent.children.filter(child => child !== this);
            this.parent = null;
        }
        this.isConnected = false;
    }

    // --- Test helpers ---

    /** Focus is a no-op here; the DOM has it, so code may call it. */
    focus(): void { /* no-op */ }

    blur(): void { /* no-op */ }

    scrollIntoView(): void { /* no-op */ }

    scrollTo(): void { /* no-op */ }

    querySelectorAll(selector: string): MiniElement[] {
        return this.findAll(element => element.matches(selector));
    }

    querySelector(selector: string): MiniElement | null {
        return this.find(element => element.matches(selector));
    }

    remove(): void {
        if (this.parent) {
            const index = this.parent.children.indexOf(this);
            if (index >= 0) this.parent.children.splice(index, 1);
        }
        this.parent = null;
        this.isConnected = false;
    }

    click(): void {
        for (const handler of this.listeners['click'] ?? []) {
            handler({ preventDefault: () => undefined, stopPropagation: () => undefined });
        }
    }

    find(predicate: (element: MiniElement) => boolean): MiniElement | null {
        if (predicate(this)) return this;
        for (const child of this.children) {
            const found = child.find(predicate);
            if (found) return found;
        }
        return null;
    }

    findAll(predicate: (element: MiniElement) => boolean): MiniElement[] {
        const out: MiniElement[] = [];
        if (predicate(this)) out.push(this);
        for (const child of this.children) out.push(...child.findAll(predicate));
        return out;
    }

    byClass(cls: string): MiniElement[] {
        return this.findAll(element => element.hasClass(cls));
    }

    textOf(cls: string): string {
        const element = this.find(candidate => candidate.hasClass(cls));
        return element ? flatten(element) : '';
    }
}

/** All text inside an element, in document order. */
export function flatten(element: MiniElement): string {
    return [element.text, ...element.children.map(flatten)].join('');
}

/** Text of every element carrying a class, in document order. */
export function textsOfClass(root: MiniElement, cls: string): string[] {
    return root.byClass(cls).map(flatten);
}

/**
 * A document that records keydown listeners and can press a key: enough for
 * surfaces that bind their shortcuts where a browser delivers them — on the
 * document, aimed at whatever has focus — rather than on their own element.
 */
export interface MiniKeyEvent {
    key: string;
    target: unknown;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
    preventDefault(): void;
    stopPropagation(): void;
}

export class MiniDocument {
    listeners: ((event: MiniKeyEvent) => void)[] = [];

    addEventListener(type: string, handler: (event: MiniKeyEvent) => void): void {
        if (type === 'keydown') this.listeners.push(handler);
    }

    removeEventListener(type: string, handler: (event: MiniKeyEvent) => void): void {
        if (type === 'keydown') this.listeners = this.listeners.filter(candidate => candidate !== handler);
    }

    /** How many keydown handlers are attached. */
    count(): number {
        return this.listeners.length;
    }

    /** Send a key to this document, aimed at `target` (the body by default). */
    press(key: string, target: unknown = null): MiniKeyEvent {
        const event: MiniKeyEvent = {
            key,
            target,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            defaultPrevented: false,
            preventDefault() { event.defaultPrevented = true; },
            stopPropagation() { /* nothing above to stop */ },
        };
        for (const handler of [...this.listeners]) handler(event);
        return event;
    }
}

/** Install the document and element globals the plugin's DOM code reaches for. */
export function installMiniDocument(): MiniDocument {
    const doc = new MiniDocument();
    const globals = globalThis as Record<string, unknown>;
    globals.document = doc;
    globals.HTMLElement = MiniElement;
    // Surfaces that drag or resize bind on the window; Node has no window, and
    // a teardown that removes those listeners must not die on the way out.
    globals.addEventListener ??= () => undefined;
    globals.removeEventListener ??= () => undefined;
    return doc;
}

// ---------------------------------------------------------------------------
// (The interactive gallery's own additions live in the block at the end of this
// file: `createSvg` and an element-level `dispatch`, added by the diagram lane
// and reused by the lab and graph lanes rather than duplicated here.)
// ---------------------------------------------------------------------------

/* ======================================================================== *
 * Appended block: SVG elements and element-delivered events.
 *
 * Added for the interactive Study diagram, which draws a real SVG and whose
 * hotspots activate on a keydown delivered to the `<g>` itself. The stand-in
 * above could build an element with `createEl` but had no `createSvg` (the
 * helper the app uses to put a node in the SVG namespace) and no way to send
 * an event to one element's listeners (`click()` is hard-wired to clicks, and
 * `MiniDocument.press` only reaches document-level handlers). Both additions
 * are purely additive: nothing that already used this stand-in changes.
 * ======================================================================== */

/** What `createSvg` accepts: a class, SVG attributes, or both. */
export interface MiniSvgOptions {
    cls?: string;
    attr?: Record<string, string | number | boolean | null>;
}

export interface MiniElement {
    /** Obsidian's `createSvg`: append an SVG-namespaced child of this element. */
    createSvg(tag: string, options?: string | MiniSvgOptions): MiniElement;
    /** Deliver an event to this element's own listeners, as a browser would. */
    dispatch(type: string, event?: Partial<MiniEvent> & { key?: string; target?: unknown }): void;
}

MiniElement.prototype.createSvg = function createSvg(
    this: MiniElement,
    tag: string,
    options?: string | MiniSvgOptions
): MiniElement {
    const element = this.appendChild(new MiniElement(tag));
    const settings = typeof options === 'string' ? { cls: options } : options;
    if (settings?.cls) element.addClass(settings.cls);
    for (const [name, value] of Object.entries(settings?.attr ?? {})) {
        if (value === null) continue;
        element.setAttribute(name, String(value));
    }
    return element;
};

MiniElement.prototype.dispatch = function dispatch(
    this: MiniElement,
    type: string,
    event?: Partial<MiniEvent> & { key?: string; target?: unknown }
): void {
    const bag = this as unknown as { listeners: Record<string, ((payload: MiniEvent & { key?: string }) => void)[]> };
    const handlers = bag.listeners[type] ?? [];
    const payload = {
        key: event?.key ?? '',
        target: this as unknown,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
        ...event,
    };
    for (const handler of [...handlers]) handler(payload);
};
