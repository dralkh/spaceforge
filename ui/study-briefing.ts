import { Notice, setIcon } from 'obsidian';
import { StudyMode, StudyObjectiveStatus, StudyObjectiveType } from '../models/study';
import type { StudyObjective, StudyPlan } from '../models/study';
import { STUDY_DOMAINS, getDomainProfile } from '../models/study-domains';
import type { StudyVisualPack } from '../models/study-visuals';
import type { StudyBriefing } from '../services/study-session-service';
import type { StudyImageRef } from '../utils/study-media';
import type { StudyMaterialView } from './study-material-section';
import { StudyMindMapView } from './study-mindmap';
import { StudySummaryView } from './study-visual-board';
import { StudyVisualGalleryView } from './study-visual-gallery';

/** The label the mode button shows for a mode. */
export function modeLabel(mode: StudyMode): string {
    return MODE_CHOICES.find(choice => choice.mode === mode)?.label ?? 'Mode';
}

export const MODE_CHOICES: { mode: StudyMode; label: string; blurb: string; icon: string }[] = [
    { mode: StudyMode.Guided, label: 'Guided', blurb: 'Explain, then check, then apply.', icon: 'compass' },
    { mode: StudyMode.Drill, label: 'Rapid drill', blurb: 'Short questions, short feedback.', icon: 'zap' },
    { mode: StudyMode.Repair, label: 'Repair', blurb: 'Attack what you keep getting wrong.', icon: 'wrench' },
    { mode: StudyMode.Scenarios, label: 'New situations', blurb: 'Unfamiliar cases only.', icon: 'shuffle' },
    { mode: StudyMode.Exam, label: 'Exam block', blurb: 'Feedback held to the end.', icon: 'graduation-cap' },
];

/**
 * The three ways to look at a note's material from the launch row: one button
 * per surface, the same three the material section holds. `noun` is how the
 * button names its surface in a title ("Show the mind map").
 */
const MATERIAL_CHOICES: { view: StudyMaterialView; label: string; icon: string; noun: string }[] = [
    { view: 'mindmap', label: 'Mind map', icon: 'git-fork', noun: 'mind map' },
    { view: 'board', label: 'Visualize', icon: 'layout-grid', noun: 'visual gallery' },
    { view: 'summary', label: 'Summary', icon: 'list', noun: 'summary' },
];

export const TYPE_LABELS: Record<StudyObjectiveType, string> = {
    [StudyObjectiveType.Mechanism]: 'how it works',
    [StudyObjectiveType.Fact]: 'fact',
    [StudyObjectiveType.Distinction]: 'distinction',
    [StudyObjectiveType.Application]: 'applying it',
    [StudyObjectiveType.Interpretation]: 'reading it',
    [StudyObjectiveType.Procedure]: 'procedure',
    [StudyObjectiveType.Critique]: 'judgement',
    [StudyObjectiveType.Safety]: 'safety',
    [StudyObjectiveType.Creative]: 'making it',
};

export const STATUS_LABELS: Record<StudyObjectiveStatus, string> = {
    [StudyObjectiveStatus.Unseen]: 'Not started',
    [StudyObjectiveStatus.Learning]: 'Learning',
    [StudyObjectiveStatus.Fragile]: 'Fragile',
    [StudyObjectiveStatus.Stable]: 'Stable',
    [StudyObjectiveStatus.Mastered]: 'Solid',
};

/** The sections of the briefing, in the order they are rendered. */
export type StudyBriefingSection =
    | 'warning'
    | 'launch'
    | 'intro'
    | 'objectives'
    | 'progress'
    | 'context'
    | 'options'
    | 'figures'
    | 'material'
    | 'provider';

/**
 * What the briefing view needs from the panel.
 *
 * The view renders; the panel decides. Everything shown here is a fact the
 * panel already computed (`briefing` from `StudySessionService.prepare`, the
 * plan for the figure rail), and every control calls back into the panel —
 * starting a session, charting, correcting the subject lens, picking a mode,
 * turning lookups on — so the view owns no state a re-mount could disagree
 * with, and nothing here reaches into the plugin.
 */
