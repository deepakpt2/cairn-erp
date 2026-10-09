/** Real write actions, with only request/session and framework cache mocked. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '@/platform/auth/session';
import { createTenant, destroyTenant, withTenant, closeDb, type TestTenant } from './helpers';
import { maintainNumberRange, listNumberRanges } from '@/modules/foundation/number-ranges';

const request = vi.hoisted(() => ({ session: null as SessionContext | null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/platform/auth/current', async (original) => {
  const actual = await original<typeof import('@/platform/auth/current')>();
  return { ...actual, requireSession: vi.fn(async () => {
    if (!request.session) throw new Error('AUTH_REDIRECT');
    return request.session;
  }) };
});
import { savePeriodRule } from '@/app/config/posting-periods/actions';
import { saveNumberRange } from '@/app/config/number-ranges/actions';
import { postJournalAction } from '@/app/finance/journal/new/actions';
import { saveMaterialAction } from '@/app/inventory/materials/actions';
import { getMaterialDetail } from '@/modules/inventory/materials';

let alpha: TestTenant; let beta: TestTenant;
const year = new Date().getUTCFullYear();
beforeAll(async () => {
  alpha = await createTenant('action-alpha'); beta = await createTenant('action-beta');
  await maintainNumberRange({ client: alpha.client, objectCode: 'JOURNAL_ENTRY', companyCode: '1000', subObject: 'GENERAL', fiscalYear: 0, prefix: 'JE', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE', status: 'ACTIVE', mode: 'CREATE', changedBy: 'TEST', reason: 'Action test setup' });
});
afterAll(async () => { await destroyTenant(alpha.client); await destroyTenant(beta.client); await closeDb(); });
function signedIn(capabilities = ['*']) {
  request.session = { user: { client: alpha.client, userId: 'action-user', username: 'real.operator', fullName: 'Real Operator', email: null, mustChangePassword: false, capabilities }, expiresAt: new Date(Date.now() + 100000), renewed: false };
}
function form(values: Record<string, string>) {
  const data = new FormData(); for (const [k, v] of Object.entries(values)) data.set(k, v); return data;
}
function periodForm() { return form({ client: beta.client, changedBy: 'FORGED', variant: 'C001', accountType: 'S', periodFrom: '1', periodTo: '11', allowSpecialPeriods: 'on' }); }
function rangeForm() { return form({ client: beta.client, changedBy: 'FORGED', objectCode: 'JOURNAL_ENTRY', companyCode: '1000', subObject: 'GENERAL', fiscalYear: '0', prefix: 'JE', fromNumber: '1', toNumber: '1000000', numberLength: '6', displayStyle: 'READABLE', status: 'ACTIVE', mode: 'CHANGE', reason: 'Security verification' }); }
function journalForm() { return form({ client: beta.client, postedBy: 'FORGED', postingDate: `${year}-04-15`, companyCode: '1000', documentType: 'SA', currency: 'USD', reference: 'SECURITY-TEST', line_0_account: '100000', line_0_side: 'S', line_0_amount: '50.0000', line_1_account: '200000', line_1_side: 'H', line_1_amount: '50.0000' }); }

describe('server action security', () => {
  it('ignores a forged tenant/actor when changing posting controls', async () => {
    signedIn();
    expect((await savePeriodRule(periodForm())).ok).toBe(true);
    const own = await withTenant(alpha.client, (tx) => tx.execute(sql`select period_to, changed_by from posting_period_rule where account_type = 'S'`));
    const other = await withTenant(beta.client, (tx) => tx.execute(sql`select period_to from posting_period_rule where account_type = 'S'`));
    expect((own as unknown as Array<Record<string, unknown>>)[0]).toEqual({ period_to: 11, changed_by: 'real.operator' });
    expect((other as unknown as Array<{ period_to: number }>)[0].period_to).toBe(12);
  });

  it('refuses a period mutation without authority and leaves the database unchanged', async () => {
    signedIn(['AUDIT.*']);
    const data = periodForm(); data.set('periodTo', '10');
    const result = await savePeriodRule(data);
    expect(result.ok).toBe(false); expect(result.message).toContain('FIN.CLOSE.PERIOD');
    const own = await withTenant(alpha.client, (tx) => tx.execute(sql`select period_to from posting_period_rule where account_type = 'S'`));
    expect((own as unknown as Array<{ period_to: number }>)[0].period_to).toBe(11);
  });

  it('takes the number-range tenant and actor from the authenticated request', async () => {
    signedIn(); const data = rangeForm(); data.set('toNumber', '999998');
    expect((await saveNumberRange({ ok: true }, data)).ok).toBe(true);
    expect((await listNumberRanges(alpha.client)).ranges[0].changedBy).toBe('real.operator');
    expect((await listNumberRanges(beta.client)).ranges).toHaveLength(0);
  });

  it('refuses unauthorised number-range maintenance', async () => {
    signedIn(['FIN.JOURNAL.POST']);
    const result = await saveNumberRange({ ok: true }, rangeForm());
    expect(result.ok).toBe(false); expect(result.message).toContain('CFG.PLT.NUMBERRANGE.DEFINE');
  });

  it('posts in the session tenant under the actual user, not the form tenant', async () => {
    signedIn(); const result = await postJournalAction({ ok: true }, journalForm());
    expect(result.ok).toBe(true);
    const own = await withTenant(alpha.client, (tx) => tx.execute(sql`select created_by from journal_entry where document_number = ${result.documentNumber}`));
    const other = await withTenant(beta.client, (tx) => tx.execute(sql`select count(*)::int as n from journal_entry`));
    expect((own as unknown as Array<{ created_by: string }>)[0].created_by).toBe('real.operator');
    expect((other as unknown as Array<{ n: number }>)[0].n).toBe(0);
  });

  it('refuses a posting without its named authority', async () => {
    signedIn(['CFG.*']);
    const result = await postJournalAction({ ok: true }, journalForm());
    expect(result.ok).toBe(false); expect(result.message).toContain('FIN.JOURNAL.POST');
  });

  it('ignores a forged tenant and audit actor when creating a material', async () => {
    signedIn(['INV.MATERIAL.MAINTAIN']);
    const data = form({ client: beta.client, changedBy: 'FORGED', view: 'BASIC', materialNumber: 'ACTION-MATERIAL', expectedVersion: '0', description: 'Action master', materialType: 'RAW', materialGroup: 'RAW', baseUnit: 'KG', grossWeight: '0', netWeight: '0' });
    const result = await saveMaterialAction({ ok: true }, data);
    expect(result.ok).toBe(true);
    expect((await getMaterialDetail(alpha.client, 'ACTION-MATERIAL'))?.base.createdBy).toBe('real.operator');
    expect(await getMaterialDetail(beta.client, 'ACTION-MATERIAL')).toBeNull();
  });

  it('requires the separate valuation authority even for a basic-data maintainer', async () => {
    signedIn(['INV.*']);
    const result = await saveMaterialAction({ ok: true }, form({ view: 'ACCOUNTING', materialNumber: 'ACTION-MATERIAL', plant: '1000' }));
    expect(result.ok).toBe(false); expect(result.message).toContain('FIN.MATERIAL.VALUATION.MAINTAIN');
  });

  it('does not turn an authentication redirect into a posting-error response', async () => {
    request.session = null;
    await expect(postJournalAction({ ok: true }, journalForm())).rejects.toThrow('AUTH_REDIRECT');
    await expect(savePeriodRule(periodForm())).rejects.toThrow('AUTH_REDIRECT');
    await expect(saveNumberRange({ ok: true }, rangeForm())).rejects.toThrow('AUTH_REDIRECT');
    await expect(saveMaterialAction({ ok: true }, form({ view: 'BASIC' }))).rejects.toThrow('AUTH_REDIRECT');
  });
});
