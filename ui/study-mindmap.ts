/**
 * Spaceforge Study — the mind map, drawn.
 *
 * `models/study-visuals.ts` hands over a hierarchy: a label per node, an
 * optional line of detail, children. This is the surface that lets a reader see
 * the shape of a subject before its parts, and it is deliberately plain DOM —
 * nested divs whose connectors are CSS — so it can live inside whatever host is
 * already open (a 340px sidebar, a dialog, a window) with no library and no
 * canvas.
 *
 * Four decisions are load-bearing:
 *
 *  - **The map never widens its host.** The tree is drawn inside a viewport the
 *    size of the host, with its own scrolling, and the canvas is sized to the
 *    tree, so a tree wider than the host scrolls inside the map instead of
 *    pushing the panel it sits in.
 *  - **The host is measured, never assumed.** A width band chosen from the
 *    host's own box decides how wide a label may be — and whether a branch
 *    fans out into a row — and the same measurement runs again on Fit and on a
 *    resize.
 *  - **No label is cut in silence.** A label wraps — including a label that is
 *    one long token — is capped at the width the host affords, and carries its
 *    full text in its title.
 *  - **A map is read by its edges.** Every node is the same chip, and every
 *    non-root node carries its own connector element: one drawn edge from its
 *    parent, hidden with the subtree it feeds when a branch is collapsed. The
 *    hierarchy is those edges, not indentation.
 *  - **Keyboard first.** The tree follows the ARIA tree pattern: one tab stop on
 *    the viewport, arrow keys move a cursor, Enter collapses or expands,
 *    Escape clears the focus lens. The cursor is the node the arrow keys are
 *    on; the focus is the node the reader asked about by name.
 *
 * Two rules about the controls, learned the hard way:
 *
 *  - **A label is text on a chip, never a control painted over it.** The label
 *    and the caret are `<button>` elements, and Obsidian's own sheet paints
 *    every button that is not `.clickable-icon` — so a reset written as one
 *    class loses, the label is drawn as a chrome button, and the reader sees a
 *    highlight slab over the words. The stylesheet answers with its own rules
 *    one level deeper (`button chrome` note in styles/study-mindmap.css).
 *  - **A map is opened and folded as a whole, not branch by branch.** The
 *    toolbar carries Expand all and Collapse all beside Fit; both are the
 *    reader's own keyboard when they are done (the tree keeps the focus).
 */

import { setIcon } from 'obsidian';
import { StudyMindMap, StudyMindMapNode, mapDepth, mapNodeCount } from '../models/study-visuals';

/** The width band a host affords; the stylesheet reads it to cap label width. */
export type MindMapWidthBand = 'narrow' | 'mid' | 'wide';

/** Host widths (px) at which a wider label becomes affordable. */
export const MIND_MAP_NARROW_MAX = 420;
export const MIND_MAP_MID_MAX = 820;

/**
 * The deepest tier the stylesheet draws. A styling key, not data: the model
 * caps a map at five levels, and anything deeper reads at the last tier rather
 * than shrinking further (the true depth stays on `aria-level`).
 */
const MIND_MAP_STYLE_DEPTH = 5;

/** Path key of the root; children are `<parent key>.<index>`. */
const ROOT_KEY = '0';

/** The band a host this wide can afford. An unmeasured host gets the middle. */
export function mindMapBand(hostWidth: number): MindMapWidthBand {
    if (!(hostWidth > 0)) return 'mid';
    if (hostWidth < MIND_MAP_NARROW_MAX) return 'narrow';
    if (hostWidth < MIND_MAP_MID_MAX) return 'mid';
    return 'wide';
}

/** The host's own width, from whichever measurement it answers. */
export function readHostWidth(host: HTMLElement): number {
    const client = typeof host.clientWidth === 'number' && Number.isFinite(host.clientWidth) ? host.clientWidth : 0;
    if (client > 0) return client;
    if (typeof host.getBoundingClientRect === 'function') {
        const width = host.getBoundingClientRect().width;
        if (Number.isFinite(width) && width > 0) return width;
    }
    const offset = typeof host.offsetWidth === 'number' && Number.isFinite(host.offsetWidth) ? host.offsetWidth : 0;
    return offset > 0 ? offset : 0;
}

