import { setIcon } from 'obsidian';
import { StudyVisual } from '../models/study-visuals';
import { StudyVisualBoardView } from './study-visual-board';
import { StudyVisualDiagramView } from './study-visual-diagram';
import { StudyVisualGraphView } from './study-visual-graph';
import { StudyVisualLabView } from './study-visual-lab';
import { StudyVisualSequenceView } from './study-visual-sequence';

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

    /** Mount the gallery; returns its teardown. */
    mount(container: HTMLElement, visuals: StudyVisual[]): () => void {
        this.root = container.createDiv('sf-vg');
        if (visuals.length === 0) {
            this.root.createDiv({ cls: 'sf-vg-empty', text: 'No visual assets in this pack yet.' });
            return () => this.destroy();
        }
        this.root.createDiv({ cls: 'sf-vg-count', text: `${visuals.length} visual asset${visuals.length === 1 ? '' : 's'}` });
        // the first asset opens; the reader opens the rest
        this.open.add(this.keyOf(visuals[0], 0));

        visuals.forEach((visual, index) => this.renderCard(visual, index));
        return () => this.destroy();
    }

    private keyOf(visual: StudyVisual, index: number): string {
        return `${visual.kind}:${index}`;
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
                if (!teardown) teardown = this.mountAsset(body, visual);
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
        head.addEventListener('click', () => {
            const nowOpen = !this.open.has(key);
            if (nowOpen) this.open.add(key);
            else this.open.delete(key);
            setOpen(nowOpen);
        });
    }

    /** One asset, in the renderer that owns its kind. */
    private mountAsset(body: HTMLElement, visual: StudyVisual): () => void {
        switch (visual.kind) {
            case 'lab':
                return new StudyVisualLabView().mount(body, visual);
            case 'diagram':
                return new StudyVisualDiagramView().mount(body, visual);
            case 'sequence':
                return new StudyVisualSequenceView().mount(body, visual);
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
