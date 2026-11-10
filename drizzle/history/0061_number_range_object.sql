-- SCR-050 / R-98 (stage 2): the object registry and the great rename.
--
-- Every stored object code narrows to at most ten characters: SAP's
-- own names where canonical (RF_BELEG, MATERIALNR) and product stems
-- in the same pattern elsewhere (R-98 carries the full map). The
-- rename runs through interval rows, allocation rows and document
-- types' range objects; historical change documents keep the keys
-- they were written with. The tenant registry then stands one row per
-- standing object with its maintainable facts.
update public.number_range set object_code = case object_code
  when 'JOURNAL_ENTRY' then 'RF_BELEG'
  when 'MATERIAL' then 'MATERIALNR'
  when 'MATERIAL_DOCUMENT' then 'MATDOC'
  when 'PURCHASE_ORDER' then 'PURCHORD'
  when 'PURCHASE_REQUISITION' then 'PURCHREQ'
  when 'SALES_ORDER' then 'SALESORD'
  when 'BILLING_DOCUMENT' then 'BILLING'
  when 'PRODUCTION_ORDER' then 'PRODORDER'
  when 'PRODUCTION_CONFIRMATION' then 'PRODCONF'
  when 'PAYMENT_RUN' then 'PAYRUN'
  when 'VENDOR_INVOICE' then 'VENDINV'
  when 'BUSINESS_PARTNER' then 'BUSPARTNR'
  else object_code end
where object_code in ('JOURNAL_ENTRY','MATERIAL','MATERIAL_DOCUMENT','PURCHASE_ORDER',
  'PURCHASE_REQUISITION','SALES_ORDER','BILLING_DOCUMENT','PRODUCTION_ORDER',
  'PRODUCTION_CONFIRMATION','PAYMENT_RUN','VENDOR_INVOICE','BUSINESS_PARTNER');
--> statement-breakpoint
update public.number_range_allocation set object_code = case object_code
  when 'JOURNAL_ENTRY' then 'RF_BELEG'
  when 'MATERIAL' then 'MATERIALNR'
  when 'MATERIAL_DOCUMENT' then 'MATDOC'
  when 'PURCHASE_ORDER' then 'PURCHORD'
  when 'PURCHASE_REQUISITION' then 'PURCHREQ'
  when 'SALES_ORDER' then 'SALESORD'
  when 'BILLING_DOCUMENT' then 'BILLING'
  when 'PRODUCTION_ORDER' then 'PRODORDER'
  when 'PRODUCTION_CONFIRMATION' then 'PRODCONF'
  when 'PAYMENT_RUN' then 'PAYRUN'
  when 'VENDOR_INVOICE' then 'VENDINV'
  when 'BUSINESS_PARTNER' then 'BUSPARTNR'
  else object_code end
where object_code in ('JOURNAL_ENTRY','MATERIAL','MATERIAL_DOCUMENT','PURCHASE_ORDER',
  'PURCHASE_REQUISITION','SALES_ORDER','BILLING_DOCUMENT','PRODUCTION_ORDER',
  'PRODUCTION_CONFIRMATION','PAYMENT_RUN','VENDOR_INVOICE','BUSINESS_PARTNER');
--> statement-breakpoint
update public.document_type set number_range_object = case number_range_object
  when 'JOURNAL_ENTRY' then 'RF_BELEG'
  when 'MATERIAL' then 'MATERIALNR'
  when 'MATERIAL_DOCUMENT' then 'MATDOC'
  when 'PURCHASE_ORDER' then 'PURCHORD'
  when 'PURCHASE_REQUISITION' then 'PURCHREQ'
  when 'SALES_ORDER' then 'SALESORD'
  when 'BILLING_DOCUMENT' then 'BILLING'
  when 'PRODUCTION_ORDER' then 'PRODORDER'
  when 'PRODUCTION_CONFIRMATION' then 'PRODCONF'
  when 'PAYMENT_RUN' then 'PAYRUN'
  when 'VENDOR_INVOICE' then 'VENDINV'
  when 'BUSINESS_PARTNER' then 'BUSPARTNR'
  else number_range_object end
where number_range_object in ('JOURNAL_ENTRY','MATERIAL','MATERIAL_DOCUMENT','PURCHASE_ORDER',
  'PURCHASE_REQUISITION','SALES_ORDER','BILLING_DOCUMENT','PRODUCTION_ORDER',
  'PRODUCTION_CONFIRMATION','PAYMENT_RUN','VENDOR_INVOICE','BUSINESS_PARTNER');
--> statement-breakpoint
create table public.number_range_object (
  client varchar(4) not null references public.client(client) on delete cascade,
  object_code varchar(10) not null,
  description varchar(60) not null,
  number_length integer not null default 10,
  warning_percent numeric(3,1),
  year_relevant boolean not null default false,
  subobject_hint varchar(30),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, object_code),
  constraint number_range_object_format_ck check (object_code ~ '^[A-Z0-9_]{1,10}$'),
  constraint number_range_object_length_ck check (number_length between 1 and 40),
  constraint number_range_object_warning_ck check (warning_percent is null or (warning_percent > 0 and warning_percent < 100))
);
--> statement-breakpoint
insert into public.number_range_object
  (client, object_code, description, number_length, year_relevant, subobject_hint, created_by)
select c.client, o.object_code, o.description, o.number_length, o.year_relevant, o.subobject_hint, 'SYSTEM'
from public.client c
cross join (values
  ('RF_BELEG',   'Accounting documents',        10, true,  'Company code'),
  ('MATDOC',     'Material documents',          10, false, null),
  ('MATERIALNR', 'Material master records',     18, false, 'Number range group'),
  ('PURCHORD',   'Purchase orders',             10, false, null),
  ('PURCHREQ',   'Purchase requisitions',       10, false, null),
  ('SALESORD',   'Sales orders',                10, false, null),
  ('DELIVERY',   'Deliveries',                   8, false, null),
  ('BILLING',    'Billing documents',           10, false, null),
  ('PRODORDER',  'Production orders',           12, false, null),
  ('PRODCONF',   'Production confirmations',    12, false, null),
  ('PAYRUN',     'Payment runs',                10, false, null),
  ('VENDINV',    'Vendor invoices',             10, false, null),
  ('BUSPARTNR',  'Business partners',           10, false, null)
) as o(object_code, description, number_length, year_relevant, subobject_hint)
on conflict do nothing;
