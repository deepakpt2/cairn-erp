/**
 * Revenue account determination — SAP's VKOA.
 *
 * A sale does not post to "revenue". It posts to the account this determines, and what determines it is
 * a key of five parts: the chart of accounts the company code keeps, the sales organisation the document
 * belongs to, the account assignment group of the customer, the account assignment group of the material,
 * and the account key the pricing step carried.
 *
 * Three properties are worth stating, because each is the difference between a determination and a
 * lookup:
 *
 * Blank is a value. A customer with no account assignment group is not half a key — it is the group that
 * names none, and rows naming none answer for it. Treating blank as "unset" and falling through to
 * something more general would silently post a customer's revenue where nobody chose.
 *
 * The most specific row that fits answers, in one fixed order, so two maintainers reading the same table
 * reach the same account. The order is: sales organisation first, then the customer's group, then the
 * material's group — the sales organisation being the narrowest statement of where the business was
 * written.
 *
 * Where nothing stands, the document is refused. Not posted to a plausible account, not posted to a
 * fallback inherited from the inventory determination: refused, naming the key and the screen. An
 * invoice in the ledger with no rule behind it is worse than an invoice that was never raised, because
 * the first one has to be found and the second one only has to be fixed.
 */
import { and, asc, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { salesAccountDetermination } from './schema';

/** Where the table is maintained. A refusal that does not name the screen leaves the reader guessing. */
export const ACCOUNT_DETERMINATION_ROUTE = '/config/sales-account-determination';

/**
 * The account keys the package delivers, with the meaning SAP gives them. A key is what a pricing step
 * carries to say what kind of figure it produced; this is the list a maintainer picks from, and a
 * condition type carrying a key outside it is a key the ledger cannot place.
 */
export const ACCOUNT_KEYS = [
  { key: 'ERL', name: 'Revenue', meaning: 'The price of the goods or services sold.' },
  { key: 'ERS', name: 'Sales deductions', meaning: 'A discount or rebate taken off the price. It reduces revenue and is never revenue itself.' },
  { key: 'ERF', name: 'Freight revenue', meaning: 'Freight charged to the customer, which is earned by carrying the goods and not by selling them.' },
  { key: 'MWS', name: 'Output tax', meaning: 'Tax charged on the sale and owed to the tax authority. It is not the company’s money.' },
  { key: 'ERU', name: 'Rebate accrual', meaning: 'A rebate the customer has yet to be given, which the sale provides for now.' },
] as const;

export type AccountKey = typeof ACCOUNT_KEYS[number]['key'];

/**
 * The determination the standard package delivers, against the standard chart of accounts: one row for
 * each of the four keys the standard procedure can produce, posting to an account that chart already
 * carries. Delivered for the same reason the procedure itself is — a tenant with no determination
 * cannot post an invoice at all — and maintained from then on by whoever owns the revenue accounts,
 * which is the one place a tenant is expected to disagree with the package.
 *
 * `ERU`, the rebate accrual, stands in the list because BO01 produces it: the rebate a billing
 * document earns is provided for now, in the accrued-liabilities account the standard chart carries,
 * and released when the settlement pays it out.
 */
export const DELIVERED_ACCOUNT_DETERMINATION = [
  { salesOrg: '', customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '', accountKey: 'ERL', glAccount: '300000' },
  { salesOrg: '', customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '', accountKey: 'ERS', glAccount: '310000' },
  { salesOrg: '', customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '', accountKey: 'ERF', glAccount: '320000' },
  { salesOrg: '', customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '', accountKey: 'MWS', glAccount: '220000' },
  { salesOrg: '', customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '', accountKey: 'ERU', glAccount: '230000' },
] as const;

export class SalesAccountDeterminationError extends Error {
  remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'SalesAccountDeterminationError';
    this.remedy = remedy;
  }
}

export interface AccountDeterminationKey {
  chartOfAccounts: string;
  salesOrg: string;
  /** Null on a customer maintained before the group existed, and no different from blank. */
  customerAccountAssignmentGroup?: string | null;
  materialAccountAssignmentGroup?: string | null;
  accountKey: string;
}

export interface DeterminedAccount {
  glAccount: string;
  accountKey: string;
  /** The row that answered, so a reader can see how specific the answer was. */
  salesOrg: string;
  customerAccountAssignmentGroup: string;
  materialAccountAssignmentGroup: string;
}

/**
 * The rows that could answer, most specific first.
 *
 * The order is fixed and not a score: three rows each matching two of three parts would tie on a count
 * and disagree on an account, and a determination that depends on how the rows happen to be sorted is
 * not a determination.
 */
function candidates(key: AccountDeterminationKey) {
  const customer = (key.customerAccountAssignmentGroup ?? '').trim();
  const material = (key.materialAccountAssignmentGroup ?? '').trim();
  const org = key.salesOrg;
  return [
    { salesOrg: org, customerAccountAssignmentGroup: customer, materialAccountAssignmentGroup: material },
    { salesOrg: org, customerAccountAssignmentGroup: customer, materialAccountAssignmentGroup: '' },
    { salesOrg: org, customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: material },
    { salesOrg: org, customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '' },
    { salesOrg: '', customerAccountAssignmentGroup: customer, materialAccountAssignmentGroup: material },
    { salesOrg: '', customerAccountAssignmentGroup: customer, materialAccountAssignmentGroup: '' },
    { salesOrg: '', customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: material },
    { salesOrg: '', customerAccountAssignmentGroup: '', materialAccountAssignmentGroup: '' },
  ];
}

