/**
 * Search AnkiWeb's shared decks and import one.
 *
 * Keyboard-first, because that is how a reader arrives here: the search field
 * autofocuses, Enter searches (or opens the highlighted deck when the query
 * has not changed), the arrow keys move the highlight, and Ctrl/Cmd+Enter
 * imports the highlighted deck. Everything the modal needs from the rest of
 * the plugin is injected (`AnkiWebSearchModalHost`), so it holds no service of
 * its own and the tests can drive the pure parts of it in Node.
 *
 * The modal's job includes being honest about refusals: AnkiWeb will not hand
 * a package to a signed-out visitor, so an import that was refused shows the
 * reason AnkiWeb gave, with the "open on AnkiWeb" path right there, instead of
 * pretending the import failed. Nothing here ever asks for AnkiWeb
 * credentials.
 *
 * Housekeeping: no inline styles (the stylesheet does the styling, and
 * `setCssProps` would be the tool for anything dynamic), no fixed px font
 * sizes, sentence-case UI text.
 */
import { App, Modal } from 'obsidian';
import { AnkiWebDeckResult, AnkiWebSearchOutcome } from '../services/ankiweb-service';

/** What running an import produced, as the modal should present it. */
export interface AnkiWebImportResult {
    kind: 'imported' | 'needs-sign-in' | 'refused' | 'failed';
    /** The sentence to show the reader; for refusals this is AnkiWeb's own. */
    message: string;
}

/**
 * Everything the modal borrows from the plugin. `importDeck` is expected to
 * fetch the package (through `AnkiWebService`) and hand the bytes to the .apkg
 * importer; the modal only reports what it gets back.
 */
export interface AnkiWebSearchModalHost {
    searchDecks(query: string): Promise<AnkiWebSearchOutcome>;
    importDeck(deck: AnkiWebDeckResult): Promise<AnkiWebImportResult>;
    /** Opens a URL in the reader's browser. Defaults to `window.open`. */
    openExternal?(url: string): void;
}

/**
 * The keyboard ring arithmetic, kept out of the DOM so it can be tested: the
 * highlight walks the list and clamps at both ends. An empty list has no
 * highlight (-1).
 */
export function moveHighlight(current: number, delta: number, length: number): number {
    if (length <= 0) return -1;
    if (current < 0) return delta > 0 ? 0 : length - 1;
    const next = current + delta;
    if (next < 0) return 0;
    if (next >= length) return length - 1;
    return next;
}

/** The one-line summary of a search, before any warning is shown under it. */
export function describeSearchOutcome(outcome: AnkiWebSearchOutcome): string {
    switch (outcome.status) {
        case 'ok':
            return outcome.results.length === 1 ? '1 deck found.' : `${outcome.results.length} decks found.`;
        case 'empty':
            return 'No decks matched.';
        case 'needs-sign-in':
            return 'AnkiWeb wants a signed-in visitor for this search.';
        default:
            return 'The search results could not be read.';
    }
}

/** The metadata line under a result's name; empty when the page said nothing. */
export function describeDeckMeta(deck: AnkiWebDeckResult): string {
    const parts: string[] = [];
    if (deck.ratings !== undefined) parts.push(`${deck.ratings.toLocaleString('en-US')} ratings`);
    if (deck.downloads !== undefined) parts.push(`${deck.downloads.toLocaleString('en-US')} downloads`);
    if (deck.author) parts.push(`by ${deck.author}`);
    return parts.join(' · ');
}

export class AnkiWebSearchModal extends Modal {
    private host: AnkiWebSearchModalHost;
    private inputEl: HTMLInputElement | null = null;
    private statusEl: HTMLElement | null = null;
    private warningEl: HTMLElement | null = null;
    private actionEl: HTMLElement | null = null;
    private listEl: HTMLElement | null = null;
    private results: AnkiWebDeckResult[] = [];
    private highlight = -1;
    private lastSearched = '';
    private searching = false;

