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
