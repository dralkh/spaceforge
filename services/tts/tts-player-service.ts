import { Notice, normalizePath } from 'obsidian';
import type SpaceforgePlugin from '../../main';
import {
    AloudImportPreview,
    detectAloudSettingsPreview,
    parseAloudTtsSettings,
    TtsProviderId,
    TtsSettings,
    TtsTargetSource,
    TTS_EXPORT_DIR,
    TTS_HIDDEN_DIR,
} from '../../models/tts';
import {
    chunkTextWithOffsets,
    hashTtsCacheKey,
    resolveAutomaticNoteRange,
} from '../../utils/tts-text';
import type { AloudSegment } from './study-aloud-converter';
import { HtmlAudioTtsSink, TtsAudioSink, TtsPlaybackHandle } from './tts-audio-sink';
import {
    AloudSharedTtsCache,
    IndexedDBTtsCache,
    MemoryTtsCache,
    TtsCacheAdapter,
    VaultAdapterLike,
    VaultTtsCache,
} from './tts-cache';
import {
    defaultTtsTransport,
    describeActiveTtsModel,
    listTtsVoices,
    synthesizeSpeech,
    TtsAudioFormat,
    TtsHttpTransport,
    TtsSynthesizedAudio,
    TtsVoiceOption,
} from './tts-providers';

export type TtsPlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface TtsPlayerSnapshot {
    status: TtsPlaybackStatus;
    title: string;
    notePath: string | null;
    sourceSurface: AloudSegment['targetSurface'] | null;
    sourceMode: TtsTargetSource;
    segments: AloudSegment[];
    currentIndex: number;
    currentSegment: AloudSegment | null;
    playbackRate: number;
    autoScroll: boolean;
    autoScrollPausedByUser: boolean;
    errorMessage: string | null;
    provider: TtsProviderId;
}

export interface TtsPlayerDeps {
    getSettings: () => TtsSettings;
    saveSettings?: () => Promise<void>;
    vaultConfigDir?: string;
    vaultAdapter?: VaultAdapterLike | null;
    transport?: TtsHttpTransport;
    sink?: TtsAudioSink;
    cache?: TtsCacheAdapter;
}

export class TtsPlayerService {
    private deps: TtsPlayerDeps;
    private sink: TtsAudioSink;
    private transport: TtsHttpTransport;
    private memoryCache = new MemoryTtsCache();
    private idbCache: AloudSharedTtsCache | null = null;
    private vaultCache: VaultTtsCache | null = null;

    private listeners = new Set<(snapshot: TtsPlayerSnapshot) => void>();
    private activeHandle: TtsPlaybackHandle | null = null;
    private inflightAudio = new Map<string, Promise<TtsSynthesizedAudio>>();
    private runToken = 0;
    private synthesisChain: Promise<void> = Promise.resolve();

    private status: TtsPlaybackStatus = 'idle';
    private title = '';
    private notePath: string | null = null;
    private sourceSurface: AloudSegment['targetSurface'] | null = null;
    private sourceMode: TtsTargetSource = 'auto';
    private segments: AloudSegment[] = [];
    private currentIndex = -1;
    private autoScrollPausedByUser = false;
    private errorMessage: string | null = null;

    constructor(deps: TtsPlayerDeps) {
        this.deps = deps;
        this.sink = deps.sink ?? new HtmlAudioTtsSink();
        this.transport = deps.transport ?? defaultTtsTransport;
    }

    static fromPlugin(plugin: SpaceforgePlugin): TtsPlayerService {
        const adapter = plugin.app?.vault?.adapter as unknown as VaultAdapterLike | undefined;
        return new TtsPlayerService({
            getSettings: () => plugin.settings.tts,
            saveSettings: async () => { await plugin.savePluginData(); },
            vaultConfigDir: plugin.app?.vault?.configDir,
            vaultAdapter: adapter ?? null,
        });
    }

    getSettings(): TtsSettings {
        return this.deps.getSettings();
    }

    subscribe(listener: (snapshot: TtsPlayerSnapshot) => void): () => void {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => {
            this.listeners.delete(listener);
        };
    }

