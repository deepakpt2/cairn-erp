/**
 * Cost allocation cycles (KSU1/KSU2) and assessment (KSU5).
 *
 * What is worth proving: a cycle reads back as defined; groups resolve with excludes and without
 * double counting; every receiver rule splits exactly; a run posts one AL document whose every line
 * carries the assessment account and a cost centre, so the account nets to zero, relieving senders by
 * their net balance and charging receivers; and every refusal is named — the owner's rules included
 * (net balance over POSTED and REVERSED documents, one segment per sender, no self-assessment, one live
 * run with a cancel-after-reversal path).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postGlDocument as postGlDocumentService } from '../src/modules/finance/gl-document';
import { saveCostCenter } from '../src/modules/foundation/cost-center-definition';
import {
  AllocationCycleError,
  allocateAmount,
  cancelAssessmentRun,
  deleteCycle,
  getCycle,
  previewAssessment,
  runAssessment,
  saveCycle,
  setReceiver,
  setSegment,
  setSender,
  type RunAssessmentInput,
} from '../src/modules/foundation/cost-allocation-cycle';
import { configActivityStatus } from '@/platform/tables/registry';
import { controllingAreaCompany } from '@/modules/foundation/schema';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, financePoster, type FinanceActor } from './helpers/finance-actor';

const ACTOR = 'KSU5-TEST';
const REASON = 'KSU5 automated test';
const YEAR = 2026;
const ACCOUNT = '690000';
let tenant: TestTenant | undefined;
let client = '';
let controller: FinanceActor;
const postGlDocument = financePoster(postGlDocumentService);

async function expectRefusal(promise: Promise<unknown>, fragment: string | RegExp): Promise<AllocationCycleError> {
  try {
    await promise;
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(AllocationCycleError);
    expect((error as Error).message).toMatch(fragment);
    return error as AllocationCycleError;
  }
  throw new Error(`Expected an AllocationCycleError matching ${fragment}, nothing was thrown.`);
}

const auth = () => ({ authorization: controller.authorization });
const actor = () => ({ client, changedBy: controller.username });

/** Post a cost on a centre: debit 400000 with the centre, credit the bank. Negative = a credit on the centre. */
async function cost(centre: string, amount: number, date: string, account = '400000') {
  const debit = amount > 0;
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: `ksu5-${randomUUID()}`, companyCode: '1000', documentDate: date, postingDate: date,
    documentType: 'SA', currency: 'USD',
    lines: [
      { glAccount: account, debitCredit: debit ? 'S' : 'H', amount: Math.abs(amount).toFixed(2), costCenter: centre },
      { glAccount: '101000', debitCredit: debit ? 'H' : 'S', amount: Math.abs(amount).toFixed(2) },
    ],
  });
}

async function cycle(code: string, segments: Array<{ number: number; rule: 'PERCENTAGE' | 'PORTION' | 'FIXED_AMOUNT'; senders: Array<string | { group: string }>; receivers: Array<[string | { group: string }, string]>; from?: string; to?: string }>, category: 'ASSESSMENT' | 'DISTRIBUTION' = 'ASSESSMENT') {
  await saveCycle({ ...actor(), mode: 'CREATE', controllingArea: 'A000', cycleCode: code, name: `Cycle ${code}`, category, validFrom: `${YEAR}-01-01`, validTo: `${YEAR}-12-31`, isActive: true, reason: REASON }, auth());
  for (const s of segments) {
    await setSegment({ ...actor(), controllingArea: 'A000', cycleCode: code, segmentNumber: s.number, name: `Segment ${s.number}`, receiverRule: s.rule, costElementFrom: s.from ?? '', costElementTo: s.to ?? '', reason: REASON }, auth());
    for (const [i, node] of s.senders.entries()) {
      await setSender({ ...actor(), controllingArea: 'A000', cycleCode: code, segmentNumber: s.number, itemNumber: i + 1, ...(typeof node === 'string' ? { costCenter: node } : { groupName: node.group }), reason: REASON }, auth());
    }
    for (const [i, [node, weight]] of s.receivers.entries()) {
      await setReceiver({ ...actor(), controllingArea: 'A000', cycleCode: code, segmentNumber: s.number, itemNumber: i + 1, ...(typeof node === 'string' ? { costCenter: node } : { groupName: node.group }), weight, reason: REASON }, auth());
    }
  }
}

