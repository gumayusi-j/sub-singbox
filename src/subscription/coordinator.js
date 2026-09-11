// Refresh ticketing: for any one source, only the newest request may commit.
//
// Ported from Tower's SourceUpdateCoordinator. A refresh spends most of its
// life waiting on the network, so a slow request can easily finish after a
// newer one for the same source - and if it were allowed to write, the user
// would end up looking at the older node list. Handing out a ticket per
// attempt and checking it before committing makes "newest wins" explicit
// rather than a race.

export function createCoordinator() {
    // source id -> the ticket currently entitled to commit.
    const tickets = new Map();
    // source id -> AbortController, for cancellation support.
    const controllers = new Map();
    // Global cancel flag for batch refresh.
    let cancelledAll = false;
    let sequence = 0;

    return {
        begin(id) {
            const ticket = { id, sequence: (sequence += 1) };
            tickets.set(id, ticket);
            const ac = new AbortController();
            controllers.set(id, ac);
            return ticket;
        },

        isCurrent(id, ticket) {
            return !!ticket && tickets.get(id) === ticket;
        },

        isRunning(id) {
            return tickets.has(id);
        },

        // Only the ticket that still holds the slot may release it, so a
        // superseded attempt cannot clear its successor's claim.
        finish(id, ticket) {
            if (tickets.get(id) === ticket) {
                tickets.delete(id);
                controllers.delete(id);
            }
        },

        invalidate(id) {
            tickets.delete(id);
            controllers.delete(id);
        },

        invalidateAll() {
            tickets.clear();
            controllers.clear();
        },

        // Cancellation support: get the AbortSignal for a running source.
        signal(id) {
            const ac = controllers.get(id);
            return ac ? ac.signal : null;
        },

        // Cancel a single source's in-flight request.
        cancel(id) {
            const ac = controllers.get(id);
            if (ac) ac.abort();
        },

        // Cancel every in-flight request in a batch.
        cancelAll() {
            cancelledAll = true;
            for (const ac of controllers.values()) ac.abort();
        },

        isCancelledAll() {
            return cancelledAll;
        },

        resetCancelAll() {
            cancelledAll = false;
        },
    };
}

export default { createCoordinator };
