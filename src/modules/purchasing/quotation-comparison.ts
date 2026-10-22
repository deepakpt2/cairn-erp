/**
 * Compare quotations — SCR-159.
 *
 * A read of the quotations that stand for one event. The event number is the
 * key. A collective number is a label. The price compared is the net price per
 * one unit of the unit that was asked, calculated and not stored. There is no
 * condition, no exchange rate, no revision, and no award. This module writes
 * nothing.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { businessPartner } from '../foundation/business-partner-schema';
import { plant, purchasingOrg } from '../foundation/schema';
import { material, materialUomConversion } from '../inventory/schema';
import { pricePerUnit } from './quotation';
import {
  purchasingQuotation, purchasingQuotationItem, purchasingRfq, purchasingRfqEvent, purchasingRfqEventItem, purchasingRfqItem,
} from './schema';

export const QUOTATION_COMPARISON_CAPABILITY = 'PROC.RFQ.COMPARISON';
export const QUOTATION_COMPARISON_ROUTE = '/purchasing/quotation-comparison';
const PRICE_SCALE = 4;
const QUANTITY_SCALE = 3;

export class ComparisonError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ComparisonError';
    this.remedy = remedy;
  }
}

export interface ComparisonInput {
  client: string;
  eventNumber?: string | null;
  collectiveNumber?: string | null;
  purchasingOrg?: string | null;
  plant?: string | null;
  materialNumber?: string | null;
  currency?: string | null;
  evaluationDate?: string | null;
  priceBasis?: string | null;
  award?: string | null;
  status?: string | null;
  revision?: string | null;
  freight?: string | null;
  discount?: string | null;
  tax?: string | null;
  condition?: string | null;
  orderNumber?: string | null;
  requestKey?: string | null;
}

export interface ComparisonOffer {
  quantity: string;
  unit: string;
  netPrice: string;
  priceUnit: string;
  pricePerOfferedUnit: string;
  comparableUnitPrice: string | null;
  extendedCost: string | null;
  deliveryDate: string;
  remark: string | null;
  quantityDiffers: boolean;
}

export interface ComparisonBid {
  partnerNumber: string;
  partnerName: string;
  rfqNumber: string;
  quotationNumber: string | null;
  copyQuantity: string;
  copyUnit: string;
  offer: ComparisonOffer | null;
  eligible: boolean;
  reason: string | null;
  rank: number | null;
  tie: boolean;
}

export interface ComparisonItem {
  itemNumber: number;
  shortText: string;
  materialNumber: string | null;
  plant: string;
  quantity: string;
  unit: string;
  deliveryDate: string;
  bids: ComparisonBid[];
}

export interface QuotationComparison {
  eventNumber: string;
  collectiveNumber: string | null;
  purchasingOrg: string;
  currency: string;
  evaluationDate: string;
  currencyNote: string;
  priceNote: string;
  filterNote: string | null;
  items: ComparisonItem[];
}

function blank(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function keyOf(value: string | null | undefined): string {
  return blank(value)?.toUpperCase() ?? '';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function refuseNamed(input: ComparisonInput): void {
  if (blank(input.award)) throw new ComparisonError('An award is not created from this comparison.');
  if (blank(input.status)) throw new ComparisonError('A quotation has no stored status. It stands when it is saved.');
  if (blank(input.revision)) throw new ComparisonError('A revision is not stored. The standing offer is what was last saved.');
  if (blank(input.orderNumber)) throw new ComparisonError('An order is not created.');
  if (blank(input.requestKey)) throw new ComparisonError('A request key is not stored.');
  if (blank(input.evaluationDate)) throw new ComparisonError('The evaluation date is the server\'s date. It is not entered.');
  if (blank(input.priceBasis) || blank(input.freight) || blank(input.discount) || blank(input.tax) || blank(input.condition)) {
    throw new ComparisonError('A landed cost is not calculated. The net price is the price named.');
  }
}

function halfUp(product: bigint, divisor: bigint): bigint {
  const quotient = product / divisor;
  const remainder = product % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

function sameQuantity(left: string, right: string): boolean {
  return toScaled(left, QUANTITY_SCALE) === toScaled(right, QUANTITY_SCALE);
}

function extendedCost(unitPrice: string, quantity: string): string {
  const price = toScaled(unitPrice, PRICE_SCALE);
  const qty = toScaled(quantity, QUANTITY_SCALE);
  return fromScaled(halfUp(price * qty, 10n ** BigInt(QUANTITY_SCALE)), PRICE_SCALE);
}

interface Conversion {
  alternativeUnit: string;
  baseUnit: string;
  numerator: number;
  denominator: number;
}

function comparableUnitPrice(
  materialNumber: string | null,
  offeredUnit: string,
  askedUnit: string,
  pricePerOffer: string,
  conversions: Conversion[],
): { price: string } | { reason: string } {
  if (offeredUnit === askedUnit) return { price: pricePerOffer };
  if (!materialNumber) return { reason: `Unit ${offeredUnit} is not the unit that was asked.` };
  const scaled = toScaled(pricePerOffer, PRICE_SCALE);
  for (const conversion of conversions) {
    if (conversion.numerator <= 0 || conversion.denominator <= 0) continue;
    if (conversion.alternativeUnit === offeredUnit && conversion.baseUnit === askedUnit) {
      return { price: fromScaled(halfUp(scaled * BigInt(conversion.denominator), BigInt(conversion.numerator)), PRICE_SCALE) };
    }
    if (conversion.alternativeUnit === askedUnit && conversion.baseUnit === offeredUnit) {
      return { price: fromScaled(halfUp(scaled * BigInt(conversion.numerator), BigInt(conversion.denominator)), PRICE_SCALE) };
    }
  }
  return { reason: `Material ${materialNumber} has no conversion from ${offeredUnit} to ${askedUnit}.` };
}

function rankBids(bids: ComparisonBid[]): ComparisonBid[] {
  const eligible = bids.filter((bid) => bid.eligible).sort((left, right) => {
    const leftPrice = toScaled(left.offer?.comparableUnitPrice ?? '0', PRICE_SCALE);
    const rightPrice = toScaled(right.offer?.comparableUnitPrice ?? '0', PRICE_SCALE);
    if (leftPrice < rightPrice) return -1;
    if (leftPrice > rightPrice) return 1;
    return left.partnerNumber.localeCompare(right.partnerNumber);
  });
  let index = 0;
  while (index < eligible.length) {
    let end = index + 1;
    const price = eligible[index].offer?.comparableUnitPrice;
    while (end < eligible.length && eligible[end].offer?.comparableUnitPrice === price) end += 1;
    const tie = end - index > 1;
    for (let cursor = index; cursor < end; cursor += 1) {
      eligible[cursor].rank = index + 1;
      eligible[cursor].tie = tie;
    }
    index = end;
  }
  const rest = bids.filter((bid) => !bid.eligible).sort((left, right) => left.partnerNumber.localeCompare(right.partnerNumber));
  return [...eligible, ...rest];
}

export async function compareQuotations(input: ComparisonInput): Promise<QuotationComparison> {
  refuseNamed(input);
  const purchasingOrgCode = keyOf(input.purchasingOrg);
  if (!purchasingOrgCode) throw new ComparisonError('A purchasing organisation is required.');
  const eventKey = keyOf(input.eventNumber);
  const collective = blank(input.collectiveNumber);
  if (collective && collective.length > 10) throw new ComparisonError('A collective number is at most ten characters.');
  if (!eventKey && !collective) throw new ComparisonError('An event number is required. A collective number is a label, not the key.');
  const plantCode = keyOf(input.plant);
  const materialNumber = keyOf(input.materialNumber);

  return withTenant(input.client, async (tx) => {
    const [org] = await tx.select().from(purchasingOrg).where(and(
      eq(purchasingOrg.client, input.client),
      eq(purchasingOrg.purchasingOrg, purchasingOrgCode),
    ));
    if (!org || !org.isActive) throw new ComparisonError(`Purchasing organisation ${purchasingOrgCode} does not stand.`);

    let event: typeof purchasingRfqEvent.$inferSelect | undefined;
    if (eventKey) {
      const [row] = await tx.select().from(purchasingRfqEvent).where(and(
        eq(purchasingRfqEvent.client, input.client),
        eq(purchasingRfqEvent.eventNumber, eventKey),
      ));
      if (!row) throw new ComparisonError(`Event ${eventKey} does not stand.`);
      if (collective && (row.collectiveNumber ?? '') !== collective) {
        throw new ComparisonError(`Event ${eventKey} carries collective number ${row.collectiveNumber ?? 'none'}, not ${collective}.`);
      }
      event = row;
    } else if (collective) {
      const rows = await tx.select().from(purchasingRfqEvent).where(and(
        eq(purchasingRfqEvent.client, input.client),
        eq(purchasingRfqEvent.collectiveNumber, collective),
      )).orderBy(asc(purchasingRfqEvent.eventNumber));
      if (rows.length === 0) throw new ComparisonError(`No event carries collective number ${collective}.`);
      if (rows.length > 1) {
        throw new ComparisonError(`Collective number ${collective} is a label on ${rows.map((row) => row.eventNumber).join(', ')}. It is not the key.`);
      }
      event = rows[0];
    }
    if (!event) throw new ComparisonError('An event number is required. A collective number is a label, not the key.');
    if (event.purchasingOrg !== purchasingOrgCode) {
      throw new ComparisonError(`Event ${event.eventNumber} is purchasing organisation ${event.purchasingOrg}, not ${purchasingOrgCode}.`);
    }
    const currency = event.currency.trim();
    const postedCurrency = keyOf(input.currency);
    if (postedCurrency && postedCurrency !== currency) {
      throw new ComparisonError(`The currency is the company's local currency ${currency}, not a field on the comparison.`);
    }
    if (postedCurrency) throw new ComparisonError(`The currency is the company's local currency ${currency}, not a field on the comparison.`);

    if (plantCode) {
      const [row] = await tx.select().from(plant).where(and(eq(plant.client, input.client), eq(plant.plant, plantCode)));
      if (!row || !row.isActive) throw new ComparisonError(`Plant ${plantCode} does not stand.`);
    }
    if (materialNumber) {
      const [row] = await tx.select({ materialNumber: material.materialNumber }).from(material).where(and(
        eq(material.client, input.client),
        eq(material.materialNumber, materialNumber),
      ));
      if (!row) throw new ComparisonError(`Material ${materialNumber} does not stand.`);
    }

    const asked = (await tx.select().from(purchasingRfqEventItem).where(and(
      eq(purchasingRfqEventItem.client, input.client),
      eq(purchasingRfqEventItem.eventNumber, event.eventNumber),
    )).orderBy(asc(purchasingRfqEventItem.itemNumber))).filter((row) => (
      (!plantCode || row.plant === plantCode) && (!materialNumber || row.materialNumber === materialNumber)
    ));
    const requests = await tx.select().from(purchasingRfq).where(and(
      eq(purchasingRfq.client, input.client),
      eq(purchasingRfq.eventNumber, event.eventNumber),
    )).orderBy(asc(purchasingRfq.partnerNumber));
    const copies = await tx.select().from(purchasingRfqItem).where(and(
      eq(purchasingRfqItem.client, input.client),
      eq(purchasingRfqItem.eventNumber, event.eventNumber),
    ));
    const requestNumbers = requests.map((row) => row.rfqNumber);
    const quotations = requestNumbers.length === 0 ? [] : await tx.select().from(purchasingQuotation).where(and(
      eq(purchasingQuotation.client, input.client),
      inArray(purchasingQuotation.rfqNumber, requestNumbers),
    ));
    const quotationByRequest = new Map(quotations.map((row) => [row.rfqNumber, row]));
    const quotationNumbers = quotations.map((row) => row.quotationNumber);
    const offers = quotationNumbers.length === 0 ? [] : await tx.select().from(purchasingQuotationItem).where(and(
      eq(purchasingQuotationItem.client, input.client),
      inArray(purchasingQuotationItem.quotationNumber, quotationNumbers),
    ));
    const offerByKey = new Map(offers.map((row) => [`${row.quotationNumber}:${row.itemNumber}`, row]));
    const partnerNumbers = requests.map((row) => row.partnerNumber);
    const partners = partnerNumbers.length === 0 ? [] : await tx.select({
      partnerNumber: businessPartner.partnerNumber,
      name: businessPartner.name,
    }).from(businessPartner).where(and(
      eq(businessPartner.client, input.client),
      inArray(businessPartner.partnerNumber, partnerNumbers),
    ));
    const partnerName = new Map(partners.map((row) => [row.partnerNumber, row.name]));
    const materials = [...new Set(asked.map((row) => row.materialNumber).filter((value): value is string => Boolean(value)))];
    const conversions = materials.length === 0 ? [] : await tx.select().from(materialUomConversion).where(and(
      eq(materialUomConversion.client, input.client),
      inArray(materialUomConversion.materialNumber, materials),
    ));
    const conversionsByMaterial = new Map<string, Conversion[]>();
    for (const row of conversions) {
      const list = conversionsByMaterial.get(row.materialNumber) ?? [];
      list.push({
        alternativeUnit: row.alternativeUnit,
        baseUnit: row.baseUnit,
        numerator: row.numerator,
        denominator: row.denominator,
      });
      conversionsByMaterial.set(row.materialNumber, list);
    }

    const items: ComparisonItem[] = asked.map((line) => {
      const bids = requests.map((request): ComparisonBid => {
        const copy = copies.find((row) => row.rfqNumber === request.rfqNumber && row.itemNumber === line.itemNumber);
        const quotation = quotationByRequest.get(request.rfqNumber) ?? null;
        const offer = quotation ? offerByKey.get(`${quotation.quotationNumber}:${line.itemNumber}`) ?? null : null;
        if (!offer || !copy) {
          return {
            partnerNumber: request.partnerNumber,
            partnerName: partnerName.get(request.partnerNumber) ?? '',
            rfqNumber: request.rfqNumber,
            quotationNumber: quotation?.quotationNumber ?? null,
            copyQuantity: copy?.quantity ?? line.quantity,
            copyUnit: copy?.unit ?? line.unit,
            offer: null,
            eligible: false,
            reason: 'No offer.',
            rank: null,
            tie: false,
          };
        }
        const perOffer = pricePerUnit(offer.netPrice, offer.priceUnit);
        const compared = comparableUnitPrice(
          line.materialNumber,
          offer.unit,
          line.unit,
          perOffer,
          line.materialNumber ? conversionsByMaterial.get(line.materialNumber) ?? [] : [],
        );
        const eligible = 'price' in compared;
        return {
          partnerNumber: request.partnerNumber,
          partnerName: partnerName.get(request.partnerNumber) ?? '',
          rfqNumber: request.rfqNumber,
          quotationNumber: quotation?.quotationNumber ?? null,
          copyQuantity: copy.quantity,
          copyUnit: copy.unit,
          offer: {
            quantity: offer.quantity,
            unit: offer.unit,
            netPrice: offer.netPrice,
            priceUnit: offer.priceUnit,
            pricePerOfferedUnit: perOffer,
            comparableUnitPrice: eligible ? compared.price : null,
            extendedCost: eligible ? extendedCost(compared.price, line.quantity) : null,
            deliveryDate: offer.deliveryDate,
            remark: offer.remark,
            quantityDiffers: offer.unit === line.unit && !sameQuantity(offer.quantity, line.quantity),
          },
          eligible,
          reason: eligible ? null : compared.reason,
          rank: null,
          tie: false,
        };
      });
      return {
        itemNumber: line.itemNumber,
        shortText: line.shortText,
        materialNumber: line.materialNumber,
        plant: line.plant,
        quantity: line.quantity,
        unit: line.unit,
        deliveryDate: line.deliveryDate,
        bids: rankBids(bids),
      };
    });

    const filterNote = asked.length === 0 && (plantCode || materialNumber)
      ? `No line of event ${event.eventNumber} matches the filter.`
      : null;
    return {
      eventNumber: event.eventNumber,
      collectiveNumber: event.collectiveNumber,
      purchasingOrg: event.purchasingOrg,
      currency,
      evaluationDate: today(),
      currencyNote: `The price is in ${currency}, the company's currency. It is not converted.`,
      priceNote: 'The compared price is the net price per one unit of the unit that was asked. It is calculated. It is not stored. A rank is not an award.',
      filterNote,
      items,
    };
  });
}
