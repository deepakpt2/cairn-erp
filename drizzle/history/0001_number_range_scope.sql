ALTER TABLE "number_range" DROP CONSTRAINT "number_range_client_object_code_sub_object_fiscal_year_pk";--> statement-breakpoint
ALTER TABLE "number_range" ADD COLUMN "company_code" varchar(10) DEFAULT '*' NOT NULL;--> statement-breakpoint
ALTER TABLE "number_range" ADD CONSTRAINT "number_range_client_object_code_company_code_sub_object_fiscal_year_pk" PRIMARY KEY("client","object_code","company_code","sub_object","fiscal_year");--> statement-breakpoint
ALTER TABLE "number_range_allocation" ADD COLUMN "company_code" varchar(10) DEFAULT '*' NOT NULL;--> statement-breakpoint
ALTER TABLE "number_range_allocation" ADD COLUMN "range_fiscal_year" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD COLUMN "display_number" varchar(40) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_access_log" DROP CONSTRAINT IF EXISTS "audit_access_log_client_fk";--> statement-breakpoint
ALTER TABLE "audit_access_log" ADD CONSTRAINT "audit_access_log_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_org_restriction" DROP CONSTRAINT IF EXISTS "auth_org_restriction_client_fk";--> statement-breakpoint
ALTER TABLE "auth_org_restriction" ADD CONSTRAINT "auth_org_restriction_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capability" DROP CONSTRAINT IF EXISTS "role_capability_client_fk";--> statement-breakpoint
ALTER TABLE "role_capability" ADD CONSTRAINT "role_capability_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sod_rule" DROP CONSTRAINT IF EXISTS "sod_rule_client_fk";--> statement-breakpoint
ALTER TABLE "sod_rule" ADD CONSTRAINT "sod_rule_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" DROP CONSTRAINT IF EXISTS "user_role_client_fk";--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_session" DROP CONSTRAINT IF EXISTS "user_session_client_fk";--> statement-breakpoint
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_range" DROP CONSTRAINT IF EXISTS "number_range_client_fk";--> statement-breakpoint
ALTER TABLE "number_range" ADD CONSTRAINT "number_range_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_range_allocation" DROP CONSTRAINT IF EXISTS "number_range_allocation_client_fk";--> statement-breakpoint
ALTER TABLE "number_range_allocation" ADD CONSTRAINT "number_range_allocation_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lock_wait_log" DROP CONSTRAINT IF EXISTS "lock_wait_log_client_fk";--> statement-breakpoint
ALTER TABLE "lock_wait_log" ADD CONSTRAINT "lock_wait_log_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_document" DROP CONSTRAINT IF EXISTS "change_document_client_fk";--> statement-breakpoint
ALTER TABLE "change_document" ADD CONSTRAINT "change_document_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_document_item" DROP CONSTRAINT IF EXISTS "change_document_item_client_fk";--> statement-breakpoint
ALTER TABLE "change_document_item" ADD CONSTRAINT "change_document_item_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_flow_link" DROP CONSTRAINT IF EXISTS "document_flow_link_client_fk";--> statement-breakpoint
ALTER TABLE "document_flow_link" ADD CONSTRAINT "document_flow_link_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_index" DROP CONSTRAINT IF EXISTS "document_index_client_fk";--> statement-breakpoint
ALTER TABLE "document_index" ADD CONSTRAINT "document_index_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_status_history" DROP CONSTRAINT IF EXISTS "document_status_history_client_fk";--> statement-breakpoint
ALTER TABLE "document_status_history" ADD CONSTRAINT "document_status_history_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_activity_status" DROP CONSTRAINT IF EXISTS "config_activity_status_client_fk";--> statement-breakpoint
ALTER TABLE "config_activity_status" ADD CONSTRAINT "config_activity_status_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_log" DROP CONSTRAINT IF EXISTS "job_log_client_fk";--> statement-breakpoint
ALTER TABLE "job_log" ADD CONSTRAINT "job_log_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" DROP CONSTRAINT IF EXISTS "job_run_client_fk";--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_server_config" DROP CONSTRAINT IF EXISTS "mail_server_config_client_fk";--> statement-breakpoint
ALTER TABLE "mail_server_config" ADD CONSTRAINT "mail_server_config_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_account" DROP CONSTRAINT IF EXISTS "gl_account_client_fk";--> statement-breakpoint
ALTER TABLE "gl_account" ADD CONSTRAINT "gl_account_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" DROP CONSTRAINT IF EXISTS "journal_entry_client_fk";--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry_line" DROP CONSTRAINT IF EXISTS "journal_entry_line_client_fk";--> statement-breakpoint
ALTER TABLE "journal_entry_line" ADD CONSTRAINT "journal_entry_line_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" DROP CONSTRAINT IF EXISTS "chart_of_accounts_client_fk";--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_code" DROP CONSTRAINT IF EXISTS "company_code_client_fk";--> statement-breakpoint
ALTER TABLE "company_code" ADD CONSTRAINT "company_code_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlling_area" DROP CONSTRAINT IF EXISTS "controlling_area_client_fk";--> statement-breakpoint
ALTER TABLE "controlling_area" ADD CONSTRAINT "controlling_area_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controlling_area_company" DROP CONSTRAINT IF EXISTS "controlling_area_company_client_fk";--> statement-breakpoint
ALTER TABLE "controlling_area_company" ADD CONSTRAINT "controlling_area_company_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_control_area" DROP CONSTRAINT IF EXISTS "credit_control_area_client_fk";--> statement-breakpoint
ALTER TABLE "credit_control_area" ADD CONSTRAINT "credit_control_area_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_channel" DROP CONSTRAINT IF EXISTS "distribution_channel_client_fk";--> statement-breakpoint
ALTER TABLE "distribution_channel" ADD CONSTRAINT "distribution_channel_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "division" DROP CONSTRAINT IF EXISTS "division_client_fk";--> statement-breakpoint
ALTER TABLE "division" ADD CONSTRAINT "division_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_type" DROP CONSTRAINT IF EXISTS "document_type_client_fk";--> statement-breakpoint
ALTER TABLE "document_type" ADD CONSTRAINT "document_type_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rate" DROP CONSTRAINT IF EXISTS "exchange_rate_client_fk";--> statement-breakpoint
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_period" DROP CONSTRAINT IF EXISTS "fiscal_year_period_client_fk";--> statement-breakpoint
ALTER TABLE "fiscal_year_period" ADD CONSTRAINT "fiscal_year_period_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_year_variant" DROP CONSTRAINT IF EXISTS "fiscal_year_variant_client_fk";--> statement-breakpoint
ALTER TABLE "fiscal_year_variant" ADD CONSTRAINT "fiscal_year_variant_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant" DROP CONSTRAINT IF EXISTS "plant_client_fk";--> statement-breakpoint
ALTER TABLE "plant" ADD CONSTRAINT "plant_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_period_rule" DROP CONSTRAINT IF EXISTS "posting_period_rule_client_fk";--> statement-breakpoint
ALTER TABLE "posting_period_rule" ADD CONSTRAINT "posting_period_rule_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_period_variant" DROP CONSTRAINT IF EXISTS "posting_period_variant_client_fk";--> statement-breakpoint
ALTER TABLE "posting_period_variant" ADD CONSTRAINT "posting_period_variant_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_group" DROP CONSTRAINT IF EXISTS "purchasing_group_client_fk";--> statement-breakpoint
ALTER TABLE "purchasing_group" ADD CONSTRAINT "purchasing_group_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_org" DROP CONSTRAINT IF EXISTS "purchasing_org_client_fk";--> statement-breakpoint
ALTER TABLE "purchasing_org" ADD CONSTRAINT "purchasing_org_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_org_plant" DROP CONSTRAINT IF EXISTS "purchasing_org_plant_client_fk";--> statement-breakpoint
ALTER TABLE "purchasing_org_plant" ADD CONSTRAINT "purchasing_org_plant_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_area" DROP CONSTRAINT IF EXISTS "sales_area_client_fk";--> statement-breakpoint
ALTER TABLE "sales_area" ADD CONSTRAINT "sales_area_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_org" DROP CONSTRAINT IF EXISTS "sales_org_client_fk";--> statement-breakpoint
ALTER TABLE "sales_org" ADD CONSTRAINT "sales_org_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_location" DROP CONSTRAINT IF EXISTS "storage_location_client_fk";--> statement-breakpoint
ALTER TABLE "storage_location" ADD CONSTRAINT "storage_location_client_client_client_fk" FOREIGN KEY ("client") REFERENCES "public"."client"("client") ON DELETE cascade ON UPDATE no action;
