/**
 * SCR-031 / OBBO stage 5 — the posting period variant registry and its refusals.
 *
 * The tenant is created the way the application creates one, through a tenant-scoped
 * transaction, so every assertion below is made twice: once against what the service returns
 * and once against what the database holds. A service that reports success while the row says
 * otherwise is the failure these tests exist to catch.
 *
 * The intervals matter as much as the variant here. A posting period variant is not a label,
 * it is the set of intervals a Company Code posts against, so "created" means the variant row
 * and five interval rows that agree with the constant the screen renders, and "deleted" means
 * both are gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { companyCode, postingPeriodRule, postingPeriodVariant } from '@/modules/foundation/schema';
import {
  DEFAULT_INTERVALS,
  PostingPeriodVariantError,
  deletePostingPeriodVariant,
  describeIntervalSet,
  listPostingPeriodVariants,
  savePostingPeriodVariant,
} from '@/modules/foundation/posting-period-variant-definition';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'SCR031_TEST';
const ACTIVITY = 'CFG.FIN.PPV.DEFINE';
const OBJECT_CLASS = 'posting_period_variant';

/** The variant the standard package ships, and the Company Code that posts against it. */
const SEEDED = 'C001';

let tenant: TestTenant | null = null;
let prerequisiteTenant: TestTenant | null = null;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-031 stage 5 tenant fixture was not initialized.');
  return tenant;
}

/**
 * The workbench row for the activity itself. Completing an activity updates a row rather than
 * inventing one, and a fixture tenant is created after the seed runs, so without this the
 * service would have nothing to mark and the assertion below would prove nothing.
 */
async function setActivityStatus(client: string, activityCode: string, status: string) {
  await withTenant(client, (tx) =>
    tx
      .insert(configActivityStatus)
      .values({
        client,
        activityCode,
        status,
        completedAt: status === 'COMPLETED' ? new Date() : null,
        completedBy: status === 'COMPLETED' ? ACTOR : null,
        createdBy: ACTOR,
      })
      .onConflictDoUpdate({
        target: [configActivityStatus.client, configActivityStatus.activityCode],
        set: {
          status,
          completedAt: status === 'COMPLETED' ? new Date() : null,
          completedBy: status === 'COMPLETED' ? ACTOR : null,
        },
      }),
  );
}

async function storedVariant(client: string, variant: string) {
  const rows = await withTenant(client, (tx) =>
    tx
      .select()
      .from(postingPeriodVariant)
      .where(and(eq(postingPeriodVariant.client, client), eq(postingPeriodVariant.variant, variant)))
      .limit(1),
  );
  return rows[0] ?? null;
}

async function storedIntervals(client: string, variant: string) {
  return withTenant(client, (tx) =>
    tx
      .select()
      .from(postingPeriodRule)
      .where(and(eq(postingPeriodRule.client, client), eq(postingPeriodRule.variant, variant)))
      .orderBy(asc(postingPeriodRule.accountType)),
  );
}

async function history(client: string, key: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, OBJECT_CLASS, key));
}

async function assignCompanyCode(client: string, code: string, variant: string | null) {
  await withTenant(client, (tx) =>
    tx
      .update(companyCode)
      .set({ postingPeriodVariant: variant })
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, code))),
  );
}

beforeAll(async () => {
  tenant = await createTenant('scr031-obbo-stage5');
  // A second tenant, left unconfigured on purpose: the prerequisite refusal needs one whose
  // fiscal year variant was never assigned, and this tenant is about to have its.
  prerequisiteTenant = await createTenant('scr031-obbo-prerequisite');

  const { client } = fixture();
  await setActivityStatus(client, 'CFG.FIN.FYV.ASSIGN', 'COMPLETED');
  await setActivityStatus(client, ACTIVITY, 'NOT_STARTED');
});

