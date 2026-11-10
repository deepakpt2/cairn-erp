CREATE TABLE "customer_sales_area" (
	"client" varchar(4) NOT NULL,
	"partner_number" varchar(40) NOT NULL,
	"role_code" varchar(16) DEFAULT 'CUSTOMER' NOT NULL,
	"sales_org" varchar(10) NOT NULL,
	"distribution_channel" varchar(4) NOT NULL,
	"division" varchar(4) NOT NULL,
	"sales_district" varchar(6),
	"delivering_plant" varchar(10),
	"pricing_procedure" varchar(6),
	"complete_delivery" boolean DEFAULT false NOT NULL,
	"order_combination" boolean DEFAULT false NOT NULL,
	"sales_status" varchar(16) DEFAULT 'INCOMPLETE' NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "customer_sales_area_client_partner_number_sales_org_distribution_channel_division_pk" PRIMARY KEY("client","partner_number","sales_org","distribution_channel","division"),
	CONSTRAINT "customer_sales_role" CHECK ("customer_sales_area"."role_code"='CUSTOMER'),
	CONSTRAINT "customer_sales_status" CHECK ("customer_sales_area"."sales_status" in ('INCOMPLETE','CREATED','MAINTAINED')),
	CONSTRAINT "customer_sales_version" CHECK ("customer_sales_area"."version">0),
	CONSTRAINT "customer_sales_district" CHECK ("customer_sales_area"."sales_district" is null or "customer_sales_area"."sales_district" ~ '^[A-Z0-9]{1,6}$'),
	CONSTRAINT "customer_sales_pricing_procedure" CHECK ("customer_sales_area"."pricing_procedure" is null or "customer_sales_area"."pricing_procedure" ~ '^[A-Z0-9]{1,6}$')
);
--> statement-breakpoint
ALTER TABLE "customer_sales_area" ADD CONSTRAINT "customer_sales_area_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sales_area" ADD CONSTRAINT "customer_sales_area_client_partner_number_role_code_bp_role_client_partner_number_role_code_fk" FOREIGN KEY ("client","partner_number","role_code") REFERENCES "public"."bp_role"("client","partner_number","role_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sales_area" ADD CONSTRAINT "customer_sales_area_client_sales_org_distribution_channel_division_sales_area_client_sales_org_distribution_channel_division_fk" FOREIGN KEY ("client","sales_org","distribution_channel","division") REFERENCES "public"."sales_area"("client","sales_org","distribution_channel","division") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sales_area" ADD CONSTRAINT "customer_sales_area_client_delivering_plant_plant_client_plant_fk" FOREIGN KEY ("client","delivering_plant") REFERENCES "public"."plant"("client","plant") ON DELETE no action ON UPDATE no action;