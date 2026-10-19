/**
 * How a deck's name reads on screen.
 *
 * A deck's name is its own — "Robbins Basic Pathology", "Grading demo" — but a
 * deck that arrived as a package, or that was named after the file it came in,
 * can carry the container's extension in its name ("round-trip.apkg"). The file
 * it lives in is an implementation detail; the reader is looking at a deck.
 * Stripping it on the way to the screen keeps that distinction in one place,
 * and never touches what is stored.
 */

/** Extensions a deck's name may have inherited from the file it arrived in. */
const PACKAGE_EXTENSION = /\.(apkg|colpkg|anki2)$/i;

/** The name to put in front of a reader. */
export function displayDeckName(name: string): string {
    const trimmed = name.trim();
    const withoutExtension = trimmed.replace(PACKAGE_EXTENSION, '').trim();
    // A deck genuinely named ".apkg" is absurd; an empty label is worse.
    return withoutExtension.length > 0 ? withoutExtension : trimmed;
}
