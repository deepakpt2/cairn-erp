/**
 * Maintaining revenue account determination.
 *
 * This is the screen SAP calls VKOA, and it is the last piece of the pricing configuration: the
 * procedure says how a figure is calculated, the condition type says what kind of figure it is, and
 * this table says where it lands in the ledger. Without it the three are a calculation with nowhere to
 * post, which is why a document whose key stands undetermined is refused rather than posted somewhere
 * plausible.
 *
 * There is no delete. A row here is part of the rule an invoice was posted under, and a tenant that
 * wants a key to stop answering maintains a row that names a different account, or withdraws the row
 * so the refusal stands — which is the honest way to say that nothing is determined.
 */
import { and, asc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { chartOfAccounts, salesOrg } from '../foundation/schema';
import { glAccount } from '../finance/schema';
import { salesAccountDetermination } from './schema';
import { ACCOUNT_DETERMINATION_ROUTE, ACCOUNT_KEYS } from './account-determination';

export const ACCOUNT_DETERMINATION_CAPABILITY = 'CFG.SALES.ACCOUNT_DETERMINATION.DEFINE';
export const ACCOUNT_DETERMINATION_OBJECT_CLASS = 'sales_account_determination';

const CODE = /^[A-Z0-9]{0,4}$/;
const ACCOUNT = /^[A-Z0-9]{1,10}$/;

export class AccountDeterminationMaintenanceError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AccountDeterminationMaintenanceError';
    this.remedy = remedy;
  }
}

export interface AccountDeterminationRow {
  chartOfAccounts: string;
  salesOrg: string;
  customerAccountAssignmentGroup: string;
  materialAccountAssignmentGroup: string;
  accountKey: string;
  glAccount: string;
  isActive: boolean;
  /** What the key means, so the screen does not leave a reader to guess at ERL and ERS. */
  accountKeyName: string;
  accountName: string | null;
  /** Whether the account the row names still stands in the chart. */
  accountStands: boolean;
}

export interface AccountDeterminationConfiguration {
  rows: AccountDeterminationRow[];
  keys: Array<{ key: string; name: string; meaning: string }>;
  charts: string[];
  organisations: string[];
  accounts: Array<{ accountNumber: string; name: string; chartOfAccounts: string }>;
}

/** The table as it stands, with the keys it can be maintained for. */
export async function listAccountDetermination(client: string): Promise<AccountDeterminationConfiguration> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesAccountDetermination)
      .where(eq(salesAccountDetermination.client, client))
      .orderBy(
        asc(salesAccountDetermination.chartOfAccounts),
        asc(salesAccountDetermination.accountKey),
        asc(salesAccountDetermination.salesOrg),
        asc(salesAccountDetermination.customerAccountAssignmentGroup),
        asc(salesAccountDetermination.materialAccountAssignmentGroup),
      );
    const accounts = await tx.select({
      accountNumber: glAccount.accountNumber,
      name: glAccount.name,
      chartOfAccounts: glAccount.chartOfAccounts,
    }).from(glAccount).where(eq(glAccount.client, client)).orderBy(asc(glAccount.accountNumber));
    const byAccount = new Map(accounts.map((row) => [`${row.chartOfAccounts}/${row.accountNumber}`, row]));
    return {
      rows: rows.map((row) => ({
        chartOfAccounts: row.chartOfAccounts,
        salesOrg: row.salesOrg,
        customerAccountAssignmentGroup: row.customerAccountAssignmentGroup,
        materialAccountAssignmentGroup: row.materialAccountAssignmentGroup,
        accountKey: row.accountKey,
        glAccount: row.glAccount,
        isActive: row.isActive,
        accountKeyName: ACCOUNT_KEYS.find((key) => key.key === row.accountKey)?.name ?? row.accountKey,
        accountName: byAccount.get(`${row.chartOfAccounts}/${row.glAccount}`)?.name ?? null,
        accountStands: byAccount.has(`${row.chartOfAccounts}/${row.glAccount}`),
      })),
      keys: ACCOUNT_KEYS.map((key) => ({ key: key.key, name: key.name, meaning: key.meaning })),
      charts: (await tx.select({ chartOfAccounts: chartOfAccounts.chartOfAccounts })
        .from(chartOfAccounts).where(eq(chartOfAccounts.client, client))).map((row) => row.chartOfAccounts),
      organisations: (await tx.select({ salesOrg: salesOrg.salesOrg })
        .from(salesOrg).where(eq(salesOrg.client, client)).orderBy(asc(salesOrg.salesOrg))).map((row) => row.salesOrg),
      accounts,
    };
  });
}

/**
 * Name the account a key posts to.
 *
 * The two judgements that matter are that the account stands in the chart the row is maintained for —
 * a determination pointing at an account in another chart is a row that can never answer — and that
 * two rows cannot answer for one combination, which would leave the engine to choose between them.
 */
