import { and, asc, eq } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { valuationClass } from '../inventory/schema';
import { accountDetermination, chartOfAccounts } from './schema';

/**
 * OBYC Define Account Determination — the read side (SCR-040 stage 1).
 *
 * The reference transaction's spine is a table of (chart, transaction key,
 * modifiers) → G/L account. This product stores the same spine in its own
 * vocabulary (R-89): the transaction keys are the product's posting events,
 * with BSX, WRX, GBB and PRD carried as search aliases and never stored;
 * the valuation-grouping dimension is omitted, because this product keyes
 * valuation by plant and holds no grouping of valuation areas to resolve
 * through; the valuation class is the material master's own, so a
 * determination line names the class a material actually carries.
 *
 * The event catalogue below is configuration vocabulary, not decoration:
 * each event states the account kind it expects (balance sheet or profit
 * and loss) and which modifier columns belong to it, and the write
 * (stage 3) judges a row against exactly those statements — including
 * refusing a valuation class or general modifier an event does not use,
 * the dynamic columns of the reference layout enforced in the service
 * rather than merely hidden on screen.
 */
export const ACTIVITY = 'CFG.FIN.ACCTDET.DEFINE';

export type AccountKind = 'BALANCE_SHEET' | 'PL_STATEMENT';

export interface PostingEvent {
  event: string;
  /** The reference transaction key, for search and display only — never stored. */
  referenceAlias: string;
  expectedAccountKind: AccountKind;
  usesValuationClass: boolean;
  usesGeneralModifier: boolean;
}

export const POSTING_EVENTS: PostingEvent[] = [
  { event: 'INVENTORY', referenceAlias: 'BSX', expectedAccountKind: 'BALANCE_SHEET', usesValuationClass: true, usesGeneralModifier: false },
  { event: 'GR_IR_CLEARING', referenceAlias: 'WRX', expectedAccountKind: 'BALANCE_SHEET', usesValuationClass: false, usesGeneralModifier: false },
  { event: 'OFFSETTING_INVENTORY', referenceAlias: 'GBB', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: true, usesGeneralModifier: true },
  { event: 'PRICE_DIFFERENCE', referenceAlias: 'PRD', expectedAccountKind: 'PL_STATEMENT', usesValuationClass: true, usesGeneralModifier: false },
];

export function postingEvent(event: string): PostingEvent | undefined {
  return POSTING_EVENTS.find((entry) => entry.event === event);
}

export interface AccountDeterminationRow {
  chartOfAccounts: string;
  event: string;
  /** '' = any valuation class. */
  valuationClass: string;
  /** '' = no general-modifier split. */
  generalModifier: string;
  glAccount: string;
}

export interface ChartChoice {
  chartOfAccounts: string;
  name: string;
}

export interface ValuationClassChoice {
  valuationClass: string;
  name: string;
}

/** Every determination row the tenant holds, in key order. */
export async function listAccountDeterminations(client: string): Promise<AccountDeterminationRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(accountDetermination)
      .where(eq(accountDetermination.client, client))
      .orderBy(
        asc(accountDetermination.chartOfAccounts),
        asc(accountDetermination.event),
        asc(accountDetermination.valuationClass),
        asc(accountDetermination.generalModifier),
      );

    return rows.map((row) => ({
      chartOfAccounts: row.chartOfAccounts,
      event: row.event,
      valuationClass: row.valuationClass,
      generalModifier: row.generalModifier,
      glAccount: row.glAccount,
    }));
  });
}

/** The charts of accounts the tenant holds — the screen's heading choice and the write's judging list. */
export async function listDeterminationCharts(client: string): Promise<ChartChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ chartOfAccounts: chartOfAccounts.chartOfAccounts, name: chartOfAccounts.name })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.client, client))
      .orderBy(asc(chartOfAccounts.chartOfAccounts));
    return rows;
  });
}

/** The tenant's active valuation classes — the class value help, in the material master's own keys. */
export async function listDeterminationValuationClasses(client: string): Promise<ValuationClassChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select({ valuationClass: valuationClass.valuationClass, name: valuationClass.name })
      .from(valuationClass)
      .where(eq(valuationClass.client, client))
      .orderBy(asc(valuationClass.valuationClass));
    return rows.filter((row) => row.valuationClass.trim() !== '');
  });
}