afterAll(async () => {
  if (prerequisiteTenant) await destroyTenant(prerequisiteTenant.client);
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('SCR-031 / OBBO — defining a posting period variant', () => {
  it('refuses while no Company Code has a fiscal year variant to open periods in', async () => {
    const client = prerequisiteTenant?.client;
    if (!client) throw new Error('The prerequisite tenant was not created.');

    const attempt = savePostingPeriodVariant({
      client,
      changedBy: ACTOR,
      mode: 'CREATE',
      variant: 'ZP0',
      name: 'Never written',
    });

    await expect(attempt).rejects.toBeInstanceOf(PostingPeriodVariantError);
    await expect(attempt).rejects.toThrow(/prerequisites are incomplete: CFG\.FIN\.FYV\.ASSIGN/);
    await expect(storedVariant(client, 'ZP0')).resolves.toBeNull();
  });

  it('refuses a key that is not up to four letters or digits', async () => {
    const { client } = fixture();

    const tooLong = savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: 'ZP123', name: 'Never written',
    });
    await expect(tooLong).rejects.toThrow(/at most four characters/);

    const empty = savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: '   ', name: 'Never written',
    });
    await expect(empty).rejects.toThrow(/Posting Period Variant is required/);

    const punctuation = savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: 'ZP!', name: 'Never written',
    });
    await expect(punctuation).rejects.toThrow(/one to four letters or digits/);

    expect(await listPostingPeriodVariants(client)).toHaveLength(1);
  });

  it('refuses a description that is missing or longer than the contract allows', async () => {
    const { client } = fixture();

    const missing = savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: 'ZP2', name: '   ',
    });
    await expect(missing).rejects.toThrow(/description is required/);

    const tooLong = savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: 'ZP2', name: 'x'.repeat(31),
    });
    await expect(tooLong).rejects.toThrow(/at most thirty characters/);

    expect(await storedVariant(client, 'ZP2')).toBeNull();
  });

  it('accepts a description of exactly thirty characters, which is the contract width', async () => {
    const { client } = fixture();
    const name = 'x'.repeat(30);

    const saved = await savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: 'ZP2', name,
    });

    expect(saved.mode).toBe('CREATED');
    const stored = await storedVariant(client, 'ZP2');
    expect(stored?.name).toBe(name);
    expect(stored?.name).toHaveLength(30);
  });

  it('refuses a new entry over a key that is already defined', async () => {
    const { client } = fixture();

    const attempt = savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: SEEDED, name: 'Somebody else wording',
    });

    await expect(attempt).rejects.toBeInstanceOf(PostingPeriodVariantError);
    await expect(attempt).rejects.toThrow(/is already defined in this tenant/);
    // The refusal must leave the seeded description alone rather than half-writing it.
    expect((await storedVariant(client, SEEDED))?.name).toBe('Standard period control');
  });

  it('refuses to change a variant that is not defined', async () => {
    const { client } = fixture();

    const attempt = savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CHANGE', variant: 'ZP9', name: 'Never written',
    });

    await expect(attempt).rejects.toThrow(/is not defined in this tenant/);
    expect(await storedVariant(client, 'ZP9')).toBeNull();
  });

  it('creates the variant with one interval per account type, exactly as the screen promises', async () => {
    const { client } = fixture();

    const saved = await savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: 'ZP1', name: 'Probe lifecycle variant',
    });

    expect(saved).toMatchObject({
      variant: 'ZP1', name: 'Probe lifecycle variant', mode: 'CREATED',
      intervalsCreated: DEFAULT_INTERVALS.length,
    });

    const stored = await storedVariant(client, 'ZP1');
    expect(stored?.isActive).toBe(true);
    expect(stored?.createdBy).toBe(ACTOR);

    const intervals = await storedIntervals(client, 'ZP1');
    expect(intervals).toHaveLength(DEFAULT_INTERVALS.length);
    // Compared row by row against the constant the screen renders, so the note on the form and
    // the rows in the table cannot drift apart without this test noticing.
    for (const expected of DEFAULT_INTERVALS) {
      const actual = intervals.find((row) => row.accountType === expected.accountType);
      expect(actual, `interval ${expected.accountType}`).toBeDefined();
      expect(actual?.periodFrom).toBe(expected.periodFrom);
      expect(actual?.periodTo).toBe(expected.periodTo);
      expect(actual?.yearShiftPast).toBe(expected.yearShiftPast);
      expect(actual?.yearShiftFuture).toBe(expected.yearShiftFuture);
      expect(actual?.allowSpecialPeriods).toBe(expected.allowSpecialPeriods);
      expect(actual?.createdBy).toBe(ACTOR);
    }
  });

  it('holds a lower-case key as upper case, and files the definition', async () => {
    const { client } = fixture();

    const saved = await savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CREATE', variant: 'zp3', name: 'Lower case key',
    });

    expect(saved.variant).toBe('ZP3');
    expect(await storedVariant(client, 'zp3')).toBeNull();
    expect((await storedVariant(client, 'ZP3'))?.name).toBe('Lower case key');

    const documents = await history(client, 'ZP3');
    expect(documents).toHaveLength(1);
    expect(documents[0].changeType).toBe('CREATE');
    expect(documents[0].transactionCode).toBe(ACTIVITY);
    expect(documents[0].changedBy).toBe(ACTOR);

    const byField = new Map(documents[0].items.map((item) => [item.fieldName, item]));
    expect(byField.get('variant')?.newValue).toBe('ZP3');
    expect(byField.get('variant')?.oldValue).toBeNull();
    expect(byField.get('name')?.newValue).toBe('Lower case key');
    expect(byField.get('intervalCount')?.newValue).toBe(String(DEFAULT_INTERVALS.length));
    expect(byField.get('intervals')?.newValue).toBe(describeIntervalSet(DEFAULT_INTERVALS));
    // The key and the interval set decide what the books accept; the description does not.
    expect(byField.get('variant')?.isSecurityRelevant).toBe('true');
    expect(byField.get('intervals')?.isSecurityRelevant).toBe('true');
    expect(byField.get('name')?.isSecurityRelevant).toBe('false');
    expect(byField.get('variant')?.fieldLabel).toBe('Posting Period Variant');
    expect(byField.get('intervals')?.fieldLabel).toBe('Interval set');
  });

  it('marks the activity complete once a variant is defined', async () => {
    const { client } = fixture();

    const status = await withTenant(client, (tx) =>
      tx
        .select({ status: configActivityStatus.status })
        .from(configActivityStatus)
        .where(and(eq(configActivityStatus.client, client), eq(configActivityStatus.activityCode, ACTIVITY))),
    );

    expect(status[0]?.status).toBe('COMPLETED');
  });
});

