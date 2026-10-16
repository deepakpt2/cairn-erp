/**
 * SCR-029 / OB29 stage 5 — the fiscal year variant service, its refusals and its audit trail.
 *
 * One tenant, whose standard package already holds a calendar-year variant in use by its
 * company code. Every other variant in this file is built to provoke exactly one guard, so a
 * refusal can be told apart from its neighbours: a shifted-year variant with no periods, a
 * year-dependent one, one whose maintained list no longer fits a new count, one that is
 * deactivated, and one that is referenced.
 *
 * Versions are read from the registry rather than counted, and a refusal test states what was
 * *not* written as well as what was: a variant whose counts and period list disagree would
 * surface months later as "no period found for 15 March", which is the failure this service
 * exists to prevent.
 *
 * The last period test is the one that matters most — it hands the maintained list to the
 * posting engine and asks where a date lands, because a period list that satisfies the service
 * but not the engine would be a rule written twice and agreed by nobody.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { configActivityStatus } from '@/platform/tables/registry';
import { derivePosition } from '@/platform/periods';
import { fiscalYearPeriod } from '@/modules/foundation/schema';
import {
  FiscalYearVariantError,
  fiscalYearVariantChoices,
  listFiscalYearVariants,
  saveFiscalYearPeriods,
  saveFiscalYearVariant,
  setFiscalYearVariantActive,
  type FiscalYearPeriodMaintenanceInput,
  type FiscalYearVariantLifecycleInput,
  type FiscalYearVariantMaintenanceInput,
  type FiscalYearVariantRow,
} from '@/modules/foundation/fiscal-year-variant-maintenance';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const TEST_ACTOR = 'SCR029_STAGE5';
const REASON = 'SCR-029 automated backend test';

/** Seeded by the standard package, calendar year, 12 ordinary + 4 adjustment, in use by 1000. */
const SEEDED = 'K4';
/** A shifted year starting in April, maintained by hand. */
const SHIFTED = 'S4';
/** A calendar-year variant created here, to watch its rows being derived. */
const DERIVED = 'C1';
/** Year dependent: one list per calendar year. */
const YEARLY = 'Y1';
/** Retired and restored; nothing points at it. */
const SPARE = 'D1';
/** Ordinary periods plus two for year-end adjustment, to watch the type come from position. */
const MIXED = 'P1';
/** A scratch variant whose period list is refused four different ways. */
const SCRATCH = 'P2';
/** A hand-maintained variant whose counts are then changed to something the list cannot fit. */
const COUNTS = 'N1';
/** Year dependent, then switched off, to watch the per-year lists go. */
const YEARLY_OFF = 'Y2';
/** Hand-maintained first, then switched to the calendar year. */
const CONVERTED = 'M1';

let tenant: TestTenant | undefined;

function fixture(): TestTenant {
  if (!tenant) throw new Error('SCR-029 stage 5 tenant fixture was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('scr029-ob29-stage5');
  await startFiscalYearVariantActivity();
});

/**
 * The workbench row a seeded tenant would already have. A fixture tenant is created after the
 * seed runs, and completing an activity updates a row rather than inventing one, so without
 * this the service would have nothing to mark and the assertion below would prove nothing.
 */
async function startFiscalYearVariantActivity() {
  const { client } = fixture();
  await withTenant(client, (tx) => tx.insert(configActivityStatus).values({
    client,
    activityCode: 'CFG.FIN.FYV.DEFINE',
    status: 'NOT_STARTED',
    createdBy: TEST_ACTOR,
  }).onConflictDoUpdate({
    target: [configActivityStatus.client, configActivityStatus.activityCode],
    set: { status: 'NOT_STARTED' },
  }));
}

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */

async function registry(): Promise<FiscalYearVariantRow[]> {
  return listFiscalYearVariants(fixture().client);
}

async function row(variant: string): Promise<FiscalYearVariantRow> {
  const found = (await registry()).find((entry) => entry.variant === variant);
  if (!found) throw new Error(`Fiscal Year Variant ${variant} is not in the registry.`);
  return found;
}

/** Rows straight from the table, so a refusal can be proved to have written nothing. */
async function storedPeriods(variant: string, calendarYear = 0): Promise<number> {
  const { client } = fixture();
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ period: fiscalYearPeriod.period })
      .from(fiscalYearPeriod)
      .where(and(
        eq(fiscalYearPeriod.client, client),
        eq(fiscalYearPeriod.variant, variant),
        eq(fiscalYearPeriod.calendarYear, calendarYear),
      ));
    return rows.length;
  });
}

