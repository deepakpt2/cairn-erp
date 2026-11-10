-- B-072: partner-wide bank-record schema; account identifiers are envelopes only.
CREATE TABLE "partner_bank" (
  "client" varchar(4) NOT NULL,
  "partner_number" varchar(40) NOT NULL,
  "bank_record_id" uuid NOT NULL,
  "account_holder" varchar(160) NOT NULL,
  "country" char(2) NOT NULL,
  "bank_name" varchar(160),
  "bank_code" varchar(20),
  "iban_ciphertext" varchar(5600),
  "local_account_number_ciphertext" varchar(5600),
  "bic" varchar(11),
  "valid_from" date NOT NULL,
  "valid_to" date,
  "is_active" boolean DEFAULT true NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_by" varchar(60),
  "changed_at" timestamp with time zone,
  CONSTRAINT "partner_bank_client_bank_record_id_pk" PRIMARY KEY("client", "bank_record_id"),
  CONSTRAINT "partner_bank_uuidv4" CHECK (
    substring("bank_record_id"::text from 15 for 1) = '4'
    AND substring("bank_record_id"::text from 20 for 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT "partner_bank_account_holder" CHECK (length(trim("account_holder")) > 0),
  CONSTRAINT "partner_bank_one_account_identifier" CHECK (
    ("iban_ciphertext" IS NOT NULL AND "local_account_number_ciphertext" IS NULL)
    OR ("iban_ciphertext" IS NULL AND "local_account_number_ciphertext" IS NOT NULL)
  ),
  CONSTRAINT "partner_bank_iban_envelope" CHECK (
    "iban_ciphertext" IS NULL OR "iban_ciphertext" ~ '^cbd1[.][A-Za-z0-9_-]{1,32}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{1,5462}[.][A-Za-z0-9_-]{22}$'
  ),
  CONSTRAINT "partner_bank_local_account_envelope" CHECK (
    "local_account_number_ciphertext" IS NULL OR "local_account_number_ciphertext" ~ '^cbd1[.][A-Za-z0-9_-]{1,32}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{1,5462}[.][A-Za-z0-9_-]{22}$'
  ),
  CONSTRAINT "partner_bank_validity" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  CONSTRAINT "partner_bank_version" CHECK ("version" > 0),
  CONSTRAINT "partner_bank_client_fk" FOREIGN KEY ("client")
    REFERENCES "public"."client"("client") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "partner_bank_partner_fk" FOREIGN KEY ("client", "partner_number")
    REFERENCES "public"."business_partner"("client", "partner_number") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "partner_bank_country_fk" FOREIGN KEY ("country")
    REFERENCES "public"."country"("code") ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX "partner_bank_partner_valid_from_idx"
  ON "partner_bank" USING btree ("client", "partner_number", "valid_from");

-- Close the grant window before the later 9000 migration grants app privileges.
-- With no policy yet, RLS default-denies access until 9016 installs scoped SELECT.
ALTER TABLE partner_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_bank FORCE ROW LEVEL SECURITY;
