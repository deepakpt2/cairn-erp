CREATE TABLE "supplier_purchasing_org" (
	"client" varchar(4) NOT NULL,
	"partner_number" varchar(40) NOT NULL,
	"role_code" varchar(16) DEFAULT 'SUPPLIER' NOT NULL,
	"purchasing_org" varchar(10) NOT NULL,
	"order_currency" char(3),
	"purchasing_group" varchar(6),
	"incoterms_code" varchar(3),
	"incoterms_location" varchar(160),
	"payment_terms_code" varchar(12),
	"purchasing_status" varchar(16) DEFAULT 'INCOMPLETE' NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "supplier_purchasing_org_client_partner_number_purchasing_org_pk" PRIMARY KEY("client","partner_number","purchasing_org"),
	CONSTRAINT "supplier_purchasing_role" CHECK ("supplier_purchasing_org"."role_code"='SUPPLIER'),
	CONSTRAINT "supplier_purchasing_status" CHECK ("supplier_purchasing_org"."purchasing_status" in ('INCOMPLETE','CREATED','MAINTAINED')),
	CONSTRAINT "supplier_purchasing_version" CHECK ("supplier_purchasing_org"."version">0),
	CONSTRAINT "supplier_purchasing_delivery_term" CHECK ("supplier_purchasing_org"."incoterms_code" is null or "supplier_purchasing_org"."incoterms_code" in ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP'))
);
--> statement-breakpoint
ALTER TABLE "supplier_purchasing_org" ADD CONSTRAINT "supplier_purchasing_org_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchasing_org" ADD CONSTRAINT "supplier_purchasing_org_order_currency_currency_code_fk" FOREIGN KEY ("order_currency") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchasing_org" ADD CONSTRAINT "supplier_purchasing_org_client_partner_number_role_code_bp_role_client_partner_number_role_code_fk" FOREIGN KEY ("client","partner_number","role_code") REFERENCES "public"."bp_role"("client","partner_number","role_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchasing_org" ADD CONSTRAINT "supplier_purchasing_org_client_purchasing_org_purchasing_org_client_purchasing_org_fk" FOREIGN KEY ("client","purchasing_org") REFERENCES "public"."purchasing_org"("client","purchasing_org") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchasing_org" ADD CONSTRAINT "supplier_purchasing_org_client_purchasing_group_purchasing_group_client_purchasing_group_fk" FOREIGN KEY ("client","purchasing_group") REFERENCES "public"."purchasing_group"("client","purchasing_group") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_purchasing_org" ADD CONSTRAINT "supplier_purchasing_org_client_payment_terms_code_payment_terms_client_terms_code_fk" FOREIGN KEY ("client","payment_terms_code") REFERENCES "public"."payment_terms"("client","terms_code") ON DELETE no action ON UPDATE no action;