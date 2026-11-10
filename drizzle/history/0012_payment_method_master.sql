-- B-036: tenant-scoped country-specific Payment Methods definitions (D-058).
CREATE TABLE "payment_method" (
  "client" varchar(4) NOT NULL,
  "country" char(2) NOT NULL,
  "method_code" varchar(2) NOT NULL,
  "description" varchar(160) NOT NULL,
  "allowed_direction" varchar(8) NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_by" varchar(60),
  "changed_at" timestamp with time zone,
  CONSTRAINT "payment_method_client_country_method_code_pk" PRIMARY KEY("client","country","method_code"),
  CONSTRAINT "payment_method_code" CHECK ("method_code" ~ '^[A-Z0-9]{1,2}$'),
  CONSTRAINT "payment_method_description" CHECK (length(trim("description")) > 0),
  CONSTRAINT "payment_method_direction" CHECK ("allowed_direction" in ('OUTGOING','INCOMING','BOTH')),
  CONSTRAINT "payment_method_version" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_client_client_client_fk"
  FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_country_country_code_fk"
  FOREIGN KEY ("country") REFERENCES "public"."country"("code") ON DELETE no action ON UPDATE no action;
