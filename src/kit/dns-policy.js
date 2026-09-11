// Which resolver a DNS query should use.
//
// Ported from Tower's SingBoxDNSPolicy. The problem it solves: a rule can send
// traffic direct while its DNS is still answered by the proxy's resolver, and
// a far-away answer for a nearby connection is what makes domestic sites feel
// slow. The route decision and the resolution decision have to agree.
//
// There are two predicates here and they are NOT interchangeable:
//
//   onlyLeaves        every path through a group reaches an allowed tag. Used
//                     where a wrong answer is a leak - picking a proxy to carry
//                     DNS through must not pick one that can go direct.
//   defaultsToDirect  follows the entry the group would actually select. Used
//                     for the projection below: a group that ships selecting
//                     DIRECT is a direct group, even when it also lists proxies.
//
// Merging them either loses the leak check or reintroduces the slowness.

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function membersOf(outbound) {
    if (!isPlainObject(outbound)) return [];
    return (Array.isArray(outbound.outbounds) ? outbound.outbounds : []).filter(
        (tag) => typeof tag === "string",
    );
}

// tag -> member tags, for every group in the document.
function groupMembers(outbounds) {
    const members = new Map();
    for (const outbound of Array.isArray(outbounds) ? outbounds : []) {
        if (!isPlainObject(outbound) || typeof outbound.tag !== "string") continue;
        members.set(outbound.tag, membersOf(outbound));
    }
    return members;
}

function findOutbound(tag, outbounds) {
    for (const outbound of Array.isArray(outbounds) ? outbounds : []) {
        if (isPlainObject(outbound) && outbound.tag === tag) return outbound;
    }
    return null;
}

// Does every leaf reachable from `tag` belong to `allowed`? A group that could
// resolve to something else answers false, which is the conservative answer.
export function onlyLeaves(tag, allowed, outbounds) {
    const permitted = allowed instanceof Set ? allowed : new Set(allowed || []);
    const members = groupMembers(outbounds);

    const walk = (name, visiting) => {
        if (permitted.has(name)) return true;
        const children = members.get(name);
        if (children === undefined || children.length === 0) return false;
        if (visiting.has(name)) return false;
        const next = new Set(visiting);
        next.add(name);
        return children.every((child) => walk(child, next));
    };

    return walk(tag, new Set());
}

// Would `tag` resolve to a direct outbound with the selection it ships with?
//
// A selector's `default` is what the client uses until someone changes it in
// the dashboard, so that is the honest answer to "where does this go". Falling
// back to the first member matches sing-box, which uses the first when no
// default is declared.
export function defaultsToDirect(tag, outbounds, visiting) {
    const seen = visiting instanceof Set ? visiting : new Set();
    if (typeof tag !== "string" || tag === "") return false;
    if (seen.has(tag)) return false;

    const definition = findOutbound(tag, outbounds);
    if (definition === null) return false;
    if (definition.type === "direct") return true;

    const children = membersOf(definition);
    if (definition.type !== "selector" || children.length === 0) {
        // A urltest, or a group with nothing to select from: it cannot be
        // reasoned about, so fall back to the conservative test.
        return onlyLeaves(tag, new Set(["direct", "DIRECT"]), outbounds);
    }

    const selected = typeof definition.default === "string" ? definition.default : children[0];
    // A default naming something outside the group would leave sing-box with
    // no usable selection, so the group is not treated as direct.
    if (children.indexOf(selected) === -1) return false;

    const next = new Set(seen);
    next.add(tag);
    return defaultsToDirect(selected, outbounds, next);
}

// Matcher keys a DNS rule understands. Deliberately only the domain family:
// an address, port or network matcher has no meaning to a resolver, and a
// `logical` rule is skipped outright - the domains inside an AND are not the
// set of names the query should be answered by.
const DNS_MATCHER_KEYS = ["domain", "domain_suffix", "domain_keyword", "domain_regex"];

// Project route rules into DNS rules, so a domain routed direct is resolved
// locally and one that is blocked is blocked at the resolver too.
//
// Order is preserved: DNS rules are evaluated in sequence, so the first match
// has to be the same one the route list would have made.
export function projectDnsRules(routeRules, outbounds, options) {
    options = options || {};
    const localServer = options.localServer || "local";
    const out = [];

    for (const rule of Array.isArray(routeRules) ? routeRules : []) {
        if (!isPlainObject(rule)) continue;
        if (rule.type === "logical") continue;

        const matchers = {};
        let hasDomainMatcher = false;
        for (const key of DNS_MATCHER_KEYS) {
            if (rule[key] === undefined) continue;
            matchers[key] = rule[key];
            hasDomainMatcher = true;
        }
        if (!hasDomainMatcher) continue;

        if (rule.action === "reject") {
            out.push(Object.assign({ action: "reject" }, matchers));
            continue;
        }
        if (typeof rule.outbound !== "string") continue;
        if (!defaultsToDirect(rule.outbound, outbounds)) continue;
        out.push(Object.assign({ action: "route", server: localServer }, matchers));
    }

    return out;
}

export default { onlyLeaves, defaultsToDirect, projectDnsRules, DNS_MATCHER_KEYS };
