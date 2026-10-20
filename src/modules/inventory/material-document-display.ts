/**
 * Display material document — SCR-134 / INV.DISPLAY (MB03 as a search alias only).
 *
 * A display, and only a display: nothing here writes, locks, or adjusts. The
 * document is read exactly as the ledger recorded it, including a document whose
 * posting period has since closed — showing history as it stood is the point of
 * the transaction, so no period check (OMSY / MARV / OB52) is applied.
 *
 * The key. The package asks for `[tenant, company code, document, fiscal year]`.
 * Canon's header carries no company code, and the document number is unique per
 * tenant (SCR-125), so the lookup stands on `(client, document number)` and the
 * fiscal year is a **cross-check**: an entered year that disagrees with the
 * document refuses by name, as MBST does. The company code is **derived** from the
 * plants the lines stand in and shown, never typed.
 *
 * Optional item number (ZEILE) narrows the grid to one line and marks it; a line
 * the document does not carry refuses by name.
 *
 * The journal number is the drill: SCR-137 delivered `FIN.JOURNAL.DISPLAY`, so the
 * number opens the accounting document display (§26.892) rather than standing as text.
 *
 * Deferred by name: F4 search help (no search-help framework exists) and the
 * reservation reference — no posting path writes one yet (`INV.GI.POST` has no
 * service; SCR-133 shipped withdrawals as a hook).
 *
 * Refused by name: plant- and storage-location-level authorisation objects. Canon
 * authorises by capability and tenant; a plant filter invented here would hide
 * documents the postings themselves allow.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { plant as plantTable } from '../foundation/schema';
import { material, materialDocument, materialDocumentLine, movementType } from './schema';

export const MATERIAL_DOC_DISPLAY_CAPABILITY = 'INV.DISPLAY';
export const MATERIAL_DOC_DISPLAY_ALIAS = 'MB03';
export const MATERIAL_DOC_DISPLAY_ROUTE = '/inventory/material-documents';

export class MaterialDocumentDisplayError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'MaterialDocumentDisplayError';
  }
}

export interface DisplayedDocumentLine {
  lineNumber: number;
  movementType: string;
  movementDescription: string | null;
  /** RECEIPT or ISSUE — canon writes transfers as one line each (SCR-131). */
  lineDirection: string;
  materialNumber: string;
  materialDescription: string | null;
  plant: string;
  storageLocation: string | null;
  stockType: string;
  quantity: string;
  unit: string;
  entryQuantity: string;
  entryUnit: string;
  value: string;
  currency: string | null;
  purchaseOrderNumber: string | null;
  purchaseOrderItem: number | null;
  itemText: string | null;
  reversalOfDocument: string | null;
  reversalOfLine: number | null;
}

