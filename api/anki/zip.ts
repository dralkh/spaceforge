/**
 * A small, dependency-free ZIP reader and writer.
 *
 * Anki packages are ordinary ZIPs, so the only things that matter here are the
 * two shapes Anki itself writes: stored (0) and deflate (8) entries, UTF-8 names
 * with the language-encoding flag set, and a local header that carries the CRC
 * and both sizes so no data descriptor is needed.
 *
 * Inflate/deflate go through the platform's `DecompressionStream` /
 * `CompressionStream` with the `deflate-raw` format, which Node 18+, Electron
 * and the mobile webviews Obsidian runs in all provide. Nothing else is
 * imported: no `zlib`, no `fs`, so this file is safe on mobile.
 */

/** The "name is UTF-8" general-purpose flag (bit 11). */
export const ZIP_UTF8_FLAG = 0x0800;

/** A fixed, deterministic DOS timestamp (1980-01-01 00:00). */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/** Entries larger than this cannot be written without zip64. */
const MAX_ZIP_ENTRY = 0xffffffff;

/** One file, as read from the central directory. */
export interface ZipEntry {
    /** The file name, decoded. */
    name: string;
    /** 0 = stored, 8 = deflate. */
    method: number;
    crc32: number;
    /** Bytes the entry occupies inside the archive. */
    compressedSize: number;
    /** Bytes the entry has once inflated. */
    uncompressedSize: number;
    /** Offset of the entry's local header. */
    localHeaderOffset: number;
}

/** The archive's table of contents. */
export interface ZipDirectory {
    entries: ZipEntry[];
    /** True when the archive used zip64 records (read-only support). */
    zip64: boolean;
}

/** One file to write. */
export interface ZipWriteEntry {
    name: string;
    data: Uint8Array;
    /** Store the bytes instead of deflating them. */
    store?: boolean;
}

/* ------------------------------------------------------------------ bytes */

/** Joins byte arrays (used for both ZIP structures and payloads). */
export function concatBytes(chunks: readonly Uint8Array[], total?: number): Uint8Array {
    let size = total;
    if (size === undefined) {
        size = 0;
        for (const chunk of chunks) {
            size += chunk.length;
        }
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

function latin1(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i]);
    }
    return out;
}

/**
 * ZIP names are UTF-8 when the flag is set. Old tools wrote CP437 without it;
 * the best available approximation is to try UTF-8 strictly and fall back to a
 * byte-per-character decode.
 */
function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
    if (utf8Flag) {
        return utf8Decoder.decode(bytes);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return latin1(bytes);
    }
}

/* ------------------------------------------------------------------ crc32 */

let crcTable: Uint32Array | null = null;

function crcLookup(): Uint32Array {
    if (!crcTable) {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            table[n] = c >>> 0;
        }
        crcTable = table;
    }
    return crcTable;
}

/** The CRC-32 of a byte range, as ZIP wants it (unsigned 32-bit). */
export function crc32(data: Uint8Array, seed = 0): number {
    const table = crcLookup();
    let c = (seed ^ 0xffffffff) >>> 0;
    for (let i = 0; i < data.length; i++) {
        c = (table[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    }
    return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------- streaming */

/** The slice of the Streams API this file relies on. */
interface ByteReader {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock?(): void;
}
interface ByteWriter {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    releaseLock?(): void;
}
interface ByteStreams {
    readable: { getReader(): ByteReader };
    writable: { getWriter(): ByteWriter };
}
type StreamConstructor = new (format: string) => ByteStreams;

function streamFactory(name: string): StreamConstructor {
    const factory = (globalThis as unknown as Record<string, unknown>)[name];
    if (typeof factory !== 'function') {
        throw new Error(`${name} is not available in this environment`);
    }
    return factory as StreamConstructor;
}

async function collect(readable: { getReader(): ByteReader }): Promise<Uint8Array> {
    const reader = readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value && value.length > 0) {
            chunks.push(value);
            total += value.length;
        }
    }
    return concatBytes(chunks, total);
}

/**
 * Pushes bytes through a compression stream. Data is fed in chunks so a large
 * media file never has to exist twice in memory at once.
 */
async function transformBytes(name: 'CompressionStream' | 'DecompressionStream', format: string, data: Uint8Array): Promise<Uint8Array> {
    const streams = new (streamFactory(name))(format);
    const writer = streams.writable.getWriter();
    const collected = collect(streams.readable);
    const chunkSize = 1 << 16;
    try {
        for (let at = 0; at < data.length; at += chunkSize) {
            await writer.write(data.subarray(at, Math.min(at + chunkSize, data.length)));
        }
        await writer.close();
    } catch (error) {
        writer.releaseLock?.();
        throw error;
    }
    return collected;
}

/** Inflates a raw deflate stream (no zlib header, as ZIP stores it). */
export function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    return transformBytes('DecompressionStream', 'deflate-raw', data);
}

