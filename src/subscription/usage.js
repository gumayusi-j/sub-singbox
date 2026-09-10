// Airport plan quota, read from three places, in decreasing order of trust:
//
//   1. the `subscription-userinfo` response header   ("upload=..; download=..")
//   2. a `STATUS=` line in the subscription body     (V2Board and friends)
//   3. a notice node in the body                     ("剩余流量：12.3 GB")
//
// Mirrors Tower's SubscriptionUsage (Models/DomainModels.swift), which reads
// the same three sources. Dates are normalised to *unix seconds* everywhere:
// `expire` arrives as seconds, as milliseconds, or as a date string depending
// on the panel, and callers should never have to care which.

import { Base64 } from "js-base64";

const HEADER_KEYS = {
    upload: "upload",
    download: "download",
    total: "total",
    expire: "expire",
};

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

// A byte count: non-negative, finite, integral. Panels occasionally send
// "1234.0" or "" for an unset field, so be forgiving about the shape but never
// report a negative or NaN number.
function toBytes(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
}

// Expiry normalisation. Accepts unix seconds, unix milliseconds, an ISO
// timestamp and a bare "YYYY-MM-DD" date. Returns unix seconds, or null.
export function normalizeExpire(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
        const raw = Number(value);
        if (!Number.isFinite(raw) || raw <= 0) return null;
        // Ten-digit values are seconds, thirteen-digit are milliseconds. The
        // cut sits well above any plausible seconds value and well below any
        // plausible milliseconds one.
        return raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);
    }
    const text = String(value).trim();
    // A bare date is parsed as UTC midnight so the result does not shift with
    // the server's timezone.
    const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed = dateOnly
        ? Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
        : Date.parse(text);
    if (!Number.isFinite(parsed)) return null;
    return Math.floor(parsed / 1000);
}

// "upload=1; download=2; total=3; expire=1735660800" -> usage object.
export function parseUserInfoHeader(value) {
    if (typeof value !== "string" || value.trim() === "") return null;
    const usage = { origin: "userinfo" };
    let matched = false;
    for (const part of value.split(/[;,]/)) {
        const index = part.indexOf("=");
        if (index <= 0) continue;
        const key = part.slice(0, index).trim().toLowerCase();
        const field = HEADER_KEYS[key];
        if (!field || field === "expire") continue;
        const bytes = toBytes(part.slice(index + 1));
        if (bytes == null) continue;
        usage[field] = bytes;
        matched = true;
    }
    const expireMatch = value.match(/expire\s*=\s*([^;,]+)/i);
    if (expireMatch) {
        const expire = normalizeExpire(expireMatch[1].trim());
        if (expire != null) {
            usage.expire = expire;
            matched = true;
        }
    }
    if (!matched) return null;
    return usage;
}

// A `STATUS=` line in the body. The value is either the same key=value form as
// the header, or a human sentence the panel wrote ("剩余流量：12.3 GB").
// V2Board base64-encodes the whole body, so scan both the raw text and its
// decoded form.
export function parseStatusLine(text) {
    if (typeof text !== "string" || text === "") return null;
    const candidates = [text];
    const decoded = tryDecodeBase64(text);
    if (decoded) candidates.push(decoded);
    for (const candidate of candidates) {
        const usage = scanForStatus(candidate);
        if (usage) return usage;
    }
    return null;
}

function tryDecodeBase64(text) {
    const compact = text.replace(/\s+/g, "");
    if (compact.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
    try {
        const decoded = Base64.decode(compact);
        // Reject garbage: a real subscription body decodes to printable text,
        // so a NUL byte or a missing ASCII run means this was not base64.
        if (!decoded || decoded.indexOf("\u0000") >= 0) return null;
        if (!/[\x20-\x7e]{4}/.test(decoded)) return null;
        return decoded;
    } catch (_e) {
        return null;
    }
}

function scanForStatus(text) {
    const match = text.match(/^\s*STATUS\s*=\s*(.+)$/im);
    if (!match) return null;
    const value = match[1].trim();
    const parsed = parseUserInfoHeader(value);
    if (parsed) return { ...parsed, origin: "status" };
    // Sentence form: pull whatever numbers the panel embedded.
    const sentence = parseSentence(value);
    return sentence ? { ...sentence, origin: "status" } : null;
}

// "剩余流量：12.3 GB，已用 3 GB，到期时间：2026-09-30" and similar.
const SENTENCE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

function parseBytesFromSentence(text) {
    const match = text.match(/([\d.]+)\s*(TB|GB|MB|KB|B)\b/i);
    if (!match) return null;
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n * SENTENCE_UNITS[match[2].toLowerCase()]);
}

