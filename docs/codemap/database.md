# Database
448 Drizzle tables (+2 SQL-only: `demo_installation`, `demo_installation_phase`, from `drizzle/9273_*`, raw SQL in `platform/tenancy/`). Aggregate: `src/platform/schema.ts` (drizzle-kit and the `Db`/`Tx` type). Migrations: `drizzle/0000_baseline.sql` + `drizzle/9267_*`…; `drizzle/history/` is never applied (see `unassigned.md`).

## Gotchas
- Tenant tables are FORCE RLS on `cairn.client`; read/write only inside `withTenant`/`withTenantAs`. The runtime role is `cairn_app` (NOBYPASSRLS); a superuser connection is refused.
- Every object must be owned by `cairn_integration_migrator` (SECURITY DEFINER functions and triggers run as it). Migrate only as that role.
- Cross-module writes exist: foundation `services.ts` → finance `gl_account`; inventory hosts `production_order*`; purchasing hosts `customer_invoice*`.
- Invariants often live in triggers or advisory locks, not indexes (payroll 9281, confirmation cancellation 9172, company-code refs). Grep `drizzle/*.sql` (not `history/`) before assuming none.

## Tables by owning module (schema file: tables)
### audit (3)
- `modules/audit/schema.ts`: audit_finding, audit_grant, audit_grant_scope

### finance (95)
- `modules/finance/gl-account-group-schema.ts`: gl_account_group, gl_account_group_field_status, group_chart_accounts
- `modules/finance/schema.ts`: accounting_reversal_link, accrual_document, asset_assignment, asset_class, asset_depreciation, asset_depreciation_posting, asset_depreciation_run, asset_depreciation_run_item, asset_retirement, asset_transaction, asset_transaction_type, carryforward_result, carryforward_run, clearing_reset, closing_execution_log, closing_task_dependency, closing_task_event, closing_task_instance, closing_task_list, closing_task_template, closing_task_template_dependency, consolidation_account_mapping, consolidation_area, consolidation_data_basis, consolidation_dimension, consolidation_execution, consolidation_execution_log, consolidation_group, consolidation_group_account, consolidation_method, consolidation_task, consolidation_task_status, consolidation_unit, consolidation_unit_assignment, consolidation_version, credit_block_reason, credit_change_audit, credit_determination, credit_release_event, credit_representative_group, credit_risk_category, customer_credit, customer_credit_group, customer_down_payment, customer_down_payment_clearing, customer_down_payment_clearing_item, customer_down_payment_request, depreciation_area, depreciation_key, down_payment_request_fulfillment, dunning_notice, dunning_run, dunning_run_account, dunning_run_company, dunning_run_item, financial_statement_assignment, financial_statement_node, financial_statement_version, fixed_asset, fx_valuation_item, fx_valuation_run, gl_account, gl_account_company, gl_account_transfer_result, gl_account_transfer_run, gl_clearing_allocation, gl_clearing_residual, grir_reclass_item, grir_reclass_run, incoming_payment, intercompany_clearing_config, intercompany_document_header, journal_entry, journal_entry_line, journal_posting_request, outgoing_payment, parked_journal_header, parked_journal_line, payment_document, payment_proposal_item, payment_run, payment_run_company, payment_run_method, residual_reason, reversal_reason, tax_return_run, vendor_down_payment, vendor_down_payment_clearing, vendor_down_payment_request, vendor_dp_request_fulfillment, vendor_invoice, vendor_invoice_line

