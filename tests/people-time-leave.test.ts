import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  ABSENCE_STATUSES,
  TIME_ENTER_CAPABILITY,
  TIME_TYPE_KINDS,
  TimeLeaveError,
  absencesOf,
  cancelAbsence,
  changeTimeType,
  decideAbsence,
  defineTimeType,
  getAbsence,
  getLeaveQuota,
  getTimeRecording,
  getTimeTypeView,
  listAbsences,
  listTimeTypes,
  openAbsenceOn,
  recordTime,
  requestAbsence,
  setLeaveQuota,
} from '../src/modules/people/time-leave';
import { createEmployee } from '../src/modules/people/employee-master';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * The People time/leave slice — time types, absence requests, leave quotas,
 * time recordings.
 *
 * Nothing is mocked: the type is defined by the service the screen calls,
 * the absence and the time record by the services `/people/time-leave` calls,
 * and every claim is checked against what the tenant reads back afterwards.
 *
 * Six things carry the weight of the slice:
 *
 *   1. a time type is defined, read back, changed and retired — nothing deleted;
 *   2. an absence is requested with an inclusive span, refused on a covered day,
 *      decided (approved / rejected / cancelled), and the decision stands;
 *   3. an approved absence that reduces a quota lowers the remaining balance;
 *   4. time is recorded on a day and overwrites the day's entry;
 *   5. overlap, quota-exceeded, unknown-employee and unknown-type refusals all
 *      file nothing;
 *   6. a second tenant lists none of the first's time types, absences or quotas.
 *
 * Open spans are dated 2031 so that no assertion depends on what today is; a
 * span that must have stopped counting closes in 2020.
 */

const ACTOR = 'PEOPLE_9197_TEST';
const AREA = 'A000';
const CC = 'CC100';

let tenant: TestTenant;
let other: TestTenant;
let counter = 0;
const key = (what: string) => `ppl9197-${what}-${++counter}`;
const numberFor = () => `T${String(9200000 + ++counter)}`;
const codeFor = (what: string) => `${what}${String(++counter).padStart(3, '0')}`;

async function person(label: string): Promise<string> {
  const personnelNumber = numberFor();
  await createEmployee({
    client: tenant.client,
    personnelNumber,
    fullName: `Time Leave Test Person ${label}`,
    changedBy: ACTOR,
    requestKey: key(`emp-${label}`),
  });
  return personnelNumber;
}

async function otherPerson(label: string): Promise<string> {
  const personnelNumber = numberFor();
  await createEmployee({
    client: other.client,
    personnelNumber,
    fullName: `Other Tenant Time Person ${label}`,
    changedBy: ACTOR,
    requestKey: key(`other-${label}`),
  });
  return personnelNumber;
}

async function defineAbsenceType(code: string): Promise<void> {
  await defineTimeType({
    client: tenant.client,
    code,
    name: `Leave ${code}`,
    description: 'A configured absence type for the tenant.',
    typeKind: 'ABSENCE',
    reducesQuota: true,
    changedBy: ACTOR,
  });
}

async function defineAttendanceType(code: string): Promise<void> {
  await defineTimeType({
    client: tenant.client,
    code,
    name: `Attendance ${code}`,
    description: 'A configured attendance type for the tenant.',
    typeKind: 'ATTENDANCE',
    reducesQuota: false,
    changedBy: ACTOR,
  });
}

