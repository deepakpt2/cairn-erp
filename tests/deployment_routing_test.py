"""Read-only regression tests for shared-proxy Docker DB name isolation."""
from pathlib import Path
import re
import unittest


class DeploymentRoutingTests(unittest.TestCase):
    def setUp(self):
        self.compose = (Path(__file__).resolve().parents[1] / 'docker-compose.yml').read_text()

    def test_all_runtime_and_owner_database_urls_use_private_namespaced_alias(self):
        hosts = re.findall(r'@([^\s:]+):5432/cairn', self.compose)
        self.assertEqual(hosts, ['cairn-postgres'] * 3)
        self.assertNotIn('@db:', self.compose)

    def test_database_alias_is_on_private_network_not_proxy(self):
        db_block = self.compose.split('  db:\n', 1)[1].split('\n  migrate:', 1)[0]
        network_block = db_block.split('    networks:\n', 1)[1].split('    healthcheck:', 1)[0]
        self.assertIn('cairn_internal:', network_block)
        self.assertIn('aliases:\n          - cairn-postgres', network_block)
        self.assertNotIn('proxy', network_block)

    def test_persistent_data_and_existing_traefik_boundaries_are_retained(self):
        self.assertIn('postgres_data:/var/lib/postgresql/data', self.compose)
        self.assertIn('traefik.docker.network: proxy', self.compose)
        self.assertIn('traefik.http.routers.cairn.entrypoints: web', self.compose)
        self.assertNotIn('certresolver', self.compose)
        self.assertNotIn('172.31.0.2', self.compose)
        self.assertNotIn('172.18.0.9', self.compose)


if __name__ == '__main__':
    unittest.main()
