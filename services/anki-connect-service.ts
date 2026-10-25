/**
 * Anki on the same computer, reached through the AnkiConnect add-on.
 *
 * This is the only way to move a schedule into a *running* Anki without a
 * package file in the middle: AnkiConnect listens on the loopback interface and
 * exposes `exportPackage` / `importPackage`, which are the same two operations
 * the reader would do by hand. Everything about the merge already lives in
 * `models/deck-merge.ts` — this service only carries bytes over that bridge.
 *
 * The rules that shape it:
 *
 * - **Desktop only.** The add-on binds to `127.0.0.1`, so a phone cannot reach
 *   it; {@link enabled} returns false away from the desktop and nothing runs.
 * - **Pull, merge, then push.** A sync reads Anki's copy first (so the desktop's
 *   answers land in the vault), merges card by card, and only then sends the
 *   merged deck back — which makes the next round a no-op instead of a fight.
 * - **A deck Anki does not have yet is pushed, not an error.** First run: the
 *   deck is new to Anki; the package creates it there, and the next pull finds
 *   it by id or by name.
 * - **One sync at a time.** A second call while one is running returns at once;
 *   the timer and the command must not race each other over the same files.
 */
import { Platform, requestUrl } from 'obsidian';

import SpaceforgePlugin from '../main';
import { AnkiCardQueue, AnkiCardType, AnkiId, isDayBasedDue } from '../models/anki';
import { syncFolderName } from '../models/deck-sync';
import { absolutePath } from '../utils/paths';
import { deckDayBase } from '../utils/dates';

/** The AnkiConnect protocol version this client speaks (the add-on's own). */
const PROTOCOL_VERSION = 6;

/** Where the add-on listens unless the reader points it elsewhere. */
const DEFAULT_URL = 'http://127.0.0.1:8765';

/** How many cards one package carries; Anki's importer fails on a few thousand. */
const CARDS_PER_PACKAGE = 500;

/** The vault folder used for the package hand-off; Anki writes into it on disk. */
const HANDOFF_FOLDER = 'spaceforge/sync/anki';

/** One action, posted as AnkiConnect documents it. Injectable for tests. */
export type AnkiConnectPost = (url: string, body: unknown) => Promise<unknown>;

/** What a status check learned. */
export interface AnkiConnectStatus {
    reachable: boolean;
    /** The add-on's protocol version, when it answered. */
    version: number | null;
    /** Anki's media folder, when it answered that question too. */
    mediaPath: string | null;
    /** Why it did not answer, when it did not. */
    error: string | null;
}

/** What Anki says about one card, in Anki's own day frame. */
interface AnkiCardSnapshot {
    cardId: number;
    type: number;
    queue: number;
    due: number;
    interval: number;
    factor: number;
}

/** What happened to one deck. */
export interface AnkiDeckSyncResult {
    path: string;
    name: string;
    /** Anki's copy was read and merged into the vault. */
    pulled: boolean;
    /** The merged deck was sent back to Anki. */
    pushed: boolean;
    /** Anki did not have this deck at all before the sync. */
    fresh: boolean;
    /** A short human note: why this deck failed, when it did. */
    note: string | null;
}

/** A whole sync's outcome. */
export interface AnkiSyncSummary {
    ok: boolean;
    decks: AnkiDeckSyncResult[];
    errors: string[];
    /** One line for the reader. */
    message: string;
}