/** One node, as it was built and as the tree is walked. */
interface MindMapNodeView {
    /** Path key: unique in the tree, so duplicate labels still have one home. */
    key: string;
    id: string;
    depth: number;
    parentKey: string | null;
    source: StudyMindMapNode;
    branchEl: HTMLElement;
    nodeEl: HTMLElement;
    childrenEl: HTMLElement | null;
    toggleEl: HTMLElement | null;
    labelEl: HTMLElement;
    childKeys: string[];
}

export interface StudyMindMapViewOptions {
    /** Called when the focused node changes; null when focus is cleared. */
    onFocusChange?: (id: string | null) => void;
}

/**
 * The mind map, mounted into a host of any width and height.
 *
 * The host is only ever emptied and filled; every class, listener and custom
 * property the map needs is its own, so a teardown leaves the host exactly as
 * it found it.
 */
export class StudyMindMapView {
    private options: StudyMindMapViewOptions;

    private container: HTMLElement | null = null;
    private map: StudyMindMap | null = null;
    private rootEl: HTMLElement | null = null;
    private viewportEl: HTMLElement | null = null;
    private canvasEl: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private expandAllEl: HTMLButtonElement | null = null;
    private collapseAllEl: HTMLButtonElement | null = null;
    private detailLabelEl: HTMLElement | null = null;
    private detailPathEl: HTMLElement | null = null;
    private detailTextEl: HTMLElement | null = null;
    private detailCloseEl: HTMLButtonElement | null = null;

    private views = new Map<string, MindMapNodeView>();
    private idIndex = new Map<string, string>();
    /** Path keys in document order, with collapsed subtrees left out. */
    private order: string[] = [];
    private collapsed = new Set<string>();
    private activeKey: string | null = null;
    private focusedKey: string | null = null;
    private band: MindMapWidthBand | null = null;
    private bindings: { el: HTMLElement; type: string; handler: EventListener }[] = [];
    private resizeObserver: ResizeObserver | null = null;

    constructor(options: StudyMindMapViewOptions = {}) {
        this.options = options;
    }

    // ------------------------------------------------------------ lifecycle

    /**
     * Build the map inside `container` and return its teardown.
     *
     * The host is emptied first: a map is the whole of what this surface draws.
     */
    mount(container: HTMLElement, map: StudyMindMap): () => void {
        this.unmount();
        this.container = container;
        this.map = map;
        container.empty();

        const rootEl = container.createDiv('sf-mm-map');
        this.rootEl = rootEl;
        this.buildToolbar(rootEl, map);
        this.buildViewport(rootEl);
        const canvas = this.canvasEl as HTMLElement;
        this.buildBranch(canvas, map.root, 1, null, 0);

        this.activeKey = this.views.has(ROOT_KEY) ? ROOT_KEY : null;
        // A map too deep to read whole opens with everything below the second
        // level closed, so the shape of the subject is what the reader sees first.
        this.setCollapsedDepth(defaultCollapsedDepth(map.root));
        this.rebuildOrder();
        this.applyCursor();
        this.applyBand();
        this.updateCount();
        this.renderDetail(null);
        this.watchResize();

        return () => this.unmount();
    }

    /** Tear the map down: listeners first, then the subtree, then the state. */
    unmount(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        for (const binding of this.bindings) binding.el.removeEventListener(binding.type, binding.handler);
        this.bindings = [];
        this.rootEl?.remove();
        this.rootEl = null;
        this.viewportEl = null;
        this.canvasEl = null;
        this.countEl = null;
        this.expandAllEl = null;
        this.collapseAllEl = null;
        this.detailLabelEl = null;
        this.detailPathEl = null;
        this.detailTextEl = null;
        this.detailCloseEl = null;
        this.views.clear();
        this.idIndex.clear();
        this.order = [];
        this.collapsed.clear();
        this.activeKey = null;
        this.focusedKey = null;
        this.band = null;
        this.container = null;
        this.map = null;
    }

    // ------------------------------------------------------------ collapse

    /**
     * Collapse every node at `depth` or deeper, counting the root as depth 1.
     * Zero or less expands the whole map; the root itself is never collapsed.
     */
    setCollapsedDepth(depth: number): void {
        const limit = Number.isFinite(depth) ? depth : Number.MAX_SAFE_INTEGER;
        this.collapsed.clear();
        if (limit > 0) {
            for (const view of this.views.values()) {
                if (view.childKeys.length > 0 && view.depth >= limit) this.collapsed.add(view.key);
            }
        }
        this.applyCollapsedClasses();
        this.rebuildOrder();
        // A fold deeper than the reader's pick hides it: the focus lens and the
        // focus strip are promises about what is on screen, so they go with it.
        if (this.focusedKey && this.order.indexOf(this.focusedKey) < 0) this.clearFocus();
        this.clampCursor();
        this.updateCount();
    }

