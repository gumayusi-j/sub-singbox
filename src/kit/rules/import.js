// Import a rule configuration into this kit's rule model.
//
// Three shapes arrive in practice, and they share one CSV rule syntax:
//
//   - a Clash/Mihomo document, as YAML (or JSON) with `rules:` and usually
//     `rule-providers:` and `proxy-groups:`
//   - a Surge configuration, whose rules live under a `[Rule]` heading
//   - a bare list of rule lines, which is what people actually paste
//
// All three funnel through the same two helpers: rules/syntax.js splits a
// line, rules/singbox.js decides whether the result can be expressed. This
// module's job is only the container formats and the policy vocabulary.
//
// A note on the policy slot, because it is the bug this replaces: the policy
// is at index 2 and parameters start at index 3, *fixed*. The tempting
// alternative - walk backwards stripping anything that looks like `key=value`
// - eats a policy named `My=Group`, leaving the rule's own value in the policy
// slot. Never do that here.

import { safeLoad } from "@/utils/yaml";
import { parseRuleLine, removingComment, formatCondition } from "./syntax";
import { toRouteRule, policyToTarget } from "./singbox";

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

// Type names other dialects spell differently but sing-box models identically.
const RESOURCE_ALIASES = {
    HOST: "DOMAIN",
    "HOST-SUFFIX": "DOMAIN-SUFFIX",
    "HOST-KEYWORD": "DOMAIN-KEYWORD",
    "HOST-WILDCARD": "DOMAIN-WILDCARD",
    "HOST-REGEX": "DOMAIN-REGEX",
    "IP6-CIDR": "IP-CIDR6",
    "DEST-PORT": "DST-PORT",
};

// Policies that are a built-in keyword rather than a group name. `DIRECT` and
// the REJECT family are handled by policyToTarget; the rest are mihomo/Surge
// behaviours sing-box does not have, and they resolve to null there.
const BUILTIN_POLICY_WORDS = new Set([
    "DIRECT",
    "PASS",
    "PASS-RULE",
    "COMPATIBLE",
    "CELLULAR",
    "CELLULAR-ONLY",
    "HYBRID",
    "NO-HYBRID",
]);