async function history(objectClass: string, objectKey: string) {
  const { client } = fixture();
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, objectKey));
}

function variantInput(
  variant: string,
  overrides: Partial<FiscalYearVariantMaintenanceInput> = {},
): FiscalYearVariantMaintenanceInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    variant,
    name: `OB29 stage 5 ${variant}`,
    isCalendarYear: false,
    regularPeriods: 12,
    specialPeriods: 0,
    isYearDependent: false,
    reason: REASON,
    ...overrides,
  };
}

/** A change opened against the version the registry holds right now, never a counted one. */
async function changeVariant(
  variant: string,
  overrides: Partial<FiscalYearVariantMaintenanceInput> = {},
) {
  const current = await row(variant);
  return saveFiscalYearVariant(variantInput(variant, {
    mode: 'CHANGE',
    expectedVersion: current.version,
    name: current.name,
    isCalendarYear: current.isCalendarYear,
    regularPeriods: current.regularPeriods,
    specialPeriods: current.specialPeriods,
    isYearDependent: current.isYearDependent,
    ...overrides,
  }));
}

async function lifecycle(
  variant: string,
  isActive: boolean,
  overrides: Partial<FiscalYearVariantLifecycleInput> = {},
) {
  const current = await row(variant);
  const input: FiscalYearVariantLifecycleInput = {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    variant,
    isActive,
    expectedVersion: current.version,
    reason: REASON,
    ...overrides,
  };
  return setFiscalYearVariantActive(input);
}

function periodInput(
  variant: string,
  periods: Array<{ period: number; month: number; day: number; yearShift: number }>,
  overrides: Partial<FiscalYearPeriodMaintenanceInput> = {},
): FiscalYearPeriodMaintenanceInput {
  return {
    client: fixture().client,
    changedBy: TEST_ACTOR,
    variant,
    calendarYear: 0,
    periods,
    expectedVersion: 0,
    reason: REASON,
    ...overrides,
  };
}

async function maintainPeriods(
  variant: string,
  periods: Array<{ period: number; month: number; day: number; yearShift: number }>,
  overrides: Partial<FiscalYearPeriodMaintenanceInput> = {},
) {
  const current = await row(variant);
  return saveFiscalYearPeriods(periodInput(variant, periods, {
    expectedVersion: current.version,
    ...overrides,
  }));
}

/** Twelve ends for a fiscal year that starts in April and closes the following March. */
function aprilYear() {
  const ends: Array<[number, number, number]> = [
    [4, 30, 0], [5, 31, 0], [6, 30, 0], [7, 31, 0], [8, 31, 0], [9, 30, 0],
    [10, 31, 0], [11, 30, 0], [12, 31, 0], [1, 31, 1], [2, 28, 1], [3, 31, 1],
  ];
  return ends.map(([month, day, yearShift], index) => ({
    period: index + 1, month, day, yearShift,
  }));
}

/** Twelve ends for a fiscal year that starts in May, to replace the April one wholesale. */
function mayYear() {
  const ends: Array<[number, number, number]> = [
    [5, 31, 0], [6, 30, 0], [7, 31, 0], [8, 31, 0], [9, 30, 0], [10, 31, 0],
    [11, 30, 0], [12, 31, 0], [1, 31, 1], [2, 28, 1], [3, 31, 1], [4, 30, 1],
  ];
  return ends.map(([month, day, yearShift], index) => ({
    period: index + 1, month, day, yearShift,
  }));
}

/** Twelve ends for a fiscal year that follows the calendar year. */
function calendarYearEnds() {
  return Array.from({ length: 12 }, (_, index) => ({
    period: index + 1, month: index + 1, day: 31, yearShift: 0,
  }));
}

/* ── Defining a variant ─────────────────────────────────────────────────────── */

