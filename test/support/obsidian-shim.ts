/**
 * Minimal stand-ins for the parts of the Obsidian API the scheduling services
 * touch, so those code paths can be exercised in Node. Only what is actually
 * called at import time or during a test lives here.
 */

import { MiniElement } from './mini-dom';

export class TAbstractFile {
    path = '';
    name = '';
    parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
    basename = '';
    extension = 'md';
    stat = { mtime: 0, ctime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
}

export const notices: string[] = [];

export class Notice {
    constructor(message: string | DocumentFragment, timeout?: number) {
        void timeout;
        notices.push(typeof message === 'string' ? message : '[fragment]');
    }

    setMessage(message: string): this {
        notices.push(message);
        return this;
    }

    hide(): void { /* no-op */ }
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function setIcon(_el: unknown, name: string): void {
    iconNames.push(name);
}

/** Every icon the code has asked for, in order. */
export const iconNames: string[] = [];

export class Component {
    load(): void { /* no-op */ }
    unload(): void { /* no-op */ }
}

export class Plugin extends Component {
    manifest = { id: 'spaceforge', version: '0.0.0' };
}

export class Modal {
    app: unknown;
    containerEl: unknown = null;
    constructor(app: unknown) { this.app = app; }
    open(): void { /* no-op */ }
    close(): void { /* no-op */ }
}

/**
 * The settings tab, in Node.
 *
 * The settings tab is the one surface whose whole job is DOM, and whose real
 * bugs — a rebuild that closes what the reader had open, a row that moves when
 * it is toggled — a text assertion cannot see. These stand-ins give the tab
 * real element structure over the miniature DOM, and let a test drive a control
 * the way a click would.
 */

/** One control inside a setting row: the fluent API, plus a way to fire it. */
export class ShimComponent {
    /** The element the component's input lives on, as Obsidian exposes it. */
    inputEl: MiniElement;
    /** The value the tab last set. */
    value: unknown = '';
    placeholder = '';
    options: { value: string; label: string }[] = [];
    limits: [number, number, number] | null = null;
    tooltip = '';
    buttonText = '';
    disabled = false;
    warning = false;
    cta = false;
    readonly el: MiniElement;

    private readonly changeHandlers: ((value: unknown) => unknown)[] = [];
    private readonly clickHandlers: (() => unknown)[] = [];

    constructor(controlEl: MiniElement, tag: 'div' | 'input' | 'select' | 'textarea' | 'button') {
        this.el = controlEl.createEl(tag);
        this.inputEl = this.el;
    }

    setValue(value: unknown): this {
        this.value = value;
        this.inputEl.value = String(value ?? '');
        return this;
    }

    getValue(): unknown {
        return this.value;
    }

    setPlaceholder(text: string): this { this.placeholder = text; return this; }
    setLimits(min: number, max: number, step: number): this { this.limits = [min, max, step]; return this; }
    setDynamicTooltip(): this { return this; }
    addOption(value: string, label: string): this { this.options.push({ value, label }); return this; }
    setButtonText(text: string): this { this.buttonText = text; return this; }
    setIcon(): this { return this; }
    setTooltip(text: string): this { this.tooltip = text; return this; }
    setDisabled(disabled = true): this { this.disabled = disabled; return this; }
    setWarning(): this { this.warning = true; return this; }
    setCta(): this { this.cta = true; return this; }

    onChange(handler: (value: never) => unknown): this {
        this.changeHandlers.push(handler as (value: unknown) => unknown);
        return this;
    }

    onClick(handler: () => unknown): this {
        this.clickHandlers.push(handler);
        return this;
    }

    /** Drive the control the way a pick or a click would, and let it settle. */
    async change(value: unknown): Promise<void> {
        this.value = value;
        for (const handler of this.changeHandlers) await handler(value);
    }

    async click(): Promise<void> {
        for (const handler of this.clickHandlers) await handler();
    }
}

/** Every row built so far, so a test can name the control it wants to drive. */
export const createdSettings: Setting[] = [];

export class Setting {
    /** The row itself, with the classes Obsidian puts on it. */
    settingEl: MiniElement;
    nameEl: MiniElement;
    descEl: MiniElement;
    controlEl: MiniElement;
    /** The row's title: how a test names the control it wants. */
    name = '';
    isHeading = false;

    text: ShimComponent | null = null;
    textArea: ShimComponent | null = null;
    toggle: ShimComponent | null = null;
    dropdown: ShimComponent | null = null;
    slider: ShimComponent | null = null;
    button: ShimComponent | null = null;
    extraButton: ShimComponent | null = null;

    constructor(containerEl: MiniElement) {
        this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
        const info = this.settingEl.createDiv({ cls: 'setting-item-info' });
        this.nameEl = info.createDiv({ cls: 'setting-item-name' });
        this.descEl = info.createDiv({ cls: 'setting-item-description' });
        this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
        createdSettings.push(this);
    }

    setName(name: string): this {
        this.name = name;
        this.nameEl.setText(name);
        return this;
    }

    setDesc(desc: string): this {
        this.descEl.setText(desc);
        return this;
    }

    setHeading(): this {
        this.isHeading = true;
        this.settingEl.addClass('setting-item-heading');
        return this;
    }

    setClass(cls: string): this {
        this.settingEl.addClass(cls);
        return this;
    }

