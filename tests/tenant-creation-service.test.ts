import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTenant, TenancyError } from '../src/platform/tenancy';
import { STRUCTURE_ACTIVITIES } from '../src/platform/tenancy/standard-structure';
import { withTenant } from '../src/platform/db/client';
import { destroyTenant } from './helpers';

/**
 * Tenant creation as SCR-032 left it: a tenant is created, a company is not.
 *
 * Three of these paths had never been executed by anything before this file. The empty
 * path existed in the service but every caller passed `activateStandardPackage`, so it
 * was dead code that also lied — it marked `CFG.ORG.COMPANYCODE.DEFINE` complete on a
 * tenant with no company code. The copy path did not exist at all. And nothing tested
 * that two tenants may share a name, because the field set had claimed the name was
 * unique until R-74 retracted it.
 */

const PASSWORD = 'tenant-service-2026';
const KEYS = ['ZT01', 'ZT02', 'ZT03', 'ZT04', 'ZT05'] as const;

function input(clientKey: string, name: string) {
  return {
    clientKey,
    name,
    country: 'KW',
    currency: 'KWD',
    timezone: 'Asia/Kuwait',
    administrator: {
      username: 'first.admin',
      fullName: 'First Administrator',
      email: 'first.admin@cairn.local',
      password: PASSWORD,
    },
    createdBy: 'TEST',
  };
}

