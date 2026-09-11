// Routing-rule syntax: the text layer every rule source is parsed through.
//
// Ported from Tower's RoutingRuleSyntax.swift. The thing worth understanding
// before reading further is that a rule line is NOT a comma-separated list.
// It is a CSV record whose fields may themselves contain commas (inside
// quotes, or inside the parentheses of a logical rule), followed by a policy
// word. Splitting on "," loses the policy the moment a value contains one:
//
//   DOMAIN,example.com,My=Group   ->   fields ["DOMAIN", "example.com"]
//
// which then reads the *value* as the policy. That was the bug worth fixing,
// and it is why the splitter below tracks quote and paren state instead.
//
// The policy slot is fixed, never inferred by scanning from the right for
// something that looks like an option: `My=Group` is a perfectly legal policy
// name, and any "strip trailing key=value" rule eats it.

// A single rule line longer than this is refused outright. The bundled .list
// snapshots top out around 200 bytes, so this only ever catches a caller
// handing us a whole file where one line was expected.
export const MAX_FIELD_BYTES = 131072;
export const MAX_PAREN_DEPTH = 64;
export const MAX_CONDITION_DEPTH = 10;

export const LOGICAL_TYPES = new Set(["AND", "OR", "NOT"]);

// Option words that belong to the *condition* rather than naming a policy.
// This is the one place the fixed policy slot yields, and only for a closed
// vocabulary: `.list` files carry `TYPE,CONTENT,no-resolve` with no policy
// column at all, so pasting one into the import box would otherwise route
// every rule to an outbound literally named "no-resolve". Anything else in
// slot 2 - including `My=Group` - is a policy, which is the whole point.
const OPTION_WORDS = new Set([
    "no-resolve",
    "src",
    "no-track",
    "dns-failed",
    "pre-matching",
    "extended-matching",
    "always-capture",
]);

function isOptionToken(token) {
    const value = String(token == null ? "" : token).toLowerCase();
    if (OPTION_WORDS.has(value)) return true;
    return /^update-interval=/i.test(value) || /^notification-(text|interval)=/i.test(value);
}

// Split a rule body into its top-level fields. Commas separate fields only at
// paren depth 0 and outside quotes; a backslash escapes the next character
// but is itself kept, so a value round-trips unchanged.
//
// Returns null - never throws - for input this parser cannot make sense of.
// Callers work through thousands of lines at a time and need to skip the odd
// malformed one rather than abandon the whole list.
export function splitFields(text) {
    if (typeof text !== "string") return null;
    if (Buffer.byteLength(text, "utf8") > MAX_FIELD_BYTES) return null;
    // A caller that forgot to split its input first gets nothing, rather than
    // a field list spanning newlines that no rule could have meant.
    if (text.includes("\n") || text.includes("\r")) return null;

    const out = [];
    let field = "";
    let quote = null;
    let escaped = false;
    let depth = 0;

    for (const ch of text) {
        if (escaped) {
            field += ch;
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            field += ch;
            escaped = true;
            continue;
        }
        if (quote !== null) {
            field += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            field += ch;
            continue;
        }
        if (ch === "(") {
            depth += 1;
            if (depth > MAX_PAREN_DEPTH) return null;
        } else if (ch === ")") {
            depth -= 1;
            if (depth < 0) return null;
        } else if (ch === "," && depth === 0) {
            out.push(field.trim());
            field = "";
            continue;
        }
        field += ch;
    }

    if (quote !== null || depth !== 0) return null;
    out.push(field.trim());
    return out;
}

// Strip one matching pair of surrounding quotes. Only fires when the first and
// last characters are the same quote, so an apostrophe mid-value is left alone.
export function unquote(text) {
    const value = String(text == null ? "" : text);
    if (value.length >= 2) {
        const first = value[0];
        if ((first === '"' || first === "'") && value[value.length - 1] === first) {
            return value.slice(1, -1);
        }
    }
    return value;
}

// A quote only opens where a value could plausibly start, so the apostrophe in
// "Alice's nodes" does not swallow the rest of the line - including any
// trailing comment, which would then survive into the field list.
function opensQuote(line, index) {
    if (index === 0) return true;
    const before = line[index - 1];
    return /\s/.test(before) || "[{,:-'\"".includes(before);
}

// Drop a trailing comment. `#`, `;` and `//` introduce one only at the start
// of the line or after whitespace - which is what keeps `https://dns.google`
// and a regex containing `//` intact, since their `//` follows a non-space.
export function removingComment(line) {
    if (typeof line !== "string") return "";
    let quote = null;
    let escaped = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        if (quote !== null) {
            if (ch === quote) quote = null;
            continue;
        }
        if ((ch === '"' || ch === "'") && opensQuote(line, i)) {
            quote = ch;
            continue;
        }
        if (i !== 0 && !/\s/.test(line[i - 1])) continue;
        if (ch === "#" || ch === ";") return line.slice(0, i).trimEnd();
        if (ch === "/" && line[i + 1] === "/") return line.slice(0, i).trimEnd();
    }
    return line;
}

const COMPARATORS = [">=", "<=", ">", "<"];

