import type { TtsSynthesizedAudio } from './tts-providers';

export interface TtsPlaybackHandle {
    pause(): void;
    resume(): Promise<void>;
    stop(): void;
    setRate(rate: number): void;
    finished: Promise<'ended' | 'stopped'>;
}

export interface TtsAudioSink {
    playChunk(audio: TtsSynthesizedAudio, playbackRate: number): TtsPlaybackHandle;
    destroy(): void;
}

/**
 * Browser HTMLAudioElement playback sink supporting MP3 & WAV with variable playbackRate
 * and deterministic Blob URL cleanup.
 */
export class HtmlAudioTtsSink implements TtsAudioSink {
    private activeStop: (() => void) | null = null;

    playChunk(audio: TtsSynthesizedAudio, playbackRate: number): TtsPlaybackHandle {
        this.activeStop?.();

        if (typeof Audio === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
            return {
                pause: () => undefined,
                resume: () => Promise.resolve(),
                stop: () => undefined,
                setRate: () => undefined,
                finished: Promise.resolve('stopped'),
            };
        }

        const mime = audio.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
        const blob = new Blob([audio.data], { type: mime });
        const objectUrl = URL.createObjectURL(blob);
        const element = new Audio(objectUrl);
        element.playbackRate = playbackRate;
        if ('preservesPitch' in element) {
            (element as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
        }

        let settled = false;
        let resolveFinished!: (reason: 'ended' | 'stopped') => void;
        let rejectFinished!: (err: Error) => void;
        const finished = new Promise<'ended' | 'stopped'>((resolve, reject) => {
            resolveFinished = resolve;
            rejectFinished = reject;
        });

        const cleanup = () => {
            element.removeEventListener('ended', onEnded);
            element.removeEventListener('error', onError);
            try {
                element.pause();
                element.removeAttribute('src');
                element.load();
            } catch {
                // Ignore DOM teardown edge cases
            }
            try {
                URL.revokeObjectURL(objectUrl);
            } catch {
                // Ignore revoke errors
            }
            if (this.activeStop === stop) {
                this.activeStop = null;
            }
        };

        const onEnded = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolveFinished('ended');
        };

        const onError = () => {
            if (settled) return;
            settled = true;
            const code = element.error?.code ?? 0;
            cleanup();
            rejectFinished(new Error(`Audio playback error (media code ${code})`));
        };

        const stop = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolveFinished('stopped');
        };

        this.activeStop = stop;
        element.addEventListener('ended', onEnded);
        element.addEventListener('error', onError);

        void element.play().catch((err: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectFinished(err instanceof Error ? err : new Error(String(err)));
        });

        return {
            pause: () => {
                if (!settled) element.pause();
            },
            resume: async () => {
                if (!settled) {
                    element.playbackRate = playbackRate;
                    await element.play();
                }
            },
            stop,
            setRate: (rate: number) => {
                element.playbackRate = rate;
            },
            finished,
        };
    }

    destroy(): void {
        this.activeStop?.();
        this.activeStop = null;
    }
}
