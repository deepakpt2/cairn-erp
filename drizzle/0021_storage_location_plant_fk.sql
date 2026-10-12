-- Keep each Storage Location attached to a Plant in the same tenant.
-- Fail before adding the constraint if historical rows contain an orphan.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.storage_location AS sl
    LEFT JOIN public.plant AS p
      ON p.client = sl.client
     AND p.plant = sl.plant
    WHERE p.client IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add storage_location Plant foreign key: orphan Storage Location rows exist.';
  END IF;
END $$;

ALTER TABLE public.storage_location
  ADD CONSTRAINT storage_location_client_plant_fk
  FOREIGN KEY (client, plant)
  REFERENCES public.plant (client, plant)
  ON DELETE NO ACTION
  ON UPDATE NO ACTION;
