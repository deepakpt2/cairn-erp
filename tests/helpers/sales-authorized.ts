/** The sales services with a signed-in actor holding reach over the whole tenant, so a suite keeps its old call signatures. */
import {
  cancelSalesOrder as cancelSo, changeSalesOrder as changeSo, getSalesOrder as getSo,
  listSalesOrderDocuments as listSo, releaseSalesOrderCredit as releaseSo, salesOrderChoices as choicesSo,
} from '../../src/modules/sales/sales-order';
import {
  changeQuotation as changeQ, getQuotation as getQ, listQuotations as listQ, rejectQuotation as rejectQ,
} from '../../src/modules/sales/quotation';
import {
  cancelDelivery as cancelD, confirmDeliveryPicks as pickD, getDelivery as getD,
  listDeliverableOrderLines as listLines, listDeliveries as listD,
} from '../../src/modules/sales/delivery';
import {
  billingDueList as dueL, cancelBillingDocument as cancelB, getBilling as getB, goodsIssueStands as stands,
  listBillableDeliveries as billable, listBillings as listB, salesDocumentFlow as flow,
} from '../../src/modules/sales/billing';
import {
  createReturnsDelivery as createRD, createReturnsOrder as createRO, listReturnsDeliveries as listRD,
  listReturnsOrders as listRO, postReturnsDelivery as postRD, postReturnsReceipt as postRR,
} from '../../src/modules/sales/returns';
import {
  listRebateAgreements as listRA, rebateAccrualsForBillingForProvisioning, rebateRegister as regRA,
  releaseRebateAgreement as releaseRA, saveRebateAgreement as saveRA, settleRebateAgreement as settleRA,
} from '../../src/modules/sales/rebate';
import {
  cancelDownPaymentRequest as cancelDP, orderDownPayments as ordersDP, requestDownPaymentFromPlanDate as requestDP,
} from '../../src/modules/sales/down-payment';
import { listDueRegister as dueR } from '../../src/modules/sales/registers';
import { createFinanceActor, refreshFinanceActorScopes, type FinanceActor } from './finance-actor';

export const SALES_TEST_CAPABILITIES = [
  'SALES.ORDER.CREATE', 'SALES.ORDER.RELEASE', 'SALES.QUOTATION.CREATE', 'SALES.DELIVERY.CREATE',
  'SALES.ORDER.AVAILABILITY.CHECK', 'CFG.SALES.CONDITION.MAINTAIN', 'SALES.DELIVERY.PICK', 'SALES.GI.POST',
  'SALES.BILLING.CREATE', 'SALES.BILLING.CANCEL', 'SALES.CREDIT.REQUEST.CREATE',
  'SALES.RETURNS.ORDER.CREATE', 'SALES.RETURNS.DELIVERY.CREATE', 'SALES.RETURNS.RECEIPT.POST',
  'SALES.REBATE.MAINTAIN', 'SALES.CREDIT.MEMO.POST',
];

const actors = new Map<string, Promise<FinanceActor>>();
export async function salesTestAuth(client: string): Promise<{ userId: string; sessionId: string }> {
  let a = actors.get(client);
  if (!a) { a = createFinanceActor(client, { capabilities: SALES_TEST_CAPABILITIES }); actors.set(client, a); }
  const resolved = await a;
  await refreshFinanceActorScopes(client, resolved);
  return resolved.authorization;
}
type Opt<F extends (i: never) => unknown> = Omit<Parameters<F>[0], 'authorization'> & { authorization?: Parameters<F>[0]['authorization'] };

