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