// One port token -> "low-high", or null when it cannot be a port at all.
function portRange(token) {
    for (const op of COMPARATORS) {
        if (!token.startsWith(op)) continue;
        const digits = token.slice(op.length);
        if (!/^\d+$/.test(digits)) return null;
        const port = Number(digits);
        if (port > 65535) return null;
        // `>=100` includes 100; `>100` starts at 101. Same idea for `<`.
        const low = op.startsWith(">") ? port + (op === ">" ? 1 : 0) : 0;
        const high = op.startsWith("<") ? port - (op === "<" ? 1 : 0) : 65535;
        if (low > high) return null;
        return low + "-" + high;
    }
    const dash = token.indexOf("-");
    if (dash >= 0) {
        const low = token.slice(0, dash);
        const high = token.slice(dash + 1);
        if (!/^\d+$/.test(low) || !/^\d+$/.test(high)) return null;
        const from = Number(low);
        const to = Number(high);
        if (to > 65535 || from > to) return null;
        return from + "-" + to;
    }
    if (!/^\d+$/.test(token)) return null;
    const port = Number(token);
    if (port > 65535) return null;
    return String(port);
}

// Normalise the port operand of DST-PORT / SRC-PORT into sing-box's
// "low-high" shape: `80`, `8000-8100`, `>=100`, `<=100`, `>100`, `<100`, and
// `/`-separated combinations of those. Returns null if any one item is not a
// port, so a typo drops the rule rather than half-applying it.
export function portRanges(text) {
    const raw = String(text == null ? "" : text).trim();
    if (raw === "") return null;
    const out = [];
    for (const item of raw.split("/")) {
        const token = item.trim();
        if (token === "") return null;
        const range = portRange(token);
        if (range === null) return null;
        out.push(range);
    }
    return out;
}

// Parse a condition body into a tree.
//
//   leaf     { type: "DOMAIN-SUFFIX", content: "example.com", options: [] }
//   logical  { type: "AND", options: [], children: [leaf, ...] }
//
// A logical node's payload is one parenthesised group per branch, each of
// which must itself parse. Any branch that cannot be expressed fails the
// *whole* rule: dropping an unrepresentable branch from `AND` would widen the
// rule, turning a narrow REJECT into a broad one. NOT takes exactly one
// branch, since "not any of these" is just OR with inverted polarity and
// sing-box spells that differently.
export function condition(body, depth) {
    const level = depth || 0;
    if (level > MAX_CONDITION_DEPTH) return null;

    const parts = splitFields(body);
    if (!parts || parts.length < 2) return null;
    if (parts[1] === "") return null;

    const type = String(parts[0]).toUpperCase();
    if (type === "" || type === "FINAL" || type === "MATCH") return null;

    const options = parts.slice(2);
    const payload = parts[1];

    if (!LOGICAL_TYPES.has(type)) {
        return { type, content: unquote(payload), options };
    }
    if (!payload.startsWith("(") || !payload.endsWith(")")) return null;

    const branches = splitFields(payload.slice(1, -1));
    if (!branches || branches.length === 0) return null;
    if (type === "NOT" && branches.length !== 1) return null;

    const children = [];
    for (const branch of branches) {
        if (!branch.startsWith("(") || !branch.endsWith(")")) return null;
        const child = condition(branch.slice(1, -1), level + 1);
        if (child === null) return null;
        children.push(child);
    }
    return { type, options, children };
}

// Parse one rule line into its condition plus the trailing policy.
//
//   { condition, policy: string|null, options: string[] }
//
// `policy` is null when the line carries none (a bare `.list` line, or a line
// whose slot 2 was an option word) - the caller supplies the default then.
// Condition and policy stay separate because they are genuinely different
// slots: in `AND,((A),(B)),REJECT,no-resolve`, REJECT names where the traffic
// goes and no-resolve configures the matcher.
export function parseRuleLine(line) {
    if (typeof line !== "string") return null;
    // Trim first. splitFields refuses any input containing \r, and the
    // bundled snapshots are CRLF, so a missed trim empties the whole list
    // silently rather than failing loudly.
    const trimmed = removingComment(line).trim();
    if (trimmed === "") return null;

    const parts = splitFields(trimmed);
    if (!parts || parts.length < 2) return null;

    const type = String(parts[0]).toUpperCase();
    if (type === "FINAL" || type === "MATCH") {
        const policy = unquote(parts[1]);
        if (policy === "") return null;
        return { condition: null, policy, options: parts.slice(2) };
    }

    const rest = parts.slice(2);
    let policy = null;
    let options = rest;
    if (rest.length > 0 && !isOptionToken(rest[0])) {
        policy = unquote(rest[0]);
        options = rest.slice(1);
    }

    // The condition is rebuilt without the policy slot, so REJECT never
    // reaches the matcher's option list.
    const body = [parts[0], parts[1]].concat(options).join(",");
    const parsed = condition(body);
    if (parsed === null) return null;

    return { condition: parsed, policy, options };
}

// Render a condition back to its canonical `TYPE,payload[,option...]` text.
// Diagnostics and tests only - the production path ends at sing-box JSON, so
// there is no need for the round-trip fidelity a rule-file writer would want.
export function formatCondition(cond) {
    if (!cond || typeof cond !== "object") return "";
    const payload = cond.children
        ? "(" + cond.children.map((c) => "(" + formatCondition(c) + ")").join(",") + ")"
        : String(cond.content);
    return [cond.type, payload].concat(cond.options || []).join(",");
}

export default {
    splitFields,
    unquote,
    removingComment,
    portRanges,
    condition,
    parseRuleLine,
    formatCondition,
    MAX_FIELD_BYTES,
    MAX_PAREN_DEPTH,
    MAX_CONDITION_DEPTH,
    LOGICAL_TYPES,
};
