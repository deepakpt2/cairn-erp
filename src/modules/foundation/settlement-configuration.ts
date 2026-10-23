/**
 * Settlement configuration read by KO88 and KO8G.
 *
 * Saving a profile, an allocation assignment, or a distribution rule does not
 * post. No receiver, percentage, document type, or account is assumed. KO02 and
 * KO8B are not this service.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { glAccount } from '../finance/schema';
import {
  allocationStructure,
  allocationStructureAssignment,
  companyCode,
  costCenter,
  documentType,
  internalOrder,
  internalOrderTypeSettlementProfile,
  settlementDistributionRule,
  settlementDocument,
  settlementProfile,
} from './schema';

export const SETTLEMENT_RULE_CAPABILITY = 'CO.SETTLE.RULE';
export const SETTLEMENT_RULE_ROUTE = '/controlling/settlement-rules';

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
  profileCode: string;
  profileDescription: string;
  documentType: string;
  structureCode: string;
  structureDescription: string;
  sourceAccount: string;
  byOriginalAccount: boolean;
  settlementAccount?: string;
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
  orderType: string;
  profileCode: string | null;
  documentType: string | null;
  structureCode: string | null;
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

function requireCode(value: string, label: string, pattern: RegExp): string {
  const code = value.trim().toUpperCase();
  if (!pattern.test(code)) throw new SettlementConfigurationError(`${label} ${value.trim() || '(blank)'} is not valid.`);
  return code;
}

export async function listSettlementDocumentTypes(client: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx.select({
      documentType: documentType.documentType,
      name: documentType.name,
    }).from(documentType).where(and(
      eq(documentType.client, client),
      eq(documentType.isActive, true),
    )).orderBy(asc(documentType.documentType));
    return rows.map((row) => ({ documentType: row.documentType, name: row.name }));
  });
}

async function loadConfiguration(tx: Tx, client: string, orderNumber: string): Promise<SettlementConfigurationView | null> {
  const [order] = await tx.select().from(internalOrder).where(and(
    eq(internalOrder.client, client),
    eq(internalOrder.orderNumber, orderNumber),
  ));
  if (!order) return null;
  const [assignment] = await tx.select().from(internalOrderTypeSettlementProfile).where(and(
    eq(internalOrderTypeSettlementProfile.client, client),
    eq(internalOrderTypeSettlementProfile.orderType, order.orderType),
  ));
  const [profile] = assignment
    ? await tx.select().from(settlementProfile).where(and(
      eq(settlementProfile.client, client),
      eq(settlementProfile.profileCode, assignment.profileCode),
    ))
    : [];
  const rules = await tx.select().from(settlementDistributionRule).where(and(
    eq(settlementDistributionRule.client, client),
    eq(settlementDistributionRule.orderNumber, orderNumber),
  )).orderBy(asc(settlementDistributionRule.ruleNumber));
  return {
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    profileCode: profile?.profileCode ?? null,
    documentType: profile?.documentType ?? null,
    structureCode: profile?.allocationStructure ?? null,
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

export async function saveOrderSettlementConfiguration(
  input: SaveSettlementConfigurationInput,
): Promise<SettlementConfigurationView> {
  const orderNumber = input.orderNumber.trim();
  if (!orderNumber) throw new SettlementConfigurationError('An order number is required.');
  const profileCode = requireCode(input.profileCode, 'Profile', /^[A-Z0-9]{2,6}$/);
  const structureCode = requireCode(input.structureCode, 'Allocation structure', /^[A-Z0-9]{2,6}$/);
  const documentTypeCode = input.documentType.trim().toUpperCase();
  if (!documentTypeCode) {
    throw new SettlementConfigurationError('A document type is required. SA is not assumed.');
  }
  const description = input.profileDescription.trim();
  const structureDescription = input.structureDescription.trim();
  if (!description || description.length > 40 || !structureDescription || structureDescription.length > 40) {
    throw new SettlementConfigurationError('The profile and allocation descriptions must be 1 to 40 characters.');
  }
  const sourceAccount = input.sourceAccount.trim().toUpperCase();
  const settlementAccount = blank(input.settlementAccount)?.toUpperCase() ?? null;
  const usesOriginal = input.byOriginalAccount === true;
  const usesSettlement = settlementAccount !== null;
  if (usesOriginal === usesSettlement) {
    throw new SettlementConfigurationError(
      'Choose the original account or a settlement account, not both and not neither.',
    );
  }
  const percentage = blank(input.percentage);
  const equivalence = blank(input.equivalence);
  const amount = blank(input.amount);
  const shares = [percentage, equivalence, amount].filter((value) => value !== null);
  if (shares.length !== 1) {
    throw new SettlementConfigurationError('A rule uses a percentage, an equivalence number, or an amount, not a mix.');
  }
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
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/settlement-rule/${orderNumber}`}, 0))`);
    const [order] = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, input.client),
      eq(internalOrder.orderNumber, orderNumber),
    ));
    if (!order) throw new SettlementConfigurationError(`Internal order ${orderNumber} does not exist.`);
    const [settled] = await tx.select({ documentNumber: settlementDocument.documentNumber }).from(settlementDocument).where(and(
      eq(settlementDocument.client, input.client),
      eq(settlementDocument.orderNumber, orderNumber),
    ));
    if (settled) {
      throw new SettlementConfigurationError(
        `Internal order ${orderNumber} already has settlement document ${settled.documentNumber}.`,
        'The posted journal is not deleted, and the rule is not rewritten.',
      );
    }
    const [type] = await tx.select().from(documentType).where(and(
      eq(documentType.client, input.client),
      eq(documentType.documentType, documentTypeCode),
      eq(documentType.isActive, true),
    ));
    if (!type) throw new SettlementConfigurationError(`Document type ${documentTypeCode} is not active. SA is not assumed.`);
    const [company] = await tx.select().from(companyCode).where(and(
      eq(companyCode.client, input.client),
      eq(companyCode.companyCode, order.companyCode),
    ));
    if (!company?.chartOfAccounts) {
      throw new SettlementConfigurationError(`Company code ${order.companyCode} has no chart of accounts.`);
    }
    await accountExists(tx, input.client, company.chartOfAccounts, sourceAccount);
    if (settlementAccount) await accountExists(tx, input.client, company.chartOfAccounts, settlementAccount);
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
      const [target] = await tx.select().from(internalOrder).where(and(
        eq(internalOrder.client, input.client),
        eq(internalOrder.orderNumber, receiver),
        eq(internalOrder.controllingArea, order.controllingArea),
      ));
      if (!target) throw new SettlementConfigurationError(`Receiver order ${receiver} does not exist in this controlling area.`);
    } else if (input.receiverCategory === 'GL_ACCOUNT') {
      await accountExists(tx, input.client, company.chartOfAccounts, receiver);
    } else {
      throw new SettlementConfigurationError(`Receiver category ${input.receiverCategory} cannot be posted.`);
    }

    await tx.insert(allocationStructure).values({
      client: input.client,
      structureCode,
      description: structureDescription,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [allocationStructure.client, allocationStructure.structureCode],
      set: { description: structureDescription, changedBy: input.changedBy, changedAt: new Date() },
    });
    await tx.delete(allocationStructureAssignment).where(and(
      eq(allocationStructureAssignment.client, input.client),
      eq(allocationStructureAssignment.structureCode, structureCode),
      eq(allocationStructureAssignment.sourceAccount, sourceAccount),
      eq(allocationStructureAssignment.receiverCategory, input.receiverCategory),
    ));
    await tx.insert(allocationStructureAssignment).values({
      client: input.client,
      structureCode,
      sourceAccount,
      receiverCategory: input.receiverCategory,
      byOriginalAccount: input.byOriginalAccount,
      settlementAccount,
      createdBy: input.changedBy,
    });
    await tx.insert(settlementProfile).values({
      client: input.client,
      profileCode,
      description,
      allocationStructure: structureCode,
      documentType: documentTypeCode,
      percentageAllowed: percentage !== null,
      equivalenceAllowed: equivalence !== null,
      amountAllowed: amount !== null,
      isActive: true,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [settlementProfile.client, settlementProfile.profileCode],
      set: {
        description,
        allocationStructure: structureCode,
        documentType: documentTypeCode,
        percentageAllowed: percentage !== null,
        equivalenceAllowed: equivalence !== null,
        amountAllowed: amount !== null,
        changedBy: input.changedBy,
        changedAt: new Date(),
      },
    });
    await tx.insert(internalOrderTypeSettlementProfile).values({
      client: input.client,
      orderType: order.orderType,
      profileCode,
      createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [internalOrderTypeSettlementProfile.client, internalOrderTypeSettlementProfile.orderType],
      set: { profileCode, changedBy: input.changedBy, changedAt: new Date() },
    });
    await tx.delete(settlementDistributionRule).where(and(
      eq(settlementDistributionRule.client, input.client),
      eq(settlementDistributionRule.orderNumber, orderNumber),
    ));
    await tx.insert(settlementDistributionRule).values({
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
      objectClass: 'settlement_distribution_rule',
      objectKey: orderNumber,
      changeType: 'UPDATE',
      changedBy: input.changedBy,
      after: { profileCode, structureCode, receiver, receiverCategory: input.receiverCategory },
    });
    const saved = await loadConfiguration(tx, input.client, orderNumber);
    if (!saved) throw new SettlementConfigurationError('The settlement rule was not stored.');
    return saved;
  });
}