export interface DisplayedDocument {
  capability: string;
  materialDocumentNumber: string;
  documentYear: number;
  documentDate: string;
  postingDate: string;
  headerText: string | null;
  status: string;
  /** USNAM — who posted it. */
  postedBy: string;
  /** CPUTM — when the ledger took it. */
  enteredAt: string;
  journalDocumentNumber: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
  /** Derived from the plants the lines stand in; never typed and never stored. */
  companyCodes: string[];
  /** The line the lookup narrowed to, when one was named. */
  selectedItem: number | null;
  lines: DisplayedDocumentLine[];
  lineCount: number;
  /** Where the list can be opened to see this document among its neighbours. */
  listDrillDown: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Find one document by its number. The fiscal year, when given, must agree; the
 * item number, when given, must stand in the document. A document that does not
 * stand is refused in the SAP shape — "Material document … does not exist".
 */
export async function displayMaterialDocument(input: {
  client: string;
  documentNumber: string;
  fiscalYear?: string;
  itemNumber?: string;
}): Promise<DisplayedDocument> {
  const number = input.documentNumber.trim();
  if (!number) {
    throw new MaterialDocumentDisplayError(
      'A material document number is required.',
      'Enter the document number (MBLNR) and its fiscal year (MJAHR).',
    );
  }
  const yearText = (input.fiscalYear ?? '').trim();
  if (yearText && !/^\d{4}$/.test(yearText)) {
    throw new MaterialDocumentDisplayError(
      `Fiscal year ${yearText} is not a four-digit year.`,
      'Enter the fiscal year as four digits, for example 2026.',
    );
  }
  const itemText = (input.itemNumber ?? '').trim();

  return withTenant(input.client, async (tx) => {
    const [header] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, number),
    ));
    if (!header) {
      throw new MaterialDocumentDisplayError(
        `Material document ${number} does not exist.`,
        'Check the number; a document is unique per tenant. The list shows the documents that stand.',
      );
    }
    if (yearText && Number(yearText) !== header.documentYear) {
      throw new MaterialDocumentDisplayError(
        `Material document ${number} does not exist in fiscal year ${yearText}.`,
        `It stands in fiscal year ${header.documentYear}. A fiscal year that disagrees with the document is refused rather than ignored.`,
      );
    }

    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, input.client),
      eq(materialDocumentLine.materialDocumentNumber, number),
    )).orderBy(materialDocumentLine.lineNumber);

    let selectedItem: number | null = null;
    if (itemText) {
      if (!/^\d+$/.test(itemText)) {
        throw new MaterialDocumentDisplayError(
          `Item ${itemText} is not an item number.`,
          'An item number is a whole number, as the line shows it.',
        );
      }
      selectedItem = Number(itemText);
      if (!lines.some((l) => l.lineNumber === selectedItem)) {
        throw new MaterialDocumentDisplayError(
          `Material document ${number} carries no item ${itemText}.`,
          `Its items are ${lines.map((l) => l.lineNumber).join(', ') || 'none'}.`,
        );
      }
    }

    const shown = selectedItem === null ? lines : lines.filter((l) => l.lineNumber === selectedItem);

    const materialNumbers = [...new Set(shown.map((l) => l.materialNumber))];
    const descriptions = new Map<string, string>();
    if (materialNumbers.length > 0) {
      const masters = await tx.select({
        materialNumber: material.materialNumber, description: material.description,
      }).from(material).where(and(
        eq(material.client, input.client), inArray(material.materialNumber, materialNumbers),
      ));
      for (const m of masters) {
        if (m.description !== null) descriptions.set(m.materialNumber, m.description);
      }
    }

    const movementCodes = [...new Set(shown.map((l) => l.movementType))];
    const movements = new Map<string, string>();
    if (movementCodes.length > 0) {
      const found = await tx.select({
        movementType: movementType.movementType, description: movementType.description,
      }).from(movementType).where(and(
        eq(movementType.client, input.client), inArray(movementType.movementType, movementCodes),
      ));
      for (const m of found) movements.set(m.movementType, m.description);
    }

    const plantCodes = [...new Set(shown.map((l) => l.plant))];
    const companyByPlant = new Map<string, string>();
    if (plantCodes.length > 0) {
      const found = await tx.select({
        plant: plantTable.plant, companyCode: plantTable.companyCode,
      }).from(plantTable).where(and(
        eq(plantTable.client, input.client), inArray(plantTable.plant, plantCodes),
      ));
      for (const p of found) {
        if (p.companyCode) companyByPlant.set(p.plant, p.companyCode);
      }
    }
    const companyCodes = [...new Set([...companyByPlant.values()])].sort();

    const row = (l: typeof materialDocumentLine.$inferSelect): DisplayedDocumentLine => ({
      lineNumber: l.lineNumber,
      movementType: l.movementType,
      movementDescription: movements.get(l.movementType) ?? null,
      lineDirection: l.lineDirection,
      materialNumber: l.materialNumber,
      materialDescription: descriptions.get(l.materialNumber) ?? null,
      plant: l.plant,
      storageLocation: l.storageLocation,
      stockType: l.stockType,
      quantity: l.baseQuantity,
      unit: l.baseUnit,
      entryQuantity: l.entryQuantity,
      entryUnit: l.entryUnit,
      value: l.value,
      currency: l.currency,
      purchaseOrderNumber: l.purchaseOrderNumber,
      purchaseOrderItem: l.purchaseOrderItem,
      itemText: l.itemText,
      reversalOfDocument: l.reversalOfDocument,
      reversalOfLine: l.reversalOfLine,
    });

    return {
      capability: MATERIAL_DOC_DISPLAY_CAPABILITY,
      materialDocumentNumber: header.materialDocumentNumber,
      documentYear: header.documentYear,
      documentDate: header.documentDate,
      postingDate: header.postingDate,
      headerText: header.headerText,
      status: header.status,
      postedBy: header.createdBy,
      enteredAt: header.createdAt instanceof Date
        ? header.createdAt.toISOString()
        : String(header.createdAt),
      journalDocumentNumber: header.journalDocumentNumber,
      reversalOf: header.reversalOf,
      reversedBy: header.reversedBy,
      companyCodes,
      selectedItem,
      lines: shown.map(row),
      lineCount: shown.length,
      listDrillDown: `/inventory/material-document-list?postingDateFrom=${encodeURIComponent(
        ISO_DATE.test(header.postingDate) ? header.postingDate : '',
      )}&postingDateTo=${encodeURIComponent(
        ISO_DATE.test(header.postingDate) ? header.postingDate : '',
      )}`,
    };
  });
}