const run = (code: string, period: number, over: Partial<RunAssessmentInput> = {}) =>
  runAssessment({ ...actor(), controllingArea: 'A000', cycleCode: code, fiscalYear: YEAR, period, reason: REASON, ...over }, auth());
const preview = (code: string, period: number) =>
  previewAssessment({ ...actor(), controllingArea: 'A000', cycleCode: code, fiscalYear: YEAR, period, reason: REASON }, auth());

async function documentLines(documentNumber: string) {
  return withTenant(client, async (tx) => (await tx.execute(sql`
    select l.gl_account, l.debit_credit, l.amount_local::text as amount, l.cost_center, e.document_type, e.posting_date::text as posting_date
      from journal_entry_line l join journal_entry e on e.client = l.client and e.company_code = l.company_code and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
     where l.client = ${client} and l.document_number = ${documentNumber} order by l.line_number`)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string; cost_center: string | null; document_type: string; posting_date: string }>);
}

async function group(name: string, leaves: Array<{ sign: 'I' | 'E'; option: 'EQ' | 'BT'; from: string; to?: string }>) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`insert into cost_center_group (client, controlling_area, group_name, title, created_by) values (${client}, 'A000', ${name}, ${`Group ${name}`}, ${ACTOR})`);
    for (const [i, l] of leaves.entries()) {
      await tx.execute(sql`insert into cost_center_group_leaf (client, controlling_area, group_name, val_sign, val_option, val_from, val_to, display_order, created_by)
        values (${client}, 'A000', ${name}, ${l.sign}, ${l.option}, ${l.from}, ${l.to ?? ''}, ${i + 1}, ${ACTOR})`);
    }
  });
}

