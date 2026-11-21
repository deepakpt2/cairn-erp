/** The material-document display and list with a signed-in actor holding reach over the whole tenant. */
import { displayMaterialDocument as display } from '../../src/modules/inventory/material-document-display';
import { listMaterialDocuments as list } from '../../src/modules/inventory/material-document-list';
import { createFinanceActor, type FinanceActor } from './finance-actor';

const actors = new Map<string, Promise<FinanceActor>>();
async function actor(client: string): Promise<FinanceActor> {
  let a = actors.get(client);
  if (!a) { a = createFinanceActor(client, { capabilities: ['INV.DISPLAY', 'INV.MATERIALDOC.LIST'] }); actors.set(client, a); }
  return a;
}
type Opt<F extends (i: never) => unknown> = Omit<Parameters<F>[0], 'authorization'> & { authorization?: Parameters<F>[0]['authorization'] };

export async function displayMaterialDocument(input: Opt<typeof display>) {
  return display({ ...input, authorization: input.authorization ?? (await actor(input.client)).authorization } as Parameters<typeof display>[0]);
}
export async function listMaterialDocuments(input: Opt<typeof list>) {
  return list({ ...input, authorization: input.authorization ?? (await actor(input.client)).authorization } as Parameters<typeof list>[0]);
}

export { MaterialDocumentDisplayError, MATERIAL_DOC_DISPLAY_CAPABILITY, MATERIAL_DOC_DISPLAY_ALIAS, MATERIAL_DOC_DISPLAY_ROUTE } from '../../src/modules/inventory/material-document-display';
export type { DisplayedDocument, DisplayedDocumentLine } from '../../src/modules/inventory/material-document-display';
export { MaterialDocListError, MATERIAL_DOC_LIST_CAPABILITY, MATERIAL_DOC_LIST_ALIAS, DEFAULT_MAX_HITS, MAX_HITS_CAP } from '../../src/modules/inventory/material-document-list';
export type { MaterialDocListRow, MaterialDocListResult, MaterialDocListSelection } from '../../src/modules/inventory/material-document-list';

import { stockOverview as overview } from '../../src/modules/inventory/stock-overview';
import { listWarehouseStocks as warehouse } from '../../src/modules/inventory/warehouse-stocks';

async function stockActor(client: string): Promise<FinanceActor> {
  const key = `stock:${client}`;
  let a = actors.get(key);
  if (!a) { a = createFinanceActor(client, { capabilities: ['INV.STOCK.VIEW', 'INV.STOCK.WAREHOUSE'] }); actors.set(key, a); }
  return a;
}
export async function stockOverview(input: Opt<typeof overview>) {
  return overview({ ...input, authorization: input.authorization ?? (await stockActor(input.client)).authorization } as Parameters<typeof overview>[0]);
}
export async function listWarehouseStocks(input: Opt<typeof warehouse>) {
  return warehouse({ ...input, authorization: input.authorization ?? (await stockActor(input.client)).authorization } as Parameters<typeof warehouse>[0]);
}
export { StockOverviewError } from '../../src/modules/inventory/stock-overview';
export { WarehouseStockError } from '../../src/modules/inventory/warehouse-stocks';

import { refreshFinanceActorScopes } from './finance-actor';
import {
  completeReservationItem as completeItem, createReservation as createRes, getReservation as getRes, withdrawReservation as withdrawRes,
} from '../../src/modules/inventory/reservations';

async function reservationActor(client: string): Promise<FinanceActor> {
  const key = `rsv:${client}`;
  let a = actors.get(key);
  if (!a) { a = createFinanceActor(client, { capabilities: ['INV.RESERVATION.CREATE'] }); actors.set(key, a); }
  const resolved = await a;
  await refreshFinanceActorScopes(client, resolved);
  return resolved;
}
export async function createReservation(input: Opt<typeof createRes>) {
  return createRes({ ...input, authorization: input.authorization ?? (await reservationActor(input.client)).authorization } as Parameters<typeof createRes>[0]);
}
export async function withdrawReservation(input: Opt<typeof withdrawRes>) {
  return withdrawRes({ ...input, authorization: input.authorization ?? (await reservationActor(input.client)).authorization } as Parameters<typeof withdrawRes>[0]);
}
export async function completeReservationItem(input: Opt<typeof completeItem>) {
  return completeItem({ ...input, authorization: input.authorization ?? (await reservationActor(input.client)).authorization } as Parameters<typeof completeItem>[0]);
}
export async function getReservation(client: string, number: string) {
  return getRes(client, number, (await reservationActor(client)).authorization);
}

import {
  cancelPhysicalInventory as cancelPi, createPhysicalInventory as createPi, listPhysicalInventory as listPi,
} from '../../src/modules/inventory/physical-inventory';