/** The default transport: Obsidian's requestUrl, which ignores CORS. */
const defaultPost: AnkiConnectPost = async (url, body) => {
    const response = await requestUrl({
        url,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify(body),
        throw: false,
    });
    return response.json;
};

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class AnkiConnectService {
    plugin: SpaceforgePlugin;
    /** The transport, injectable so the protocol has a test that cannot dial out. */
    post: AnkiConnectPost;
    private syncing = false;
    /** Which way this add-on lets a due date be written; learned once. */
    private dueDoor: 'days' | 'column' | null = null;

    constructor(plugin: SpaceforgePlugin, post: AnkiConnectPost = defaultPost) {
        this.plugin = plugin;
        this.post = post;
    }

    /** The add-on's address, as configured. */
    url(): string {
        const configured = this.plugin.settings.ankiConnectUrl?.trim() ?? '';
        return configured === '' ? DEFAULT_URL : configured;
    }

    /** Is this machine able to talk to Anki at all, and did the reader ask for it? */
    enabled(): boolean {
        return Platform.isDesktop && this.plugin.settings.ankiConnectEnabled === true;
    }

    /**
     * One action to AnkiConnect. The add-on answers every request with
     * `{result, error}` regardless of HTTP status, so the error field is what
     * decides success.
     */
    private async call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
        const payload = await this.post(this.url(), { action, version: PROTOCOL_VERSION, params });
        if (typeof payload !== 'object' || payload === null) {
            throw new Error(`AnkiConnect answered ${action} with something that is not an object.`);
        }
        const record = payload as { result?: unknown; error?: unknown };
        if (record.error !== undefined && record.error !== null && record.error !== '') {
            throw new Error(String(record.error));
        }
        return record.result as T;
    }

    /** Is Anki answering, and which version of the add-on is it? */
    async status(): Promise<AnkiConnectStatus> {
        if (!Platform.isDesktop) {
            return {
                reachable: false,
                version: null,
                mediaPath: null,
                error: 'AnkiConnect runs on the computer Anki is installed on, so a phone cannot reach it.',
            };
        }
        try {
            const version = await this.call<number>('version');
            let mediaPath: string | null = null;
            try {
                mediaPath = await this.call<string>('getMediaDirPath');
            } catch {
                // An older add-on may not expose it; a status without it is fine.
                mediaPath = null;
            }
            return { reachable: true, version, mediaPath, error: null };
        } catch (error) {
            return { reachable: false, version: null, mediaPath: null, error: messageOf(error) };
        }
    }

    /**
     * Sync every deck in the vault: pull each one Anki already has, merge, then
     * push every deck back. Never throws — a failure is a line in the summary.
     */
    async syncAll(): Promise<AnkiSyncSummary> {
        const summary = (results: AnkiDeckSyncResult[], errors: string[]): AnkiSyncSummary => ({
            ok: errors.length === 0,
            decks: results,
            errors,
            message: summarize(results, errors),
        });

        if (!Platform.isDesktop) {
            return summary([], ['AnkiConnect is only reachable from the desktop app.']);
        }
        if (this.syncing) {
            return summary([], ['A sync with Anki is already running.']);
        }
        this.syncing = true;
        try {
            const status = await this.status();
            if (!status.reachable) {
                const url = this.url();
                return summary([], [
                    `Anki is not answering at ${url}. Is Anki running, with the AnkiConnect add-on? (${status.error ?? 'no answer'})`,
                ]);
            }

            const ankiDecks = await this.call<Record<string, number>>('deckNamesAndIds');
            const decks = await this.plugin.deckStore.listDecks();
            const results: AnkiDeckSyncResult[] = [];
            const errors: string[] = [];

            for (const deck of decks) {
                const result: AnkiDeckSyncResult = {
                    path: deck.path,
                    name: deck.name,
                    pulled: false,
                    pushed: false,
                    fresh: false,
                    note: null,
                };
                const notes: string[] = [];
                const ankiId = ankiIdFor(deck, ankiDecks);
                // Anki's own name for the deck: a deck renamed on either side is
                // matched by id, and every search and export has to use the name
                // *Anki* has, or it finds nothing.
                const ankiName = ankiId === null ? deck.name : nameForId(ankiDecks, ankiId) ?? deck.name;
                let ankiCrt: number | null = null;
                if (ankiId === null) {
                    result.fresh = true;
                    notes.push('new to Anki');
                } else {
                    try {
                        ankiCrt = await this.pullDeck(ankiName, ankiId, deck.name);
                        result.pulled = true;
                    } catch (error) {
                        const note = messageOf(error);
                        notes.push(note);
                        errors.push(`${deck.name}: ${note}`);
                    }
                }
                // Pushing is attempted even when the pull failed: the vault's
                // answers are still worth sending, and a deck Anki cannot
                // export is often one it can still import.
                try {
                    result.pushed = await this.pushDeck(deck.path, deck.id, ankiId !== null);
                    const schedule = await this.pushSchedule(deck.path, ankiName, ankiCrt);
                    if (schedule.carried > 0) {
                        notes.push(`${schedule.carried} due date${schedule.carried === 1 ? '' : 's'} carried`);
                    }
                    if (schedule.note !== null) {
                        notes.push(schedule.note);
                    }
                } catch (error) {
                    const note = messageOf(error);
                    notes.push(note);
                    errors.push(`${deck.name}: ${note}`);
                }
                result.note = notes.length > 0 ? notes.join('; ') : null;
                results.push(result);
            }
            return summary(results, errors);
        } catch (error) {
            return summary([], [messageOf(error)]);
        } finally {
            this.syncing = false;
        }
    }

    /**
     * The timer's entry point: does nothing unless the reader turned the
     * setting on, Anki is reachable in principle, and no sitting is running
     * (a background merge under a live sitting would move the queue beneath
     * the reader).
     */
    async syncIfEnabled(): Promise<AnkiSyncSummary | null> {
        if (!this.enabled()) return null;
        if (this.plugin.deckSessionController?.isActive()) return null;
        return this.syncAll();
    }

    // ------------------------------------------------------------ internals

    /**
     * Where a package is handed over: an absolute path Anki can write, and the
     * vault-relative one the adapter must use for its own reads and writes.
     * Mixing the two is a silent no-op — the file lands somewhere the vault is
     * not, or nowhere at all.
     */
    private async handoff(name: string): Promise<{ rel: string; abs: string }> {
        const root = this.basePath();
        if (root === null) throw new Error('This vault is not on a filesystem Anki can reach.');
        const rel = `${HANDOFF_FOLDER}/${name}.apkg`;
        await this.ensureFolder(HANDOFF_FOLDER);
        return { rel, abs: absolutePath(root, rel) };
    }

    /** Read Anki's copy of one deck and merge it into the vault's deck. */
    private async pullDeck(ankiName: string, ankiId: number, vaultName: string): Promise<number> {
        const file = await this.handoff(syncFolderName(String(ankiId)));
        try {
            await this.exportFromAnki(ankiName, ankiId, file.abs);
            const bytes = new Uint8Array(await this.readFile(file.rel));
            // The merge keeps the vault's own deck name, whatever Anki calls it.
            const report = await this.plugin.deckService.importApkg(bytes, { name: vaultName });
            // The package's `crt` is the day Anki's own day numbers count from —
            // the frame the pushed due dates have to be compared in.
            return report.crt ?? 0;
        } finally {
            await this.removeFile(file.rel);
        }
    }

    /**
     * `exportPackage` takes the deck's *name* under `deck` in both add-on
     * generations this has been tried against, and the id under `deckId` in
     * some; a number under `deck` reaches Anki's deck lookup as "bad argument
     * type", and a `deckId` the add-on does not know is either rejected or —
     * worse — dropped, which leaves it exporting the whole collection and
     * failing on the size of the search. So the name goes first.
     */
    private async exportFromAnki(name: string, ankiId: number, path: string): Promise<void> {
        try {
            await this.call('exportPackage', { deck: name, path, includeSched: true });
        } catch (error) {
            if (!/unexpected keyword argument|invalid keyword|unknown (?:field|parameter)|required positional argument|bad argument type/i.test(messageOf(error))) {
                throw error;
            }
            await this.call('exportPackage', { deckId: ankiId, path, includeSched: true });
        }
    }

    /**
     * Carry the vault's schedule to Anki, as far as Anki allows.
     *
     * AnkiConnect refuses to write the scheduling columns themselves on current
     * builds — the add-on answers "use native scheduling commands for protected
     * state" — so the interval, the reps and the lapses cannot be transferred.
     * What travels is the due *date* and the ease factor; Anki recomputes its own
     * interval the next time the card is answered. So Anki stays the schedule
     * authority and the vault mirrors it on every pull, and this is the half that
     * keeps a card from being shown on the phone a month before the desktop
     * expects it.
     *
     * Two ways to move a due date, and which one exists depends on the add-on's
     * build: `setDueDate` (a day count from today) on some, and writing the `due`
     * column through `setSpecificValueOfCard` on others — the maintained build
     * has the first and refuses the second, the older one the other way round.
     * The day count is tried first because it is the scheduler's own door; the
     * column is the fallback, and it is exact (a day number in Anki's frame, not
     * a delta), so it needs no correction for Anki's rollover hour.
     */
    private async pushSchedule(
        path: string,
        name: string,
        ankiCrt: number | null,
    ): Promise<{ carried: number; note: string | null }> {
        const bundle = await this.plugin.deckStore.readDeck(path);
        const onAnki = await this.cardsOnAnki(name);
        if (onAnki.size === 0) return { carried: 0, note: null };

        const crt = typeof bundle.extra?.crt === 'number' && bundle.extra.crt > 0
            ? bundle.extra.crt
            : Math.floor(deckDayBase(bundle.deck.id, null) / 1000);
        const createdDay = Math.floor(crt / 86_400);
        // Anki's own day count, when the pull just told us what it is. Without a
        // pull there is nothing to compare against, so every card is sent.
        const ankiDay = ankiCrt !== null && ankiCrt > 0 ? Math.floor(ankiCrt / 86_400) : null;

        const due = new Map<number, number>();
        const ease: Array<{ id: number; factor: number }> = [];
        for (const card of bundle.cards) {
            const id = Number(card.id);
            const theirs = onAnki.get(id);
            if (theirs === undefined) continue;
            if (card.type === AnkiCardType.New || card.queue === AnkiCardQueue.New) continue;
            if (theirs.factor !== card.easeFactor && card.easeFactor > 0) {
                ease.push({ id, factor: card.easeFactor });
            }
            // A learning card's due is a clock time, and Anki has its own view of
            // the steps; the next pull brings it back.
            if (!isDayBasedDue(card.type, card.queue)) continue;
            const target = createdDay + card.due;
            if (ankiDay !== null && theirs.type === AnkiCardType.Review && Math.abs(ankiDay + theirs.due - target) <= 1) continue;
            due.set(id, target);
        }

        let carried = 0;
        let note: string | null = null;
        if (due.size > 0) {
            const result = await this.carryDue(due, ankiDay);
            carried = result.carried;
            note = result.note;
        }
        for (const entry of ease) {
            await this.call('setEaseFactors', { cards: [entry.id], easeFactors: [entry.factor] });
        }
        return { carried, note };
    }

    /**
     * Write due dates, by whichever door this add-on opens.
     *
     * `days` (a count from today) is the scheduler's own way in, but it is
     * counted from *Anki's* today, which rolls over at its own hour: the batch is
     * read back and corrected when the two clocks disagree. The `due` column is a
     * day number in the collection's own frame, so it lands exactly; it is used
     * when the build has no `setDueDate`, which is the case for the older add-on.
     */
    private async carryDue(
        due: Map<number, number>,
        ankiDay: number | null,
    ): Promise<{ carried: number; note: string | null }> {
        const groups = new Map<number, number[]>();
        for (const [id, target] of due) {
            const group = groups.get(target) ?? [];
            group.push(id);
            groups.set(target, group);
        }

        if (await this.dueDoorFor() === 'days') {
            const today = Math.floor(Date.now() / 86_400_000);
            for (const [target, ids] of groups) {
                await this.call('setDueDate', { cards: ids, days: String(target - today) });
            }
            // Anki counts from its own today; if the batch landed a day out, say
            // so in Anki's terms rather than leave a wrong date behind.
            if (ankiDay !== null) {
                const [firstId, firstTarget] = [...due.entries()][0];
                const skew = await this.skewOnAnki({ id: firstId, days: firstTarget - today }, ankiDay);
                if (skew !== 0) {
                    for (const [target, ids] of groups) {
                        await this.call('setDueDate', { cards: ids, days: String(target - today - skew) });
                    }
                }
            }
            return { carried: due.size, note: null };
        }

        // The `due` column, card by card: the add-on takes one value per card.
        if (ankiDay === null) {
            return { carried: 0, note: 'this Anki’s add-on cannot set due dates from here; the decks stay in step for content and ease' };
        }
        let carried = 0;
        for (const [id, target] of due) {
            try {
                await this.call('setSpecificValueOfCard', { card: id, keys: ['due'], newValues: [target - ankiDay] });
            } catch (error) {
                // The content has already gone across; a due date this add-on will
                // not write is a limitation to report, not a failed sync.
                return {
                    carried,
                    note: `this Anki’s add-on would not set a due date (${messageOf(error)}); content and ease still match`,
                };
            }
            carried += 1;
        }
        return { carried, note: null };
    }

    /**
     * Which door this add-on opens for a due date.
     *
     * Every AnkiConnect release tried (the FooSoft 23.10 build and the current
     * master) answers 110 actions and `setDueDate` is not one of them; a fork may
     * add it, so the action list is asked for once per session rather than
     * assumed. Without `apiReflect`, the column is the safe assumption: it exists
     * in both builds, and a failed `setDueDate` would cost a call per sync.
     */
    private async dueDoorFor(): Promise<'days' | 'column'> {
        if (this.dueDoor !== null) return this.dueDoor;
        try {
            const reflected = await this.call<{ actions?: unknown }>('apiReflect', { scopes: ['actions'] });
            const actions = Array.isArray(reflected?.actions) ? reflected.actions : [];
            this.dueDoor = actions.includes('setDueDate') ? 'days' : 'column';
        } catch {
            this.dueDoor = 'column';
        }
        return this.dueDoor;
    }

    /**
     * How far a batch of due dates landed from where it was aimed, in days.
     *
     * The day count was measured from the machine's today; Anki counts from its
     * own, which is behind whenever the reader is up before Anki's rollover hour.
     * The card's new `due` is a day number in Anki's frame, so `crtDay + due` is
     * where it actually landed. Zero when the two clocks agree.
     */
    private async skewOnAnki(sent: { id: number; days: number }, ankiDay: number): Promise<number> {
        const info = await this.call<AnkiCardSnapshot[]>('cardsInfo', { cards: [sent.id] });
        const due = Array.isArray(info) && info.length > 0 ? Number(info[0].due) : null;
        if (due === null || !Number.isFinite(due)) return 0;
        return ankiDay + due - (Math.floor(Date.now() / 86_400_000) + sent.days);
    }

    /** Every card Anki holds for a deck, by id, in Anki's own day frame. */
    private async cardsOnAnki(name: string): Promise<Map<number, AnkiCardSnapshot>> {
        const query = `deck:"${name.replace(/"/g, '\\"')}"`;
        const ids = await this.call<number[]>('findCards', { query });
        if (!Array.isArray(ids) || ids.length === 0) return new Map();
        const info = await this.call<AnkiCardSnapshot[]>('cardsInfo', { cards: ids });
        const out = new Map<number, AnkiCardSnapshot>();
        for (const card of Array.isArray(info) ? info : []) {
            out.set(Number(card.cardId), card);
        }
        return out;
    }

    /**
     * Send the vault's deck to Anki as a package, in slices.
     *
     * Two reasons it is not one file. Anki's importer searches the whole package
     * it is given — the notes and cards it already has — and a few thousand cards
     * in one package make it fail with "Expression tree is too large", which is
     * Anki's own limit, not a size the vault chose. And a package is only worth
     * writing when the deck changed: the timer runs every few minutes and a deck
     * of ten thousand cards would otherwise be rebuilt and re-imported each time.
     * A slice carries only the notes of the cards in it, so a note is never split
     * across packages.
     */
    private async pushDeck(path: string, deckId: string, known: boolean): Promise<boolean> {
        const bundle = await this.plugin.deckStore.readDeck(path);
        const stamp = Number(bundle.deck.modified ?? 0);
        const last = this.plugin.settings.ankiPushed?.[path];
        if (known && last !== undefined && last === stamp) {
            return false;
        }
        const ids = bundle.cards.map((card) => card.id);
        const slices: AnkiId[][] = [];
        for (let index = 0; index < ids.length; index += CARDS_PER_PACKAGE) {
            slices.push(ids.slice(index, index + CARDS_PER_PACKAGE));
        }
        if (slices.length === 0) slices.push([]);

        for (const [index, cardIds] of slices.entries()) {
            const exported = await this.plugin.deckService.exportDeck(path, { cardIds });
            const file = await this.handoff(`${syncFolderName(deckId)}-out${slices.length > 1 ? `-${index + 1}` : ''}`);
            try {
                await this.writeFile(file.rel, exported.bytes);
                await this.call('importPackage', { path: file.abs });
            } finally {
                await this.removeFile(file.rel);
            }
        }

        this.plugin.settings.ankiPushed = {
            ...(this.plugin.settings.ankiPushed ?? {}),
            [path]: stamp,
        };
        await this.plugin.savePluginData();
        return true;
    }

    /** The vault's absolute path, on a desktop filesystem. */
    private basePath(): string | null {
        const adapter = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string };
        if (typeof adapter.getBasePath !== 'function') return null;
        const base = adapter.getBasePath();
        return typeof base === 'string' && base.length > 0 ? base : null;
    }

    private async readFile(path: string): Promise<ArrayBuffer> {
        return await this.plugin.app.vault.adapter.readBinary(path);
    }

    private async writeFile(path: string, bytes: Uint8Array): Promise<void> {
        const copy = bytes.slice();
        await this.plugin.app.vault.adapter.writeBinary(path, copy.buffer as ArrayBuffer);
    }

    private async removeFile(path: string): Promise<void> {
        try {
            if (await this.plugin.app.vault.adapter.exists(path)) {
                await this.plugin.app.vault.adapter.remove(path);
            }
        } catch (error) {
            console.warn('[spaceforge] a hand-off package could not be removed', error);
        }
    }

    private async ensureFolder(path: string): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        let current = '';
        for (const segment of path.split('/')) {
            current = current.length > 0 ? `${current}/${segment}` : segment;
            if (current === '') continue;
            if (!(await adapter.exists(current))) {
                try {
                    await adapter.mkdir(current);
                } catch (error) {
                    // An already-existing folder is the common race; anything
                    // else surfaces when the file is written.
                    if (!(await adapter.exists(current))) throw error;
                }
            }
        }
    }
}