export interface StudyBriefingHost {
    /** Everything the panel computed about this note. */
    briefing: StudyBriefing;
    /** The charted plan (the figure rail lives on it), or null before a chart. */
    plan: StudyPlan | null;
    /** The mode the session would start in. */
    mode: StudyMode;
    /** Whether web lookup would start on. */
    webLookup: boolean;
    /** True while a chart is running for this note. */
    charting: boolean;
    /** How long the note takes to read, or null when it cannot be measured. */
    studyMinutes: number | null;
    /** Begin a session. `fresh` starts with no mastery carried in. */
    start: (fresh: boolean) => void;
    /** Chart the note (again) from its current content. */
    rechart: () => void;
    /** The reader corrected the subject lens. */
    changeDomain: (domainId: string, notes: string) => void;
    /** The reader picked a different session mode. */
    changeMode: (mode: StudyMode) => void;
    /** The reader turned web lookup on or off. */
    toggleLookup: (on: boolean) => void;
    /** The element the panel mounts the study material section into. */
    materialSlot: (element: HTMLElement) => void;
    /** The material the launch row's buttons show, or null before it is made. */
    materialPack: StudyVisualPack | null;
    /** True when the note changed since the pack was made. */
    materialStale: boolean;
    /** Vault URL for a figure, or null when it does not resolve. */
    figureSource: (image: StudyImageRef) => string | null;
    /** Show the figure (the panel's lightbox lives at the panel's own root). */
    openFigure: (image: StudyImageRef) => void;
}

/**
 * The briefing: the launch screen a reader sees before a session starts.
 *
 * It is a view of its own because deciding to study is a different job from
 * studying, and it was being rendered as a settings page: a small primary
 * button at the bottom, peer-sized secondary buttons beside it, the warning
 * below the fold, four zeroes dressed as statistics, and the objectives listed
 * under a header that said what version of the note they came from. In reading
 * order the screen now answers, one question per section:
 *
 *   1. is anything blocking? (the note changed since it was charted)
 *   2. what am I starting, and what is the one button that starts it?
 *   3. what will it teach? (a summary that opens into the full list)
 *   4. where am I with this note? (progress, or an honest line that says none)
 *   5. what did last time leave behind? (recall notes, the tutor's memory)
 *   6. how should this session run? (mode grid, lookup toggle, subject lens)
 *   7. what else is here? (figures in the note, the study material)
 *   8. which model is teaching?
 *
 * The primary action is the only filled button on the screen, and it changes
 * with the one blocking fact there is: studying a stale chart is the wrong
 * move, so with a stale note the primary charters it again and `Start anyway`
 * is the way past it, small and secondary.
 *
 * Beside it sit the material buttons — Mind map, Visualize, Summary — and each
 * one opens its surface in this briefing, under the row, rather than in a
 * window: the material is part of deciding how to study, not an errand. One
 * with nothing made yet is disabled and carries the reason in its title.
 */
export class StudyBriefingView {
    private rootEl: HTMLElement | null = null;
    private host: StudyBriefingHost | null = null;
    private listEl: HTMLElement | null = null;
    private objectivesOpen = false;
    private launchEl: HTMLElement | null = null;
    private materialButtons = new Map<StudyMaterialView, HTMLButtonElement>();
    private materialPack: StudyVisualPack | null = null;
    private materialStale = false;
    private materialOpen: StudyMaterialView | null = null;
    private viewerEl: HTMLElement | null = null;
    private materialTeardown: (() => void) | null = null;

    /** Build the briefing inside `container`. Mounting again replaces. */
    mount(container: HTMLElement, host: StudyBriefingHost): void {
        this.destroy();
        this.host = host;
        this.materialPack = host.materialPack;
        this.materialStale = host.materialStale;
        const card = container.createDiv('sf-study-briefing');
        this.rootEl = card;
        const briefing = host.briefing;

        // 1. Anything blocking comes first: a stale chart changes the move.
        if (this.isStale(host)) this.renderWarning(card);

        // 2. What is being started, and the one button that starts it.
        this.renderLaunch(card, host);

        if (briefing.totalObjectives === 0) {
            this.renderIntro(card, host);
        } else {
            // 3-5. What it teaches, where the reader is, what last time left.
            this.renderObjectives(card, host);
            this.renderProgress(card, host);
            this.renderContext(card, host);
        }

        // 6. The session's options, together: mode, lookups, subject lens.
        this.renderOptions(card, host);

        // 7-8. The note's figures, the material, then who is teaching.
        this.renderFigures(card, host);
        host.materialSlot(this.section(card, 'material'));
        this.renderProvider(card, host);
    }

