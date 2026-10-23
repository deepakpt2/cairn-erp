-- ME33K is the display route. It is not the change screen.
-- The capability and alias already stand. Only the route moves.

update term_registry
   set route_path = '/purchasing/contract-display',
       description = 'Display a purchase contract. This route writes nothing.',
       changed_by = 'MIGRATION_9149',
       changed_at = now()
 where our_code = 'PROC.CONTRACT.DISPLAY';