export async function getSalesOrder(client: string, orderNumber: string) { return getSo(client, orderNumber, await salesTestAuth(client)); }
export async function listSalesOrderDocuments(client: string, filter: Parameters<typeof listSo>[1] = {}) {
  return listSo(client, filter, await salesTestAuth(client));
}
export async function salesOrderChoices(client: string) { return choicesSo(client, await salesTestAuth(client)); }
export async function changeSalesOrder(input: Opt<typeof changeSo>) {
  return changeSo({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof changeSo>[0]);
}
export async function cancelSalesOrder(input: Opt<typeof cancelSo>) {
  return cancelSo({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof cancelSo>[0]);
}
export async function releaseSalesOrderCredit(input: Opt<typeof releaseSo>) {
  return releaseSo({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof releaseSo>[0]);
}

export async function getQuotation(client: string, quotationNumber: string, today?: string) {
  return getQ(client, quotationNumber, await salesTestAuth(client), today);
}
export async function listQuotations(client: string, filter: NonNullable<Parameters<typeof listQ>[1]> = {}) {
  return listQ(client, filter, await salesTestAuth(client));
}
export async function changeQuotation(input: Opt<typeof changeQ>) {
  return changeQ({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof changeQ>[0]);
}
export async function rejectQuotation(input: Opt<typeof rejectQ>) {
  return rejectQ({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof rejectQ>[0]);
}

export async function getDelivery(client: string, deliveryNumber: string) { return getD(client, deliveryNumber, await salesTestAuth(client)); }
export async function listDeliveries(client: string, filter: NonNullable<Parameters<typeof listD>[1]> = {}) {
  return listD(client, filter, await salesTestAuth(client));
}
export async function listDeliverableOrderLines(client: string, filter: NonNullable<Parameters<typeof listLines>[1]> = {}) {
  return listLines(client, filter, await salesTestAuth(client));
}
export async function confirmDeliveryPicks(input: Opt<typeof pickD>) {
  return pickD({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof pickD>[0]);
}
export async function cancelDelivery(input: Opt<typeof cancelD>) {
  return cancelD({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof cancelD>[0]);
}
export async function listDueRegister(client: string, input: Parameters<typeof dueR>[1]) {
  return dueR(client, input, await salesTestAuth(client));
}

export async function getBilling(client: string, billingNumber: string) { return getB(client, billingNumber, await salesTestAuth(client)); }
export async function listBillings(client: string, filter: Parameters<typeof listB>[1] = {}) {
  return listB(client, filter, await salesTestAuth(client));
}
export async function billingDueList(client: string, filter: NonNullable<Parameters<typeof dueL>[1]> = {}) {
  return dueL(client, filter, await salesTestAuth(client));
}
export async function listBillableDeliveries(client: string, filter: NonNullable<Parameters<typeof billable>[1]> = {}) {
  return billable(client, filter, await salesTestAuth(client));
}
export async function salesDocumentFlow(client: string, orderNumber: string) { return flow(client, orderNumber, await salesTestAuth(client)); }
export async function goodsIssueStands(client: string, deliveryNumber: string) { return stands(client, deliveryNumber, await salesTestAuth(client)); }
export async function cancelBillingDocument(input: Opt<typeof cancelB>) {
  return cancelB({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof cancelB>[0]);
}

export async function createReturnsOrder(input: Opt<typeof createRO>) {
  return createRO({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof createRO>[0]);
}
export async function createReturnsDelivery(input: Opt<typeof createRD>) {
  return createRD({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof createRD>[0]);
}
export async function postReturnsDelivery(input: Opt<typeof postRD>) {
  return postRD({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof postRD>[0]);
}
export async function postReturnsReceipt(input: Opt<typeof postRR>) {
  return postRR({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof postRR>[0]);
}
export async function listReturnsOrders(client: string, filter: NonNullable<Parameters<typeof listRO>[1]> = {}) {
  return listRO(client, filter, await salesTestAuth(client));
}
export async function listReturnsDeliveries(client: string, filter: NonNullable<Parameters<typeof listRD>[1]> = {}) {
  return listRD(client, filter, await salesTestAuth(client));
}

export const rebateAccrualsForBilling = rebateAccrualsForBillingForProvisioning;
export async function saveRebateAgreement(input: Opt<typeof saveRA>) {
  return saveRA({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof saveRA>[0]);
}
export async function releaseRebateAgreement(input: Opt<typeof releaseRA>) {
  return releaseRA({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof releaseRA>[0]);
}
export async function settleRebateAgreement(input: Opt<typeof settleRA>) {
  return settleRA({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof settleRA>[0]);
}
export async function listRebateAgreements(client: string, filter?: Parameters<typeof listRA>[1]) {
  return listRA(client, filter, await salesTestAuth(client));
}
export async function rebateRegister(client: string, agreementNumber: string) {
  return regRA(client, agreementNumber, await salesTestAuth(client));
}
export async function requestDownPaymentFromPlanDate(input: Opt<typeof requestDP>) {
  return requestDP({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof requestDP>[0]);
}
export async function cancelDownPaymentRequest(input: Opt<typeof cancelDP>) {
  return cancelDP({ ...input, authorization: input.authorization ?? await salesTestAuth(input.client) } as Parameters<typeof cancelDP>[0]);
}
export async function orderDownPayments(client: string, orderNumber: string) {
  return ordersDP(client, orderNumber, await salesTestAuth(client));
}
