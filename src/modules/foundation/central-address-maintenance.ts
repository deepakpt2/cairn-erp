/** Transaction helpers for internal ten-digit Central Address Management numbers. */
import { sql } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { centralAddress } from './central-address-schema';

type CentralAddressInsert = Omit<
  typeof centralAddress.$inferInsert,
  'client' | 'addressNumber' | 'createdBy' | 'createdAt' | 'changedBy' | 'changedAt'
>;

/** Allocate an atomic ADRNR from the database sequence and create its CAM record. */
export async function createCentralAddress(
  tx: Tx,
  client: string,
  changedBy: string,
  values: CentralAddressInsert,
): Promise<string> {
  const result = await tx.execute(sql`
    select lpad(nextval('central_address_number_seq')::text, 10, '0') as address_number
  `);
  const row = (result as unknown as Array<{ address_number: string }>)[0];
  const addressNumber = row?.address_number?.trim() ?? '';
  if (!/^[0-9]{10}$/.test(addressNumber)) {
    throw new Error('Central Address Management could not allocate a valid ten-digit address number.');
  }
  await tx.insert(centralAddress).values({ client, addressNumber, ...values, createdBy: changedBy });
  return addressNumber;
}
