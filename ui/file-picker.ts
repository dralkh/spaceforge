/**
 * Picking a file from the reader's own disk.
 *
 * Obsidian's vault API only reaches inside the vault, and `.apkg` files arrive
 * from outside it — a download from AnkiWeb, a package a colleague sent, a file
 * from an older Anki install. A hidden file input is the platform's own way to
 * ask, works on desktop and mobile alike, and needs no permissions beyond the
 * one file the reader chooses.
 */

/** What the reader chose, with just enough about it to name it in a notice. */
export interface PickedFile {
    name: string;
    bytes: Uint8Array;
}

export interface PickFileOptions {
    /** The `accept` attribute; keep it narrow so the dialog filters for them. */
    accept?: string;
    /** What the dialog's own title suggests, where the platform shows one. */
    hint?: string;
}

/**
 * Ask for a file and read it. Resolves with null when the reader closes the
 * dialog without choosing anything — a decision, not a failure.
 */
export function pickFile(options: PickFileOptions = {}): Promise<PickedFile | null> {
    return new Promise(resolve => {
        const input = createEl('input');
        input.type = 'file';
        input.accept = options.accept ?? '.apkg,.colpkg,.anki2,application/zip,application/octet-stream';
        if (options.hint) input.setAttribute('aria-label', options.hint);
        input.addClass('sf-pick-file');

        let settled = false;
        const finish = (file: PickedFile | null): void => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(file);
        };

        input.addEventListener('change', () => {
            const chosen = input.files?.[0];
            if (!chosen) {
                finish(null);
                return;
            }
            void chosen
                .arrayBuffer()
                .then(buffer => finish({ name: chosen.name, bytes: new Uint8Array(buffer) }))
                .catch(error => {
                    console.error('spaceforge: could not read the chosen file', error);
                    finish(null);
                });
        });

        // A cancelled dialog fires no event in every browser, so the element is
        // left in the DOM and cleaned up by the next pick; it is invisible.
        document.body.appendChild(input);
        input.click();
    });
}
