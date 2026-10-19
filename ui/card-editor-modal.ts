/**
 * The way into the card editor.
 *
 * There is no modal here any more. The editor is the in-place panel in
 * `ui/card-editor-panel.ts`, and it opens inside the cards surface — the deck
 * sitting's own view, under the sitting's bar, in the dock the reader is
 * already in. Nothing is placed over the note, and nothing is placed over the
 * cards either: the panel takes the card's place while it is open.
 *
 * This class is the seam the sidebar's "New card" row calls
 * (`new CardEditorModal(plugin).open()`); the name is kept so that row needs no
 * change, but what it opens is a sitting, not a window.
 */

import { Notice } from 'obsidian';

import type SpaceforgePlugin from '../main';
import type { CardEditorRequest } from './card-editor-panel';

export type { CardEditorRequest };

/**
 * Open the in-place editor in the cards surface.
 *
 * With no sitting running this starts one (a pane, or the dock when a review
 * session is up — never a popup), so a reader with nothing due can still write
 * a card. The sitting keeps working while the editor is open: the card comes
 * back exactly where it was when the editor closes.
 */
export async function openCardEditor(plugin: SpaceforgePlugin, request: CardEditorRequest = { mode: 'new' }): Promise<void> {
    const sitting = plugin.deckSessionController;
    if (!sitting) {
        new Notice('The deck lane is not available.');
        return;
    }
    await sitting.openCardEditor(request);
}

/**
 * The sidebar row's entry point (see the file comment): the name is the row's,
 * the shape it opens is the cards surface's.
 */
export class CardEditorModal {
    private plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    /** No window opens here: this is the sitting, with the editor in it. */
    open(): void {
        void openCardEditor(this.plugin, { mode: 'new' }).catch((error: unknown) => {
            console.error('spaceforge: could not open the card editor', error);
            new Notice('The card editor could not be opened.');
        });
    }
}
