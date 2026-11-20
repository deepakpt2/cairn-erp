/**
 * Distribution cycles (KSV5) — the run of a cycle whose category is DISTRIBUTION.
 *
 * What is worth proving: a distribution posts one AL document on the account each cost was posted to
 * (never the assessment account, no CO_ASSESSMENT determination); every account nets to zero across the
 * document and the sender is relieved on each account; shares in a group sum exactly under every
 * receiver rule; a negative per-account net is distributed, not dropped; a sender whose accounts cancel
 * is refused; allocation output is never read back as primary cost — by document, not by type, so a
 * re-run after a real reversal (an AB document) reproduces the first run's amounts; a sender already
 * on a live run's document is refused rather than relieved twice; and authority follows the category.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postGlDocument as postGlDocumentService } from '../src/modules/finance/gl-document';
import { reverseDocument as reverseDocumentService } from '../src/modules/finance/document-reversal';
import { saveCostCenter } from '../src/modules/foundation/cost-center-definition';
import {
  AllocationCycleError,
  allocateGroups,
  cancelAssessmentRun,
  executeCapabilityFor,
  listRuns,
  previewAssessment,
  runAssessment,
  saveCycle,
  setReceiver,
  setSegment,
  setSender,
} from '../src/modules/foundation/cost-allocation-cycle';
import { configActivityStatus } from '@/platform/tables/registry';
import { controllingAreaCompany } from '@/modules/foundation/schema';
import { closeDb, createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';
import { createFinanceActor, financePoster, type FinanceActor, withFinanceAuth } from './helpers/finance-actor';

const ACTOR = 'KSV5-TEST';
const reverseDocument = withFinanceAuth(reverseDocumentService);
const REASON = 'KSV5 automated test';
const YEAR = 2026;
const ASSESSMENT_ACCOUNT = '690000';
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
const date = (period: number, day = 10) => `${YEAR}-${String(period).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** Post a cost on a centre: debit the account with the centre, credit the bank. Negative = a credit on the centre. */
async function cost(centre: string, amount: number, period: number, account = '400000') {
  const debit = amount > 0;
  await postGlDocument({
    client, changedBy: ACTOR, requestKey: `ksv5-${randomUUID()}`, companyCode: '1000', documentDate: date(period), postingDate: date(period),
    documentType: 'SA', currency: 'USD',
    lines: [
      { glAccount: account, debitCredit: debit ? 'S' : 'H', amount: Math.abs(amount).toFixed(2), costCenter: centre },
      { glAccount: '101000', debitCredit: debit ? 'H' : 'S', amount: Math.abs(amount).toFixed(2) },
    ],
  });
}

type Rule = 'PERCENTAGE' | 'PORTION' | 'FIXED_AMOUNT';
async function cycle(code: string, segments: Array<{ number: number; rule: Rule; senders: string[]; receivers: Array<[string, string]>; from?: string; to?: string }>, category: 'ASSESSMENT' | 'DISTRIBUTION' = 'DISTRIBUTION') {
  await saveCycle({ ...actor(), mode: 'CREATE', controllingArea: 'A000', cycleCode: code, name: `Cycle ${code}`, category, validFrom: `${YEAR}-01-01`, validTo: `${YEAR}-12-31`, isActive: true, reason: REASON }, auth());
  for (const s of segments) {
    await setSegment({ ...actor(), controllingArea: 'A000', cycleCode: code, segmentNumber: s.number, name: `Segment ${s.number}`, receiverRule: s.rule, costElementFrom: s.from ?? '', costElementTo: s.to ?? '', reason: REASON }, auth());
    for (const [i, centre] of s.senders.entries()) {
      await setSender({ ...actor(), controllingArea: 'A000', cycleCode: code, segmentNumber: s.number, itemNumber: i + 1, costCenter: centre, reason: REASON }, auth());
    }
    for (const [i, [centre, weight]] of s.receivers.entries()) {
      await setReceiver({ ...actor(), controllingArea: 'A000', cycleCode: code, segmentNumber: s.number, itemNumber: i + 1, costCenter: centre, weight, reason: REASON }, auth());
    }
  }
}

const input = (code: string, period: number) => ({ ...actor(), controllingArea: 'A000', cycleCode: code, fiscalYear: YEAR, period, reason: REASON });
const run = (code: string, period: number) => runAssessment(input(code, period), auth());
const preview = (code: string, period: number) => previewAssessment(input(code, period), auth());