beforeAll(async () => {
  tenant = await createTenant('ksu5-assess');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: YEAR });
  await withTenant(client, async (tx) => {
    for (const activityCode of ['CFG.COST.CONTROLLINGAREA.DEFINE', 'CFG.COST.COSTCENTER.DEFINE']) {
      await tx.insert(configActivityStatus).values({ client, activityCode, status: 'COMPLETED', createdBy: ACTOR })
        .onConflictDoUpdate({ target: [configActivityStatus.client, configActivityStatus.activityCode], set: { status: 'COMPLETED', changedBy: ACTOR, changedAt: new Date() } });
    }
    await tx.insert(controllingAreaCompany).values({ client, controllingArea: 'A000', companyCode: '1000', createdBy: ACTOR }).onConflictDoNothing();
    // A dedicated assessment account, copied from an expense account of the chart, and its determination.
    await tx.execute(sql`insert into gl_account
      select (jsonb_populate_record(null::gl_account, to_jsonb(g) || jsonb_build_object('account_number', ${ACCOUNT}::text, 'name', 'Internal cost allocation', 'created_by', ${ACTOR}::text))).*
        from gl_account g where g.client = ${client} and g.account_number = '400000'`);
    await tx.execute(sql`insert into gl_account_company
      select (jsonb_populate_record(null::gl_account_company, to_jsonb(g) || jsonb_build_object('gl_account', ${ACCOUNT}::text, 'created_by', ${ACTOR}::text))).*
        from gl_account_company g where g.client = ${client} and g.gl_account = '400000'`);
    await tx.execute(sql`insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select distinct client, chart_of_accounts, 'CO_ASSESSMENT', '', '', ${ACCOUNT}, ${ACTOR} from gl_account where client = ${client} and account_number = ${ACCOUNT}`);
  });
  for (const [centre, name, from, to] of [
    ['CC1000', 'Mixing', `${YEAR}-01-01`, `${YEAR}-12-31`],
    ['CC1010', 'Packing', `${YEAR}-01-01`, `${YEAR}-12-31`],
    ['CC2000', 'Warehousing', `${YEAR}-01-01`, `${YEAR}-12-31`],
    ['CC5000', 'Administration', `${YEAR}-01-01`, `${YEAR}-12-31`],
    ['CC6000', 'Short-lived', `${YEAR}-01-01`, `${YEAR}-05-31`],
  ] as const) {
    await saveCostCenter({ client, changedBy: ACTOR, mode: 'CREATE', controllingArea: 'A000', costCenter: centre, validFrom: from, validTo: to, name, personResponsible: '', category: 'PRODUCTION', companyCode: '1000', reason: REASON });
  }
  controller = await createFinanceActor(client, { capabilities: ['CFG.COST.ALLOCATION.DEFINE', 'CO.ASSESSMENT.EXECUTE', 'FIN.JOURNAL.POST'] });
  await group('SVC1', [{ sign: 'I', option: 'EQ', from: 'CC2000' }]);
  await group('SVC2', [{ sign: 'I', option: 'EQ', from: 'CC2000' }, { sign: 'I', option: 'EQ', from: 'CC5000' }]);
  await group('PROD', [{ sign: 'I', option: 'BT', from: 'CC1000', to: 'CC1999' }, { sign: 'E', option: 'EQ', from: 'CC1010' }]);
  await group('EMPTY', [{ sign: 'I', option: 'EQ', from: 'CC9999' }]);
  // April: Warehousing 1,000 debit and 200 credit (net 800); Administration 500; a 400000 and a 410000 cost.
  await cost('CC2000', 1000, `${YEAR}-04-10`);
  await cost('CC2000', -200, `${YEAR}-04-12`);
  await cost('CC5000', 500, `${YEAR}-04-10`);
  await cost('CC5000', 300, `${YEAR}-04-11`, '410000');
}, 180_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('allocateAmount (pure)', () => {
  const sum = (parts: string[]) => parts.reduce((s, p) => s + Math.round(Number(p) * 10000), 0);

  it('3. PERCENTAGE: shares of 100, and weights not summing to 100 are refused', () => {
    expect(allocateAmount('1000', 'PERCENTAGE', ['60', '40'])).toEqual(['600.0000', '400.0000']);
    expect(() => allocateAmount('1000', 'PERCENTAGE', ['60', '30'])).toThrow(/sum to 90.0000, not 100/);
  });

  it('4. PORTION normalises, and zero-sum weights are refused', () => {
    expect(allocateAmount('900', 'PORTION', ['1', '2'])).toEqual(['300.0000', '600.0000']);
    expect(() => allocateAmount('900', 'PORTION', ['0', '0'])).toThrow(/sum to zero/);
  });

  it('5. FIXED_AMOUNT: the weights are the amounts, and a mismatch is refused', () => {
    expect(allocateAmount('100', 'FIXED_AMOUNT', ['70', '30'])).toEqual(['70.0000', '30.0000']);
    expect(() => allocateAmount('100', 'FIXED_AMOUNT', ['70', '20'])).toThrow(/sum to 90.0000, but the senders send 100.0000/);
  });

  it('6. the shares sum to the total exactly under every rule; the residual goes to the largest receiver', () => {
    const thirds = allocateAmount('100', 'PORTION', ['1', '1', '1']);
    expect(sum(thirds)).toBe(1_000_000);
    expect(thirds).toEqual(['33.3334', '33.3333', '33.3333']);
    expect(sum(allocateAmount('100', 'PERCENTAGE', ['33.333', '33.333', '33.334']))).toBe(1_000_000);
    expect(sum(allocateAmount('0.0001', 'PORTION', ['1', '5']))).toBe(1);
  });

  it('shares are rounded to the currency precision, still summing exactly', () => {
    const usd = allocateAmount('1000.01', 'PERCENTAGE', ['33', '33', '34'], 2);
    expect(usd).toEqual(['330.0000', '330.0000', '340.0100']);
    expect(usd.every((x) => /\.\d\d00$/.test(x))).toBe(true);
    expect(sum(usd)).toBe(10_000_100);
    expect(() => allocateAmount('100.005', 'PORTION', ['1'], 2)).toThrow(/more than 2 decimal places/);
  });
});

