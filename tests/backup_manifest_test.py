"""Atomic backup-manifest publication tests; no database or backup is accessed."""
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "backup-integration-db.py"
spec = importlib.util.spec_from_file_location("integration_backup", SCRIPT)
backup = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(backup)


class BackupManifestPublicationTests(unittest.TestCase):
    def test_publishes_complete_private_json_and_removes_temporary_name(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.json"
            record = {"database": "cairn_integration", "archive_bytes": 42}

            backup.publish_manifest(path, record)

            self.assertEqual(json.loads(path.read_text()), record)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertFalse(path.with_name(f".{path.name}.partial").exists())

    def test_refuses_to_replace_an_existing_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.json"
            original = b"owner-preserved manifest\n"
            path.write_bytes(original)

            with self.assertRaises(FileExistsError):
                backup.publish_manifest(path, {"database": "other"})

            self.assertEqual(path.read_bytes(), original)
            self.assertFalse(path.with_name(f".{path.name}.partial").exists())

    def test_refuses_to_reuse_a_preexisting_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.json"
            temporary = path.with_name(f".{path.name}.partial")
            original = b"preserve this incomplete artifact for operator review"
            temporary.write_bytes(original)

            with self.assertRaises(FileExistsError):
                backup.publish_manifest(path, {"database": "cairn_integration"})

            self.assertFalse(path.exists())
            self.assertEqual(temporary.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