### foundation (94)
- `modules/foundation/business-partner-schema.ts`: bp_role, business_partner, industry, industry_text
- `modules/foundation/central-address-schema.ts`: central_address
- `modules/foundation/characteristic-schema.ts`: characteristic, characteristic_value, class_assignment, class_type, classification_class, release_code, release_group, release_strategy, release_strategy_criterion, release_strategy_step
- `modules/foundation/customer-company-schema.ts`: customer_company_code
- `modules/foundation/customer-sales-area-schema.ts`: customer_sales_area
- `modules/foundation/output-schema.ts`: output_condition_record, output_message, output_type
- `modules/foundation/partner-bank-country-profile-schema.ts`: partner_bank_country_profile
- `modules/foundation/partner-bank-profile-activation-audit-schema.ts`: partner_bank_profile_activation_audit
- `modules/foundation/partner-bank-schema.ts`: partner_bank
- `modules/foundation/payment-method-schema.ts`: payment_method
- `modules/foundation/payment-terms-schema.ts`: payment_terms
- `modules/foundation/schema.ts`: account_determination, activity_rate, activity_type, allocation_structure, allocation_structure_assignment, bank_account, chart_of_accounts, company_code, controlling_area, controlling_area_company, cost_allocation_cycle, cost_allocation_receiver, cost_allocation_run, cost_allocation_segment, cost_allocation_sender, cost_center, cost_center_group, cost_center_group_leaf, cost_center_hierarchy, cost_center_node, cost_center_node_assignment, cost_center_plan, credit_control_area, distribution_channel, division, document_type, employee_tolerance_group, exchange_rate, factory_calendar, fiscal_year_period, fiscal_year_variant, group_chart_of_accounts, house_bank, internal_order, internal_order_budget_profile, internal_order_original_budget, internal_order_original_budget_year, internal_order_type, internal_order_type_budget_profile, internal_order_type_settlement_profile, plan_revaluation_order, plan_revaluation_order_item, plant, posting_period_rule, posting_period_variant, profit_center, profit_center_group, profit_center_group_leaf, profit_center_hierarchy, profit_center_node, profit_center_node_assignment, purchasing_group, purchasing_org, purchasing_org_plant, sales_area, sales_org, sales_org_distribution_channel, sales_org_division, sales_org_text, settlement_distribution_rule, settlement_document, settlement_profile, special_gl_config, storage_location, tax_code
- `modules/foundation/supplier-company-schema.ts`: supplier_company_code
- `modules/foundation/supplier-partner-schema.ts`: supplier_partner_function, supplier_purchasing_partner
- `modules/foundation/supplier-purchasing-schema.ts`: supplier_purchasing_org

### inventory (53)
- `modules/inventory/schema.ts`: account_category_reference, batch, batch_access_sequence, batch_access_step, batch_assigned_receipt, batch_condition_table, batch_condition_table_field, batch_conversion_check, batch_conversion_conflict, batch_document_management, batch_level_configuration, batch_level_conversion, batch_number_assignment, batch_search_allocation, batch_search_procedure, batch_search_procedure_step, batch_search_strategy, batch_search_strategy_key, batch_sort_sequence, batch_sort_sequence_criterion, batch_status_management, batch_status_plant, batch_status_plant_conversion, batch_strategy_type, industry_sector, material, material_document, material_document_line, material_group, material_number_range_group, material_period_control, material_plant, material_sales, material_type, material_type_valuation, material_uom_conversion, material_valuation, movement_type, mrp_controller, physical_inventory_difference_allocation, physical_inventory_document, physical_inventory_item, physical_inventory_recount_link, planning_file, production_order, production_order_component, production_scheduling_profile, reservation_header, reservation_item, serial_number, stock_quantity, valuation_class, valuation_class_reference

### people (27)
- `modules/people/schema.ts`: absence, delegation, delegation_approval, delegation_scope, employee, employee_record, job, leave_quota, org_hierarchy, org_unit, pay_component, pay_component_config, payroll_result, payroll_result_line, payroll_run, payroll_run_exception, position, position_assignment, record_field, record_field_value, record_type, salary_payment, salary_structure, salary_structure_assignment, salary_structure_component, time_recording, time_type

### platform (shared) (41)
- `platform/tables/audit-trail.ts`: change_document, change_document_item, document_flow_link, document_index, document_status_history
- `platform/tables/lock.ts`: enqueue_entry, lock_object, lock_wait_log
- `platform/tables/numbering.ts`: number_range, number_range_allocation, number_range_object
- `platform/tables/reference.ts`: bank_master, country, currency, unit_of_measure
- `platform/tables/registry.ts`: config_activity, config_activity_status, term_alias, term_registry
- `platform/tables/security.ts`: app_user, audit_access_log, auth_org_restriction, capability, password_reset_token, position_capability, role, role_capability, sod_rule, user_capability, user_capability_scope, user_role, user_session
- `platform/tables/system.ts`: job_definition, job_log, job_run, mail_message, mail_server_config, message_catalog, notification
- `platform/tables/tenancy.ts`: client, client_settings

