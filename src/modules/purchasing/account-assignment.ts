/**
 * Account assignment — what an account-assigned value belongs to.
 *
 * A purchase order item that carries no material through stock has to say where
 * its value goes instead: a cost centre, an internal order, or an asset. That
 * answer is an account assignment, and it has to hold in two places — when the
 * order is written, and later, when the invoice is posted against it. The same
 * answer judged by two different pieces of code is two answers, so it is judged
 * here, once, and both gates read it.
 *
 * The second gate is not ceremony. An order written in October can be invoiced
 * in March, by which time the cost centre may stand locked, the internal order
 * may have ended, or the asset may have been deactivated. What stood valid when
 * the commitment was made is not the same question as what stands valid on the
 * day the money is posted.
 *
 * Nothing here posts. It answers what the value belongs to and what account
 * carries it; the document that posts decides what to do with the answer.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx } from '../../platform/db/client';
import { controllingAreaCompany, costCenter, internalOrder } from '../foundation/schema';
import {
  assetClass, assetTransactionType, fixedAsset, glAccount,
} from '../finance/schema';

export interface AssignmentRow {
  /** Numbered when the row is written; an assignment being judged for the first time has none. */
  lineNumber?: number;
  glAccount: string;
  costCenter?: string | null;
  internalOrder?: string | null;
  assetNumber?: string | null;
  assetSubNumber?: string | null;
  assetTransactionType?: string | null;
  distributionPercentage: string | number;
}

export interface JudgedAssignment {
  lineNumber: number | null;
  /** The account that carries this share of the value. */
  glAccount: string;
  costCenter: string | null;
  internalOrder: string | null;
  assetNumber: string | null;
  assetSubNumber: string | null;
  assetTransactionType: string | null;
  percentage: number;
}

export interface JudgedAssignments {
  /** Why the assignments do not stand, stated so a screen can show it. Null when they do. */
  refusal: string | null;
  rows: JudgedAssignment[];
}