async function count(client: string, table: string): Promise<number> {
  const rows = (await withTenant(
    client,
    (tx) => tx.execute(sql.raw(`select count(*)::int as n from ${table}`)),
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function completedActivities(client: string): Promise<string[]> {
  const rows = (await withTenant(
    client,
    (tx) =>
      tx.execute(
        sql`select activity_code from config_activity_status
             where status = 'COMPLETED' order by activity_code`,
      ),
  )) as unknown as Array<{ activity_code: string }>;
  return rows.map((row) => row.activity_code);
}

async function tenantSetting(client: string): Promise<string | null> {
  const rows = (await withTenant(
    client,
    (tx) => tx.execute(sql`select fiscal_year_variant from client_settings`),
  )) as unknown as Array<{ fiscal_year_variant: string | null }>;
  return rows[0]?.fiscal_year_variant ?? null;
}

describe('tenant creation without a company', () => {
  afterAll(async () => {
    for (const key of KEYS) {
      // A refused creation leaves nothing to destroy, and destroying nothing throws.
      if (await count(key, 'client')) await destroyTenant(key);
    }
  });

  it('creates an empty tenant that owns nothing and claims nothing', async () => {
    const result = await createTenant(input('ZT01', 'Empty Tenant'));

    expect(result.client).toBe('ZT01');
    expect(result.administratorUsername).toBe('first.admin');
    expect(result.packageVersion).toBeUndefined();
    expect(result.accountsCreated).toBeUndefined();

    // The tenant and its first user exist; no configuration does.
    expect(await count('ZT01', 'client')).toBe(1);
    expect(await count('ZT01', 'app_user')).toBe(1);
    expect(await count('ZT01', 'company_code')).toBe(0);
    expect(await count('ZT01', 'chart_of_accounts')).toBe(0);
    expect(await count('ZT01', 'gl_account')).toBe(0);
    expect(await count('ZT01', 'fiscal_year_variant')).toBe(0);
    expect(await count('ZT01', 'posting_period_variant')).toBe(0);
    expect(await count('ZT01', 'controlling_area')).toBe(0);
    expect(await count('ZT01', 'plant')).toBe(0);
    expect(await count('ZT01', 'sales_org')).toBe(0);
    expect(await tenantSetting('ZT01')).toBeNull();

    // Only what creation actually did is complete: the tenant, its roles and its user.
    // Not one configuration activity, and above all not CFG.ORG.COMPANYCODE.DEFINE,
    // which the dead branch used to mark on a tenant with no company code.
    expect(await completedActivities('ZT01')).toEqual([
      'CFG.PLT.CLIENT.DEFINE',
      'CFG.PLT.ROLE.DEFINE',
      'CFG.PLT.USER.CREATE',
    ]);
  });

  it('refuses to copy a tenant and writes nothing at all', async () => {
    const attempt = createTenant({ ...input('ZT02', 'Copied Tenant'), creationType: 'copy' });
    await expect(attempt).rejects.toBeInstanceOf(TenancyError);
    await expect(attempt).rejects.toThrow('Copying a tenant is not available yet.');

    // The refusal is raised before any write, so there is no half-created tenant, no
    // user, and no workbench state to clean up.
    expect(await count('ZT02', 'client')).toBe(0);
    expect(await count('ZT02', 'app_user')).toBe(0);
    expect(await count('ZT02', 'config_activity_status')).toBe(0);

    // A remedy is part of a refusal in this product; an explanation without one leaves
    // the person who hit it with nowhere to go.
    try {
      await createTenant({ ...input('ZT02', 'Copied Tenant'), creationType: 'copy' });
      throw new Error('the copy creation type was not refused');
    } catch (error) {
      expect((error as TenancyError).remedy).toMatch(/Create an empty tenant/);
    }
  });

  it('applies the standard general data and still creates no company', async () => {
    const result = await createTenant({
      ...input('ZT03', 'Standard Tenant'),
      creationType: 'standard',
    });

    expect(result.packageVersion).toBe('INTL-STD-3');
    expect(result.accountsCreated).toBe(74);

    // What the package holds: data that is true for any company.
    expect(await count('ZT03', 'chart_of_accounts')).toBe(1);
    expect(await count('ZT03', 'gl_account')).toBe(74);
    expect(await count('ZT03', 'fiscal_year_variant')).toBe(1);
    expect(await count('ZT03', 'fiscal_year_period')).toBe(16);
    expect(await count('ZT03', 'posting_period_variant')).toBe(1);
    expect(await count('ZT03', 'distribution_channel')).toBeGreaterThan(0);
    expect(await count('ZT03', 'division')).toBeGreaterThan(0);
    expect(await count('ZT03', 'purchasing_group')).toBeGreaterThan(0);
    expect(await tenantSetting('ZT03')).toBe('K4');

    // And what it no longer holds: anything belonging to a company. This is the point
    // of the whole SCR — a tenant that took the standard package still has no legal
    // entity, no structure and no books of its own.
    expect(await count('ZT03', 'company_code')).toBe(0);
    expect(await count('ZT03', 'controlling_area')).toBe(0);
    expect(await count('ZT03', 'credit_control_area')).toBe(0);
    expect(await count('ZT03', 'plant')).toBe(0);
    expect(await count('ZT03', 'storage_location')).toBe(0);
    expect(await count('ZT03', 'purchasing_org')).toBe(0);
    expect(await count('ZT03', 'sales_org')).toBe(0);
    expect(await count('ZT03', 'sales_area')).toBe(0);

    const completed = await completedActivities('ZT03');
    // The eleven the reduced package marks, plus the three platform ones, asserted as an
    // exact list rather than a count. Measured by execution, which corrected two readings
    // of the source: the payment terms applier records a change document under
    // CFG.FIN.PAYTERMS.DEFINE but never marks that activity, so it is not one of the
    // package's marks and the pre-split total was twenty-nine rather than thirty.
    expect(completed).toEqual([
      'CFG.FIN.COA.DEFINE',
      'CFG.FIN.DOCTYPE.DEFINE',
      'CFG.FIN.EXRATE.MAINTAIN',
      'CFG.FIN.FYV.DEFINE',
      'CFG.FIN.PPV.DEFINE',
      'CFG.INV.MATERIALGROUP.DEFINE',
      'CFG.INV.MATERIALTYPE.DEFINE',
      'CFG.ORG.DISTCHANNEL.DEFINE',
      'CFG.ORG.DIVISION.DEFINE',
      'CFG.PLT.CLIENT.DEFINE',
      'CFG.PLT.ROLE.DEFINE',
      'CFG.PLT.USER.CREATE',
      'CFG.PROC.PURGROUP.DEFINE',
      'CFG.PROD.MRPCONTROLLER.DEFINE',
    ]);
    for (const code of STRUCTURE_ACTIVITIES) {
      expect(completed, `${code} describes a company and must not be marked at creation`).not.toContain(code);
    }
  });

  it('lets two tenants share a name and refuses a repeated key', async () => {
    // R-74: only the key identifies a tenant. The form claims no uniqueness for the
    // name and the service enforces none.
    await createTenant(input('ZT04', 'Same Name'));
    await createTenant(input('ZT05', 'Same Name'));
    expect(await count('ZT04', 'client')).toBe(1);
    expect(await count('ZT05', 'client')).toBe(1);

    const duplicate = createTenant(input('ZT04', 'Another Tenant'));
    await expect(duplicate).rejects.toBeInstanceOf(TenancyError);
    await expect(duplicate).rejects.toThrow('Tenant ZT04 already exists.');
    // The refusal left the original alone.
    expect(await count('ZT04', 'client')).toBe(1);
  });
});