export async function defineAccountDetermination(input: {
  client: string; changedBy: string;
  chartOfAccounts: string;
  salesOrg?: string;
  customerAccountAssignmentGroup?: string;
  materialAccountAssignmentGroup?: string;
  accountKey: string;
  glAccount: string;
}): Promise<void> {
  const chart = input.chartOfAccounts.trim().toUpperCase();
  const org = (input.salesOrg ?? '').trim().toUpperCase();
  const customer = (input.customerAccountAssignmentGroup ?? '').trim().toUpperCase();
  const material = (input.materialAccountAssignmentGroup ?? '').trim().toUpperCase();
  const key = input.accountKey.trim().toUpperCase();
  const account = input.glAccount.trim().toUpperCase();
  if (!CODE.test(org) || !CODE.test(customer) || !CODE.test(material)) {
    throw new AccountDeterminationMaintenanceError(
      'A sales organisation and each account assignment group are named by up to four capital letters or digits, or left blank for any.',
      'Leave a part blank to have the row answer for every value of it.',
    );
  }
  if (!ACCOUNT.test(account)) {
    throw new AccountDeterminationMaintenanceError(
      `Account ${input.glAccount} is not an account number.`,
      'Name the G/L account in this chart that the key posts to.',
    );
  }
  return withTenant(input.client, async (tx) => {
    if (!ACCOUNT_KEYS.some((row) => row.key === key)) {
      throw new AccountDeterminationMaintenanceError(
        `Account key ${key} is not one this package determines.`,
        `Use one of the delivered keys — ${ACCOUNT_KEYS.map((row) => row.key).join(', ')} — which are the keys the pricing steps carry.`,
      );
    }
    const [standing] = await tx.select().from(glAccount).where(and(
      eq(glAccount.client, input.client), eq(glAccount.chartOfAccounts, chart),
      eq(glAccount.accountNumber, account),
    )).limit(1);
    if (!standing) {
      throw new AccountDeterminationMaintenanceError(
        `Account ${account} does not stand in chart ${chart}.`,
        'Name an account that stands in the chart the row is maintained for; a determination pointing at another chart can never answer.',
      );
    }
    const inserted = await tx.insert(salesAccountDetermination).values({
      client: input.client, chartOfAccounts: chart, salesOrg: org,
      customerAccountAssignmentGroup: customer, materialAccountAssignmentGroup: material,
      accountKey: key, glAccount: account, isActive: true, createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ accountKey: salesAccountDetermination.accountKey });
    if (inserted.length === 0) {
      throw new AccountDeterminationMaintenanceError(
        'A determination already stands for that chart, sales organisation, pair of groups and account key.',
        `Two rows cannot answer for one combination: the engine would have to choose, and revenue nobody can name the rule for is not revenue. Change the standing row at ${ACCOUNT_DETERMINATION_ROUTE}.`,
      );
    }
    await recordChange(tx, {
      client: input.client, objectClass: ACCOUNT_DETERMINATION_OBJECT_CLASS,
      objectKey: `${chart}/${org || '*'}/${customer || '*'}/${material || '*'}/${key}`,
      changeType: 'CREATE', changedBy: input.changedBy,
      after: { glAccount: account }, securityRelevantFields: ['glAccount'],
    });
  });
}

/**
 * Withdraw a row, or restore one.
 *
 * A withdrawn row is not gone: it stops answering, so the document that needed it is refused and names
 * this screen. That is the only honest way to say a key is no longer determined — deleting the row would
 * leave the same refusal with nothing to point at.
 */
export async function changeAccountDeterminationStatus(input: {
  client: string; changedBy: string;
  chartOfAccounts: string; salesOrg: string;
  customerAccountAssignmentGroup: string; materialAccountAssignmentGroup: string;
  accountKey: string; isActive: boolean;
}): Promise<void> {
  return withTenant(input.client, async (tx) => {
    const [standing] = await tx.select().from(salesAccountDetermination).where(and(
      eq(salesAccountDetermination.client, input.client),
      eq(salesAccountDetermination.chartOfAccounts, input.chartOfAccounts),
      eq(salesAccountDetermination.salesOrg, input.salesOrg),
      eq(salesAccountDetermination.customerAccountAssignmentGroup, input.customerAccountAssignmentGroup),
      eq(salesAccountDetermination.materialAccountAssignmentGroup, input.materialAccountAssignmentGroup),
      eq(salesAccountDetermination.accountKey, input.accountKey),
    )).limit(1);
    if (!standing) {
      throw new AccountDeterminationMaintenanceError(
        'No determination stands for that combination, so there is nothing to change.',
        `Define it at ${ACCOUNT_DETERMINATION_ROUTE} first.`,
      );
    }
    await tx.update(salesAccountDetermination)
      .set({ isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date() })
      .where(and(
        eq(salesAccountDetermination.client, input.client),
        eq(salesAccountDetermination.chartOfAccounts, input.chartOfAccounts),
        eq(salesAccountDetermination.salesOrg, input.salesOrg),
        eq(salesAccountDetermination.customerAccountAssignmentGroup, input.customerAccountAssignmentGroup),
        eq(salesAccountDetermination.materialAccountAssignmentGroup, input.materialAccountAssignmentGroup),
        eq(salesAccountDetermination.accountKey, input.accountKey),
      ));
    await recordChange(tx, {
      client: input.client, objectClass: ACCOUNT_DETERMINATION_OBJECT_CLASS,
      objectKey: `${input.chartOfAccounts}/${input.salesOrg || '*'}/${input.customerAccountAssignmentGroup || '*'}/${input.materialAccountAssignmentGroup || '*'}/${input.accountKey}`,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { isActive: standing.isActive }, after: { isActive: input.isActive },
      securityRelevantFields: ['isActive'],
    });
  });
}
