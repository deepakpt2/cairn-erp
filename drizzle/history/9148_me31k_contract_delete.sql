-- Tenant removal deletes the contract header before its items unless the item
-- foreign key cascades. A call-off reference is set null only when the contract
-- item itself is removed with the tenant. The service does not delete a contract.

alter table public.purchase_contract_item
  drop constraint purchase_contract_item_header_fk;
alter table public.purchase_contract_item
  add constraint purchase_contract_item_header_fk
  foreign key (client, contract_number)
  references public.purchase_contract (client, contract_number)
  on delete cascade;

alter table public.purchase_order_item
  drop constraint purchase_order_item_contract_fk;
alter table public.purchase_order_item
  add constraint purchase_order_item_contract_fk
  foreign key (client, contract_number, contract_item)
  references public.purchase_contract_item (client, contract_number, item_number)
  on delete set null;
