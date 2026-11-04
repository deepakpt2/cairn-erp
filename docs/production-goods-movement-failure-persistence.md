# CO11N automatic goods-movement failures and COGI recovery

## Scope

Migration `9212_production_goods_movement_failure.sql` established durable intents for automatic goods movements caused only by operation-level CO11N confirmations. Migration `9213_cogi_postprocessing.sql` adds correction revisions, postprocessing history, and the COGI recovery surface at `/production/cogi` (alias `COGI`, capability `PROD.GM.REPROCESS`). MIGO-originated movements and CO15 header confirmations remain out of scope; COGI does not become a general MIGO posting surface.

## Transaction contract

1. CO11N takes the existing production-order transaction lock, validates and saves the operation confirmation and activity rows, and writes one immutable movement intent for each eligible automatic issue/receipt. This confirmation transaction performs no inventory posting.
2. Once that transaction commits, each intent is claimed independently. The owner opens a fresh tenant transaction, reacquires the same production-order lock used by CO11N and CO13, checks whether the source confirmation has been cancelled, then calls the existing goods-issue or production-receipt service with that caller-owned transaction.
3. A successful material document, journal, stock/valuation/reservation/output side effects, success-attempt history, and intent transition to `POSTED` commit together. A thrown posting refusal is not caught inside the posting transaction: that transaction rolls back first. A separate transaction then records the failed attempt and retry time. A successful companion movement is never rolled back with it; the confirmation and its durable intent remain available for review.
4. If CO13 wins the production-order lock first, recovery observes the cancellation and marks the intent `BLOCKED` without posting. If posting wins first, CO13 sees the standing material document and applies its existing refusal rule.

The isolation guarantee depends on the posting services continuing to write every posting side effect through the supplied transaction. A future service that catches a posting error and continues, or writes a posting side effect through another connection, must not be used by this worker until that behavior is corrected and verified.

## Durable record and retry

- `production_goods_movement_failure` stores tenant, source confirmation, order/operation/plant, movement kind/type, posting context, request key, SHA-256 fingerprint, complete original payload, status, failure details, attempt count, timestamps, retry timing, processing lease, and successful material-document reference.
- `production_goods_movement_failure_line` stores searchable material, quantity/unit, effective storage location, batch, special-stock, reservation, and order-item context. Composite tenant/plant foreign keys prevent line context from crossing the source plant. Original inputs are retained rather than rebuilt from mutable defaults during recovery.
- `production_goods_movement_failure_attempt` preserves every claim, completion, refusal, and abandoned lease. A lease token and row lock provide exclusive ownership; an expired processing attempt is first closed as `ABANDONED` before another owner may claim it.
- Posting reuses the original movement request key and original payload fingerprint. A `POSTED` intent cannot be claimed again. Replaying CO11N does not retry a `FAILED` intent; it returns the stored confirmation/outcome. A COGI retry is explicit and uses the current corrected revision, if any.
- Reads, retrieval, filtering, correction, attempt execution, and discard are tenant-scoped. Database RLS and composite foreign keys provide additional isolation.

## COGI recovery surface

The COGI workbench filters and lists CO11N movement failures, shows their line details and attempt/revision history, and operates on one durable intent at a time. The supported line corrections are quantity, storage location, and batch. Each correction requires a reason and the displayed revision number; it appends a correction revision instead of mutating the original payload, fingerprint, or idempotency key. A retry posts through the existing MIGO posting service. A discard is terminal, requires a reason, and is audited.

Every read and mutation requires the `PROD.GM.REPROCESS` capability and explicit Company Code and Plant scope. Scope is checked against the source production order and plant, not accepted from form data. Correction and discard do not edit or cancel the production confirmation. If the confirmation is cancelled, the movement cannot be retried.

## Future sources

MIGO and CO15 may share the transaction/recovery pattern later, but must not be added by weakening the CO11N source checks in these migrations. A follow-on design should first generalize source identity (for example, a source type plus a source-reference table with source-specific foreign keys), then define each source's immutable payload, idempotency key, order-lock and cancellation/void race, authorization boundary, retry policy, and rollback tests. MIGO must snapshot its actual user-entered line/context instead of deriving it from a production confirmation. CO15 must define how one header confirmation relates to multiple operations and what cancellation means for each movement.
