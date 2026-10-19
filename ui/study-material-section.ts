import { setIcon } from 'obsidian';
import { StudyVisualPack } from '../models/study-visuals';
import { StudyMindMapView } from './study-mindmap';
import { StudySummaryView } from './study-visual-board';
import { StudyVisualGalleryView } from './study-visual-gallery';

/**
 * The study material section: one row of tabs, one host, three surfaces.
 *
 * The map, the boards and the summary are made on demand and kept on the plan,
 * so this section owns only what is on screen — it asks its host to generate,
 * and the host decides where the result is stored. Everything the reader sees
 * about freshness ("made from this note", "out of date") comes from the host's
 * two facts, `pack` and `stale`, rather than from a timestamp of its own.
 */

/** The three material surfaces, one at a time. */
export type StudyMaterialView = 'mindmap' | 'board' | 'summary';

export interface StudyMaterialHost {
    /**
     * The pack on the plan right now, if one has been made, and whether the note
     * has changed since. A method rather than two getters so the host can be a
     * plain object built with arrow functions — and so one call gives a
     * consistent pair rather than two reads that could disagree.
     */
    snapshot: () => { pack: StudyVisualPack | null; stale: boolean };
    /** Make (or remake) the pack. Returns null when the model gave nothing usable. */
    generate: () => Promise<StudyVisualPack | null>;
}

export class StudyMaterialSection {
    private rootEl: HTMLElement | null = null;
    private stateEl: HTMLElement | null = null;
    private generateEl: HTMLButtonElement | null = null;
    private tabs = new Map<StudyMaterialView, HTMLButtonElement>();
    private hostEl: HTMLElement | null = null;
    private teardown: (() => void) | null = null;
    private view: StudyMaterialView = 'mindmap';
    private busy = false;
    private host: StudyMaterialHost | null = null;

    /** Build the section inside `container`. */
    mount(container: HTMLElement, host: StudyMaterialHost): void {
        this.host = host;
        this.rootEl = container.createDiv('sf-study-material');
        const head = this.rootEl.createDiv('sf-study-material-head');
        head.createDiv({ cls: 'sf-study-section-title', text: 'Study material' });
        this.stateEl = head.createDiv('sf-study-material-state');
        this.generateEl = head.createEl('button', { cls: 'sf-btn sf-study-material-generate' });
        this.generateEl.addEventListener('click', () => void this.make());

        const tabRow = this.rootEl.createDiv('sf-study-material-tabs');
        const views: [StudyMaterialView, string, string][] = [
            ['mindmap', 'Mind map', 'git-fork'],
            ['board', 'Visualize', 'layout-grid'],
            ['summary', 'Summary', 'list'],
        ];
        this.tabs.clear();
        for (const [view, label, icon] of views) {
            const button = tabRow.createEl('button', { cls: 'sf-study-material-tab' });
            const iconEl = button.createSpan('sf-study-material-tab-icon');
            setIcon(iconEl, icon);
            button.createSpan({ cls: 'sf-study-material-tab-label', text: label });
            button.addEventListener('click', () => {
                if (!this.host?.snapshot().pack) return;
                this.view = view;
                this.show();
            });
            this.tabs.set(view, button);
        }

        this.hostEl = this.rootEl.createDiv('sf-study-material-host');
        this.refresh();
    }

    /** Re-read the host's facts and repaint the state line, tabs and surface. */
    refresh(): void {
        const host = this.host;
        if (!host || !this.stateEl || !this.generateEl) return;
        const { pack, stale } = host.snapshot();
        this.stateEl.removeClass('is-stale');
        this.stateEl.removeClass('is-error');
        if (!pack) {
            this.stateEl.setText('A mind map, visual boards and a condensed summary, drawn from this note.');
        } else if (stale) {
            this.stateEl.setText('Out of date — this note changed since it was made.');
            this.stateEl.addClass('is-stale');
        } else {
            const boards = pack.visuals.length;
            this.stateEl.setText(`${boards} visual asset${boards === 1 ? '' : 's'} · ${pack.summary.bullets.length} bullets · made from this note`);
        }
        this.generateEl.setText(pack ? 'Regenerate' : 'Make it');
        this.generateEl.removeAttribute('disabled');
        this.show();
    }

    /** The one surface that is on screen, and the old one always torn down. */
    private show(): void {
        this.teardown?.();
        this.teardown = null;
        const hostEl = this.hostEl;
        if (!hostEl) return;
        hostEl.empty();
        const pack = this.host?.snapshot().pack ?? null;
        for (const [view, button] of this.tabs) {
            button.classList.toggle('is-selected', pack !== null && view === this.view);
            button.classList.toggle('is-disabled', pack === null);
        }
        if (!pack) {
            hostEl.createDiv({ cls: 'sf-study-material-empty', text: 'Nothing made yet — press Make it, and the note becomes a map, boards and a summary.' });
            return;
        }
        if (this.view === 'mindmap') this.teardown = new StudyMindMapView().mount(hostEl, pack.mindMap);
        else if (this.view === 'board') this.teardown = new StudyVisualGalleryView().mount(hostEl, pack.visuals);
        else this.teardown = new StudySummaryView().mount(hostEl, pack.summary);
    }

    /**
     * Ask the host for a pack, once.
     *
     * The button is disabled for the duration and a second press is ignored:
     * the service is single-flight too, but a section that fires twice would
     * still paint two answers.
     */
    private async make(): Promise<void> {
        const host = this.host;
        if (!host || this.busy || !this.stateEl || !this.generateEl) return;
        this.busy = true;
        this.generateEl.setAttribute('disabled', 'true');
        this.stateEl.removeClass('is-stale');
        this.stateEl.removeClass('is-error');
        this.stateEl.setText('Reading the note and drawing…');
        try {
            const pack = await host.generate();
            if (!pack) {
                this.stateEl.addClass('is-error');
                this.stateEl.setText('The model did not return usable material. Try again.');
                return;
            }
            this.refresh();
        } catch (error) {
            this.stateEl.addClass('is-error');
            this.stateEl.setText(error instanceof Error ? error.message : 'Could not reach a model.');
        } finally {
            this.busy = false;
            this.generateEl.removeAttribute('disabled');
        }
    }

    /** Take the section down, surfaces included. */
    destroy(): void {
        this.teardown?.();
        this.teardown = null;
        this.tabs.clear();
        this.rootEl?.remove();
        this.rootEl = null;
        this.stateEl = null;
        this.generateEl = null;
        this.hostEl = null;
        this.host = null;
    }
}
