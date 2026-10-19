/**
 * Special G/L configuration maintenance — SCR-081 / R-129.
 *
 * Each row names the alternative reconciliation account a
 * one-character special G/L indicator posts to, per account type
 * (AP vendor side, AR customer side) and company scope; the
 * tenant-wide scope '' stands as the default a company row
 * overrides. The alternative account must stand as a G/L master
 * somewhere in the tenant's charts — the posting engine judges
 * its company-chart standing when a payment posts. Deletion is
 * refused while a posted down payment references the indicator,
 * so history never loses its resolution.
 */
import { and, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { glAccount } from '../finance/schema';
import { vendorDownPayment } from '../finance/schema';
import { specialGlConfig } from './schema';

export const SPECIAL_GL_ACTIVITY = 'CFG.FIN.SPECIALGL.DEFINE';
const OBJECT_CLASS = 'special_gl_config';

export class SpecialGlError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SpecialGlError';
    this.remedy = remedy;
  }
}

export interface SpecialGlRow {
  companyCode: string;
  accountType: string;
  indicator: string;
  alternativeReconciliationAccount: string;
  /** Set on a down-payment request (noted) indicator: the actual indicator it expects at fulfillment. */
  targetSpecialGlIndicator: string | null;
  description: string;
}

export async function listSpecialGlConfigs(client: string): Promise<SpecialGlRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(specialGlConfig)
      .where(eq(specialGlConfig.client, client))
      .orderBy(specialGlConfig.accountType, specialGlConfig.indicator, specialGlConfig.companyCode);
    return rows.map((r) => ({
      companyCode: r.companyCode, accountType: r.accountType, indicator: r.indicator,
      alternativeReconciliationAccount: r.alternativeReconciliationAccount,
      targetSpecialGlIndicator: r.targetSpecialGlIndicator,
      description: r.description,
    }));
  });
}

function judgeReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (!trimmed) throw new SpecialGlError('A reason is required for every change.', 'State why the configuration changes.');
  return trimmed;
}

async function judgeAccount(tx: Tx, client: string, account: string) {
  const [row] = await tx.select().from(glAccount).where(and(
    eq(glAccount.client, client), eq(glAccount.accountNumber, account),
  ));
  if (!row) {
    throw new SpecialGlError(
      `G/L account ${account} does not stand in any chart of this tenant.`,
      'Create the alternative reconciliation account first, then configure the indicator.',
    );
  }
}

export async function maintainSpecialGlConfig(input: {
  client: string; changedBy: string;
  companyCode: string; accountType: string; indicator: string;
  alternativeReconciliationAccount: string; description?: string;
  /** Down-payment requests: naming a target makes this a noted request indicator; '' clears it. */
  targetSpecialGlIndicator?: string;
  reason?: string;
}): Promise<SpecialGlRow> {
  const reason = judgeReason(input.reason);
  if (input.accountType !== 'AP' && input.accountType !== 'AR') {
    throw new SpecialGlError('The account type is AP (vendor) or AR (customer).');
  }
  if (!/^[A-Za-z0-9]$/.test(input.indicator)) {
    throw new SpecialGlError('The special G/L indicator is a single character.');
  }
  if (input.targetSpecialGlIndicator) {
    if (!/^[A-Za-z0-9]$/.test(input.targetSpecialGlIndicator)) {
      throw new SpecialGlError('The target special G/L indicator is a single character.');
    }
    if (input.targetSpecialGlIndicator.toUpperCase() === input.indicator.toUpperCase()) {
      throw new SpecialGlError('A request indicator cannot target itself.');
    }
  }
  return withTenant(input.client, async (tx) => {
    await judgeAccount(tx, input.client, input.alternativeReconciliationAccount);
    const key = {
      client: input.client, companyCode: input.companyCode,
      accountType: input.accountType, indicator: input.indicator,
    };
    const [existing] = await tx.select().from(specialGlConfig).where(and(
      eq(specialGlConfig.client, key.client),
      eq(specialGlConfig.companyCode, key.companyCode),
      eq(specialGlConfig.accountType, key.accountType),
      eq(specialGlConfig.indicator, key.indicator),
    ));
    const targetSpecialGlIndicator = input.targetSpecialGlIndicator === undefined
      ? (existing?.targetSpecialGlIndicator ?? null)
      : (input.targetSpecialGlIndicator ? input.targetSpecialGlIndicator.toUpperCase() : null);
    const values = {
      ...key,
      alternativeReconciliationAccount: input.alternativeReconciliationAccount,
      targetSpecialGlIndicator,
      description: input.description ?? '',
      createdBy: input.changedBy,
    };
    if (existing) {
      await tx.update(specialGlConfig).set({
        alternativeReconciliationAccount: values.alternativeReconciliationAccount,
        targetSpecialGlIndicator: values.targetSpecialGlIndicator,
        description: values.description,
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(specialGlConfig.client, key.client),
        eq(specialGlConfig.companyCode, key.companyCode),
        eq(specialGlConfig.accountType, key.accountType),
        eq(specialGlConfig.indicator, key.indicator),
      ));
    } else {
      await tx.insert(specialGlConfig).values(values);
    }
    await recordChange(tx, {
      client: input.client, objectClass: OBJECT_CLASS,
      objectKey: `${key.companyCode || '*'}/${key.accountType}/${key.indicator}`,
      changeType: existing ? 'CHANGE' : 'CREATE', reason,
      changedBy: input.changedBy, transactionCode: SPECIAL_GL_ACTIVITY,
      after: {
        alternativeReconciliationAccount: values.alternativeReconciliationAccount,
        targetSpecialGlIndicator: values.targetSpecialGlIndicator,
      },
    });
    return { ...key, alternativeReconciliationAccount: values.alternativeReconciliationAccount, targetSpecialGlIndicator: values.targetSpecialGlIndicator, description: values.description };
  });
}

export async function deleteSpecialGlConfig(input: {
  client: string; changedBy: string;
  companyCode: string; accountType: string; indicator: string;
  reason?: string;
}): Promise<void> {
  const reason = judgeReason(input.reason);
  return withTenant(input.client, async (tx) => {
    if (input.accountType === 'AP') {
      const used = await tx.select().from(vendorDownPayment).where(and(
        eq(vendorDownPayment.client, input.client),
        eq(vendorDownPayment.specialGlIndicator, input.indicator),
      ));
      if (used.length > 0) {
        throw new SpecialGlError(
          `Indicator ${input.indicator} stands on ${used.length} posted down payment(s) and cannot be deleted.`,
          'Posted history keeps its resolution; leave the indicator configured.',
        );
      }
    }
    await tx.delete(specialGlConfig).where(and(
      eq(specialGlConfig.client, input.client),
      eq(specialGlConfig.companyCode, input.companyCode),
      eq(specialGlConfig.accountType, input.accountType),
      eq(specialGlConfig.indicator, input.indicator),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: OBJECT_CLASS,
      objectKey: `${input.companyCode || '*'}/${input.accountType}/${input.indicator}`,
      changeType: 'DELETE', reason,
      changedBy: input.changedBy, transactionCode: SPECIAL_GL_ACTIVITY,
    });
  });
}
