/**
 * Images inside a note, as study material.
 *
 * The tutor cannot see pictures, and pretending otherwise would be the worst
 * kind of dishonesty in a teaching tool. What it *can* do is know that they
 * exist, know what the learner called them and which section they sit in, and
 * tell the learner to look at one — and the panel can preview it. So images are
 * extracted, resolved to vault files, and passed to the model as references it
 * is allowed to point at but never describe.
 *
 * Also used for charting: a figure's place in the note is a legitimate source
 * anchor ("interpret the ECG strip in figure 3"), which keeps image-only
 * material from vanishing from a plan.
 */

export type StudyImageSyntax = 'embed' | 'markdown' | 'remote';

export interface StudyImageRef {
    /** Stable id within the note: img-1, img-2, … */
    id: string;
    /** The exact syntax as it appears in the note, so the tutor can reuse it. */
    raw: string;
    syntax: StudyImageSyntax;
    /** Link target: a vault path, a bare filename, or a URL. */
    target: string;
    /** Basename, for display and for the prompt. */
    fileName: string;
    /** Resolved vault path, when a resolver was supplied and found it. */
    resolvedPath: string | null;
    /** Alt text or caption, when the note provides one. */
    alt: string;
    /** 1-based line number in the note. */
    line: number;
    /** Nearest preceding heading, which is usually the figure's topic. */
    heading: string | null;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

interface Match {
    raw: string;
    index: number;
    syntax: StudyImageSyntax;
    target: string;
    alt: string;
}

/** Find wiki embeds, markdown images and bare image URLs, in document order. */
function findMatches(content: string): Match[] {
    const matches: Match[] = [];

    // Obsidian embeds: ![[file.png]], ![[file.png|300]], ![[file.png|alt]]
    const embedPattern = /!\[\[([^\]|#]+?)(?:\|([^\]]*))?\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = embedPattern.exec(content)) !== null) {
        const target = match[1].trim();
        if (!IMAGE_EXTENSIONS.test(target)) continue;
        matches.push({ raw: match[0], index: match.index, syntax: 'embed', target, alt: (match[2] ?? '').trim() });
    }

    // Markdown images: ![alt](path "title")
    const markdownPattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    while ((match = markdownPattern.exec(content)) !== null) {
        const target = match[2].trim();
        const isRemote = /^https?:\/\//i.test(target);
        if (!isRemote && !IMAGE_EXTENSIONS.test(target)) continue;
        matches.push({
            raw: match[0],
            index: match.index,
            syntax: isRemote ? 'remote' : 'markdown',
            target,
            alt: match[1].trim(),
        });
    }

    return matches.sort((a, b) => a.index - b.index);
}

/** The heading that governs a line, given the content before it. */
function nearestHeading(contentBefore: string): string | null {
    const headings = contentBefore.match(/^#{1,6}\s+.+$/gm);
    if (!headings || headings.length === 0) return null;
    return headings[headings.length - 1].replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').trim();
}

/**
 * Extract every image reference from a note.
 *
 * `resolve` maps a link target to a vault path and is optional: without it the
 * refs are still complete enough for the prompt, they just cannot be previewed.
 */
export function extractImageRefs(
    content: string,
    resolve?: (target: string) => string | null
): StudyImageRef[] {
    const refs: StudyImageRef[] = [];

    for (const match of findMatches(content)) {
        const line = content.slice(0, match.index).split('\n').length;
        const headingBefore = content.slice(0, match.index);
        const fileName = match.target.split('/').pop() ?? match.target;
        refs.push({
            id: `img-${refs.length + 1}`,
            raw: match.raw,
            syntax: match.syntax,
            target: match.target,
            fileName,
            resolvedPath: match.syntax === 'remote' ? match.target : (resolve ? resolve(match.target) : null),
            alt: match.alt,
            line,
            heading: nearestHeading(headingBefore),
        });
    }

    return refs;
}

/** Which images fall inside a slice of the note, by line range. */
export function imagesInRange(refs: StudyImageRef[], startLine: number, endLine: number): StudyImageRef[] {
    return refs.filter(ref => ref.line >= startLine && ref.line <= endLine);
}

/**
 * Replace image lines with compact, still-honest markers.
 *
 * Chunk text is token budget; a 90-character asset path plus the surrounding
 * blank lines costs real money across forty figures and teaches nothing. The
 * marker keeps the figure's position and name so anchors and captions survive.
 */
export function markImageLines(content: string, refs: StudyImageRef[]): string {
    if (refs.length === 0) return content;
    const markerByLine = new Map(refs.map(ref => [ref.line, `[figure: ${ref.fileName}${ref.alt ? ` — ${ref.alt}` : ''}]`]));
    return content
        .split('\n')
        .map((line, index) => markerByLine.get(index + 1) ?? line)
        .join('\n');
}

/**
 * The image block handed to the model, for a whole note or one section.
 *
 * Ends with the constraint, not the invitation, because the failure mode is a
 * model confidently describing a picture it has never seen.
 */
export function describeImagesForPrompt(refs: StudyImageRef[]): string {
    if (refs.length === 0) return '';
    const lines = refs.map(ref => {
        const where = ref.heading ? ` in section "${ref.heading}"` : '';
        const caption = ref.alt ? `, caption/alt: "${ref.alt}"` : '';
        // Prefer a wiki embed: it resolves vault-wide, so the tutor can show a
        // figure from a note in any folder without knowing where it sits.
        const show = ref.resolvedPath && ref.syntax !== 'remote' ? `![[${ref.resolvedPath}]]` : ref.raw;
        return `- ${ref.id}: ${ref.fileName}${where}${caption} | to show it, write this exactly: ${show}`;
    });
    return `IMAGES IN THIS NOTE (you cannot see them)
${lines.join('\n')}
You may point the learner at a figure ("look at the ECG strip in ${refs[0].fileName}") and ask what they see, or ask them to reproduce it from memory. You must never claim to see an image, describe its contents, or interpret what it shows. If an objective depends on a figure, ask the learner to describe it and grade their description against the note text, not against the image. When you want an image shown in the session, write its exact syntax from the list above into your "say" text.`;
}