    constructor(app: App, host: AnkiWebSearchModalHost) {
        super(app);
        this.host = host;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.titleEl.setText('Import from AnkiWeb');
        contentEl.addClass('sf-ankiweb-modal');

        const searchRow = contentEl.createDiv({ cls: 'sf-ankiweb-search-row' });
        this.inputEl = searchRow.createEl('input', {
            cls: 'sf-ankiweb-input',
            attr: {
                type: 'search',
                placeholder: 'Search AnkiWeb decks',
                'aria-label': 'Search AnkiWeb decks',
                spellcheck: 'false',
            },
        });
        const searchButton = searchRow.createEl('button', {
            cls: 'sf-ankiweb-search-button',
            text: 'Search',
            attr: { type: 'button' },
        });
        searchButton.addEventListener('click', () => void this.runSearch());
        this.inputEl.addEventListener('keydown', (event) => this.onSearchKeydown(event));

        this.statusEl = contentEl.createDiv({ cls: 'sf-ankiweb-status' });
        this.warningEl = contentEl.createDiv({ cls: 'sf-ankiweb-warning' });
        this.warningEl.hide();
        this.actionEl = contentEl.createDiv({ cls: 'sf-ankiweb-action' });
        this.listEl = contentEl.createDiv({ cls: 'sf-ankiweb-results' });
        this.listEl.addEventListener('keydown', (event) => this.onListKeydown(event));
        contentEl.createDiv({
            cls: 'sf-ankiweb-hint',
            text: 'Enter opens the highlighted deck on AnkiWeb; Ctrl/Cmd+Enter imports it.',
        });

        this.setStatus('Type a few words to search AnkiWeb.');
        this.inputEl.focus();
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.inputEl = null;
        this.statusEl = null;
        this.warningEl = null;
        this.actionEl = null;
        this.listEl = null;
        this.results = [];
        this.highlight = -1;
    }

    /* ------------------------------------------------------------- keyboard */

