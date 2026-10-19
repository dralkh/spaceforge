/**
 * Spaceforge Study — the arithmetic a lab's answers are written in.
 *
 * A lab's outputs are expressions a model produced, so they are evaluated here
 * rather than handed to the host: no `eval`, no `new Function`, no property
 * access — a tokenizer, a small recursive-descent parser, and an evaluator over
 * that tree. Nothing in this file can reach outside its own numbers.
 *
 * The contract is that it never throws and never leaks a non-answer: anything
 * it cannot read (an unknown identifier, an unbalanced parenthesis, a stray
 * character, empty input) parses to `null`, and anything it cannot compute
 * (division by zero, `ln(0)`, `sqrt(-1)`, an overflow to `Infinity`) evaluates
 * to `null`. An unreadable expression is a question the lab honestly says it
 * cannot answer, never `NaN` in a panel and never a crash.
 *
 * Grammar, whitespace ignored:
 *
 *     sum     := product (('+' | '-') product)*
 *     product := unary (('*' | '/') unary)*
 *     unary   := ('-' | '+') unary | power
 *     power   := primary ('^' unary)?      — right associative
 *     primary := number | name | call | '(' sum ')'
 *
 * Precedence falls out of that shape, including the trap: `-2^2` is
 * `-(2^2)` = -4, `2^3^2` is `2^(3^2)` = 512, and `2^-1` is a legal exponent.
 */

/** Every operator the grammar understands. */
export type ExpressionOperator = '+' | '-' | '*' | '/' | '^';

/** A parsed expression. Plain data, so a test can read the tree it parsed. */
export type ExpressionNode =
    | { kind: 'number'; value: number }
    | { kind: 'name'; name: string }
    | { kind: 'negate'; operand: ExpressionNode }
    | { kind: 'binary'; operator: ExpressionOperator; left: ExpressionNode; right: ExpressionNode }
    | { kind: 'call'; name: string; args: ExpressionNode[] };

/** The constants an expression may name. They win over a variable of the same name. */
export const EXPRESSION_CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E };

/**
 * The functions an expression may call, with the argument counts each accepts.
 * `min`/`max` take a list; the rest take exactly one number.
 */
const FUNCTION_ARITY: Record<string, { min: number; max: number }> = {
    min: { min: 1, max: 8 },
    max: { min: 1, max: 8 },
    abs: { min: 1, max: 1 },
    round: { min: 1, max: 1 },
    sqrt: { min: 1, max: 1 },
    ln: { min: 1, max: 1 },
    log10: { min: 1, max: 1 },
    exp: { min: 1, max: 1 },
};

/** The callable names, for docs and for tests that pin the vocabulary. */
export const EXPRESSION_FUNCTIONS: readonly string[] = Object.keys(FUNCTION_ARITY);

/** An expression longer than this is refused rather than parsed. */
const MAX_LENGTH = 400;
/** Token and nesting ceilings: a pathological string fails cleanly. */
const MAX_TOKENS = 256;
const MAX_DEPTH = 64;

const OPERATORS = '+-*/^';

// ------------------------------------------------------------------ scanning

interface ExpressionToken {
    kind: 'number' | 'name' | 'operator' | 'paren' | 'comma';
    text: string;
}

function isDigit(character: string): boolean {
    return character >= '0' && character <= '9';
}

function isNameStart(character: string): boolean {
    return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || character === '_';
}

function isNamePart(character: string): boolean {
    return isNameStart(character) || isDigit(character);
}

function isSpace(character: string): boolean {
    return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

/**
 * The whole string as tokens, or null the moment a character makes no sense.
 * A number is one number — `1.2.3` scans as one token and then fails as a
 * number, which is the honest reading of it.
 */
function tokenize(text: string): ExpressionToken[] | null {
    const tokens: ExpressionToken[] = [];
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (isSpace(character)) {
            index += 1;
            continue;
        }
        if (isDigit(character) || (character === '.' && isDigit(text[index + 1] ?? ''))) {
            let end = index;
            while (end < text.length && (isDigit(text[end]) || text[end] === '.')) end += 1;
            // Scientific notation, but only when the exponent is really one:
            // in `2e` the `e` is the constant, not an exponent marker.
            if (end < text.length && (text[end] === 'e' || text[end] === 'E')) {
                let probe = end + 1;
                if (text[probe] === '+' || text[probe] === '-') probe += 1;
                if (isDigit(text[probe] ?? '')) {
                    while (probe < text.length && isDigit(text[probe])) probe += 1;
                    end = probe;
                }
            }
            const raw = text.slice(index, end);
            if (!Number.isFinite(Number(raw))) return null;
            tokens.push({ kind: 'number', text: raw });
            index = end;
            continue;
        }
        if (isNameStart(character)) {
            let end = index;
            while (end < text.length && isNamePart(text[end])) end += 1;
            tokens.push({ kind: 'name', text: text.slice(index, end) });
            index = end;
            continue;
        }
        if (OPERATORS.indexOf(character) >= 0) {
            tokens.push({ kind: 'operator', text: character });
            index += 1;
            continue;
        }
        if (character === '(' || character === ')') {
            tokens.push({ kind: 'paren', text: character });
            index += 1;
            continue;
        }
        if (character === ',') {
            tokens.push({ kind: 'comma', text: character });
            index += 1;
            continue;
        }
        return null;
    }
    if (tokens.length === 0 || tokens.length > MAX_TOKENS) return null;
    return tokens;
}

