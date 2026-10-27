import { setIcon } from 'obsidian';
import { StudyVisualPack } from '../models/study-visuals';
import { StudyMindMapView } from './study-mindmap';
import { StudySummaryView } from './study-visual-board';
import { StudyGalleryAssetState, StudyVisualGalleryView } from './study-visual-gallery';

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

/** Stable, short identity for one material pack's UI state. */
export function studyPackStateKey(pack: StudyVisualPack): string {
    return `${pack.sourceHash}:${pack.generatedAt}:${pack.visuals.length}`;
}

export interface StudyMaterialState {
    view?: StudyMaterialView;
    packs?: Record<string, { map?: { collapsed: string[]; focused: string | null }; gallery?: string[]; assets?: Record<string, StudyGalleryAssetState> }>;
}

export interface StudyMaterialHost {
    /**
     * The pack on the plan right now, if one has been made, and whether the note
     * has changed since. A method rather than two getters so the host can be a
     * plain object built with arrow functions — and so one call gives a
     * consistent pair rather than two reads that could disagree.
     */
    snapshot: () => { pack: StudyVisualPack | null; stale: boolean; preparation?: { state: string; message: string; materials: string } | null };
    /** Make (or remake) the pack. Returns null when the model gave nothing usable. */
    generate: () => Promise<StudyVisualPack | null>;
    state?: StudyMaterialState;
    saveState?: () => void;
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
    private surfaces = new Map<StudyMaterialView, { el: HTMLElement; teardown: () => void }>();
    private renderedPack: StudyVisualPack | null = null;
    private externalNavigation = false;