describe('SCR-031 / OBBO — changing a description', () => {
  it('saves a new description and files only the field that moved', async () => {
    const { client } = fixture();

    const saved = await savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CHANGE', variant: 'ZP1', name: 'Renamed by the suite',
    });

    expect(saved).toMatchObject({ variant: 'ZP1', mode: 'CHANGED', intervalsCreated: 0 });
    expect((await storedVariant(client, 'ZP1'))?.name).toBe('Renamed by the suite');
    // Changing the description must not touch the intervals it was created with.
    expect(await storedIntervals(client, 'ZP1')).toHaveLength(DEFAULT_INTERVALS.length);

    const change = (await history(client, 'ZP1')).find((doc) => doc.changeType === 'CHANGE');
    expect(change).toBeDefined();
    expect(change?.items).toHaveLength(1);
    expect(change?.items[0]).toMatchObject({
      fieldName: 'name', oldValue: 'Probe lifecycle variant', newValue: 'Renamed by the suite',
    });
  });

  it('reports an identical description as unchanged and files nothing', async () => {
    const { client } = fixture();
    const before = await history(client, 'ZP1');

    const saved = await savePostingPeriodVariant({
      client, changedBy: ACTOR, mode: 'CHANGE', variant: 'ZP1', name: 'Renamed by the suite',
    });

    expect(saved.mode).toBe('UNCHANGED');
    expect(await history(client, 'ZP1')).toHaveLength(before.length);
  });
});

