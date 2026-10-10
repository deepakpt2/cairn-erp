CREATE TABLE "bp_role" (
	"client" varchar(4) NOT NULL,
	"partner_number" varchar(40) NOT NULL,
	"role_code" varchar(16) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "bp_role_client_partner_number_role_code_pk" PRIMARY KEY("client","partner_number","role_code"),
	CONSTRAINT "bp_role_code" CHECK ("bp_role"."role_code" in ('SUPPLIER','CUSTOMER'))
);
--> statement-breakpoint
CREATE TABLE "business_partner" (
	"client" varchar(4) NOT NULL,
	"partner_number" varchar(40) NOT NULL,
	"category" varchar(16) DEFAULT 'ORGANIZATION' NOT NULL,
	"name" varchar(160) DEFAULT '' NOT NULL,
	"name2" varchar(160),
	"search_term" varchar(40),
	"country" char(2),
	"region" varchar(80),
	"street" varchar(180),
	"city" varchar(100),
	"postal_code" varchar(20),
	"tax_number" varchar(40),
	"email" varchar(254),
	"phone" varchar(40),
	"general_status" varchar(16) DEFAULT 'INCOMPLETE' NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "business_partner_client_partner_number_pk" PRIMARY KEY("client","partner_number"),
	CONSTRAINT "business_partner_category" CHECK ("business_partner"."category" in ('ORGANIZATION','PERSON')),
	CONSTRAINT "business_partner_status" CHECK ("business_partner"."general_status" in ('INCOMPLETE','CREATED','MAINTAINED')),
	CONSTRAINT "business_partner_version" CHECK ("business_partner"."version">0)
);
--> statement-breakpoint
ALTER TABLE "bp_role" ADD CONSTRAINT "bp_role_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bp_role" ADD CONSTRAINT "bp_role_client_partner_number_business_partner_client_partner_number_fk" FOREIGN KEY ("client","partner_number") REFERENCES "public"."business_partner"("client","partner_number") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_partner" ADD CONSTRAINT "business_partner_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_partner" ADD CONSTRAINT "business_partner_country_country_code_fk" FOREIGN KEY ("country") REFERENCES "public"."country"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_partner_search_idx" ON "business_partner" USING btree ("client","search_term");