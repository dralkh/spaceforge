/**
 * How a deck card asks its question, and how an answer is judged.
 *
 * Pure: a note and a card go in, a resolved view comes out, and nothing here
 * touches the vault, the DOM or the clock. Everything the deck runner shows is
 * decided in this file, so a preview and the real sitting cannot disagree — and
 * so the rules can be tested without a model, a window or a vault.
 *
 * The shapes are Anki's: two fields are a flip card (one answer per direction),
 * one field with {{c1::…}} is a cloze card, and a typed answer is compared the
 * way Anki's `compare_answer` compares it — exactly, unless the card says
 * otherwise with the same two modifiers Anki has (`ci:` case, `nc:` accents).
 */

import {
    AnkiCard,
    AnkiNote,
    CardPresentation,
    CardPresentationMode,
} from './anki';

/** The card as the runner needs it: text resolved, mode decided. */
export interface CardView {
    mode: CardPresentationMode;
    /** What the reader is shown first. Media is already rewritten to vault paths. */
    front: string;
    /** What is revealed. */
    back: string;
    /**
     * What a typed answer is compared against. Usually the back, but a cloze
     * card compares against the deleted words themselves — its back is the
     * text with those words *emphasised*, which nothing should ever be asked
     * to type.
     */
    answerText: string;
    /** Multiple choice: the choices, in order. Empty for every other mode. */
    choices: string[];
    /** Multiple choice: which choice is right, or -1 when it is not known. */
    answerIndex: number;
    /** Typing: other spellings that count as right. */
    accept: string[];
    /** Typing: the comparison ignores capitalisation. */
    caseInsensitive: boolean;
    /** Typing: the comparison ignores diacritics. */
    ignoreDiacritics: boolean;
    /** Cloze: which deletion this card asks about, counting from 1. */
    clozeOrdinal: number;
    /** The note's own tags, for the runner's header and the export. */
    tags: string[];
}

/** Matches Anki's cloze syntax, with the optional hint form {{c1::text::hint}}. */
const CLOZE_PATTERN = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g;

/** A fresh matcher every time: a shared /g regex carries lastIndex between calls. */
function clozeMatcher(): RegExp {
    return new RegExp(CLOZE_PATTERN.source, 'g');
}

/**
 * Work out how a card presents itself.
 *
 * The card's own `presentation` wins; without one the note's shape decides, in
 * the same order Anki does it:
 *
 * - a single field holding {{c1::…}} markers is a cloze card;
 * - a note with two or more fields is a flip card, and its cards alternate
 *   direction by ordinal (ord 0 asks front to back, ord 1 asks back to front) —
 *   which is what makes a two-card note a *flip matrix* rather than two copies
 *   of the same question;
 * - anything else is a plain flip card from field 1 to field 2.
 */
export function resolvePresentation(note: AnkiNote, card: AnkiCard): CardView {
    const presentation = card.presentation;
    const values = note.values;

    if (presentation?.mode === 'mcq') {
        return {
            mode: 'mcq',
            front: values[0] ?? '',
            back: values[1] ?? '',
            answerText: values[1] ?? '',
            choices: presentation.choices ?? [],
            answerIndex: presentation.answer ?? -1,
            accept: [],
            caseInsensitive: false,
            ignoreDiacritics: false,
            clozeOrdinal: 0,
            tags: note.tags,
        };
    }

    if (presentation?.mode === 'type') {
        return {
            mode: 'type',
            front: values[0] ?? '',
            back: values[1] ?? '',
            answerText: values[1] ?? '',
            choices: [],
            answerIndex: -1,
            accept: presentation.accept ?? [],
            caseInsensitive: presentation.caseInsensitive === true,
            ignoreDiacritics: presentation.ignoreDiacritics === true,
            clozeOrdinal: 0,
            tags: note.tags,
        };
    }

    if (presentation?.mode === 'cloze' || (presentation === undefined && isClozeNote(note))) {
        // A hand-written cloze card usually carries no mode: the markers in the
        // text are the declaration, and the card's ordinal is which deletion it
        // asks about (ord 0 asks about {{c1::…}}).
        const ordinal = Math.max(1, card.ord + 1);
        const text = values[0] ?? '';
        // A cloze note from a real deck usually has an "Extra" field beside its
        // text; Anki's own cloze template shows it under the answer, so the back
        // carries it too. The front stays the cloze text alone.
        const extra = values.slice(1).map(value => value.trim()).filter(value => value.length > 0);
        return {
            mode: 'cloze',
            front: blankCloze(text, ordinal),
            back: [revealCloze(text, ordinal), ...extra].join('\n\n'),
            answerText: clozeAnswerText(text, ordinal),
            choices: [],
            answerIndex: -1,
            accept: presentation?.accept ?? [],
            caseInsensitive: presentation?.caseInsensitive === true,
            ignoreDiacritics: presentation?.ignoreDiacritics === true,
            clozeOrdinal: ordinal,
            tags: note.tags,
        };
    }

    // Flip: field against field. A two-field note reverses on the odd ordinals,
    // which is what an Anki "and reversed card" note does.
    const fields = values.length >= 2 ? values : [...values, ''];
    const reversed = card.ord % 2 === 1;
    return {
        mode: 'flip',
        front: (reversed ? fields[1] : fields[0]) ?? '',
        back: (reversed ? fields[0] : fields[1]) ?? '',
        answerText: (reversed ? fields[0] : fields[1]) ?? '',
        choices: [],
        answerIndex: -1,
        accept: [],
        caseInsensitive: false,
        ignoreDiacritics: false,
        clozeOrdinal: 0,
        tags: note.tags,
    };
}