describe('OB29 define a fiscal year variant', () => {
  it('derives the periods of a calendar-year variant from its own counts', async () => {
    const result = await saveFiscalYearVariant(variantInput(DERIVED, {
      isCalendarYear: true,
      regularPeriods: 12,
      specialPeriods: 4,
      name: 'Calendar year, four adjustment',
    }));

    expect(result).toMatchObject({ variant: DERIVED, mode: 'CREATED', version: 1, periodsWritten: 16 });

    const stored = await row(DERIVED);
    expect(stored.years).toEqual([0]);
    expect(stored.periods).toHaveLength(16);
    expect(stored.periods.slice(0, 12).every((period) => period.periodType === 'REGULAR')).toBe(true);
    expect(stored.periods.slice(12).every((period) => period.periodType === 'SPECIAL')).toBe(true);
    // Derived, never stored: the first period starts on the first day of its month and the
    // second ends on the last day of February, which no row in the table records.
    expect(stored.periods[0]).toMatchObject({ month: 1, day: 31, periodType: 'REGULAR' });
    expect(stored.periods[0].derivedStart).toMatch(/^\d{4}-01-01$/);
    expect(stored.periods[1].derivedEnd).toMatch(/^\d{4}-02-2[89]$/);
  });

  it('creates a shifted-year variant with no periods until somebody maintains them', async () => {
    const result = await saveFiscalYearVariant(variantInput(SHIFTED, {
      name: 'April to March',
    }));
    expect(result).toMatchObject({ variant: SHIFTED, mode: 'CREATED', periodsWritten: 0 });
    expect((await row(SHIFTED)).periods).toHaveLength(0);

    // The engine refuses rather than guessing, which is the point of leaving the list empty.
    await expect(withTenant(fixture().client, (tx) =>
      derivePosition(tx, fixture().client, SHIFTED, '2026-05-15'))).rejects.toThrow(/no periods defined/);
  });

  it('upper-cases the key and refuses one that is not two letters or digits', async () => {
    await saveFiscalYearVariant(variantInput('s5', { name: 'Lower case key' }));
    expect((await registry()).map((entry) => entry.variant)).toContain('S5');

    await expect(saveFiscalYearVariant(variantInput('K44'))).rejects.toThrow(/exactly two letters or digits/);
    await expect(saveFiscalYearVariant(variantInput('K'))).rejects.toThrow(/exactly two letters or digits/);
    await expect(saveFiscalYearVariant(variantInput('S5'))).rejects.toThrow(/already defined/);
  });

  it('refuses counts outside the contract and a missing reason', async () => {
    await expect(saveFiscalYearVariant(variantInput('X1', { regularPeriods: 17 })))
      .rejects.toThrow(/at most sixteen posting periods/);
    await expect(saveFiscalYearVariant(variantInput('X1', { regularPeriods: 0 })))
      .rejects.toThrow(/at least one posting period/);
    await expect(saveFiscalYearVariant(variantInput('X1', { specialPeriods: 5 })))
      .rejects.toThrow(/at most four special periods/);
    await expect(saveFiscalYearVariant(variantInput('X1', { reason: '   ' })))
      .rejects.toThrow(/A reason is required/);

    expect((await registry()).some((entry) => entry.variant === 'X1')).toBe(false);
  });

  it('offers only the active variants to a screen that assigns one', async () => {
    const choices = await fiscalYearVariantChoices(fixture().client);
    expect(choices.map((choice) => choice.code)).toEqual(expect.arrayContaining([SEEDED, DERIVED, SHIFTED]));
    expect(choices.every((choice) => typeof choice.name === 'string' && choice.name.length > 0)).toBe(true);
  });
});

/* ── Changing a variant ─────────────────────────────────────────────────────── */

