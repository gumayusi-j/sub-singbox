// Custom rule schemes: a user's imported configuration, in the same shape the
// bundled ACL4SSR presets use so kit/acl4ssr/build.js can render either one
// without caring which it has.
//
// A bundled preset routes rule *files* - `{ list: "ACL4SSR_ChinaDomain.list" }`
// - because its rules ship with the app. An imported scheme routes inline
// descriptors instead: `{ descriptors: [...] }`. That one extra arm is the
// whole difference, and it is what lets an imported Clash document reuse the
// group resolution, folding and rejection machinery already in place.
//
// Everything here treats its input as untrusted: a scheme round-trips through
// the data file and a browser form, so normalizeScheme rebuilds it field by
// field and refuses anything it cannot account for.

import { findPreset } from "./acl4ssr/build";

export const CUSTOM_PREFIX = "custom:";

// Ceilings on a stored scheme. Generous enough for a real mihomo document
// (the ACL4SSR snapshots are ~10k rule lines) while keeping one pathological
// import from turning the data file into a megabyte of JSON.
export const MAX_GROUPS = 200;
export const MAX_RULES = 20000;
export const MAX_NAME = 80;
// How many imported schemes one deployment may keep. A scheme is a whole rule
// set, so this is a storage bound rather than a usability one.
export const MAX_SCHEMES = 20;

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value, max) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if (max !== undefined && text.length > max) return text.slice(0, max);
    return text;
}

function stringList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((item) => typeof item === "string" && item !== "");
}

// A group in buildGroups' vocabulary. `memberTokens` follows the bundled
// convention: `[]name` is a reference to another group or a built-in policy,
// anything else is a node-name regex.
function normalizeGroup(raw) {
    if (!isPlainObject(raw)) return null;
    const tag = trimmedString(raw.tag, MAX_NAME);
    if (tag === "") return null;
    const memberTokens = stringList(raw.memberTokens);
    if (memberTokens.length === 0) return null;
    return {
        tag,
        kind: raw.kind === "url-test" ? "url-test" : "select",
        memberTokens,
        drop: raw.drop === true,
    };
}

function normalizeGroups(value) {
    const groups = [];
    for (const item of Array.isArray(value) ? value : []) {
        const group = normalizeGroup(item);
        if (group !== null) groups.push(group);
        if (groups.length >= MAX_GROUPS) break;
    }
    return groups;
}

function normalizeCondition(raw) {
    if (!isPlainObject(raw) || typeof raw.type !== "string" || raw.type === "") return null;
    const out = {
        type: raw.type.toUpperCase(),
        options: stringList(raw.options),
    };
    if (Array.isArray(raw.children)) {
        const children = [];
        for (const child of raw.children) {
            const normalized = normalizeCondition(child);
            // A logical node that loses a branch matches something wider than
            // it did, so a bad child invalidates the whole node.
            if (normalized === null) return null;
            children.push(normalized);
        }
        if (children.length === 0) return null;
        out.children = children;
    } else {
        out.content = typeof raw.content === "string" ? raw.content : "";
    }
    return out;
}

function normalizeDescriptor(raw) {
    const condition = normalizeCondition(raw);
    if (condition === null) return null;
    if (typeof raw.outbound === "string" && raw.outbound !== "") {
        condition.outbound = raw.outbound;
    }
    return condition;
}

function normalizeRuleEntry(raw) {
    if (!isPlainObject(raw)) return null;
    if (!Array.isArray(raw.descriptors)) return null;
    const descriptors = [];
    for (const item of raw.descriptors) {
        const descriptor = normalizeDescriptor(item);
        if (descriptor === null) return null;
        descriptors.push(descriptor);
    }
    if (descriptors.length === 0) return null;
    return { descriptors, group: trimmedString(raw.group, MAX_NAME) };
}

function normalizeRules(value) {
    const rules = [];
    for (const item of Array.isArray(value) ? value : []) {
        const entry = normalizeRuleEntry(item);
        if (entry !== null) rules.push(entry);
        if (rules.length >= MAX_RULES) break;
    }
    return rules;
}