/**
 * True when a note is a cloze note: any of its text carries {{c1::…}} markers.
 *
 * Anki decides this from the notetype, which a hand-written deck file does not
 * have — so the markers themselves are the declaration. A note whose *other*
 * field merely mentions a marker is read the same way, because the alternative
 * is showing a reader their own cloze syntax as literal text.
 */
export function isClozeNote(note: AnkiNote): boolean {
    return note.values.some(value => clozeOrdinals(value).length > 0);
}

/** Every deletion in a cloze text, in the order they appear. */
export function clozeOrdinals(text: string): number[] {
    const ordinals = new Set<number>();
    const pattern = clozeMatcher();
    let match = pattern.exec(text);
    while (match) {
        ordinals.add(Number(match[1]));
        match = pattern.exec(text);
    }
    return [...ordinals].sort((a, b) => a - b);
}

/**
 * A cloze text as the question side shows it: this card's deletion becomes a
 * blank (with its hint, if one was written), and every other deletion stays as
 * plain text — exactly how Anki presents one cloze card.
 */
export function blankCloze(text: string, ordinal: number): string {
    return text.replace(clozeMatcher(), (whole, number: string, content: string, hint?: string) => {
        if (Number(number) !== ordinal) return content;
        return hint ? `[${hint}]` : '[...]';
    });
}

/** A cloze text as the answer side shows it: this card's deletion highlighted. */
export function revealCloze(text: string, ordinal: number): string {
    return text.replace(clozeMatcher(), (whole, number: string, content: string) => {
        if (Number(number) !== ordinal) return content;
        return `**${content}**`;
    });
}

/**
 * The answer text for a cloze card, which is what typing is compared against:
 * the text with every marker replaced by its content and the deletions that are
 * asked for joined by commas, as Anki accepts them.
 */
export function clozeAnswerText(text: string, ordinal: number): string {
    const asked: string[] = [];
    text.replace(clozeMatcher(), (whole, number: string, content: string) => {
        if (Number(number) === ordinal) asked.push(content);
        return whole;
    });
    return asked.join(', ');
}

// ----------------------------------------------------------------- comparison

/** Whitespace and markup that must not decide whether an answer is right. */
function normalized(text: string, ignoreDiacritics: boolean): string {
    let out = text
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/?(?:div|p|span|b|i|u|em|strong|sub|sup|font)[^>]*>/gi, '')
        .replace(/\[sound:[^\]]*\]/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
    if (ignoreDiacritics) out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return out;
}

export interface TypedAnswerRules {
    caseInsensitive: boolean;
    ignoreDiacritics: boolean;
    /** Other spellings that count as right. */
    accept: string[];
}

/**
 * Compare a typed answer, the way Anki's own comparison works: exact, unless
 * the card asked otherwise (`ci:` for case, `nc:` for accents). Leading and
 * trailing space, line breaks and markup never count against the reader, and a
 * cloze card accepts its several answers separated by commas.
 */
export function compareTypedAnswer(typed: string, view: CardView, extraAnswers: string[] = []): boolean {
    const rules: TypedAnswerRules = {
        caseInsensitive: view.caseInsensitive,
        ignoreDiacritics: view.ignoreDiacritics,
        accept: view.accept,
    };
    return compareAnswer(typed, [...extraAnswers, view.answerText, ...rules.accept], rules);
}

export function compareAnswer(typed: string, expected: string[], rules: TypedAnswerRules): boolean {
    const normalize = (text: string): string => {
        const value = normalized(text, rules.ignoreDiacritics);
        return rules.caseInsensitive ? value.toLocaleLowerCase() : value;
    };
    const given = normalize(typed);
    if (given === '') return false;

    const sortedParts = (text: string): string =>
        text.split(',').map(part => normalize(part)).filter(part => part !== '').sort().join('\u0000');

    return expected.some(candidate => {
        if (normalize(candidate) === given) return true;
        // A cloze card asking about several deletions accepts them in any order,
        // separated by commas (Anki's own multi-section cloze typing).
        const wanted = sortedParts(candidate);
        return wanted.includes('\u0000') && wanted === sortedParts(given);
    });
}

/** How a multiple-choice answer is judged. */
export function judgeChoice(view: CardView, choiceIndex: number): 'correct' | 'wrong' | 'unknown' {
    if (view.answerIndex < 0) return 'unknown';
    return choiceIndex === view.answerIndex ? 'correct' : 'wrong';
}

/** The label the runner shows for a mode, in sentence case. */
export function modeLabel(mode: CardPresentationMode): string {
    switch (mode) {
        case 'mcq':
            return 'Multiple choice';
        case 'type':
            return 'Typed answer';
        case 'cloze':
            return 'Cloze';
        default:
            return 'Flip';
    }
}

/** The presentation a card should carry to be asked as a specific mode. */
export function presentationFor(mode: CardPresentationMode, extra: Partial<CardPresentation> = {}): CardPresentation {
    return { mode, ...extra };
}
