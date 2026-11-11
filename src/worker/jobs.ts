/**
 * Every job handler the worker can run — CAIRN.md §21.
 *
 * Handlers register themselves as a side effect of their module being imported,
 * so something has to import all of them or the worker starts, finds nothing to
 * do, and every run it claims fails with "no handler is registered". This is
 * that something: the worker imports this one file, and a new job is wired up by
 * adding one line here.
 *
 * The web app deliberately does not import it. A request only ever needs the
 * job *code* to enqueue work; loading every handler into the request path would
 * pull background-job dependencies into screens that never run them.
 */

// ── Jobs ───────────────────────────────────────────────────────────────────
// None have been written yet. Phase 4 builds the runtime and its proof; the
// first real job arrives with the first feature that needs one, and lands here.
//
//   import '../modules/sales/jobs/reprice-open-orders';
//
// Adding a job means adding its import here. A job that is not imported is not
// a job — it is a run that will fail the moment a worker claims it.

export {};