describe('SCR-031 / OBBO — deleting a variant', () => {
  it('refuses while a Company Code posts against the variant, and names it', async () => {
    const { client, companyCode: code } = fixture();

    const attempt = deletePostingPeriodVariant({ client, changedBy: ACTOR, variant: SEEDED });

    await expect(attempt).rejects.toBeInstanceOf(PostingPeriodVariantError);
    await expect(attempt).rejects.toThrow(/cannot be deleted: Company Code .*posts against it/);
    await expect(storedVariant(client, SEEDED)).resolves.not.toBeNull();
    expect(await storedIntervals(client, SEEDED)).toHaveLength(DEFAULT_INTERVALS.length);

    // The refusal follows the current assignment rather than a stale read: move the Company
    // Code onto a variant of its own and the same deletion is refused for the same reason.
    await assignCompanyCode(client, code, 'ZP1');
    const moved = deletePostingPeriodVariant({ client, changedBy: ACTOR, variant: 'ZP1' });
    await expect(moved).rejects.toThrow(new RegExp(`Company Code ${code} posts against it`));
    await assignCompanyCode(client, code, SEEDED);
  });

  it('refuses to delete a variant that is not defined', async () => {
    const { client } = fixture();

    const attempt = deletePostingPeriodVariant({ client, changedBy: ACTOR, variant: 'ZP9' });

    await expect(attempt).rejects.toThrow(/is not defined in this tenant/);
  });

  it('deletes an unreferenced variant with the intervals it owns, and files what went', async () => {
    const { client } = fixture();
    expect(await storedIntervals(client, 'ZP1')).toHaveLength(DEFAULT_INTERVALS.length);

    const deleted = await deletePostingPeriodVariant({ client, changedBy: ACTOR, variant: 'ZP1' });

    expect(deleted).toMatchObject({
      deleted: true, variant: 'ZP1', name: 'Renamed by the suite',
      intervalsRemoved: DEFAULT_INTERVALS.length, companyCodes: [],
    });
    expect(await storedVariant(client, 'ZP1')).toBeNull();
    expect(await storedIntervals(client, 'ZP1')).toHaveLength(0);

    const removal = (await history(client, 'ZP1')).find((doc) => doc.changeType === 'DELETE');
    expect(removal).toBeDefined();
    expect(removal?.transactionCode).toBe(ACTIVITY);
    const byField = new Map(removal?.items.map((item) => [item.fieldName, item]) ?? []);
    // A deletion files what was there against a null new value, so an auditor reads the set
    // that was removed rather than only the fact of its removal.
    expect(byField.get('variant')?.oldValue).toBe('ZP1');
    expect(byField.get('variant')?.newValue).toBeNull();
    expect(byField.get('variant')?.isSecurityRelevant).toBe('true');
    // The variant was created from the defaults and its intervals were never edited, so the
    // sentence filed here is the same one the create filed, in the same order.
    expect(byField.get('intervals')?.oldValue).toBe(describeIntervalSet(DEFAULT_INTERVALS));
    expect(byField.get('intervalCount')?.oldValue).toBe(String(DEFAULT_INTERVALS.length));

    // The registry reads back without it, and the seeded variant is untouched throughout.
    const remaining = await listPostingPeriodVariants(client);
    expect(remaining.map((row) => row.variant)).not.toContain('ZP1');
    const seeded = remaining.find((row) => row.variant === SEEDED);
    expect(seeded?.name).toBe('Standard period control');
    expect(seeded?.intervals).toHaveLength(DEFAULT_INTERVALS.length);
    expect(seeded?.usedByCompanyCodes).toEqual([fixture().companyCode]);
  });

  it('leaves the lower-case-keyed variant deletable too, and the tenant readable afterwards', async () => {
    const { client } = fixture();

    const deleted = await deletePostingPeriodVariant({ client, changedBy: ACTOR, variant: 'zp3' });
    expect(deleted.deleted).toBe(true);

    const rows = await listPostingPeriodVariants(client);
    expect(rows.map((row) => row.variant)).toEqual([SEEDED, 'ZP2']);
    expect(rows[0].intervals.map((interval) => interval.accountType)).toEqual(['S', 'K', 'D', 'A', 'M']);
    expect(rows[0].intervals[0].summary).toContain('periods 1 to 12');
  });
});