export async function judgeAccountAssignments(
  tx: Tx,
  input: {
    client: string;
    companyCode: string;
    chartOfAccounts: string | null;
    /** The date the judgement has to hold on: the order's date, or the invoice's posting date. */
    onDate: string;
    category: string | null;
    rows: AssignmentRow[];
  },
): Promise<JudgedAssignments> {
  const { client, companyCode, chartOfAccounts, onDate, category, rows } = input;

  if (!category) {
    return rows.length > 0
      ? { refusal: 'A stock item carries no account assignments.', rows: [] }
      : { refusal: null, rows: [] };
  }
  if (category !== 'COST_CENTER' && category !== 'ASSET') {
    return { refusal: `Account assignment category ${category} is not supported this round.`, rows: [] };
  }
  if (rows.length === 0) {
    return { refusal: 'An account-assigned item needs at least one account assignment row.', rows: [] };
  }
  const total = rows.reduce((sum, row) => sum + Number(row.distributionPercentage), 0);
  if (Math.abs(total - 100) > 0.005) {
    return { refusal: `Assignment percentages total ${total.toFixed(2)}, not 100.`, rows: [] };
  }

  const [area] = await tx.select().from(controllingAreaCompany).where(and(
    eq(controllingAreaCompany.client, client), eq(controllingAreaCompany.companyCode, companyCode),
  ));
  if (!area) {
    return { refusal: `Company code ${companyCode} belongs to no controlling area.`, rows: [] };
  }

  const judged: JudgedAssignment[] = [];
  for (const row of rows) {
    const named = [
      row.costCenter ? 'cost centre' : null,
      row.internalOrder ? 'internal order' : null,
      row.assetNumber ? 'asset' : null,
    ].filter((value): value is string => value !== null);
    if (named.length !== 1) {
      return {
        refusal: named.length === 0
          ? 'An account assignment row names no cost object: a cost centre, an internal order or an asset.'
          : `An account assignment row names ${named.join(' and ')}. One row charges one cost object.`,
        rows: [],
      };
    }

    if (row.costCenter) {
      const centres = await tx.select().from(costCenter).where(and(
        eq(costCenter.client, client), eq(costCenter.controllingArea, area.controllingArea),
        eq(costCenter.costCenter, row.costCenter),
      ));
      const standing = centres.find((c) => c.validFrom <= onDate && c.validTo >= onDate);
      if (!standing) {
        return {
          refusal: `Cost centre ${row.costCenter} does not stand valid on ${onDate} in controlling area ${area.controllingArea}.`,
          rows: [],
        };
      }
      if (standing.isPostingLocked) {
        return { refusal: `Cost centre ${row.costCenter} is locked for postings.`, rows: [] };
      }
    }

    if (row.internalOrder) {
      const [order] = await tx.select().from(internalOrder).where(and(
        eq(internalOrder.client, client), eq(internalOrder.orderNumber, row.internalOrder),
      ));
      if (!order || order.companyCode !== companyCode) {
        return {
          refusal: `Internal order ${row.internalOrder} does not stand in company code ${companyCode}.`,
          rows: [],
        };
      }
      if (order.markedForDeletion) {
        return { refusal: `Internal order ${row.internalOrder} is marked for deletion.`, rows: [] };
      }
      if (order.isPostingLocked) {
        return { refusal: `Internal order ${row.internalOrder} is locked for postings.`, rows: [] };
      }
      if (order.startDate > onDate || order.endDate < onDate) {
        return {
          refusal: `Internal order ${row.internalOrder} does not stand valid on ${onDate}; it runs ${order.startDate} to ${order.endDate}.`,
          rows: [],
        };
      }
      if (order.controllingArea !== area.controllingArea) {
        return {
          refusal: `Internal order ${row.internalOrder} belongs to controlling area ${order.controllingArea}, not ${area.controllingArea}.`,
          rows: [],
        };
      }
    }

    let chargeAccount = row.glAccount;
    let assetSubNumber: string | null = null;
    if (row.assetNumber) {
      assetSubNumber = row.assetSubNumber ?? '0000';
      const [asset] = await tx.select().from(fixedAsset).where(and(
        eq(fixedAsset.client, client), eq(fixedAsset.companyCode, companyCode),
        eq(fixedAsset.assetNumber, row.assetNumber), eq(fixedAsset.subNumber, assetSubNumber),
      ));
      if (!asset) {
        return {
          refusal: `Asset ${row.assetNumber}/${assetSubNumber} does not stand in company ${companyCode}.`,
          rows: [],
        };
      }
      if (asset.status !== 'ACTIVE') {
        return {
          refusal: `Asset ${asset.assetNumber}/${asset.subNumber} stands ${asset.status.toLowerCase()} and takes no acquisition.`,
          rows: [],
        };
      }
      const [klass] = await tx.select().from(assetClass).where(and(
        eq(assetClass.client, client), eq(assetClass.assetClass, asset.assetClass),
      ));
      if (!klass || !klass.isActive) {
        return {
          refusal: `Asset class ${asset.assetClass} is not configured active in this tenant.`,
          rows: [],
        };
      }
      if (!klass.reconAccount) {
        return {
          refusal: `Asset class ${asset.assetClass} carries no acquisition account determination.`,
          rows: [],
        };
      }
      // An asset is not charged to an account the buyer picked: the class says which
      // account the class's assets are capitalized on, and that is the account used.
      chargeAccount = klass.reconAccount;

      if (!row.assetTransactionType) {
        return {
          refusal: `Asset ${asset.assetNumber}/${asset.subNumber} was named without an acquisition transaction type.`,
          rows: [],
        };
      }
      const [type] = await tx.select().from(assetTransactionType).where(and(
        eq(assetTransactionType.client, client),
        eq(assetTransactionType.typeCode, row.assetTransactionType),
      ));
      if (!type || !type.isActive || type.kind !== 'ACQUISITION') {
        return {
          refusal: `Asset transaction type ${row.assetTransactionType} is not configured as an active acquisition type.`,
          rows: [],
        };
      }
    }

    // Only a consumption row names its own account, and it has to be one that goes
    // through the profit and loss: a balance-sheet account would leave the value
    // sitting on the books twice, once as the asset or expense and once as the account.
    if (!row.assetNumber) {
      if (!chartOfAccounts) {
        return { refusal: `Company code ${companyCode} has no chart of accounts assigned.`, rows: [] };
      }
      const [account] = await tx.select().from(glAccount).where(and(
        eq(glAccount.client, client), eq(glAccount.chartOfAccounts, chartOfAccounts),
        eq(glAccount.accountNumber, row.glAccount),
      ));
      if (!account) {
        return {
          refusal: `G/L account ${row.glAccount} does not exist in chart ${chartOfAccounts}.`,
          rows: [],
        };
      }
      if (account.isBalanceSheet) {
        return {
          refusal: `G/L account ${row.glAccount} is a balance-sheet account; a consumption assignment needs a P&L account.`,
          rows: [],
        };
      }
    }

    judged.push({
      lineNumber: row.lineNumber ?? null,
      glAccount: chargeAccount,
      costCenter: row.costCenter ?? null,
      internalOrder: row.internalOrder ?? null,
      assetNumber: row.assetNumber ?? null,
      assetSubNumber,
      assetTransactionType: row.assetTransactionType ?? null,
      percentage: Number(row.distributionPercentage),
    });
  }

  return { refusal: null, rows: judged };
}
