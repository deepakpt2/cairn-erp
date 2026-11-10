-- B-089: global, fixed-field activation evidence. Runtime mutation is disabled in 9018.
CREATE TABLE "partner_bank_profile_activation_audit" (
  "event_id" uuid NOT NULL,
  "actor_client" varchar(4) NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "country_code" char(2) NOT NULL,
  "policy_revision" varchar(12) NOT NULL,
  "previous_status" varchar(12) NOT NULL,
  "new_status" varchar(12) NOT NULL,
  "previous_version" integer NOT NULL,
  "new_version" integer NOT NULL,
  "evidence_code" varchar(32) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "partner_bank_profile_activation_audit_event_pk" PRIMARY KEY ("event_id"),
  CONSTRAINT "partner_bank_profile_activation_audit_event_uuidv4" CHECK (
    substring("event_id"::text from 15 for 1) = '4'
    AND substring("event_id"::text from 20 for 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT "partner_bank_profile_activation_audit_actor_client" CHECK ("actor_client" ~ '^[A-Za-z0-9]{2,4}$'),
  CONSTRAINT "partner_bank_profile_activation_audit_policy_revision" CHECK ("policy_revision" ~ '^D-[0-9]{3}$'),
  CONSTRAINT "partner_bank_profile_activation_audit_transition" CHECK (
    "previous_status" = 'NOT_READY' AND "new_status" = 'READY'
  ),
  CONSTRAINT "partner_bank_profile_activation_audit_version" CHECK (
    "previous_version" > 0 AND "new_version" = "previous_version" + 1
  ),
  CONSTRAINT "partner_bank_profile_activation_audit_evidence" CHECK (
    "evidence_code" = 'PROFILE_VALIDATION_ACCEPTED'
  ),
  CONSTRAINT "partner_bank_profile_activation_audit_country_fk" FOREIGN KEY ("country_code")
    REFERENCES "public"."country"("code") ON DELETE NO ACTION ON UPDATE NO ACTION
);
--> statement-breakpoint
CREATE INDEX "partner_bank_profile_activation_audit_country_time_idx"
  ON "partner_bank_profile_activation_audit" USING btree ("country_code", "created_at");