    /** Take the briefing down. Idempotent; a second mount replaces. */
    destroy(): void {
        this.listEl?.remove();
        this.listEl = null;
        this.teardownMaterial();
        this.materialButtons.clear();
        this.launchEl = null;
        this.rootEl?.remove();
        this.rootEl = null;
        this.host = null;
        this.objectivesOpen = false;
    }

    // ------------------------------------------------------------ the sections

    /** One section, tagged with its name so the reading order is assertable. */
    private section(card: HTMLElement, name: StudyBriefingSection, extra = ''): HTMLElement {
        const section = card.createDiv({ cls: `sf-brief-section sf-brief-${name}${extra ? ` ${extra}` : ''}` });
        section.setAttribute('data-section', name);
        return section;
    }

    /** A stale chart is the one fact that reorders the screen. */
    private isStale(host: StudyBriefingHost): boolean {
        return host.briefing.stale && host.briefing.totalObjectives > 0;
    }

    /** The blocking notice: the first thing read, and a banner, not a column. */
    private renderWarning(card: HTMLElement): void {
        const section = this.section(card, 'warning', 'sf-study-banner sf-study-banner-warn');
        const icon = section.createSpan('sf-study-banner-icon');
        setIcon(icon, 'git-compare');
        section.createDiv({
            text: 'This note changed since it was charted. Re-charting keeps the mastery of objectives that survived.',
        });
    }

    /**
     * The launch header: what this is, one scope line, and the row of actions.
     *
     * The row is the one filled button plus the three material buttons, side by
     * side where the decision is made — the material used to live only at the
     * bottom of the briefing. `Start fresh` and `Re-chart` are links under it
     * rather than buttons beside it: as peers of the primary they read as three
     * equal decisions when there is only one obvious move.
     */
    private renderLaunch(card: HTMLElement, host: StudyBriefingHost): void {
        const briefing = host.briefing;
        const section = this.section(card, 'launch');
        this.launchEl = section;
        section.createDiv({ cls: 'sf-brief-title', text: briefing.noteTitle });
        if (briefing.topicSummary) section.createDiv({ cls: 'sf-study-topic', text: briefing.topicSummary });
        const scope = this.scopeLine(host);
        if (scope.length > 0) section.createDiv({ cls: 'sf-brief-scope', text: scope });

        // One row of actions: the decision, and the material to look at while
        // making it. The row wraps at narrow widths rather than shrinking the
        // primary action down to a peer.
        const actions = section.createDiv('sf-brief-actions');
        const stale = this.isStale(host);
        const canStart = briefing.providerReady && briefing.totalObjectives > 0;
        const primary = actions.createEl('button', { cls: 'sf-btn sf-btn-primary sf-brief-primary' });

        if (stale) {
            // The chart describes text that no longer exists: re-chart first.
            primary.setText('Re-chart this note');
            primary.disabled = !briefing.providerReady;
            primary.addEventListener('click', () => host.rechart());
        } else if (briefing.totalObjectives === 0) {
            primary.setText(host.charting ? 'Waiting for objectives…' : 'Chart this note');
            primary.disabled = !briefing.providerReady || host.charting;
            primary.addEventListener('click', () => host.rechart());
        } else {
            primary.setText('Start studying');
            primary.disabled = !canStart;
            primary.addEventListener('click', () => host.start(false));
        }

        this.renderMaterialButtons(actions);

        const secondary: [string, () => void, boolean][] = [];
        if (stale) secondary.push(['Start anyway', () => host.start(false), !canStart]);
        if (briefing.totalObjectives > 0) {
            secondary.push(['Start fresh', () => host.start(true), !briefing.providerReady]);
            if (!stale) secondary.push(['Re-chart', () => host.rechart(), !briefing.providerReady]);
        }
        if (secondary.length === 0) return;
        const links = section.createDiv('sf-brief-links');
        for (const [label, handler, disabled] of secondary) this.link(links, label, handler, disabled);
    }

