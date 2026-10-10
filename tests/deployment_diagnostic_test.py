"""Pure redaction tests; no Docker or database is contacted."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('diagnostic', Path(__file__).resolve().parents[1] / 'scripts' / 'diagnose-docker-db.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DiagnosticRedactionTests(unittest.TestCase):
    def test_matching_connections_do_not_disclose_password(self):
        secret = 'DummyPrivateCredential'
        env = {'DATABASE_URL': 'postgresql://cairn_app:' + secret + '@db:5432/cairn'}
        report = d.connection_summary(env, env, {'CAIRN_APP_DB_PASSWORD': secret})
        self.assertTrue(report['exact_application_migration_url_match'])
        self.assertTrue(report['app_password_matches_db_container_setting'])
        self.assertNotIn(secret, json.dumps(report))
        self.assertNotIn('postgresql://', json.dumps(report))

    def test_stale_application_password_is_reported_only_as_boolean(self):
        report = d.connection_summary({'DATABASE_URL': 'postgres://cairn_app:OldDummy@db/cairn'}, {'DATABASE_URL': 'postgres://cairn_app:NewDummy@db/cairn'}, {'CAIRN_APP_DB_PASSWORD': 'NewDummy'})
        self.assertFalse(report['decoded_application_migration_password_match'])
        self.assertFalse(report['app_password_matches_db_container_setting'])
        self.assertNotIn('OldDummy', json.dumps(report))
        self.assertNotIn('NewDummy', json.dumps(report))

    def test_encoded_passwords_are_compared_without_disclosure(self):
        env = {'DATABASE_URL': 'postgres://cairn_app:Dummy%21@db/cairn'}
        report = d.connection_summary(env, env, {'CAIRN_APP_DB_PASSWORD': 'Dummy!'})
        self.assertTrue(report['app_password_matches_db_container_setting'])
        self.assertNotIn('Dummy', json.dumps(report))

    def test_missing_connections_do_not_leak_other_variables(self):
        report = d.connection_summary({'GITHUB_PAT': 'DummyPrivateToken'}, {}, {})
        self.assertFalse(report['application_url_present'])
        self.assertNotIn('DummyPrivateToken', json.dumps(report))

    def test_malformed_connection_is_reported_without_raw_value(self):
        env = {'DATABASE_URL': 'postgres://cairn_app:DummySecret@db:invalid/cairn'}
        report = d.connection_summary(env, env, {})
        self.assertTrue(report['connection_url_parse_failed'])
        self.assertNotIn('DummySecret', json.dumps(report))


if __name__ == '__main__':
    unittest.main()