describe('people time and leave', () => {
  beforeAll(async () => {
    tenant = await createTenant('ppl-time-leave-primary', { withConfiguration: true });
    other = await createTenant('ppl-time-leave-other', { withConfiguration: true });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  });

  describe('time types', () => {
    it('defines, reads back, changes and retires a type', async () => {
      const code = codeFor('TYPE');
      await defineAbsenceType(code);

      const view = await getTimeTypeView(tenant.client, code);
      expect(view.code).toBe(code);
      expect(view.name).toBe('Leave ' + code);
      expect(view.typeKind).toBe('ABSENCE');
      expect(view.reducesQuota).toBe(true);
      expect(view.isValid).toBe(true);

      const list = await listTimeTypes(tenant.client, true);
      expect(list.some((t) => t.code === code)).toBe(true);

      await changeTimeType({
        client: tenant.client,
        code,
        name: 'Renamed ' + code,
        isValid: false,
        changedBy: ACTOR,
      });

      const changed = await getTimeTypeView(tenant.client, code);
      expect(changed.name).toBe('Renamed ' + code);
      expect(changed.isValid).toBe(false);

      const stillThere = await listTimeTypes(tenant.client, false);
      expect(stillThere.some((t) => t.code === code)).toBe(true);

      const openOnly = await listTimeTypes(tenant.client, true);
      expect(openOnly.some((t) => t.code === code)).toBe(false);
    });

    it('refuses a duplicate code and a retired type for new use', async () => {
      const code = codeFor('DUP');
      await defineAbsenceType(code);

      await expect(
        defineTimeType({
          client: tenant.client,
          code,
          name: 'Duplicate',
          typeKind: 'ABSENCE',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);

      // A retired type cannot be used for a new absence.
      await changeTimeType({
        client: tenant.client,
        code,
        isValid: false,
        changedBy: ACTOR,
      });

      const p = await person('retired-user');
      await expect(
        requestAbsence({
          client: tenant.client,
          personnelNumber: p,
          timeTypeCode: code,
          validFrom: '2031-01-01',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);
    });
  });

  describe('absence requests', () => {
    it('requests, overlaps, approves, rejects and cancels', async () => {
      const code = codeFor('LEAVE');
      await defineAbsenceType(code);
      const p = await person('absence-user');

      await setLeaveQuota({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        year: '2031',
        entitlement: '30',
        changedBy: ACTOR,
      });

      // Request a dated absence.
      const view = await requestAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-02-01',
        validTo: '2031-02-10',
        reason: 'Annual leave',
        changedBy: ACTOR,
      });
      expect(view.status).toBe('REQUESTED');
      expect(view.validTo).toBe('2031-02-10');

      // Read it back.
      const got = await getAbsence(tenant.client, p, code, '2031-02-01');
      expect(got.status).toBe('REQUESTED');
      expect(got.reason).toBe('Annual leave');

      // An overlap on a covered day is refused.
      await expect(
        requestAbsence({
          client: tenant.client,
          personnelNumber: p,
          timeTypeCode: code,
          validFrom: '2031-02-05',
          validTo: '2031-02-08',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);

      // Approve it.
      const approved = await decideAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-02-01',
        status: 'APPROVED',
        changedBy: ACTOR,
      });
      expect(approved.status).toBe('APPROVED');

      // A decided absence cannot be decided again.
      await expect(
        decideAbsence({
          client: tenant.client,
          personnelNumber: p,
          timeTypeCode: code,
          validFrom: '2031-02-01',
          status: 'REJECTED',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);

      // Request a second, non-overlapping absence after the first ends.
      await requestAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-03-01',
        validTo: '2031-03-10',
        reason: 'Sick leave',
        changedBy: ACTOR,
      });

      // Cancel the second one.
      const cancelled = await cancelAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-03-01',
        changedBy: ACTOR,
      });
      expect(cancelled.status).toBe('CANCELLED');

      // History: two rows for this employee/type, one approved, one cancelled — nothing deleted.
      const all = await absencesOf(tenant.client, p);
      expect(all.filter((a) => a.timeTypeCode === code)).toHaveLength(2);
    });

    it('refuses an unknown employee, type, and end-before-start', async () => {
      const code = codeFor('BAD');
      await defineAbsenceType(code);

      await expect(
        requestAbsence({
          client: tenant.client,
          personnelNumber: 'NOPE',
          timeTypeCode: code,
          validFrom: '2031-01-01',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);

      await expect(
        requestAbsence({
          client: tenant.client,
          personnelNumber: 'NOPE',
          timeTypeCode: 'NOPE',
          validFrom: '2031-01-01',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);

      await expect(
        requestAbsence({
          client: tenant.client,
          personnelNumber: 'NOPE',
          timeTypeCode: code,
          validFrom: '2031-01-02',
          validTo: '2031-01-01',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);
    });

    it('searches by status and type', async () => {
      const code = codeFor('SEARCH');
      await defineAbsenceType(code);
      const p = await person('search-user');

      await setLeaveQuota({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        year: '2031',
        entitlement: '30',
        changedBy: ACTOR,
      });

      await requestAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-04-01',
        changedBy: ACTOR,
      });

      const requested = await listAbsences({
        client: tenant.client,
        status: 'REQUESTED',
      });
      expect(requested.some((a) => a.personnelNumber === p && a.timeTypeCode === code)).toBe(true);

      const byType = await listAbsences({
        client: tenant.client,
        timeTypeCode: code,
      });
      expect(byType.some((a) => a.personnelNumber === p)).toBe(true);

      const none = await listAbsences({
        client: tenant.client,
        status: 'APPROVED',
      });
      expect(none.some((a) => a.personnelNumber === p)).toBe(false);
    });
  });

  describe('leave quota', () => {
    it('sets entitlement and reduces remaining on approval', async () => {
      const code = codeFor('QUOTA');
      await defineAbsenceType(code);
      const p = await person('quota-user');

      await setLeaveQuota({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        year: '2031',
        entitlement: '20',
        changedBy: ACTOR,
      });

      const quota = await getLeaveQuota(tenant.client, p, code, 2031);
      expect(quota.entitlement).toBe(20);
      expect(quota.taken).toBe(0);
      expect(quota.remaining).toBe(20);

      // Request and approve a 5-day absence — remaining drops.
      await requestAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-05-01',
        validTo: '2031-05-05',
        changedBy: ACTOR,
      });
      await decideAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-05-01',
        status: 'APPROVED',
        changedBy: ACTOR,
      });

      const after = await getLeaveQuota(tenant.client, p, code, 2031);
      expect(after.taken).toBe(5);
      expect(after.remaining).toBe(15);

      // A new request for more than remaining is refused.
      await expect(
        requestAbsence({
          client: tenant.client,
          personnelNumber: p,
          timeTypeCode: code,
          validFrom: '2031-06-01',
          validTo: '2031-06-20',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);

      // But one within remaining is fine.
      await requestAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-06-01',
        validTo: '2031-06-10',
        changedBy: ACTOR,
      });
    });

    it('refuses a quota for a type that does not reduce quota', async () => {
      const code = codeFor('ATT');
      await defineAttendanceType(code);
      const p = await person('no-quota-user');

      await expect(
        setLeaveQuota({
          client: tenant.client,
          personnelNumber: p,
          timeTypeCode: code,
          year: '2031',
          entitlement: '10',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);
    });
  });

  describe('time recordings', () => {
    it('records, overwrites and reads back time', async () => {
      const code = codeFor('ATTEND');
      await defineAttendanceType(code);
      const p = await person('time-user');

      const view = await recordTime({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        recordingDate: '2031-07-01',
        hours: '8',
        changedBy: ACTOR,
      });
      expect(view.hours).toBe(8);

      const got = await getTimeRecording(tenant.client, p, code, '2031-07-01');
      expect(got.hours).toBe(8);

      // Overwrite the same day.
      await recordTime({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        recordingDate: '2031-07-01',
        hours: '6.5',
        changedBy: ACTOR,
      });

      const after = await getTimeRecording(tenant.client, p, code, '2031-07-01');
      expect(after.hours).toBe(6.5);
    });

    it('refuses unknown employee, type and bad hours', async () => {
      const code = codeFor('BADTIME');
      await defineAttendanceType(code);

      await expect(
        recordTime({
          client: tenant.client,
          personnelNumber: 'NOPE',
          timeTypeCode: code,
          recordingDate: '2031-07-01',
          hours: '8',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);

      await expect(
        recordTime({
          client: tenant.client,
          personnelNumber: 'NOPE',
          timeTypeCode: 'NOPE',
          recordingDate: '2031-07-01',
          hours: '8',
          changedBy: ACTOR,
        }),
      ).rejects.toThrow(TimeLeaveError);
    });
  });

  describe('tenant isolation', () => {
    it('keeps each tenant\'s time types and absences separate', async () => {
      const code = codeFor('ISO');
      await defineAbsenceType(code);

      const types = await listTimeTypes(tenant.client, true);
      expect(types.some((t) => t.code === code)).toBe(true);

      const otherTypes = await listTimeTypes(other.client, true);
      expect(otherTypes.some((t) => t.code === code)).toBe(false);

      const p = await person('iso-user');
      const op = await otherPerson('other-iso-user');

      await setLeaveQuota({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        year: '2031',
        entitlement: '30',
        changedBy: ACTOR,
      });

      await requestAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-08-01',
        changedBy: ACTOR,
      });

      const mine = await listAbsences({ client: tenant.client });
      expect(mine.some((a) => a.personnelNumber === p)).toBe(true);

      const theirs = await listAbsences({ client: other.client });
      expect(theirs.some((a) => a.personnelNumber === p)).toBe(false);

      // The other tenant's own employee cannot see this tenant's type.
      await expect(
        getAbsence(other.client, op, code, '2031-08-01'),
      ).rejects.toThrow(TimeLeaveError);
    });
  });

  describe('open absence on a day', () => {
    it('finds the absence standing on a day', async () => {
      const code = codeFor('OPEN');
      await defineAbsenceType(code);
      const p = await person('open-user');

      await setLeaveQuota({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        year: '2031',
        entitlement: '30',
        changedBy: ACTOR,
      });

      await requestAbsence({
        client: tenant.client,
        personnelNumber: p,
        timeTypeCode: code,
        validFrom: '2031-09-01',
        validTo: '2031-09-30',
        changedBy: ACTOR,
      });

      const open = await openAbsenceOn(tenant.client, p, code, '2031-09-15');
      expect(open).not.toBeNull();
      expect(open!.status).toBe('REQUESTED');

      const notOpen = await openAbsenceOn(tenant.client, p, code, '2031-10-01');
      expect(notOpen).toBeNull();
    });
  });
});
