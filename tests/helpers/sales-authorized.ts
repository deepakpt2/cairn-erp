/** The sales services with a signed-in actor holding reach over the whole tenant, so a suite keeps its old call signatures. */
import {
  cancelSalesOrder as cancelSo, changeSalesOrder as changeSo, getSalesOrder as getSo,
  listSalesOrderDocuments as listSo, releaseSalesOrderCredit as releaseSo, salesOrderChoices as choicesSo,
} from '../../src/modules/sales/sales-order';
import { createFinanceActor, refreshFinanceActorScopes, type FinanceActor } from './finance-actor';

export const SALES_TEST_CAPABILITIES = [
  'SALES.ORDER.CREATE', 'SALES.ORDER.RELEASE', 'SALES.QUOTATION.CREATE', 'SALES.DELIVERY.CREATE',
  'SALES.ORDER.AVAILABILITY.CHECK', 'CFG.SALES.CONDITION.MAINTAIN',
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
