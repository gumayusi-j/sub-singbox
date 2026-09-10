// Multi-source node merging.
//
// Two independent identifier spaces exist depending on what is being produced:
//
//   - sing-box identifies outbounds by `tag`; a duplicate tag makes the config
//     refuse to boot.
//   - every other dialect (Clash, Surge, Loon, ...) identifies a proxy by its
//     display `name`; a duplicate name silently shadows one of the entries.
//
// Both helpers append the same "-N" suffix the assembler uses for its synthetic
// groups, and report each rename through the caller's `warnings` array so the
// UI can surface it.

function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

// A document whose tag space carries duplicates would assemble into a config
// sing-box refuses to boot (duplicate outbound/endpoint tags), so multi-source
// merges rename colliding tags with the same "-N" suffix the assembler uses
// for its synthetic groups. Single-source documents pass through untouched so
// their tags never drift from what the caller pasted.
export function mergeParsed(parsedList, warnings) {
    if (!Array.isArray(parsedList) || parsedList.length <= 1) {
        return {
            outbounds: (parsedList && parsedList[0] && parsedList[0].outbounds) || [],
            endpoints: (parsedList && parsedList[0] && parsedList[0].endpoints) || [],
        };
    }
    const outbounds = [];
    const endpoints = [];
    const seenOut = new Set();
    const seenEp = new Set();
    const append = (coll, o, seen, label) => {
        if (!o) return;
        let item = o;
        const tag = item.tag;
        if (typeof tag === "string" && seen.has(tag)) {
            let i = 2;
            let candidate = tag + "-" + i;
            while (seen.has(candidate)) {
                i += 1;
                candidate = tag + "-" + i;
            }
            item = Object.assign({}, o, { tag: candidate });
            warnings.push({
                message:
                    "duplicate " + label + " tag '" + tag +
                    "' across subscriptions renamed to '" + candidate + "'",
                path: "merge",
            });
        }
        coll.push(item);
        if (typeof item.tag === "string") seen.add(item.tag);
    };
    for (const parsed of parsedList) {
        for (const o of (parsed && parsed.outbounds) || []) {
            append(outbounds, o, seenOut, "node");
        }
        for (const o of (parsed && parsed.endpoints) || []) {
            append(endpoints, o, seenEp, "endpoint");
        }
    }
    return { outbounds, endpoints };
}

// The non-sing-box dialects key their entries by display name, so merging two
// subscriptions that both ship a node called "香港 01" needs the second one
// renamed or the client silently drops it. `nodesList` is a list of node-object
// arrays (the shape ProxyUtils.parse hands back); the result is one flat array.
export function dedupeNodeNames(nodesList, warnings) {
    const out = [];
    const seen = new Set();
    for (const nodes of nodesList || []) {
        for (const node of nodes || []) {
            if (!isPlainObject(node)) continue;
            const name = node.name;
            if (typeof name !== "string") {
                out.push(node);
                continue;
            }
            if (!seen.has(name)) {
                seen.add(name);
                out.push(node);
                continue;
            }
            let i = 2;
            let candidate = name + " " + i;
            while (seen.has(candidate)) {
                i += 1;
                candidate = name + " " + i;
            }
            if (warnings) {
                warnings.push({
                    message:
                        "duplicate node name '" + name +
                        "' across subscriptions renamed to '" + candidate + "'",
                    path: "merge",
                });
            }
            seen.add(candidate);
            out.push(Object.assign({}, node, { name: candidate }));
        }
    }
    return out;
}

export default { mergeParsed, dedupeNodeNames };
