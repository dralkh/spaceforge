import type { TtsChunkType } from '../models/tts';

export interface TtsTextSpan {
    rawText: string;
    spokenText: string;
    start: number;
    end: number;
}

/**
 * Strip YAML frontmatter and return content + character offset where body begins.
 */
export function stripFrontmatterWithOffset(markdown: string): { text: string; offset: number } {
    const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
    if (!match) {
        return { text: markdown, offset: 0 };
    }
    return {
        text: markdown.slice(match[0].length),
        offset: match[0].length,
    };
}

/**
 * Automatic selection inspired by obsidian-aloud-tts's ObsidianBridge.triggerSelection:
 * - If the user selected a meaningful phrase (> 1 word or >= 4 chars), read that exact selection.
 * - Otherwise, if cursor is inside the note body, select from the start of the cursor's line/cursor to the end of the note (skipping YAML frontmatter).
 * - If cursor is not available, read the full note body (skipping YAML frontmatter).
 */
export function resolveAutomaticNoteRange(
    fullText: string,
    selectionFrom?: number,
    selectionTo?: number,
): { start: number; end: number; text: string; mode: 'selection' | 'cursor-to-end' | 'full-note' } {
    const body = stripFrontmatterWithOffset(fullText);
    const hasCursor = typeof selectionFrom === 'number' && typeof selectionTo === 'number';
    if (hasCursor) {
        const from = Math.max(0, Math.min(selectionFrom, selectionTo));
        const to = Math.max(from, Math.min(fullText.length, Math.max(selectionFrom, selectionTo)));
        const selected = fullText.slice(from, to).trim();
        const wordCount = selected ? selected.split(/\s+/).length : 0;
        if (selected.length >= 4 && (wordCount > 1 || selected.length >= 12)) {
            return { start: from, end: to, text: fullText.slice(from, to), mode: 'selection' };
        }
        const start = Math.max(body.offset, from);
        if (start < fullText.length) {
            return {
                start,
                end: fullText.length,
                text: fullText.slice(start),
                mode: start > body.offset ? 'cursor-to-end' : 'full-note',
            };
        }
    }
    return {
        start: body.offset,
        end: fullText.length,
        text: body.text,
        mode: 'full-note',
    };
}

/**
 * Convert basic LaTeX expressions into natural spoken equivalents.
 */
function cleanLatexMath(latex: string): string {
    let out = latex.trim();
    const replacements: Array<[RegExp, string]> = [
        [/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1 over $2'],
        [/\\sqrt\{([^{}]+)\}/g, 'square root of $1'],
        [/\\times/g, ' times '],
        [/\\cdot/g, ' times '],
        [/\\div/g, ' divided by '],
        [/\\pm/g, ' plus or minus '],
        [/\\approx/g, ' approximately equal to '],
        [/\\neq/g, ' not equal to '],
        [/\\leq/g, ' less than or equal to '],
        [/\\geq/g, ' greater than or equal to '],
        [/\\rightarrow|\\to/g, ' leads to '],
        [/\\leftarrow/g, ' from '],
        [/\\leftrightarrow/g, ' corresponds to '],
        [/\\infty/g, ' infinity '],
        [/\\sum/g, ' sum of '],
        [/\\int/g, ' integral of '],
        [/\\Delta/g, ' delta '],
        [/\\alpha/g, ' alpha '],
        [/\\beta/g, ' beta '],
        [/\\gamma/g, ' gamma '],
        [/\\theta/g, ' theta '],
        [/\\lambda/g, ' lambda '],
        [/\\mu/g, ' mu '],
        [/\\sigma/g, ' sigma '],
        [/\\pi/g, ' pi '],
        [/\^\{([^{}]+)\}/g, ' to the power of $1'],
        [/\^([0-9a-zA-Z])/g, ' to the power of $1'],
        [/_\{([^{}]+)\}/g, ' sub $1'],
        [/_([0-9a-zA-Z])/g, ' sub $1'],
    ];
    for (const [pattern, replacement] of replacements) {
        out = out.replace(pattern, replacement);
    }
    out = out.replace(/\\[a-zA-Z]+/g, ' ');
    out = out.replace(/[{}]/g, ' ');
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Convert markdown table blocks into readable header-value rows.
 */
function cleanMarkdownTables(input: string): string {
    const lines = input.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const nextLine = lines[i + 1] ?? '';
        const isHeader = line.includes('|') && /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(nextLine);
        if (!isHeader) {
            result.push(line);
            i += 1;
            continue;
        }

        const parseRow = (row: string): string[] =>
            row
                .trim()
                .replace(/^\|/, '')
                .replace(/\|$/, '')
                .split('|')
                .map(cell => cell.trim());

        const headers = parseRow(line);
        i += 2; // Skip header + separator
        const rowSentences: string[] = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim().length > 0) {
            const cells = parseRow(lines[i]);
            const pairs: string[] = [];
            for (let c = 0; c < cells.length; c++) {
                const cell = cells[c];
                if (!cell) continue;
                const header = headers[c];
                pairs.push(header ? `${header}: ${cell}` : cell);
            }
            if (pairs.length > 0) {
                rowSentences.push(pairs.join(', ') + '.');
            }
            i += 1;
        }
        if (rowSentences.length > 0) {
            result.push(rowSentences.join(' '));
        }
    }

    return result.join('\n');
}