function parseSentence(text) {
    const usage = {};
    let matched = false;
    const fields = [
        ["total", /(?:剩余流量|剩余|Remaining)[^\d]*([\d.]+\s*(?:TB|GB|MB|KB|B))/i],
        ["download", /(?:已用|已使用|Used)[^\d]*([\d.]+\s*(?:TB|GB|MB|KB|B))/i],
    ];
    for (const [field, pattern] of fields) {
        const match = text.match(pattern);
        if (!match) continue;
        const bytes = parseBytesFromSentence(match[1]);
        if (bytes == null) continue;
        usage[field] = bytes;
        matched = true;
    }
    const expire = text.match(
        /(?:到期时间|到期|过期|Expire[sd]?)[^\d]*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
    );
    if (expire) {
        const seconds = normalizeExpire(expire[1].replace(/\//g, "-"));
        if (seconds != null) {
            usage.expire = seconds;
            matched = true;
        }
    }
    return matched ? usage : null;
}

// Notice nodes: a panel frequently injects fake nodes whose name carries the
// plan summary. `nodes` is any list of objects with a `name` field.
export function parseNoticeUsage(nodes) {
    if (!Array.isArray(nodes)) return null;
    for (const node of nodes) {
        const name = node && typeof node.name === "string" ? node.name : null;
        if (!name) continue;
        const sentence = parseSentence(name);
        if (sentence) return { ...sentence, origin: "notice", notices: [name] };
    }
    return null;
}

// Combine sources by field: the first source that supplies a field wins, so
// pass them in decreasing order of trust.
export function mergeUsage(parts) {
    const out = {
        upload: null,
        download: null,
        total: null,
        expire: null,
        origin: null,
        notices: [],
    };
    let any = false;
    for (const part of parts || []) {
        if (!isPlainObject(part)) continue;
        for (const field of ["upload", "download", "total", "expire"]) {
            if (out[field] == null && part[field] != null) {
                out[field] = part[field];
                out.origin = out.origin || part.origin || null;
                any = true;
            }
        }
        if (Array.isArray(part.notices)) out.notices.push(...part.notices);
    }
    if (!any && out.notices.length === 0) return null;
    return out;
}

// The header airports send, so a client subscribed to this server sees the
// quota. A null field is omitted rather than sent as 0, which some clients
// render as "0 bytes remaining".
export function formatUserInfoHeader(usage) {
    if (!isPlainObject(usage)) return null;
    const parts = [];
    for (const field of ["upload", "download", "total"]) {
        if (usage[field] != null) {
            parts.push(field + "=" + Math.max(0, Math.floor(usage[field])));
        }
    }
    if (usage.expire != null) parts.push("expire=" + Math.floor(usage.expire));
    return parts.length > 0 ? parts.join("; ") : null;
}

// Presentation view for the UI. `now` is a Date; `expire` is unix seconds.
export function usageSummary(usage, now) {
    if (!isPlainObject(usage)) return null;
    const upload = usage.upload || 0;
    const download = usage.download || 0;
    const used = upload + download;
    const total = usage.total || 0;
    // A total of 0 means "unlimited" on essentially every panel, not "0 bytes".
    const unlimited = total <= 0;
    const nowSeconds = Math.floor((now ? now.getTime() : Date.now()) / 1000);
    return {
        upload,
        download,
        used,
        total,
        unlimited,
        ratio: unlimited ? null : Math.min(1, used / total),
        expireAt: usage.expire != null ? new Date(usage.expire * 1000).toISOString() : null,
        daysLeft:
            usage.expire != null
                ? Math.max(0, Math.ceil((usage.expire - nowSeconds) / 86400))
                : null,
        expired: usage.expire != null && usage.expire <= nowSeconds,
        notices: Array.isArray(usage.notices) ? usage.notices : [],
    };
}

// One call for the refresh engine: prefer the header, fall back to the body.
export function extractUsage(headers, text, nodes) {
    const header = isPlainObject(headers) ? headers["subscription-userinfo"] : null;
    return mergeUsage([
        parseUserInfoHeader(header),
        parseStatusLine(text),
        parseNoticeUsage(nodes),
    ]);
}

export default {
    parseUserInfoHeader,
    parseStatusLine,
    parseNoticeUsage,
    mergeUsage,
    extractUsage,
    normalizeExpire,
    formatUserInfoHeader,
    usageSummary,
};
