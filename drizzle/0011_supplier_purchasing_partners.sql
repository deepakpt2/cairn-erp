-- B-026: tenant-scoped supplier purchasing partner-function rules and directed assignments.
CREATE TABLE "supplier_partner_function" (
  "client" varchar(4) NOT NULL,
  "function_code" varchar(24) NOT NULL,
  "display_name" varchar(80) NOT NULL,
  "allows_multiple" boolean NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_by" varchar(60),
  "changed_at" timestamp with time zone,
  CONSTRAINT "supplier_partner_function_pk" PRIMARY KEY("client","function_code"),
  CONSTRAINT "supplier_partner_function_code" CHECK ("function_code" in ('ORDERING_PARTNER','DELIVERY_PARTNER','INVOICE_SENDER')),
  CONSTRAINT "supplier_partner_function_name" CHECK (length(trim("display_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_partner_function" ADD CONSTRAINT "supplier_partner_function_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "supplier_purchasing_partner" (
  "client" varchar(4) NOT NULL,
  "partner_number" varchar(40) NOT NULL,
  "purchasing_org" varchar(10) NOT NULL,
  "function_code" varchar(24) NOT NULL,
  "assigned_partner_number" varchar(40) NOT NULL,
  "assigned_role_code" varchar(16) DEFAULT 'SUPPLIER' NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_by" varchar(60),
  "changed_at" timestamp with time zone,
  CONSTRAINT "supplier_purchasing_partner_pk" PRIMARY KEY("client","partner_number","purchasing_org","function_code","assigned_partner_number"),
  CONSTRAINT "supplier_purchasing_partner_assigned_role" CHECK ("assigned_role_code"='SUPPLIER'),
  CONSTRAINT "supplier_purchasing_partner_version" CHECK ("version">0)
);
--> statement-breakpoint
ALTER TABLE "supplier_purchasing_partner" ADD CONSTRAINT "supplier_purchasing_partner_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supplier_purchasing_partner" ADD CONSTRAINT "supplier_purchasing_partner_owner_fk" FOREIGN KEY ("client","partner_number","purchasing_org") REFERENCES "public"."supplier_purchasing_org"("client","partner_number","purchasing_org") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supplier_purchasing_partner" ADD CONSTRAINT "supplier_purchasing_partner_function_fk" FOREIGN KEY ("client","function_code") REFERENCES "public"."supplier_partner_function"("client","function_code") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "supplier_purchasing_partner" ADD CONSTRAINT "supplier_purchasing_partner_assigned_supplier_fk" FOREIGN KEY ("client","assigned_partner_number","assigned_role_code") REFERENCES "public"."bp_role"("client","partner_number","role_code") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "supplier_purchasing_partner_assigned_idx" ON "supplier_purchasing_partner" USING btree ("client","assigned_partner_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_purchasing_partner_default_uq" ON "supplier_purchasing_partner" USING btree ("client","partner_number","purchasing_org","function_code") WHERE "is_default";