    addText(cb: (component: ShimComponent) => unknown): this { this.text = this.component('input'); cb(this.text); return this; }
    addTextArea(cb: (component: ShimComponent) => unknown): this { this.textArea = this.component('textarea'); cb(this.textArea); return this; }
    addToggle(cb: (component: ShimComponent) => unknown): this { this.toggle = this.component('div'); cb(this.toggle); return this; }
    addDropdown(cb: (component: ShimComponent) => unknown): this { this.dropdown = this.component('select'); cb(this.dropdown); return this; }
    addSlider(cb: (component: ShimComponent) => unknown): this { this.slider = this.component('div'); cb(this.slider); return this; }
    addButton(cb: (component: ShimComponent) => unknown): this { this.button = this.component('button'); cb(this.button); return this; }
    addExtraButton(cb: (component: ShimComponent) => unknown): this { this.extraButton = this.component('button'); cb(this.extraButton); return this; }

    private component(tag: 'div' | 'input' | 'select' | 'textarea' | 'button'): ShimComponent {
        return new ShimComponent(this.controlEl, tag);
    }
}

/**
 * The tab base class: a container to render into. `display()` is the plugin
 * tab's own, so the base does nothing with it.
 */
export class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl: MiniElement = new MiniElement('div');

    constructor(app: unknown, plugin: unknown) {
        this.app = app;
        this.plugin = plugin;
    }

    display(): void { /* the plugin's tab renders itself */ }
    hide(): void { /* no-op */ }
}

/** The model field's suggestion popover, without the popover. */
export class AbstractInputSuggest<T> {
    constructor(public app: unknown, public inputEl: unknown) { /* nothing to set up */ }

    setValue(): void { /* the real one writes back into the input */ }
    close(): void { /* the real one hides its popover */ }
    protected getSuggestions(): T[] { return []; }
}
export class ItemView extends Component {
    containerEl: unknown = null;
    contentEl: unknown = null;
    constructor() { super(); }
}

export interface MenuItemStub {
    title: string;
    icon: string | null;
    checked?: boolean;
    click: () => void;
}

/** Items added to the most recently created Menu, so tests can inspect them. */
export const menuItems: MenuItemStub[] = [];

export class Menu {
    constructor() {
        menuItems.length = 0;
    }

    addItem(callback: (item: MenuItemApi) => void): this {
        const item: MenuItemApi = {
            setTitle: (title: string) => { current.title = title; return item; },
            setIcon: (icon: string) => { current.icon = icon; return item; },
            setChecked: (checked: boolean) => { current.checked = checked; return item; },
            onClick: (handler: () => void) => { current.click = handler; return item; },
        };
        const current: MenuItemStub = { title: '', icon: null, click: () => undefined };
        menuItems.push(current);
        callback(item);
        return this;
    }

    addSeparator(): this {
        return this;
    }

    showAtMouseEvent(): void { /* no-op */ }
}

export interface MenuItemApi {
    setTitle(title: string): MenuItemApi;
    setIcon(icon: string): MenuItemApi;
    setChecked(checked: boolean): MenuItemApi;
    onClick(handler: () => void): MenuItemApi;
}

export class MarkdownView {
    containerEl: unknown = null;
    contentEl: unknown = null;
    file: TFile | null = null;
}

export const Platform = { isDesktop: true, isMobile: false, isMobileApp: false };

/**
 * Stand-in for Obsidian's markdown renderer.
 *
 * Tests assert on behaviour and text, not on rendered Markdown, so this writes
 * the raw markdown into the element and resolves. Image embeds are left as
 * text, which is what a test would look for anyway.
 */
export const MarkdownRenderer = {
    render: async (
        _app: unknown,
        markdown: string,
        el: unknown,
        _sourcePath: string,
        _component: unknown
    ): Promise<void> => {
        const target = el as { textContent?: string; setText?: (text: string) => void } | null;
        if (!target) return;
        if (typeof target.setText === 'function') target.setText(markdown);
        else target.textContent = markdown;
    },
};

export function debounce<T extends (...args: never[]) => unknown>(fn: T): T {
    return fn;
}

/**
 * Canned-response seam for the plugin's HTTP paths.
 *
 * `provider-registry` and `chat-client` call Obsidian's `requestUrl`; in a test
 * there is no network, so a test installs a stub with `setRequestUrlStub` and
 * gets back exactly the response the stub returns. With no stub installed the
 * original behaviour — reject, as if the request could not be made — is
 * unchanged, so nothing that relied on it ever sees a different result.
 */
export interface StubRequestUrlRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    throw?: boolean;
}

export interface StubRequestUrlResponse {
    status: number;
    json?: unknown;
    text?: string;
    headers?: Record<string, string>;
}

export type RequestUrlStub = (
    request: StubRequestUrlRequest
) => StubRequestUrlResponse | Promise<StubRequestUrlResponse>;

let requestUrlStub: RequestUrlStub | null = null;

/** Install a canned response for the next call(s), or clear it with null. */
export function setRequestUrlStub(stub: RequestUrlStub | null): void {
    requestUrlStub = stub;
}

export function requestUrl(request: StubRequestUrlRequest): Promise<StubRequestUrlResponse> {
    if (requestUrlStub) return Promise.resolve(requestUrlStub(request));
    return Promise.reject(new Error('requestUrl is not available in tests'));
}
