import { requestUrl } from 'obsidian';
import SpaceforgePlugin from '../main';
import { StudySearchProvider } from '../models/settings';

/**
 * Web lookup for the Study tutor.
 *
 * The tutor is allowed to ask for a lookup when it needs the mechanistic or
 * empirical detail behind a claim, but it is never allowed to *invent* a
 * source. Everything the learner sees as a citation has to have come through
 * this service first, which is why the result URLs are also used as an
 * allow-list when rendering sources.
 *
 * Four backends, because the honest answer to "where should search come from"
 * depends on what the user already has: a hosted key (Tavily, Brave), a
 * self-hosted instance (SearXNG), or anything else that speaks a simple JSON
 * contract (Custom).
 */

export interface StudySearchResult {
    title: string;
    url: string;
    snippet: string;
}

export interface StudySearchOutcome {
    query: string;
    results: StudySearchResult[];
    /** Set when the lookup itself failed; surfaced to the tutor as a caveat. */
    error: string | null;
}

const MAX_SNIPPET_CHARS = 700;

/** Trim and normalise a snippet so a chatty page cannot eat the context. */
function cleanSnippet(value: string): string {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return collapsed.length > MAX_SNIPPET_CHARS ? `${collapsed.slice(0, MAX_SNIPPET_CHARS)}…` : collapsed;
}

function toResult(title: unknown, url: unknown, snippet: unknown): StudySearchResult | null {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
    let host = url;
    try {
        host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
        // Keep the raw URL when it cannot be parsed.
    }
    return {
        title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : host,
        url,
        snippet: cleanSnippet(typeof snippet === 'string' ? snippet : ''),
    };
}

export class StudyWebSearchService {
    private plugin: SpaceforgePlugin;

    /**
     * Settings are read through the plugin on every call rather than captured:
     * the save path replaces the settings object, so a captured reference goes
     * stale the first time the user changes anything.
     */
    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    private get settings() {
        return this.plugin.settings;
    }

    /** Whether lookups can actually run, and if not, what is missing. */
    status(): { ok: boolean; reason: string | null; label: string } {
        const provider = this.settings.studySearchProvider;
        const label = this.label(provider);
        if (provider === StudySearchProvider.None) {
            return { ok: false, reason: 'No search provider selected', label };
        }
        if (provider === StudySearchProvider.Custom) {
            if (!this.settings.studySearchEndpoint) {
                return { ok: false, reason: 'No search endpoint set', label };
            }
            return { ok: true, reason: null, label };
        }
        if (provider === StudySearchProvider.Searxng) {
            if (!this.settings.studySearchEndpoint) {
                return { ok: false, reason: 'No SearXNG instance URL set', label };
            }
            return { ok: true, reason: null, label };
        }
        if (!this.settings.studySearchApiKey) {
            return { ok: false, reason: 'No search API key set', label };
        }
        return { ok: true, reason: null, label };
    }

    label(provider: StudySearchProvider): string {
        switch (provider) {
            case StudySearchProvider.Tavily: return 'Tavily';
            case StudySearchProvider.Brave: return 'Brave Search';
            case StudySearchProvider.Searxng: return 'SearXNG';
            case StudySearchProvider.Custom: return 'Custom endpoint';
            default: return 'Off';
        }
    }

