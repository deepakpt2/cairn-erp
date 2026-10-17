-- SCR-042 / R-91 (stage 2): the cost centre hierarchy and alternative groups.
--
-- Two structures, as the reference carries both (parity, R-91): the
-- standard hierarchy — one tree per controlling area into which cost
-- centre periods are placed, a period in at most one node of its area
-- (the unique index on the assignment IS the one-parent rule) — and
-- alternative groups whose leaves are single centres or ranges with
-- inclusion/exclusion signs, resolved dynamically at read time.
-- Storage keeps the design's own table map (§10); group-in-group
-- subsets are not built. Parent links cannot cycle by construction
-- here — acyclicity and the ten-level guard read sibling rows, so the
-- service judges them; formats and key rules are declared here.
create table public.cost_center_hierarchy (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  title varchar(40) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, controlling_area),
  constraint cost_center_hierarchy_area_format_ck check (controlling_area ~ '^[A-Z0-9]{4}$'),
  constraint cost_center_hierarchy_title_not_blank_ck check (length(btrim(title)) > 0),
  constraint cost_center_hierarchy_area_fk foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area)
);
--> statement-breakpoint
create table public.cost_center_node (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  node varchar(24) not null,
  parent_node varchar(24),
  title varchar(40) not null,
  display_order integer not null default 0,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, controlling_area, node),
  constraint cost_center_node_key_format_ck check (node ~ '^[A-Z0-9]{1,24}$'),
  constraint cost_center_node_parent_format_ck check (parent_node is null or parent_node ~ '^[A-Z0-9]{1,24}$'),
  constraint cost_center_node_title_not_blank_ck check (length(btrim(title)) > 0),
  constraint cost_center_node_hierarchy_fk foreign key (client, controlling_area)
    references public.cost_center_hierarchy (client, controlling_area),
  constraint cost_center_node_parent_fk foreign key (client, controlling_area, parent_node)
    references public.cost_center_node (client, controlling_area, node)
);
--> statement-breakpoint
create table public.cost_center_node_assignment (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  node varchar(24) not null,
  cost_center varchar(10) not null,
  valid_from date not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, controlling_area, node, cost_center, valid_from),
  constraint cost_center_node_assignment_node_fk foreign key (client, controlling_area, node)
    references public.cost_center_node (client, controlling_area, node),
  constraint cost_center_node_assignment_period_fk foreign key (client, controlling_area, cost_center, valid_from)
    references public.cost_center (client, controlling_area, cost_center, valid_from)
);
--> statement-breakpoint
create unique index cost_center_node_assignment_period_unique_idx
  on public.cost_center_node_assignment (client, controlling_area, cost_center, valid_from);
--> statement-breakpoint
create table public.cost_center_group (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  group_name varchar(24) not null,
  title varchar(40) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, controlling_area, group_name),
  constraint cost_center_group_name_format_ck check (group_name ~ '^[A-Z0-9]{1,24}$'),
  constraint cost_center_group_title_not_blank_ck check (length(btrim(title)) > 0),
  constraint cost_center_group_area_fk foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area)
);
--> statement-breakpoint
create table public.cost_center_group_leaf (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  group_name varchar(24) not null,
  val_sign char(1) not null default 'I',
  val_option varchar(2) not null default 'EQ',
  val_from varchar(10) not null,
  val_to varchar(10) not null default '',
  display_order integer not null default 0,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, controlling_area, group_name, val_sign, val_option, val_from, val_to),
  constraint cost_center_group_leaf_sign_ck check (val_sign in ('I','E')),
  constraint cost_center_group_leaf_option_ck check (val_option in ('EQ','BT')),
  constraint cost_center_group_leaf_from_format_ck check (val_from ~ '^[A-Z0-9]{1,10}$'),
  constraint cost_center_group_leaf_range_ck check (
    (val_option = 'EQ' and val_to = '') or (val_option = 'BT' and val_to ~ '^[A-Z0-9]{1,10}$' and val_to >= val_from)
  ),
  constraint cost_center_group_leaf_group_fk foreign key (client, controlling_area, group_name)
    references public.cost_center_group (client, controlling_area, group_name)
);
--> statement-breakpoint
