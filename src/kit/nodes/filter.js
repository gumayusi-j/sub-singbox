// Node-name filtering: keep or drop nodes by name.
//
// Ported from Tower's NodeNameFilterDraft. The design worth carrying over is
// that the persisted form is always a single regular expression - the
// keyword/style/case controls are a *view* onto it, and switching to the raw
// regex editor is a one-way door for anything the keyword form cannot express.
//
//   serializeFilter(parseFilterPattern(p)) === p   for any p we accept
//
// The one place this port departs from the original: NSRegularExpression
// accepts inline `(?i)` / `(?-i)` flags and JavaScript's RegExp does not - it
// throws on them. They are stripped at the boundary and re-emitted on the way
// back, so a pattern written for Tower still compiles here.
//
// Matching is unanchored, and each node is tried under both its display name
// and its raw name: a pattern naming a region should match either.

// The keyword escape set, deliberately unchanged from the original. `-` and
// `#` are absent because encode and decode have to agree on exactly one set,
// and those two are harmless outside a character class.
const REGEX_SPECIALS = new Set("\\^$.*+?()[]{}|".split(""));

// Escapes the decode pass is willing to undo. A pattern using any other
// identity escape is left as a raw regular expression rather than being
// silently misread as a keyword.
const DECODABLE_ESCAPES = new Set(". * + ? ( ) [ ] { } ^ $ | # -".split(" "));

export const MATCH_STYLES = ["contains", "prefix", "suffix", "exact"];

export const DEFAULT_TIMEOUT_MS = 1000;

// A single match cannot be interrupted - JavaScript offers no way to abort a
// backtracking run - so the only bound available inside one candidate is its
// length. Real node names are a few dozen characters; this is far above that
// and far below anything that could stall.
const MAX_CANDIDATE_LENGTH = 200;

const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : () => Date.now();

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

export function emptyDraft(options) {
    options = options || {};
    return {
        keywords: "",
        style: "contains",
        ignoresCase: options.caseInsensitive !== false,
        usesRegex: false,
        regex: "",
    };
}

function splitKeywords(keywords) {
    return String(keywords == null ? "" : keywords)
        .split(/\r?\n/)
        .map((word) => word.trim())
        .filter((word) => word !== "");
}

function escapeKeyword(word) {
    let out = "";
    for (const ch of word) out += REGEX_SPECIALS.has(ch) ? "\\" + ch : ch;
    return out;
}

// Draft -> the expression that gets stored.
//
// Several keywords are alternatives (any one of them matching is enough), and
// the anchor wraps the whole group rather than each alternative - `^a|b$`
// would anchor only the first and last branches.
export function serializeFilter(draft) {
    if (!isPlainObject(draft)) return "";
    if (draft.usesRegex) return typeof draft.regex === "string" ? draft.regex : "";

    const words = splitKeywords(draft.keywords);
    if (words.length === 0) return "";

    const flags = draft.ignoresCase === false ? "(?-i)" : "(?i)";
    const style = MATCH_STYLES.indexOf(draft.style) === -1 ? "contains" : draft.style;
    const prefix = style === "prefix" || style === "exact" ? "^" : "";
    const suffix = style === "suffix" || style === "exact" ? "$" : "";
    return flags + prefix + "(?:" + words.map(escapeKeyword).join("|") + ")" + suffix;
}

// Split off a leading inline case flag. Returns null for `ignoresCase` when
// the pattern says nothing about it, so the caller's default applies.
function stripInlineFlags(text) {
    if (text.startsWith("(?i)")) return { source: text.slice(4), ignoresCase: true };
    if (text.startsWith("(?-i)")) return { source: text.slice(5), ignoresCase: false };
    return { source: text, ignoresCase: null };
}