// ------------------------------------------------------------------- parsing

interface Cursor {
    tokens: ExpressionToken[];
    index: number;
}

function peek(cursor: Cursor): ExpressionToken | null {
    return typeof cursor.tokens[cursor.index] === 'undefined' ? null : cursor.tokens[cursor.index];
}

function functionArityOk(name: string, count: number): boolean {
    const arity = FUNCTION_ARITY[name];
    if (!arity) return false;
    return count >= arity.min && count <= arity.max;
}

function parseSum(cursor: Cursor, depth: number): ExpressionNode | null {
    if (depth > MAX_DEPTH) return null;
    let left = parseProduct(cursor, depth + 1);
    if (!left) return null;
    for (;;) {
        const token = peek(cursor);
        if (!token || token.kind !== 'operator' || (token.text !== '+' && token.text !== '-')) return left;
        const operator: ExpressionOperator = token.text === '-' ? '-' : '+';
        cursor.index += 1;
        const right = parseProduct(cursor, depth + 1);
        if (!right) return null;
        left = { kind: 'binary', operator, left, right };
    }
}

function parseProduct(cursor: Cursor, depth: number): ExpressionNode | null {
    if (depth > MAX_DEPTH) return null;
    let left = parseUnary(cursor, depth + 1);
    if (!left) return null;
    for (;;) {
        const token = peek(cursor);
        if (!token || token.kind !== 'operator' || (token.text !== '*' && token.text !== '/')) return left;
        const operator: ExpressionOperator = token.text === '/' ? '/' : '*';
        cursor.index += 1;
        const right = parseUnary(cursor, depth + 1);
        if (!right) return null;
        left = { kind: 'binary', operator, left, right };
    }
}

/**
 * A leading sign binds looser than the power above it — so `-2^2` is -(2^2) —
 * and tighter than the product, so `-3*2` is -6 rather than an error.
 */
function parseUnary(cursor: Cursor, depth: number): ExpressionNode | null {
    if (depth > MAX_DEPTH) return null;
    const token = peek(cursor);
    if (token && token.kind === 'operator' && (token.text === '-' || token.text === '+')) {
        cursor.index += 1;
        const operand = parseUnary(cursor, depth + 1);
        if (!operand) return null;
        return token.text === '-' ? { kind: 'negate', operand } : operand;
    }
    return parsePower(cursor, depth + 1);
}

/** Right associative, and its exponent may carry its own sign: `2^-1`. */
function parsePower(cursor: Cursor, depth: number): ExpressionNode | null {
    if (depth > MAX_DEPTH) return null;
    const base = parsePrimary(cursor, depth + 1);
    if (!base) return null;
    const token = peek(cursor);
    if (!token || token.kind !== 'operator' || token.text !== '^') return base;
    cursor.index += 1;
    const exponent = parseUnary(cursor, depth + 1);
    if (!exponent) return null;
    return { kind: 'binary', operator: '^', left: base, right: exponent };
}

function parseArguments(cursor: Cursor, depth: number): ExpressionNode[] | null {
    const args: ExpressionNode[] = [];
    const first = peek(cursor);
    if (first && first.kind === 'paren' && first.text === ')') {
        cursor.index += 1;
        return args;
    }
    for (;;) {
        const arg = parseSum(cursor, depth + 1);
        if (!arg) return null;
        args.push(arg);
        const separator = peek(cursor);
        if (separator && separator.kind === 'comma') {
            cursor.index += 1;
            continue;
        }
        if (separator && separator.kind === 'paren' && separator.text === ')') {
            cursor.index += 1;
            return args;
        }
        return null;
    }
}

function parsePrimary(cursor: Cursor, depth: number): ExpressionNode | null {
    if (depth > MAX_DEPTH) return null;
    const token = peek(cursor);
    if (!token) return null;

    if (token.kind === 'number') {
        cursor.index += 1;
        const value = Number(token.text);
        return Number.isFinite(value) ? { kind: 'number', value } : null;
    }

    if (token.kind === 'name') {
        cursor.index += 1;
        const next = peek(cursor);
        if (next && next.kind === 'paren' && next.text === '(') {
            cursor.index += 1;
            const args = parseArguments(cursor, depth + 1);
            // A call to a name that is not a function, or with the wrong number
            // of arguments, can never compute: it is refused here, not at run time.
            if (!args || !functionArityOk(token.text, args.length)) return null;
            return { kind: 'call', name: token.text, args };
        }
        return { kind: 'name', name: token.text };
    }

    if (token.kind === 'paren' && token.text === '(') {
        cursor.index += 1;
        const inner = parseSum(cursor, depth + 1);
        if (!inner) return null;
        const close = peek(cursor);
        if (!close || close.kind !== 'paren' || close.text !== ')') return null;
        cursor.index += 1;
        return inner;
    }

    return null;
}