    getSnapshot(): TtsPlayerSnapshot {
        const settings = this.deps.getSettings();
        const currentSegment =
            this.currentIndex >= 0 && this.currentIndex < this.segments.length
                ? this.segments[this.currentIndex]
                : null;
        return {
            status: this.status,
            title: this.title,
            notePath: this.notePath,
            sourceSurface: this.sourceSurface,
            sourceMode: this.sourceMode,
            segments: this.segments,
            currentIndex: this.currentIndex,
            currentSegment,
            playbackRate: settings.playbackSpeed,
            autoScroll: settings.autoScroll && !this.autoScrollPausedByUser,
            autoScrollPausedByUser: this.autoScrollPausedByUser,
            errorMessage: this.errorMessage,
            provider: settings.provider,
        };
    }

    private emit(): void {
        const snap = this.getSnapshot();
        for (const listener of this.listeners) {
            try {
                listener(snap);
            } catch {
                // Keep UI subscribers isolated
            }
        }
    }

    private resolveCache(): TtsCacheAdapter {
        if (this.deps.cache) return this.deps.cache;
        const settings = this.deps.getSettings();
        if (settings.cacheType === 'vault' && this.deps.vaultAdapter) {
            // The same hidden folder Obsidian Aloud caches into: one place for
            // both plugins' audio, out of the way of the reader's notes.
            if (!this.vaultCache) {
                this.vaultCache = new VaultTtsCache(this.deps.vaultAdapter, TTS_HIDDEN_DIR);
            }
            return this.vaultCache;
        }
        if (typeof indexedDB !== 'undefined') {
            // On this device: inside Obsidian Aloud's own "Local" cache database.
            if (!this.idbCache) {
                this.idbCache = new AloudSharedTtsCache(new IndexedDBTtsCache());
            }
            return this.idbCache;
        }
        return this.memoryCache;
    }

    async expireCache(): Promise<void> {
        const settings = this.deps.getSettings();
        if (settings.cacheDurationMillis <= 0) return;
        try {
            await this.resolveCache().expire(settings.cacheDurationMillis);
        } catch {
            // Non-fatal
        }
    }

    async getCacheSize(): Promise<number> {
        try {
            return await this.resolveCache().getStorageSize();
        } catch {
            return 0;
        }
    }

    async clearCache(): Promise<void> {
        try {
            await this.resolveCache().clear();
        } catch {
            // Non-fatal
        }
    }

    /**
     * Play an ordered sequence of educational / note segments starting at `startIndex`.
     */
    async playSegments(options: {
        title: string;
        notePath: string | null;
        sourceSurface: AloudSegment['targetSurface'];
        segments: AloudSegment[];
        startIndex?: number;
        sourceMode?: TtsTargetSource;
    }): Promise<void> {
        const filtered = options.segments.filter(s => s.text.trim().length > 0);
        if (filtered.length === 0) {
            this.status = 'idle';
            this.errorMessage = 'Nothing readable found in this section.';
            this.emit();
            return;
        }

        this.stopInternal(false);
        this.title = options.title;
        this.notePath = options.notePath;
        this.sourceSurface = options.sourceSurface;
        this.sourceMode = options.sourceMode ?? this.deps.getSettings().defaultSource;
        this.segments = filtered;
        this.currentIndex = Math.max(0, Math.min(options.startIndex ?? 0, filtered.length - 1));
        this.autoScrollPausedByUser = false;
        this.errorMessage = null;

        void this.expireCache();
        await this.playIndex(this.currentIndex);
    }

    /**
     * Automatic note reader modeled after Aloud's ObsidianBridge:
     * uses active selection if substantial, otherwise extends from cursor to end of note (or full note).
     */
    async playNoteContent(options: {
        title: string;
        notePath: string;
        markdown: string;
        selectionFrom?: number;
        selectionTo?: number;
    }): Promise<void> {
        const settings = this.deps.getSettings();
        const range = resolveAutomaticNoteRange(options.markdown, options.selectionFrom, options.selectionTo);
        const spans = chunkTextWithOffsets(range.text, settings.chunkType, range.start);
        const segments: AloudSegment[] = spans.map((span, idx) => ({
            id: `note-${idx}-${span.start}`,
            text: span.spokenText,
            label: `${options.title} · Part ${idx + 1}`,
            targetSurface: 'note',
            noteRange: { start: span.start, end: span.end },
        }));

        await this.playSegments({
            title: options.title,
            notePath: options.notePath,
            sourceSurface: 'note',
            segments,
            sourceMode: 'note',
        });
    }