// Expression -> Draft, or null when the expression is more than the keyword
// form can say. Null is the honest answer for anything with a construct the
// round trip would flatten: the caller keeps it as a raw regular expression
// rather than being shown a keyword list that no longer means the same thing.
export function parseFilterPattern(pattern, caseInsensitiveDefault) {
    const text = String(pattern == null ? "" : pattern);
    if (text === "" || /[\r\n]/.test(text)) return null;

    const stripped = stripInlineFlags(text);
    const ignoresCase =
        stripped.ignoresCase === null ? caseInsensitiveDefault !== false : stripped.ignoresCase;

    let body = stripped.source;
    let anchoredStart = false;
    let anchoredEnd = false;
    if (body.startsWith("^")) {
        anchoredStart = true;
        body = body.slice(1);
    }
    if (body.endsWith("$") && !body.endsWith("\\$")) {
        anchoredEnd = true;
        body = body.slice(0, -1);
    }

    const wrapped = /^\(\?:(.*)\)$/.exec(body) || /^\((.*)\)$/.exec(body);
    if (wrapped) body = wrapped[1];

    // An anchor over an unwrapped alternation binds to the outermost branches
    // only, so `^HK|JP$` is not the same expression as `^(?:HK|JP)$` and
    // cannot be shown as one.
    if (
        (anchoredStart || anchoredEnd) &&
        body.includes("|") &&
        !stripped.source.includes("(?:")
    ) {
        return null;
    }

    const words = [];
    let word = "";
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === "\\") {
            const next = body[i + 1];
            if (next === undefined || !DECODABLE_ESCAPES.has(next)) return null;
            word += next;
            i += 1;
            continue;
        }
        if (ch === "|") {
            if (word === "") return null;
            words.push(word);
            word = "";
            continue;
        }
        if (REGEX_SPECIALS.has(ch)) return null;
        word += ch;
    }
    if (word === "") return null;
    words.push(word);

    for (const value of words) {
        // Trimming here would silently turn a literal that happens to end in a
        // space into a different literal.
        if (value !== value.trim()) return null;
    }

    const style =
        anchoredStart && anchoredEnd
            ? "exact"
            : anchoredStart
              ? "prefix"
              : anchoredEnd
                ? "suffix"
                : "contains";

    return {
        keywords: words.join("\n"),
        style,
        ignoresCase,
        usesRegex: false,
        regex: text,
    };
}

// Nested quantifiers are the shape that backtracks exponentially: a group that
// already contains a repetition, repeated again. `(ab)*` is fine and passes;
// `(a+)+` does not. Rejecting a few linear patterns along with the bad ones is
// the right side to err on, because the alternative is a request that never
// returns.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)\s*(?:[*+]|\{\d+,\})/;

export function compileFilter(pattern, caseInsensitive) {
    const text = String(pattern == null ? "" : pattern).trim();
    if (text === "") return { error: "筛选表达式不能为空" };
    if (text.length > 1000) return { error: "筛选表达式过长" };
    if (/[\r\n]/.test(text)) return { error: "筛选表达式不能包含换行" };

    const stripped = stripInlineFlags(text);
    const source = stripped.source;
    const wantsCase =
        stripped.ignoresCase === null ? caseInsensitive !== false : stripped.ignoresCase;

    if (NESTED_QUANTIFIER.test(source)) {
        return {
            error: "筛选表达式存在嵌套量词（如 (a+)+），可能造成灾难性回溯，请改写",
        };
    }

    // No `u` flag on purpose: node names are plain text, and `u` turns
    // identity escapes that people write by habit - `\-` outside a class, for
    // one - into syntax errors.
    try {
        return { re: new RegExp(source, wantsCase ? "i" : "") };
    } catch (e) {
        return { error: "筛选表达式无效：" + (e && e.message ? e.message : e) };
    }
}

function matches(re, candidate) {
    if (typeof candidate !== "string" || candidate === "") return false;
    const subject =
        candidate.length > MAX_CANDIDATE_LENGTH
            ? candidate.slice(0, MAX_CANDIDATE_LENGTH)
            : candidate;
    return re.test(subject);
}

// Apply a pattern to a list of node names.
//
// Each entry is either a name or a list of names to try in turn - the render
// path passes the display name and the raw name together, and matching either
// counts.
//
// Returns `{ names, error }`. An empty `names` alongside a non-null `error`
// means "we could not tell you", which is a different answer from "nothing
// matched" and must not be presented as one.
export function filterNodeNames(names, pattern, options) {
    options = options || {};
    const list = Array.isArray(names) ? names : [];
    const text = pattern == null ? "" : String(pattern).trim();
    if (text === "") return { names: list.slice(), error: null };

    const compiled = compileFilter(text, options.caseInsensitive !== false);
    if (compiled.error) return { names: [], error: compiled.error };

    const budget = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const deadline = now() + budget;
    const out = [];
    for (const entry of list) {
        if (now() > deadline) {
            return { names: [], error: "筛选表达式匹配超时，请简化表达式" };
        }
        const candidates = Array.isArray(entry) ? entry : [entry];
        for (const candidate of candidates) {
            if (matches(compiled.re, candidate)) {
                // The entry comes back whole, not the candidate that matched:
                // a caller pairing a node with its names wants the node.
                out.push(entry);
                break;
            }
        }
    }
    return { names: out, error: null };
}

// The stored shape. A null or empty pattern means "no filter", which is
// distinct from a pattern that matches nothing.
export function normalizeNodeFilter(raw) {
    if (!isPlainObject(raw)) return null;
    const pattern = typeof raw.pattern === "string" ? raw.pattern.trim() : "";
    if (pattern === "") return null;
    return {
        pattern,
        caseInsensitive: raw.caseInsensitive !== false,
    };
}

export default {
    serializeFilter,
    parseFilterPattern,
    compileFilter,
    filterNodeNames,
    normalizeNodeFilter,
    emptyDraft,
    MATCH_STYLES,
    DEFAULT_TIMEOUT_MS,
};
