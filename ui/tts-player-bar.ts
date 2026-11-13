import { setIcon } from 'obsidian';
import type { TtsTargetSource } from '../models/tts';
import type { TtsPlayerService, TtsPlayerSnapshot } from '../services/tts/tts-player-service';

export interface TtsPlayerBarHandlers {
    onReadTarget: (source: TtsTargetSource) => Promise<void> | void;
    onSourceChange?: (source: TtsTargetSource) => void;
    onResumeFollow?: () => void;
}

const SPEED_STEPS = [0.85, 1.0, 1.25, 1.5, 1.75, 2.0];

const SOURCE_OPTIONS: Array<{ value: TtsTargetSource; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'note', label: 'Note' },
    { value: 'summary', label: 'Summary' },
    { value: 'mindmap', label: 'Mind map' },
    { value: 'visualize', label: 'Visualize' },
    { value: 'tutor', label: 'Tutor' },
];

/**
 * Compact TTS transport bar rendered inside the review bar/dock so it appears in all
 * review hosts (under note, split pane, popout window, and sidebar Review tab).
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

    constructor(player: TtsPlayerService, handlers: TtsPlayerBarHandlers) {
        this.player = player;
        this.handlers = handlers;
        this.selectedSource = player.getSettings().defaultSource || 'auto';
    }

    mount(container: HTMLElement): () => void {
        this.unmount();

        const root = container.createDiv('sf-tts-bar');
        this.rootEl = root;

        const controls = root.createDiv('sf-tts-controls');

        const playBtn = controls.createEl('button', {
            cls: 'sf-btn sf-tts-play-btn',
            attr: { type: 'button', title: 'Read aloud (Play / Pause)', 'aria-label': 'Read aloud (Play / Pause)' },
        });
        this.playIconEl = playBtn.createSpan('sf-tts-btn-icon');
        setIcon(this.playIconEl, 'volume-2');
        playBtn.addEventListener('click', () => {
            const snap = this.player.getSnapshot();
            if (snap.status === 'playing' || snap.status === 'loading' || snap.status === 'paused') {
                void this.player.togglePlayPause();
            } else {
                void this.handlers.onReadTarget(this.selectedSource);
            }
        });
        this.playBtn = playBtn;

        this.prevBtn = controls.createEl('button', {
            cls: 'sf-btn sf-tts-icon-btn',
            attr: { type: 'button', title: 'Previous chunk', 'aria-label': 'Previous chunk' },
        });
        setIcon(this.prevBtn, 'skip-back');
        this.prevBtn.addEventListener('click', () => void this.player.previous());

        this.nextBtn = controls.createEl('button', {
            cls: 'sf-btn sf-tts-icon-btn',
            attr: { type: 'button', title: 'Next chunk', 'aria-label': 'Next chunk' },
        });
        setIcon(this.nextBtn, 'skip-forward');
        this.nextBtn.addEventListener('click', () => void this.player.next());

        this.stopBtn = controls.createEl('button', {
            cls: 'sf-btn sf-tts-icon-btn',
            attr: { type: 'button', title: 'Stop reading aloud', 'aria-label': 'Stop reading aloud' },
        });
        setIcon(this.stopBtn, 'square');
        this.stopBtn.addEventListener('click', () => this.player.stop());

        const sourceSelect = controls.createEl('select', {
            cls: 'sf-tts-source',
            attr: { 'aria-label': 'Read aloud source' },
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

        this.speedBtn = controls.createEl('button', {
            cls: 'sf-btn sf-tts-chip-btn',
            attr: { type: 'button', title: 'Cycle reading speed' },
        });
        this.speedBtn.addEventListener('click', () => {
            const cur = this.player.getSettings().playbackSpeed;
            const nextIdx = SPEED_STEPS.findIndex(s => s > cur + 0.02);
            const next = nextIdx >= 0 ? SPEED_STEPS[nextIdx] : SPEED_STEPS[0];
            this.player.setPlaybackRate(next);
        });

        this.followBtn = controls.createEl('button', {
            cls: 'sf-btn sf-tts-chip-btn sf-tts-follow-btn',
            attr: { type: 'button', title: 'Toggle highlight auto-scroll' },
        });
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

        this.exportBtn = controls.createEl('button', {
            cls: 'sf-btn sf-tts-icon-btn',
            attr: { type: 'button', title: 'Export audio track', 'aria-label': 'Export audio track' },
        });
        setIcon(this.exportBtn, 'download');
        this.exportBtn.addEventListener('click', () => void this.player.exportCurrentTrack());

        const info = root.createDiv('sf-tts-info');
        this.captionEl = info.createDiv('sf-tts-caption');
        this.countEl = info.createDiv('sf-tts-count');

        const progress = root.createDiv('sf-tts-progress');
        this.fillEl = progress.createDiv('sf-tts-progress-fill');

        this.unsubscribe = this.player.subscribe(snapshot => this.render(snapshot));
        return () => this.unmount();
    }

    getSelectedSource(): TtsTargetSource {
        return this.selectedSource;
    }

    private render(snapshot: TtsPlayerSnapshot): void {
        const root = this.rootEl;
        if (!root) return;

        const isActive =
            snapshot.status === 'playing' ||
            snapshot.status === 'loading' ||
            snapshot.status === 'paused';

        root.toggleClass('is-active', isActive);
        root.toggleClass('is-playing', snapshot.status === 'playing');
        root.toggleClass('is-paused', snapshot.status === 'paused');
        root.toggleClass('is-loading', snapshot.status === 'loading');
        root.toggleClass('is-error', snapshot.status === 'error');

        if (this.playIconEl) {
            this.playIconEl.empty();
            setIcon(
                this.playIconEl,
                snapshot.status === 'playing'
                    ? 'pause'
                    : snapshot.status === 'loading'
                      ? 'loader'
                      : 'volume-2',
            );
        }

        const hasSegments = snapshot.segments.length > 0;
        if (this.prevBtn) this.prevBtn.disabled = !hasSegments || snapshot.currentIndex <= 0;
        if (this.nextBtn) {
            this.nextBtn.disabled = !hasSegments || snapshot.currentIndex >= snapshot.segments.length - 1;
        }
        if (this.stopBtn) this.stopBtn.disabled = !isActive;
        if (this.exportBtn) this.exportBtn.disabled = !hasSegments;

        if (this.speedBtn) {
            this.speedBtn.setText(`${snapshot.playbackRate.toFixed(snapshot.playbackRate % 1 === 0 ? 1 : 2)}x`);
        }

        if (this.followBtn) {
            const on = snapshot.autoScroll;
            this.followBtn.toggleClass('is-on', on);
            this.followBtn.toggleClass('is-paused', snapshot.autoScrollPausedByUser);
            this.followBtn.setAttribute('aria-pressed', String(on));
            this.followBtn.setText(snapshot.autoScrollPausedByUser ? 'Resume follow' : on ? 'Follow' : 'Manual');
        }

        if (this.captionEl) {
            if (snapshot.status === 'error') {
                this.captionEl.setText(snapshot.errorMessage || 'TTS error');
            } else if (snapshot.currentSegment) {
                this.captionEl.setText(snapshot.currentSegment.label || snapshot.currentSegment.text);
            } else if (snapshot.errorMessage) {
                this.captionEl.setText(snapshot.errorMessage);
            } else {
                this.captionEl.setText('Read aloud');
            }
        }

        if (this.countEl) {
            if (snapshot.segments.length > 0 && snapshot.currentIndex >= 0) {
                this.countEl.setText(`${snapshot.currentIndex + 1}/${snapshot.segments.length}`);
            } else {
                this.countEl.setText('');
            }
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
    }
}