    /** Build the section inside `container`. */
    mount(container: HTMLElement, host: StudyMaterialHost, options: { externalNavigation?: boolean } = {}): void {
        this.host = host;
        this.externalNavigation = options.externalNavigation === true;
        this.view = host.state?.view ?? 'mindmap';
        this.rootEl = container.createDiv('sf-study-material');
        const head = this.rootEl.createDiv('sf-study-material-head');
        head.createDiv({ cls: 'sf-study-section-title', text: 'Study material' });
        this.stateEl = head.createDiv('sf-study-material-state');
        this.generateEl = head.createEl('button', { cls: 'sf-btn sf-study-material-generate' });
        this.generateEl.addEventListener('click', () => void this.make());

        const tabRow = this.externalNavigation ? null : this.rootEl.createDiv('sf-study-material-tabs');
        const views: [StudyMaterialView, string, string][] = [
            ['mindmap', 'Mind map', 'git-fork'],
            ['board', 'Visualize', 'layout-grid'],
            ['summary', 'Summary', 'list'],
        ];
        this.tabs.clear();
        for (const [view, label, icon] of views) {
            if (!tabRow) break;
            const button = tabRow.createEl('button', { cls: 'sf-study-material-tab' });
            const iconEl = button.createSpan('sf-study-material-tab-icon');
            setIcon(iconEl, icon);
            button.createSpan({ cls: 'sf-study-material-tab-label', text: label });
            button.addEventListener('click', () => {
                this.setView(view);
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
        const { pack, stale, preparation } = host.snapshot();
        this.stateEl.removeClass('is-stale');
        this.stateEl.removeClass('is-error');
        if (!pack) {
            this.stateEl.setText('A mind map, visual boards and a condensed summary, drawn from this note.');
        } else if (stale) {
            this.stateEl.setText('Out of date — this note changed since it was made.');
            this.stateEl.addClass('is-stale');
        } else if (this.externalNavigation) {
            this.stateEl.setText('');
        } else {
            const boards = pack.visuals.length;
            this.stateEl.setText(`${boards} visual asset${boards === 1 ? '' : 's'} · ${pack.summary.bullets.length} bullets · made from this note`);
        }
        this.generateEl.setText(pack ? 'Regenerate' : 'Make it');
        this.generateEl.removeAttribute('disabled');
        if (preparation && preparation.materials !== 'ready' && preparation.materials !== 'skipped') {
            this.stateEl.setText(preparation.message);
            const pending = preparation.materials === 'queued' || preparation.materials === 'running';
            this.stateEl.toggleClass('is-error', preparation.materials === 'error' || preparation.materials === 'interrupted');
            this.generateEl.setText(pending ? 'Preparing material…' : 'Retry material');
            if (pending) this.generateEl.setAttribute('disabled', 'true');
        }
        if (this.busy) this.generateEl.setAttribute('disabled', 'true');
        this.show();
    }

    /** The one surface that is on screen, and the old one always torn down. */
    setView(view: StudyMaterialView): void {
        this.view = view;
        if (this.host?.state) this.host.state.view = view;
        this.host?.saveState?.();
        // Re-read the host: preparation can finish while this section is
        // hidden behind Learn, and its error line would otherwise survive a
        // successful retry until the panel was rebuilt.
        this.refresh();
    }

    private show(): void {
        const hostEl = this.hostEl;
        if (!hostEl) return;
        const pack = this.host?.snapshot().pack ?? null;
        if (pack !== this.renderedPack) {
            for (const surface of this.surfaces.values()) surface.teardown();
            this.surfaces.clear();
            this.renderedPack = pack;
        }
        // Detach, don't destroy: parameter values, selection and scroll survive
        // a material switch without leaving hidden timers in the document.
        for (const surface of this.surfaces.values()) surface.el.remove();
        hostEl.empty();
        for (const [view, button] of this.tabs) {
            button.classList.toggle('is-selected', view === this.view);
            button.setAttribute('aria-pressed', String(view === this.view));
        }
        if (!pack) {
            const label = this.view === 'board' ? 'Visualize' : this.view === 'mindmap' ? 'Mind map' : 'Summary';
            const failed = this.host?.snapshot().preparation;
            hostEl.createDiv({
                cls: 'sf-study-material-empty',
                text: failed && (failed.materials === 'error' || failed.materials === 'interrupted')
                    ? `${label}: the material was not made. Use Retry material to try again — the chart and your progress are unaffected.`
                    : `${label}: nothing made yet — make it to turn this note into material.`,
            });
            return;
        }
        const cached = this.surfaces.get(this.view);
        if (cached) { hostEl.appendChild(cached.el); return; }
        const surface = hostEl.createDiv('sf-study-material-surface');
        // A pack's whole body is not an identifier: it was the persisted map
        // key, duplicating several KB per pack and never being pruned. Keep one
        // short key and one entry; the state is cache, not data.
        const key = studyPackStateKey(pack);
        const states = this.host?.state;
        const state = states ? ((states.packs ??= {})[key] ??= {}) : {};
        if (states?.packs) {
            for (const existing of Object.keys(states.packs)) if (existing !== key) delete states.packs[existing];
        }
        const save = () => this.host?.saveState?.();
        let teardown: () => void;
        if (this.view === 'mindmap') teardown = new StudyMindMapView({ state: state.map, onStateChange: value => { state.map = value; save(); } }).mount(surface, pack.mindMap);
        else if (this.view === 'board') teardown = new StudyVisualGalleryView().mount(surface, pack.visuals, { open: state.gallery, assets: state.assets ??= {}, onChange: value => { state.gallery = value; save(); }, onAssetChange: save });
        else teardown = new StudySummaryView().mount(surface, pack.summary);
        this.surfaces.set(this.view, { el: surface, teardown });
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
            if (!this.stateEl || !this.generateEl) return;
            if (!pack) {
                this.stateEl.addClass('is-error');
                this.stateEl.setText('The model did not return usable material. Try again.');
                return;
            }
            this.refresh();
        } catch (error) {
            this.stateEl?.addClass('is-error');
            this.stateEl?.setText(error instanceof Error ? error.message : 'Could not reach a model.');
        } finally {
            this.busy = false;
            this.generateEl?.removeAttribute('disabled');
        }
    }

    /** Take the section down, surfaces included. */
    destroy(): void {
        for (const surface of this.surfaces.values()) surface.teardown();
        this.surfaces.clear();
        this.renderedPack = null;
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
