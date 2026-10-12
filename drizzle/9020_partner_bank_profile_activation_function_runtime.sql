-- B-091: expose only the narrow activation function to the server-side app role.
-- Profile-table UPDATE and audit-table DML remain revoked; no capability role grants are added here.
REVOKE ALL PRIVILEGES ON FUNCTION public.cairn_activate_partner_bank_profile(
  uuid, varchar, uuid, varchar, varchar, integer, varchar
) FROM PUBLIC, cairn_app;
GRANT EXECUTE ON FUNCTION public.cairn_activate_partner_bank_profile(
  uuid, varchar, uuid, varchar, varchar, integer, varchar
) TO cairn_app;
