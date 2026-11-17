-- 9304_release_categories.sql
--
-- Release strategies cover two more document categories: a parked journal entry (JOURNAL_ENTRY) and a
-- payment run (PAYMENT_RUN). Both categories are added to the release_group and document_release category
-- checks, and each gets its release capability. Contracts and scheduling agreements were already in the
-- checks; only the strategy configuration screen did not offer them.

alter table public.release_group drop constraint if exists release_group_category_ck;
alter table public.release_group add constraint release_group_category_ck check (
  document_category in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_CONTRACT', 'SCHED_AGREEMENT',
                        'JOURNAL_ENTRY', 'PAYMENT_RUN'));

alter table public.document_release drop constraint if exists document_release_category_ck;
alter table public.document_release add constraint document_release_category_ck check (
  document_category in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PURCHASE_CONTRACT', 'SCHED_AGREEMENT',
                        'JOURNAL_ENTRY', 'PAYMENT_RUN'));

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('FIN.JOURNAL.RELEASE', 'FIN', 'APPROVE', false,
   'Release a parked journal entry when a release strategy claims it. The person who prepared the document cannot release it'),
  ('FIN.AP.PAYMENTRUN.RELEASE', 'FIN', 'APPROVE', false,
   'Release a payment run proposal when a release strategy claims it. The person who prepared the run cannot release it')
on conflict (code) do nothing;