describe('OB29 change a fiscal year variant', () => {
  it('saves a change, bumps the version once, and says so when nothing differs', async () => {
    const before = await row(DERIVED);
    const changed = await changeVariant(DERIVED, { name: 'Calendar year, renamed' });
    expect(changed).toMatchObject({ mode: 'CHANGED', version: before.version + 1 });
    expect((await row(DERIVED)).name).toBe('Calendar year, renamed');

    const again = await changeVariant(DERIVED, { name: 'Calendar year, renamed' });
    expect(again).toMatchObject({ mode: 'UNCHANGED', version: before.version + 1 });
  });

  it('refuses a change opened against a version that has moved on, and one that does not exist', async () => {
    await expect(changeVariant(DERIVED, { name: 'Too late', expectedVersion: 99 }))
      .rejects.toThrow(/changed after it was opened/);
    expect((await row(DERIVED)).name).toBe('Calendar year, renamed');

    await expect(saveFiscalYearVariant(variantInput('ZZ', { mode: 'CHANGE', expectedVersion: 1 })))
      .rejects.toThrow(/does not exist in this tenant/);
  });

  it('refuses a count the maintained period list cannot fit', async () => {
    await saveFiscalYearVariant(variantInput(COUNTS, { name: 'Twelve periods, maintained' }));
    await maintainPeriods(COUNTS, calendarYearEnds());
    expect(await storedPeriods(COUNTS)).toBe(12);

    await expect(changeVariant(COUNTS, { regularPeriods: 13 }))
      .rejects.toThrow(/holds 12 ordinary and 0 special periods/);

    const untouched = await row(COUNTS);
    expect(untouched.regularPeriods).toBe(12);
    expect(await storedPeriods(COUNTS)).toBe(12);
  });

  it('replaces a hand-maintained list when the variant is switched to the calendar year', async () => {
    await saveFiscalYearVariant(variantInput(CONVERTED, { name: 'Hand maintained, then derived' }));
    await maintainPeriods(CONVERTED, aprilYear());
    expect(await storedPeriods(CONVERTED)).toBe(12);

    const converted = await changeVariant(CONVERTED, {
      isCalendarYear: true,
      regularPeriods: 12,
      specialPeriods: 2,
    });
    expect(converted).toMatchObject({ mode: 'CHANGED', periodsWritten: 14 });

    const stored = await row(CONVERTED);
    expect(stored.isCalendarYear).toBe(true);
    expect(stored.periods).toHaveLength(14);
    // The April shape is gone: these are the derived calendar ends, not the maintained ones.
    expect(stored.periods[0]).toMatchObject({ month: 1, day: 31 });
    expect(stored.periods[13]).toMatchObject({ month: 12, day: 31, periodType: 'SPECIAL' });
  });

  it('drops the per-year lists when year dependence is switched off', async () => {
    await saveFiscalYearVariant(variantInput(YEARLY_OFF, {
      name: 'One list per year',
      isYearDependent: true,
    }));
    await maintainPeriods(YEARLY_OFF, calendarYearEnds(), { calendarYear: 2026 });
    await maintainPeriods(YEARLY_OFF, aprilYear(), { calendarYear: 2027 });
    expect((await row(YEARLY_OFF)).years.sort()).toEqual([2026, 2027]);

    await changeVariant(YEARLY_OFF, { isYearDependent: false });

    const after = await row(YEARLY_OFF);
    expect(after.isYearDependent).toBe(false);
    expect(after.years).toEqual([]);
    expect(after.periods).toHaveLength(0);
  });

  it('refuses to change a variant that has been retired', async () => {
    await saveFiscalYearVariant(variantInput(SPARE, { name: 'Retired and restored' }));
    await lifecycle(SPARE, false);

    await expect(changeVariant(SPARE, { name: 'Should not land' })).rejects.toThrow(/is deactivated/);
    await expect(changeVariant(SPARE, { name: 'Should not land' })).rejects.toThrowError(FiscalYearVariantError);
    expect((await row(SPARE)).name).toBe('Retired and restored');

    await lifecycle(SPARE, true);
  });
});

/* ── Retiring a variant ─────────────────────────────────────────────────────── */

describe('OB29 retire a fiscal year variant', () => {
  it('refuses to retire a variant a company code still points at', async () => {
    const before = await row(SEEDED);
    await expect(lifecycle(SEEDED, false)).rejects.toThrow(/is still used by/);
    await expect(lifecycle(SEEDED, false)).rejects.toThrow(/in all/);

    const after = await row(SEEDED);
    expect(after.isActive).toBe(true);
    expect(after.version).toBe(before.version);
  });

  it('retires and restores an unused variant, and reports a status it already had', async () => {
    const before = await row(SPARE);
    const retired = await lifecycle(SPARE, false);
    expect(retired).toMatchObject({ isActive: false, changed: true, version: before.version + 1 });

    const repeated = await lifecycle(SPARE, false);
    expect(repeated).toMatchObject({ changed: false, version: before.version + 1 });

    const restored = await lifecycle(SPARE, true);
    expect(restored).toMatchObject({ isActive: true, changed: true, version: before.version + 2 });

    // A retired variant is hidden from the screens that assign one, and kept for the books
    // that already use it.
    await lifecycle(SPARE, false);
    expect((await fiscalYearVariantChoices(fixture().client)).map((choice) => choice.code)).not.toContain(SPARE);
    expect((await registry()).find((entry) => entry.variant === SPARE)).toBeDefined();
    await lifecycle(SPARE, true);
  });

  it('needs a reason, and refuses a lifecycle write opened against a stale version', async () => {
    await expect(lifecycle(SPARE, false, { reason: '' })).rejects.toThrow(/A reason is required/);
    await expect(lifecycle(SPARE, false, { expectedVersion: 99 }))
      .rejects.toThrow(/changed after it was opened/);
    expect((await row(SPARE)).isActive).toBe(true);
  });
});

