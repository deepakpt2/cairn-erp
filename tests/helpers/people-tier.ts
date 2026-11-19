/**
 * Give a test actor a place on the org chart: a position of the requested tier, an active employee holding it
 * (company-wide, at `plant`), and the link from the employee to the actor's user. This is what makes an actor's
 * tier real — the services read it from the chart, never from the session.
 */
import { assignPosition } from '../../src/modules/people/assignment';
import { createEmployee, linkEmployeeUser } from '../../src/modules/people/employee-master';
import { defineOrgUnit, definePosition } from '../../src/modules/people/org-structure';
import { AREA, CENTRE } from './payroll-actor';

const ADMIN = ['*'] as const;
const units = new Set<string>();
let seq = 0;

export async function placeOnChart(
  client: string, actor: { username: string }, tier: number, plant?: string,
): Promise<{ personnelNumber: string; positionCode: string }> {
  seq += 1;
  const suffix = `${String(Date.now()).slice(-5)}${seq}`;
  const unit = `TU${client.replace(/[^A-Z0-9]/gi, '').slice(-6).toUpperCase()}`;
  if (!units.has(unit)) {
    await defineOrgUnit({ client, code: unit, name: 'Tier test unit', changedBy: 'T' }, ADMIN).catch(() => undefined);
    units.add(unit);
  }
  const positionCode = `TP${tier}${suffix}`;
  await definePosition({ client, code: positionCode, title: `Tier ${tier} position`, orgUnitCode: unit, tier, changedBy: 'T' }, ADMIN);
  const personnelNumber = `TA${suffix}`;
  await createEmployee({ client, personnelNumber, fullName: `Actor ${personnelNumber}`, changedBy: 'T', requestKey: `tier-actor-${personnelNumber}` }, ADMIN);
  await assignPosition({
    client, personnelNumber, positionCode, controllingArea: AREA, costCenter: CENTRE, ...(plant ? { plant } : {}),
    validFrom: '2025-01-01', changedBy: 'T',
  }, ADMIN);
  await linkEmployeeUser({ client, personnelNumber, username: actor.username, changedBy: 'T' }, ADMIN);
  return { personnelNumber, positionCode };
}