    async togglePlayPause(): Promise<void> {
        if (this.status === 'playing') {
            this.pause();
            return;
        }
        if (this.status === 'paused') {
            await this.resume();
            return;
        }
        if (this.segments.length > 0) {
            const idx = this.currentIndex >= 0 && this.currentIndex < this.segments.length ? this.currentIndex : 0;
            await this.playIndex(idx);
        }
    }

    pause(): void {
        if (this.status !== 'playing' && this.status !== 'loading') return;
        this.activeHandle?.pause();
        this.status = 'paused';
        this.emit();
    }

    async resume(): Promise<void> {
        if (this.status !== 'paused') return;
        if (this.activeHandle) {
            this.status = 'playing';
            this.emit();
            try {
                await this.activeHandle.resume();
            } catch (err) {
                this.status = 'error';
                this.errorMessage = err instanceof Error ? err.message : String(err);
                this.emit();
            }
            return;
        }
        if (this.currentIndex >= 0 && this.currentIndex < this.segments.length) {
            await this.playIndex(this.currentIndex);
        }
    }

    stop(): void {
        this.stopInternal(true);
    }

    private stopInternal(resetTrack: boolean): void {
        this.runToken += 1;
        this.activeHandle?.stop();
        this.activeHandle = null;
        this.status = 'idle';
        this.errorMessage = null;
        if (resetTrack) {
            this.currentIndex = -1;
            this.segments = [];
            this.sourceSurface = null;
            this.autoScrollPausedByUser = false;
        }
        this.emit();
    }

    async next(): Promise<void> {
        if (this.segments.length === 0) return;
        const nextIdx = Math.min(this.segments.length - 1, this.currentIndex + 1);
        if (nextIdx === this.currentIndex && this.status === 'playing') return;
        await this.playIndex(nextIdx);
    }

    async previous(): Promise<void> {
        if (this.segments.length === 0) return;
        const prevIdx = Math.max(0, this.currentIndex - 1);
        await this.playIndex(prevIdx);
    }

    async jumpTo(index: number): Promise<void> {
        if (index < 0 || index >= this.segments.length) return;
        await this.playIndex(index);
    }

    setPlaybackRate(rate: number): void {
        const clamped = Math.min(2.5, Math.max(0.5, Number(rate) || 1));
        const settings = this.deps.getSettings();
        settings.playbackSpeed = clamped;
        this.activeHandle?.setRate(clamped);
        void this.deps.saveSettings?.();
        this.emit();
    }

    setAutoScroll(enabled: boolean): void {
        const settings = this.deps.getSettings();
        settings.autoScroll = enabled;
        if (enabled) {
            this.autoScrollPausedByUser = false;
        }
        void this.deps.saveSettings?.();
        this.emit();
    }

    pauseAutoScrollByUser(): void {
        if (this.status !== 'playing' && this.status !== 'loading') return;
        if (!this.deps.getSettings().autoScroll || this.autoScrollPausedByUser) return;
        this.autoScrollPausedByUser = true;
        this.emit();
    }

    resumeAutoScroll(): void {
        this.autoScrollPausedByUser = false;
        const settings = this.deps.getSettings();
        if (!settings.autoScroll) {
            settings.autoScroll = true;
            void this.deps.saveSettings?.();
        }
        this.emit();
    }

    private runSerializedSynthesis<T>(task: () => Promise<T>): Promise<T> {
        const next = this.synthesisChain.then(task, task);
        this.synthesisChain = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }

