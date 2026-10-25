/**
 * Paths that leave the vault: the vault gives a directory, Anki wants a file
 * name inside it, and the two speak different separators.
 *
 * Obsidian's adapter always takes vault-relative paths with forward slashes,
 * whatever the OS. A program outside Obsidian — Anki, in the deck bridge — takes
 * an OS path, and on Windows that means backslashes: a forward slash in a path
 * handed to `importPackage` reaches Python's `pathlib` intact, but the same
 * string goes through Anki's own `Path` handling and its error reporting reads
 * like a missing file rather than a separator problem. Normalising here keeps
 * that difference in one place, where it has a test.
 */

/** How a path is written on the machine that will read it. */
export function pathSeparator(root: string): string {
    return root.includes('\\') && !root.includes('/') ? '\\' : '/';
}

/**
 * A vault-relative path as an absolute one under `root`.
 *
 * The root keeps its own separator; the relative part is rewritten to match, so
 * `C:\Users\reader\Vault` and `spaceforge/sync/x.apkg` become
 * `C:\Users\reader\Vault\spaceforge\sync\x.apkg` rather than a mixture. A root
 * that already ends in a separator does not gain a second one.
 */
export function absolutePath(root: string, rel: string): string {
    const separator = pathSeparator(root);
    const trimmed = root.replace(/[\\/]+$/, '');
    const relative = rel
        .split(/[\\/]+/)
        .filter(segment => segment.length > 0)
        .join(separator);
    return relative.length === 0 ? trimmed : `${trimmed}${separator}${relative}`;
}