    /** A secondary action: a small text link, never a filled button. */
    private link(parent: HTMLElement, label: string, handler: () => void, disabled: boolean): void {
        const button = parent.createEl('button', { text: label, cls: 'sf-brief-link' });
        button.disabled = disabled;
        button.addEventListener('click', handler);
    }

    // ------------------------------------------------------- the material row

    /**
     * The three material buttons, beside the primary action.
     *
     * Each one opens its own surface in this section, directly under the row —
     * the briefing itself, never a window — and pressing it again puts the
     * surface away. A surface that has not been made yet leaves its button
     * disabled with the reason in the title: a control that quietly does
     * nothing reads as a broken feature, and a reader who is told where to make
     * it can act.
     */
    private renderMaterialButtons(row: HTMLElement): void {
        for (const choice of MATERIAL_CHOICES) {
            // `sf-brief-material-button`, not `sf-brief-material`: that name is
            // the material section's own (the slot the panel mounts into), and a
            // second element wearing it inherits rules it never asked for.
            const button = row.createEl('button', { cls: 'sf-btn sf-brief-material-button' });
            button.setAttribute('type', 'button');
            const icon = button.createSpan('sf-brief-material-icon');
            setIcon(icon, choice.icon);
            button.createSpan({ cls: 'sf-brief-material-label', text: choice.label });
            // Bound even while disabled (a disabled button fires nothing), so a
            // pack that lands later needs the row repainted, not rebuilt.
            button.addEventListener('click', () => this.toggleMaterial(choice.view));
            this.materialButtons.set(choice.view, button);
        }
        this.paintMaterialButtons();
    }

    /** Repaint the three buttons from the pack that is on the plan now. */
    private paintMaterialButtons(): void {
        const host = this.host;
        const ready = this.materialPack !== null;
        for (const choice of MATERIAL_CHOICES) {
            const button = this.materialButtons.get(choice.view);
            if (!button) continue;
            const open = ready && this.materialOpen === choice.view;
            button.disabled = !ready;
            button.toggleClass('is-active', open);
            button.setAttribute('aria-pressed', String(open));
            if (!host) continue;
            if (!ready) button.setAttribute('title', this.materialMissingTitle(choice.view, host));
            else button.setAttribute('title', open ? `Hide the ${choice.noun}` : `Show the ${choice.noun}`);
        }
    }

    /** Why a button cannot show its surface yet, as the reader's next move. */
    private materialMissingTitle(view: StudyMaterialView, host: StudyBriefingHost): string {
        const noun = MATERIAL_CHOICES.find(choice => choice.view === view)?.noun ?? 'material';
        if (!host.plan || host.briefing.totalObjectives === 0) {
            return `This note has no chart yet, so there is no ${noun} to show. Chart it first.`;
        }
        return `Not made yet — press Make it in Study material below, and this opens the ${noun}.`;
    }

    /** A press on a material button: swap to its surface, or put it away. */
    private toggleMaterial(view: StudyMaterialView): void {
        if (this.materialPack === null) return;
        if (this.materialOpen === view) {
            this.teardownMaterial();
        } else {
            this.materialOpen = view;
            this.mountMaterial(view);
        }
        this.paintMaterialButtons();
    }

    /** Mount one surface, from the pack on the plan now, into the viewer. */
    private mountMaterial(view: StudyMaterialView): void {
        const pack = this.materialPack;
        const launch = this.launchEl;
        if (pack === null || launch === null) return;
        this.materialTeardown?.();
        this.materialTeardown = null;

        const viewer = this.viewerEl && this.viewerEl.isConnected ? this.viewerEl : launch.createDiv('sf-brief-material-viewer');
        this.viewerEl = viewer;
        viewer.empty();
        viewer.setAttribute('data-view', view);
        if (this.materialStale) {
            viewer.createDiv({ cls: 'sf-brief-material-note', text: 'Out of date — this note changed since it was made.' });
        }
        // The surface gets its own element: the mind map empties the node it is
        // mounted into, and it must not take the freshness line with it.
        const surface = viewer.createDiv('sf-brief-material-surface');
        if (view === 'mindmap') this.materialTeardown = new StudyMindMapView().mount(surface, pack.mindMap);
        else if (view === 'board') this.materialTeardown = new StudyVisualGalleryView().mount(surface, pack.visuals);
        else this.materialTeardown = new StudySummaryView().mount(surface, pack.summary);
    }

