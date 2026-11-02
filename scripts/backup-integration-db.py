#!/usr/bin/env python3
"""Create a verified, mode-0600 logical backup of the approved persistent integration DB.

The password is read only from the secure environment file and passed to PostgreSQL
clients through PGPASSWORD, never in argv or output. Restore rehearsals must use a
new, clearly named cairn_migration_test_YYYYMMDD_<run-id> database.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

EXPECTED_DATABASE = "cairn_integration"
EXPECTED_HOST = "127.0.0.1"
EXPECTED_PORT = 55435
EXPECTED_RUNTIME_ROLE = "cairn_app"
EXPECTED_MIGRATION_ROLE = "cairn_integration_migrator"
EXPECTED_DATA_DIRECTORY = "/home/cairn/.local/share/postgresql/cairn_integration/data"
EXPECTED_SYSTEM_IDENTIFIER = "7703407688127814566"


def fail(message: str, code: int = 1) -> "NoReturn":
    print(f"integration backup refused: {message}; credentials withheld.", file=sys.stderr)
    raise SystemExit(code)


def load_env(path: Path) -> dict[str, str]:
    if not path.is_file() or path.stat().st_mode & 0o077:
        fail("secure environment file is missing or accessible to group/other users")
    values: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def parse_url(raw: str | None, name: str):
    if not raw:
        fail(f"{name} must be explicitly configured")
    try:
        url = urlsplit(raw)
        port = url.port
    except Exception:
        fail(f"{name} is invalid")
    if url.scheme not in {"postgres", "postgresql"} or url.query or url.fragment:
        fail(f"{name} must be a plain PostgreSQL URL without query parameters")
    return url, unquote(url.username or ""), unquote(url.password or ""), unquote(url.path.lstrip("/")), port


def run(argv: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(argv, env=env, text=True, capture_output=True, check=False)
    except OSError:
        fail(f"required PostgreSQL utility {Path(argv[0]).name} could not be started")
    if result.returncode:
        fail(f"{Path(argv[0]).name} failed with exit {result.returncode}")
    return result


def main() -> None:
    env_path = Path(os.environ.get(
        "CAIRN_INTEGRATION_ENV_FILE",
        str(Path.home() / ".config/cairn-erp/cairn_integration.env"),
    ))
    settings = load_env(env_path)
    if settings.get("CAIRN_INTEGRATION_MODE") != "persistent":
        fail("only CAIRN_INTEGRATION_MODE=persistent is eligible for this backup")
    if settings.get("CAIRN_TEST_DB_NAME") != EXPECTED_DATABASE:
        fail("the explicit database name is not cairn_integration")
    if settings.get("CAIRN_INTEGRATION_DATA_DIRECTORY") != EXPECTED_DATA_DIRECTORY:
        fail("the configured data directory does not match the approved cluster")
    if settings.get("CAIRN_INTEGRATION_SYSTEM_IDENTIFIER") != EXPECTED_SYSTEM_IDENTIFIER:
        fail("the configured system identifier does not match the approved cluster")

    runtime, runtime_role, runtime_password, runtime_db, runtime_port = parse_url(settings.get("DATABASE_URL"), "DATABASE_URL")
    migration, migration_role, migration_password, migration_db, migration_port = parse_url(settings.get("MIGRATION_DATABASE_URL"), "MIGRATION_DATABASE_URL")
    for name, url, role, password, database, port in (
        ("DATABASE_URL", runtime, runtime_role, runtime_password, runtime_db, runtime_port),
        ("MIGRATION_DATABASE_URL", migration, migration_role, migration_password, migration_db, migration_port),
    ):
        if url.hostname != EXPECTED_HOST or port != EXPECTED_PORT or database != EXPECTED_DATABASE or not password:
            fail(f"{name} does not match the approved endpoint and database")
    if runtime_role != EXPECTED_RUNTIME_ROLE or migration_role != EXPECTED_MIGRATION_ROLE:
        fail("runtime and migration roles do not match the approved role split")
    if runtime_password == migration_password:
        fail("runtime and migration passwords must be distinct")
    if settings.get("CAIRN_DB_HOST") != EXPECTED_HOST or settings.get("CAIRN_DB_PORT") != str(EXPECTED_PORT):
        fail("identity-verification endpoint settings do not match")
    if settings.get("CAIRN_DB_USER") != EXPECTED_RUNTIME_ROLE or settings.get("CAIRN_DB_PASSWORD") != runtime_password:
        fail("identity-verification role settings do not match")

    child_env = os.environ.copy()
    child_env["PGPASSWORD"] = migration_password
    identity_sql = (
        "select current_database() || '|' || current_user || '|' || data_directory || '|' || system_identifier || '|' || migrations "
        "from cairn_integration_guard.cluster_identity(), "
        "(select count(*)::text as migrations from cairn_migration) m"
    )
    identity = run([
        "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-h", EXPECTED_HOST,
        "-p", str(EXPECTED_PORT), "-U", EXPECTED_MIGRATION_ROLE,
        "-d", EXPECTED_DATABASE, "-c", identity_sql,
    ], child_env).stdout.strip()
    expected_prefix = f"{EXPECTED_DATABASE}|{EXPECTED_MIGRATION_ROLE}|{EXPECTED_DATA_DIRECTORY}|{EXPECTED_SYSTEM_IDENTIFIER}|"
    if not identity.startswith(expected_prefix):
        fail("live database identity does not match the approved target")
    migration_count_text = identity.rsplit("|", 1)[-1]
    if not migration_count_text.isdigit() or int(migration_count_text) < 333:
        fail("migration ledger is incomplete")

    backup_dir = Path.home() / ".local/backups/cairn_integration"
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup_dir.chmod(0o700)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stem = f"cairn_integration_{timestamp}"
    backup = backup_dir / f"{stem}.dump"
    partial = backup_dir / f".{stem}.partial"
    manifest = backup_dir / f"{stem}.json"
    if backup.exists() or partial.exists() or manifest.exists():
        fail("a backup with this timestamp already exists")

    dump_args = [
        "pg_dump", "--format=custom", "--file", str(partial), "-h", EXPECTED_HOST,
        "-p", str(EXPECTED_PORT), "-U", EXPECTED_MIGRATION_ROLE, "-d", EXPECTED_DATABASE,
    ]
    run(dump_args, child_env)
    partial.chmod(0o600)
    run(["pg_restore", "--list", str(partial)], child_env)
    digest = hashlib.sha256(partial.read_bytes()).hexdigest()
    size = partial.stat().st_size
    partial.replace(backup)
    backup.chmod(0o600)

    record = {
        "format": "PostgreSQL custom archive",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "database": EXPECTED_DATABASE,
        "server": f"{EXPECTED_HOST}:{EXPECTED_PORT}",
        "data_directory": EXPECTED_DATA_DIRECTORY,
        "system_identifier": EXPECTED_SYSTEM_IDENTIFIER,
        "migration_count": int(migration_count_text),
        "archive": backup.name,
        "archive_bytes": size,
        "sha256": digest,
        "verified_by": "pg_restore --list",
        "restore_owner": "cairn superuser or an equivalent administrator; restore roles must already exist",
    }
    manifest.write_text(json.dumps(record, indent=2) + "\n")
    manifest.chmod(0o600)
    print(f"Verified integration backup created: {backup} ({size} bytes, SHA-256 {digest[:16]}…, {migration_count_text} migrations).")
    print("Archive listing and target identity verified; passwords and URLs were not printed.")


if __name__ == "__main__":
    main()
