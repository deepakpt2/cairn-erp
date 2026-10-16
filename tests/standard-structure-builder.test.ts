import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { withTenant } from '../src/platform/db/client';
import {
  applyStandardStructure,
  STANDARD_STRUCTURE,
} from '../src/platform/tenancy/standard-structure';
import {
  companyCode,
  controllingArea,
  controllingAreaCompany,
  creditControlArea,
  plant,
  purchasingOrg,
  purchasingOrgPlant,
  salesArea,
  salesOrg,
  salesOrgDistributionChannel,
  salesOrgDivision,
  salesOrgText,
  storageLocation,
} from '../src/modules/foundation/schema';
import { centralAddress } from '../src/modules/foundation/central-address-schema';
import { changeDocument, changeDocumentItem } from '../src/platform/tables/audit-trail';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * The company-specific half of the standard package, in the order it has to be
 * deleted: every table above a given entry holds a foreign key into it, so
 * `sales_area` goes first because it points at the sales organisation and at both
 * of its assignment tables, and `credit_control_area` goes last because the company
 * code points at it. `plant.default_storage_location` is deliberately not a foreign
 * key, which is the only reason this list is a straight line rather than a knot.
 */
const STRUCTURE_TABLES = [
  { name: 'sales_area', table: salesArea },
  { name: 'sales_org_division', table: salesOrgDivision },
  { name: 'sales_org_distribution_channel', table: salesOrgDistributionChannel },
  { name: 'sales_org_text', table: salesOrgText },
  { name: 'sales_org', table: salesOrg },
  { name: 'controlling_area_company', table: controllingAreaCompany },
  { name: 'purchasing_org_plant', table: purchasingOrgPlant },
  { name: 'purchasing_org', table: purchasingOrg },
  { name: 'storage_location', table: storageLocation },
  { name: 'plant', table: plant },
  { name: 'controlling_area', table: controllingArea },
  { name: 'company_code', table: companyCode },
  { name: 'credit_control_area', table: creditControlArea },
] as const;

/**
 * Change documents the structure owns. The package recorded three of these itself and
 * the OX19 service recorded a fourth; the builder has to produce the same set, so the
 * comparison below reads them by class, key, type and activity rather than by id.
 */
const STRUCTURE_CHANGE_CLASSES = [
  'company_code',
  'controlling_area',
  'controlling_area_company',
  'credit_control_area',
  'plant',
  'purchasing_org',
  'purchasing_org_plant',
  'sales_area',
  'sales_org',
  'sales_org_distribution_channel',
  'sales_org_division',
  'sales_org_text',
  'storage_location',
] as const;

/** Columns that legitimately differ between two builds of the same structure. */
const VOLATILE = /(At|addressNumber)$/;

function normalise(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!VOLATILE.test(key)) out[key] = value;
  }
  return out;
}

type Snapshot = Record<string, string[]>;

async function snapshot(client: string): Promise<Snapshot> {
  return withTenant(client, async (tx) => {
    const out: Snapshot = {};
    for (const { name, table } of STRUCTURE_TABLES) {
      const rows = await tx.select().from(table).where(eq(table.client, client));
      out[name] = rows
        .map((row) => JSON.stringify(normalise(row as Record<string, unknown>)))
        .sort();
    }
    const addresses = await tx.select().from(centralAddress).where(eq(centralAddress.client, client));
    out.central_address = addresses
      .map((row) => JSON.stringify(normalise(row as Record<string, unknown>)))
      .sort();
    return out;
  });
}

async function changeProjection(client: string): Promise<string[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        objectClass: changeDocument.objectClass,
        objectKey: changeDocument.objectKey,
        changeType: changeDocument.changeType,
        transactionCode: changeDocument.transactionCode,
      })
      .from(changeDocument)
      .where(
        and(
          eq(changeDocument.client, client),
          inArray(
            changeDocument.objectClass,
            STRUCTURE_CHANGE_CLASSES as unknown as string[],
          ),
        ),
      );
    return rows.map((row) => JSON.stringify(row)).sort();
  });
}

/**
 * Remove the structure the way step A2 will: the rows go, and so do the change
 * documents that recorded them, because a builder that reproduces the structure has to
 * reproduce its audit trail into an empty space rather than on top of the package's.
 */
async function deleteStructure(client: string): Promise<void> {
  await withTenant(client, async (tx) => {
    for (const { table } of STRUCTURE_TABLES) {
      await tx.delete(table).where(eq(table.client, client));
    }
    const documents = await tx
      .select({ id: changeDocument.id })
      .from(changeDocument)
      .where(
        and(
          eq(changeDocument.client, client),
          inArray(
            changeDocument.objectClass,
            STRUCTURE_CHANGE_CLASSES as unknown as string[],
          ),
        ),
      );
    const ids = documents.map((row) => row.id);
    if (ids.length) {
      await tx.delete(changeDocumentItem).where(inArray(changeDocumentItem.changeDocumentId, ids));
      await tx.delete(changeDocument).where(inArray(changeDocument.id, ids));
    }
  });
}

