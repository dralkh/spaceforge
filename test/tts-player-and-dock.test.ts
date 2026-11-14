import test from 'node:test';
import assert from 'node:assert/strict';

import { MiniElement, installMiniDocument } from './support/mini-dom';
import { DEFAULT_TTS_SETTINGS, normalizeTtsSettings } from '../models/tts';
import { StudyVisualPack } from '../models/study-visuals';
import { MemoryTtsCache } from '../services/tts/tts-cache';
import { TtsAudioSink, TtsPlaybackHandle } from '../services/tts/tts-audio-sink';
import { TtsPlayerService } from '../services/tts/tts-player-service';
import { ReviewDock } from '../ui/review-dock';
import { StudyController } from '../controllers/study-controller';
import { StudySummaryView } from '../ui/study-visual-board';
import { StudyMindMapView } from '../ui/study-mindmap';
import { StudyVisualGalleryView } from '../ui/study-visual-gallery';

class FakeAudioSink implements TtsAudioSink {
    handles: Array<{
        rate: number;
        paused: boolean;
        stopped: boolean;
        complete: () => void;
        stop: () => void;
    }> = [];

    playChunk(_audio: unknown, playbackRate: number): TtsPlaybackHandle {
        let resolve!: (reason: 'ended' | 'stopped') => void;
        const finished = new Promise<'ended' | 'stopped'>(r => { resolve = r; });
        const stop = () => {
            if (!entry.stopped) {
                entry.stopped = true;
                resolve('stopped');
            }
        };
        const entry = {
            rate: playbackRate,
            paused: false,
            stopped: false,
            complete: () => {
                if (!entry.stopped) resolve('ended');
            },
            stop,
        };
        this.handles.push(entry);
        return {
            pause: () => { entry.paused = true; },
            resume: async () => { entry.paused = false; },
            stop,
            setRate: rate => { entry.rate = rate; },
            finished,
        };
    }

    destroy(): void {
        for (const h of this.handles) h.stop();
    }
}

test('TtsPlayerService caches synthesized chunks, prefetches lookahead, and pauses auto-scroll on manual scroll', async () => {
    const settings = normalizeTtsSettings({
        ...DEFAULT_TTS_SETTINGS,
        provider: 'openai',
        openai_apiKey: 'sk-test',
        autoScroll: true,
    });

    let apiCalls = 0;
    const sink = new FakeAudioSink();
    const cache = new MemoryTtsCache();
    const service = new TtsPlayerService({
        getSettings: () => settings,
        sink,
        cache,
        transport: async () => {
            apiCalls += 1;
            return {
                status: 200,
                headers: {},
                arrayBuffer: new Uint8Array([1, 2, 3, 4]).buffer,
                text: '',
                json: undefined,
            };
        },
    });

    await service.playSegments({
        title: 'Test Note',
        notePath: 'notes/a.md',
        sourceSurface: 'summary',
        segments: [
            { id: 's1', text: 'First chunk.', label: 'One', targetSurface: 'summary' },
            { id: 's2', text: 'Second chunk.', label: 'Two', targetSurface: 'summary' },
        ],
    });

    assert.equal(service.getSnapshot().status, 'playing');
    assert.equal(service.getSnapshot().currentIndex, 0);
    assert.equal(service.getSnapshot().autoScroll, true);

    // Manual scroll pauses auto-scroll until user resumes follow
    service.pauseAutoScrollByUser();
    assert.equal(service.getSnapshot().autoScroll, false);
    assert.equal(service.getSnapshot().autoScrollPausedByUser, true);

    service.resumeAutoScroll();
    assert.equal(service.getSnapshot().autoScroll, true);
    assert.equal(service.getSnapshot().autoScrollPausedByUser, false);

    // Pause / resume / speed adjustments
    service.pause();
    assert.equal(service.getSnapshot().status, 'paused');
    assert.equal(sink.handles[0].paused, true);

    await service.resume();
    assert.equal(service.getSnapshot().status, 'playing');
    service.setPlaybackRate(1.75);
    assert.equal(sink.handles[0].rate, 1.75);

    // Advance to second chunk cleanly and verify cached replay makes 0 new API calls
    await new Promise(resolve => setTimeout(resolve, 20)); // allow prefetch to populate cache
    const callsAfterFirst = apiCalls;
    await service.next();
    assert.equal(service.getSnapshot().currentIndex, 1);

    await service.previous();
    assert.equal(service.getSnapshot().currentIndex, 0);
    assert.equal(apiCalls, callsAfterFirst, 'cached chunks reuse storage without calling endpoint again');

    service.destroy();
});