interface Line { gl_account: string; debit_credit: string; amount: string; cost_center: string | null; document_type: string }
async function documentLines(documentNumber: string): Promise<Line[]> {
  return withTenant(client, async (tx) => (await tx.execute(sql`
    select l.gl_account, l.debit_credit, l.amount_local::text as amount, l.cost_center, e.document_type
      from journal_entry_line l join journal_entry e on e.client = l.client and e.company_code = l.company_code and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
     where l.client = ${client} and l.document_number = ${documentNumber} order by l.line_number`)) as unknown as Line[]);
}
const signed = (l: Line) => (l.debit_credit === 'S' ? 1 : -1) * Math.round(Number(l.amount) * 100);
/** Net in cents on an account over the lines, optionally for one centre. */
const net = (lines: Line[], account: string, centre?: string) =>
  lines.filter((l) => l.gl_account === account && (centre === undefined || l.cost_center === centre)).reduce((s, l) => s + signed(l), 0);
const normal = (lines: Line[]) => lines.map((l) => `${l.cost_center}|${l.gl_account}|${l.debit_credit}|${l.amount}`).sort();

async function runRow(code: string) {
  return withTenant(client, async (tx) => (await tx.execute(sql`select run_id, category, assessment_account, assessed_total::text as total, document_number, status from cost_allocation_run where client = ${client} and cycle_code = ${code} order by executed_at`)) as unknown as Array<{ run_id: string; category: string; assessment_account: string | null; total: string; document_number: string; status: string }>);
}

async function copyAccount(account: string, name: string) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`insert into gl_account
      select (jsonb_populate_record(null::gl_account, to_jsonb(g) || jsonb_build_object('account_number', ${account}::text, 'name', ${name}::text, 'created_by', ${ACTOR}::text))).*
        from gl_account g where g.client = ${client} and g.account_number = '400000'
          and not exists (select 1 from gl_account x where x.client = g.client and x.chart_of_accounts = g.chart_of_accounts and x.account_number = ${account})`);
    await tx.execute(sql`insert into gl_account_company
      select (jsonb_populate_record(null::gl_account_company, to_jsonb(g) || jsonb_build_object('gl_account', ${account}::text, 'created_by', ${ACTOR}::text))).*
        from gl_account_company g where g.client = ${client} and g.gl_account = '400000'
          and not exists (select 1 from gl_account_company x where x.client = g.client and x.company_code = g.company_code and x.gl_account = ${account})`);
  });
}

beforeAll(async () => {
  tenant = await createTenant('ksv5-distribution');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: YEAR });
  await withTenant(client, async (tx) => {
    for (const activityCode of ['CFG.COST.CONTROLLINGAREA.DEFINE', 'CFG.COST.COSTCENTER.DEFINE']) {
      await tx.insert(configActivityStatus).values({ client, activityCode, status: 'COMPLETED', createdBy: ACTOR })
        .onConflictDoUpdate({ target: [configActivityStatus.client, configActivityStatus.activityCode], set: { status: 'COMPLETED', changedBy: ACTOR, changedAt: new Date() } });
    }
    await tx.insert(controllingAreaCompany).values({ client, controllingArea: 'A000', companyCode: '1000', createdBy: ACTOR }).onConflictDoNothing();
  });
  // Accounts of the chart beside 400000 / 410000: 420000 (reclass) and 430000 (nets to zero), and the
  // assessment account — whose determination is added only for the regression test, not for distribution.
  await copyAccount('420000', 'Reclass');
  await copyAccount('430000', 'Other');
  await copyAccount(ASSESSMENT_ACCOUNT, 'Internal cost allocation');
  for (const [centre, name] of [
    ['CC1000', 'Mixing'], ['CC1010', 'Packing'], ['CC2000', 'Warehousing'], ['CC3000', 'Maintenance'],
    ['CC4000', 'Quality'], ['CC5000', 'Administration'], ['CC6000', 'Facilities'],
  ] as const) {
    await saveCostCenter({ client, changedBy: ACTOR, mode: 'CREATE', controllingArea: 'A000', costCenter: centre, validFrom: `${YEAR}-01-01`, validTo: `${YEAR}-12-31`, name, personResponsible: '', category: 'PRODUCTION', companyCode: '1000', reason: REASON });
  }
  controller = await createFinanceActor(client, { capabilities: ['CFG.COST.ALLOCATION.DEFINE', 'CO.DISTRIBUTION.EXECUTE', 'CO.ASSESSMENT.EXECUTE', 'FIN.JOURNAL.POST'] });

  // April, Warehousing: the worked example of the spec — 8,000 salaries, 2,000 rent, a 500 credit reclass,
  // and an account that nets to zero (430000: +300, −300).
  await cost('CC2000', 8000, 4, '400000');
  await cost('CC2000', 2000, 4, '410000');
  await cost('CC2000', -500, 4, '420000');
  await cost('CC2000', 300, 4, '430000');
  await cost('CC2000', -300, 4, '430000');
  // May to August, Maintenance: three accounts that do not divide evenly (140.03 in total). May, June and
  // July are run; August is only previewed, so no live run stands on the centre there.
  for (const period of [5, 6, 7, 8]) {
    await cost('CC3000', 100.01, period, '400000');
    await cost('CC3000', 50.03, period, '410000');
    await cost('CC3000', -10.01, period, '420000');
  }
  // September, Administration: accounts that cancel (+500 / −500).
  await cost('CC5000', 500, 9, '400000');
  await cost('CC5000', -500, 9, '410000');
  // October, Administration: the re-run test.
  await cost('CC5000', 1000, 10, '400000');
  await cost('CC5000', 200, 10, '410000');
  // November: two segments chained.
  await cost('CC5000', 500, 11, '400000');
  await cost('CC2000', 800, 11, '400000');
}, 240_000);

