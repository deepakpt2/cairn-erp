-- Reflect platform setup that onboarding already performed.
UPDATE config_activity_status s SET status = 'COMPLETED',
       completed_at = coalesce(s.completed_at, now()), completed_by = 'MIGRATION_9005',
       changed_at = now(), changed_by = 'MIGRATION_9005'
 WHERE status <> 'COMPLETED' AND (
   activity_code = 'CFG.PLT.CLIENT.DEFINE'
   OR (activity_code = 'CFG.PLT.ROLE.DEFINE' AND EXISTS (SELECT 1 FROM role r WHERE r.client = s.client))
   OR (activity_code = 'CFG.PLT.USER.CREATE' AND EXISTS (SELECT 1 FROM app_user u WHERE u.client = s.client))
 );