test('TtsPlayerService detects and imports obsidian-aloud-tts data.json from the vault', async () => {
    const settings = normalizeTtsSettings(DEFAULT_TTS_SETTINGS);
    let saved = 0;

    const aloudPayload = JSON.stringify({
        modelProvider: 'gemini',
        gemini_apiKey: 'AIza-imported',
        gemini_ttsVoice: 'Kore',
        playbackSpeed: 1.5,
        chunkType: 'paragraph',
        cacheType: 'vault',
        audioFolder: 'TTS-Vault',
    });

    const service = new TtsPlayerService({
        getSettings: () => settings,
        saveSettings: async () => { saved += 1; },
        vaultConfigDir: '.obsidian',
        vaultAdapter: {
            exists: async path => path === '.obsidian/plugins/aloud-tts/data.json',
            read: async () => aloudPayload,
            write: async () => undefined,
        },
        sink: new FakeAudioSink(),
        cache: new MemoryTtsCache(),
    });

    const preview = await service.detectAloudSettings();
    assert.ok(preview);
    assert.equal(preview.preview.provider, 'gemini');

    const res = await service.importFromAloudSettings();
    assert.equal(res.imported, true);
    assert.equal(res.provider, 'gemini');
    assert.equal(settings.provider, 'gemini');
    assert.equal(settings.gemini_apiKey, 'AIza-imported');
    assert.equal(settings.gemini_ttsVoice, 'Kore');
    assert.equal(settings.playbackSpeed, 1.5);
    assert.equal(settings.chunkType, 'paragraph');
    assert.equal(settings.cacheType, 'vault');
    assert.equal(settings.audioFolder, 'TTS-Vault');
    assert.equal(saved, 1);

    service.destroy();
});