afterAll(async () => {
  if (tenant) await destroyTenant(tenant.client);
  await closeDb();
});

describe('allocateGroups (pure)', () => {
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const scaled = (n: number) => BigInt(Math.round(n * 10000));

  it('5. every group sums to its net exactly, the residual to the largest receiver, in a two-decimal currency', () => {
    const nets = [scaled(100.01), scaled(50.03), scaled(-10.01)];
    for (const rule of ['PERCENTAGE', 'PORTION'] as const) {
      const shares = allocateGroups(rule, rule === 'PERCENTAGE' ? ['33', '33', '34'] : ['1', '1', '1'], nets, 2);
      shares.forEach((g, i) => {
        expect(sum(g)).toBe(nets[i]);
        expect(g.every((x) => x % 100n === 0n)).toBe(true); // whole cents
      });
    }
  });

  it('6. FIXED_AMOUNT: weights are the segment total; groups split in proportion, each receiver ends with exactly its amount', () => {
    const nets = [scaled(100.01), scaled(50.03), scaled(-10.01)];
    const fixed = ['40.03', '50', '50'];
    const shares = allocateGroups('FIXED_AMOUNT', fixed, nets, 2);
    shares.forEach((g, i) => expect(sum(g)).toBe(nets[i]));
    [0, 1, 2].forEach((r) => expect(shares.reduce((s, g) => s + g[r]!, 0n)).toBe(scaled(Number(fixed[r]))));
    expect(() => allocateGroups('FIXED_AMOUNT', ['40', '50', '50'], nets, 2)).toThrow(/sum to 140.0000, but the senders send 140.0300/);
  });
});

