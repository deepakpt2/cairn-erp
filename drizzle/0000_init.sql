CREATE TABLE "client" (
	"client" varchar(4) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"legal_name" varchar(200),
	"country" char(2) DEFAULT 'KW' NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"language" char(2) DEFAULT 'EN' NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"status" varchar(16) DEFAULT 'DRAFT' NOT NULL,
	"is_development" boolean DEFAULT false NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"notes" text,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "client_settings" (
	"client" varchar(4) PRIMARY KEY NOT NULL,
	"number_display_format" varchar(24) DEFAULT 'READABLE' NOT NULL,
	"show_reference_aliases" boolean DEFAULT true NOT NULL,
	"date_format" varchar(20) DEFAULT 'YYYY-MM-DD' NOT NULL,
	"decimal_separator" char(1) DEFAULT '.' NOT NULL,
	"thousands_separator" char(1) DEFAULT ',' NOT NULL,
	"fiscal_year_variant" varchar(4),
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"username" varchar(40) NOT NULL,
	"full_name" varchar(120) NOT NULL,
	"email" varchar(200),
	"password_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" varchar(8) DEFAULT '0' NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_access_log" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"user_id" varchar(36),
	"username" varchar(40),
	"event_type" varchar(32) NOT NULL,
	"transaction_code" varchar(64),
	"object_type" varchar(64),
	"object_key" varchar(120),
	"detail" text,
	"ip_address" varchar(64),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_org_restriction" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"scope_type" varchar(32) NOT NULL,
	"scope_value" varchar(40) NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "capability" (
	"code" varchar(64) PRIMARY KEY NOT NULL,
	"module" varchar(16) NOT NULL,
	"description" text,
	"action" varchar(24) NOT NULL,
	"is_posting_relevant" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"client" varchar(4) NOT NULL,
	"code" varchar(40) NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" text,
	"is_system_role" boolean DEFAULT false NOT NULL,
	"is_read_only" boolean DEFAULT false NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "role_client_code_pk" PRIMARY KEY("client","code")
);
--> statement-breakpoint
CREATE TABLE "role_capability" (
	"client" varchar(4) NOT NULL,
	"role_code" varchar(40) NOT NULL,
	"capability_code" varchar(64) NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "role_capability_client_role_code_capability_code_pk" PRIMARY KEY("client","role_code","capability_code")
);
--> statement-breakpoint
CREATE TABLE "sod_rule" (
	"client" varchar(4) NOT NULL,
	"code" varchar(40) NOT NULL,
	"description" text NOT NULL,
	"capability_a" varchar(64) NOT NULL,
	"capability_b" varchar(64) NOT NULL,
	"severity" varchar(16) DEFAULT 'HIGH' NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "sod_rule_client_code_pk" PRIMARY KEY("client","code")
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"client" varchar(4) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"role_code" varchar(40) NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "user_role_client_user_id_role_code_pk" PRIMARY KEY("client","user_id","role_code")
);
--> statement-breakpoint
CREATE TABLE "user_session" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip_address" varchar(64),
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "number_range" (
	"client" varchar(4) NOT NULL,
	"object_code" varchar(40) NOT NULL,
	"sub_object" varchar(24) DEFAULT '*' NOT NULL,
	"fiscal_year" integer DEFAULT 0 NOT NULL,
	"prefix" varchar(12) DEFAULT '' NOT NULL,
	"from_number" bigint NOT NULL,
	"to_number" bigint NOT NULL,
	"current_number" bigint NOT NULL,
	"number_length" integer DEFAULT 6 NOT NULL,
	"display_style" varchar(16) DEFAULT 'READABLE' NOT NULL,
	"is_buffered" boolean DEFAULT false NOT NULL,
	"buffer_size" integer DEFAULT 0 NOT NULL,
	"is_external" boolean DEFAULT false NOT NULL,
	"status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "number_range_client_object_code_sub_object_fiscal_year_pk" PRIMARY KEY("client","object_code","sub_object","fiscal_year")
);
--> statement-breakpoint
CREATE TABLE "number_range_allocation" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"object_code" varchar(40) NOT NULL,
	"sub_object" varchar(24) NOT NULL,
	"fiscal_year" integer DEFAULT 0 NOT NULL,
	"allocated_number" bigint NOT NULL,
	"displayed_number" varchar(40) NOT NULL,
	"document_id" varchar(80),
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocated_by" varchar(60) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lock_object" (
	"code" varchar(40) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"table_names" text DEFAULT '' NOT NULL,
	"default_mode" varchar(16) DEFAULT 'EXCLUSIVE' NOT NULL,
	"wait_timeout_ms" integer DEFAULT 10000 NOT NULL,
	"is_configured" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lock_wait_log" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"lock_object_code" varchar(40) NOT NULL,
	"lock_key" varchar(200) NOT NULL,
	"outcome" varchar(24) NOT NULL,
	"waited_ms" integer NOT NULL,
	"requested_by" varchar(60) NOT NULL,
	"transaction_code" varchar(64),
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_document" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"object_class" varchar(64) NOT NULL,
	"object_key" varchar(120) NOT NULL,
	"change_type" varchar(24) NOT NULL,
	"transaction_code" varchar(64),
	"reason" text,
	"changed_by" varchar(60) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_from" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "change_document_item" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"change_document_id" varchar(36) NOT NULL,
	"client" varchar(4) NOT NULL,
	"field_name" varchar(120) NOT NULL,
	"field_label" varchar(200),
	"old_value" text,
	"new_value" text,
	"is_security_relevant" varchar(8) DEFAULT 'false' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_flow_link" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"predecessor_class" varchar(48) NOT NULL,
	"predecessor_key" varchar(120) NOT NULL,
	"successor_class" varchar(48) NOT NULL,
	"successor_key" varchar(120) NOT NULL,
	"relation_type" varchar(40) DEFAULT 'FOLLOWS' NOT NULL,
	"link_quantity" numeric(23, 3),
	"link_value" numeric(23, 4),
	"link_currency" char(3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(60) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_index" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"document_class" varchar(48) NOT NULL,
	"document_key" varchar(120) NOT NULL,
	"display_number" varchar(40) NOT NULL,
	"document_type" varchar(24),
	"company_code" varchar(10),
	"posting_date" timestamp with time zone,
	"status" varchar(24) DEFAULT 'POSTED' NOT NULL,
	"summary" text,
	"search_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_status_history" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"document_class" varchar(48) NOT NULL,
	"document_key" varchar(120) NOT NULL,
	"previous_status" varchar(32),
	"new_status" varchar(32) NOT NULL,
	"reason" text,
	"changed_by" varchar(60) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_activity" (
	"code" varchar(80) NOT NULL,
	"area" varchar(64) NOT NULL,
	"sub_area" varchar(64),
	"title" varchar(200) NOT NULL,
	"description" text,
	"activity_kind" varchar(12) NOT NULL,
	"prerequisites" text DEFAULT '' NOT NULL,
	"enables" text,
	"sequence" integer DEFAULT 100 NOT NULL,
	"wizard_stage" varchar(24) DEFAULT 'STANDARD' NOT NULL,
	"route_path" varchar(200),
	"is_config_only" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "config_activity_code_pk" PRIMARY KEY("code")
);
--> statement-breakpoint
CREATE TABLE "config_activity_status" (
	"client" varchar(4) NOT NULL,
	"activity_code" varchar(80) NOT NULL,
	"status" varchar(20) DEFAULT 'NOT_STARTED' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" varchar(60),
	"note" text,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "config_activity_status_client_activity_code_pk" PRIMARY KEY("client","activity_code")
);
--> statement-breakpoint
CREATE TABLE "term_alias" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"term_id" varchar(36) NOT NULL,
	"external_system" varchar(32) DEFAULT 'REFERENCE_ERP' NOT NULL,
	"alias" varchar(80) NOT NULL,
	"usage" varchar(20) DEFAULT 'SEARCH_ONLY' NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "term_registry" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"our_code" varchar(64),
	"our_table" varchar(80),
	"title" varchar(200) NOT NULL,
	"term_type" varchar(24) NOT NULL,
	"module" varchar(16) NOT NULL,
	"description" text,
	"coverage_tier" varchar(24) DEFAULT 'TIER_1_BUILT' NOT NULL,
	"route_path" varchar(200),
	"conformance_tier" varchar(2),
	"deferral_note" text,
	"is_searchable" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_definition" (
	"code" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text,
	"queue" varchar(40) DEFAULT 'DEFAULT' NOT NULL,
	"module" varchar(16) NOT NULL,
	"schedule" varchar(80),
	"is_scheduled" boolean DEFAULT false NOT NULL,
	"max_retries" integer DEFAULT 0 NOT NULL,
	"timeout_seconds" integer DEFAULT 600 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_log" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"job_run_id" varchar(36) NOT NULL,
	"client" varchar(4) NOT NULL,
	"level" varchar(12) DEFAULT 'INFO' NOT NULL,
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client" varchar(4) NOT NULL,
	"job_code" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'QUEUED' NOT NULL,
	"trigger_type" varchar(16) DEFAULT 'MANUAL' NOT NULL,
	"triggered_by" varchar(60) NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"progress_text" varchar(200),
	"result_summary" text,
	"error_text" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mail_server_config" (
	"client" varchar(4) PRIMARY KEY NOT NULL,
	"host" varchar(200),
	"port" integer DEFAULT 587 NOT NULL,
	"encryption" varchar(16) DEFAULT 'STARTTLS' NOT NULL,
	"username" varchar(200),
	"password_encrypted" text,
	"sender_address" varchar(200),
	"sender_name" varchar(120),
	"is_enabled" boolean DEFAULT false NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_result" text,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_catalog" (
	"code" varchar(80) PRIMARY KEY NOT NULL,
	"severity" varchar(16) NOT NULL,
	"message_class" varchar(40) NOT NULL,
	"text_en" text NOT NULL,
	"i18n_key" varchar(120) NOT NULL,
	"long_text" text,
	"remedy" text,
	"is_user_facing" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "country" (
	"code" char(2) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"default_currency" char(3) NOT NULL,
	"is_tax_relevant" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currency" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"decimal_places" integer DEFAULT 2 NOT NULL,
	"symbol" varchar(8),
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_of_measure" (
	"code" varchar(6) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"dimension" varchar(16) DEFAULT 'COUNT' NOT NULL,
	"decimal_places" integer DEFAULT 3 NOT NULL,
	"is_base_unit" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_account" (
	"client" varchar(4) NOT NULL,
	"chart_of_accounts" varchar(8) NOT NULL,
	"account_number" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"account_type" varchar(16) NOT NULL,
	"is_balance_sheet" boolean NOT NULL,
	"is_open_item_managed" boolean DEFAULT false NOT NULL,
	"reconciliation_type" varchar(16),
	"requires_cost_object" boolean DEFAULT false NOT NULL,
	"is_tax_relevant" boolean DEFAULT false NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "gl_account_client_chart_of_accounts_account_number_pk" PRIMARY KEY("client","chart_of_accounts","account_number")
);
--> statement-breakpoint
CREATE TABLE "journal_entry" (
	"client" varchar(4) NOT NULL,
	"document_number" varchar(40) NOT NULL,
	"fiscal_year" integer NOT NULL,
	"document_type" varchar(12) NOT NULL,
	"company_code" varchar(10) NOT NULL,
	"document_date" date NOT NULL,
	"posting_date" date NOT NULL,
	"posting_period" integer NOT NULL,
	"document_currency" char(3) NOT NULL,
	"local_currency" char(3) NOT NULL,
	"exchange_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"reference" varchar(60),
	"header_text" text,
	"status" varchar(16) DEFAULT 'POSTED' NOT NULL,
	"reversal_of" varchar(40),
	"reversed_by" varchar(40),
	"reversal_reason" text,
	"origin_class" varchar(48),
	"origin_key" varchar(120),
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "journal_entry_client_document_number_fiscal_year_pk" PRIMARY KEY("client","document_number","fiscal_year")
);
--> statement-breakpoint
CREATE TABLE "journal_entry_line" (
	"client" varchar(4) NOT NULL,
	"document_number" varchar(40) NOT NULL,
	"fiscal_year" integer NOT NULL,
	"line_number" integer NOT NULL,
	"gl_account" varchar(20) NOT NULL,
	"company_code" varchar(10) NOT NULL,
	"debit_credit" char(1) NOT NULL,
	"amount_local" numeric(23, 4) NOT NULL,
	"amount_document" numeric(23, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"cost_center" varchar(20),
	"profit_center" varchar(20),
	"internal_order" varchar(20),
	"production_order" varchar(24),
	"business_partner" varchar(20),
	"material" varchar(40),
	"plant" varchar(10),
	"tax_code" varchar(4),
	"line_text" text,
	"clearing_document" varchar(40),
	"clearing_date" date,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entry_line_client_document_number_fiscal_year_line_number_pk" PRIMARY KEY("client","document_number","fiscal_year","line_number")
);
--> statement-breakpoint
CREATE TABLE "chart_of_accounts" (
	"client" varchar(4) NOT NULL,
	"chart_of_accounts" varchar(8) NOT NULL,
	"name" varchar(120) NOT NULL,
	"language" char(2) DEFAULT 'EN' NOT NULL,
	"account_number_length" integer DEFAULT 6 NOT NULL,
	"group_chart" varchar(8),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "chart_of_accounts_client_chart_of_accounts_pk" PRIMARY KEY("client","chart_of_accounts")
);
--> statement-breakpoint
CREATE TABLE "company_code" (
	"client" varchar(4) NOT NULL,
	"company_code" varchar(10) NOT NULL,
	"name" varchar(160) NOT NULL,
	"chart_of_accounts" varchar(8) NOT NULL,
	"fiscal_year_variant" varchar(4) NOT NULL,
	"posting_period_variant" varchar(4) NOT NULL,
	"currency" char(3) NOT NULL,
	"country" char(2) NOT NULL,
	"city" varchar(80),
	"address" text,
	"language" char(2) DEFAULT 'EN' NOT NULL,
	"tax_registration_number" varchar(40),
	"credit_control_area" varchar(4),
	"intercompany_clearing_account" varchar(20),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "company_code_client_company_code_pk" PRIMARY KEY("client","company_code")
);
--> statement-breakpoint
CREATE TABLE "controlling_area" (
	"client" varchar(4) NOT NULL,
	"controlling_area" varchar(4) NOT NULL,
	"name" varchar(160) NOT NULL,
	"currency" char(3) NOT NULL,
	"fiscal_year_variant" varchar(4) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "controlling_area_client_controlling_area_pk" PRIMARY KEY("client","controlling_area")
);
--> statement-breakpoint
CREATE TABLE "controlling_area_company" (
	"client" varchar(4) NOT NULL,
	"controlling_area" varchar(4) NOT NULL,
	"company_code" varchar(10) NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "controlling_area_company_client_controlling_area_company_code_pk" PRIMARY KEY("client","controlling_area","company_code")
);
--> statement-breakpoint
CREATE TABLE "credit_control_area" (
	"client" varchar(4) NOT NULL,
	"credit_control_area" varchar(4) NOT NULL,
	"name" varchar(160) NOT NULL,
	"currency" char(3) NOT NULL,
	"warning_threshold_percent" integer DEFAULT 90 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "credit_control_area_client_credit_control_area_pk" PRIMARY KEY("client","credit_control_area")
);
--> statement-breakpoint
CREATE TABLE "distribution_channel" (
	"client" varchar(4) NOT NULL,
	"distribution_channel" varchar(4) NOT NULL,
	"name" varchar(120) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "distribution_channel_client_distribution_channel_pk" PRIMARY KEY("client","distribution_channel")
);
--> statement-breakpoint
CREATE TABLE "division" (
	"client" varchar(4) NOT NULL,
	"division" varchar(4) NOT NULL,
	"name" varchar(120) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "division_client_division_pk" PRIMARY KEY("client","division")
);
--> statement-breakpoint
CREATE TABLE "document_type" (
	"client" varchar(4) NOT NULL,
	"document_type" varchar(12) NOT NULL,
	"name" varchar(120) NOT NULL,
	"number_range_object" varchar(40) NOT NULL,
	"number_range_sub_object" varchar(24) DEFAULT '*' NOT NULL,
	"allowed_account_types" varchar(8) DEFAULT 'S' NOT NULL,
	"reversal_mode" varchar(24) DEFAULT 'REVERSE_AND_ALT_DATE' NOT NULL,
	"reversal_document_type" varchar(12),
	"requires_reference" boolean DEFAULT false NOT NULL,
	"requires_line_text" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "document_type_client_document_type_pk" PRIMARY KEY("client","document_type")
);
--> statement-breakpoint
CREATE TABLE "exchange_rate" (
	"client" varchar(4) NOT NULL,
	"rate_type" varchar(12) DEFAULT 'AVERAGE' NOT NULL,
	"from_currency" char(3) NOT NULL,
	"to_currency" char(3) NOT NULL,
	"valid_from" date NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"is_indirect_quote" boolean DEFAULT false NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "exchange_rate_client_rate_type_from_currency_to_currency_valid_from_pk" PRIMARY KEY("client","rate_type","from_currency","to_currency","valid_from")
);
--> statement-breakpoint
CREATE TABLE "fiscal_year_period" (
	"client" varchar(4) NOT NULL,
	"variant" varchar(4) NOT NULL,
	"period" integer NOT NULL,
	"period_type" varchar(10) NOT NULL,
	"start_month" integer NOT NULL,
	"start_day" integer DEFAULT 1 NOT NULL,
	"end_month" integer NOT NULL,
	"end_day" integer DEFAULT 31 NOT NULL,
	"name" varchar(60),
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "fiscal_year_period_client_variant_period_pk" PRIMARY KEY("client","variant","period")
);
--> statement-breakpoint
CREATE TABLE "fiscal_year_variant" (
	"client" varchar(4) NOT NULL,
	"variant" varchar(4) NOT NULL,
	"name" varchar(120) NOT NULL,
	"regular_periods" integer DEFAULT 12 NOT NULL,
	"special_periods" integer DEFAULT 4 NOT NULL,
	"is_calendar_year" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "fiscal_year_variant_client_variant_pk" PRIMARY KEY("client","variant")
);
--> statement-breakpoint
CREATE TABLE "plant" (
	"client" varchar(4) NOT NULL,
	"plant" varchar(10) NOT NULL,
	"name" varchar(160) NOT NULL,
	"company_code" varchar(10) NOT NULL,
	"country" char(2) NOT NULL,
	"city" varchar(80),
	"address" text,
	"is_production_site" boolean DEFAULT true NOT NULL,
	"is_storage_site" boolean DEFAULT true NOT NULL,
	"default_storage_location" varchar(10),
	"language" char(2) DEFAULT 'EN' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "plant_client_plant_pk" PRIMARY KEY("client","plant")
);
--> statement-breakpoint
CREATE TABLE "posting_period_rule" (
	"client" varchar(4) NOT NULL,
	"variant" varchar(4) NOT NULL,
	"account_type" char(1) NOT NULL,
	"period_from" integer NOT NULL,
	"period_to" integer NOT NULL,
	"year_shift_past" integer DEFAULT 0 NOT NULL,
	"year_shift_future" integer DEFAULT 0 NOT NULL,
	"allow_special_periods" boolean DEFAULT false NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "posting_period_rule_client_variant_account_type_pk" PRIMARY KEY("client","variant","account_type")
);
--> statement-breakpoint
CREATE TABLE "posting_period_variant" (
	"client" varchar(4) NOT NULL,
	"variant" varchar(4) NOT NULL,
	"name" varchar(120) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "posting_period_variant_client_variant_pk" PRIMARY KEY("client","variant")
);
--> statement-breakpoint
CREATE TABLE "purchasing_group" (
	"client" varchar(4) NOT NULL,
	"purchasing_group" varchar(6) NOT NULL,
	"name" varchar(120) NOT NULL,
	"purchasing_org" varchar(10),
	"responsible_buyer" varchar(80),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "purchasing_group_client_purchasing_group_pk" PRIMARY KEY("client","purchasing_group")
);
--> statement-breakpoint
CREATE TABLE "purchasing_org" (
	"client" varchar(4) NOT NULL,
	"purchasing_org" varchar(10) NOT NULL,
	"name" varchar(160) NOT NULL,
	"company_code" varchar(10) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "purchasing_org_client_purchasing_org_pk" PRIMARY KEY("client","purchasing_org")
);
--> statement-breakpoint
CREATE TABLE "purchasing_org_plant" (
	"client" varchar(4) NOT NULL,
	"purchasing_org" varchar(10) NOT NULL,
	"plant" varchar(10) NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "purchasing_org_plant_client_purchasing_org_plant_pk" PRIMARY KEY("client","purchasing_org","plant")
);
--> statement-breakpoint
CREATE TABLE "sales_area" (
	"client" varchar(4) NOT NULL,
	"sales_org" varchar(10) NOT NULL,
	"distribution_channel" varchar(4) NOT NULL,
	"division" varchar(4) NOT NULL,
	"name" varchar(160) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "sales_area_client_sales_org_distribution_channel_division_pk" PRIMARY KEY("client","sales_org","distribution_channel","division")
);
--> statement-breakpoint
CREATE TABLE "sales_org" (
	"client" varchar(4) NOT NULL,
	"sales_org" varchar(10) NOT NULL,
	"name" varchar(160) NOT NULL,
	"company_code" varchar(10) NOT NULL,
	"currency" char(3) NOT NULL,
	"country" char(2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "sales_org_client_sales_org_pk" PRIMARY KEY("client","sales_org")
);
--> statement-breakpoint
CREATE TABLE "storage_location" (
	"client" varchar(4) NOT NULL,
	"plant" varchar(10) NOT NULL,
	"storage_location" varchar(10) NOT NULL,
	"name" varchar(120) NOT NULL,
	"allow_negative_stock" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(60) DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" varchar(60),
	"changed_at" timestamp with time zone,
	CONSTRAINT "storage_location_client_plant_storage_location_pk" PRIMARY KEY("client","plant","storage_location")
);
--> statement-breakpoint
ALTER TABLE "client_settings" ADD CONSTRAINT "client_settings_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_org_restriction" ADD CONSTRAINT "auth_org_restriction_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_document_item" ADD CONSTRAINT "change_document_item_change_document_id_change_document_id_fk" FOREIGN KEY ("change_document_id") REFERENCES "public"."change_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_activity_status" ADD CONSTRAINT "config_activity_status_activity_code_config_activity_code_fk" FOREIGN KEY ("activity_code") REFERENCES "public"."config_activity"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "term_alias" ADD CONSTRAINT "term_alias_term_id_term_registry_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."term_registry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_log" ADD CONSTRAINT "job_log_job_run_id_job_run_id_fk" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_job_code_job_definition_code_fk" FOREIGN KEY ("job_code") REFERENCES "public"."job_definition"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_settings_client_idx" ON "client_settings" USING btree ("client");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_client_username_uq" ON "app_user" USING btree ("client","username");--> statement-breakpoint
CREATE INDEX "app_user_client_idx" ON "app_user" USING btree ("client");--> statement-breakpoint
CREATE INDEX "audit_access_log_client_time_idx" ON "audit_access_log" USING btree ("client","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_access_log_user_idx" ON "audit_access_log" USING btree ("client","user_id");--> statement-breakpoint
CREATE INDEX "auth_org_restriction_user_idx" ON "auth_org_restriction" USING btree ("client","user_id");--> statement-breakpoint
CREATE INDEX "capability_module_idx" ON "capability" USING btree ("module");--> statement-breakpoint
CREATE INDEX "role_client_idx" ON "role" USING btree ("client");--> statement-breakpoint
CREATE INDEX "role_capability_role_idx" ON "role_capability" USING btree ("client","role_code");--> statement-breakpoint
CREATE INDEX "user_role_user_idx" ON "user_role" USING btree ("client","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_session_token_uq" ON "user_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_session_user_idx" ON "user_session" USING btree ("client","user_id");--> statement-breakpoint
CREATE INDEX "number_range_client_object_idx" ON "number_range" USING btree ("client","object_code");--> statement-breakpoint
CREATE INDEX "nra_lookup_idx" ON "number_range_allocation" USING btree ("client","object_code","sub_object","allocated_number");--> statement-breakpoint
CREATE INDEX "lock_wait_log_client_time_idx" ON "lock_wait_log" USING btree ("client","occurred_at");--> statement-breakpoint
CREATE INDEX "lock_wait_log_object_idx" ON "lock_wait_log" USING btree ("lock_object_code");--> statement-breakpoint
CREATE INDEX "change_document_object_idx" ON "change_document" USING btree ("client","object_class","object_key");--> statement-breakpoint
CREATE INDEX "change_document_time_idx" ON "change_document" USING btree ("client","changed_at");--> statement-breakpoint
CREATE INDEX "change_document_item_doc_idx" ON "change_document_item" USING btree ("client","change_document_id");--> statement-breakpoint
CREATE INDEX "dfl_predecessor_idx" ON "document_flow_link" USING btree ("client","predecessor_class","predecessor_key");--> statement-breakpoint
CREATE INDEX "dfl_successor_idx" ON "document_flow_link" USING btree ("client","successor_class","successor_key");--> statement-breakpoint
CREATE INDEX "document_index_key_idx" ON "document_index" USING btree ("client","document_class","document_key");--> statement-breakpoint
CREATE INDEX "document_index_number_idx" ON "document_index" USING btree ("client","display_number");--> statement-breakpoint
CREATE INDEX "dsh_document_idx" ON "document_status_history" USING btree ("client","document_class","document_key");--> statement-breakpoint
CREATE INDEX "config_activity_area_idx" ON "config_activity" USING btree ("area","sequence");--> statement-breakpoint
CREATE INDEX "config_activity_status_client_idx" ON "config_activity_status" USING btree ("client","status");--> statement-breakpoint
CREATE UNIQUE INDEX "term_alias_system_alias_uq" ON "term_alias" USING btree ("external_system","alias");--> statement-breakpoint
CREATE INDEX "term_alias_term_idx" ON "term_alias" USING btree ("term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "term_registry_our_code_uq" ON "term_registry" USING btree ("our_code");--> statement-breakpoint
CREATE UNIQUE INDEX "term_registry_our_table_uq" ON "term_registry" USING btree ("our_table");--> statement-breakpoint
CREATE INDEX "term_registry_type_idx" ON "term_registry" USING btree ("term_type");--> statement-breakpoint
CREATE INDEX "term_registry_module_idx" ON "term_registry" USING btree ("module");--> statement-breakpoint
CREATE INDEX "job_definition_queue_idx" ON "job_definition" USING btree ("queue");--> statement-breakpoint
CREATE INDEX "job_log_run_idx" ON "job_log" USING btree ("job_run_id","logged_at");--> statement-breakpoint
CREATE INDEX "job_run_client_status_idx" ON "job_run" USING btree ("client","status");--> statement-breakpoint
CREATE INDEX "job_run_job_idx" ON "job_run" USING btree ("job_code","queued_at");--> statement-breakpoint
CREATE INDEX "message_catalog_class_idx" ON "message_catalog" USING btree ("message_class");--> statement-breakpoint
CREATE INDEX "country_name_idx" ON "country" USING btree ("name");--> statement-breakpoint
CREATE INDEX "currency_name_idx" ON "currency" USING btree ("name");--> statement-breakpoint
CREATE INDEX "uom_dimension_idx" ON "unit_of_measure" USING btree ("dimension");--> statement-breakpoint
CREATE INDEX "gl_account_type_idx" ON "gl_account" USING btree ("client","account_type");--> statement-breakpoint
CREATE INDEX "journal_entry_company_date_idx" ON "journal_entry" USING btree ("client","company_code","posting_date");--> statement-breakpoint
CREATE INDEX "journal_entry_origin_idx" ON "journal_entry" USING btree ("client","origin_class","origin_key");--> statement-breakpoint
CREATE INDEX "jel_account_idx" ON "journal_entry_line" USING btree ("client","gl_account","fiscal_year");--> statement-breakpoint
CREATE INDEX "jel_costcenter_idx" ON "journal_entry_line" USING btree ("client","cost_center");--> statement-breakpoint
CREATE INDEX "jel_clearing_idx" ON "journal_entry_line" USING btree ("client","clearing_document");--> statement-breakpoint
CREATE INDEX "company_code_coa_idx" ON "company_code" USING btree ("client","chart_of_accounts");--> statement-breakpoint
CREATE INDEX "exchange_rate_lookup_idx" ON "exchange_rate" USING btree ("client","rate_type","from_currency","to_currency");--> statement-breakpoint
CREATE INDEX "fiscal_year_period_variant_idx" ON "fiscal_year_period" USING btree ("client","variant");--> statement-breakpoint
CREATE INDEX "plant_company_idx" ON "plant" USING btree ("client","company_code");