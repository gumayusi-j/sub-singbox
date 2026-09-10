// A fetch stand-in so subscription tests never touch the network.
//
// Node 22 ships a real Response class, so the mock hands back genuine Response
// objects - downloadText's header flattening and status handling then run
// against the same shapes production sees, instead of a hand-rolled stub that
// could drift from them.

// createMockFetch(routes, { onRequest })
//
//   routes .... { "<url>": handler } where handler is either an object
//               ({status, headers, body}) or a function (request) => object.
//               A function may return a promise, including one that never
//               settles, which is how the timeout tests work.
//   onRequest . optional hook invoked with every request before routing.
//
// The returned function carries `.calls`, an array of
// { url, method, headers, at } in arrival order.
export function createMockFetch(routes, options) {
    options = options || {};
    const calls = [];

    const fetchImpl = async function (url, init) {
        const request = {
            url: String(url),
            method: (init && init.method) || "GET",
            headers: flattenHeaders(init && init.headers),
            at: Date.now(),
            // Exposed so a route can simulate a slow panel by awaiting it.
            signal: init && init.signal,
        };
        calls.push(request);
        if (typeof options.onRequest === "function") options.onRequest(request);

        const handler = routes[request.url];
        if (handler === undefined) {
            return new Response("not found", { status: 404, statusText: "Not Found" });
        }
        const result = await (typeof handler === "function" ? handler(request) : handler);
        if (result instanceof Response) return result;
        const status = result.status === undefined ? 200 : result.status;
        return new Response(result.body === undefined ? "" : result.body, {
            status,
            statusText: result.statusText || "",
            headers: result.headers || {},
        });
    };

    fetchImpl.calls = calls;
    fetchImpl.reset = () => {
        calls.length = 0;
    };
    return fetchImpl;
}

function flattenHeaders(headers) {
    const out = {};
    if (!headers) return out;
    if (typeof headers.forEach === "function") {
        headers.forEach((value, name) => {
            out[String(name).toLowerCase()] = value;
        });
        return out;
    }
    for (const name of Object.keys(headers)) {
        out[String(name).toLowerCase()] = headers[name];
    }
    return out;
}

// A promise that never settles, for exercising the AbortController timeout
// path. The abort signal is watched so the request rejects the way a real
// fetch would - without that, the timeout branch would hang the suite.
export function pendingForever(request) {
    return new Promise((_resolve, reject) => {
        const signal = request && request.signal;
        if (!signal) return;
        if (signal.aborted) {
            reject(new Error("aborted"));
            return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
}

export default { createMockFetch, pendingForever };