describe('standard structure builder', () => {
  let tenant: TestTenant;
  let before: Snapshot;
  let changesBefore: string[];

  /**
   * The point of this file. Step A2 of SCR-032 took the company-specific rows out of
   * the standard package and left this builder as the only thing that writes them.
   * Eighteen test files and twelve browser targets were written against the structure
   * the package provided and were not allowed to change, so the builder had to produce
   * the same rows, not merely rows that happen to satisfy them.
   *
   * This test was written and published green while the package still wrote the
   * structure (commit 75cff49), which is when the comparison against the package was
   * actually made — and it caught two things the builder was missing, the controlling
   * area link and three change documents. Now that the package no longer writes them,
   * the same test proves something narrower and still worth having: the builder
   * reproduces the structure exactly after it is deleted, and a repeat call changes
   * nothing. The values the package used to write are pinned as constants in the test
   * below, so the historical half of the claim stays under test rather than living only
   * in a commit message.
   */
  it('rebuilds the structure row for row after it is deleted', async () => {
    tenant = await createTenant('structure-builder');
    before = await snapshot(tenant.client);
    changesBefore = await changeProjection(tenant.client);
    expect(changesBefore.length).toBeGreaterThan(0);

    // The package really did write the structure; otherwise the comparison below
    // would pass by comparing two empty sets.
    expect(before.company_code).toHaveLength(1);
    expect(before.plant).toHaveLength(1);
    expect(before.storage_location).toHaveLength(4);
    expect(before.controlling_area).toHaveLength(1);
    expect(before.credit_control_area).toHaveLength(1);
    expect(before.purchasing_org).toHaveLength(1);
    expect(before.purchasing_org_plant).toHaveLength(1);
    expect(before.sales_org).toHaveLength(1);
    expect(before.sales_org_text).toHaveLength(1);
    expect(before.sales_org_distribution_channel).toHaveLength(1);
    expect(before.sales_org_division).toHaveLength(1);
    expect(before.sales_area).toHaveLength(1);

    await deleteStructure(tenant.client);
    const emptied = await snapshot(tenant.client);
    for (const { name } of STRUCTURE_TABLES) {
      expect(emptied[name], `${name} should be empty after deletion`).toHaveLength(0);
    }

    const result = await applyStandardStructure({
      client: tenant.client,
      companyCode: tenant.companyCode,
      companyName: `Test company ${tenant.client}`,
      currency: tenant.currency,
      country: 'KW',
      changedBy: 'TEST',
    });
    expect(result.created).toBe(true);
    expect(result.companyCode).toBe(STANDARD_STRUCTURE.companyCode);
    expect(result.storageLocations).toBe(4);

    const after = await snapshot(tenant.client);
    for (const { name } of STRUCTURE_TABLES) {
      expect(after[name], `${name} differs from what the package wrote`).toEqual(before[name]);
    }
    expect(await changeProjection(tenant.client)).toEqual(changesBefore);

    // The sales organisation's address is the one value that cannot be equal: the
    // address table has no natural key, so a rebuild allocates a fresh number and
    // leaves the package's address behind. Assert the replacement is equivalent
    // rather than pretending the column matches.
    expect(after.central_address.length).toBeGreaterThan(before.central_address.length);
    await withTenant(tenant.client, async (tx) => {
      const rows = await tx
        .select({ addressNumber: salesOrg.addressNumber, country: centralAddress.country })
        .from(salesOrg)
        .innerJoin(centralAddress, eq(centralAddress.addressNumber, salesOrg.addressNumber))
        .where(eq(salesOrg.client, tenant.client));
      expect(rows).toHaveLength(1);
      expect(rows[0].country).toBe('KW');
    });
  });

  it('changes nothing when the structure is already there', async () => {
    const addressesBefore = (await snapshot(tenant.client)).central_address.length;

    const second = await applyStandardStructure({
      client: tenant.client,
      companyCode: tenant.companyCode,
      companyName: `Test company ${tenant.client}`,
      currency: tenant.currency,
      country: 'KW',
      changedBy: 'TEST',
    });
    expect(second.created).toBe(false);

    const after = await snapshot(tenant.client);
    for (const { name } of STRUCTURE_TABLES) {
      expect(after[name], `${name} changed on a repeat call`).toEqual(before[name]);
    }
    // A repeat call must not allocate another address: with no natural key to conflict
    // on, an unconditional insert would orphan one row per call.
    expect(after.central_address).toHaveLength(addressesBefore);
    // ...and must not record the same change twice.
    expect(await changeProjection(tenant.client)).toEqual(changesBefore);
  });

  it('hangs the whole structure from the company code the caller names', async () => {
    // Nine fixture files ask for a company code other than 1000. The builder has to
    // link the plant, the purchasing organisation and the sales organisation to the
    // code it is given while keeping their own keys, which stay 1000 exactly as the
    // package kept them. The structure is removed first because a tenant that still
    // has the package's rows cannot show the difference.
    const custom = await createTenant('structure-builder-2');
    await deleteStructure(custom.client);

    const result = await applyStandardStructure({
      client: custom.client,
      companyCode: '2000',
      companyName: `Test company ${custom.client}`,
      currency: custom.currency,
      country: 'KW',
      changedBy: 'TEST',
    });
    expect(result.created).toBe(true);
    expect(result.companyCode).toBe('2000');

    await withTenant(custom.client, async (tx) => {
      const companies = await tx
        .select()
        .from(companyCode)
        .where(eq(companyCode.client, custom.client));
      expect(companies).toHaveLength(1);
      expect(companies[0].companyCode).toBe('2000');

      const plants = await tx.select().from(plant).where(eq(plant.client, custom.client));
      expect(plants).toHaveLength(1);
      expect(plants[0].plant).toBe(STANDARD_STRUCTURE.plant);
      expect(plants[0].companyCode).toBe('2000');

      const purchasing = await tx
        .select()
        .from(purchasingOrg)
        .where(eq(purchasingOrg.client, custom.client));
      expect(purchasing[0].companyCode).toBe('2000');

      const sales = await tx.select().from(salesOrg).where(eq(salesOrg.client, custom.client));
      expect(sales[0].companyCode).toBe('2000');
    });

    await destroyTenant(custom.client);
  });

  it('pins the keys, names and defaults the standard package used to write', async () => {
    // The round-trip test above can only prove the builder agrees with itself. These are
    // the values the package wrote before SCR-032 reduced it, kept as assertions so that
    // a fixture written against them — eighteen test files and twelve browser targets —
    // cannot drift silently.
    await withTenant(tenant.client, async (tx) => {
      const [company] = await tx
        .select()
        .from(companyCode)
        .where(eq(companyCode.client, tenant.client));
      expect(company.companyCode).toBe('1000');
      expect(company.name).toBe(`Test company ${tenant.client}`);
      expect(company.chartOfAccounts).toBe('CA01');
      expect(company.fiscalYearVariant).toBe('K4');
      expect(company.postingPeriodVariant).toBe('C001');
      expect(company.creditControlArea).toBe('0001');
      expect(company.intercompanyClearingAccount).toBe('110100');
      expect(company.country).toBe('KW');

      const [credit] = await tx
        .select()
        .from(creditControlArea)
        .where(eq(creditControlArea.client, tenant.client));
      expect(credit.creditControlArea).toBe('0001');
      expect(credit.name).toBe('Standard credit control area');
      expect(credit.warningThresholdPercent).toBe(90);

      const [area] = await tx
        .select()
        .from(controllingArea)
        .where(eq(controllingArea.client, tenant.client));
      expect(area.controllingArea).toBe('A000');
      expect(area.name).toBe('Standard controlling area');
      expect(area.companyCodeScope).toBe('SINGLE');
      expect(area.fiscalYearVariant).toBe('K4');

      const [link] = await tx
        .select()
        .from(controllingAreaCompany)
        .where(eq(controllingAreaCompany.client, tenant.client));
      expect(link.controllingArea).toBe('A000');
      expect(link.companyCode).toBe('1000');

      const [site] = await tx.select().from(plant).where(eq(plant.client, tenant.client));
      expect(site.plant).toBe('1000');
      expect(site.name).toBe(`Test company ${tenant.client} — Main plant`);
      expect(site.defaultStorageLocation).toBe('0001');
      expect(site.isProductionSite).toBe(true);
      expect(site.isStorageSite).toBe(true);

      const locations = await tx
        .select()
        .from(storageLocation)
        .where(eq(storageLocation.client, tenant.client));
      expect(locations.map((row) => row.storageLocation).sort()).toEqual([
        '0001',
        '0002',
        '0003',
        '0099',
      ]);

      const [purchasing] = await tx
        .select()
        .from(purchasingOrg)
        .where(eq(purchasingOrg.client, tenant.client));
      expect(purchasing.purchasingOrg).toBe('1000');
      expect(purchasing.name).toBe(`Test company ${tenant.client} — Purchasing`);
      const [orgPlant] = await tx
        .select()
        .from(purchasingOrgPlant)
        .where(eq(purchasingOrgPlant.client, tenant.client));
      expect(orgPlant.purchasingOrg).toBe('1000');
      expect(orgPlant.plant).toBe('1000');

      const [sales] = await tx
        .select()
        .from(salesOrg)
        .where(eq(salesOrg.client, tenant.client));
      expect(sales.salesOrg).toBe('1000');
      const [text] = await tx
        .select()
        .from(salesOrgText)
        .where(eq(salesOrgText.client, tenant.client));
      expect(text.name).toBe('Standard Sales');
      expect(text.languageKey).toBe('E');
      expect(text.formText?.trim()).toBe('STANDARD'); // char(n), so it comes back padded
      const [channel] = await tx
        .select()
        .from(salesOrgDistributionChannel)
        .where(eq(salesOrgDistributionChannel.client, tenant.client));
      expect(channel.distributionChannel).toBe('01');
      const [divisionRow] = await tx
        .select()
        .from(salesOrgDivision)
        .where(eq(salesOrgDivision.client, tenant.client));
      expect(divisionRow.division).toBe('01');
      const [area2] = await tx
        .select()
        .from(salesArea)
        .where(eq(salesArea.client, tenant.client));
      expect(area2.name).toBe('Direct sales — manufactured products');
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });
});
