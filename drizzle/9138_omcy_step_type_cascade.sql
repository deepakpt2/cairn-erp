-- A client removal must be able to remove a strategy type and the procedure
-- steps that name it. The application still refuses that deletion while the
-- step stands. This does not assign a movement type or select a batch.

ALTER TABLE batch_search_procedure_step
  DROP CONSTRAINT IF EXISTS batch_search_procedure_step_type_fk;

ALTER TABLE batch_search_procedure_step
  ADD CONSTRAINT batch_search_procedure_step_type_fk
  FOREIGN KEY (client, usage, application, strategy_type)
  REFERENCES batch_strategy_type (client, usage, application, strategy_type)
  ON DELETE CASCADE;