    /** Take the open surface and the viewer with it. */
    private teardownMaterial(): void {
        this.materialTeardown?.();
        this.materialTeardown = null;
        this.viewerEl?.remove();
        this.viewerEl = null;
        this.materialOpen = null;
    }

    /**
     * The pack changed — made, or made again. The panel calls this after a
     * generation so the buttons beside the primary action stop saying "not made
     * yet" about material that now exists, without rebuilding the briefing.
     */
    setMaterial(pack: StudyVisualPack | null, stale: boolean): void {
        this.materialPack = pack;
        this.materialStale = stale;
        if (this.materialOpen !== null && pack === null) this.teardownMaterial();
        else if (this.materialOpen !== null) this.mountMaterial(this.materialOpen);
        this.paintMaterialButtons();
    }

    /**
     * The scope line: how much there is, how long it takes, when it was last
     * studied. Each fact is computed from what the panel already holds, and a
     * fact that cannot be computed is left out rather than guessed.
     */
    private scopeLine(host: StudyBriefingHost): string {
        const parts: string[] = [];
        const total = host.briefing.totalObjectives;
        if (total > 0) parts.push(`${total} objective${total === 1 ? '' : 's'}`);
        if (host.studyMinutes !== null && total > 0) parts.push(`about ${host.studyMinutes} min`);
        const last = host.briefing.lastSessionAt;
        if (last !== null) parts.push(`last studied ${this.relativeDays(last)}`);
        return parts.join(' · ');
    }

    /** "today" / "yesterday" / "6 days ago", counted in days, not hours. */
    private relativeDays(timestamp: number): string {
        const startOfDay = (value: number): number => {
            const date = new Date(value);
            date.setHours(0, 0, 0, 0);
            return date.getTime();
        };
        const days = Math.max(0, Math.round((startOfDay(Date.now()) - startOfDay(timestamp)) / 86400000));
        if (days === 0) return 'today';
        if (days === 1) return 'yesterday';
        return `${days} days ago`;
    }

    private renderIntro(card: HTMLElement, host: StudyBriefingHost): void {
        const intro = this.section(card, 'intro', 'sf-study-intro');
        intro.createDiv({
            cls: 'sf-study-intro-text',
            text: host.charting
                ? 'Charting this note now — objectives appear as sections are read. You can start as soon as the first ones land.'
                : 'Study breaks this note into the smallest ideas worth knowing, teaches them one at a time, and remembers what you got wrong. Charting it has not produced any objectives yet.',
        });
    }

    /**
     * The objectives, scannable: one line of titles that opens the full list.
     *
     * The list is built when the disclosure opens and removed when it closes —
     * a hidden list is still a hundred rows of DOM the reader cannot see, and
     * the point of the summary is that most readers never need them.
     */
    private renderObjectives(card: HTMLElement, host: StudyBriefingHost): void {
        const briefing = host.briefing;
        const section = this.section(card, 'objectives');
        section.createDiv({ cls: 'sf-study-section-title', text: `Objectives (${briefing.totalObjectives})` });

        const titles = briefing.objectives.map(entry => entry.objective.title);
        const visible = titles.slice(0, 3);
        const rest = titles.length - visible.length;

        const summary = section.createEl('button', { cls: 'sf-brief-objectives-summary' });
        summary.setAttribute('aria-expanded', 'false');
        const caret = summary.createSpan('sf-brief-objectives-caret');
        setIcon(caret, 'chevron-down');
        summary.createSpan({ cls: 'sf-brief-objectives-titles', text: visible.join(', ') });
        if (rest > 0) summary.createSpan({ cls: 'sf-brief-objectives-more', text: `, +${rest} more` });

        summary.addEventListener('click', () => {
            this.objectivesOpen = !this.objectivesOpen;
            summary.setAttribute('aria-expanded', String(this.objectivesOpen));
            summary.toggleClass('is-open', this.objectivesOpen);
            if (this.objectivesOpen) {
                this.renderObjectiveList(section, host);
            } else {
                this.listEl?.remove();
                this.listEl = null;
            }
        });
    }

