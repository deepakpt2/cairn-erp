/**
 * Server-generated identifiers for future partner-bank rows (D-082).
 *
 * UUIDv4 shape alone does not prove that an ID came from a trusted record. A
 * future read/reveal path must first resolve it under the authenticated tenant
 * and partner, then use the ID from that database row.
 */
import { randomUUID } from 'node:crypto';

declare const bankRecordIdBrand: unique symbol;
export type BankRecordId = string & { readonly [bankRecordIdBrand]: true };

const BANK_RECORD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Generate a canonical lowercase UUIDv4 using Node's cryptographic RNG. */
export function generateBankRecordId(): BankRecordId {
  return randomUUID() as BankRecordId;
}

/** Validate canonical UUIDv4 shape only; this does not establish provenance. */
export function isBankRecordId(value: unknown): value is BankRecordId {
  return typeof value === 'string' && BANK_RECORD_ID_PATTERN.test(value);
}