### production (51)
- `modules/production/schema.ts`: availability_check_scope, availability_checking_group, availability_checking_rule, bom_item_category, bom_status, bom_usage, material_bom, material_bom_item, material_cost_estimate, material_cost_estimate_item, mrp_dependent_requirement, mrp_run, planned_order, production_checking_control, production_confirmation, production_confirmation_activity, production_confirmation_cancellation, production_confirmation_operation, production_goods_movement_failure, production_goods_movement_failure_attempt, production_goods_movement_failure_line, production_goods_movement_failure_revision, production_order_availability_run, production_order_component_commitment_event, production_order_operation, production_order_operation_value, production_order_settlement_distribution_rule, production_order_type, production_order_type_parameter, production_order_type_settlement_profile, production_version, production_version_finding, production_version_rule, report_layout, routing, routing_component_allocation, routing_control_key, routing_material_assignment, routing_operation, routing_operation_value, routing_sequence, routing_standard_value_key, routing_standard_value_parameter, routing_status, routing_task_list_type, routing_usage, wip_batch_activation, work_center, work_center_capacity, work_center_category, work_center_costing

### purchasing (44)
- `modules/purchasing/schema.ts`: customer_invoice, customer_invoice_line, document_release, gr_ir_maintenance_link, parked_supplier_invoice, parked_supplier_invoice_item, purchase_contract, purchase_contract_item, purchase_delivery_completion_plant, purchase_delivery_completion_policy, purchase_order, purchase_order_assignment, purchase_order_item, purchase_order_schedule_line, purchase_requisition_assignment, purchase_requisition_item, purchasing_contract_type, purchasing_info_record, purchasing_info_record_org, purchasing_info_record_price, purchasing_quota_arrangement, purchasing_quota_arrangement_item, purchasing_quotation, purchasing_quotation_item, purchasing_rfq, purchasing_rfq_event, purchasing_rfq_event_item, purchasing_rfq_item, purchasing_source_list, purchasing_source_list_entry, scheduling_agreement, scheduling_agreement_item, scheduling_agreement_release, scheduling_agreement_release_line, scheduling_agreement_schedule_line, scheduling_agreement_type, scheduling_release_profile, scheduling_release_profile_assignment, supplier_invoice, supplier_invoice_item, supplier_invoice_payment_block, supplier_invoice_payment_block_event, vendor_evaluation_assessment, vendor_evaluation_criterion

### quality (4)
- `modules/quality/schema.ts`: inspection_characteristic, inspection_result, quality_lot, usage_decision

### sales (42)
- `modules/sales/schema.ts`: billing_document, billing_document_line, customer_sales_partner, delivery, delivery_line, delivery_picking, delivery_picking_serial, incompletion_assignment, incompletion_group, incompletion_procedure, incompletion_procedure_field, incompletion_status_group, sales_account_determination, sales_batch_determination_rule, sales_billing_plan, sales_billing_plan_date, sales_billing_plan_type, sales_billing_split_criterion, sales_condition_record, sales_condition_type, sales_document_condition, sales_document_partner, sales_document_type, sales_down_payment_request, sales_incompletion_log, sales_invoice_list_item, sales_order, sales_order_line, sales_order_schedule, sales_partner_function, sales_pricing_procedure, sales_pricing_procedure_step, sales_procedure_determination, sales_quotation, sales_quotation_line, sales_quotation_schedule, sales_rebate_accrual, sales_rebate_agreement, sales_returns_configuration, shipping_condition, shipping_point, shipping_point_determination

