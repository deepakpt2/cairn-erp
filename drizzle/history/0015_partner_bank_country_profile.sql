-- B-084: global profile-readiness registry; no tenant bank data or write path.
CREATE TABLE "partner_bank_country_profile" (
  "country_code" char(2) NOT NULL,
  "policy_revision" varchar(12) NOT NULL,
  "readiness_status" varchar(12) DEFAULT 'NOT_READY' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "changed_by" varchar(60),
  "changed_at" timestamp with time zone,
  CONSTRAINT "partner_bank_country_profile_country_code_pk" PRIMARY KEY("country_code"),
  CONSTRAINT "partner_bank_country_profile_policy_revision" CHECK ("policy_revision" ~ '^D-[0-9]{3}$'),
  CONSTRAINT "partner_bank_country_profile_status" CHECK ("readiness_status" IN ('NOT_READY', 'READY')),
  CONSTRAINT "partner_bank_country_profile_version" CHECK ("version" > 0),
  CONSTRAINT "partner_bank_country_profile_country_fk" FOREIGN KEY ("country_code")
    REFERENCES "public"."country"("code") ON DELETE NO ACTION ON UPDATE NO ACTION
);