/** Deflates to a raw deflate stream. */
export function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
    return transformBytes('CompressionStream', 'deflate-raw', data);
}

/* ------------------------------------------------------------------ read */

function sig(view: DataView, at: number): number {
    return view.getUint32(at, true);
}

/** Reads a 64-bit little-endian value as a JS number (safe for real archives). */
function u64(view: DataView, at: number): number {
    return view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x100000000;
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
    const earliest = Math.max(0, bytes.length - 22 - 0xffff);
    for (let at = bytes.length - 22; at >= earliest; at--) {
        if (sig(view, at) !== 0x06054b50) {
            continue;
        }
        const commentLength = view.getUint16(at + 20, true);
        if (at + 22 + commentLength <= bytes.length) {
            return at;
        }
    }
    throw new Error('not a zip file: no end-of-central-directory record');
}

interface Zip64End {
    entries: number;
    centralDirectoryOffset: number;
}

function readZip64End(bytes: Uint8Array, view: DataView, eocd: number): Zip64End | null {
    if (eocd < 20 || sig(view, eocd - 20) !== 0x07064b50) {
        return null;
    }
    const at = u64(view, eocd - 20 + 8);
    if (at < 0 || at + 56 > bytes.length || sig(view, at) !== 0x06064b50) {
        return null;
    }
    return { entries: u64(view, at + 32), centralDirectoryOffset: u64(view, at + 48) };
}

/** Parses the central directory. Nothing is decompressed yet. */
export function readZipDirectory(bytes: Uint8Array): ZipDirectory {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEndOfCentralDirectory(bytes, view);
    let entries = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    let zip64 = false;
    if (entries === 0xffff || offset === 0xffffffff) {
        const zip64End = readZip64End(bytes, view, eocd);
        if (zip64End) {
            entries = zip64End.entries;
            offset = zip64End.centralDirectoryOffset;
            zip64 = true;
        }
    }

    const out: ZipEntry[] = [];
    let at = offset;
    for (let i = 0; i < entries; i++) {
        if (at + 46 > bytes.length || sig(view, at) !== 0x02014b50) {
            throw new Error(`zip: central directory is damaged at entry ${i}`);
        }
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        let compressedSize = view.getUint32(at + 20, true);
        let uncompressedSize = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        let localHeaderOffset = view.getUint32(at + 42, true);
        const name = decodeName(bytes.subarray(at + 46, at + 46 + nameLength), (flags & ZIP_UTF8_FLAG) !== 0);

        // zip64 extra field: the fields that were too small follow in order.
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            let extra = at + 46 + nameLength;
            const extraEnd = extra + extraLength;
            while (extra + 4 <= extraEnd) {
                const id = view.getUint16(extra, true);
                const size = view.getUint16(extra + 2, true);
                if (id === 0x0001) {
                    let field = extra + 4;
                    if (uncompressedSize === 0xffffffff) {
                        uncompressedSize = u64(view, field);
                        field += 8;
                    }
                    if (compressedSize === 0xffffffff) {
                        compressedSize = u64(view, field);
                        field += 8;
                    }
                    if (localHeaderOffset === 0xffffffff) {
                        localHeaderOffset = u64(view, field);
                        field += 8;
                    }
                    zip64 = true;
                    break;
                }
                extra += 4 + size;
            }
        }

        if ((flags & 0x0001) !== 0) {
            throw new Error(`zip: entry "${name}" is encrypted`);
        }
        if (method !== 0 && method !== 8) {
            throw new Error(`zip: entry "${name}" uses unsupported compression method ${method}`);
        }
        out.push({ name, method, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return { entries: out, zip64 };
}

/** Reads and, if needed, inflates one entry. */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = entry.localHeaderOffset;
    if (at + 30 > bytes.length || sig(view, at) !== 0x04034b50) {
        throw new Error(`zip: local header for "${entry.name}" is missing`);
    }
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const start = at + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > bytes.length) {
        throw new Error(`zip: entry "${entry.name}" runs past the end of the file`);
    }
    const stored = bytes.subarray(start, end);
    if (entry.uncompressedSize === 0) {
        return new Uint8Array(0);
    }
    if (entry.method === 0) {
        return stored.slice();
    }
    const inflated = await inflateRaw(stored);
    if (inflated.length !== entry.uncompressedSize) {
        throw new Error(`zip: entry "${entry.name}" inflated to ${inflated.length} bytes, expected ${entry.uncompressedSize}`);
    }
    return inflated;
}