    /** The full list the summary opens: read-only rows, mastery marker intact. */
    private renderObjectiveList(section: HTMLElement, host: StudyBriefingHost): void {
        const list = section.createDiv('sf-study-objective-list');
        this.listEl = list;
        for (const entry of host.briefing.objectives) {
            const objective = entry.objective;
            const status = entry.state.status ?? StudyObjectiveStatus.Unseen;
            const row = list.createDiv('sf-study-obj is-static');
            row.setAttribute('data-status', status);

            const marker = row.createSpan('sf-study-obj-status');
            marker.setAttribute('title', STATUS_LABELS[status]);

            const main = row.createDiv('sf-study-obj-main');
            main.createDiv({ cls: 'sf-study-obj-title', text: objective.title });
            const meta = this.objectiveMeta(objective);
            main.createDiv({ cls: 'sf-study-obj-meta', text: meta });
        }
    }

    private objectiveMeta(objective: StudyObjective): string {
        const type = `${TYPE_LABELS[objective.type]}${objective.importance === 'standard' ? '' : ` · ${objective.importance}`}`;
        const statement = objective.statement.length > 150 ? `${objective.statement.slice(0, 147)}…` : objective.statement;
        return `${type} — ${statement}`;
    }

    /**
     * Where the reader is with this note.
     *
     * Before anything is studied every one of these numbers is zero, and four
     * zeroes on a launch screen say "you have nothing here" when the truth is
     * "there are ten things ready" — so the row is only drawn once there is
     * progress, and before that the screen says the second thing.
     */
    private renderProgress(card: HTMLElement, host: StudyBriefingHost): void {
        const briefing = host.briefing;
        const section = this.section(card, 'progress');
        const studied = briefing.covered > 0 || briefing.mastered > 0 || briefing.fragile > 0;

        if (!studied && briefing.due.length === 0) {
            section.createDiv({
                cls: 'sf-brief-progress-empty',
                text: `Nothing studied yet · ${briefing.totalObjectives} objective${briefing.totalObjectives === 1 ? '' : 's'} ready`,
            });
            return;
        }

        const row = section.createDiv('sf-study-stats');
        this.statTile(row, 'Covered', String(briefing.covered), 'eye');
        this.statTile(row, 'Solid', String(briefing.mastered), 'check-circle');
        this.statTile(row, 'Fragile', String(briefing.fragile), 'alert-circle');
        this.statTile(row, 'Mastery', `${Math.round(briefing.masteryScore * 100)}%`, 'trending-up');

        if (briefing.due.length > 0) {
            const due = section.createDiv('sf-study-due');
            due.createDiv({ cls: 'sf-study-due-title', text: `${briefing.due.length} objective${briefing.due.length === 1 ? '' : 's'} due for review` });
            const list = due.createDiv('sf-study-due-list');
            for (const entry of briefing.due.slice(0, 6)) {
                const item = list.createDiv('sf-study-due-item');
                item.createSpan({ cls: 'sf-study-due-badge', text: entry.overdueDays === 0 ? 'today' : `${entry.overdueDays}d late` });
                item.createSpan({ text: entry.title });
            }
        }
    }

    private statTile(parent: HTMLElement, label: string, value: string, icon: string): void {
        const tile = parent.createDiv('sf-study-stat');
        const iconEl = tile.createSpan('sf-study-stat-icon');
        setIcon(iconEl, icon);
        tile.createDiv({ cls: 'sf-study-stat-value', text: value });
        tile.createDiv({ cls: 'sf-study-stat-label', text: label });
    }

