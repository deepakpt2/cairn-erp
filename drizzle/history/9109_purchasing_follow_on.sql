-- A request may name a requisition without consuming it. A quotation may
-- carry the info-update indicator. An order may name the quotation and the
-- quota item it settled. A material may hold a future price and a previous
-- price. None of these columns post by themselves.

alter table purchasing_rfq_event_item
  add column requisition_number varchar(10),
  add column requisition_item integer;

alter table purchasing_rfq_event_item
  add constraint purchasing_rfq_event_item_requisition_pair_ck
  check ((requisition_number is null) = (requisition_item is null));

alter table purchasing_rfq_event_item
  add constraint purchasing_rfq_event_item_requisition_fk
  foreign key (client, requisition_number, requisition_item)
  references purchase_requisition_item (client, requisition_number, item_number);

alter table purchasing_rfq_item
  add column requisition_number varchar(10),
  add column requisition_item integer;

alter table purchasing_rfq_item
  add constraint purchasing_rfq_item_requisition_pair_ck
  check ((requisition_number is null) = (requisition_item is null));

alter table purchasing_rfq_item
  add constraint purchasing_rfq_item_requisition_fk
  foreign key (client, requisition_number, requisition_item)
  references purchase_requisition_item (client, requisition_number, item_number);

alter table purchasing_quotation_item
  add column info_update boolean not null default false;

alter table purchase_order_item
  add column quotation_number varchar(20),
  add column quotation_item integer,
  add column info_update boolean not null default false,
  add column quota_number varchar(20),
  add column quota_item varchar(3);

alter table purchase_order_item
  add constraint purchase_order_item_quotation_pair_ck
  check ((quotation_number is null) = (quotation_item is null));

alter table purchase_order_item
  add constraint purchase_order_item_quota_pair_ck
  check ((quota_number is null) = (quota_item is null));

alter table purchase_order_item
  add constraint purchase_order_item_quotation_fk
  foreign key (client, quotation_number, quotation_item)
  references purchasing_quotation_item (client, quotation_number, item_number);

alter table purchase_order_item
  add constraint purchase_order_item_quota_fk
  foreign key (client, quota_number, quota_item)
  references purchasing_quota_arrangement_item (client, quota_number, item_number);

create index purchase_order_item_quotation_idx
  on purchase_order_item (client, quotation_number, quotation_item);

alter table material_valuation
  add column future_price numeric(23, 4),
  add column future_price_unit numeric(23, 3),
  add column future_valid_from date,
  add column previous_price numeric(23, 4),
  add column previous_price_unit numeric(23, 3);

alter table material_valuation
  add constraint material_valuation_future_ck
  check (
    (future_price is null and future_price_unit is null and future_valid_from is null)
    or (future_price >= 0 and future_price_unit > 0 and future_valid_from is not null)
  );

alter table material_valuation
  add constraint material_valuation_previous_ck
  check (
    (previous_price is null and previous_price_unit is null)
    or (previous_price >= 0 and previous_price_unit > 0)
  );

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'INV.MATERIAL.PRICECHANGE',
  'INV',
  'POST',
  true,
  'Change a material price. The current period revalues stock now. A previous period posts only while that period is open. A future price is stored and posts when it is released.'
)
on conflict (code) do update set
  description = excluded.description,
  is_posting_relevant = excluded.is_posting_relevant;

insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'INV.MATERIAL.PRICECHANGE', 'MIGRATION_9109'
from role_capability rc
where rc.capability_code in ('INV.GR.POST', 'INV.MATERIAL.MAINTAIN')
on conflict (client, role_code, capability_code) do nothing;

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'INV.MATERIAL.PRICECHANGE',
  null,
  'Change material price',
  'TRANSACTION',
  'INV',
  'Change the valuation price of a material at a plant. The current period posts the stock-value difference now, to inventory and price difference, and updates the book value. A previous period posts only when that material period is open for backposting and the financial period is open; the current book price is not changed. A future price is stored and does not post until it is released. A batch is not part of this screen.',
  'TIER_1_BUILT',
  '/inventory/price-change',
  'B',
  'MIGRATION_9109'
)
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9109',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MR21', 'SEARCH_ONLY', 'MIGRATION_9109'
from term_registry t
where t.our_code = 'INV.MATERIAL.PRICECHANGE'
on conflict (external_system, alias) do nothing;

update term_registry
set description = 'A request for quotation asks. Each supplier receives a separate copy of the lines. A line may name a requisition item. That reference is copied and the requisition quantity is not consumed, so several suppliers may be asked for the same quantity. A request does not create a quotation, an order, a goods movement, or a journal.',
    changed_by = 'MIGRATION_9109',
    changed_at = now()
where our_code = 'PROC.RFQ.CREATE';

update term_registry
set description = 'A quotation prices one standing request. A line may carry an info-update indicator. Saving the quotation does not write the info record and does not create an order. The order writes the info record, when it is saved from the quotation, only if that indicator is set.',
    changed_by = 'MIGRATION_9109',
    changed_at = now()
where our_code = 'PROC.RFQ.QUOTATION';

update term_registry
set description = 'A purchasing quota arrangement weights who may supply one material at one plant. Saving an order adds the order quantity to that vendor''s quota base when the vendor stands in the quota. A vendor who does not stand is warned, and the order is saved. This screen still allocates nothing.',
    changed_by = 'MIGRATION_9109',
    changed_at = now()
where our_code = 'PROC.QUOTA.MAINTAIN';
