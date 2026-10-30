/**
 * The settlement rule of one production order, read by PROD.ORDER.SETTLE.
 *
 * Mirrors src/modules/foundation/settlement-configuration.ts for production orders.
 * This screen stores what belongs to the order: which receiver takes the balance, by
 * what share, over which period range. The profile, the allocation structure and its
 * account assignments are shared by every order of the order's type and are maintained
 * at /config/settlement-configuration; here they are read and refused against, never
 * written. A payload that still carries one of those fields is rejected rather than
 * quietly dropped.
 *
 * Saving does not post. No receiver, share, document type, or account is assumed.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { glAccount } from '../finance/schema';
import {
  allocationStructureAssignment,
  companyCode,
  costCenter,
  settlementDocument,
  settlementProfile,
} from '../foundation/schema';
import { productionOrder } from '../inventory/schema';
import {
  productionOrderSetttlementDistributionRule,
  productionOrderTypeSettlementProfile,
} from './schema';

export const SETTLEMENT_RULE_CAPABILITY = 'CO.SETTLE.RULE';
export const SETTLEMENT_RULE_ROUTE = '/production/settlement-rules';

export const SHARED_MASTER_FIELDS = [
  'profileCode',
  'profileDescription',
  'documentType',
  'structureCode',
  'structureDescription',
  'sourceAccount',
  'byOriginalAccount',
  'settlementAccount',
] as const;

export class SettlementConfigurationError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SettlementConfigurationError';
    this.remedy = remedy;
  }
}

export type ReceiverCategory = 'COST_CENTER' | 'INTERNAL_ORDER' | 'GL_ACCOUNT';
export type SettlementType = 'PER' | 'FUL';

export interface SaveSettlementConfigurationInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  receiverCategory: ReceiverCategory;
  receiver: string;
  percentage?: string;
  equivalence?: string;
  amount?: string;
  settlementType: SettlementType;
  validFromYear: number;
  validFromPeriod: number;
  validToYear: number;
  validToPeriod: number;
}

export interface SettlementConfigurationView {
  orderNumber: string;
  orderType: string | null;
  profileCode: string | null;
  documentType: string | null;
  structureCode: string | null;
  settlementProfile: {
    profileCode: string;
    description: string;
    allocationStructure: string;
    documentType: string;
    percentageAllowed: boolean;
    equivalenceAllowed: boolean;
    amountAllowed: boolean;
    isActive: boolean;
  } | null;
  rules: Array<{
    ruleNumber: number;
    receiverCategory: string;
    receiver: string;
    percentage: string | null;
    equivalence: string | null;
    amount: string | null;
    settlementType: string;
  }>;
}

function blank(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function refuseSharedMasterFields(raw: SaveSettlementConfigurationInput): void {
  const sent = raw as unknown as Record<string, unknown>;
  const present = SHARED_MASTER_FIELDS.filter((field) => {
    const value = sent[field];
    return typeof value === 'boolean' ? true : blank(typeof value === 'string' ? value : undefined) !== null;
  });
  if (present.length === 0) return;
  throw new SettlementConfigurationError(
    `These fields are settlement masters, not part of an order's rule: ${present.join(', ')}.`,
    'Maintain the profile, the allocation structure and its account assignments at /config/settlement-configuration. Nothing was stored here.',
  );
}

async function loadConfiguration(tx: Tx, client: string, orderNumber: string): Promise<SettlementConfigurationView | null> {
  const [order] = await tx.select().from(productionOrder).where(and(
    eq(productionOrder.client, client),
    eq(productionOrder.orderNumber, orderNumber),
  ));
  if (!order) return null;
  const [assignment] = await tx.select().from(productionOrderTypeSettlementProfile).where(and(
    eq(productionOrderTypeSettlementProfile.client, client),
    eq(productionOrderTypeSettlementProfile.orderType, order.orderType ?? ''),
  ));
  const [profile] = assignment
    ? await tx.select().from(settlementProfile).where(and(
      eq(settlementProfile.client, client),
      eq(settlementProfile.profileCode, assignment.profileCode),
    ))
    : [];
  const rules = await tx.select().from(productionOrderSetttlementDistributionRule).where(and(
    eq(productionOrderSetttlementDistributionRule.client, client),
    eq(productionOrderSetttlementDistributionRule.orderNumber, orderNumber),
  )).orderBy(asc(productionOrderSetttlementDistributionRule.ruleNumber));
  return {
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    profileCode: profile?.profileCode ?? null,
    documentType: profile?.documentType ?? null,
    structureCode: profile?.allocationStructure ?? null,
    settlementProfile: profile ? {
      profileCode: profile.profileCode,
      description: profile.description,
      allocationStructure: profile.allocationStructure,
      documentType: profile.documentType,
      percentageAllowed: profile.percentageAllowed,
      equivalenceAllowed: profile.equivalenceAllowed,
      amountAllowed: profile.amountAllowed,
      isActive: profile.isActive,
    } : null,
    rules: rules.map((rule) => ({
      ruleNumber: rule.ruleNumber,
      receiverCategory: rule.receiverCategory,
      receiver: rule.receiver,
      percentage: rule.percentage,
      equivalence: rule.equivalence,
      amount: rule.amount,
      settlementType: rule.settlementType,
    })),
  };
}

export async function getSettlementConfiguration(
  client: string,
  orderNumber: string,
): Promise<SettlementConfigurationView | null> {
  const number = orderNumber.trim();
  if (!number) return null;
  return withTenant(client, (tx) => loadConfiguration(tx, client, number));
}

async function accountExists(tx: Tx, client: string, chart: string, account: string) {
  const [row] = await tx.select().from(glAccount).where(and(
    eq(glAccount.client, client),
    eq(glAccount.chartOfAccounts, chart),
    eq(glAccount.accountNumber, account),
  ));
  if (!row) throw new SettlementConfigurationError(`Account ${account} is not in chart ${chart}.`);
  if (row.isBlockedPosting) throw new SettlementConfigurationError(`Account ${account} is blocked for posting.`);
  return row;
}

export async function lockSettlementRuleForProductionOrder(tx: Tx, client: string, orderNumber: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/production-settlement-rule/${orderNumber.trim()}`}, 0))`);
}

export interface OrderTypeSettlementProfileInput {
  client: string;
  changedBy: string;
  orderType: string;
  profileCode: string;
}

export async function assignProductionOrderTypeSettlementProfile(
  input: OrderTypeSettlementProfileInput,
): Promise<{ orderType: string; profileCode: string }> {
  const orderType = input.orderType.trim().toUpperCase();
  const profileCode = input.profileCode.trim().toUpperCase();
  if (!orderType) throw new SettlementConfigurationError('An order type is required.');
  if (!profileCode) throw new SettlementConfigurationError('A profile code is required.');

  return withTenant(input.client, async (tx) => {
    const [type] = await tx.select().from(productionOrderTypeSettlementProfile).where(and(
      eq(productionOrderTypeSettlementProfile.client, input.client),
      eq(productionOrderTypeSettlementProfile.orderType, orderType),
    ));
    if (type) {
      if (type.profileCode === profileCode) return { orderType, profileCode: type.profileCode };
      await tx.update(productionOrderTypeSettlementProfile).set({ profileCode }).where(and(
        eq(productionOrderTypeSettlementProfile.client, input.client),
        eq(productionOrderTypeSettlementProfile.orderType, orderType),
      ));
      await recordChange(tx, {
        client: input.client,
        objectClass: 'production_order_type_settlement_profile',
        objectKey: orderType,
        changeType: 'CHANGE',
        changedBy: input.changedBy,
        before: { profileCode: type.profileCode },
        after: { profileCode },
      });
      return { orderType, profileCode };
    }
    const [profile] = await tx.select().from(settlementProfile).where(and(
      eq(settlementProfile.client, input.client),
      eq(settlementProfile.profileCode, profileCode),
    ));
    if (!profile) throw new SettlementConfigurationError(`Settlement profile ${profileCode} does not exist.`);
    const [written] = await tx.insert(productionOrderTypeSettlementProfile).values({
      client: input.client,
      orderType,
      profileCode,
      createdBy: input.changedBy,
    }).returning({ orderType: productionOrderTypeSettlementProfile.orderType, profileCode: productionOrderTypeSettlementProfile.profileCode });
    if (!written) throw new SettlementConfigurationError(`Profile assignment for ${orderType} was not stored.`);
    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order_type_settlement_profile',
      objectKey: orderType,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      after: { profileCode },
    });
    return { orderType: written.orderType, profileCode: written.profileCode };
  });
}

export async function saveProductionOrderSettlementConfiguration(
  input: SaveSettlementConfigurationInput,
): Promise<SettlementConfigurationView> {
  refuseSharedMasterFields(input);
  const orderNumber = input.orderNumber.trim();
  if (!orderNumber) throw new SettlementConfigurationError('An order number is required.');
  const percentage = blank(input.percentage);
  const equivalence = blank(input.equivalence);
  const amount = blank(input.amount);
  const shares = [percentage, equivalence, amount].filter((value) => value !== null);
  if (shares.length !== 1) {
    throw new SettlementConfigurationError('A rule uses a percentage, an equivalence number, or an amount, not a mix.');
  }
  const usedMethod = percentage !== null ? 'percentage' : equivalence !== null ? 'equivalence number' : 'amount';
  if (!['PER', 'FUL'].includes(input.settlementType)) {
    throw new SettlementConfigurationError('The settlement type must be periodic or full. A processing type is not assumed.');
  }
  if (
    !Number.isInteger(input.validFromYear) || !Number.isInteger(input.validToYear)
    || !Number.isInteger(input.validFromPeriod) || !Number.isInteger(input.validToPeriod)
    || input.validFromPeriod < 1 || input.validToPeriod < 1 || input.validFromPeriod > 16 || input.validToPeriod > 16
    || input.validFromYear * 100 + input.validFromPeriod > input.validToYear * 100 + input.validToPeriod
  ) {
    throw new SettlementConfigurationError('The rule validity is not a period range. It was not replaced.');
  }
  const receiver = input.receiver.trim().toUpperCase();
  if (!receiver) throw new SettlementConfigurationError('A receiver is required. None is assumed.');

  return withTenant(input.client, async (tx) => {
    await lockSettlementRuleForProductionOrder(tx, input.client, orderNumber);
    const [order] = await tx.select().from(productionOrder).where(and(
      eq(productionOrder.client, input.client),
      eq(productionOrder.orderNumber, orderNumber),
    ));
    if (!order) throw new SettlementConfigurationError(`Production order ${orderNumber} does not exist.`);
    const [settled] = await tx.select({ documentNumber: settlementDocument.documentNumber }).from(settlementDocument).where(and(
      eq(settlementDocument.client, input.client),
      eq(settlementDocument.orderNumber, orderNumber),
    ));
    if (settled) {
      throw new SettlementConfigurationError(
        `Production order ${orderNumber} already has settlement document ${settled.documentNumber}.`,
        'The posted journal is not deleted, and the rule is not rewritten.',
      );
    }

    const [link] = await tx.select().from(productionOrderTypeSettlementProfile).where(and(
      eq(productionOrderTypeSettlementProfile.client, input.client),
      eq(productionOrderTypeSettlementProfile.orderType, order.orderType ?? ''),
    ));
    if (!link) {
      throw new SettlementConfigurationError(
        `Order type ${order.orderType ?? '(none)'} reads no settlement profile.`,
        'Assign the profile to the order type at /config/settlement-configuration. This screen stores the rule of one order only.',
      );
    }
    const [profile] = await tx.select().from(settlementProfile).where(and(
      eq(settlementProfile.client, input.client),
      eq(settlementProfile.profileCode, link.profileCode),
    ));
    if (!profile) {
      throw new SettlementConfigurationError(
        `Order type ${order.orderType ?? '(none)'} reads settlement profile ${link.profileCode}, which does not exist.`,
        'Repair the assignment at /config/settlement-configuration.',
      );
    }
    if (!profile.isActive) {
      throw new SettlementConfigurationError(
        `Settlement profile ${profile.profileCode} is inactive.`,
        'Activate it or assign another profile at /config/settlement-configuration.',
      );
    }
    const methodAllowed = percentage !== null
      ? profile.percentageAllowed
      : equivalence !== null ? profile.equivalenceAllowed : profile.amountAllowed;
    if (!methodAllowed) {
      throw new SettlementConfigurationError(
        `Settlement profile ${profile.profileCode} does not allow distribution by ${usedMethod}.`,
        'Allow the method on the profile at /config/settlement-configuration, or store the rule with a method it allows.',
      );
    }
    const mapped = await tx.select({ count: sql<number>`count(*)::int` }).from(allocationStructureAssignment).where(and(
      eq(allocationStructureAssignment.client, input.client),
      eq(allocationStructureAssignment.structureCode, profile.allocationStructure),
      eq(allocationStructureAssignment.receiverCategory, input.receiverCategory),
    ));
    if ((mapped[0]?.count ?? 0) === 0) {
      throw new SettlementConfigurationError(
        `Allocation structure ${profile.allocationStructure} has no assignment for receiver category ${input.receiverCategory}.`,
        'Store that assignment at /config/settlement-configuration. A settlement run stops on the same condition.',
      );
    }

    const [company] = await tx.select().from(companyCode).where(and(
      eq(companyCode.client, input.client),
      eq(companyCode.companyCode, order.companyCode),
    ));
    if (!company?.chartOfAccounts) {
      throw new SettlementConfigurationError(`Company code ${order.companyCode} has no chart of accounts.`);
    }
    if (input.receiverCategory === 'COST_CENTER') {
      const centers = await tx.select().from(costCenter).where(and(
        eq(costCenter.client, input.client),
        eq(costCenter.controllingArea, order.controllingArea),
        eq(costCenter.costCenter, receiver),
        eq(costCenter.companyCode, order.companyCode),
      ));
      if (centers.length === 0) {
        throw new SettlementConfigurationError(
          `Cost center ${receiver} is not in controlling area ${order.controllingArea}.`,
          'The order cost center is not used as a receiver.',
        );
      }
    } else if (input.receiverCategory === 'INTERNAL_ORDER') {
      if (receiver === order.orderNumber) {
        throw new SettlementConfigurationError('An order cannot be its own settlement receiver.');
      }
      const [target] = await tx.select().from(productionOrder).where(and(
        eq(productionOrder.client, input.client),
        eq(productionOrder.orderNumber, receiver),
        eq(productionOrder.controllingArea, order.controllingArea),
      ));
      if (!target) throw new SettlementConfigurationError(`Receiver order ${receiver} does not exist in this controlling area.`);
    } else if (input.receiverCategory === 'GL_ACCOUNT') {
      await accountExists(tx, input.client, company.chartOfAccounts, receiver);
    } else {
      throw new SettlementConfigurationError(`Receiver category ${input.receiverCategory} cannot be posted.`);
    }

    await tx.delete(productionOrderSetttlementDistributionRule).where(and(
      eq(productionOrderSetttlementDistributionRule.client, input.client),
      eq(productionOrderSetttlementDistributionRule.orderNumber, orderNumber),
    ));
    await tx.insert(productionOrderSetttlementDistributionRule).values({
      client: input.client,
      orderNumber,
      ruleNumber: 1,
      receiverCategory: input.receiverCategory,
      receiver,
      percentage,
      equivalence,
      amount,
      settlementType: input.settlementType,
      validFromYear: input.validFromYear,
      validFromPeriod: input.validFromPeriod,
      validToYear: input.validToYear,
      validToPeriod: input.validToPeriod,
      createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_order_settlement_distribution_rule',
      objectKey: orderNumber,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      after: {
        profileCode: link.profileCode,
        receiver,
        receiverCategory: input.receiverCategory,
        settlementType: input.settlementType,
        [usedMethod]: shares[0],
      },
    });
    const saved = await loadConfiguration(tx, input.client, orderNumber);
    if (!saved) throw new SettlementConfigurationError('The settlement rule was not stored.');
    return saved;
  });
}
