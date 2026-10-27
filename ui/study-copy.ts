/**
 * Keep the tutor's closing line from asking the question twice.
 *
 * The protocol carries the question in `next.text`, which the panel renders as
 * its own answerable card. Models still often end `say` with "Your turn: …"
 * restating it, and at sidebar width that duplicate costs a whole paragraph and
 * splits the reader's attention. Only a final paragraph that both announces a
 * turn and substantially repeats the question is removed; teaching prose stays.
 */
export function stripRestatedQuestion(say: string, question: string | null | undefined): string {
    if (!question) return say;
    const paragraphs = say.trimEnd().split(/\n{2,}/);
    if (paragraphs.length < 2) return say;
    const last = paragraphs[paragraphs.length - 1];
    if (!/your turn/i.test(last)) return say;

    const tokens = (text: string): Set<string> => new Set(
        text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(word => word.length >= 3),
    );
    const asked = tokens(question);
    if (asked.size === 0) return say;
    let shared = 0;
    tokens(last).forEach(token => { if (asked.has(token)) shared += 1; });
    if (shared / asked.size < 0.6) return say;
    return paragraphs.slice(0, -1).join('\n\n');
}