    /** Run one query. Never throws: failures come back as `error`. */
    async search(query: string): Promise<StudySearchOutcome> {
        const trimmed = query.trim();
        if (trimmed.length === 0) return { query, results: [], error: 'Empty query' };

        const maxResults = Math.max(1, Math.min(10, this.settings.studySearchMaxResults || 4));
        try {
            switch (this.settings.studySearchProvider) {
                case StudySearchProvider.Tavily:
                    return { query: trimmed, results: await this.searchTavily(trimmed, maxResults), error: null };
                case StudySearchProvider.Brave:
                    return { query: trimmed, results: await this.searchBrave(trimmed, maxResults), error: null };
                case StudySearchProvider.Searxng:
                    return { query: trimmed, results: await this.searchSearxng(trimmed, maxResults), error: null };
                case StudySearchProvider.Custom:
                    return { query: trimmed, results: await this.searchCustom(trimmed, maxResults), error: null };
                default:
                    return { query: trimmed, results: [], error: 'Web lookup is not configured' };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { query: trimmed, results: [], error: message.slice(0, 200) };
        }
    }

    /** Run several queries, de-duplicating by URL across all of them. */
    async searchMany(queries: string[]): Promise<StudySearchOutcome[]> {
        const outcomes: StudySearchOutcome[] = [];
        const seen = new Set<string>();
        for (const query of queries.slice(0, 3)) {
            const outcome = await this.search(query);
            outcome.results = outcome.results.filter(result => {
                if (seen.has(result.url)) return false;
                seen.add(result.url);
                return true;
            });
            outcomes.push(outcome);
        }
        return outcomes;
    }

    private async searchTavily(query: string, maxResults: number): Promise<StudySearchResult[]> {
        const response = await requestUrl({
            url: 'https://api.tavily.com/search',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: this.settings.studySearchApiKey,
                query,
                max_results: maxResults,
                search_depth: 'basic',
                include_answer: false,
                include_raw_content: false,
            }),
            throw: false,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Tavily lookup failed (${response.status})`);
        }
        const data = response.json as { results?: Array<{ title?: string; url?: string; content?: string }> };
        return (data.results ?? [])
            .map(entry => toResult(entry.title, entry.url, entry.content))
            .filter((entry): entry is StudySearchResult => entry !== null)
            .slice(0, maxResults);
    }

    private async searchBrave(query: string, maxResults: number): Promise<StudySearchResult[]> {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
        const response = await requestUrl({
            url,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': this.settings.studySearchApiKey,
            },
            throw: false,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Brave lookup failed (${response.status})`);
        }
        const data = response.json as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
        return (data.web?.results ?? [])
            .map(entry => toResult(entry.title, entry.url, entry.description))
            .filter((entry): entry is StudySearchResult => entry !== null)
            .slice(0, maxResults);
    }

    private async searchSearxng(query: string, maxResults: number): Promise<StudySearchResult[]> {
        const base = this.settings.studySearchEndpoint.endsWith('/')
            ? this.settings.studySearchEndpoint.slice(0, -1)
            : this.settings.studySearchEndpoint;
        const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
        const headers: Record<string, string> = { 'Accept': 'application/json' };
        if (this.settings.studySearchApiKey) headers['Authorization'] = `Bearer ${this.settings.studySearchApiKey}`;
        const response = await requestUrl({ url, method: 'GET', headers, throw: false });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`SearXNG lookup failed (${response.status})`);
        }
        const data = response.json as { results?: Array<{ title?: string; url?: string; content?: string }> };
        return (data.results ?? [])
            .map(entry => toResult(entry.title, entry.url, entry.content))
            .filter((entry): entry is StudySearchResult => entry !== null)
            .slice(0, maxResults);
    }

    /**
     * Anything that accepts {query, max_results} and answers with a results
     * array. Headers are guessed from the common shapes so the same code works
     * with bearer tokens and with key-in-body services.
     */
    private async searchCustom(query: string, maxResults: number): Promise<StudySearchResult[]> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const key = this.settings.studySearchApiKey;
        if (key) {
            headers['Authorization'] = `Bearer ${key}`;
            headers['X-Api-Key'] = key;
        }
        const response = await requestUrl({
            url: this.settings.studySearchEndpoint,
            method: 'POST',
            headers,
            body: JSON.stringify({ query, max_results: maxResults, api_key: key || undefined }),
            throw: false,
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Custom lookup failed (${response.status})`);
        }
        const data = response.json as Record<string, unknown> & {
            results?: Array<Record<string, unknown>>;
            web?: { results?: Array<Record<string, unknown>> };
        };
        const raw = data.results ?? data.web?.results ?? [];
        return raw
            .map(entry => toResult(entry.title ?? entry.name, entry.url ?? entry.link, entry.content ?? entry.snippet ?? entry.description))
            .filter((entry): entry is StudySearchResult => entry !== null)
            .slice(0, maxResults);
    }
}
