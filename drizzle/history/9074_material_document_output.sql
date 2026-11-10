-- SCR-135 (B-870/§26.882): output determination and dispatch for material
-- documents, in the NAST shape. The document is referenced by its own columns with
-- a real foreign key; no company code is stored (it follows the plants) and no
-- concatenated object key is created, because no database can check one.

create table public.output_type (
  client varchar(4) not null references public.client (client) on delete cascade,
  output_type varchar(4) not null,
  description varchar(60) not null,
  direction varchar(8) not null,
  transmission_medium varchar(8) not null default 'PRINT',
  dispatch_time varchar(10) not null default 'IMMEDIATE',
  is_active boolean not null default true,
  created_by varchar(40) not null,
  created_at timestamp with time zone not null default now(),
  changed_by varchar(40),
  changed_at timestamp with time zone,
  constraint output_type_pk primary key (client, output_type),
  constraint output_type_code_ck check (output_type ~ '^[A-Z0-9]{2,4}$'),
  constraint output_type_direction_ck check (direction in ('RECEIPT', 'ISSUE', 'ANY')),
  constraint output_type_medium_ck check (transmission_medium in ('PRINT', 'EMAIL')),
  constraint output_type_dispatch_ck check (dispatch_time in ('IMMEDIATE', 'PERIODIC'))
);

create table public.output_message (
  client varchar(4) not null references public.client (client) on delete cascade,
  material_document_number varchar(20) not null,
  document_year integer not null,
  output_type varchar(4) not null,
  transmission_medium varchar(8) not null,
  dispatch_time varchar(10) not null,
  status varchar(10) not null default 'PENDING',
  send_count integer not null default 0,
  recipient varchar(50),
  printer_queue varchar(30),
  last_processed_at timestamp with time zone,
  error_text varchar(200),
  created_by varchar(40) not null,
  created_at timestamp with time zone not null default now(),
  changed_by varchar(40),
  changed_at timestamp with time zone,
  constraint output_message_pk primary key (client, material_document_number, output_type, transmission_medium),
  constraint output_message_document_fk foreign key (client, material_document_number)
    references public.material_document (client, material_document_number) on delete cascade,
  constraint output_message_type_fk foreign key (client, output_type)
    references public.output_type (client, output_type) on delete restrict,
  constraint output_message_medium_ck check (transmission_medium in ('PRINT', 'EMAIL')),
  constraint output_message_dispatch_ck check (dispatch_time in ('IMMEDIATE', 'PERIODIC')),
  constraint output_message_status_ck check (status in ('PENDING', 'PROCESSED', 'ERROR')),
  constraint output_message_send_count_ck check (send_count >= 0),
  constraint output_message_error_ck check (status <> 'ERROR' or error_text is not null),
  constraint output_message_recipient_ck check (recipient is null or length(btrim(recipient)) > 0)
);