/**
 * The account a figure posts to, or a refusal.
 *
 * `undefined` is never returned: a caller who cannot post is told why, and told where to fix it.
 */
export async function determineSalesAccount(
  tx: Tx,
  client: string,
  key: AccountDeterminationKey,
): Promise<DeterminedAccount> {
  const accountKey = key.accountKey.toUpperCase();
  if (!ACCOUNT_KEYS.some((row) => row.key === accountKey)) {
    throw new SalesAccountDeterminationError(
      `Account key ${accountKey} is not one this package determines.`,
      `Use one of the delivered keys — ${ACCOUNT_KEYS.map((row) => row.key).join(', ')} — or maintain the key on the condition type it came from.`,
    );
  }
  const rows = await tx.select().from(salesAccountDetermination).where(and(
    eq(salesAccountDetermination.client, client),
    eq(salesAccountDetermination.chartOfAccounts, key.chartOfAccounts),
    eq(salesAccountDetermination.accountKey, accountKey),
    eq(salesAccountDetermination.isActive, true),
  )).orderBy(asc(salesAccountDetermination.salesOrg));
  const standing = rows.filter((row) => row.isActive);
  for (const wanted of candidates(key)) {
    const row = standing.find((candidate) =>
      candidate.salesOrg === wanted.salesOrg
      && candidate.customerAccountAssignmentGroup === wanted.customerAccountAssignmentGroup
      && candidate.materialAccountAssignmentGroup === wanted.materialAccountAssignmentGroup);
    if (row) {
      return {
        glAccount: row.glAccount,
        accountKey,
        salesOrg: row.salesOrg,
        customerAccountAssignmentGroup: row.customerAccountAssignmentGroup,
        materialAccountAssignmentGroup: row.materialAccountAssignmentGroup,
      };
    }
  }
  const customer = (key.customerAccountAssignmentGroup ?? '').trim() || '(none)';
  const material = (key.materialAccountAssignmentGroup ?? '').trim() || '(none)';
  const name = ACCOUNT_KEYS.find((row) => row.key === accountKey)?.name ?? accountKey;
  throw new SalesAccountDeterminationError(
    `No G/L account is determined for ${accountKey} (${name}) in chart ${key.chartOfAccounts}, sales organisation ${key.salesOrg}, customer group ${customer} and material group ${material}, so this document cannot be posted.`,
    `Maintain the account determination at ${ACCOUNT_DETERMINATION_ROUTE}: a row naming ${accountKey} for this chart and sales organisation, with the customer and material groups that fit — or with both blank, which answers for every customer and material.`,
  );
}

/** A condition as a document stored it: what it is worth, and the key that says what kind of figure it is. */
export interface ConditionForKey {
  accountKey: string | null;
  amount: string;
  isStatistical: boolean;
  conditionClass: string;
  conditionType: string;
}

export interface LineComponent {
  accountKey: string;
  glAccount: string;
  /** Signed: a deduction that takes away from revenue is negative, and posts on the other side. */
  amount: string;
}

export interface DeterminedLineAccounts {
  /** The revenue, the deductions and the freight, each to the account its key determined. */
  components: LineComponent[];
  /** Where the tax on the line posts. Absent where the line carried no tax condition. */
  taxAccount?: string;
}

/**
 * The accounts one document line posts to, from the conditions that priced it.
 *
 * `undefined` is returned where the line carried no conditions with an account key — a document raised
 * before the conditions existed, or one priced by a procedure whose steps name no keys. That is not a
 * refusal: such a document is posted where it has always been posted, and the caller falls back to the
 * standing revenue and tax accounts. A line that *does* carry keys and finds no account for one of them
 * is refused here, and names the screen.
 *
 * The tax is kept apart from the rest because it is not revenue, not a deduction and not freight: it is
 * money owed to a tax authority, and it posts to the account its own key names.
 */
export async function determineLineAccounts(
  tx: Tx,
  client: string,
  input: {
    chartOfAccounts: string;
    salesOrg: string;
    customerAccountAssignmentGroup?: string | null;
    materialAccountAssignmentGroup?: string | null;
    conditions: ConditionForKey[];
  },
): Promise<DeterminedLineAccounts | undefined> {
  const usable = input.conditions.filter(
    (condition) => !condition.isStatistical && condition.accountKey && Number(condition.amount) !== 0,
  );
  if (usable.length === 0) return undefined;

  const key = (accountKey: string) => ({
    chartOfAccounts: input.chartOfAccounts,
    salesOrg: input.salesOrg,
    customerAccountAssignmentGroup: input.customerAccountAssignmentGroup,
    materialAccountAssignmentGroup: input.materialAccountAssignmentGroup,
    accountKey,
  });

  const totals = new Map<string, number>();
  let taxKey: string | null = null;
  for (const condition of usable) {
    const accountKey = condition.accountKey!;
    if (condition.conditionClass === 'TAX') {
      taxKey = accountKey;
      continue;
    }
    totals.set(accountKey, Math.round(((totals.get(accountKey) ?? 0) + Number(condition.amount)) * 100) / 100);
  }

  const components: LineComponent[] = [];
  for (const [accountKey, amount] of totals) {
    if (Math.abs(amount) < 0.005) continue;
    const determined = await determineSalesAccount(tx, client, key(accountKey));
    components.push({ accountKey, glAccount: determined.glAccount, amount: amount.toFixed(2) });
  }
  const taxAccount = taxKey
    ? (await determineSalesAccount(tx, client, key(taxKey))).glAccount
    : undefined;
  return { components, ...(taxAccount ? { taxAccount } : {}) };
}
