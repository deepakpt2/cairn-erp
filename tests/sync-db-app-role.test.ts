import { describe, expect, it } from 'vitest';
import { managedRoleCommand } from '../scripts/sync-db-app-role';

describe('managed application-role DDL', () => {
  it('creates a non-privileged application login using safe defaults', () => {
    expect(managedRoleCommand(false)).toBe(
      'CREATE ROLE cairn_app LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
    );
  });

  it('updates routine login attributes without attempting superuser-only flags', () => {
    const command = managedRoleCommand(true);
    expect(command).toBe(
      'ALTER ROLE cairn_app LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
    );
    expect(command).not.toMatch(/\b(?:SUPERUSER|BYPASSRLS)\b/i);
  });
});