## Cross-module access
| table | owner | also used by |
|---|---|---|
| account_determination | foundation | dev/walkthrough-asset.ts, finance, inventory, people, platform/tenancy, purchasing, sales |
| accounting_reversal_link | finance | people |
| activity_rate | foundation | platform/tenancy, production |
| activity_type | foundation | platform/tenancy, production |
| allocation_structure_assignment | foundation | production |
| app_user | platform/tables | audit, finance, foundation, inventory, people, platform, platform/auth, platform/job, platform/notification, platform/tenancy, production, purchasing |
| asset_class | finance | foundation, purchasing |
| asset_transaction | finance | dev/walkthrough-asset.ts |
| asset_transaction_type | finance | foundation, purchasing |
| audit_access_log | platform/tables | audit, people, platform, platform/auth, platform/security |
| auth_org_restriction | platform/tables | finance, inventory, platform, platform/auth, platform/tenancy, production |
| availability_check_scope | production | platform/tenancy, sales |
| availability_checking_group | production | platform/tenancy, sales |
| availability_checking_rule | production | platform/tenancy, sales |
| bank_account | foundation | finance, people |
| bank_master | platform/tables | foundation, platform/tenancy |
| batch | inventory | sales |
| batch_level_configuration | inventory | production |
| batch_number_assignment | inventory | platform/tenancy |
| batch_status_management | inventory | platform/tenancy |
| billing_document | sales | finance, platform/tenancy |
| bp_role | foundation | inventory, purchasing, sales |
| business_partner | foundation | finance, inventory, purchasing, sales |
| capability | platform/tables | audit, inventory, platform, platform/auth, platform/tenancy, production |
| change_document | platform/tables | finance, foundation, inventory, platform/change, platform/notification, production, purchasing |
| change_document_item | platform/tables | finance, foundation, platform/change, purchasing |
| characteristic | foundation | inventory, platform/tenancy, purchasing |
| chart_of_accounts | foundation | finance, people, platform/tenancy, sales |
| class_assignment | foundation | inventory |
| class_type | foundation | inventory |
| classification_class | foundation | inventory, platform/tenancy |
| client | platform/tables | finance, platform, platform/tenancy, purchasing |
| client_settings | platform/tables | platform/tenancy |
| company_code | foundation | audit, finance, inventory, people, platform, platform/periods, platform/tenancy, production, purchasing, sales |
| config_activity | platform/tables | platform/tenancy |
| config_activity_status | platform/tables | foundation, platform/tenancy |
| controlling_area | foundation | inventory, platform/tenancy, production |
| controlling_area_company | foundation | inventory, platform/tenancy, production, purchasing |
| cost_center | foundation | finance, inventory, people, platform/tenancy, production, purchasing |
| cost_center_hierarchy | foundation | platform/tenancy |
| country | platform/tables | foundation, inventory |
| credit_control_area | foundation | finance, platform/tenancy |
| credit_determination | finance | sales |
| credit_risk_category | finance | platform/tenancy |
| currency | platform/tables | finance, foundation, inventory, people, platform/i18n, purchasing, sales |
| customer_company_code | foundation | finance |
| customer_credit | finance | sales |
| customer_down_payment_request | finance | sales |
| customer_invoice | purchasing | finance, platform/tenancy |
| customer_invoice_line | purchasing | finance |
| customer_sales_area | foundation | sales |
| delegation | people | platform/auth, platform/notification |
| delegation_approval | people | platform/auth |
| delegation_scope | people | platform/auth |
| delivery | sales | platform/tenancy |
| delivery_line | sales | platform/tenancy |
| delivery_picking_serial | sales | inventory |
| depreciation_area | finance | foundation |
| depreciation_key | finance | foundation |
| distribution_channel | foundation | inventory, platform/tenancy |
| division | foundation | platform/tenancy |
| document_flow_link | platform/tables | platform/document |
| document_index | platform/tables | foundation, platform/document |
| document_release | purchasing | inventory, platform/attention, production |
| document_status_history | platform/tables | platform/document |
| document_type | foundation | finance, platform/posting, platform/tenancy |
| down_payment_request_fulfillment | finance | sales |
| employee | people | platform, platform/auth, platform/notification, platform/tenancy, purchasing |
| employee_tolerance_group | foundation | finance, platform/tenancy |
| enqueue_entry | platform/tables | platform/auth, platform/job, platform/lock |
| exchange_rate | foundation | finance, platform/tenancy, purchasing |
| factory_calendar | foundation | production |
| financial_statement_assignment | finance | foundation |
| financial_statement_node | finance | foundation |
| financial_statement_version | finance | foundation |
| fiscal_year_period | foundation | audit, finance, platform/periods, production |
| fiscal_year_variant | foundation | finance, inventory, platform/periods, platform/tenancy, production |
| fixed_asset | finance | dev/walkthrough-asset.ts, purchasing |
| gl_account | finance | foundation, people, platform/posting, platform/tenancy, production, purchasing, sales |
| gl_account_company | finance | foundation |
| gl_account_group | finance | foundation |
| house_bank | foundation | finance, people, platform/tenancy |
| incompletion_group | sales | foundation |
| industry | foundation | platform/tenancy |
| industry_sector | inventory | platform/tenancy |
| internal_order | foundation | finance, purchasing |
| internal_order_budget_profile | foundation | platform/tenancy |
| internal_order_type | foundation | platform/tenancy |
| internal_order_type_budget_profile | foundation | platform/tenancy |
| job_definition | platform/tables | platform/job |
| job_log | platform/tables | platform/job |
| job_run | platform/tables | platform/job |
| journal_entry | finance | foundation, inventory, people, platform/posting, platform/tenancy, production, purchasing |
| journal_entry_line | finance | dev/walkthrough-asset.ts, foundation, people, platform/posting, platform/tenancy, production, purchasing |
| lock_wait_log | platform/tables | platform/lock |
| mail_message | platform/tables | platform/mail |
| mail_server_config | platform/tables | platform/mail |
| material | inventory | foundation, production, purchasing, sales |
| material_bom | production | platform/tenancy |
| material_document | inventory | finance, production, purchasing, quality, sales |
| material_document_line | inventory | dev/walkthrough-asset.ts, finance, production, purchasing, quality, sales |
| material_group | inventory | platform/tenancy, purchasing |
| material_period_control | inventory | platform/tenancy |
| material_plant | inventory | foundation, platform/tenancy, production, purchasing, sales |
| material_sales | inventory | sales |
| material_type | inventory | platform/tenancy |
| material_uom_conversion | inventory | foundation, purchasing |
| material_valuation | inventory | platform/tenancy, production, purchasing, sales |
| movement_type | inventory | finance, platform/tenancy, production, purchasing, sales |
| mrp_controller | inventory | production |
| notification | platform/tables | platform/notification |
| number_range | platform/tables | foundation, inventory, platform/numbering, platform/tenancy, purchasing, sales |
| number_range_allocation | platform/tables | foundation, inventory, platform/numbering, platform/posting |
| number_range_object | platform/tables | foundation, inventory, platform/tenancy |
| outgoing_payment | finance | dev/walkthrough-asset.ts |
| output_condition_record | foundation | sales |
| output_message | foundation | inventory, sales |
| output_type | foundation | inventory, sales |
| parked_supplier_invoice | purchasing | foundation |
| password_reset_token | platform/tables | platform |
| pay_component | people | platform/tenancy |
| pay_component_config | people | platform/tenancy |
| payment_document | finance | purchasing |
| payment_method | foundation | finance, platform/tenancy |
| payment_proposal_item | finance | purchasing |
| payment_run | finance | purchasing |
| payment_terms | foundation | finance, platform/tenancy, purchasing |
| payroll_run_exception | people | platform/tenancy |
| planning_file | inventory | production |
| plant | foundation | finance, inventory, platform, platform/auth, platform/tenancy, production, purchasing, sales |
| position_assignment | people | platform/auth, platform/notification |
| position_capability | platform/tables | platform/auth, platform/notification |
| posting_period_rule | foundation | platform/periods |
| posting_period_variant | foundation | platform/periods, platform/tenancy |
| production_order | inventory | platform/tenancy, production |
| production_order_component | inventory | production |
| production_order_type | production | inventory, platform/tenancy |
| production_order_type_parameter | production | platform/tenancy |
| production_version | production | platform/tenancy |
| profit_center | foundation | finance, platform/tenancy |
| profit_center_hierarchy | foundation | platform/tenancy |
| purchase_contract | purchasing | platform/attention |
| purchase_order | purchasing | dev/walkthrough-asset.ts, dev/walkthrough-volume.ts, finance, foundation, inventory, platform/attention, production |
| purchase_order_item | purchasing | dev/walkthrough-asset.ts, dev/walkthrough-volume.ts, finance, inventory, production |
| purchase_order_schedule_line | purchasing | production |
| purchase_requisition_item | purchasing | platform/attention, production |
| purchasing_contract_type | purchasing | platform/tenancy |
| purchasing_group | foundation | inventory, platform/tenancy, purchasing |
| purchasing_org | foundation | platform/tenancy, purchasing |
| purchasing_org_plant | foundation | platform/tenancy, purchasing |
| purchasing_quotation | purchasing | foundation |
| purchasing_rfq | purchasing | foundation |
| purchasing_rfq_event | purchasing | foundation |
| record_type | people | platform/tenancy |
| release_group | foundation | purchasing |
| release_strategy | foundation | platform/tenancy, purchasing |
| release_strategy_criterion | foundation | purchasing |
| release_strategy_step | foundation | platform/attention, purchasing |
| reservation_header | inventory | production |
| reservation_item | inventory | production |
| reversal_reason | finance | foundation |
| role | platform/tables | finance, inventory, platform, platform/auth, platform/notification, platform/tenancy, production |
| role_capability | platform/tables | finance, inventory, platform, platform/auth, platform/notification, platform/tenancy, production |
| routing | production | platform/tenancy |
| routing_control_key | production | platform/tenancy |
| routing_operation | production | platform/tenancy |
| sales_account_determination | sales | foundation |
| sales_area | foundation | platform/tenancy, sales |
| sales_billing_plan_type | sales | foundation |
| sales_condition_record | sales | platform/tenancy |
| sales_condition_type | sales | foundation |
| sales_document_type | sales | foundation |
| sales_order | sales | platform/tenancy |
| sales_org | foundation | inventory, platform/tenancy, sales |
| sales_org_distribution_channel | foundation | platform/tenancy |
| sales_org_division | foundation | platform/tenancy |
| sales_org_text | foundation | platform/tenancy |
| sales_partner_function | sales | foundation |
| sales_pricing_procedure | sales | foundation |
| sales_pricing_procedure_step | sales | foundation |
| sales_procedure_determination | sales | foundation |
| sales_returns_configuration | sales | foundation |
| scheduling_agreement | purchasing | platform/attention |
| scheduling_agreement_type | purchasing | platform/tenancy |
| settlement_document | foundation | production |
| settlement_profile | foundation | platform/tenancy, production |
| shipping_condition | sales | foundation |
| sod_rule | platform/tables | platform |
| special_gl_config | foundation | finance, sales |
| stock_quantity | inventory | dev/walkthrough-volume.ts, production, sales |
| storage_location | foundation | inventory, platform/tenancy, production, purchasing |
| supplier_company_code | foundation | finance, purchasing |
| supplier_invoice | purchasing | dev/walkthrough-asset.ts, finance, foundation |
| supplier_invoice_item | purchasing | finance |
| supplier_purchasing_org | foundation | purchasing |
| tax_code | foundation | finance, platform/tenancy, purchasing, sales |
| tax_return_run | finance | platform/tenancy |
| term_alias | platform/tables | platform/registry |
| term_registry | platform/tables | platform/registry |
| time_type | people | platform/tenancy |
| unit_of_measure | platform/tables | foundation, inventory, production, purchasing, quality, sales |
| user_capability | platform/tables | people, platform/auth, platform/notification |
| user_capability_scope | platform/tables | platform/auth |
| user_role | platform/tables | finance, inventory, platform, platform/auth, platform/notification, platform/tenancy, production |
| user_session | platform/tables | finance, inventory, platform, platform/auth, platform/job, platform/lock, production |
| valuation_class | inventory | foundation, platform/tenancy |
| vendor_down_payment | finance | foundation, purchasing |
| vendor_down_payment_clearing | finance | purchasing |
| work_center | production | platform/tenancy |
| work_center_costing | production | platform/tenancy |
