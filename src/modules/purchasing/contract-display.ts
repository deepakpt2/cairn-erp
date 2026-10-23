/**
 * Display a purchase contract — ME33K.
 *
 * A read of the contract that already stands. It writes nothing, takes no
 * change lock, and does not release, reprice, or send output. The figures
 * come from the same reader as the contract itself.
 */
import { changeHistory } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import {
  CONTRACT_DISPLAY_CAPABILITY,
  CONTRACT_OBJECT_CLASS,
  getPurchaseContract,
  listPurchaseContracts,
  type ContractDocument,
  type ContractListRow,
} from './contract';

export const CONTRACT_DISPLAY_ROUTE = '/purchasing/contract-display';
export { CONTRACT_DISPLAY_CAPABILITY };

const REFUSED: Record<string, string> = {
  save: 'Display does not save a contract.',
  price: 'A price change is not this display.',
  netPrice: 'A price change is not this display.',
  release: 'This display does not release a contract.',
  output: 'Contract output is not stored. This display does not send a message.',
  condition: 'A pricing condition is not stored. The net price is the stored price.',
  stock: 'This display does not change stock.',
  delete: 'This display does not delete a contract.',
  targetQuantity: 'A quantity change is not this display.',
  items: 'An item change is not this display.',
  changedBy: 'This display does not record a change.',
};

const KNOWN = new Set(['contract', 'supplier', 'documentType']);

export class PurchaseContractDisplayError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'PurchaseContractDisplayError';
  }
}

export interface ContractChangeLine {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface ContractChangeEntry {
  changeType: string;
  changedBy: string;
  changedAt: string;
  transactionCode: string | null;
  items: ContractChangeLine[];
}

function fail(message: string, remedy?: string): never {
  throw new PurchaseContractDisplayError(message, remedy);
}

function refuseNamed(params: Record<string, string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!value.trim() || KNOWN.has(name)) continue;
    fail(REFUSED[name] ?? `${name} is not a field on this display.`, 'Open the contract by its number.');
  }
}

function when(value: Date | string | null | undefined): string {
  if (value == null || value === '') return '';
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export async function openPurchaseContractDisplay(
  client: string,
  params: Record<string, string>,
): Promise<{
  refusal: { message: string; remedy?: string } | null;
  document: ContractDocument | null;
  history: ContractChangeEntry[];
  rows: ContractListRow[];
}> {
  try {
    refuseNamed(params);
    const number = params.contract?.trim() ?? '';
    if (number.length > 20) fail('The contract number is too long.');
    if (!number) {
      const listed = await listPurchaseContracts(client);
      const supplier = params.supplier?.trim().toUpperCase() ?? '';
      const type = params.documentType?.trim().toUpperCase() ?? '';
      const rows = listed.filter((row) => (
        (!supplier || row.supplierNumber === supplier)
        && (!type || row.documentType === type)
      )).slice(0, 20);
      return { refusal: null, document: null, history: [], rows };
    }
    const document = await getPurchaseContract(client, number);
    if (!document) {
      return {
        refusal: { message: `Contract ${number} does not exist.`, remedy: 'Choose a contract that stands in this client.' },
        document: null,
        history: [],
        rows: [],
      };
    }
    const history = await withTenant(client, async (tx) => {
      const documents = await changeHistory(tx, client, CONTRACT_OBJECT_CLASS, document.contractNumber);
      return documents.map((entry) => ({
        changeType: entry.changeType,
        changedBy: entry.changedBy,
        changedAt: when(entry.changedAt),
        transactionCode: entry.transactionCode ?? null,
        items: entry.items.map((item) => ({
          fieldName: item.fieldName,
          oldValue: item.oldValue,
          newValue: item.newValue,
        })),
      }));
    });
    return { refusal: null, document, history, rows: [] };
  } catch (error) {
    if (error instanceof PurchaseContractDisplayError) {
      return { refusal: { message: error.message, remedy: error.remedy }, document: null, history: [], rows: [] };
    }
    throw error;
  }
}
