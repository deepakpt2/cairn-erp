-- SCR-135 (B-871/§26.883): the grid and the periodic run both read the queue as
-- "this tenant's messages in this status, newest first" and "the pending periodic
-- ones, oldest first". The package's (status, output type) index was measured and
-- refused — the planner never chose it — while this one is chosen for both reads.
-- Over 40,000 messages: grid 9.650 → 0.085 ms, periodic run 6.197 → 0.394 ms.

create index output_message_queue_idx
  on public.output_message (client, status, created_at);