    /**
     * Open every branch: the whole tree in one view. A map is *read* branch by
     * branch, but it is opened and folded as a whole — 24 nodes one caret at a
     * time is not a reader's map.
     */
    expandAll(): void {
        this.setCollapsedDepth(0);
        this.keepCursorFocus();
    }

    /**
     * Fold every branch below the root, so the map reads as its sections again.
     * A section is opened the way it always is: by its own caret.
     */
    collapseAll(): void {
        this.setCollapsedDepth(2);
        this.keepCursorFocus();
    }

    /**
     * A bulk control is not a keyboard: once the tree has been opened or folded,
     * the focus goes back to where the reader was working, so the next arrow key
     * lands on the cursor and not on a toolbar button.
     */
    private keepCursorFocus(): void {
        if (this.activeKey) {
            this.views.get(this.activeKey)?.nodeEl.focus?.();
            return;
        }
        this.viewportEl?.focus?.();
    }

    private toggleCollapse(key: string): void {
        const view = this.views.get(key);
        if (!view || view.childKeys.length === 0) return;
        if (this.collapsed.has(key)) this.collapsed.delete(key);
        else this.collapsed.add(key);
        this.applyCollapsedClasses();
        this.rebuildOrder();
        // A focus that has just been hidden is a promise the map cannot keep.
        if (this.focusedKey && this.collapsed.has(key) && this.isDescendantOf(this.focusedKey, key)) this.clearFocus();
        this.clampCursor();
        this.updateCount();
    }

    private applyCollapsedClasses(): void {
        for (const view of this.views.values()) {
            const collapsed = this.collapsed.has(view.key);
            view.nodeEl.toggleClass('is-collapsed', collapsed);
            view.childrenEl?.toggleClass('is-collapsed', collapsed);
            if (view.childKeys.length > 0) view.nodeEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            if (view.toggleEl) {
                view.toggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                view.toggleEl.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
            }
        }
    }

    /** Document order of what is on screen, collapsed subtrees left out. */
    private rebuildOrder(): void {
        const order: string[] = [];
        const walk = (key: string): void => {
            const view = this.views.get(key);
            if (!view) return;
            order.push(key);
            if (this.collapsed.has(key)) return;
            for (const child of view.childKeys) walk(child);
        };
        walk(ROOT_KEY);
        this.order = order;
    }

    private isDescendantOf(key: string, ancestorKey: string): boolean {
        let parent = this.views.get(key)?.parentKey ?? null;
        while (parent) {
            if (parent === ancestorKey) return true;
            parent = this.views.get(parent)?.parentKey ?? null;
        }
        return false;
    }

    /** Keep the keyboard cursor on something that is still on screen. */
    private clampCursor(): void {
        if (this.order.length === 0) {
            this.setActive(null);
            return;
        }
        if (this.activeKey && this.order.indexOf(this.activeKey) >= 0) return;
        let candidate = this.activeKey;
        while (candidate && this.order.indexOf(candidate) < 0) {
            candidate = this.views.get(candidate)?.parentKey ?? null;
        }
        this.setActive(candidate ?? this.order[0] ?? null);
    }

    /** What is on screen, and how much of the whole tree that is. */
    private updateCount(): void {
        const countEl = this.countEl;
        if (!countEl || !this.map) return;
        const total = mapNodeCount(this.map.root);
        const visible = this.order.length;
        countEl.setText(visible < total ? `${visible} of ${nodeLabel(total)}` : nodeLabel(total));
        this.syncTools();
    }

    /**
     * A bulk control that cannot do anything is not offered as if it could:
     * Expand all is dead while nothing is folded, and Collapse all is dead while
     * every branch on screen is already folded.
     */
    private syncTools(): void {
        const expandAll = this.expandAllEl;
        const collapseAll = this.collapseAllEl;
        if (expandAll) expandAll.disabled = this.collapsed.size === 0;
        if (collapseAll) collapseAll.disabled = !this.hasOpenBranch();
    }

