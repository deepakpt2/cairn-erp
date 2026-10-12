/**
 * Global append-only evidence for partner-bank profile activation — D-060/D-061.
 *
 * Actor identity is a tenant key plus globally unique user UUID, captured as a
 * snapshot so tenant/user deletion cannot erase global activation evidence. The
 * runtime role has no direct table privileges; a narrow activation function will
 * write status + evidence atomically in a later batch.
 */
import { sql } from 'drizzle-orm';
import { char, check, index, integer, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { country } from '../../platform/tables/reference';

export const partnerBankProfileActivationAudit = pgTable(
  'partner_bank_profile_activation_audit',
  {
    eventId: uuid('event_id').notNull(),
    actorClient: varchar('actor_client', { length: 4 }).notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    countryCode: char('country_code', { length: 2 })
      .notNull()
      .references(() => country.code),
    policyRevision: varchar('policy_revision', { length: 12 }).notNull(),
    previousStatus: varchar('previous_status', { length: 12 }).notNull(),
    newStatus: varchar('new_status', { length: 12 }).notNull(),
    previousVersion: integer('previous_version').notNull(),
    newVersion: integer('new_version').notNull(),
    evidenceCode: varchar('evidence_code', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId] }),
    index('partner_bank_profile_activation_audit_country_time_idx').on(t.countryCode, t.createdAt),
    check(
      'partner_bank_profile_activation_audit_event_uuidv4',
      sql`substring(${t.eventId}::text from 15 for 1) = '4'
        and substring(${t.eventId}::text from 20 for 1) in ('8', '9', 'a', 'b')`,
    ),
    check('partner_bank_profile_activation_audit_actor_client', sql`${t.actorClient} ~ '^[A-Za-z0-9]{2,4}$'`),
    check('partner_bank_profile_activation_audit_policy_revision', sql`${t.policyRevision} ~ '^D-[0-9]{3}$'`),
    check(
      'partner_bank_profile_activation_audit_transition',
      sql`${t.previousStatus} = 'NOT_READY' and ${t.newStatus} = 'READY'`,
    ),
    check(
      'partner_bank_profile_activation_audit_version',
      sql`${t.previousVersion} > 0 and ${t.newVersion} = ${t.previousVersion} + 1`,
    ),
    check(
      'partner_bank_profile_activation_audit_evidence',
      sql`${t.evidenceCode} = 'PROFILE_VALIDATION_ACCEPTED'`,
    ),
  ],
);