/**
 * Which Anki deck a vault deck is. The id the package carries is the first
 * choice; the name is the fallback, because a package imported by hand may have
 * been given a fresh id by Anki while keeping its name.
 */
/** The name Anki knows a deck by, from its id. */
function nameForId(ankiDecks: Record<string, number>, ankiId: number): string | null {
    for (const [name, id] of Object.entries(ankiDecks)) {
        if (id === ankiId) return name;
    }
    return null;
}

function ankiIdFor(deck: { id: string; name: string }, ankiDecks: Record<string, number>): number | null {
    const byName = ankiDecks[deck.name];
    if (typeof byName === 'number' && Number.isFinite(byName)) return byName;
    const numeric = Number(deck.id);
    if (Number.isFinite(numeric) && Object.values(ankiDecks).includes(numeric)) return numeric;
    return null;
}

/** Does an add-on error mean this build simply does not have the action? */
function isMissingAction(error: unknown): boolean {
    return /unsupported action|unexpected keyword|does not exist|not (?:available|supported|implemented)|unknown action/i.test(
        error instanceof Error ? error.message : String(error),
    );
}

function summarize(results: AnkiDeckSyncResult[], errors: string[]): string {
    if (results.length === 0) {
        return errors.length > 0 ? errors[0] : 'Anki: there are no decks to sync.';
    }
    const pushed = results.filter(result => result.pushed).length;
    const pulled = results.filter(result => result.pulled).length;
    const fresh = results.filter(result => result.fresh).length;
    const parts = [`${pulled} of ${results.length} ${results.length === 1 ? 'deck' : 'decks'} pulled`];
    if (pushed > 0) parts.push(`${pushed} pushed`);
    if (fresh > 0) parts.push(`${fresh} new to Anki`);
    const head = `Anki: ${parts.join(', ')}`;
    return errors.length > 0 ? `${head}. ${errors[0]}` : `${head}.`;
}