test('StudySummaryView, StudyMindMapView, and StudyVisualGalleryView highlight and scroll active TTS segments', () => {
    installMiniDocument();

    const scrollCalls: Array<{ cls: string; opts: unknown }> = [];
    const patchScroll = (root: MiniElement) => {
        const visit = (el: MiniElement) => {
            (el as unknown as { scrollIntoView: (o?: unknown) => void }).scrollIntoView = (opts?: unknown) => {
                scrollCalls.push({ cls: Array.from(el.classes).join(' '), opts });
            };
            for (const kid of el.children) visit(kid);
        };
        visit(root);
    };

    // 1. Summary highlight + scroll
    const sumHost = new MiniElement('div');
    const summaryView = new StudySummaryView();
    summaryView.mount(sumHost as unknown as HTMLElement, {
        title: 'Summary Title',
        bullets: [
            { text: 'Bullet 0', emphasis: 'pearl', children: ['Child 0'] },
            { text: 'Bullet 1', emphasis: 'normal' },
        ],
        kept: 'Kept line',
    });
    patchScroll(sumHost);
    summaryView.highlightTtsTarget({ kind: 'child', bulletIndex: 0, childIndex: 0 }, true);
    assert.ok(sumHost.find(el => el.hasClass('sf-sum-child') && el.hasClass('sf-tts-active-segment')));
    assert.ok(scrollCalls.some(c => c.cls.includes('sf-sum-child')));

    // 2. Mind map expands collapsed branch, focuses node, highlights, and scrolls
    const mmHost = new MiniElement('div');
    const mmView = new StudyMindMapView({
        state: { collapsed: ['0.0'], focused: null },
    });
    mmView.mount(mmHost as unknown as HTMLElement, {
        title: 'Map',
        root: {
            id: 'r',
            label: 'Root',
            children: [
                {
                    id: 'b1',
                    label: 'Branch 1',
                    children: [{ id: 'leaf1', label: 'Hidden Leaf', detail: 'Important mechanism' }],
                },
            ],
        },
    });
    patchScroll(mmHost);
    mmView.highlightTtsNode({ nodeId: 'leaf1', nodeKey: '0.0.0' }, true);
    assert.equal(mmView.getFocusedId(), 'leaf1');
    assert.ok(mmHost.find(el => el.hasClass('sf-mm-node') && el.hasClass('sf-tts-active-segment')));
    assert.ok(scrollCalls.some(c => c.cls.includes('sf-mm-node')));

    // 3. Visual gallery opens collapsed card 2, highlights step item, and scrolls
    const vgHost = new MiniElement('div');
    const vgView = new StudyVisualGalleryView();
    vgView.mount(vgHost as unknown as HTMLElement, [
        {
            kind: 'timeline',
            title: 'First Card',
            entries: [{ when: 't0', label: 'A' }],
        },
        {
            kind: 'flow',
            title: 'Collapsed Flow Card',
            steps: [
                { id: 's1', label: 'Step A' },
                { id: 's2', label: 'Step B', kind: 'outcome' },
            ],
        },
    ]);
    patchScroll(vgHost);
    vgView.highlightTtsTarget(
        { visualIndex: 1, visualKind: 'flow', cardTitle: 'Collapsed Flow Card', itemIndex: 1, subRole: 'item' },
        true,
    );
    const cards = vgHost.byClass('sf-vg-card');
    assert.equal(cards[1].hasClass('is-open'), true);
    assert.equal(cards[1].hasClass('sf-tts-active-card'), true);
    assert.ok(cards[1].find(el => el.hasClass('sf-vb-step') && el.hasClass('sf-tts-active-segment')));
});

