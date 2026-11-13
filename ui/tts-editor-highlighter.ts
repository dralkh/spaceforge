import { App, MarkdownView, TFile } from 'obsidian';
import type { TtsPlayerSnapshot } from '../services/tts/tts-player-service';

const ACTIVE_CLASS = 'sf-tts-active-segment';

/**
 * Highlights the active spoken chunk inside an open MarkdownView (both Edit/Live Preview
 * and Reading/Preview mode) and smoothly scrolls to it while auto-scroll is active.
 */
export class TtsEditorHighlighter {
    private app: App;
    private onManualScroll: () => void;
    private previewHighlightedEl: HTMLElement | null = null;
    private boundScrollContainers = new WeakSet<HTMLElement>();

    constructor(app: App, onManualScroll: () => void) {
        this.app = app;
        this.onManualScroll = onManualScroll;
    }

    sync(snapshot: TtsPlayerSnapshot): void {
        this.clearPreviewHighlight();

        const seg = snapshot.currentSegment;
        const active =
            (snapshot.status === 'playing' || snapshot.status === 'loading' || snapshot.status === 'paused') &&
            seg &&
            seg.targetSurface === 'note' &&
            seg.noteRange;

        if (!active || !snapshot.notePath || !seg?.noteRange) {
            return;
        }

        const view = this.findMarkdownViewForPath(snapshot.notePath);
        if (!view) return;

        this.attachScrollDetector(view);

        const mode = typeof view.getMode === 'function' ? view.getMode() : 'source';
        if (mode === 'preview') {
            this.highlightInPreview(view, seg.text, snapshot.autoScroll);
            return;
        }

        const editor = view.editor;
        if (!editor || typeof editor.offsetToPos !== 'function') return;

        const maxLen = editor.getValue().length;
        const startOffset = Math.max(0, Math.min(seg.noteRange.start, maxLen));
        const endOffset = Math.max(startOffset, Math.min(seg.noteRange.end, maxLen));
        const from = editor.offsetToPos(startOffset);
        const to = editor.offsetToPos(endOffset);

        this.highlightCodeMirrorLine(view, from.line);

        if (snapshot.autoScroll && typeof editor.scrollIntoView === 'function') {
            editor.scrollIntoView({ from, to }, true);
        }
    }

    clear(): void {
        this.clearPreviewHighlight();
    }

    private findMarkdownViewForPath(notePath: string): MarkdownView | null {
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (active?.file instanceof TFile && active.file.path === notePath) {
            return active;
        }
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            const view = leaf.view;
            if (view instanceof MarkdownView && view.file instanceof TFile && view.file.path === notePath) {
                return view;
            }
        }
        return null;
    }

    private attachScrollDetector(view: MarkdownView): void {
        const container = view.containerEl;
        if (!container || typeof container.querySelector !== 'function') return;
        const scroller =
            container.querySelector<HTMLElement>('.cm-scroller') ??
            container.querySelector<HTMLElement>('.markdown-preview-view');
        if (!scroller || this.boundScrollContainers.has(scroller)) return;

        this.boundScrollContainers.add(scroller);
        scroller.addEventListener(
            'wheel',
            () => {
                this.onManualScroll();
            },
            { passive: true },
        );
        scroller.addEventListener(
            'touchmove',
            () => {
                this.onManualScroll();
            },
            { passive: true },
        );
    }

    private highlightCodeMirrorLine(view: MarkdownView, zeroBasedLine: number): void {
        const container = view.containerEl;
        if (!container || typeof container.querySelectorAll !== 'function') return;
        const lines = container.querySelectorAll('.cm-line');
        // Note: CM6 virtualizes lines, so also match via line element if visible; fallback selects cleanly
        if (lines.length === 0) return;

        // Best-effort highlight using current cursor/selection + visible DOM line matching
        const editor = view.editor;
        if (!editor) return;
        const lineText = editor.getLine(zeroBasedLine)?.trim();
        if (!lineText) return;
        const probe = lineText.slice(0, 32);
        for (let i = 0; i < lines.length; i++) {
            const el = lines[i] as HTMLElement;
            if ((el.textContent || '').includes(probe)) {
                el.classList.add(ACTIVE_CLASS);
                this.previewHighlightedEl = el;
                break;
            }
        }
    }

    private highlightInPreview(view: MarkdownView, spokenText: string, autoScroll: boolean): void {
        const container = view.containerEl;
        if (!container || typeof container.querySelectorAll !== 'function') return;
        const blocks = container.querySelectorAll(
            '.markdown-preview-section p, .markdown-preview-section li, .markdown-preview-section h1, .markdown-preview-section h2, .markdown-preview-section h3, .markdown-preview-section h4, .markdown-preview-section blockquote',
        );
        if (blocks.length === 0) return;

        const needle = spokenText
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
            .trim()
            .slice(0, 40);
        if (!needle) return;

        const firstWords = needle.split(/\s+/).slice(0, 4).join(' ');
        for (let i = 0; i < blocks.length; i++) {
            const el = blocks[i] as HTMLElement;
            const candidate = (el.textContent || '')
                .toLowerCase()
                .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
                .trim();
            if (candidate.includes(firstWords)) {
                el.classList.add(ACTIVE_CLASS);
                this.previewHighlightedEl = el;
                if (autoScroll) {
                    el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
                }
                break;
            }
        }
    }

    private clearPreviewHighlight(): void {
        if (this.previewHighlightedEl) {
            this.previewHighlightedEl.classList?.remove(ACTIVE_CLASS);
            this.previewHighlightedEl = null;
        }
    }
}