    private onSearchKeydown(event: KeyboardEvent): void {
        const input = this.inputEl;
        if (!input) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            if ((event.ctrlKey || event.metaKey) && this.highlight >= 0) {
                const deck = this.results[this.highlight];
                if (deck) void this.importDeck(deck);
                return;
            }
            if (input.value.trim() !== this.lastSearched || this.highlight < 0) {
                void this.runSearch();
                return;
            }
            const deck = this.results[this.highlight];
            if (deck) this.openDeck(deck);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (this.results.length === 0) return;
            event.preventDefault();
            this.setHighlight(moveHighlight(this.highlight, event.key === 'ArrowDown' ? 1 : -1, this.results.length));
        }
    }

    private onListKeydown(event: KeyboardEvent): void {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (this.results.length === 0) return;
            event.preventDefault();
            this.focusResult(moveHighlight(this.highlight, event.key === 'ArrowDown' ? 1 : -1, this.results.length));
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && this.highlight >= 0) {
            event.preventDefault();
            const deck = this.results[this.highlight];
            if (deck) void this.importDeck(deck);
        }
    }

    /* -------------------------------------------------------------- actions */

    private async runSearch(): Promise<void> {
        const input = this.inputEl;
        if (!input || this.searching) return;
        const query = input.value.trim();
        if (query.length === 0) {
            this.setStatus('Type something to search for.');
            return;
        }

        this.searching = true;
        this.lastSearched = query;
        this.setStatus(`Searching AnkiWeb for “${query}”…`);
        this.setWarning(null);
        this.clearAction();
        this.clearResults();

        let outcome: AnkiWebSearchOutcome;
        try {
            outcome = await this.host.searchDecks(query);
        } catch (error) {
            // The service reports failures rather than throwing; a host that
            // does not still must not take the modal down.
            this.searching = false;
            if (!this.inputEl) return;
            this.setStatus('The search could not be run.');
            this.setWarning(error instanceof Error ? error.message : String(error));
            return;
        }
        this.searching = false;
        if (!this.inputEl) return; // The modal was closed while the search ran.

        this.setStatus(describeSearchOutcome(outcome));
        const needsBrowser = outcome.status === 'unreadable'
            || outcome.status === 'needs-sign-in'
            || (outcome.status === 'ok' && outcome.results.length === 0);
        this.setWarning(outcome.warning, needsBrowser ? query : null);
        this.results = outcome.status === 'ok' ? outcome.results : [];
        this.renderResults();
        if (this.results.length > 0) this.setHighlight(0);
    }

    private openDeck(deck: AnkiWebDeckResult): void {
        if (this.host.openExternal) {
            this.host.openExternal(deck.url);
            return;
        }
        window.open(deck.url, '_blank', 'noopener');
    }

    private async importDeck(deck: AnkiWebDeckResult): Promise<void> {
        this.setStatus(`Importing “${deck.name}”…`);
        this.setWarning(null);
        this.clearAction();

        const result = await this.host.importDeck(deck).catch((error: unknown): AnkiWebImportResult => ({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error),
        }));
        if (!this.inputEl) return; // The modal was closed while the import ran.

        if (result.kind === 'imported') {
            this.setStatus(result.message);
            return;
        }

        // A refusal is an answer, not a failure: say why, and offer the browser.
        this.setStatus(result.message);
        const action = this.actionEl;
        if (action) {
            const openButton = action.createEl('button', {
                cls: 'sf-ankiweb-open-button',
                text: 'Open this deck on AnkiWeb',
                attr: { type: 'button' },
            });
            openButton.addEventListener('click', () => this.openDeck(deck));
        }
    }

    /* ------------------------------------------------------------ rendering */

    private clearResults(): void {
        this.results = [];
        this.highlight = -1;
        this.listEl?.empty();
    }

    private renderResults(): void {
        const list = this.listEl;
        if (!list) return;
        list.empty();
        this.results.forEach((deck, index) => {
            const row = list.createDiv({ cls: 'sf-ankiweb-result' });
            const openButton = row.createEl('button', {
                cls: 'sf-ankiweb-result-open',
                attr: { type: 'button' },
            });
            openButton.createSpan({ cls: 'sf-ankiweb-result-name', text: deck.name });
            const meta = describeDeckMeta(deck);
            if (meta.length > 0) openButton.createSpan({ cls: 'sf-ankiweb-result-meta', text: meta });
            openButton.addEventListener('click', () => {
                this.setHighlight(index);
                this.openDeck(deck);
            });

            const importButton = row.createEl('button', {
                cls: 'sf-ankiweb-result-import',
                text: 'Import',
                attr: { type: 'button' },
            });
            importButton.addEventListener('click', () => void this.importDeck(deck));
        });
    }

    private setStatus(text: string): void {
        this.statusEl?.setText(text);
    }

    private setWarning(text: string | null, browserQuery: string | null = null): void {
        const warning = this.warningEl;
        if (!warning) return;
        warning.empty();
        if (text === null) {
            warning.hide();
            return;
        }
        warning.createDiv({ cls: 'sf-ankiweb-warning-text', text });
        if (browserQuery !== null) {
            // The sentence above says to search AnkiWeb instead; this is that
            // sentence's verb, so the reader never has to retype the query.
            const button = warning.createEl('button', { cls: 'sf-ankiweb-browser', text: 'Search on AnkiWeb' });
            button.addEventListener('click', () => this.openSearchInBrowser(browserQuery));
        }
        warning.show();
    }

    /** AnkiWeb's own search page, for the query the reader already typed. */
    private openSearchInBrowser(query: string): void {
        const url = `https://ankiweb.net/shared/decks?search=${encodeURIComponent(query)}`;
        if (this.host.openExternal) {
            this.host.openExternal(url);
            return;
        }
        window.open(url, '_blank', 'noopener');
    }

    private clearAction(): void {
        this.actionEl?.empty();
    }

    private setHighlight(index: number): void {
        this.highlight = index;
        const list = this.listEl;
        if (!list) return;
        for (let i = 0; i < list.children.length; i++) {
            const row = list.children.item(i);
            if (!(row instanceof HTMLElement)) continue;
            row.toggleClass('is-highlighted', i === index);
            if (i === index) row.scrollIntoView({ block: 'nearest' });
        }
    }

    private focusResult(index: number): void {
        this.setHighlight(index);
        const row = this.listEl?.children.item(index);
        if (row instanceof HTMLElement) {
            const button = row.querySelector('button');
            if (button instanceof HTMLElement) button.focus();
        }
    }
}
