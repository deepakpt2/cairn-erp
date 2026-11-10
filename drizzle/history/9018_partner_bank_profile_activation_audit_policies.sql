-- Global activation evidence is writable only by the later narrow owner-rights function.
-- The application cannot read, insert, update, delete, or truncate audit events directly.
REVOKE ALL PRIVILEGES ON TABLE partner_bank_profile_activation_audit FROM PUBLIC, cairn_app;
