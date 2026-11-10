-- Execution order for the one stored standard sequence.
--
-- Operation number remains identity. Sequence 000000 of type 0 remains the
-- only sequence identity; that check is not relaxed. This column is the order
-- in which that one sequence is displayed, copied, and confirmed against.
-- It is not a second sequence, not a predecessor, and not a successor.
--
-- Rows that already stood had no stored execution order. Displays ordered them
-- by operation number. The backfill assigns that previously displayed order.
-- It does not invent an alternative sequence. A new save does not derive the
-- order from the operation number.

ALTER TABLE routing_operation ADD COLUMN IF NOT EXISTS execution_order integer;

UPDATE routing_operation AS op
   SET execution_order = ranked.n
  FROM (
    SELECT client, task_list_type, routing_group, group_counter, operation_number,
           row_number() OVER (
             PARTITION BY client, task_list_type, routing_group, group_counter, sequence
             ORDER BY operation_number
           )::integer AS n
      FROM routing_operation
  ) AS ranked
 WHERE op.execution_order IS NULL
   AND op.client = ranked.client
   AND op.task_list_type = ranked.task_list_type
   AND op.routing_group = ranked.routing_group
   AND op.group_counter = ranked.group_counter
   AND op.operation_number = ranked.operation_number;

ALTER TABLE routing_operation ALTER COLUMN execution_order SET NOT NULL;

ALTER TABLE production_order_operation ADD COLUMN IF NOT EXISTS execution_order integer;

UPDATE production_order_operation AS op
   SET execution_order = ranked.n
  FROM (
    SELECT client, order_number, operation_number,
           row_number() OVER (
             PARTITION BY client, order_number
             ORDER BY operation_number
           )::integer AS n
      FROM production_order_operation
  ) AS ranked
 WHERE op.execution_order IS NULL
   AND op.client = ranked.client
   AND op.order_number = ranked.order_number
   AND op.operation_number = ranked.operation_number;

ALTER TABLE production_order_operation ALTER COLUMN execution_order SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_operation_execution_order_ck'
  ) THEN
    ALTER TABLE routing_operation
      ADD CONSTRAINT routing_operation_execution_order_ck CHECK (execution_order > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_operation_execution_order_uq'
  ) THEN
    ALTER TABLE routing_operation
      ADD CONSTRAINT routing_operation_execution_order_uq
      UNIQUE (client, task_list_type, routing_group, group_counter, sequence, execution_order)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_order_operation_execution_order_ck'
  ) THEN
    ALTER TABLE production_order_operation
      ADD CONSTRAINT production_order_operation_execution_order_ck CHECK (execution_order > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_order_operation_execution_order_uq'
  ) THEN
    ALTER TABLE production_order_operation
      ADD CONSTRAINT production_order_operation_execution_order_uq
      UNIQUE (client, order_number, execution_order)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
