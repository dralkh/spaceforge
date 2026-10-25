import { EstimationUtils } from '../utils/estimation';

/**
 * How many words each note holds, kept between renders.
 *
 * The calendar has to add up a day's reading time, and that means knowing the word
 * count of every note due — not the file's size in kilobytes. Reading a note is
 * cheap; reading four hundred of them on every render is not. So each note is read
 * once, its count is kept against the file's modification stamp, and every later
 * question is answered from memory. When a note changes, its stamp changes and it is
 * read again.
 *
 * The stamp is `mtime:size`, which the vault already has on every file: deciding
 * whether a note needs reading costs no read at all.
 */
export interface WordCountSource {
    /** The note's text, or null if it cannot be read. */
    read(path: string): Promise<string | null>;
    /** A stamp that changes whenever the text could have changed, or null if gone. */
    stamp(path: string): string | null;
}

interface Entry {
    stamp: string;
    words: number;
}

export class WordCountCache {
    private readonly counts = new Map<string, Entry>();
    private readonly queued = new Set<string>();
    private queue: string[] = [];
    private draining: Promise<void> | null = null;

    constructor(
        private readonly source: WordCountSource,
        private readonly concurrency = 6,
    ) {}

    /** The count, if this note has been read since it last changed. */
    words(path: string): number | null {
        const entry = this.counts.get(path);
        if (!entry) return null;
        const stamp = this.source.stamp(path);
        if (stamp === null || stamp !== entry.stamp) {
            this.counts.delete(path);
            return null;
        }
        return entry.words;
    }

    /**
     * Record a count for text that was just read for another reason, so reading a
     * note's body and pricing it are the same read.
     */
    remember(path: string, text: string): void {
        const stamp = this.source.stamp(path);
        if (stamp === null) return;
        this.counts.set(path, { stamp, words: EstimationUtils.countWords(text) });
    }

    /** Forget a note, so the next question about it reads the file again. */
    forget(path: string): void {
        this.counts.delete(path);
    }

    /** How many notes are known right now. */
    get known(): number {
        return this.counts.size;
    }

    /**
     * Read whatever is not known yet, and answer how many of `paths` are known
     * afterwards. Notes already queued, in flight, or unchanged are not read again,
     * so calling this on every render costs nothing after the first pass.
     */
    async prime(paths: string[]): Promise<number> {
        for (const path of paths) {
            if (this.queued.has(path)) continue;
            if (this.words(path) !== null) continue;
            this.queued.add(path);
            this.queue.push(path);
        }

        while (this.queue.length > 0) {
            const run = this.draining ?? (this.draining = this.drain());
            try {
                await run;
            } finally {
                if (this.draining === run) this.draining = null;
            }
        }

        return paths.filter(path => this.words(path) !== null).length;
    }

    private async drain(): Promise<void> {
        const worker = async (): Promise<void> => {
            for (;;) {
                const path = this.queue.shift();
                if (path === undefined) return;
                this.queued.delete(path);

                const stamp = this.source.stamp(path);
                if (stamp === null) {
                    this.counts.delete(path);
                    continue;
                }
                const known = this.counts.get(path);
                if (known && known.stamp === stamp) continue;

                const text = await this.source.read(path);
                if (text === null) {
                    this.counts.delete(path);
                    continue;
                }
                this.counts.set(path, { stamp, words: EstimationUtils.countWords(text) });
            }
        };

        const width = Math.max(1, Math.min(this.concurrency, this.queue.length));
        await Promise.all(Array.from({ length: width }, () => worker()));
    }
}