/* ── Maintaining the period list ────────────────────────────────────────────── */

describe('OB29 maintain a period list', () => {
  it('stores only the ends, and the engine derives the windows and the posting period', async () => {
    const result = await maintainPeriods(SHIFTED, aprilYear());
    expect(result).toMatchObject({ variant: SHIFTED, calendarYear: 0, periods: 12 });

    const stored = await row(SHIFTED);
    expect(stored.periods).toHaveLength(12);
    expect(stored.periods[0]).toMatchObject({ period: 1, month: 4, day: 30, yearShift: 0 });
    expect(stored.periods[0].derivedStart).toMatch(/^\d{4}-04-01$/);
    expect(stored.periods[0].derivedEnd).toMatch(/^\d{4}-04-30$/);
    // The last period closes the fiscal year in the following March, a year the row never names.
    expect(stored.periods[11]).toMatchObject({ period: 12, month: 3, day: 31, yearShift: 1 });
    expect(stored.periods[11].derivedEnd).toMatch(/^\d{4}-03-31$/);

    // And the reason the list exists: a date in May belongs to period 2 of the fiscal year
    // that started in April.
    const position = await withTenant(fixture().client, (tx) =>
      derivePosition(tx, fixture().client, SHIFTED, '2026-05-15'));
    expect(position).toMatchObject({ period: 2, periodType: 'REGULAR' });
  });

  it('takes the period type from its position, ordinary first and adjustment last', async () => {
    const periods = [
      ...calendarYearEnds(),
      { period: 13, month: 12, day: 31, yearShift: 0 },
      { period: 14, month: 12, day: 31, yearShift: 0 },
    ];
    await saveFiscalYearVariant(variantInput(MIXED, { regularPeriods: 12, specialPeriods: 2 }));
    await maintainPeriods(MIXED, periods);

    const stored = await row(MIXED);
    expect(stored.periods.filter((period) => period.periodType === 'REGULAR')).toHaveLength(12);
    expect(stored.periods.filter((period) => period.periodType === 'SPECIAL'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ period: 13 }),
        expect.objectContaining({ period: 14 }),
      ]));
  });

  it('refuses a list that is short, misnumbered, out of order, or shorter than a year', async () => {
    await saveFiscalYearVariant(variantInput(SCRATCH, { name: 'Refused four ways' }));
    const before = await row(SCRATCH);
    const full = calendarYearEnds();

    // One period missing.
    await expect(maintainPeriods(SCRATCH, full.slice(0, 11))).rejects.toThrow(/asks for 12 periods/);
    // A gap in the numbering.
    await expect(maintainPeriods(SCRATCH, [
      ...full.slice(0, 11),
      { period: 13, month: 12, day: 31, yearShift: 0 },
    ])).rejects.toThrow(/run from 1 without a gap/);
    // A later period ending before an earlier one.
    await expect(maintainPeriods(SCRATCH, full.map((period) =>
      period.period === 3 ? { ...period, month: 1, day: 15 } : period))).rejects.toThrow(/ends before period 2/);
    // Twelve periods that cover half a year.
    await expect(maintainPeriods(SCRATCH, full.map((period) =>
      ({ ...period, month: Math.min(period.month, 6) })))).rejects.toThrow(/do not cover one whole year/);

    // Four refusals, and still nothing in the table: a period list is written whole or not at all.
    expect(await storedPeriods(SCRATCH)).toBe(0);
    expect((await row(SCRATCH)).version).toBe(before.version);
  });

  it('keeps a year-dependent variant per year and refuses the every-year list', async () => {
    await saveFiscalYearVariant(variantInput(YEARLY, {
      name: 'One list per year',
      isYearDependent: true,
    }));

    await expect(maintainPeriods(YEARLY, calendarYearEnds(), { calendarYear: 0 }))
      .rejects.toThrow(/maintained one calendar year at a time/);
    await expect(maintainPeriods(SHIFTED, aprilYear(), { calendarYear: 2028 }))
      .rejects.toThrow(/holds for every year/);

    await maintainPeriods(YEARLY, aprilYear(), { calendarYear: 2028 });
    expect((await row(YEARLY)).years).toContain(2028);
    expect(await storedPeriods(YEARLY, 2028)).toBe(12);
    expect(await storedPeriods(YEARLY, 0)).toBe(0);
  });

  it('refuses to maintain the periods of a calendar-year variant or a retired one', async () => {
    await expect(maintainPeriods(DERIVED, calendarYearEnds()))
      .rejects.toThrow(/follows the calendar year/);
    await expect(maintainPeriods(SEEDED, calendarYearEnds()))
      .rejects.toThrow(/follows the calendar year/);

    await lifecycle(MIXED, false);
    await expect(maintainPeriods(MIXED, calendarYearEnds())).rejects.toThrow(/is deactivated/);
    await lifecycle(MIXED, true);
  });

  it('reports an identical period list as unchanged rather than filing an empty document', async () => {
    // recordChange files only the fields that moved, so a document for a list that did not
    // change would have no items at all and come back null — which this module reads as a lost
    // audit trail and refuses. The honest answer is that nothing changed.
    const before = await row(COUNTS);
    const repeated = await maintainPeriods(COUNTS, calendarYearEnds());
    expect(repeated).toMatchObject({ unchanged: true, version: before.version });
    expect((await row(COUNTS)).version).toBe(before.version);
    expect(await history('fiscal_year_period', `${COUNTS}/every-year`)).toHaveLength(1);

    // And a list that does move is still written and still filed.
    const moved = await maintainPeriods(COUNTS, [
      ...calendarYearEnds().slice(0, 11),
      { period: 12, month: 12, day: 30, yearShift: 0 },
    ]);
    expect(moved).toMatchObject({ unchanged: false, version: before.version + 1 });
    expect(await history('fiscal_year_period', `${COUNTS}/every-year`)).toHaveLength(2);
  });

  it('refuses a period list opened against a stale version, and rewrites the list whole', async () => {
    await expect(maintainPeriods(SHIFTED, aprilYear(), { expectedVersion: 99 }))
      .rejects.toThrow(/changed after it was opened/);

    // A second save replaces the rows rather than adding to them: the shifted year becomes a
    // May year, and no April row survives to contradict it.
    await maintainPeriods(SHIFTED, mayYear());
    const stored = await row(SHIFTED);
    expect(stored.periods).toHaveLength(12);
    expect(stored.periods[0]).toMatchObject({ month: 5, day: 31 });
    expect(stored.periods[11]).toMatchObject({ month: 4, day: 30, yearShift: 1 });
    expect(await storedPeriods(SHIFTED)).toBe(12);
  });
});

