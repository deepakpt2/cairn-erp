-- 9274 — Demo credentials are remembered, never stored
--
-- The demo installation issues one password, shared by every demo account, at the
-- moment the dataset is built. That password must never be written to the database:
-- anyone who can read the database could then sign in as any demo user, and the
-- database is the one artefact a deployment is most likely to hand to somebody.
--
-- What is stored instead is a fingerprint, and it answers exactly one question:
-- has a password already been issued for this installation? A later run needs that
-- answer, because the credential file may have been lost and rewritten, and the
-- report has to say honestly that the password cannot be shown again rather than
-- printing a blank space where it used to be.
--
-- The fingerprint is a hash of the password with a fixed prefix. It is not a
-- verifier for login — real authentication uses scrypt in the application — and it
-- is deliberately not derived from anything the application stores, so nothing here
-- can be replayed against a real account.

alter table demo_installation
  add column if not exists password_fingerprint text,
  add column if not exists password_issued_at timestamptz;

comment on column demo_installation.password_fingerprint is
  'sha256 of the issued demo password under a fixed prefix. Proves a password was issued and lets a later run detect that it is being asked to reprint one; it cannot be reversed into the password. Null until credentials are delivered.';

comment on column demo_installation.password_issued_at is
  'When the shared demo password was generated and delivered. Shown in the credential report when the password itself can no longer be printed.';

-- The application role already holds INSERT and UPDATE on this table from 9273; no
-- further grant is needed for these columns, and DELETE remains ungranted: an
-- interrupted installation keeps its evidence.