/** Reads the whole archive into memory, keyed by name. */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
    const { entries } = readZipDirectory(bytes);
    const out = new Map<string, Uint8Array>();
    for (const entry of entries) {
        out.set(entry.name, await readZipEntry(bytes, entry));
    }
    return out;
}

/** True when the buffer starts with a ZIP signature (empty archives included). */
export function isZip(bytes: Uint8Array): boolean {
    if (bytes.length < 4) {
        return false;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const head = sig(view, 0);
    return head === 0x04034b50 || head === 0x06054b50 || head === 0x08074b50;
}

/* ----------------------------------------------------------------- write */

interface PreparedEntry {
    nameBytes: Uint8Array;
    method: number;
    crc: number;
    compressed: Uint8Array;
    uncompressedSize: number;
    localHeaderOffset: number;
}

/**
 * Builds a ZIP. Entries are deflated unless `store` is set or deflating made
 * them bigger; every local header carries the CRC and both sizes, the names are
 * UTF-8 with the language-encoding flag, and zip64 is never emitted (a package
 * that big is refused rather than written wrongly).
 */
export async function writeZip(entries: readonly ZipWriteEntry[]): Promise<Uint8Array> {
    if (entries.length > 0xffff) {
        throw new Error('zip: too many entries to write without zip64');
    }
    const prepared: PreparedEntry[] = [];
    let offset = 0;
    for (const entry of entries) {
        const nameBytes = utf8Encoder.encode(entry.name);
        const crc = crc32(entry.data);
        let method = entry.store || entry.data.length === 0 ? 0 : 8;
        let payload: Uint8Array = entry.data;
        if (method === 8) {
            const deflated = await deflateRaw(entry.data);
            if (deflated.length < entry.data.length) {
                payload = deflated;
            } else {
                method = 0;
            }
        }
        if (payload.length > MAX_ZIP_ENTRY || entry.data.length > MAX_ZIP_ENTRY) {
            throw new Error(`zip: entry "${entry.name}" is too large to write without zip64`);
        }
        prepared.push({
            nameBytes,
            method,
            crc,
            compressed: payload,
            uncompressedSize: entry.data.length,
            localHeaderOffset: offset,
        });
        offset += 30 + nameBytes.length + payload.length;
    }

    const localParts: Uint8Array[] = [];
    for (const entry of prepared) {
        const header = new Uint8Array(30 + entry.nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true); // version needed to extract
        view.setUint16(6, ZIP_UTF8_FLAG, true);
        view.setUint16(8, entry.method, true);
        view.setUint16(10, DOS_TIME, true);
        view.setUint16(12, DOS_DATE, true);
        view.setUint32(14, entry.crc, true);
        view.setUint32(18, entry.compressed.length, true);
        view.setUint32(22, entry.uncompressedSize, true);
        view.setUint16(26, entry.nameBytes.length, true);
        view.setUint16(28, 0, true); // no extra field, no data descriptor
        header.set(entry.nameBytes, 30);
        localParts.push(header, entry.compressed);
    }

    const centralParts: Uint8Array[] = [];
    let centralSize = 0;
    for (const entry of prepared) {
        const record = new Uint8Array(46 + entry.nameBytes.length);
        const view = new DataView(record.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true); // version made by
        view.setUint16(6, 20, true); // version needed
        view.setUint16(8, ZIP_UTF8_FLAG, true);
        view.setUint16(10, entry.method, true);
        view.setUint16(12, DOS_TIME, true);
        view.setUint16(14, DOS_DATE, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, entry.compressed.length, true);
        view.setUint32(24, entry.uncompressedSize, true);
        view.setUint16(28, entry.nameBytes.length, true);
        view.setUint32(42, entry.localHeaderOffset, true);
        record.set(entry.nameBytes, 46);
        centralParts.push(record);
        centralSize += record.length;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, prepared.length, true);
    endView.setUint16(10, prepared.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    centralParts.push(end);
    return concatBytes([...localParts, ...centralParts]);
}