test('ReviewDock integrates TtsPlayerBar and automatically selects and reads Mind map / Visualize / Summary / Note', async () => {
    installMiniDocument();
    const settings = {
        ...normalizeTtsSettings({
            ...DEFAULT_TTS_SETTINGS,
            provider: 'openai',
            openai_apiKey: 'sk-dock',
        }),
    };

    const sink = new FakeAudioSink();
    const ttsService = new TtsPlayerService({
        getSettings: () => settings,
        sink,
        cache: new MemoryTtsCache(),
        transport: async () => ({
            status: 200,
            headers: {},
            arrayBuffer: new Uint8Array([9, 8, 7, 6]).buffer,
            text: '',
            json: undefined,
        }),
    });

    const visualPack: StudyVisualPack = {
        version: 1,
        domain: 'general',
        mindMap: {
            title: 'Optics',
            root: {
                id: 'root',
                label: 'Light',
                children: [{ id: 'refl', label: 'Reflection', detail: 'Angle in equals angle out.' }],
            },
        },
        visuals: [
            {
                kind: 'compare',
                title: 'Concave vs Convex',
                columns: ['Concave', 'Convex'],
                rows: [{ label: 'Focus', cells: ['Converges', 'Diverges'] }],
            },
        ],
        summary: {
            title: 'Optics Summary',
            bullets: [{ text: 'Light obeys Snell law.', emphasis: 'pearl' }],
        },
        generatedAt: 1,
        sourceHash: 'abc',
    };

    const plugin = {
        app: {
            vault: {
                getAbstractFileByPath: () => null,
                cachedRead: async () => 'Light bends across boundaries.',
                on: () => ({ id: 'ref' }),
                offref: () => undefined,
            },
            workspace: {
                getActiveViewOfType: () => null,
                getLeavesOfType: () => [],
            },
        },
        settings: {
            studyEnabled: true,
            enableMCQ: false,
            mcqGradingMode: 'ask',
            reviewDockHeight: 0,
            reviewStripIntervalPreviews: false,
            reviewStripGradeKeys: true,
            defaultSchedulingAlgorithm: 'fsrs',
            studyAutoRateNote: false,
            tts: settings,
        },
        ttsService,
        studyVisualService: { isStale: () => false },
        studyChartQueue: { getPreparationStatus: () => null },
        savePluginData: async () => true,
    };

    const controller = {
        planService: {
            getPlan: () => ({
                notePath: 'notes/optics.md',
                objectives: [],
                visuals: visualPack,
                domainId: 'general',
            }),
            getProgress: () => null,
            ensureProgress: () => ({ notePath: 'notes/optics.md', objectiveStates: {} }),
            sessionsForNote: () => [],
            dueObjectives: () => [],
            mostRecentSession: () => null,
            isStale: () => false,
            coverageCount: () => 0,
            overallMastery: () => 0,
            savePlan: () => undefined,
            saveProgress: () => undefined,
        },
        chartUpdate: () => null,
        subscribeChart: () => () => undefined,
        searchService: { status: () => ({ ok: false }) },
        status: () => ({ ok: false }),
        isCharting: () => false,
        setStudyingNote: () => undefined,
        readNote: async () => '---\ntopic: physics\n---\nLight bends across boundaries.',
    } as unknown as StudyController;

    const root = new MiniElement('div');
    const dock = new ReviewDock(plugin as never, controller);
    dock.mountInto(root as unknown as HTMLElement);
    dock.setPath('notes/optics.md');

    assert.ok(root.find(el => el.hasClass('sf-tts-bar')), 'ReviewDock mounts compact TtsPlayerBar');

    // Read mind map directly -> opens study tab, converts map to segments, highlights node
    await dock.readAloud('mindmap');
    const mmSnap = ttsService.getSnapshot();
    assert.equal(mmSnap.status, 'playing');
    assert.equal(mmSnap.sourceSurface, 'mindmap');
    assert.equal(mmSnap.segments.length, 2);
    assert.match(mmSnap.segments[1].text, /Angle in equals angle out/);

    // Auto mode while Visualize view is active reads Visualize segments
    await dock.readAloud('visualize');
    assert.equal(ttsService.getSnapshot().sourceSurface, 'visualize');
    assert.equal(ttsService.getSnapshot().segments[0].visualTarget?.visualKind, 'compare');

    await dock.readAloud('auto');
    assert.equal(ttsService.getSnapshot().sourceSurface, 'visualize');

    // Summary mode reads summary directly
    await dock.readAloud('summary');
    assert.equal(ttsService.getSnapshot().sourceSurface, 'summary');
    assert.match(ttsService.getSnapshot().segments[1].text, /Snell law/);

    // Note mode reads note skipping frontmatter
    await dock.readAloud('note');
    assert.equal(ttsService.getSnapshot().sourceSurface, 'note');
    assert.match(ttsService.getSnapshot().segments[0].text, /Light bends across boundaries/);

    // The reader leaves Summary for Visualize while Summary is being read: the
    // track's highlight never pulls them back, and Play reads Visualize — the
    // view on screen — instead of resuming the Summary track.
    await dock.readAloud('summary');
    assert.equal(dock.tabState().view, 'summary');
    dock.openTab('study', 'board');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dock.tabState().view, 'board', 'a Summary track does not drag the reader back to Summary');
    assert.equal(dock.tabState().listen?.playing, false, 'the speaker offers to read Visualize, not to pause Summary');
    if (ttsService.getSnapshot().status === 'playing') await ttsService.togglePlayPause();
    dock.toggleListen();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(ttsService.getSnapshot().sourceSurface, 'visualize', 'Play reads what is on screen');

    await new Promise(resolve => setTimeout(resolve, 15));
    dock.destroy();
    ttsService.destroy();
});
