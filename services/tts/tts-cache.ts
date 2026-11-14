import { normalizePath } from 'obsidian';
import type { TtsAudioFormat, TtsSynthesizedAudio } from './tts-providers';

export interface TtsCacheAdapter {
    getAudio(key: string): Promise<TtsSynthesizedAudio | null>;
    saveAudio(key: string, audio: TtsSynthesizedAudio): Promise<void>;
    expire(olderThanMillis: number): Promise<void>;
    getStorageSize(): Promise<number>;
    clear(): Promise<void>;
}

interface CacheIndexEntry {
    key: string;
    format: TtsAudioFormat;
    size: number;
    lastRead: number;
}

/**
 * In-memory audio cache (used in Node/unit tests and as fallback).
 */
export class MemoryTtsCache implements TtsCacheAdapter {
    private entries = new Map<string, { audio: TtsSynthesizedAudio; lastRead: number; size: number }>();

    getAudio(key: string): Promise<TtsSynthesizedAudio | null> {
        const hit = this.entries.get(key);
        if (!hit) return Promise.resolve(null);
        hit.lastRead = Date.now();
        return Promise.resolve(hit.audio);
    }

    saveAudio(key: string, audio: TtsSynthesizedAudio): Promise<void> {
        this.entries.set(key, {
            audio: { data: audio.data.slice(0), format: audio.format },
            lastRead: Date.now(),
            size: audio.data.byteLength,
        });
        return Promise.resolve();
    }

    expire(olderThanMillis: number): Promise<void> {
        if (olderThanMillis <= 0) return Promise.resolve();
        const cutoff = Date.now() - olderThanMillis;
        for (const [key, entry] of this.entries.entries()) {
            if (entry.lastRead < cutoff) {
                this.entries.delete(key);
            }
        }
        return Promise.resolve();
    }

    getStorageSize(): Promise<number> {
        let total = 0;
        for (const entry of this.entries.values()) {
            total += entry.size;
        }
        return Promise.resolve(total);
    }

    clear(): Promise<void> {
        this.entries.clear();
        return Promise.resolve();
    }
}

/**
 * Zero-dependency browser IndexedDB audio cache inspired by obsidian-aloud-tts.
 */
export class IndexedDBTtsCache implements TtsCacheAdapter {
    private dbPromise: Promise<IDBDatabase> | null = null;
    private readonly dbName: string;

    constructor(dbName = 'spaceforge-tts-cache') {
        this.dbName = dbName;
    }

    private open(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise;
        if (typeof indexedDB === 'undefined') {
            return Promise.reject(new Error('IndexedDB unavailable'));
        }
        this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('audio')) {
                    db.createObjectStore('audio', { keyPath: 'key' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    const meta = db.createObjectStore('meta', { keyPath: 'key' });
                    meta.createIndex('lastRead', 'lastRead', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error('Failed to open TTS cache DB'));
        });
        return this.dbPromise;
    }

    async getAudio(key: string): Promise<TtsSynthesizedAudio | null> {
        const db = await this.open();
        const record = await new Promise<{ key: string; buffer: ArrayBuffer; format: TtsAudioFormat } | undefined>(
            (resolve, reject) => {
                const tx = db.transaction(['audio'], 'readonly');
                const req = tx.objectStore('audio').get(key);
                req.onsuccess = () => resolve(req.result as { key: string; buffer: ArrayBuffer; format: TtsAudioFormat } | undefined);
                req.onerror = () => reject(req.error);
            },
        );
        if (!record) return null;

        // Touch metadata timestamp
        const tx = db.transaction(['meta'], 'readwrite');
        tx.objectStore('meta').put({
            key,
            format: record.format,
            size: record.buffer.byteLength,
            lastRead: Date.now(),
        } satisfies CacheIndexEntry);

        return { data: record.buffer, format: record.format };
    }