async function phyInvActor(client: string): Promise<FinanceActor> {
  const key = `pi:${client}`;
  let a = actors.get(key);
  if (!a) { a = createFinanceActor(client, { capabilities: ['INV.PHYINV.CREATE', 'INV.PHYINV.CANCEL', 'INV.PHYINV.COUNT', 'INV.PHYINV.COUNT.CORRECT', 'INV.PHYINV.DIFF.LIST', 'INV.PHYINV.DIFF.POST', 'INV.PHYINV.RECOUNT', 'INV.REVERSE'] }); actors.set(key, a); }
  const resolved = await a;
  await refreshFinanceActorScopes(client, resolved);
  return resolved;
}
export async function createPhysicalInventory(input: Opt<typeof createPi>) {
  return createPi({ ...input, authorization: input.authorization ?? (await phyInvActor(input.client)).authorization } as Parameters<typeof createPi>[0]);
}
export async function cancelPhysicalInventory(input: Opt<typeof cancelPi>) {
  return cancelPi({ ...input, authorization: input.authorization ?? (await phyInvActor(input.client)).authorization } as Parameters<typeof cancelPi>[0]);
}
export async function listPhysicalInventory(client: string, filter: { plant?: string } = {}) {
  return listPi(client, filter, (await phyInvActor(client)).authorization);
}

import {
  clearCount as clearCnt, getCountDocument as getCntDoc, getCountHistory as getCntHist,
  getCountStatus as getCntStatus, searchCountDocuments as searchCnt, submitCounts as submitCnt,
} from '../../src/modules/inventory/physical-inventory-count';
import {
  getDifferenceDocument as getDiffDoc, listDifferences as listDiff, openDifferenceWorkflow as openDiff,
} from '../../src/modules/inventory/physical-inventory-differences';
import {
  getDifferencePosting as getPost, getPostingHistory as getPostHist, postDifferences as postDiff,
  reverseDifferencePosting as reversePost, validateDifferencePosting as validatePost,
} from '../../src/modules/inventory/physical-inventory-posting';
import {
  cancelRecount as cancelRc, createRecount as createRc, getRecountComparison as getRcCmp,
  getRecountSource as getRcSrc, validateRecount as validateRc,
} from '../../src/modules/inventory/physical-inventory-recount';

type Keys = { documentNumber: string; fiscalYear: number };
const auth = async (client: string) => (await phyInvActor(client)).authorization;

export async function submitCounts(input: Opt<typeof submitCnt>) {
  return submitCnt({ ...input, authorization: input.authorization ?? await auth(input.client) } as Parameters<typeof submitCnt>[0]);
}
export async function clearCount(input: Opt<typeof clearCnt>) {
  return clearCnt({ ...input, authorization: input.authorization ?? await auth(input.client) } as Parameters<typeof clearCnt>[0]);
}
export async function getCountDocument(client: string, keys: Keys) { return getCntDoc(client, keys, await auth(client)); }
export async function searchCountDocuments(client: string, filter: { plant?: string; status?: string } = {}) {
  return searchCnt(client, filter, await auth(client));
}
export async function getCountHistory(client: string, keys: Keys & { itemNumber?: number }) { return getCntHist(client, keys, await auth(client)); }
export async function getCountStatus(client: string, keys: Keys) { return getCntStatus(client, keys, await auth(client)); }

export async function listDifferences(client: string, raw: Parameters<typeof listDiff>[1]) { return listDiff(client, raw, await auth(client)); }
export async function getDifferenceDocument(client: string, keys: Keys) { return getDiffDoc(client, keys, await auth(client)); }
export async function openDifferenceWorkflow(client: string, input: Parameters<typeof openDiff>[1]) { return openDiff(client, input, await auth(client)); }

export async function getDifferencePosting(client: string, keys: Keys) { return getPost(client, keys, await auth(client)); }
export async function getPostingHistory(client: string, keys: Keys) { return getPostHist(client, keys, await auth(client)); }
export async function validateDifferencePosting(input: Opt<typeof validatePost>) {
  return validatePost({ ...input, authorization: input.authorization ?? await auth(input.client) } as Parameters<typeof validatePost>[0]);
}
export async function postDifferences(input: Opt<typeof postDiff>) {
  return postDiff({ ...input, authorization: input.authorization ?? await auth(input.client) } as Parameters<typeof postDiff>[0]);
}
export async function reverseDifferencePosting(input: Opt<typeof reversePost>) {
  return reversePost({ ...input, authorization: input.authorization ?? await auth(input.client) } as Parameters<typeof reversePost>[0]);
}

export async function validateRecount(input: Opt<typeof validateRc>) {
  return validateRc({ ...input, authorization: input.authorization ?? await auth(input.client) } as Parameters<typeof validateRc>[0]);
}
export async function createRecount(input: Opt<typeof createRc>) {
  return createRc({ ...input, authorization: input.authorization ?? await auth(input.client) } as Parameters<typeof createRc>[0]);
}
export async function cancelRecount(input: Opt<typeof cancelRc>) {
  return cancelRc({ ...input, authorization: input.authorization ?? await auth(input.client) } as Parameters<typeof cancelRc>[0]);
}
export async function getRecountSource(client: string, keys: Keys) { return getRcSrc(client, keys, await auth(client)); }
export async function getRecountComparison(client: string, keys: Keys) { return getRcCmp(client, keys, await auth(client)); }
