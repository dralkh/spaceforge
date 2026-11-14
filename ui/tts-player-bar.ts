import { setIcon } from 'obsidian';
import type { TtsTargetSource } from '../models/tts';
import type { TtsPlayerService, TtsPlayerSnapshot } from '../services/tts/tts-player-service';

export interface TtsPlayerBarHandlers {
    onReadTarget: (source: TtsTargetSource) => Promise<void> | void;
    /**
     * Play / pause in "read what is on screen" mode. The host knows which view
     * is showing; without this the bar falls back to its own source choice.
     */
    onToggle?: () => void;
    onSourceChange?: (source: TtsTargetSource) => void;
    onResumeFollow?: () => void;
}

const SPEED_STEPS = [0.85, 1.0, 1.25, 1.5, 1.75, 2.0];

const SOURCE_OPTIONS: Array<{ value: TtsTargetSource; label: string }> = [
    { value: 'auto', label: 'On screen' },
    { value: 'note', label: 'Note' },
    { value: 'summary', label: 'Summary' },
    { value: 'mindmap', label: 'Mind map' },
    { value: 'visualize', label: 'Visualize' },
    { value: 'tutor', label: 'Tutor' },
];

/**
 * The read-aloud transport: one row, no taller than a button.
 *
 *   ▶  ⏮ ⏭   Reflection — angle in equals angle out…  3/12   1.0× ◎ On screen ▾ ⤓ ■
 *   ▬▬▬▬▬▬▬▬░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (hairline progress)
 *
 * It is hidden while idle — the review bar's speaker starts it — so it only
 * ever costs a row while something is actually being read.
 */
export class TtsPlayerBar {
    private player: TtsPlayerService;
    private handlers: TtsPlayerBarHandlers;
    private rootEl: HTMLElement | null = null;
    private sourceEl: HTMLSelectElement | null = null;
    private playBtn: HTMLButtonElement | null = null;
    private playIconEl: HTMLElement | null = null;
    private prevBtn: HTMLButtonElement | null = null;
    private nextBtn: HTMLButtonElement | null = null;
    private stopBtn: HTMLButtonElement | null = null;
    private speedBtn: HTMLButtonElement | null = null;
    private followBtn: HTMLButtonElement | null = null;
    private exportBtn: HTMLButtonElement | null = null;
    private captionEl: HTMLElement | null = null;
    private countEl: HTMLElement | null = null;
    private fillEl: HTMLElement | null = null;
    private unsubscribe: (() => void) | null = null;
    private selectedSource: TtsTargetSource = 'auto';
    private lastPlayIcon = '';

    constructor(player: TtsPlayerService, handlers: TtsPlayerBarHandlers) {
        this.player = player;
        this.handlers = handlers;
        this.selectedSource = player.getSettings().defaultSource || 'auto';
    }

    mount(container: HTMLElement): () => void {
        this.unmount();

        const root = container.createDiv('sf-tts-bar');
        this.rootEl = root;

        this.playBtn = this.iconButton(root, 'volume-2', 'Play / pause (reads what is on screen)', 'sf-tts-play-btn');
        this.playIconEl = this.playBtn.querySelector<HTMLElement>('.sf-tts-btn-icon');
        this.playBtn.addEventListener('click', () => this.play());

        this.prevBtn = this.iconButton(root, 'skip-back', 'Previous part', 'sf-tts-secondary');
        this.prevBtn.addEventListener('click', () => void this.player.previous());
        this.nextBtn = this.iconButton(root, 'skip-forward', 'Next part', 'sf-tts-secondary');
        this.nextBtn.addEventListener('click', () => void this.player.next());

        // What is being read, taking whatever width the row has left.
        const info = root.createDiv('sf-tts-info');
        this.captionEl = info.createDiv('sf-tts-caption');
        this.countEl = info.createDiv('sf-tts-count');

        this.speedBtn = root.createEl('button', {
            cls: 'sf-tts-chip-btn sf-tts-secondary',
            attr: { type: 'button', title: 'Reading speed (click to change)' },
        });
        this.speedBtn.addEventListener('click', () => {
            const cur = this.player.getSettings().playbackSpeed;
            const nextIdx = SPEED_STEPS.findIndex(s => s > cur + 0.02);
            this.player.setPlaybackRate(nextIdx >= 0 ? SPEED_STEPS[nextIdx] : SPEED_STEPS[0]);
        });

        this.followBtn = this.iconButton(root, 'locate-fixed', 'Follow along: keep the part being read centred', 'sf-tts-follow-btn sf-tts-secondary');
        this.followBtn.addEventListener('click', () => {
            const snap = this.player.getSnapshot();
            if (snap.autoScrollPausedByUser) {
                this.player.resumeAutoScroll();
                this.handlers.onResumeFollow?.();
            } else {
                const next = !this.player.getSettings().autoScroll;
                this.player.setAutoScroll(next);
                if (next) this.handlers.onResumeFollow?.();
            }
        });

        const sourceSelect = root.createEl('select', {
            cls: 'sf-tts-source dropdown',
            attr: { 'aria-label': 'What to read', title: 'What to read' },
        });
        for (const opt of SOURCE_OPTIONS) {
            sourceSelect.createEl('option', { value: opt.value, text: opt.label });
        }
        sourceSelect.value = this.selectedSource;
        sourceSelect.addEventListener('change', () => {
            const nextSource = sourceSelect.value as TtsTargetSource;
            this.selectedSource = nextSource;
            this.player.getSettings().defaultSource = nextSource;
            this.handlers.onSourceChange?.(nextSource);
            const status = this.player.getSnapshot().status;
            if (status === 'playing' || status === 'loading' || status === 'paused') {
                void this.handlers.onReadTarget(nextSource);
            }
        });
        this.sourceEl = sourceSelect;

        this.exportBtn = this.iconButton(root, 'download', 'Save this audio', 'sf-tts-secondary');
        this.exportBtn.addEventListener('click', () => void this.player.exportCurrentTrack());

        this.stopBtn = this.iconButton(root, 'square', 'Stop', 'sf-tts-secondary');
        this.stopBtn.addEventListener('click', () => this.player.stop());

        const progress = root.createDiv('sf-tts-progress');
        this.fillEl = progress.createDiv('sf-tts-progress-fill');

        this.unsubscribe = this.player.subscribe(snapshot => this.render(snapshot));
        return () => this.unmount();
    }

