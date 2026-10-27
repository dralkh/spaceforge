import { ItemView, WorkspaceLeaf } from 'obsidian';

/** The registered view type of a window that holds the review session itself. */
export const REVIEW_WINDOW_VIEW = 'spaceforge-review-window';

/**
 * A window for the review session.
 *
 * The session's surfaces are plain DOM — a bar and a dock — so this view is only
 * a place to put them: a leaf of its own, in a window of its own, with the note
 * left in the pane the reader was working in. It knows nothing about the flow,
 * which is why closing it reports back through a callback instead of reaching
 * into the controller.
 */
export class ReviewWindowView extends ItemView {
    private sessionEl: HTMLElement | null = null;
    private readonly onWindowClosed: () => void;
    /** True when this leaf is the workspace split beside the note, not a popout. */
    private splitHost = false;

    constructor(leaf: WorkspaceLeaf, onWindowClosed: () => void = () => undefined) {
        super(leaf);
        this.onWindowClosed = onWindowClosed;
    }

    getViewType(): string {
        return REVIEW_WINDOW_VIEW;
    }

    /**
     * Remember which kind of leaf this is. The controller adopts an existing
     * split after a reload; without this the view state was `{}` and the only
     * way to tell a split from a popout window was gone.
     */
    getState(): Record<string, unknown> {
        return this.splitHost ? { spaceforgeSplit: true } : {};
    }

    setState(state: unknown, _result: unknown): Promise<void> {
        const record = state as { spaceforgeSplit?: unknown } | null;
        this.splitHost = record?.spaceforgeSplit === true;
        return Promise.resolve();
    }

    getDisplayText(): string {
        return 'Review';
    }

    getIcon(): string {
        return 'calendar-clock';
    }

    /** The element the session's bar and dock mount into. */
    getSessionHostEl(): HTMLElement {
        this.sessionEl ??= this.contentEl.createDiv({ cls: 'sf-review-window' });
        return this.sessionEl;
    }

    onOpen(): Promise<void> {
        this.contentEl.addClass('sf-review-window-content');
        this.getSessionHostEl();
        return Promise.resolve();
    }

    onClose(): Promise<void> {
        this.onWindowClosed();
        return Promise.resolve();
    }
}