// Rebuild a stored scheme, or return null when it is not one. Null is the
// only failure mode: a caller holding a corrupt entry skips it and keeps the
// rest of its list, which is what a data file edited by hand deserves.
export function normalizeScheme(raw) {
    if (!isPlainObject(raw)) return null;
    const id = trimmedString(raw.id, MAX_NAME + 40);
    if (id === "" || id.lastIndexOf(CUSTOM_PREFIX, 0) !== 0) return null;
    const name = trimmedString(raw.name, MAX_NAME);
    if (name === "") return null;

    const groups = normalizeGroups(raw.groups);
    const rules = normalizeRules(raw.rules);
    if (rules.length === 0) return null;

    return {
        id,
        name,
        summary: trimmedString(raw.summary, 200),
        sourceFormat: trimmedString(raw.sourceFormat, 20),
        groups,
        rules,
        final: trimmedString(raw.final, MAX_NAME) || null,
    };
}

// Group an import's flat rule list by the policy each rule targets, and shape
// the result as a scheme.
//
// `meta.id` and `meta.name` are the caller's: this module has no clock and no
// random source, which keeps it a pure function and the tests deterministic.
export function schemeFromImport(imported, meta) {
    meta = meta || {};
    const id = trimmedString(meta.id, MAX_NAME + 40);
    const name = trimmedString(meta.name, MAX_NAME);
    if (id === "" || name === "") return null;
    if (!isPlainObject(imported) || !Array.isArray(imported.rules)) return null;
    if (imported.rules.length === 0) return null;

    // Preserve first-appearance order: rule precedence depends on it.
    const buckets = new Map();
    for (const rule of imported.rules) {
        const policy =
            typeof rule.outbound === "string" && rule.outbound !== "" ? rule.outbound : "proxy";
        if (!buckets.has(policy)) buckets.set(policy, []);
        buckets.get(policy).push(rule);
    }

    const rules = [];
    for (const [policy, descriptors] of buckets) {
        const entry = normalizeRuleEntry({ descriptors, group: policy });
        if (entry !== null) rules.push(entry);
    }
    if (rules.length === 0) return null;

    const target = {
        id,
        name,
        summary: trimmedString(meta.summary, 200),
        sourceFormat: trimmedString(imported.format, 20),
        groups: normalizeGroups(imported.groups),
        rules,
        final: trimmedString(imported.final, MAX_NAME) || null,
    };
    // Round-trip through the same validation a stored scheme gets, so an
    // import can never produce something normalizeScheme would later reject.
    return normalizeScheme(target);
}

// Built-in presets first, then the caller's custom ones. A custom id can never
// collide with a bundled one - findPreset would win - which is why custom ids
// carry the `custom:` prefix rather than being bare names.
export function findScheme(id, custom) {
    const builtin = findPreset(id);
    if (builtin !== null) return builtin;
    if (typeof id !== "string" || id === "") return null;
    for (const raw of Array.isArray(custom) ? custom : []) {
        const scheme = normalizeScheme(raw);
        if (scheme !== null && scheme.id === id) return scheme;
    }
    return null;
}

// What the rules page lists: every built-in preset plus every usable custom
// scheme. Custom entries that fail to normalize are skipped rather than
// surfacing as a broken card.
export function listSchemes(custom, presetList) {
    const out = (typeof presetList === "function" ? presetList() : []).map((preset) => ({
        id: preset.id,
        name: preset.name,
        summary: preset.summary,
        custom: false,
    }));
    for (const raw of Array.isArray(custom) ? custom : []) {
        const scheme = normalizeScheme(raw);
        if (scheme === null) continue;
        out.push({
            id: scheme.id,
            name: scheme.name,
            summary: scheme.summary,
            sourceFormat: scheme.sourceFormat,
            custom: true,
        });
    }
    return out;
}

export default {
    normalizeScheme,
    schemeFromImport,
    findScheme,
    listSchemes,
    CUSTOM_PREFIX,
    MAX_GROUPS,
    MAX_RULES,
    MAX_NAME,
    MAX_SCHEMES,
};