describe('a distribution run', () => {
  let documentNumber = '';
  let lines: Line[] = [];

  it('1. a distribution cycle runs — the refusal is gone — and needs no CO_ASSESSMENT determination', async () => {
    await cycle('DST1', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC1000', '60'], ['CC1010', '40']] }]);
    const det = await withTenant(client, async (tx) => (await tx.execute(sql`select count(*)::int as n from account_determination where client = ${client} and event = 'CO_ASSESSMENT'`)) as unknown as Array<{ n: number }>);
    expect(det[0]!.n).toBe(0);
    const view = await preview('DST1', 4);
    expect(view).toMatchObject({ category: 'DISTRIBUTION', assessmentAccount: null, assessedTotal: '9500.0000' });
    const result = await run('DST1', 4);
    documentNumber = result.documentNumber;
    expect(result).toMatchObject({ category: 'DISTRIBUTION', assessmentAccount: null, assessedTotal: '9500.0000', postingDate: `${YEAR}-04-30` });
    lines = await documentLines(documentNumber);
    expect(new Set(lines.map((l) => l.document_type))).toEqual(new Set(['AL']));
  });

  it('2. the document carries every sender account with a non-zero net and no account that had none', () => {
    expect(new Set(lines.map((l) => l.gl_account))).toEqual(new Set(['400000', '410000', '420000']));
    expect(lines.some((l) => l.gl_account === ASSESSMENT_ACCOUNT)).toBe(false);
    expect(lines.some((l) => l.gl_account === '430000')).toBe(false);
    expect(lines.every((l) => l.cost_center)).toBe(true);
  });

  it('the worked example: sender lines opposite the net, receivers charged on the same account, a negative net reversed in direction', () => {
    const find = (centre: string, account: string) => lines.filter((l) => l.cost_center === centre && l.gl_account === account).map((l) => `${l.debit_credit} ${l.amount}`);
    expect(find('CC2000', '400000')).toEqual(['H 8000.0000']);
    expect(find('CC1000', '400000')).toEqual(['S 4800.0000']);
    expect(find('CC1010', '400000')).toEqual(['S 3200.0000']);
    expect(find('CC2000', '410000')).toEqual(['H 2000.0000']);
    expect(find('CC1000', '410000')).toEqual(['S 1200.0000']);
    expect(find('CC1010', '410000')).toEqual(['S 800.0000']);
    // 7. a negative per-account net is distributed: the sender is debited, the receivers credited.
    expect(find('CC2000', '420000')).toEqual(['S 500.0000']);
    expect(find('CC1000', '420000')).toEqual(['H 300.0000']);
    expect(find('CC1010', '420000')).toEqual(['H 200.0000']);
    const debits = lines.filter((l) => l.debit_credit === 'S').reduce((s, l) => s + Number(l.amount), 0);
    const credits = lines.filter((l) => l.debit_credit === 'H').reduce((s, l) => s + Number(l.amount), 0);
    expect([debits, credits]).toEqual([10500, 10500]);
  });

  it('3. each account nets to zero across the document', () => {
    for (const account of ['400000', '410000', '420000']) expect(net(lines, account)).toBe(0);
  });

  it('4. after the run the sender is at zero on every account it was relieved of', async () => {
    const rows = await withTenant(client, async (tx) => (await tx.execute(sql`
      select l.gl_account, sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end)::text as net
        from journal_entry_line l join journal_entry e on e.client = l.client and e.company_code = l.company_code and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
       where l.client = ${client} and l.cost_center = 'CC2000' and e.posting_period = 4 and e.status in ('POSTED', 'REVERSED')
       group by l.gl_account order by 1`)) as unknown as Array<{ gl_account: string; net: string }>);
    expect(rows.map((r) => [r.gl_account, Number(r.net)])).toEqual([['400000', 0], ['410000', 0], ['420000', 0], ['430000', 0]]);
  });

  it('the run row says distribution, carries no assessment account, and the database enforces the pairing', async () => {
    const [row] = await runRow('DST1');
    expect(row).toMatchObject({ category: 'DISTRIBUTION', assessment_account: null, total: '9500.0000', status: 'EXECUTED' });
    expect((await listRuns(client, 'A000'))[0]).toMatchObject({ cycleCode: 'DST1', category: 'DISTRIBUTION' });
    await expect(withTenant(client, (tx) => tx.execute(sql`update cost_allocation_run set assessment_account = ${ASSESSMENT_ACCOUNT} where client = ${client} and cycle_code = 'DST1'`))).rejects.toThrow();
    await expect(withTenant(client, (tx) => tx.execute(sql`update cost_allocation_run set category = 'ASSESSMENT' where client = ${client} and cycle_code = 'DST1'`))).rejects.toThrow();
  });

  it('10. allocation output is not primary cost: a second cycle over the same sender is refused, naming the run and cycle — never relieved twice', async () => {
    await cycle('DST2', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC4000', '100']] }]);
    const [first] = await runRow('DST1');
    await expectRefusal(run('DST2', 4), new RegExp(`CC2000 already stands on the document of run ${first!.run_id} of cycle DST1 in period 4/${YEAR}`));
    // A receiver of the first run cannot pass the received cost on in the same period either (chaining needs iteration).
    await cycle('DST3', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC1000'], receivers: [['CC4000', '100']] }]);
    await expectRefusal(run('DST3', 4), /CC1000 already stands on the document of run .* of cycle DST1/);
  });
});

describe('receiver rules, per group (two-decimal currency, amounts that do not divide)', () => {
  /** What each receiver and sender carries on each account in the document, in cents. */
  const grouped = (lines: Line[], centre: string) => ['400000', '410000', '420000'].map((a) => net(lines, a, centre));

  it('5, 6. PERCENTAGE: every group sums exactly, the residual to the largest receiver', async () => {
    await cycle('PCT', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC3000'], receivers: [['CC1000', '33'], ['CC1010', '33'], ['CC4000', '34']] }]);
    const lines = await documentLines((await run('PCT', 5)).documentNumber);
    expect(grouped(lines, 'CC3000')).toEqual([-10001, -5003, 1001]);
    for (const [i, account] of ['400000', '410000', '420000'].entries()) {
      const receivers = ['CC1000', 'CC1010', 'CC4000'].reduce((s, c) => s + net(lines, account, c), 0);
      expect(receivers).toBe(-grouped(lines, 'CC3000')[i]!);
    }
    expect(lines.every((l) => /^\d+\.\d\d00$/.test(l.amount))).toBe(true);
  });

  it('6. PORTION: every group sums exactly', async () => {
    await cycle('PTN', [{ number: 1, rule: 'PORTION', senders: ['CC3000'], receivers: [['CC1000', '1'], ['CC1010', '2'], ['CC4000', '3']] }]);
    const lines = await documentLines((await run('PTN', 6)).documentNumber);
    expect(grouped(lines, 'CC3000')).toEqual([-10001, -5003, 1001]);
    for (const [i, account] of ['400000', '410000', '420000'].entries()) {
      const receivers = ['CC1000', 'CC1010', 'CC4000'].reduce((s, c) => s + net(lines, account, c), 0);
      expect(receivers).toBe(-grouped(lines, 'CC3000')[i]!);
    }
  });

  it('6. FIXED_AMOUNT: the fixed amounts are the segment total; every group sums exactly and each receiver gets its amount', async () => {
    await cycle('FIX', [{ number: 1, rule: 'FIXED_AMOUNT', senders: ['CC3000'], receivers: [['CC1000', '40.03'], ['CC1010', '50'], ['CC4000', '50']] }]);
    const lines = await documentLines((await run('FIX', 7)).documentNumber);
    for (const [i, account] of ['400000', '410000', '420000'].entries()) {
      const receivers = ['CC1000', 'CC1010', 'CC4000'].reduce((s, c) => s + net(lines, account, c), 0);
      expect(receivers).toBe(-grouped(lines, 'CC3000')[i]!);
    }
    const total = (centre: string) => ['400000', '410000', '420000'].reduce((s, a) => s + net(lines, a, centre), 0);
    expect([total('CC1000'), total('CC1010'), total('CC4000')]).toEqual([4003, 5000, 5000]);
  });

  it('FIXED_AMOUNT amounts that do not match the segment total are refused', async () => {
    await cycle('FIXB', [{ number: 1, rule: 'FIXED_AMOUNT', senders: ['CC3000'], receivers: [['CC1000', '40'], ['CC1010', '50']] }]);
    await expectRefusal(preview('FIXB', 8), /fixed amounts sum to 90.0000, but the senders send 140.0300/);
  });
});

describe('refusals', () => {
  it('8. a sender whose accounts cancel out is refused, naming the sender and the total', async () => {
    await cycle('CNL', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC5000'], receivers: [['CC1000', '100']] }]);
    await expectRefusal(preview('CNL', 9), /Cost Centre CC5000 carries a net cost of 0\.0000 in period 9\/2026.*no cost to distribute/);
  });

  it('a sender with no posted cost at all is the same refusal', async () => {
    await cycle('NOC', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC6000'], receivers: [['CC1000', '100']] }]);
    await expectRefusal(preview('NOC', 4), /Cost Centre CC6000 carries a net cost of 0\.0000/);
  });

  it('12. an unrecognised category is refused, naming it', () => {
    expect(() => executeCapabilityFor('SPLITTING')).toThrow(/Cycle category SPLITTING is not recognised/);
    expect(executeCapabilityFor('ASSESSMENT')).toBe('CO.ASSESSMENT.EXECUTE');
    expect(executeCapabilityFor('DISTRIBUTION')).toBe('CO.DISTRIBUTION.EXECUTE');
  });

  it('the cost element range restricts which accounts are distributed', async () => {
    await cycle('RNG', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC3000'], receivers: [['CC1000', '100']], from: '410000', to: '419999' }]);
    const view = await preview('RNG', 8);
    expect(view.segments[0]!.accounts).toEqual([{ costCenter: 'CC3000', glAccount: '410000', amount: '50.0300' }]);
    expect(view.assessedTotal).toBe('50.0300');
  });
});

describe('the re-run after a real reversal', () => {
  it('9. run, reverse the document through the reversal action, cancel the run, run again — identical amounts', async () => {
    await cycle('RRN', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC5000'], receivers: [['CC1000', '60'], ['CC1010', '40']] }]);
    const first = await run('RRN', 10);
    const firstLines = await documentLines(first.documentNumber);
    expect(first.assessedTotal).toBe('1200.0000');

    // An AL document is reversed by an AB document that names it — a filter on type AL would keep the reversal.
    const reversal = await reverseDocument({
      client, changedBy: ACTOR, companyCode: '1000', documentNumber: first.documentNumber, fiscalYear: YEAR, reasonCode: '01',
      documentDate: date(10, 31), postingDate: date(10, 31), confirmed: true, requestKey: `ksv5-rev-${first.documentNumber}`,
    });
    expect(reversal.reversalDocumentType).toBe('AB');
    const reversalLines = await documentLines(reversal.reversalDocumentNumber);
    expect(new Set(reversalLines.map((l) => l.document_type))).toEqual(new Set(['AB']));
    const [link] = await withTenant(client, async (tx) => (await tx.execute(sql`select reversal_of, status from journal_entry where client = ${client} and document_number = ${reversal.reversalDocumentNumber}`)) as unknown as Array<{ reversal_of: string; status: string }>);
    expect(link).toMatchObject({ reversal_of: first.documentNumber, status: 'POSTED' });

    const [row] = await runRow('RRN');
    await cancelAssessmentRun({ ...actor(), runId: row!.run_id, reason: 'Reversed for correction' }, auth());

    const second = await run('RRN', 10);
    expect(second.documentNumber).not.toBe(first.documentNumber);
    expect(second.assessedTotal).toBe(first.assessedTotal);
    expect(normal(await documentLines(second.documentNumber))).toEqual(normal(firstLines));
  });
});

describe('chained segments', () => {
  it('11. two segments, sender to receiver: costs are those from before the run, as assessment does', async () => {
    await cycle('CHN', [
      { number: 1, rule: 'PERCENTAGE', senders: ['CC5000'], receivers: [['CC2000', '100']] },
      { number: 2, rule: 'PERCENTAGE', senders: ['CC2000'], receivers: [['CC1000', '100']] },
    ]);
    const view = await preview('CHN', 11);
    expect(view.segments.map((s) => s.total)).toEqual(['500.0000', '800.0000']);
    const lines = await documentLines((await run('CHN', 11)).documentNumber);
    expect(net(lines, '400000', 'CC2000')).toBe(50000 - 80000);
    expect(net(lines, '400000', 'CC1000')).toBe(80000);
    expect(net(lines, '400000')).toBe(0);
  });
});

describe('assessment is unchanged', () => {
  it('13. an assessment still runs on the determined account, still needs that determination, and a distribution does not', async () => {
    await withTenant(client, (tx) => tx.execute(sql`insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select distinct client, chart_of_accounts, 'CO_ASSESSMENT', '', '', ${ASSESSMENT_ACCOUNT}, ${ACTOR} from gl_account where client = ${client} and account_number = ${ASSESSMENT_ACCOUNT}`));
    await cost('CC4000', 400, 12, '400000');
    await cycle('ASM', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC4000'], receivers: [['CC1000', '100']] }], 'ASSESSMENT');
    const result = await run('ASM', 12);
    expect(result).toMatchObject({ category: 'ASSESSMENT', assessmentAccount: ASSESSMENT_ACCOUNT, assessedTotal: '400.0000' });
    const lines = await documentLines(result.documentNumber);
    expect(lines.every((l) => l.gl_account === ASSESSMENT_ACCOUNT && l.cost_center)).toBe(true);
    expect(net(lines, ASSESSMENT_ACCOUNT)).toBe(0);
    const [row] = await runRow('ASM');
    expect(row).toMatchObject({ category: 'ASSESSMENT', assessment_account: ASSESSMENT_ACCOUNT });

    // Without the determination: assessment refused, a distribution of the same period runs.
    await cost('CC6000', 250, 12, '410000');
    await cycle('DSTN', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC6000'], receivers: [['CC1010', '100']] }]);
    await cycle('ASM2', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC6000'], receivers: [['CC1010', '100']] }], 'ASSESSMENT');
    const removed = await withTenant(client, async (tx) => (await tx.execute(sql`delete from account_determination where client = ${client} and event = 'CO_ASSESSMENT' returning chart_of_accounts`)) as unknown as Array<{ chart_of_accounts: string }>);
    try {
      await expectRefusal(preview('ASM2', 12), /No account is determined for posting event CO_ASSESSMENT/);
      expect((await run('DSTN', 12)).assessedTotal).toBe('250.0000');
    } finally {
      for (const r of removed) {
        await withTenant(client, (tx) => tx.execute(sql`insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by) values (${client}, ${r.chart_of_accounts}, 'CO_ASSESSMENT', '', '', ${ASSESSMENT_ACCOUNT}, ${ACTOR})`));
      }
    }
  });
});

describe('authority and the screen', () => {
  it('15. a distribution run, preview and cancel by an actor without CO.DISTRIBUTION.EXECUTE are refused by the service', async () => {
    const assessor = await createFinanceActor(client, { capabilities: ['CO.ASSESSMENT.EXECUTE'] });
    const asAssessor = { authorization: assessor.authorization };
    const who = { client, changedBy: assessor.username };
    await cycle('AUT', [{ number: 1, rule: 'PERCENTAGE', senders: ['CC3000'], receivers: [['CC1000', '100']] }]);
    await expectRefusal(runAssessment({ ...who, controllingArea: 'A000', cycleCode: 'DST3', fiscalYear: YEAR, period: 8, reason: REASON }, asAssessor), /You do not hold CO\.DISTRIBUTION\.EXECUTE/);
    await expectRefusal(previewAssessment({ ...who, controllingArea: 'A000', cycleCode: 'DST3', fiscalYear: YEAR, period: 8, reason: REASON }, asAssessor), /You do not hold CO\.DISTRIBUTION\.EXECUTE/);
    const [dist] = await runRow('DST1');
    await expectRefusal(cancelAssessmentRun({ ...who, runId: dist!.run_id, reason: REASON }, asAssessor), /You do not hold CO\.DISTRIBUTION\.EXECUTE/);

    // And the other way round: a distribution holder cannot run an assessment.
    const distributor = await createFinanceActor(client, { capabilities: ['CO.DISTRIBUTION.EXECUTE'] });
    await expectRefusal(previewAssessment({ client, changedBy: distributor.username, controllingArea: 'A000', cycleCode: 'ASM', fiscalYear: YEAR, period: 8, reason: REASON }, { authorization: distributor.authorization }), /You do not hold CO\.ASSESSMENT\.EXECUTE/);
    expect((await previewAssessment({ client, changedBy: distributor.username, controllingArea: 'A000', cycleCode: 'AUT', fiscalYear: YEAR, period: 8, reason: REASON }, { authorization: distributor.authorization })).category).toBe('DISTRIBUTION');
  });

  it('14. the screen offers the category, defaulting to Assessment, and the run list says which it is', () => {
    const forms = readFileSync('src/app/controlling/allocation-cycles/CycleForms.tsx', 'utf8');
    expect(forms).toContain(`name="category" defaultValue={cycle?.category ?? 'ASSESSMENT'}`);
    expect(forms.indexOf('<option value="ASSESSMENT">Assessment</option>')).toBeGreaterThan(-1);
    expect(forms).toContain('<option value="DISTRIBUTION">Distribution</option>');
    expect(forms).toContain(`view.assessmentAccount ? \`account \${view.assessmentAccount}\` : 'original accounts'`);
    const page = readFileSync('src/app/controlling/allocation-cycles/page.tsx', 'utf8');
    expect(page).toContain('<th>Category</th>');
    expect(page).toContain('{r.category.toLowerCase()}');
  });
});