/**
 * Clean Markdown, Obsidian syntax, tables, and LaTeX math for clear speech synthesis.
 */
export function cleanMarkdownForSpeech(raw: string): string {
    if (!raw) return '';
    let text = raw.replace(/\r\n/g, '\n');

    // Remove YAML frontmatter if still present at start
    text = text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '');

    // Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');

    // Remove fenced code blocks' triple backticks (keep content brief or summarize language)
    text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
        const trimmed = String(code ?? '').trim();
        if (!trimmed) return '';
        const prefix = lang ? `${lang} code: ` : 'Code snippet: ';
        return trimmed.length > 260 ? `${prefix}${trimmed.slice(0, 260)}.` : `${prefix}${trimmed}.`;
    });

    // Block math & inline math
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr) => ` ${cleanLatexMath(String(expr))} `);
    text = text.replace(/\$([^$\n]+?)\$/g, (_m, expr) => ` ${cleanLatexMath(String(expr))} `);

    // Tables
    text = cleanMarkdownTables(text);

    // Embedded images / attachments ![[file|alt]] -> ignore or alt
    text = text.replace(/!\[\[([^|\]]+\|)?([^\]]+)\]\]/g, (_m, _pipe, label) => {
        const clean = String(label ?? '').replace(/\.[a-z0-9]+$/i, '');
        return clean ? `Image: ${clean}.` : '';
    });

    // Obsidian wikilinks [[target|alias]] -> alias, [[target]] -> target
    text = text.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2');
    text = text.replace(/\[\[([^\]]+)\]\]/g, (_m, target) => {
        const parts = String(target).split('#');
        return parts[parts.length - 1] || String(target);
    });

    // Markdown images ![alt](url) and links [label](url)
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_m, alt) => (alt ? `Image: ${alt}.` : ''));
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Callout markers > [!info] Title
    text = text.replace(/^\s*>\s*\[!([a-zA-Z0-9_-]+)\]\s*(.*)$/gm, (_m, kind, title) =>
        title ? `${kind}: ${title}.` : `${kind} note.`
    );

    // Blockquotes, headings, list markers, footnotes
    text = text.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, '$1.');
    text = text.replace(/^\s*>\s?/gm, '');
    text = text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '');
    text = text.replace(/^\s*[-*+]\s+/gm, '');
    text = text.replace(/^\s*\d+[.)]\s+/gm, '');
    text = text.replace(/^\s*[-*_]{3,}\s*$/gm, '');
    text = text.replace(/\[\^[^\]]+\]/g, '');

    // Inline markdown emphasis/code/highlight/strikethrough
    text = text.replace(/`([^`]+)`/g, '$1');
    text = text.replace(/==([^=]+)==/g, '$1');
    text = text.replace(/~~([^~]+)~~/g, '$1');
    text = text.replace(/(\*\*\*|___)(.*?)\1/g, '$2');
    text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
    text = text.replace(/(\*|_)(.*?)\1/g, '$2');

    // Strip leftover HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Collapse whitespace without merging intentional line breaks into run-ons
    text = text
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');

    return text.trim();
}

/**
 * Split raw note text into sentence or paragraph chunks while preserving exact raw character offsets
 * relative to `baseOffset` (so CodeMirror can highlight the underlying note accurately).
 */
export function chunkTextWithOffsets(
    text: string,
    mode: TtsChunkType,
    baseOffset = 0,
): TtsTextSpan[] {
    if (!text.trim()) return [];
    const spans: TtsTextSpan[] = [];

    if (mode === 'paragraph') {
        const regex = /[^\r\n]+(?:\r?\n(?![ \t]*\r?\n)[^\r\n]+)*/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
            const rawText = match[0];
            const spokenText = cleanMarkdownForSpeech(rawText);
            if (spokenText.length > 0 && /[a-zA-Z0-9\p{L}\p{N}]/u.test(spokenText)) {
                spans.push({
                    rawText,
                    spokenText,
                    start: baseOffset + match.index,
                    end: baseOffset + match.index + rawText.length,
                });
            }
        }
        return spans;
    }

    // Sentence mode: split paragraphs first so headings/bullets don't merge endlessly
    const paraRegex = /[^\r\n]+/g;
    let paraMatch: RegExpExecArray | null;
    while ((paraMatch = paraRegex.exec(text)) !== null) {
        const line = paraMatch[0];
        const lineStart = baseOffset + paraMatch.index;
        const sentRegex = /[^.!?\n]+(?:[.!?]+(?=\s|$)|$)/g;
        let sentMatch: RegExpExecArray | null;
        while ((sentMatch = sentRegex.exec(line)) !== null) {
            const rawSegment = sentMatch[0];
            const trimmed = rawSegment.trim();
            if (!trimmed) continue;
            const leadingSpaces = rawSegment.indexOf(trimmed);
            const start = lineStart + sentMatch.index + Math.max(0, leadingSpaces);
            const end = start + trimmed.length;
            const spokenText = cleanMarkdownForSpeech(trimmed);
            if (spokenText.length > 0 && /[a-zA-Z0-9\p{L}\p{N}]/u.test(spokenText)) {
                spans.push({
                    rawText: trimmed,
                    spokenText,
                    start,
                    end,
                });
            }
        }
    }

    return spans;
}

/**
 * Split a long text at sentence boundaries under maxLen (e.g. Speechify's 2000 char limit).
 */
export function splitTextForLimit(text: string, maxLen = 1900): string[] {
    const clean = text.trim();
    if (!clean) return [];
    if (clean.length <= maxLen) return [clean];

    const chunks: string[] = [];
    let remaining = clean;
    while (remaining.length > maxLen) {
        const window = remaining.slice(0, maxLen);
        let splitAt = Math.max(
            window.lastIndexOf('. '),
            window.lastIndexOf('! '),
            window.lastIndexOf('? '),
            window.lastIndexOf('\n'),
        );
        if (splitAt < maxLen * 0.4) {
            splitAt = window.lastIndexOf(' ');
        }
        if (splitAt <= 0) {
            splitAt = maxLen;
        } else {
            splitAt += 1;
        }
        const piece = remaining.slice(0, splitAt).trim();
        if (piece) chunks.push(piece);
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    if (typeof atob === 'function') {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }
    const buf = Buffer.from(base64, 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    if (typeof btoa === 'function') {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }
    return Buffer.from(buffer).toString('base64');
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
    const clean = hex.trim();
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
        bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    }
    return bytes.buffer;
}

/**
 * Wrap raw PCM audio data in a standard 44-byte RIFF/WAVE header so browsers and Obsidian's
 * Audio element / WebAudio can play PCM outputs (e.g. Gemini 24kHz mono 16-bit) with zero dependencies.
 */
export function pcmToWavArrayBuffer(
    pcmData: ArrayBuffer,
    sampleRate = 24000,
    channels = 1,
    bitDepth = 16,
): ArrayBuffer {
    const dataLength = pcmData.byteLength;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeStr = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    const blockAlign = (channels * bitDepth) / 8;
    const byteRate = sampleRate * blockAlign;

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // AudioFormat = PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataLength, true);

    new Uint8Array(buffer, 44).set(new Uint8Array(pcmData));
    return buffer;
}

/**
 * Deterministic fast 64-bit hex hash (double FNV-1a) matching Aloud's content-addressable cache key model.
 */
export function hashTtsCacheKey(parts: {
    text: string;
    provider: string;
    model: string;
    voice: string;
    instructions?: string;
    apiUri?: string;
    format: string;
    speed?: number;
}): string {
    const payload = JSON.stringify([
        1,
        parts.text,
        parts.provider,
        parts.apiUri ?? '',
        parts.model,
        parts.voice,
        parts.instructions ?? '',
        parts.speed ?? 1,
        parts.format,
    ]);
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < payload.length; i++) {
        const ch = payload.charCodeAt(i);
        h1 ^= ch;
        h1 = Math.imul(h1, 0x01000193);
        h2 ^= (ch + i) & 0xffff;
        h2 = Math.imul(h2, 0x85ebca6b);
    }
    return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}