    getSelectedSource(): TtsTargetSource {
        return this.selectedSource;
    }

    private play(): void {
        // "On screen" is the host's to resolve: it knows which tab is showing.
        if (this.selectedSource === 'auto' && this.handlers.onToggle) {
            this.handlers.onToggle();
            return;
        }
        const snap = this.player.getSnapshot();
        if (snap.status === 'playing' || snap.status === 'loading' || snap.status === 'paused') {
            void this.player.togglePlayPause();
        } else {
            void this.handlers.onReadTarget(this.selectedSource);
        }
    }

    /** An icon-only button with its glyph in a fixed box (see the iPad note in tts.css). */
    private iconButton(parent: HTMLElement, icon: string, label: string, cls: string): HTMLButtonElement {
        const button = parent.createEl('button', {
            cls: `sf-tts-icon-btn ${cls}`,
            attr: { type: 'button', title: label, 'aria-label': label },
        });
        setIcon(button.createSpan('sf-tts-btn-icon'), icon);
        return button;
    }

    private render(snapshot: TtsPlayerSnapshot): void {
        const root = this.rootEl;
        if (!root) return;

        const isActive =
            snapshot.status === 'playing' ||
            snapshot.status === 'loading' ||
            snapshot.status === 'paused';

        const hasSegments = snapshot.segments.length > 0;
        const isIdle = !isActive && !hasSegments && snapshot.status !== 'error' && !snapshot.errorMessage;
        root.toggleClass('is-idle', isIdle);
        root.toggleClass('is-active', isActive);
        root.toggleClass('is-playing', snapshot.status === 'playing');
        root.toggleClass('is-paused', snapshot.status === 'paused');
        root.toggleClass('is-loading', snapshot.status === 'loading');
        root.toggleClass('is-error', snapshot.status === 'error');

        const icon = snapshot.status === 'playing' ? 'pause' : snapshot.status === 'loading' ? 'loader' : 'play';
        if (this.playIconEl && icon !== this.lastPlayIcon) {
            this.lastPlayIcon = icon;
            this.playIconEl.empty();
            setIcon(this.playIconEl, icon);
        }

        if (this.prevBtn) this.prevBtn.disabled = !hasSegments || snapshot.currentIndex <= 0;
        if (this.nextBtn) {
            this.nextBtn.disabled = !hasSegments || snapshot.currentIndex >= snapshot.segments.length - 1;
        }
        if (this.stopBtn) this.stopBtn.disabled = !isActive;
        if (this.exportBtn) this.exportBtn.disabled = !hasSegments;

        if (this.speedBtn) {
            this.speedBtn.setText(`${snapshot.playbackRate.toFixed(snapshot.playbackRate % 1 === 0 ? 1 : 2)}×`);
        }

        if (this.followBtn) {
            const on = snapshot.autoScroll && !snapshot.autoScrollPausedByUser;
            this.followBtn.toggleClass('is-on', on);
            this.followBtn.toggleClass('is-paused', snapshot.autoScrollPausedByUser);
            this.followBtn.setAttribute('aria-pressed', String(on));
            const label = snapshot.autoScrollPausedByUser
                ? 'Follow paused because you scrolled — click to resume'
                : on ? 'Following along — click to stop' : 'Not following — click to follow along';
            this.followBtn.setAttribute('title', label);
            this.followBtn.setAttribute('aria-label', label);
        }

        if (this.captionEl) {
            if (snapshot.status === 'error') {
                this.captionEl.setText(snapshot.errorMessage || 'Read aloud failed');
            } else if (snapshot.currentSegment) {
                this.captionEl.setText(snapshot.currentSegment.label || snapshot.currentSegment.text);
            } else {
                this.captionEl.setText(snapshot.errorMessage || snapshot.title || '');
            }
        }

        if (this.countEl) {
            this.countEl.setText(
                snapshot.segments.length > 0 && snapshot.currentIndex >= 0
                    ? `${snapshot.currentIndex + 1}/${snapshot.segments.length}`
                    : '',
            );
        }

        if (this.fillEl) {
            const pct =
                snapshot.segments.length > 0 && snapshot.currentIndex >= 0
                    ? Math.round(((snapshot.currentIndex + 1) / snapshot.segments.length) * 100)
                    : 0;
            this.fillEl.setCssProps({ '--sf-tts-progress': `${pct}%` });
        }
    }

    unmount(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.rootEl?.remove();
        this.rootEl = null;
        this.sourceEl = null;
        this.playBtn = null;
        this.playIconEl = null;
        this.prevBtn = null;
        this.nextBtn = null;
        this.stopBtn = null;
        this.speedBtn = null;
        this.followBtn = null;
        this.exportBtn = null;
        this.captionEl = null;
        this.countEl = null;
        this.fillEl = null;
        this.lastPlayIcon = '';
    }
}
