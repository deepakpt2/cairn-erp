/**
 * Display a scheduling agreement — ME33L.
 *
 * A read of the agreement that already stands. It writes nothing, takes no
 * change lock, and does not release, reprice, or create a schedule line.
 */
import { changeHistory } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import {
  SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY,
  SCHEDULING_AGREEMENT_OBJECT_CLASS,
  getSchedulingAgreement,
  listSchedulingAgreements,
  type SchedulingAgreementDocument,
  type SchedulingAgreementListRow,
} from './scheduling-agreement';

export const SCHEDULING_AGREEMENT_DISPLAY_ROUTE = '/purchasing/scheduling-agreement-display';
export { SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY };

const REFUSED: Record<string, string> = {
  save: 'Display does not save a scheduling agreement.',
  price: 'A price change is not this display.',
  netPrice: 'A price change is not this display.',
  release: 'This display does not release a scheduling agreement.',
  output: 'Scheduling-agreement output is not stored. This display does not send a message.',
  condition: 'A pricing condition is not stored. The net price is the stored price.',
  stock: 'This display does not change stock.',
  delete: 'This display does not delete a scheduling agreement.',
  targetQuantity: 'A quantity change is not this display.',
  items: 'An item change is not this display.',
  changedBy: 'This display does not record a change.',
  scheduleLine: 'A delivery schedule line is not created here. ME38 maintains schedule lines.',
  exchangeRate: 'An exchange rate is not stored. Historical values are not recalculated.',
  firmZone: 'A firm zone is not stored.',
  centralContract: 'A central-contract reference is not stored on this agreement.',
};

const KNOWN = new Set(['agreement', 'supplier', 'documentType']);

export class SchedulingAgreementDisplayError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'SchedulingAgreementDisplayError';
  }
}

export interface SchedulingAgreementChangeLine {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface SchedulingAgreementChangeEntry {
  changeType: string;
  changedBy: string;
  changedAt: string;
  transactionCode: string | null;
  items: SchedulingAgreementChangeLine[];
}

function fail(message: string, remedy?: string): never {
  throw new SchedulingAgreementDisplayError(message, remedy);
}

function refuseNamed(params: Record<string, string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!value.trim() || KNOWN.has(name)) continue;
    fail(REFUSED[name] ?? `${name} is not a field on this display.`, 'Open the scheduling agreement by its number.');
  }
}

function when(value: Date | string | null | undefined): string {
  if (value == null || value === '') return '';
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export async function openSchedulingAgreementDisplay(
  client: string,
  params: Record<string, string>,
): Promise<{
  refusal: { message: string; remedy?: string } | null;
  document: SchedulingAgreementDocument | null;
  history: SchedulingAgreementChangeEntry[];
  rows: SchedulingAgreementListRow[];
}> {
  try {
    refuseNamed(params);
    const number = params.agreement?.trim() ?? '';
    if (number.length > 20) fail('The agreement number is too long.');
    if (!number) {
      const listed = await listSchedulingAgreements(client);
      const supplier = params.supplier?.trim().toUpperCase() ?? '';
      const type = params.documentType?.trim().toUpperCase() ?? '';
      return {
        refusal: null,
        document: null,
        history: [],
        rows: listed.filter((row) => (
          (!supplier || row.supplierNumber === supplier)
          && (!type || row.documentType === type)
        )).slice(0, 20),
      };
    }
    const document = await getSchedulingAgreement(client, number);
    if (!document) {
      return {
        refusal: { message: `Scheduling agreement ${number} does not exist.`, remedy: 'Choose an agreement that stands in this client.' },
        document: null,
        history: [],
        rows: [],
      };
    }
    const history = await withTenant(client, async (tx) => {
      const documents = await changeHistory(tx, client, SCHEDULING_AGREEMENT_OBJECT_CLASS, document.agreementNumber);
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
    if (error instanceof SchedulingAgreementDisplayError) {
      return { refusal: { message: error.message, remedy: error.remedy }, document: null, history: [], rows: [] };
    }
    throw error;
  }
}
