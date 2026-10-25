-- CO02 technical completion. This is a function of the existing change screen.
-- It is not a new transaction, and it does not add closed, delivered, or settlement.
-- Existing orders remain created or released. Their completion columns stay empty.

ALTER TABLE production_order
  ALTER COLUMN status TYPE varchar(32);

ALTER TABLE production_order
  ADD COLUMN technically_completed_by varchar(64),
  ADD COLUMN technically_completed_at timestamptz;

ALTER TABLE production_order
  DROP CONSTRAINT production_order_status_ck;

ALTER TABLE production_order
  ADD CONSTRAINT production_order_status_ck
  CHECK (status IN ('CREATED', 'RELEASED', 'TECHNICALLY_COMPLETED'));

ALTER TABLE production_order
  ADD CONSTRAINT production_order_technical_completion_ck
  CHECK (
    (
      status = 'TECHNICALLY_COMPLETED'
      AND technically_completed_by IS NOT NULL
      AND technically_completed_at IS NOT NULL
    )
    OR (
      status <> 'TECHNICALLY_COMPLETED'
      AND technically_completed_by IS NULL
      AND technically_completed_at IS NULL
    )
  );

UPDATE capability
SET description = 'Change a production order. CO02 is a search alias. Quantity, dates, and components can change only while the order is not technically complete and no goods movement or confirmation cites it. Technical completion and its revocation are separate actions on this screen. They do not release, close, deliver, settle, or post.'
WHERE code = 'PROD.ORDER.CHANGE';

UPDATE term_registry
SET description = 'Change a production order. CO02 is a search alias. The number, material, plant, and unit stay fixed. Quantity, dates, and component quantities can change while the order is not technically complete and no goods movement or confirmation cites it. Technical completion and its revocation are explicit actions on this screen, not a typed status and not a separate transaction. A header quantity change does not rescale components. Operations are not stored. Change does not release, close, deliver, settle, or post.',
    changed_by = 'MIGRATION_9174',
    changed_at = now()
WHERE our_code = 'PROD.ORDER.CHANGE';
