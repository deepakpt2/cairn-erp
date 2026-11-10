/**
 * The statuses a serialised unit moves between, kept apart from the module that reads the master.
 *
 * The screen that records a unit is a client component, and this file is the reason it can import the
 * choices without pulling the database driver into the browser bundle: `serial-number.ts` imports the
 * tables it reads, and a client component that imports it takes the whole of `postgres` with it —
 * which is exactly what put the batch determination screen at 500. What each status means is part of
 * what a clerk is being told, so it lives with the choices rather than in the screen.
 */

export const SERIAL_STATUSES = ['AVAILABLE', 'IN_STOCK', 'DELIVERED', 'SCRAPPED'] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];

export const SERIAL_STATUS_MEANING: Record<SerialStatus, string> = {
  AVAILABLE: 'Created, and not yet put away in a store.',
  IN_STOCK: 'Standing in a store, and can be picked.',
  DELIVERED: 'Gone out to a customer, and the delivery it went on is written beside it.',
  SCRAPPED: 'Not coming back.',
};
