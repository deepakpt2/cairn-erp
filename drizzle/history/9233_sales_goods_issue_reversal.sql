-- A goods issue that stands is a fact, not a reading.
--
-- Reversing a material document has never told Sales anything, which is how a delivery whose goods
-- have been taken back out of the plant could go on standing GOODS_ISSUED, and how a goods issue
-- could be reversed out from under a receivable that was already raised on it. The delivery carried
-- the material document it posted, so the question "does the issue still stand?" was answered by
-- reading that document's unreversed lines — a computation, in a screen, about a fact the delivery
-- itself is the owner of.
--
-- It is the delivery's fact, so the delivery stores it. Two constraints come with it, and they are
-- the point of storing it at all: a delivery cannot claim an issue stands with no movement behind
-- the claim, and a delivery that stands GOODS_ISSUED is a delivery whose goods are out — if the
-- issue has been undone, the status has to be undone with it, because a screen reading GOODS_ISSUED
-- is entitled to believe the goods have gone.

alter table public.delivery
  add column goods_issue_stands boolean not null default false;

-- Everything already issued stands issued: the column arrives false, and that would be a lie about
-- every delivery that has posted a movement.
update public.delivery
   set goods_issue_stands = true
 where status = 'GOODS_ISSUED'
   and material_document_number is not null;

alter table public.delivery
  drop constraint if exists delivery_goods_issue_stands_ck;
alter table public.delivery
  add constraint delivery_goods_issue_stands_ck
  check (not goods_issue_stands or material_document_number is not null);

alter table public.delivery
  drop constraint if exists delivery_issued_issue_stands_ck;
alter table public.delivery
  add constraint delivery_issued_issue_stands_ck
  check (status <> 'GOODS_ISSUED' or goods_issue_stands);

comment on column public.delivery.goods_issue_stands is
  'Whether the goods issue this delivery posted still stands: true from the moment the movement posts, false when that movement is reversed. A delivery that stands GOODS_ISSUED is a delivery whose goods are out, so undoing the issue undoes the status with it.';
