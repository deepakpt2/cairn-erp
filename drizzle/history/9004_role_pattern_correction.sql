-- D-048. Restore the literal patterns declared by the standard roles.
-- A legacy seed replaced EVERY pattern beginning with '*' with SYSTEM.WILDCARD,
-- losing both the administrator's '*' and the auditor's '*.*.DISPLAY' suffix.
-- Only the known standard roles are repaired; custom roles are not widened.
UPDATE role_capability SET capability_code = '*', changed_by = 'MIGRATION_9004', changed_at = now()
 WHERE role_code = 'ADMINISTRATOR' AND capability_code = 'SYSTEM.WILDCARD';
UPDATE role_capability SET capability_code = '*.*.DISPLAY', changed_by = 'MIGRATION_9004', changed_at = now()
 WHERE role_code = 'AUDITOR' AND capability_code = 'SYSTEM.WILDCARD';