    /** Whether any branch below the root is still open — what Collapse all folds. */
    private hasOpenBranch(): boolean {
        for (const key of this.order) {
            // The root is never folded by a bulk control, so an open root is not
            // something Collapse all could close.
            if (key === ROOT_KEY) continue;
            const view = this.views.get(key);
            if (view && view.childKeys.length > 0 && !this.collapsed.has(key)) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- focus

    /**
     * Focus a node by id: it and its ancestors stay bright, everything else
     * dims, and its detail is shown under the tree. An id this map does not
     * know clears the focus instead of throwing.
     */
    focusNode(id: string): void {
        const key = this.idIndex.get(id) ?? null;
        const view = key ? this.views.get(key) : undefined;
        if (!key || !view) {
            this.clearFocus();
            return;
        }

        // A focus nobody can see is not focus: open the way to the node first.
        let opened = false;
        let parent = view.parentKey;
        while (parent) {
            if (this.collapsed.delete(parent)) opened = true;
            parent = this.views.get(parent)?.parentKey ?? null;
        }
        if (opened) {
            this.applyCollapsedClasses();
            this.rebuildOrder();
            this.updateCount();
            this.clampCursor();
        }

        this.focusedKey = key;
        for (const candidate of this.views.values()) {
            const focused = candidate.key === key;
            candidate.nodeEl.toggleClass('is-focused', focused);
            candidate.nodeEl.toggleClass('is-ancestor', !focused && this.isDescendantOf(key, candidate.key));
            candidate.nodeEl.setAttribute('aria-selected', focused ? 'true' : 'false');
        }
        this.rootEl?.addClass('is-focus-mode');
        this.renderDetail(view);
        // The cursor follows the focus, so Enter lands where the reader is.
        this.setActive(key);
        view.nodeEl.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        this.options.onFocusChange?.(view.id);
    }

    /** Drop the focus lens: everything reads at full strength again. */
    clearFocus(): void {
        const had = this.focusedKey !== null;
        this.focusedKey = null;
        if (had) {
            for (const view of this.views.values()) {
                view.nodeEl.removeClass('is-focused');
                view.nodeEl.removeClass('is-ancestor');
                view.nodeEl.setAttribute('aria-selected', 'false');
            }
        }
        this.rootEl?.removeClass('is-focus-mode');
        this.renderDetail(null);
        if (had) this.options.onFocusChange?.(null);
    }

    /** The id of the focused node, or null while nothing is focused. */
    getFocusedId(): string | null {
        return this.focusedKey ? this.views.get(this.focusedKey)?.id ?? null : null;
    }

    /** The id of the node the keyboard cursor is on, or null before mount. */
    getActiveId(): string | null {
        return this.activeKey ? this.views.get(this.activeKey)?.id ?? null : null;
    }

    // ------------------------------------------------------------- keyboard

    /**
     * Handle one keyboard event for the tree. Returns true when the key was
     * the map's business (the caller then prevents the default).
     *
     * Arrows move the cursor, Home/End jump to either end, Enter collapses or
     * expands the node it is on (on a leaf it focuses it, since there is
     * nothing to collapse), and Escape clears the focus.
     */
    handleKey(event: KeyboardEvent): boolean {
        const key = event?.key ?? '';
        if (event && (event.ctrlKey || event.metaKey || event.altKey)) return false;
        if (this.order.length === 0) return false;
        switch (key) {
            case 'ArrowDown':
                return this.moveCursor(1);
            case 'ArrowUp':
                return this.moveCursor(-1);
            case 'ArrowRight':
                return this.expandOrEnter();
            case 'ArrowLeft':
                return this.collapseOrLeave();
            case 'Enter':
                return this.activateCursor();
            case 'Home':
                return this.moveToEdge(0);
            case 'End':
                return this.moveToEdge(-1);
            case 'Escape':
                return this.clearFocusFromKey();
            default:
                return false;
        }
    }

    private moveCursor(delta: number): boolean {
        const current = this.activeKey ? this.order.indexOf(this.activeKey) : -1;
        const next = current < 0
            ? (delta > 0 ? 0 : this.order.length - 1)
            : Math.min(this.order.length - 1, Math.max(0, current + delta));
        this.setActive(this.order[next] ?? null);
        return true;
    }

    private moveToEdge(index: number): boolean {
        const key = index < 0 ? this.order[this.order.length - 1] : this.order[0];
        if (!key) return false;
        this.setActive(key);
        return true;
    }

    private expandOrEnter(): boolean {
        const view = this.activeKey ? this.views.get(this.activeKey) : undefined;
        if (!view || view.childKeys.length === 0) return false;
        if (this.collapsed.has(view.key)) this.toggleCollapse(view.key);
        else this.setActive(view.childKeys[0] ?? view.key);
        return true;
    }

    private collapseOrLeave(): boolean {
        const view = this.activeKey ? this.views.get(this.activeKey) : undefined;
        if (!view) return false;
        if (view.childKeys.length > 0 && !this.collapsed.has(view.key)) {
            this.toggleCollapse(view.key);
            return true;
        }
        if (view.parentKey) {
            this.setActive(view.parentKey);
            return true;
        }
        return false;
    }

    private activateCursor(): boolean {
        const view = this.activeKey ? this.views.get(this.activeKey) : undefined;
        if (!view) return false;
        if (view.childKeys.length > 0) this.toggleCollapse(view.key);
        else this.focusNode(view.id);
        return true;
    }

    private clearFocusFromKey(): boolean {
        if (this.focusedKey === null) return false;
        this.clearFocus();
        return true;
    }

    private setActive(key: string | null): void {
        if (this.activeKey && this.activeKey !== key) this.views.get(this.activeKey)?.nodeEl.removeClass('is-cursor');
        this.activeKey = key;
        const view = key ? this.views.get(key) : undefined;
        if (!view) return;
        view.nodeEl.addClass('is-cursor');
        view.nodeEl.focus?.();
    }

    private applyCursor(): void {
        if (this.activeKey) this.views.get(this.activeKey)?.nodeEl.addClass('is-cursor');
    }

    // ------------------------------------------------------------------ fit

    /**
     * Re-fit the map to the host it is in: measure it again for the label
     * width, and start the tree at its own origin so the root is where the
     * reader looks first. The reader's own collapsing is left alone.
     */
    fit(): void {
        this.applyBand();
        const viewport = this.viewportEl;
        if (viewport) {
            viewport.scrollLeft = 0;
            viewport.scrollTop = 0;
        }
        this.views.get(ROOT_KEY)?.nodeEl.scrollIntoView?.({ block: 'nearest', inline: 'start' });
    }

    private applyBand(): void {
        const container = this.container;
        const rootEl = this.rootEl;
        if (!container || !rootEl) return;
        const band = mindMapBand(readHostWidth(container));
        if (band === this.band) return;
        rootEl.removeClass('is-narrow');
        rootEl.removeClass('is-mid');
        rootEl.removeClass('is-wide');
        rootEl.addClass(`is-${band}`);
        this.band = band;
        this.applyRowLayout();
    }

    /**
     * A branch with more than two children fans out into a row when the host is
     * wide enough to afford it and stays a column when it is not — so the map
     * uses a wide panel's width instead of running down one thin column. It is
     * decided from the band, so Fit and a resize move the rows with the host.
     */
    private applyRowLayout(): void {
        const row = this.band === 'wide';
        for (const view of this.views.values()) {
            if (!view.childrenEl) continue;
            view.childrenEl.toggleClass('is-row', row && view.childKeys.length > 2);
        }
    }

    private watchResize(): void {
        const container = this.container;
        if (!container || typeof ResizeObserver === 'undefined') return;
        this.resizeObserver = new ResizeObserver(() => this.applyBand());
        this.resizeObserver.observe(container);
    }

    // --------------------------------------------------------------- markup

    private bind(el: HTMLElement, type: string, handler: (event: Event) => void): void {
        const listener = handler as EventListener;
        el.addEventListener(type, listener);
        this.bindings.push({ el, type, handler: listener });
    }

    private buildToolbar(rootEl: HTMLElement, map: StudyMindMap): void {
        const toolbar = rootEl.createDiv('sf-mm-toolbar');
        const title = toolbar.createDiv('sf-mm-title');
        title.setText(map.title);
        title.setAttribute('title', map.title);
        this.countEl = toolbar.createDiv('sf-mm-count');
        const tools = toolbar.createDiv('sf-mm-tools');

        // The bulk controls come first: a map is opened as a whole far more often
        // than it is fitted to its panel. Both are disabled by `syncTools` when
        // they would do nothing at all.
        this.expandAllEl = this.buildTool(tools, 'Expand all', 'sf-mm-expand-all', 'Open every branch', () => this.expandAll());
        this.collapseAllEl = this.buildTool(tools, 'Collapse all', 'sf-mm-collapse-all', 'Fold every branch below the root', () => this.collapseAll());
        this.buildTool(tools, 'Fit', 'sf-mm-fit', 'Fit the map to the panel it is in', () => this.fit());
    }

    /** One toolbar control: a button, its tooltip, and what it does. */
    private buildTool(parent: HTMLElement, label: string, cls: string, tooltip: string, run: () => void): HTMLButtonElement {
        const button = parent.createEl('button', { cls: `sf-mm-btn ${cls}`, text: label });
        button.setAttribute('type', 'button');
        button.setAttribute('title', tooltip);
        this.bind(button, 'click', () => run());
        return button;
    }

    private buildViewport(rootEl: HTMLElement): void {
        const viewport = rootEl.createDiv('sf-mm-viewport');
        this.viewportEl = viewport;
        viewport.setAttribute('role', 'tree');
        viewport.setAttribute('aria-label', 'Mind map');
        viewport.setAttribute('tabindex', '0');
        this.bind(viewport, 'keydown', event => {
            const keyboard = event as KeyboardEvent;
            const target = keyboard.target as HTMLElement | null;
            // A button inside the tree answers Enter itself (its own click):
            // toggling the cursor node as well would be two actions for one key.
            const onControl = !!target && typeof target.tagName === 'string' && target.tagName.toUpperCase() === 'BUTTON';
            if (onControl && keyboard.key === 'Enter') return;
            if (this.handleKey(keyboard)) keyboard.preventDefault();
        });

        const canvas = viewport.createDiv('sf-mm-canvas');
        // A wrapper, not a thing: the tree items below it are what AT reads.
        canvas.setAttribute('role', 'presentation');
        this.canvasEl = canvas;

        const detail = rootEl.createDiv('sf-mm-detail');
        const head = detail.createDiv('sf-mm-detail-head');
        this.detailLabelEl = head.createDiv('sf-mm-detail-label');
        this.detailLabelEl.setAttribute('aria-live', 'polite');
        const close = head.createEl('button', { cls: 'sf-mm-btn sf-mm-detail-close', text: 'Clear' });
        close.setAttribute('type', 'button');
        close.setAttribute('title', 'Clear the focus and show the whole map');
        this.bind(close, 'click', () => this.clearFocus());
        this.detailCloseEl = close as HTMLButtonElement;
        this.detailPathEl = detail.createDiv('sf-mm-detail-path');
        this.detailTextEl = detail.createDiv('sf-mm-detail-text');
    }

    /** Draw one node and, below it, its children — as deep as the map goes. */
    private buildBranch(parent: HTMLElement, node: StudyMindMapNode, depth: number, parentKey: string | null, index: number): string {
        const key = parentKey === null ? ROOT_KEY : `${parentKey}.${index}`;
        const childrenOfNode = node.children ?? [];

        const branch = parent.createDiv('sf-mm-branch');
        branch.setAttribute('role', 'presentation');
        if (depth === 1) branch.addClass('is-root');

        // Every node is the same chip; the root is told apart by the accent its
        // border and fill carry, never by being the only boxed thing.
        const nodeEl = branch.createDiv('sf-mm-node sf-mm-node-chip');
        nodeEl.setAttribute('data-node-id', node.id);
        nodeEl.setAttribute('data-depth', String(Math.min(depth, MIND_MAP_STYLE_DEPTH)));
        nodeEl.setAttribute('role', 'treeitem');
        nodeEl.setAttribute('aria-level', String(depth));
        nodeEl.setAttribute('aria-selected', 'false');
        nodeEl.setAttribute('tabindex', '-1');
        // A treeitem that has children says whether they are on screen: the
        // caret is a control, and this is the state a screen reader reads.
        if (childrenOfNode.length > 0) nodeEl.setAttribute('aria-expanded', 'true');
        // A node is clickable as a whole so the row is a target, not just its
        // text; the label and the toggle stop the click on their way up.
        this.bind(nodeEl, 'click', () => this.activate(key));

        // The edge from the parent: one element per non-root node, drawn by the
        // stylesheet inside the node it feeds — so collapsing the branch above
        // takes the edge with it.
        if (parentKey !== null) {
            const connectorEl = nodeEl.createSpan('sf-mm-connector');
            connectorEl.setAttribute('aria-hidden', 'true');
        }

        let toggleEl: HTMLElement | null = null;
        if (childrenOfNode.length > 0) {
            toggleEl = nodeEl.createEl('button', { cls: 'sf-mm-toggle' });
            toggleEl.setAttribute('type', 'button');
            toggleEl.setAttribute('aria-expanded', 'true');
            toggleEl.setAttribute('aria-label', 'Collapse');
            toggleEl.setAttribute('title', 'Collapse or expand this branch');
            // The tree is the only tab stop (the ARIA tree pattern): a reader
            // walks it with the arrow keys and folds with Enter, so the caret
            // and the label are reached from the cursor, not from the Tab key.
            toggleEl.setAttribute('tabindex', '-1');
            // A drawn caret, not a glyph: the triangle character is rendered by
            // whatever font happens to be in force and sits off-centre in it.
            setIcon(toggleEl.createSpan('sf-mm-toggle-mark'), 'chevron-right');
            this.bind(toggleEl, 'click', event => {
                event.stopPropagation();
                this.toggleCollapse(key);
            });
        }

        const labelEl = nodeEl.createEl('button', { cls: 'sf-mm-label' });
        labelEl.setAttribute('type', 'button');
        // A button, so a click is a click and a title is a title — but not a tab
        // stop: 24 labels would be 24 stops between the reader and the next
        // control, in a surface that is driven by the arrow keys.
        labelEl.setAttribute('tabindex', '-1');
        labelEl.setText(node.label);
        // The whole label, always: the box may be narrowed, the text may not.
        labelEl.setAttribute('title', node.label);
        this.bind(labelEl, 'click', event => {
            event.stopPropagation();
            this.focusNode(node.id);
        });

        const childKeys: string[] = [];
        let childrenEl: HTMLElement | null = null;
        if (childrenOfNode.length > 0) {
            childrenEl = branch.createDiv('sf-mm-children');
            childrenEl.setAttribute('role', 'group');
            childrenOfNode.forEach((child, childIndex) => {
                childKeys.push(this.buildBranch(childrenEl as HTMLElement, child, depth + 1, key, childIndex));
            });
        }

        this.views.set(key, { key, id: node.id, depth, parentKey, source: node, branchEl: branch, nodeEl, childrenEl, toggleEl, labelEl, childKeys });
        if (!this.idIndex.has(node.id)) this.idIndex.set(node.id, key);
        return key;
    }

    /** Row click: collapse what has children, focus what has none. */
    private activate(key: string): void {
        const view = this.views.get(key);
        if (!view) return;
        if (view.childKeys.length > 0) this.toggleCollapse(key);
        else this.focusNode(view.id);
    }

    /** The detail panel: the focused node, where it sits, and what it means. */
    private renderDetail(view: MindMapNodeView | null): void {
        const labelEl = this.detailLabelEl;
        const pathEl = this.detailPathEl;
        const textEl = this.detailTextEl;
        if (!labelEl || !pathEl || !textEl) return;

        if (!view) {
            labelEl.setText('No node selected');
            labelEl.setAttribute('title', 'No node selected');
            // The count is the toolbar's badge, live as branches fold: the strip
            // does not repeat it. It goes quiet and reads as the hint it is.
            pathEl.setText('');
            textEl.setText('Select a node to read what it means.');
            this.rootEl?.addClass('is-idle');
            if (this.detailCloseEl) this.detailCloseEl.disabled = true;
            return;
        }

        const path: string[] = [];
        let key: string | null = view.key;
        while (key) {
            const ancestor = this.views.get(key);
            if (!ancestor) break;
            path.unshift(ancestor.source.label);
            key = ancestor.parentKey;
        }

        labelEl.setText(view.source.label);
        labelEl.setAttribute('title', view.source.label);
        pathEl.setText(path.join(' › '));
        textEl.setText(view.source.detail ?? 'No extra detail for this node.');
        this.rootEl?.removeClass('is-idle');
        if (this.detailCloseEl) this.detailCloseEl.disabled = false;
    }
}

/** `node`/`nodes`, so a one-node map does not read as a defect. */
function nodeLabel(count: number): string {
    return `${count} node${count === 1 ? '' : 's'}`;
}

/** The default collapse for a map too deep to show whole. */
export function defaultCollapsedDepth(root: StudyMindMapNode): number {
    return mapDepth(root) > 3 ? 2 : 0;
}