    /** What the last session left behind, when it left anything. */
    private renderContext(card: HTMLElement, host: StudyBriefingHost): void {
        const briefing = host.briefing;
        if (!briefing.lastSessionSummary && briefing.tutorMemory.length === 0) return;
        const section = this.section(card, 'context');

        if (briefing.lastSessionSummary) {
            const summary = section.createDiv('sf-study-recall');
            summary.createDiv({ cls: 'sf-study-recall-title', text: 'Last time' });
            summary.createDiv({ cls: 'sf-study-recall-text', text: briefing.lastSessionSummary });
        }
        if (briefing.tutorMemory.length > 0) {
            const memory = section.createDiv('sf-study-memory');
            memory.createDiv({ cls: 'sf-study-memory-title', text: 'What the tutor remembers about you here' });
            const list = memory.createDiv('sf-study-memory-list');
            for (const line of briefing.tutorMemory.slice(-6)) list.createDiv({ cls: 'sf-study-memory-item', text: line });
        }
    }

    /**
     * How the session runs: the mode grid and the lookup toggle in one place.
     *
     * The lookup toggle is a session option like the mode is, so it sits in
     * this section as a compact row rather than as its own full-width box that
     * competed with the mode grid for the same decision.
     */
    private renderOptions(card: HTMLElement, host: StudyBriefingHost): void {
        const section = this.section(card, 'options');
        section.createDiv({ cls: 'sf-study-section-title', text: 'How to run this session' });

        const grid = section.createDiv('sf-study-mode-grid');
        for (const choice of MODE_CHOICES) {
            const button = grid.createEl('button', { cls: 'sf-study-mode' });
            if (choice.mode === host.mode) button.addClass('is-selected');
            const icon = button.createSpan('sf-study-mode-icon');
            setIcon(icon, choice.icon);
            button.createDiv({ cls: 'sf-study-mode-label', text: choice.label });
            button.createDiv({ cls: 'sf-study-mode-blurb', text: choice.blurb });
            button.addEventListener('click', () => {
                grid.querySelectorAll('.sf-study-mode').forEach(el => el.removeClass('is-selected'));
                button.addClass('is-selected');
                host.changeMode(choice.mode);
            });
        }

        // The toggle and the subject lens are one decision area, so they share a
        // row wherever there is room: two half-height rows instead of two full.
        const context = section.createDiv('sf-brief-options-context');
        this.renderLookupRow(context, host);
        this.renderDomainRow(context, host);
    }

    private renderLookupRow(section: HTMLElement, host: StudyBriefingHost): void {
        const briefing = host.briefing;
        const row = section.createDiv('sf-brief-lookup');
        const text = row.createDiv('sf-study-toggle-text');
        const available = host.briefing.searchAvailable;
        text.createDiv({ cls: 'sf-study-toggle-title', text: available ? 'Look things up while studying' : 'Look things up' });
        text.createDiv({
            cls: 'sf-study-toggle-blurb',
            text: briefing.searchAvailable
                ? `The tutor can verify mechanisms and current facts through ${briefing.searchLabel}, and will cite only what it actually retrieved.`
                : `Not available: ${briefing.searchReason ?? 'no search provider configured'}. Anything uncertain gets labelled as unverified.`,
        });

        let on = host.webLookup && briefing.searchAvailable;
        const switchEl = row.createEl('button', { cls: 'sf-study-switch' });
        switchEl.setAttribute('aria-pressed', String(on));
        if (on) switchEl.addClass('is-on');
        if (!briefing.searchAvailable) switchEl.addClass('is-disabled');
        switchEl.createSpan('sf-study-switch-knob');
        switchEl.addEventListener('click', () => {
            if (!briefing.searchAvailable) {
                new Notice('Configure a search provider in Spaceforge settings to use web lookup.');
                return;
            }
            on = !on;
            switchEl.toggleClass('is-on', on);
            switchEl.setAttribute('aria-pressed', String(on));
            host.toggleLookup(on);
        });
    }

    /** The subject lens, editable: it changes how everything above is taught. */
    private renderDomainRow(section: HTMLElement, host: StudyBriefingHost): void {
        const briefing = host.briefing;
        const row = section.createDiv('sf-study-domain-row sf-brief-domain');
        const label = row.createDiv('sf-study-domain-label');
        const icon = label.createSpan('sf-study-domain-icon');
        setIcon(icon, 'compass');
        label.createDiv({ cls: 'sf-study-domain-name', text: briefing.domainLabel });
        label.createDiv({
            cls: 'sf-study-domain-note',
            text: briefing.hasPlan
                ? (briefing.domainNotes || getDomainProfile(briefing.domainId).mechanism)
                : 'Detected when the note is charted.',
        });
        const edit = row.createEl('button', { text: 'Change', cls: 'sf-btn sf-study-domain-edit' });
        edit.addEventListener('click', () => this.openDomainEditor(section, host));
    }