    async saveAudio(key: string, audio: TtsSynthesizedAudio): Promise<void> {
        const db = await this.open();
        const copy = audio.data.slice(0);
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['audio', 'meta'], 'readwrite');
            tx.objectStore('audio').put({ key, buffer: copy, format: audio.format });
            tx.objectStore('meta').put({
                key,
                format: audio.format,
                size: copy.byteLength,
                lastRead: Date.now(),
            } satisfies CacheIndexEntry);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async expire(olderThanMillis: number): Promise<void> {
        if (olderThanMillis <= 0) return;
        const db = await this.open();
        const cutoff = Date.now() - olderThanMillis;
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['audio', 'meta'], 'readwrite');
            const metaStore = tx.objectStore('meta');
            const audioStore = tx.objectStore('audio');
            const req = metaStore.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                const val = cursor.value as CacheIndexEntry;
                if (val.lastRead < cutoff) {
                    metaStore.delete(val.key);
                    audioStore.delete(val.key);
                }
                cursor.continue();
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async getStorageSize(): Promise<number> {
        const db = await this.open();
        return new Promise<number>((resolve, reject) => {
            const tx = db.transaction(['meta'], 'readonly');
            const req = tx.objectStore('meta').openCursor();
            let total = 0;
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve(total);
                    return;
                }
                total += (cursor.value as CacheIndexEntry).size || 0;
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    async clear(): Promise<void> {
        const db = await this.open();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['audio', 'meta'], 'readwrite');
            tx.objectStore('audio').clear();
            tx.objectStore('meta').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }
}

/** Obsidian Aloud's "Local" cache: its IndexedDB database and stores. */
export const ALOUD_IDB_NAME = 'tts-aloud-db';
const ALOUD_AUDIO_STORE = 'audio';
const ALOUD_META_STORE = 'audioMetadata';
/** Spaceforge's clips in Aloud's database carry this prefix, so they are told apart from Aloud's own. */
export const SHARED_KEY_PREFIX = 'spaceforge:';

interface AloudAudioRecord { hash: string; blob: Blob; format: TtsAudioFormat }
interface AloudMetaRecord { hash: string; size: number; lastread: number; format: TtsAudioFormat }

/**
 * The "this device only" cache, kept in the same place Obsidian Aloud's
 * "Local" cache keeps its audio: the `tts-aloud-db` IndexedDB database, in
 * Aloud's own record shapes, so both plugins' spoken audio lives in one store
 * with one retention.
 *
 * Living in another plugin's database is done carefully:
 *  - Spaceforge never asks for a database version, so it can never block or
 *    out-version Aloud's own upgrades; it lets go of its connection the moment
 *    Aloud asks to upgrade.
 *  - Its records are keyed `spaceforge:…`, and clearing or sizing touches
 *    only those — Aloud's clips are never deleted from here.
 *  - If the database cannot be used as Aloud lays it out, the cache falls back
 *    to Spaceforge's own database rather than reshaping Aloud's.
 */
export class AloudSharedTtsCache implements TtsCacheAdapter {
    private dbPromise: Promise<IDBDatabase | null> | null = null;
    private fallback: TtsCacheAdapter;

    constructor(fallback: TtsCacheAdapter = new IndexedDBTtsCache()) {
        this.fallback = fallback;
    }

    private open(): Promise<IDBDatabase | null> {
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise<IDBDatabase | null>(resolve => {
            if (typeof indexedDB === 'undefined') {
                resolve(null);
                return;
            }
            let req: IDBOpenDBRequest;
            try {
                // No version: whatever Aloud has made it, never an upgrade of ours.
                req = indexedDB.open(ALOUD_IDB_NAME);
            } catch {
                resolve(null);
                return;
            }
            req.onupgradeneeded = () => {
                // Only reached when the database does not exist yet: lay it out
                // exactly as Aloud does, so Aloud opens it as its own.
                const db = req.result;
                if (!db.objectStoreNames.contains(ALOUD_AUDIO_STORE)) {
                    db.createObjectStore(ALOUD_AUDIO_STORE, { keyPath: 'hash' });
                }
                if (!db.objectStoreNames.contains(ALOUD_META_STORE)) {
                    db.createObjectStore(ALOUD_META_STORE, { keyPath: 'hash' }).createIndex('lastread', 'lastread');
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                const usable = db.objectStoreNames.contains(ALOUD_AUDIO_STORE) && db.objectStoreNames.contains(ALOUD_META_STORE);
                if (!usable) {
                    db.close();
                    resolve(null);
                    return;
                }
                // Aloud wants to upgrade: step aside, reopen on next use.
                db.onversionchange = () => {
                    db.close();
                    this.dbPromise = null;
                };
                resolve(db);
            };
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        });
        return this.dbPromise;
    }

    private static hash(key: string): string {
        return `${SHARED_KEY_PREFIX}${key}`;
    }

    private static run<T>(request: IDBRequest<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        });
    }