/* ── Audit trail and workbench ──────────────────────────────────────────────── */

describe('OB29 records what it did', () => {
  it('writes one change document per write, with the reason and the fields that moved', async () => {
    const documents = await history('fiscal_year_variant', DERIVED);
    expect(documents.length).toBeGreaterThanOrEqual(2);
    expect(documents.every((document) => document.reason === REASON)).toBe(true);
    expect(documents.some((document) => document.changeType === 'CREATE')).toBe(true);

    const rename = documents.find((document) =>
      document.items.some((item) => item.fieldName === 'name'));
    expect(rename?.items.find((item) => item.fieldName === 'name')).toMatchObject({
      oldValue: 'Calendar year, four adjustment',
      newValue: 'Calendar year, renamed',
    });
  });

  it('records a period list as one document, not as sixteen rows', async () => {
    const documents = await history('fiscal_year_period', `${CONVERTED}/every-year`);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ changeType: 'CHANGE', reason: REASON });

    const items = documents[0].items;
    expect(items.find((item) => item.fieldName === 'periodCount')?.newValue).toBe('12');
    expect(items.find((item) => item.fieldName === 'periodEnds')?.newValue)
      .toBe('1:4/30 2:5/31 3:6/30 4:7/31 5:8/31 6:9/30 7:10/31 8:11/30 9:12/31 10:1/31 11:2/28 12:3/31');

    // A per-year list is recorded under its own year, so the two cannot be confused.
    expect(await history('fiscal_year_period', `${YEARLY}/2028`)).toHaveLength(1);
  });

  it('records a retirement against the variant, and marks the configuration activity complete', async () => {
    const documents = await history('fiscal_year_variant', SPARE);
    expect(documents.some((document) =>
      document.items.some((item) => item.fieldName === 'isActive'))).toBe(true);

    const { client } = fixture();
    const status = await withTenant(client, (tx) => tx
      .select()
      .from(configActivityStatus)
      .where(and(
        eq(configActivityStatus.client, client),
        eq(configActivityStatus.activityCode, 'CFG.FIN.FYV.DEFINE'),
      )));
    expect(status[0]?.status).toBe('COMPLETED');
    expect(status[0]?.completedBy).toBe(TEST_ACTOR);
  });
});