describe('definition', () => {
  it('1. a cycle, its segment, senders and receivers are defined and read back', async () => {
    await cycle('ASM1', [{ number: 1, rule: 'PERCENTAGE', senders: [{ group: 'SVC1' }, { group: 'SVC2' }], receivers: [['CC1000', '60'], ['CC1010', '40']] }]);
    const view = (await getCycle(client, 'A000', 'ASM1'))!;
    expect(view).toMatchObject({ cycleCode: 'ASM1', category: 'ASSESSMENT', isActive: true });
    expect(view.segments[0]).toMatchObject({ segmentNumber: 1, receiverRule: 'PERCENTAGE', costElementFrom: null });
    expect(view.segments[0]!.senders.map((s) => s.groupName)).toEqual(['SVC1', 'SVC2']);
    expect(view.segments[0]!.receivers.map((r) => [r.costCenter, r.weight])).toEqual([['CC1000', '60.0000'], ['CC1010', '40.0000']]);
  });

  it('definition refuses an unknown centre or group, both or neither named, and an unbuilt rule', async () => {
    await expectRefusal(setSender({ ...actor(), controllingArea: 'A000', cycleCode: 'ASM1', segmentNumber: 1, itemNumber: 9, costCenter: 'CC9999', reason: REASON }, auth()), /CC9999 does not stand/);
    await expectRefusal(setSender({ ...actor(), controllingArea: 'A000', cycleCode: 'ASM1', segmentNumber: 1, itemNumber: 9, groupName: 'NOPE', reason: REASON }, auth()), /Group NOPE does not stand/);
    await expectRefusal(setSender({ ...actor(), controllingArea: 'A000', cycleCode: 'ASM1', segmentNumber: 1, itemNumber: 9, costCenter: 'CC2000', groupName: 'SVC1', reason: REASON }, auth()), /not both/);
    await expectRefusal(setSegment({ ...actor(), controllingArea: 'A000', cycleCode: 'ASM1', segmentNumber: 2, name: 'Traced', receiverRule: 'TRACING', reason: REASON }, auth()), /tracing-factor master/);
  });
});

describe('a run', () => {
  let documentNumber = '';

  it('2, 17. preview resolves groups (excluded centre excluded, a centre in two groups once) and writes nothing', async () => {
    const view = await preview('ASM1', 4);
    expect(view.segments[0]!.senders.map((s) => [s.costCenter, s.amount])).toEqual([['CC2000', '800.0000'], ['CC5000', '800.0000']]);
    expect(view.assessedTotal).toBe('1600.0000');
    expect(view.iterations).toBe(1);
    const runs = await withTenant(client, async (tx) => (await tx.execute(sql`select count(*)::int as n from cost_allocation_run where client = ${client}`)) as unknown as Array<{ n: number }>);
    expect(runs[0]!.n).toBe(0);
  });

  it('7, 8, 9, 18. a run posts one AL document; every line on the assessment account with a cost centre; senders relieved, receivers charged', async () => {
    const result = await run('ASM1', 4);
    documentNumber = result.documentNumber;
    expect(result).toMatchObject({ assessedTotal: '1600.0000', iterations: 1, postingDate: `${YEAR}-04-30`, assessmentAccount: ACCOUNT });
    const lines = await documentLines(documentNumber);
    expect(new Set(lines.map((l) => l.document_type))).toEqual(new Set(['AL']));
    expect(lines.every((l) => l.gl_account === ACCOUNT && l.cost_center)).toBe(true);
    const net = lines.reduce((s, l) => s + (l.debit_credit === 'S' ? 1 : -1) * Number(l.amount), 0);
    expect(net).toBeCloseTo(0, 4);
    const by = (centre: string, side: string) => lines.filter((l) => l.cost_center === centre && l.debit_credit === side).reduce((s, l) => s + Number(l.amount), 0);
    expect([by('CC2000', 'H'), by('CC5000', 'H'), by('CC1000', 'S'), by('CC1010', 'S')]).toEqual([800, 800, 960, 640]);
    const row = await withTenant(client, async (tx) => (await tx.execute(sql`select status, document_number, iterations, assessed_total::text as total from cost_allocation_run where client = ${client} and cycle_code = 'ASM1'`)) as unknown as Array<Record<string, unknown>>);
    expect(row[0]).toMatchObject({ status: 'EXECUTED', document_number: documentNumber, iterations: 1, total: '1600.0000' });
  });

  it('12. a second run for the same cycle, year and period is refused, naming the document', async () => {
    await expectRefusal(run('ASM1', 4), new RegExp(`already ran for 4/${YEAR} as document ${documentNumber}`));
  });

  it('a run is cancelled only once its document stands reversed, and the period can then run again', async () => {
    const [r] = await withTenant(client, async (tx) => (await tx.execute(sql`select run_id from cost_allocation_run where client = ${client} and cycle_code = 'ASM1'`)) as unknown as Array<{ run_id: string }>);
    await expectRefusal(cancelAssessmentRun({ ...actor(), runId: r!.run_id, reason: REASON }, auth()), /stands POSTED/);
    // The reversal service is the real path; here the original's status stands for it.
    await withTenant(client, (tx) => tx.execute(sql`update journal_entry set status = 'REVERSED' where client = ${client} and document_number = ${documentNumber}`));
    const cancelled = await cancelAssessmentRun({ ...actor(), runId: r!.run_id, reason: 'Reversed for correction' }, auth());
    expect(cancelled.status).toBe('CANCELLED');
    // A REVERSED original still counts in the senders' net (its reversal would post the credit).
    const again = await run('ASM1', 4);
    expect(again.documentNumber).not.toBe(documentNumber);
    expect(again.assessedTotal).toBe('1600.0000');
  });

  it('10. a cost element range restricts what is assessed', async () => {
    await cycle('ASM2', [{ number: 1, rule: 'PORTION', senders: ['CC5000'], receivers: [[{ group: 'PROD' }, '1']], from: '410000', to: '419999' }]);
    const view = await preview('ASM2', 4);
    expect(view.segments[0]!.senders).toEqual([expect.objectContaining({ costCenter: 'CC5000', amount: '300.0000' })]);
    expect(view.segments[0]!.receivers.map((r) => r.costCenter)).toEqual(['CC1000']);
  });
});