/**
 * Parse an expression to its tree, or null when the text cannot be read.
 *
 * An identifier parses: whether it means anything is decided at evaluation,
 * because a lab's parameter names are not known here. A call whose name is not
 * one of `EXPRESSION_FUNCTIONS`, or whose argument count is wrong, does not
 * parse — it could never compute.
 */
export function parseExpression(expression: string): ExpressionNode | null {
    try {
        if (typeof expression !== 'string') return null;
        const text = expression.trim();
        if (!text || text.length > MAX_LENGTH) return null;
        const tokens = tokenize(text);
        if (!tokens) return null;
        const cursor: Cursor = { tokens, index: 0 };
        const node = parseSum(cursor, 0);
        // Trailing tokens are not an expression: `1+2 3` is refused whole.
        if (!node || cursor.index !== tokens.length) return null;
        return node;
    } catch (_error) {
        return null;
    }
}

// ---------------------------------------------------------------- evaluation

function applyFunction(name: string, args: number[]): number | null {
    const first = args[0];
    switch (name) {
        case 'min':
            return args.reduce((lowest, value) => (value < lowest ? value : lowest), first);
        case 'max':
            return args.reduce((highest, value) => (value > highest ? value : highest), first);
        case 'abs':
            return Math.abs(first);
        case 'round':
            return Math.round(first);
        case 'sqrt':
            return first < 0 ? null : Math.sqrt(first);
        case 'ln':
            return first <= 0 ? null : Math.log(first);
        case 'log10':
            return first <= 0 ? null : Math.log10(first);
        case 'exp': {
            const value = Math.exp(first);
            return Number.isFinite(value) ? value : null;
        }
        default:
            return null;
    }
}

function valueOf(node: ExpressionNode, variables: Record<string, number>, depth: number): number | null {
    if (depth > MAX_DEPTH) return null;
    switch (node.kind) {
        case 'number':
            return node.value;
        case 'name': {
            if (Object.prototype.hasOwnProperty.call(EXPRESSION_CONSTANTS, node.name)) return EXPRESSION_CONSTANTS[node.name];
            const variable = variables[node.name];
            return typeof variable === 'number' && Number.isFinite(variable) ? variable : null;
        }
        case 'negate': {
            const operand = valueOf(node.operand, variables, depth + 1);
            return operand === null ? null : -operand;
        }
        case 'binary': {
            const left = valueOf(node.left, variables, depth + 1);
            if (left === null) return null;
            const right = valueOf(node.right, variables, depth + 1);
            if (right === null) return null;
            switch (node.operator) {
                case '+':
                    return left + right;
                case '-':
                    return left - right;
                case '*':
                    return left * right;
                // Division by zero is not a number to show: it is a question
                // the lab cannot answer.
                case '/':
                    return right === 0 ? null : left / right;
                case '^': {
                    const powered = Math.pow(left, right);
                    return Number.isFinite(powered) ? powered : null;
                }
            }
            return null;
        }
        case 'call': {
            const args: number[] = [];
            for (const arg of node.args) {
                const value = valueOf(arg, variables, depth + 1);
                if (value === null) return null;
                args.push(value);
            }
            return applyFunction(node.name, args);
        }
        default:
            return null;
    }
}

/**
 * Evaluate a parsed tree against the parameter values.
 *
 * Null means "no answer": an unknown identifier (neither constant nor
 * variable), an argument that did not compute, or a result that is not a finite
 * number. `-0` is normalised to `0` so a readout never shows `-0`.
 */
export function evaluateNode(node: ExpressionNode, variables: Record<string, number> = {}): number | null {
    try {
        if (!node || typeof node !== 'object') return null;
        const scope = variables && typeof variables === 'object' ? variables : {};
        const value = valueOf(node, scope, 0);
        if (value === null || !Number.isFinite(value)) return null;
        return value === 0 ? 0 : value;
    } catch (_error) {
        return null;
    }
}

/**
 * The one call the lab makes: expression text plus the current parameter
 * values, in — a finite number or null, out. Never throws.
 */
export function evaluateExpression(expression: string, variables: Record<string, number> = {}): number | null {
    const node = parseExpression(expression);
    if (!node) return null;
    return evaluateNode(node, variables);
}

// ---------------------------------------------------------------- formatting

/**
 * A number as a reader should see it: the shortest honest rendering, rounded to
 * `decimals` places, with no `-0` and no floating-point dust (`0.30000000004`
 * reads as `0.3`). A value that would round away to nothing is shown in
 * exponential form rather than as a plain `0`, which would be a lie.
 */
export function formatNumber(value: number, decimals = 3): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    const places = Math.max(0, Math.min(6, Math.floor(decimals)));
    const rounded = Number(value.toFixed(places));
    if (rounded === 0 && value !== 0) return value.toExponential(2);
    return String(rounded === 0 ? 0 : rounded);
}
