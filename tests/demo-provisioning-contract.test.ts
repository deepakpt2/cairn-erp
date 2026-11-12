import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDemoTimeline,
  DEMO_CLAIM_LOCK_KEY,
  DEMO_PROVISION_OPERATION,
  isDemoProvisioningEnabled,
} from '../src/platform/tenancy/demo-provisioning';

const module = readFileSync('src/platform/tenancy/demo-provisioning.ts', 'utf8');
const migration = readFileSync('drizzle/9273_demo_installation.sql', 'utf8');
const provisioner = readFileSync('scripts/demo-provision.ts', 'utf8');

describe('dummy-data provisioning', () => {
  it('is off unless the deployment asks for it by name', () => {
    // A misspelled flag must produce an empty deployment, not a populated one.
    // Surrounding space is trimmed, so ' true ' is an affirmative. A value that only
    // looks like one — 'TRUE ' with the space inside the quotes, or 'enabled' — is not.
    for (const off of [undefined, '', ' ', 'false', 'False', '0', 'no', 'off', 'yes please', 'enabled']) {
      expect(isDemoProvisioningEnabled({ ENABLE_DUMMY_DATA: off } as unknown as NodeJS.ProcessEnv)).toBe(false);
    }
    for (const on of ['true', 'TRUE', 'True', ' true ', '1', 'yes', 'YES', 'on']) {
      expect(isDemoProvisioningEnabled({ ENABLE_DUMMY_DATA: on } as unknown as NodeJS.ProcessEnv)).toBe(true);
    }
  });

  it('freezes a three-period calendar ending with the month of deployment', () => {
    const timeline = buildDemoTimeline(new Date(Date.UTC(2026, 7, 19)));
    expect(timeline.openPeriods).toEqual(['202606', '202607', '202608']);
    expect(timeline.startDate).toBe('2026-06-01');
    expect(timeline.endDate).toBe('2026-08-19');
    expect(timeline.anchorDate).toBe('2026-08-19');
  });

  it('spans a year boundary without losing a period', () => {
    const timeline = buildDemoTimeline(new Date(Date.UTC(2026, 0, 5)));
    expect(timeline.openPeriods).toEqual(['202511', '202512', '202601']);
    expect(timeline.startDate).toBe('2025-11-01');
  });

  it('counts business data through a definer function, because row-level security hides it', () => {
    // Measured on a database holding one tenant: a direct scan reported 7 conflicts
    // of 424 and missed the tenant entirely, because every tenant-owned table is
    // filtered to the session's tenant and provisioning has none.
    expect(module).toContain('demo_tenant_table_count()');
    expect(module).toContain('demo_eligibility_conflicts()');
    expect(migration).toMatch(/security definer/i);
    // Neither takes an argument, so the elevated right cannot be aimed elsewhere.
    expect(migration).toContain('create or replace function demo_tenant_table_count()');
    expect(migration).toContain('create or replace function demo_eligibility_conflicts()');
  });

  it('treats an unreadable catalogue as a failed survey, never as an empty database', () => {
    expect(module).toContain('tablesScanned === 0');
    expect(module).toContain('Refusing rather than assuming an empty database');
  });

  it('holds one lock for the whole run and a different one for the claim', () => {
    // One key for both made a run wait on itself: session and transaction advisory
    // locks share a lock space, so the claim blocked behind the run lock it already
    // held. Two keys, and the reason recorded where the next person will look.
    expect(DEMO_CLAIM_LOCK_KEY).not.toBe('cairn/demo-provisioning/run');
    expect(module).toContain('pg_try_advisory_lock');
    expect(module).toContain('pg_advisory_xact_lock');
  });

  it('never grants itself the right to erase its own record', () => {
    expect(migration).toContain('grant select, insert, update on demo_installation to cairn_app');
    expect(migration).toContain('grant select, insert, update on demo_installation_phase to cairn_app');
    expect(migration).not.toMatch(/grant[^;]*delete[^;]*demo_installation/i);
  });

  it('refuses rather than offering a way past the refusal', () => {
    // There is no force flag, no reset, no truncate — and no code path that deletes.
    expect(module).not.toMatch(/\bdelete from\b/i);
    expect(module).not.toMatch(/\btruncate\b/i);
    expect(provisioner).not.toMatch(/force/i);
    expect(provisioner).toContain('PROHIBITED_DATABASES');
    for (const database of ['cairn_b210', 'cairn_hr_accept', 'cairn_demo', 'cairn_acceptance', 'cairn_integration']) {
      expect(provisioner).toContain(database);
    }
  });

  it('leaves a failed installation visible instead of cleaning it up', () => {
    expect(provisioner).toContain('It will not be resumed automatically');
    // The phase is marked failed by the module, and the installation with it: a run
    // that died is recorded as died rather than tidied away.
    expect(module).toContain("set status = 'FAILED', completed_at = now()");
    expect(module).toContain("set status = 'FAILED', updated_at = now(), completed_at = now()");
    expect(DEMO_PROVISION_OPERATION).toMatch(/^DEMO_PROVISION_V\d+$/);
  });
});