    private async loadChunkAudio(text: string): Promise<TtsSynthesizedAudio> {
        const settings = this.deps.getSettings();
        const desc = describeActiveTtsModel(settings);
        const key = hashTtsCacheKey({
            text,
            provider: desc.provider,
            model: desc.model,
            voice: desc.voice,
            instructions: desc.instructions,
            apiUri: desc.apiUri,
            format: desc.format,
            speed: desc.speed,
        });

        const existingInflight = this.inflightAudio.get(key);
        if (existingInflight) return existingInflight;

        const work = (async (): Promise<TtsSynthesizedAudio> => {
            const cache = this.resolveCache();
            try {
                const cached = await cache.getAudio(key);
                if (cached) return cached;
            } catch {
                // Fall through to remote synthesis
            }

            return await this.runSerializedSynthesis(async () => {
                // Re-check cache once our turn in the queue arrives
                try {
                    const cachedAfterWait = await cache.getAudio(key);
                    if (cachedAfterWait) return cachedAfterWait;
                } catch {
                    // Ignore cache read errors
                }

                let lastErr: unknown;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        const synthesized = await synthesizeSpeech(text, settings, this.transport);
                        try {
                            await cache.saveAudio(key, synthesized);
                        } catch {
                            // Cache write failure is non-fatal
                        }
                        return synthesized;
                    } catch (err) {
                        lastErr = err;
                        const retryable = (err as { retryable?: boolean })?.retryable === true;
                        if (!retryable || attempt === 2) break;
                        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 500 : 1200));
                    }
                }
                throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
            });
        })();

        this.inflightAudio.set(key, work);
        try {
            return await work;
        } finally {
            this.inflightAudio.delete(key);
        }
    }

    private async prefetchAhead(fromIndex: number, token: number): Promise<void> {
        const limit = Math.min(this.segments.length - 1, fromIndex + 2);
        for (let i = fromIndex + 1; i <= limit; i++) {
            if (token !== this.runToken) return;
            const seg = this.segments[i];
            if (seg?.text) {
                try {
                    await this.loadChunkAudio(seg.text);
                } catch {
                    return;
                }
            }
        }
    }

    private async playIndex(index: number): Promise<void> {
        const token = ++this.runToken;
        this.activeHandle?.stop();
        this.activeHandle = null;

        if (index < 0 || index >= this.segments.length) {
            this.stopInternal(false);
            return;
        }

        this.currentIndex = index;
        this.status = 'loading';
        this.errorMessage = null;
        this.emit();

        try {
            const segment = this.segments[index];
            const audio = await this.loadChunkAudio(segment.text);
            if (token !== this.runToken) return;

            void this.prefetchAhead(index, token);

            const rate = this.deps.getSettings().playbackSpeed;
            const handle = this.sink.playChunk(audio, rate);
            if (token !== this.runToken) {
                handle.stop();
                return;
            }
            this.activeHandle = handle;
            this.status = 'playing';
            this.emit();

            void handle.finished.then(
                reason => {
                    if (token !== this.runToken || reason === 'stopped') return;
                    if (index + 1 < this.segments.length) {
                        void this.playIndex(index + 1);
                    } else {
                        this.activeHandle = null;
                        this.status = 'idle';
                        this.currentIndex = -1;
                        this.emit();
                    }
                },
                err => {
                    if (token !== this.runToken) return;
                    this.activeHandle = null;
                    this.status = 'error';
                    this.errorMessage = err instanceof Error ? err.message : String(err);
                    this.emit();
                },
            );
        } catch (err) {
            if (token !== this.runToken) return;
            this.activeHandle = null;
            this.status = 'error';
            this.errorMessage = err instanceof Error ? err.message : String(err);
            this.emit();
        }
    }

    /**
     * Synthesize a quick sample clip to test the currently active TTS endpoint in settings.
     */
    async testVoice(sampleText = 'Spaceforge text-to-speech is ready.'): Promise<void> {
        await this.playSegments({
            title: 'Voice check',
            notePath: null,
            sourceSurface: 'summary',
            segments: [
                {
                    id: 'voice-test',
                    text: sampleText,
                    label: 'Voice check',
                    targetSurface: 'summary',
                },
            ],
        });
    }

    async fetchVoices(): Promise<TtsVoiceOption[]> {
        return listTtsVoices(this.deps.getSettings(), this.transport);
    }

    /**
     * Export the current loaded track segments into one combined audio file (vault or browser download).
     */
    async exportCurrentTrack(): Promise<string | null> {
        if (this.segments.length === 0) {
            new Notice('Load or play something before exporting audio.');
            return null;
        }
        const buffers: ArrayBuffer[] = [];
        let format: TtsAudioFormat = 'mp3';
        for (const seg of this.segments) {
            const audio = await this.loadChunkAudio(seg.text);
            buffers.push(audio.data);
            format = audio.format;
        }
        const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const buf of buffers) {
            merged.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        }

        const settings = this.deps.getSettings();
        const safeName = (this.title || 'spaceforge-audio')
            .replace(/[^a-zA-Z0-9._ -]+/g, '')
            .trim()
            .replace(/\s+/g, '-') || 'spaceforge-audio';
        const filename = `${safeName}-${Date.now()}.${format}`;

        const destination = settings.audioExportDestination;
        if ((destination === 'cache' || destination === 'vault') && this.deps.vaultAdapter?.writeBinary) {
            const folder = normalizePath(
                destination === 'cache' ? TTS_EXPORT_DIR : (settings.audioFolder || 'spaceforge/tts-audio'),
            );
            if (this.deps.vaultAdapter.mkdir && !(await this.deps.vaultAdapter.exists(folder))) {
                const segs = folder.split('/').filter(Boolean);
                let cur = '';
                for (const s of segs) {
                    cur = cur ? `${cur}/${s}` : s;
                    if (!(await this.deps.vaultAdapter.exists(cur))) {
                        await this.deps.vaultAdapter.mkdir(cur);
                    }
                }
            }
            const dest = `${folder}/${filename}`;
            await this.deps.vaultAdapter.writeBinary(dest, merged.buffer);
            new Notice(`Saved audio to ${dest}`);
            return dest;
        }

        if (typeof Blob !== 'undefined' && typeof document !== 'undefined' && typeof URL !== 'undefined') {
            const blob = new Blob([merged.buffer], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            new Notice(`Downloaded ${filename}`);
            return filename;
        }
        return null;
    }

    /**
     * Resolve candidate paths where obsidian-aloud-tts saves its `data.json`.
     */
    private getAloudCandidatePaths(): string[] {
        const configDir = this.deps.vaultConfigDir?.trim();
        if (!configDir) return [];
        const custom = this.deps.getSettings().useVaultAloudSettingsPath?.trim();
        const candidates = [
            custom ? `${configDir}/${custom.replace(/^\/+/, '')}` : '',
            `${configDir}/plugins/aloud-tts/data.json`,
            `${configDir}/plugins/tts-aloud/data.json`,
        ].filter(Boolean);
        return [...new Set(candidates.map(p => normalizePath(p)))];
    }

    async detectAloudSettings(): Promise<{ path: string; preview: AloudImportPreview; raw: unknown } | null> {
        const adapter = this.deps.vaultAdapter;
        if (!adapter) return null;
        for (const candidate of this.getAloudCandidatePaths()) {
            try {
                if (!(await adapter.exists(candidate))) continue;
                const rawText = await adapter.read(candidate);
                const rawJson = JSON.parse(rawText) as unknown;
                const preview = detectAloudSettingsPreview(rawJson);
                if (preview) {
                    return { path: candidate, preview, raw: rawJson };
                }
            } catch {
                // Keep checking remaining candidates
            }
        }
        return null;
    }

    async importFromAloudSettings(): Promise<{ imported: boolean; sourcePath?: string; provider?: TtsProviderId }> {
        const detected = await this.detectAloudSettings();
        if (!detected) return { imported: false };
        const patch = parseAloudTtsSettings(detected.raw);
        if (!patch) return { imported: false };

        const target = this.deps.getSettings();
        Object.assign(target, patch);
        await this.deps.saveSettings?.();
        this.emit();
        return {
            imported: true,
            sourcePath: detected.path,
            provider: detected.preview.provider,
        };
    }

    destroy(): void {
        this.stopInternal(true);
        this.sink.destroy();
        this.listeners.clear();
    }
}