describe('refusals', () => {
  it('11. zero assessable cost is refused', async () => {
    await cycle('ZERO', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC1000', '100']] }]);
    await expectRefusal(run('ZERO', 6), /no assessable cost in period 6/);
  });

  it('a sender with a net credit is refused', async () => {
    await cost('CC1010', -50, `${YEAR}-05-10`);
    await cycle('NEG', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC1010'], receivers: [['CC1000', '100']] }]);
    await expectRefusal(run('NEG', 5), /CC1010 carries a net credit of 50/);
  });

  it('a sender in two segments, and a centre assessing itself, are refused', async () => {
    await cycle('DUP', [
      { number: 1, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC1000', '100']] },
      { number: 2, rule: 'PERCENTAGE', senders: [{ group: 'SVC2' }], receivers: [['CC1010', '100']] },
    ]);
    await expectRefusal(preview('DUP', 4), /CC2000 is a sender in segment 1 and segment 2/);
    await cycle('SELF', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC2000', '50'], ['CC1000', '50']] }]);
    await expectRefusal(preview('SELF', 4), /CC2000 is both a sender and a receiver in segment 1/);
  });

  it('a chained allocation across segments stands', async () => {
    await cycle('CHAIN', [
      { number: 1, rule: 'PERCENTAGE', senders: ['CC5000'], receivers: [['CC2000', '100']] },
      { number: 2, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC1000', '100']] },
    ]);
    const view = await preview('CHAIN', 4);
    // One pass: segment 2 sends what CC2000 carried before the run.
    expect(view.segments.map((s) => s.total)).toEqual(['800.0000', '800.0000']);
  });

  it('13. a distribution cycle is refused by name', async () => {
    await cycle('DIST', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC1000', '100']] }], 'DISTRIBUTION');
    await expectRefusal(run('DIST', 4), /Cycle DIST is a distribution cycle\. Distribution is not built/);
  });

  it('a group that does not resolve is refused', async () => {
    await cycle('EMPT', [{ number: 1, rule: 'PERCENTAGE', senders: [{ group: 'EMPTY' }], receivers: [['CC1000', '100']] }]);
    await expectRefusal(preview('EMPT', 4), /Group EMPTY resolves to no cost centre/);
  });

  it('14. a missing CO_ASSESSMENT determination is refused, naming /config/account-determination', async () => {
    const before = await withTenant(client, async (tx) => (await tx.execute(sql`delete from account_determination where client = ${client} and event = 'CO_ASSESSMENT' returning chart_of_accounts`)) as unknown as Array<{ chart_of_accounts: string }>);
    try {
      const refusal = await expectRefusal(preview('ASM2', 4), /No account is determined for posting event CO_ASSESSMENT/);
      expect(refusal.remedy).toContain('/config/account-determination');
    } finally {
      for (const b of before) {
        await withTenant(client, (tx) => tx.execute(sql`insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values (${client}, ${b.chart_of_accounts}, 'CO_ASSESSMENT', '', '', ${ACCOUNT}, ${ACTOR})`));
      }
    }
  });

  it('15. a closed period is refused', async () => {
    const restore = await withTenant(client, async (tx) => {
      const rows = (await tx.execute(sql`select r.variant, r.period_to from posting_period_rule r join company_code c on c.client = r.client and c.posting_period_variant = r.variant
        where r.client = ${client} and c.company_code = '1000' and r.account_type = 'S'`)) as unknown as Array<{ variant: string; period_to: number }>;
      await tx.execute(sql`update posting_period_rule set period_to = 3 where client = ${client} and variant = ${rows[0]!.variant} and account_type = 'S'`);
      return rows[0]!;
    });
    try {
      await expectRefusal(preview('ASM2', 4), /Period 4 of fiscal year 2026 is closed/);
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`update posting_period_rule set period_to = ${restore.period_to} where client = ${client} and variant = ${restore.variant} and account_type = 'S'`));
    }
  });

  it('16. a centre not valid for the period, or locked, is refused', async () => {
    await cycle('SHORT', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC6000', '100']] }]);
    await expectRefusal(preview('SHORT', 7), /CC6000 is not valid in period 7/);
    await withTenant(client, (tx) => tx.execute(sql`update cost_center set is_posting_locked = true where client = ${client} and cost_center = 'CC6000'`));
    try {
      await expectRefusal(preview('SHORT', 4), /CC6000 is locked for posting/);
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`update cost_center set is_posting_locked = false where client = ${client} and cost_center = 'CC6000'`));
    }
  });

  it('19. an actor without CO.ASSESSMENT.EXECUTE is refused by the service', async () => {
    const definer = await createFinanceActor(client, { capabilities: ['CFG.COST.ALLOCATION.DEFINE'] });
    await expectRefusal(runAssessment({ client, changedBy: definer.username, controllingArea: 'A000', cycleCode: 'ASM2', fiscalYear: YEAR, period: 4, reason: REASON }, { authorization: definer.authorization }), /You do not hold CO\.ASSESSMENT\.EXECUTE/);
    await expectRefusal(previewAssessment({ client, changedBy: 'x', controllingArea: 'A000', cycleCode: 'ASM2', fiscalYear: YEAR, period: 4, reason: REASON }), /signed-in user/);
    await expectRefusal(saveCycle({ client, changedBy: definer.username, mode: 'CREATE', controllingArea: 'A000', cycleCode: 'X1', name: 'x', validFrom: `${YEAR}-01-01`, validTo: `${YEAR}-12-31`, reason: REASON }, { authorization: (await createFinanceActor(client, { capabilities: ['CO.ASSESSMENT.EXECUTE'] })).authorization }), /CFG\.COST\.ALLOCATION\.DEFINE/);
  });

  it('20. an actor whose scope misses a company of the area is refused, naming the company', async () => {
    const elsewhere = await createFinanceActor(client, { capabilities: ['CO.ASSESSMENT.EXECUTE'], companyScopes: ['ZZZZ'] });
    await expectRefusal(previewAssessment({ client, changedBy: elsewhere.username, controllingArea: 'A000', cycleCode: 'ASM2', fiscalYear: YEAR, period: 4, reason: REASON }, { authorization: elsewhere.authorization }), /does not cover company code 1000 of Controlling Area A000/);
  });

  it('a cycle with runs is not deleted; a reason is required', async () => {
    await expectRefusal(deleteCycle({ ...actor(), controllingArea: 'A000', cycleCode: 'ASM1', reason: REASON }, auth()), /has been executed/);
    await expectRefusal(run('ASM2', 4, { reason: '' }), /A reason is required/);
    await deleteCycle({ ...actor(), controllingArea: 'A000', cycleCode: 'ZERO', reason: REASON }, auth());
    expect(await getCycle(client, 'A000', 'ZERO')).toBeNull();
  });
});
