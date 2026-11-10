-- This registry is global reference configuration, not tenant-scoped data.
-- The runtime may inspect readiness but cannot activate or rewrite profiles.
REVOKE ALL PRIVILEGES ON TABLE partner_bank_country_profile FROM cairn_app;
GRANT SELECT ON TABLE partner_bank_country_profile TO cairn_app;