    private static done(tx: IDBTransaction): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
    }

    /** Walk Spaceforge's own metadata rows, in one read-write transaction. */
    private async eachOwn(db: IDBDatabase, visit: (meta: AloudMetaRecord, tx: IDBTransaction) => void): Promise<void> {
        const tx = db.transaction([ALOUD_AUDIO_STORE, ALOUD_META_STORE], 'readwrite');
        const range = IDBKeyRange.bound(SHARED_KEY_PREFIX, `${SHARED_KEY_PREFIX}\uffff`);
        const req = tx.objectStore(ALOUD_META_STORE).openCursor(range);
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            visit(cursor.value as AloudMetaRecord, tx);
            cursor.continue();
        };
        await AloudSharedTtsCache.done(tx);
    }

    async getAudio(key: string): Promise<TtsSynthesizedAudio | null> {
        const db = await this.open();
        if (!db) return this.fallback.getAudio(key);
        const hash = AloudSharedTtsCache.hash(key);
        const record = await AloudSharedTtsCache.run(
            db.transaction(ALOUD_AUDIO_STORE, 'readonly').objectStore(ALOUD_AUDIO_STORE).get(hash),
        ) as AloudAudioRecord | undefined;
        if (!record?.blob) return null;
        const data = await record.blob.arrayBuffer();
        const format = record.format ?? 'mp3';
        const tx = db.transaction(ALOUD_META_STORE, 'readwrite');
        tx.objectStore(ALOUD_META_STORE).put({ hash, size: data.byteLength, lastread: Date.now(), format } satisfies AloudMetaRecord);
        await AloudSharedTtsCache.done(tx).catch(() => undefined);
        return { data, format };
    }

    async saveAudio(key: string, audio: TtsSynthesizedAudio): Promise<void> {
        const db = await this.open();
        if (!db) return this.fallback.saveAudio(key, audio);
        const hash = AloudSharedTtsCache.hash(key);
        const tx = db.transaction([ALOUD_AUDIO_STORE, ALOUD_META_STORE], 'readwrite');
        // A Blob, as Aloud stores it — never a bare buffer Aloud could not read.
        tx.objectStore(ALOUD_AUDIO_STORE).put({ hash, blob: new Blob([audio.data.slice(0)]), format: audio.format } satisfies AloudAudioRecord);
        tx.objectStore(ALOUD_META_STORE).put({ hash, size: audio.data.byteLength, lastread: Date.now(), format: audio.format } satisfies AloudMetaRecord);
        await AloudSharedTtsCache.done(tx);
    }

    async expire(olderThanMillis: number): Promise<void> {
        if (olderThanMillis <= 0) return;
        const db = await this.open();
        if (!db) return this.fallback.expire(olderThanMillis);
        const cutoff = Date.now() - olderThanMillis;
        await this.eachOwn(db, (meta, tx) => {
            if (meta.lastread >= cutoff) return;
            tx.objectStore(ALOUD_AUDIO_STORE).delete(meta.hash);
            tx.objectStore(ALOUD_META_STORE).delete(meta.hash);
        });
    }

    async getStorageSize(): Promise<number> {
        const db = await this.open();
        if (!db) return this.fallback.getStorageSize();
        let total = 0;
        await this.eachOwn(db, meta => { total += meta.size || 0; });
        return total;
    }

    /** Spaceforge's clips only: Aloud's own audio is Aloud's to clear. */
    async clear(): Promise<void> {
        const db = await this.open();
        if (!db) return this.fallback.clear();
        await this.eachOwn(db, (meta, tx) => {
            tx.objectStore(ALOUD_AUDIO_STORE).delete(meta.hash);
            tx.objectStore(ALOUD_META_STORE).delete(meta.hash);
        });
        // What the old private database held is Spaceforge's too.
        await this.fallback.clear().catch(() => undefined);
    }
}

export interface VaultAdapterLike {
    exists(normalizedPath: string): Promise<boolean>;
    mkdir?(normalizedPath: string): Promise<void>;
    read(normalizedPath: string): Promise<string>;
    write(normalizedPath: string, data: string): Promise<void>;
    readBinary?(normalizedPath: string): Promise<ArrayBuffer>;
    writeBinary?(normalizedPath: string, data: ArrayBuffer): Promise<void>;
    remove?(normalizedPath: string): Promise<void>;
}