    private openDomainEditor(section: HTMLElement, host: StudyBriefingHost): void {
        section.querySelector('.sf-study-domain-editor')?.remove();
        const editor = section.createDiv('sf-study-domain-editor');
        editor.createDiv({ cls: 'sf-study-section-title', text: 'What kind of subject is this?' });
        editor.createDiv({
            cls: 'sf-study-domain-editor-blurb',
            text: 'The tutor changes how it explains, what counts as a mechanism, and what a good test looks like based on this. Correct it if it guessed wrong.',
        });
        const select = editor.createEl('select', { cls: 'dropdown sf-study-domain-select' });
        for (const profile of STUDY_DOMAINS) {
            const option = select.createEl('option', { text: profile.label });
            // `value` is not set by createEl for options in every Obsidian build.
            option.value = profile.id;
            option.selected = profile.id === host.briefing.domainId;
        }
        const notes = editor.createEl('textarea', { cls: 'sf-study-domain-school' });
        notes.value = host.briefing.domainNotes;
        notes.placeholder = 'Anything specific about how this subject should be taught (optional)';

        const buttons = editor.createDiv('sf-study-domain-editor-actions');
        const save = buttons.createEl('button', { text: 'Save', cls: 'sf-btn sf-btn-primary' });
        save.addEventListener('click', () => host.changeDomain(select.value, notes.value.trim()));
        const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'sf-btn' });
        cancel.addEventListener('click', () => editor.remove());
    }

    /** Thumbnails of the note's figures, previewed through the panel. */
    private renderFigures(card: HTMLElement, host: StudyBriefingHost): void {
        const images = host.plan?.images ?? [];
        if (images.length === 0) return;
        const section = this.section(card, 'figures', 'sf-study-figures');
        section.createDiv({ cls: 'sf-study-section-title', text: `Figures in this note (${images.length})` });
        const strip = section.createDiv('sf-study-figure-strip');

        for (const image of images) {
            const figure = strip.createDiv('sf-study-figure');
            figure.setAttribute('title', `${image.fileName}${image.heading ? ` — ${image.heading}` : ''}`);

            const thumb = host.figureSource(image);
            if (thumb) {
                const img = figure.createEl('img', { cls: 'sf-study-figure-img' });
                img.src = thumb;
                img.alt = image.fileName;
                img.loading = 'lazy';
            } else {
                const placeholder = figure.createDiv('sf-study-figure-placeholder');
                const icon = placeholder.createSpan();
                setIcon(icon, 'image-off');
            }
            figure.createDiv({ cls: 'sf-study-figure-name', text: image.fileName.replace(/^.*?_/, '').slice(0, 18) });
            figure.addEventListener('click', () => host.openFigure(image));
        }

        if (images.length > 6) {
            const more = strip.createDiv('sf-study-figure sf-study-figure-more');
            const count = more.createDiv({ cls: 'sf-study-figure-more-count', text: `+${images.length - 6}` });
            more.setAttribute('title', 'Show every figure in this note');
            more.addEventListener('click', () => {
                const expanded = !strip.hasClass('is-expanded');
                strip.toggleClass('is-expanded', expanded);
                count.setText(expanded ? 'less' : `+${images.length - 6}`);
                more.setAttribute('title', expanded ? 'Show fewer figures' : 'Show every figure in this note');
            });
        }
    }

    /** Only a problem is worth saying here: a working model needs no caption. */
    private renderProvider(card: HTMLElement, host: StudyBriefingHost): void {
        const briefing = host.briefing;
        if (briefing.providerReady) return;
        const section = this.section(card, 'provider', 'sf-study-provider');
        const icon = section.createSpan('sf-study-provider-icon');
        setIcon(icon, 'alert-triangle');
        section.createDiv({
            cls: 'sf-study-provider-text',
            text: `No model available: ${briefing.providerReason ?? 'check the API provider settings'}`,
        });
    }
}
