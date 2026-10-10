CREATE TABLE "payment_terms" (
	"client" varchar(4) NOT NULL,
	"terms_code" varchar(12) NOT NULL,
	"description" varchar(160) NOT NULL,
	"baseline_source" varchar(16) DEFAULT 'DOCUMENT_DATE' NOT NULL,
	"net_days" integer DEFAULT 0 NOT NULL,
	"discount1_days" integer,
	"discount1_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"discount2_days" integer,
	"discount2_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "payment_terms_client_terms_code_pk" PRIMARY KEY("client","terms_code"),
	CONSTRAINT "payment_terms_baseline" CHECK ("payment_terms"."baseline_source" in ('DOCUMENT_DATE','POSTING_DATE','ENTRY_DATE')),
	CONSTRAINT "payment_terms_net_days" CHECK ("payment_terms"."net_days" between 0 and 3650),
	CONSTRAINT "payment_terms_discount1" CHECK (("payment_terms"."discount1_days" is null and "payment_terms"."discount1_percent"=0) or ("payment_terms"."discount1_days" is not null and "payment_terms"."discount1_days" between 0 and "payment_terms"."net_days" and "payment_terms"."discount1_percent">0 and "payment_terms"."discount1_percent"<=100)),
	CONSTRAINT "payment_terms_discount2" CHECK (("payment_terms"."discount2_days" is null and "payment_terms"."discount2_percent"=0) or ("payment_terms"."discount1_days" is not null and "payment_terms"."discount2_days" is not null and "payment_terms"."discount2_days" between "payment_terms"."discount1_days" and "payment_terms"."net_days" and "payment_terms"."discount2_percent">0 and "payment_terms"."discount2_percent"<="payment_terms"."discount1_percent")),
	CONSTRAINT "payment_terms_version" CHECK ("payment_terms"."version">0)
);
--> statement-breakpoint
ALTER TABLE "payment_terms" ADD CONSTRAINT "payment_terms_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;