function isBuiltinPolicyWord(word) {
    const name = String(word == null ? "" : word).trim().toUpperCase();
    if (name === "") return false;
    return BUILTIN_POLICY_WORDS.has(name) || /^REJECT(-[A-Z0-9-]+)?$/.test(name);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;

// A literal address or CIDR, of either family. Local so the kit stays free of
// node built-ins - it is bundled for the browser as well as run in Node.
function isAddressOrCidr(value) {
    if (IPV4.test(value)) return true;
    return value.includes(":") && /^[0-9a-f:]+(\/\d{1,3})?$/i.test(value);
}

// Rewrite a dialect spelling into the canonical one, in place. Applied to
// every imported rule rather than only to rule-provider payloads: Surge
// configs spell their host matchers HOST-SUFFIX throughout, and one that
// reached the sing-box mapper unaliased would be dropped as unrepresentable.
function applyAlias(condition) {
    const alias = RESOURCE_ALIASES[condition.type];
    if (alias !== undefined) condition.type = alias;
    return condition;
}

function makeResult(format, options) {
    return {
        format,
        rules: [],
        groups: [],
        final: null,
        providers: [],
        warnings: [],
        stats: {
            lines: 0,
            rules: 0,
            skipped: 0,
            droppedByType: {},
            policies: [],
        },
    };
}

function notePolicy(result, policy) {
    if (typeof policy !== "string" || policy === "") return;
    if (result.stats.policies.indexOf(policy) === -1) result.stats.policies.push(policy);
}

// Compile one rule line into the result. `defaultOutbound` is used when the
// line names no policy at all, which is the norm for a bare `.list`.
function addRule(result, line, defaultOutbound, options) {
    result.stats.lines += 1;
    const parsed = parseRuleLine(line);
    if (parsed === null) {
        result.stats.skipped += 1;
        return;
    }
    // FINAL / MATCH: the fallthrough policy, not a rule. It becomes the
    // scheme's `final` rather than a route rule sing-box has no place for.
    if (parsed.condition === null) {
        if (parsed.policy !== null) {
            result.final = parsed.policy;
            notePolicy(result, parsed.policy);
        }
        return;
    }

    const policy = parsed.policy === null ? defaultOutbound : parsed.policy;
    const target = policyToTarget(policy);
    if (target === null) {
        const key = String(policy).toUpperCase();
        result.stats.droppedByType[key] = (result.stats.droppedByType[key] || 0) + 1;
        result.stats.skipped += 1;
        result.warnings.push({
            message: "策略「" + policy + "」在 sing-box 中没有对应写法，该规则已跳过",
            line: String(line).trim(),
        });
        return;
    }

    const descriptor = Object.assign({}, applyAlias(parsed.condition), { outbound: target });
    // Counting a rule we cannot actually emit would make the summary lie.
    if (toRouteRule(descriptor, target, options) === null) {
        const key = descriptor.type;
        result.stats.droppedByType[key] = (result.stats.droppedByType[key] || 0) + 1;
        result.stats.skipped += 1;
        return;
    }

    notePolicy(result, policy);
    result.rules.push(descriptor);
    result.stats.rules += 1;
}

// ---------------------------------------------------------------------------
// Rule resources (a rule-provider's payload, or a QuanX-style list)
// ---------------------------------------------------------------------------

// Turn a resource payload into rule lines the parser can read.
//
// `behavior` decides how a line that is not already `TYPE,VALUE` is read: a
// domain-list provider holds bare domains, an ipcidr one holds bare
// addresses. Anything the parser already understands is passed through with
// its type aliased into this kit's vocabulary - and with any policy column
// dropped, since the RULE-SET that referenced the resource supplies it.
export function normalizeResourceLines(lines, behavior) {
    const out = [];
    for (const raw of lines || []) {
        const line = removingComment(String(raw)).trim();
        if (line === "") continue;

        const parsed = parseRuleLine(line);
        if (parsed !== null && parsed.condition !== null) {
            out.push(formatCondition(applyAlias(parsed.condition)));
            continue;
        }

        const bare = bareResourceLine(line, behavior);
        if (bare !== null) out.push(bare);
    }
    return out;
}

function bareResourceLine(line, behavior) {
    if (isAddressOrCidr(line)) {
        return (line.includes(":") ? "IP-CIDR6," : "IP-CIDR,") + line;
    }
    if (behavior === "domain" || behavior === "domain-text") {
        if (line.startsWith("+.") || line.startsWith(".")) {
            return "DOMAIN-SUFFIX," + line.replace(/^\+?\./, "");
        }
        if (line.includes("*") || line.includes("?")) return "DOMAIN-WILDCARD," + line;
        return "DOMAIN," + line;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Mihomo / Clash
// ---------------------------------------------------------------------------

// Give each rule-provider's payload the parameters the RULE-SET line carried.
// `no-resolve` only means anything to an address matcher, and an
// update-interval is provider plumbing rather than rule syntax.
function inheritOptions(line, options) {
    if (!options || options.length === 0) return line;
    const parsed = parseRuleLine(line);
    if (parsed === null || parsed.condition === null) return line;
    const type = parsed.condition.type;
    const inherited = options.filter((option) => {
        if (String(option).toLowerCase() === "no-resolve") {
            return ["IP-CIDR", "IP-CIDR6", "IP-ASN", "GEOIP"].indexOf(type) !== -1;
        }
        return !/^update-interval=/i.test(String(option));
    });
    const merged = parsed.condition.options.slice();
    for (const option of inherited) {
        if (merged.indexOf(option) === -1) merged.push(option);
    }
    return formatCondition(Object.assign({}, parsed.condition, { options: merged }));
}

function readProviders(doc) {
    const raw = doc["rule-providers"];
    const providers = new Map();
    if (!isPlainObject(raw)) return providers;
    for (const name of Object.keys(raw)) {
        const entry = raw[name];
        if (!isPlainObject(entry)) continue;
        providers.set(name, {
            name,
            type: typeof entry.type === "string" ? entry.type : "http",
            behavior: typeof entry.behavior === "string" ? entry.behavior : undefined,
            format: typeof entry.format === "string" ? entry.format : undefined,
            interval: Number.isInteger(entry.interval) ? entry.interval : undefined,
            url: typeof entry.url === "string" ? entry.url : undefined,
            payload: Array.isArray(entry.payload) ? entry.payload : [],
        });
    }
    return providers;
}

// A proxy-group member that names a node rather than another group. The
// source document's nodes do not exist in the subscription this kit renders
// from, so a member list like [♻️ 自动选择, DIRECT, 香港01] has to widen its
// node names to "any node" - otherwise every group imports empty, gets
// dropped, and takes its rules with it.
function membersToTokens(members, declared) {
    const tokens = [];
    let sawNodeName = false;
    for (const member of members) {
        if (isBuiltinPolicyWord(member)) {
            tokens.push("[]" + member.toUpperCase());
            continue;
        }
        if (declared.has(member)) {
            tokens.push("[]" + member);
            continue;
        }
        sawNodeName = true;
    }
    // `.*` is how the bundled ACL4SSR schemes spell "every node", so a widened
    // import reads the same as a shipped preset rather than a special case.
    if (sawNodeName || tokens.length === 0) tokens.push(".*");
    return tokens;
}

function importGroups(doc) {
    const raw = doc["proxy-groups"];
    if (!Array.isArray(raw)) return { groups: [], widened: false };
    const declared = new Set();
    for (const group of raw) {
        if (isPlainObject(group) && typeof group.name === "string") declared.add(group.name);
    }

    const groups = [];
    let widened = false;
    for (const group of raw) {
        if (!isPlainObject(group)) continue;
        const tag = typeof group.name === "string" ? group.name.trim() : "";
        if (tag === "") continue;
        const members = (Array.isArray(group.proxies) ? group.proxies : []).filter(
            (member) => typeof member === "string" && member.trim() !== "",
        );
        const kind =
            String(group.type || "select").toLowerCase() === "select" ? "select" : "url-test";
        const hasNodeName = members.some(
            (member) => !declared.has(member) && !isBuiltinPolicyWord(member),
        );

        if (kind === "url-test") {
            // A url-test group means "probe these and use the fastest". With
            // the source's node names unavailable, "all of them" is the only
            // reading that stays useful.
            widened = widened || hasNodeName;
            const interval = Number(group.interval);
            const tolerance = Number(group.tolerance);
            groups.push({
                tag,
                kind,
                memberTokens: [
                    ".*",
                    typeof group.url === "string" ? group.url : "",
                    [
                        Number.isInteger(interval) && interval > 0 ? interval : "",
                        "",
                        Number.isInteger(tolerance) && tolerance > 0 ? tolerance : "",
                    ].join(","),
                ],
                drop: false,
            });
            continue;
        }

        widened = widened || hasNodeName;
        const tokens = membersToTokens(members, declared);
        groups.push({
            tag,
            kind,
            memberTokens: tokens,
            // A group whose members are all built-in policies is a "drop"
            // group: the bundled schemes use the same convention, and the
            // rules routed to it become `action: reject` rather than an
            // outbound.
            drop:
                tokens.length > 0 &&
                tokens.every((token) => /^\[\](DIRECT|REJECT.*)$/i.test(token)),
        });
    }
    return { groups, widened };
}

export function importMihomoDocument(doc, options) {
    options = options || {};
    const result = makeResult("mihomo", options);
    if (!isPlainObject(doc)) {
        result.warnings.push({ message: "不是一份可识别的 Clash/Mihomo 配置" });
        return result;
    }

    const providers = readProviders(doc);
    const { groups, widened } = importGroups(doc);
    result.groups = groups;
    if (widened) {
        result.warnings.push({
            message:
                "策略组里的节点名在本订阅中并不存在，已按「全部节点」导入；需要更窄的分组请在选择该方案后调整节点筛选。",
        });
    }

    const rules = doc.rules;
    if (!Array.isArray(rules)) {
        result.warnings.push({ message: "配置里没有 rules 列表" });
        return result;
    }

    const defaultOutbound = options.defaultOutbound || "proxy";
    for (const raw of rules) {
        if (typeof raw !== "string") continue;
        const parsed = parseRuleLine(raw);
        if (parsed !== null && parsed.condition !== null && parsed.condition.type === "RULE-SET") {
            importRuleSet(result, parsed, providers, defaultOutbound, options);
            continue;
        }
        addRule(result, raw, defaultOutbound, options);
    }
    return result;
}

function importRuleSet(result, parsed, providers, defaultOutbound, options) {
    result.stats.lines += 1;
    const name = parsed.condition.content;
    const provider = providers.get(name);
    if (provider === undefined) {
        result.stats.skipped += 1;
        result.warnings.push({
            message: "RULE-SET 引用了未声明的 rule-provider：" + name,
            line: "",
        });
        return;
    }
    if (provider.type !== "inline") {
        result.providers.push(provider);
        result.stats.skipped += 1;
        result.warnings.push({
            message:
                "远程 rule-provider「" +
                name +
                "」需要在规则方案里声明为 rule_set 才能使用，本次导入已跳过。",
        });
        return;
    }
    const policy = parsed.policy === null ? defaultOutbound : parsed.policy;
    // The RULE-SET line's trailing parameters belong to every rule the
    // payload expands into - `no-resolve` on an address set, for instance.
    const expanded = normalizeResourceLines(provider.payload, provider.behavior);
    for (const line of expanded) {
        addRule(result, inheritOptions(line, parsed.options), policy, options);
    }
}

export function importMihomoYaml(text, options) {
    let doc;
    try {
        doc = safeLoad(String(text));
    } catch (e) {
        const result = makeResult("mihomo", options || {});
        result.warnings.push({ message: "YAML 解析失败：" + (e && e.message ? e.message : e) });
        return result;
    }
    return importMihomoDocument(doc, options);
}

// ---------------------------------------------------------------------------
// Surge
// ---------------------------------------------------------------------------

const SECTION = /^\[(.+)\]$/;

export function importSurgeText(text, options) {
    options = options || {};
    const result = makeResult("surge", options);
    const defaultOutbound = options.defaultOutbound || "proxy";
    let inRule = false;
    let inRemoteRule = false;

    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        const section = SECTION.exec(line);
        if (section) {
            const name = section[1].trim().toLowerCase();
            inRule = name === "rule";
            inRemoteRule = name === "remote rule";
            continue;
        }
        if (inRemoteRule) {
            // `url, policy[, interval]` - the address is fetched by the client,
            // not by us, so it becomes a provider the scheme has to declare.
            const parts = line.split(",").map((part) => part.trim());
            if (parts.length >= 2 && /^https?:\/\//i.test(parts[0])) {
                result.stats.lines += 1;
                result.providers.push({ name: parts[0], type: "http", url: parts[0] });
                result.stats.skipped += 1;
                result.warnings.push({
                    message:
                        "远程规则集「" +
                        parts[0] +
                        "」需要在规则方案里声明为 rule_set 才能使用，本次导入已跳过。",
                });
            }
            continue;
        }
        if (!inRule) continue;
        addRule(result, line, defaultOutbound, options);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Bare rule lines
// ---------------------------------------------------------------------------

export function importRuleLines(text, options) {
    options = options || {};
    const result = makeResult("text", options);
    const defaultOutbound = options.defaultOutbound || "proxy";
    for (const raw of String(text).split(/\r?\n/)) {
        addRule(result, raw, defaultOutbound, options);
    }
    return result;
}

// Which importer a blob of text wants. The order matters: a Clash document is
// YAML that may well contain a `[Rule]`-looking string, so the structured
// check has to come first.
export function detectRuleFormat(text) {
    const value = String(text == null ? "" : text);
    if (value.trim() === "") return "text";
    try {
        const doc = safeLoad(value);
        if (Array.isArray(doc)) return "text";
        if (
            isPlainObject(doc) &&
            (Array.isArray(doc.rules) || isPlainObject(doc["rule-providers"]))
        ) {
            return "mihomo";
        }
    } catch (_e) {
        // Not YAML - fall through to the text formats.
    }
    if (/^\s*\[(rule|remote rule)\]\s*$/im.test(value)) return "surge";
    return "text";
}

// The one entry point callers need: hand it whatever the user pasted, get back
// a normalised rule set plus a report of what could not be carried over.
export function importRules(text, options) {
    const format = detectRuleFormat(text);
    if (format === "mihomo") return importMihomoYaml(text, options);
    if (format === "surge") return importSurgeText(text, options);
    return importRuleLines(text, options);
}

export default {
    importRules,
    detectRuleFormat,
    importMihomoDocument,
    importMihomoYaml,
    importSurgeText,
    importRuleLines,
    normalizeResourceLines,
};
