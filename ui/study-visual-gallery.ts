import { setIcon } from 'obsidian';
import { StudyVisual } from '../models/study-visuals';
import { StudyVisualBoardView } from './study-visual-board';
import { StudyVisualDiagramView } from './study-visual-diagram';
import { StudyVisualGraphView } from './study-visual-graph';
import { StudyVisualLabView } from './study-visual-lab';
import { StudySequenceState, StudyVisualSequenceView } from './study-visual-sequence';

export interface StudyGalleryAssetState { lab?: Record<string, number>; sequence?: StudySequenceState }
export interface StudyGalleryState {
    open?: string[];
    assets?: Record<string, StudyGalleryAssetState>;
    onChange?: (open: string[]) => void;
    onAssetChange?: () => void;
}

/**
 * The visualise gallery: several assets, each one interactive, each one teaching
 * one thing.
 *
 * This is deliberately not a table of the material and not a second mind map.
 * Every card is a thing the reader *operates* — move a parameter and watch the
 * answer change, open a part of a picture, put a shuffled order back together,
 * hover a point on a curve, reveal a comparison cell by cell, step a process.
 * The first card is open and the rest wait collapsed, so the gallery reads as a
 * set of assets rather than one long page.
 *
 * Each asset renders its own teach line: the renderer knows how to place it
 * against its own component, and a second copy here read as a stutter.
 */

const KIND_LABELS: Record<string, string> = {
    lab: 'Lab',
    diagram: 'Diagram',
    sequence: 'Sequence',
    graph: 'Graph',
    matrix: 'Matrix',
    compare: 'Comparison',
    flow: 'Flow',
    cycle: 'Cycle',
    timeline: 'Timeline',
};

export class StudyVisualGalleryView {
    private root: HTMLElement | null = null;
    private teardowns: (() => void)[] = [];
    private cardTeardowns = new Map<HTMLElement, () => void>();
    private open = new Set<string>();
    private onChange: ((open: string[]) => void) | undefined;
    private state: StudyGalleryState = {};
    private closers = new Map<HTMLElement, () => void>();
    private collapseAllEl: HTMLButtonElement | null = null;

    /** Mount the gallery; returns its teardown. */
    mount(container: HTMLElement, visuals: StudyVisual[], state: StudyGalleryState = {}): () => void {
        this.state = state;
        this.onChange = state.onChange;
        this.root = container.createDiv('sf-vg');
        if (visuals.length === 0) {
            this.root.createDiv({ cls: 'sf-vg-empty', text: 'No visual assets in this pack yet.' });
            return () => this.destroy();
        }
        const toolbar = this.root.createDiv('sf-vg-toolbar');
        toolbar.createDiv({ cls: 'sf-vg-count', text: `${visuals.length} visual asset${visuals.length === 1 ? '' : 's'}` });
        if (visuals.length > 1) {
            this.collapseAllEl = toolbar.createEl('button', { cls: 'sf-vg-collapse-all', text: 'Collapse all' });
            this.collapseAllEl.setAttribute('type', 'button');
            this.collapseAllEl.addEventListener('click', () => this.collapseAll());
        }
        // the first asset opens; the reader opens the rest
        this.open = new Set(state.open ?? [this.keyOf(visuals[0], 0)]);

        visuals.forEach((visual, index) => this.renderCard(visual, index));
        this.updateToolbar();
        return () => this.destroy();
    }

    private keyOf(visual: StudyVisual, _index: number): string {
        return JSON.stringify(visual);
    }

    private renderCard(visual: StudyVisual, index: number): void {
        const root = this.root;
        if (!root) return;
        const key = this.keyOf(visual, index);
        const card = root.createDiv('sf-vg-card');
        const isOpen = this.open.has(key);
        if (isOpen) card.addClass('is-open');

        const head = card.createEl('button', { cls: 'sf-vg-head' });
        head.setAttribute('aria-expanded', String(isOpen));
        head.createSpan({ cls: 'sf-vg-kind', text: KIND_LABELS[visual.kind] ?? visual.kind });
        head.createSpan({ cls: 'sf-vg-title', text: visual.title });
        const chevron = head.createSpan('sf-vg-chevron');

        const body = card.createDiv('sf-vg-body');
        let teardown: (() => void) | null = null;
        const setOpen = (open: boolean) => {
            card.classList.toggle('is-open', open);
            head.setAttribute('aria-expanded', String(open));
            chevron.empty();
            setIcon(chevron, open ? 'chevron-down' : 'chevron-right');
            if (open) {
                if (!teardown) {
                    // One malformed asset must not take the gallery down with it.
                    // The model's data is coerced, but a renderer can still meet
                    // a host or a value it cannot draw; leave the other cards
                    // usable and say so in this card.
                    try {
                        teardown = this.mountAsset(body, visual);
                    } catch {
                        body.empty();
                        body.createDiv({ cls: 'sf-vg-error', text: 'This visual could not be drawn. Open another asset, or regenerate the material.' });
                        teardown = () => { body.empty(); };
                    }
                }
            } else if (teardown) {
                // A component that is merely hidden is still a component: it
                // measures its host (zero, when hidden) and holds listeners.
                teardown();
                teardown = null;
                body.empty();
            }
        };
        setOpen(isOpen);
        this.cardTeardowns.set(card, () => {
            teardown?.();
            teardown = null;
        });
        this.closers.set(card, () => setOpen(false));
        head.addEventListener('click', () => {
            const nowOpen = !this.open.has(key);
            if (nowOpen) this.open.add(key);
            else this.open.delete(key);
            this.onChange?.([...this.open]);
            setOpen(nowOpen);
            this.updateToolbar();
        });
    }

    /** Close every card: the reader asked for the index back. */
    private collapseAll(): void {
        for (const close of this.closers.values()) close();
        this.open.clear();
        this.onChange?.([]);
        this.updateToolbar();
    }

    private updateToolbar(): void {
        if (this.collapseAllEl) this.collapseAllEl.disabled = this.open.size === 0;
    }

    /** One asset, in the renderer that owns its kind. */
    private mountAsset(body: HTMLElement, visual: StudyVisual): () => void {
        const assets = this.state.assets ??= {};
        const state = assets[this.keyOf(visual, 0)] ??= {};
        switch (visual.kind) {
            case 'lab':
                return new StudyVisualLabView().mount(body, visual, { values: state.lab, onChange: values => { state.lab = values; this.state.onAssetChange?.(); } });
            case 'diagram':
                return new StudyVisualDiagramView().mount(body, visual);
            case 'sequence':
                return new StudyVisualSequenceView().mount(body, visual, { value: state.sequence, onChange: value => { state.sequence = value; this.state.onAssetChange?.(); } });
            case 'graph':
                return new StudyVisualGraphView().mount(body, visual);
            default:
                return new StudyVisualBoardView().mount(body, [visual]);
        }
    }

    private destroy(): void {
        for (const teardown of this.cardTeardowns.values()) {
            try {
                teardown();
            } catch {
                // one broken asset must not stop the rest being taken down
            }
        }
        this.cardTeardowns.clear();
        this.closers.clear();
        this.collapseAllEl = null;
        for (const teardown of this.teardowns.splice(0)) {
            try {
                teardown();
            } catch {
                // one broken asset must not stop the rest being taken down
            }
        }
        this.open.clear();
        this.root?.remove();
        this.root = null;
    }
}
