CREATE TABLE "supplier_company_code" (
	"client" varchar(4) NOT NULL,
	"partner_number" varchar(40) NOT NULL,
	"role_code" varchar(16) DEFAULT 'SUPPLIER' NOT NULL,
	"company_code" varchar(10) NOT NULL,
	"chart_of_accounts" varchar(8) NOT NULL,
	"reconciliation_account" varchar(20),
	"payment_terms_code" varchar(12),
	"company_status" varchar(16) DEFAULT 'INCOMPLETE' NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "supplier_company_code_client_partner_number_company_code_pk" PRIMARY KEY("client","partner_number","company_code"),
	CONSTRAINT "supplier_company_role" CHECK ("supplier_company_code"."role_code"='SUPPLIER'),
	CONSTRAINT "supplier_company_status" CHECK ("supplier_company_code"."company_status" in ('INCOMPLETE','CREATED','MAINTAINED')),
	CONSTRAINT "supplier_company_version" CHECK ("supplier_company_code"."version">0)
);
--> statement-breakpoint
ALTER TABLE "supplier_company_code" ADD CONSTRAINT "supplier_company_code_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_company_code" ADD CONSTRAINT "supplier_company_code_client_partner_number_role_code_bp_role_client_partner_number_role_code_fk" FOREIGN KEY ("client","partner_number","role_code") REFERENCES "public"."bp_role"("client","partner_number","role_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_company_code" ADD CONSTRAINT "supplier_company_code_client_company_code_company_code_client_company_code_fk" FOREIGN KEY ("client","company_code") REFERENCES "public"."company_code"("client","company_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_company_code" ADD CONSTRAINT "supplier_company_code_client_chart_of_accounts_reconciliation_account_gl_account_client_chart_of_accounts_account_number_fk" FOREIGN KEY ("client","chart_of_accounts","reconciliation_account") REFERENCES "public"."gl_account"("client","chart_of_accounts","account_number") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_company_code" ADD CONSTRAINT "supplier_company_code_client_payment_terms_code_payment_terms_client_terms_code_fk" FOREIGN KEY ("client","payment_terms_code") REFERENCES "public"."payment_terms"("client","terms_code") ON DELETE no action ON UPDATE no action;