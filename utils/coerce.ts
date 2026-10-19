/**
 * Defensive coercion helpers.
 *
 * Anything that arrives from a language model is `unknown` and usually almost
 * right: numbers as strings, booleans as words, a single value where a list was
 * asked for. These helpers take the most reasonable reading available and
 * return null (or the fallback) rather than throwing, so callers can keep going
 * and degrade gracefully instead of failing a whole turn.
 */

/** Read a non-empty trimmed string, accepting numbers and booleans. */
export function asTextValue(value: unknown): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
}

/** Read an array of strings, tolerating a single string in its place. */
export function asTextList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map(item => asTextValue(item)).filter((item): item is string => item !== null);
    }
    const single = asTextValue(value);
    return single ? [single] : [];
}

/** Read a finite number, stripping stray currency/unit characters. */
export function asNumberValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value.replace(/[^0-9.-]/g, ''));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** Read a rounded integer within bounds. */
export function clampIntValue(value: unknown, min: number, max: number): number | null {
    const parsed = asNumberValue(value);
    if (parsed === null) return null;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

/** Read a boolean, accepting the usual word forms. */
export function asBoolValue(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(lowered)) return true;
        if (['false', 'no', 'n', '0'].includes(lowered)) return false;
    }
    if (typeof value === 'number') return value !== 0;
    return null;
}

/** Read a plain object, rejecting arrays and null. */
export function asRecordValue(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return null;
}

/** Lowercase, hyphen-separated slug used for enum matching. */
export function slugify(value: string): string {
    return value
        .toLowerCase()
        // Apostrophes are dropped rather than turned into hyphens, so "don't"
        // slugifies to "dont" and matches the alias table.
        .replace(/['\u2018\u2019]/g, '')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** Read a top-level array by trying several key names. */
export function pickArray(source: Record<string, unknown>, keys: string[]): unknown[] {
    for (const key of keys) {
        const value = source[key];
        if (Array.isArray(value)) return value;
    }
    return [];
}