/**
 * Vault-stored object cache so generated audio clips persist inside the user's vault folder.
 */
export class VaultTtsCache implements TtsCacheAdapter {
    private adapter: VaultAdapterLike;
    private folder: string;
    private indexLoaded = false;
    private index: Record<string, CacheIndexEntry> = {};

    constructor(adapter: VaultAdapterLike, folder: string) {
        this.adapter = adapter;
        this.folder = normalizePath(folder || 'spaceforge/tts-audio');
    }

    setFolder(folder: string): void {
        const next = normalizePath(folder || 'spaceforge/tts-audio');
        if (next !== this.folder) {
            this.folder = next;
            this.indexLoaded = false;
            this.index = {};
        }
    }

    private indexPath(): string {
        return `${this.folder}/.tts-index.json`;
    }

    private audioPath(key: string, format: TtsAudioFormat): string {
        return `${this.folder}/${key}.${format}`;
    }

    private async ensureFolder(): Promise<void> {
        if (!this.adapter.mkdir) return;
        const segments = this.folder.split('/').filter(Boolean);
        let current = '';
        for (const seg of segments) {
            current = current ? `${current}/${seg}` : seg;
            if (!(await this.adapter.exists(current))) {
                try {
                    await this.adapter.mkdir(current);
                } catch {
                    // Folder created concurrently
                }
            }
        }
    }

    private async loadIndex(): Promise<void> {
        if (this.indexLoaded) return;
        this.indexLoaded = true;
        try {
            const path = this.indexPath();
            if (await this.adapter.exists(path)) {
                const raw = await this.adapter.read(path);
                const parsed = JSON.parse(raw) as Record<string, CacheIndexEntry>;
                if (parsed && typeof parsed === 'object') {
                    this.index = parsed;
                }
            }
        } catch {
            this.index = {};
        }
    }

    private async saveIndex(): Promise<void> {
        await this.ensureFolder();
        await this.adapter.write(this.indexPath(), JSON.stringify(this.index, null, 2));
    }

    async getAudio(key: string): Promise<TtsSynthesizedAudio | null> {
        if (!this.adapter.readBinary) return null;
        await this.loadIndex();
        const entry = this.index[key];
        if (!entry) return null;
        const filePath = this.audioPath(key, entry.format);
        try {
            if (!(await this.adapter.exists(filePath))) {
                delete this.index[key];
                await this.saveIndex();
                return null;
            }
            const data = await this.adapter.readBinary(filePath);
            entry.lastRead = Date.now();
            void this.saveIndex();
            return { data, format: entry.format };
        } catch {
            return null;
        }
    }

    async saveAudio(key: string, audio: TtsSynthesizedAudio): Promise<void> {
        if (!this.adapter.writeBinary) return;
        await this.loadIndex();
        await this.ensureFolder();
        const filePath = this.audioPath(key, audio.format);
        await this.adapter.writeBinary(filePath, audio.data.slice(0));
        this.index[key] = {
            key,
            format: audio.format,
            size: audio.data.byteLength,
            lastRead: Date.now(),
        };
        await this.saveIndex();
    }

    async expire(olderThanMillis: number): Promise<void> {
        if (olderThanMillis <= 0) return;
        await this.loadIndex();
        const cutoff = Date.now() - olderThanMillis;
        let dirty = false;
        for (const [key, entry] of Object.entries(this.index)) {
            if (entry.lastRead < cutoff) {
                const filePath = this.audioPath(key, entry.format);
                try {
                    if (this.adapter.remove && (await this.adapter.exists(filePath))) {
                        await this.adapter.remove(filePath);
                    }
                } catch {
                    // Best-effort cleanup
                }
                delete this.index[key];
                dirty = true;
            }
        }
        if (dirty) await this.saveIndex();
    }

    async getStorageSize(): Promise<number> {
        await this.loadIndex();
        return Object.values(this.index).reduce((sum, entry) => sum + (entry.size || 0), 0);
    }

    async clear(): Promise<void> {
        await this.loadIndex();
        for (const [key, entry] of Object.entries(this.index)) {
            const filePath = this.audioPath(key, entry.format);
            try {
                if (this.adapter.remove && (await this.adapter.exists(filePath))) {
                    await this.adapter.remove(filePath);
                }
            } catch {
                // Best-effort cleanup
            }
        }
        this.index = {};
        await this.saveIndex();
    }
}
