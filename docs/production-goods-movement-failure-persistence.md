# CO11N automatic goods-movement failure persistence

## Scope

Migration `9212_production_goods_movement_failure.sql` and the production persistence service support **only the automatic goods movements caused by an operation-level CO11N confirmation**. The mechanism is not a COGI transaction: it adds no route, registry alias, screen, capability, or direct posting surface. MIGO production-order movements and CO15 header confirmations remain out of scope.

## Transaction contract

1. CO11N takes the existing production-order transaction lock, validates and saves the operation confirmation and activity rows, and writes one immutable movement intent for each eligible automatic issue/receipt. This confirmation transaction performs no inventory posting.
2. Once that transaction commits, each intent is claimed independently. The owner opens a fresh tenant transaction, reacquires the same production-order lock used by CO11N and CO13, checks whether the source confirmation has been cancelled, then calls the existing goods-issue or production-receipt service with that caller-owned transaction.
3. A successful material document, journal, stock/valuation/reservation/output side effects, success-attempt history, and intent transition to `POSTED` commit together. A thrown posting refusal is not caught inside the posting transaction: that transaction rolls back first. A separate transaction then records the failed attempt and retry time. A successful companion movement is never rolled back with it.
4. If CO13 wins the production-order lock first, recovery observes the cancellation and marks the intent `BLOCKED` without posting. If posting wins first, CO13 sees the standing material document and applies its existing refusal rule.

The isolation guarantee depends on the posting services continuing to write every posting side effect through the supplied transaction. A future service that catches a posting error and continues, or writes a posting side effect through another connection, must not be used by this worker until that behavior is corrected and verified.

## Durable record and recovery

- `production_goods_movement_failure` stores tenant, source confirmation, order/operation/plant, movement kind/type, posting context, request key, SHA-256 fingerprint, complete original payload, status, failure details, attempt count, timestamps, retry timing, processing lease, and successful material-document reference.
- `production_goods_movement_failure_line` stores searchable material, quantity/unit, effective storage location, batch, special-stock, reservation, and order-item context. Composite tenant/plant foreign keys prevent line context from crossing the source plant. Original inputs are retained rather than rebuilt from mutable defaults during recovery.
- `production_goods_movement_failure_attempt` preserves every claim, completion, refusal, and abandoned lease. A lease token and row lock provide exclusive ownership; an expired processing attempt is first closed as `ABANDONED` before another owner may claim it.
- Posting reuses the original movement request key and payload fingerprint. A `POSTED` intent cannot be claimed again. A repeated CO11N request does not retry a `FAILED` intent; it returns the stored confirmation/outcome. Recovery callers may explicitly invoke the attempt service once `next_retry_at` is due.
- Reads, retrieval, filtering, attempt execution, and recovery are tenant-scoped. Database RLS and composite foreign keys provide additional isolation.

## Future sources

MIGO and CO15 may share the transaction/recovery pattern later, but must not be added by weakening the CO11N source checks in this migration. A follow-on design should first generalize source identity (for example, a source type plus a source-reference table with source-specific foreign keys), then define each source's immutable payload, idempotency key, order-lock and cancellation/void race, authorization boundary, retry policy, and rollback tests. MIGO must snapshot its actual user-entered line/context instead of deriving it from a production confirmation. CO15 must define how one header confirmation relates to multiple operations and what cancellation means for each movement. Only after those source contracts are independently tested should a future COGI recovery UI/route and narrowly scoped capability be considered.
