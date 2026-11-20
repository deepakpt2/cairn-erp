# Foundation
Enterprise structure & master data (partners, company codes, plants, orgs) + controlling masters/reporting/planning (cost/profit centers, internal orders, settlement, cost centre planning KP06, activity price calculation KSPI, allocation cycles/assessment KSU5). Routes: `/foundation/*`, `/controlling/*`, `/constrained-values`, most of `/config/*`. Paths relative to `src/`; tables are SQL names.

## Gotchas
- Covers enterprise structure + master data **and** controlling (KP06 planning, KSPI prices, KSU5 assessment, settlement).
- Nullable company-code FKs are "define then assign"; trigger `cairn_assert_company_code_refs()` names the missing config step.
- `bank_master`, `number_range*` tables live in `platform/tables`; foundation owns their maintenance logic.
- Partner bank data: encrypted envelope (`cbd1.…`) CHECK, exactly one of IBAN/local account; app role is SELECT-only. Same-named files in `platform/security` are pure constants (no DB).
- Settlement: `settlement-configuration.ts` (rules, advisory lock) vs `-masters.ts` (IMG) vs `-keys.ts` (DB-free constants); `order-settlement.ts` executes KO88/KO8G.
- Assessment posts via `postGlDocument` (event `CO_ASSESSMENT`); one run per cycle/period (partial unique index excluding CANCELLED).
- Distribution (KSV5) is the same engine (`prepareDistribution`), category on the cycle **and** the run: no `CO_ASSESSMENT`, run's `assessment_account` null (CHECK). Allocation output is excluded from the read **by document** (`cost_allocation_run.document_number` / reversal's `reversal_of`), never by type — a reversal of AL is AB. A sender on a live run's document is refused. Capability follows category (`executeCapabilityFor`): preview, run and cancel.
- `output-schema.ts` is module-less but hosted here. `constrained-values.ts` serves every module's dropdowns.
- `internal-order-cost-report.ts` (KOB1) reads journal lines directly (no view); checks `CO.ORDER.COST.DISPLAY` (exact-grant-only) in the service before reading.
- Demo phases `D12_CO_PLAN`, `D13_ACTIVITY_PRICE`, `D14_ASSESSMENT` (assessment SVC01 + distribution DST01).

## Files (302)
| file | exports | tables |
|---|---|---|
| **app/config/account-determination/** | | |
| AccountDetermination.tsx | AccountDetermination |  |
| actions.ts | saveDeterminationAction, deleteDeterminationAction |  |
| page.tsx | AccountDeterminationPage |  |
| **app/config/activity-rates/** | | |
| actions.ts | saveActivityRatesAction, deleteActivityRateAction |  |
| ActivityRates.tsx | ActivityRates |  |
| page.tsx | ActivityRatesPage |  |
| price-actions.ts | activityPriceAction |  |
| PricePanel.tsx | PricePanel |  |
| **app/config/activity-types/** | | |
| actions.ts | saveActivityTypeAction, lockActivityTypeAction, deleteActivityTypeAction |  |
| ActivityTypes.tsx | ActivityTypes |  |
| page.tsx | ActivityTypesPage |  |
| **app/config/banks/** | | |
| actions.ts | saveBankAction, deleteBankAction |  |
| Banks.tsx | Banks |  |
| page.tsx | BanksPage |  |
| **app/config/characteristics/** | | |
| actions.ts | saveCharacteristicAction, setCharacteristicStatusAction, deleteCharacteristicAction |  |
| Characteristics.tsx | Characteristics |  |
| page.tsx | CharacteristicsPage |  |
| **app/config/classes/** | | |
| actions.ts | saveClassAction, setClassStatusAction, deleteClassAction |  |
| Classes.tsx | Classes |  |
| page.tsx | ClassesPage |  |
| **app/config/company-codes/** | | |
| actions.ts | defineCompanyCodeAction, assignCompanyCodeCoaAction |  |
| CompanyCodeCoaAssignmentForm.tsx | CompanyCodeCoaAssignmentForm |  |
| CompanyCodeDefinitionForm.tsx | CompanyCodeDefinitionForm |  |
| page.tsx | CompanyCodesPage |  |
| **app/config/company-codes/assign-chart-of-accounts/** | | |
| actions.ts | assignCoaAction |  |
| CoaAssignmentForm.tsx | CoaAssignmentForm |  |
| page.tsx | AssignChartOfAccountsPage |  |
| **app/config/controlling-area/** | | |
| actions.ts | saveControllingAreaAction |  |
| AssignmentControlField.tsx | AssignmentControlField |  |
| ControllingAreaCompanyAssignmentUI.tsx | ControllingAreaCompanyAssignmentUI |  |
| ControllingAreaForm.tsx | ControllingAreaForm, ActionMessage |  |
| ControllingAreasList.tsx | ControllingAreasList |  |
| ControllingAreaValueHelp.tsx | ControllingAreaValueHelp |  |
| page.tsx | ControllingAreaPage |  |
| **app/config/controlling-area/assign-company-code/** | | |
| actions.ts | assignControllingAreaCompanyAction, unassignControllingAreaCompanyAction |  |
| page.tsx | ControllingAreaCompanyCodeAssignmentPage |  |
| **app/config/cost-center-hierarchy/** | | |
| actions.ts | saveHierarchyHeaderAction, saveHierarchyNodeAction, deleteHierarchyNodeAction, placePeriodAction, unplacePeriodAction, saveGroupAction, deleteGroupAction, addLeafAction, removeLeafAction |  |
| CostCenterHierarchy.tsx | CostCenterHierarchy |  |
| page.tsx | CostCenterHierarchyPage |  |
| **app/config/cost-centers/** | | |
| actions.ts | saveCostCenterAction, lockCostCenterAction, deleteCostCenterAction |  |
| CostCenters.tsx | CostCenters |  |
| page.tsx | CostCentersPage |  |
| **app/config/distribution-channels/** | | |
| actions.ts | saveDistributionChannelAction, deactivateDistributionChannelAction |  |
| DeactivateDistributionChannelForm.tsx | DeactivateDistributionChannelForm |  |
| DistributionChannelDefinitionForm.tsx | DistributionChannelDefinitionForm |  |
| page.tsx | DistributionChannelsPage |  |
| **app/config/divisions/** | | |
| actions.ts | saveDivisionAction, deactivateDivisionAction |  |
| DeactivateDivisionForm.tsx | DeactivateDivisionForm |  |
| DivisionDefinitionForm.tsx | DivisionDefinitionForm |  |
| page.tsx | DivisionsPage |  |
| **app/config/document-types/** | | |
| actions.ts | saveDocumentTypeAction, setDocumentTypeActiveAction, deleteDocumentTypeAction |  |
| DocumentTypes.tsx | DocumentTypes |  |
| page.tsx | DocumentTypesPage |  |
| **app/config/exchange-rates/** | | |
| actions.ts | saveExchangeRateAction, deleteExchangeRateAction |  |
| ExchangeRates.tsx | ExchangeRates |  |
| page.tsx | ExchangeRatesPage |  |
| **app/config/factory-calendars/** | | |
| actions.ts | savePeriodAction, deletePeriodAction, saveHolidayCalendarAction, deleteHolidayCalendarAction, addHolidayAction, removeHolidayAction |  |
| FactoryCalendarForms.tsx | PeriodForm, HolidayCalendarPanel |  |
| page.tsx | FactoryCalendarsPage |  |
| **app/config/house-banks/** | | |
| actions.ts | saveHouseBankAction, deleteHouseBankAction, saveBankAccountAction, deleteBankAccountAction |  |
| HouseBanks.tsx | HouseBanks |  |
| page.tsx | HouseBanksPage |  |
| **app/config/industries/** | | |
| actions.ts | saveIndustryAction, setIndustryActiveAction, deleteIndustryAction |  |
| Industries.tsx | Industries |  |
| page.tsx | IndustriesPage |  |
| **app/config/mrp-controllers/** | | |
| page.tsx | MrpControllersPage |  |
| **app/config/number-range-objects/** | | |
| actions.ts | saveNumberRangeObjectAction |  |
| NumberRangeObjects.tsx | NumberRangeObjects |  |
| page.tsx | NumberRangeObjectsPage |  |
| **app/config/number-ranges/** | | |
| actions.ts | saveNumberRange, adjustNumberRangeCurrentAction |  |
| page.tsx | NumberRangesPage |  |
| RangeForm.tsx | RangeForm, AdjustCurrentForm |  |
| **app/config/payment-methods/** | | |
| actions.ts | savePaymentMethodAction, retirePaymentMethodAction |  |
| page.tsx | PaymentMethodsPage |  |
| PaymentMethodForm.tsx | PaymentMethodForm |  |
| RetirePaymentMethodForm.tsx | RetirePaymentMethodForm |  |
| **app/config/payment-terms/** | | |
| actions.ts | savePaymentTermAction |  |
| page.tsx | PaymentTermsPage |  |
| TermsForm.tsx | TermsForm |  |
| **app/config/plants/** | | |
| actions.ts | savePlantDefinitionAction, assignPlantCompanyCodeAction |  |
| page.tsx | PlantsPage |  |
| PlantCompanyCodeAssignmentForm.tsx | PlantCompanyCodeAssignmentForm |  |
| PlantDefinitionForm.tsx | PlantDefinitionForm |  |
| **app/config/posting-period-variants/** | | |
| actions.ts | savePostingPeriodVariantAction, deletePostingPeriodVariantAction |  |
| page.tsx | PostingPeriodVariantsPage |  |
| PostingPeriodVariants.tsx | ActionMessage, PostingPeriodVariantForm, PostingPeriodVariantPanel, PostingPeriodVariantList |  |
| **app/config/posting-period-variants/assign-company-codes/** | | |
| actions.ts | assignPostingPeriodVariantAction |  |
| page.tsx | AssignPostingPeriodVariantPage |  |
| PostingPeriodVariantAssignments.tsx | PostingPeriodVariantAssignments |  |
| **app/config/posting-periods/** | | |
| actions.ts | savePeriodRule |  |
| page.tsx | PostingPeriodsPage |  |
| PeriodRules.tsx | PeriodRules |  |
| **app/config/profit-center-hierarchy/** | | |
| actions.ts | saveHierarchyHeaderAction, saveHierarchyNodeAction, deleteHierarchyNodeAction, placePeriodAction, unplacePeriodAction, saveGroupAction, deleteGroupAction, addLeafAction, removeLeafAction |  |
| page.tsx | ProfitCenterHierarchyPage |  |
| ProfitCenterHierarchy.tsx | ProfitCenterHierarchy |  |
| **app/config/profit-centers/** | | |
| actions.ts | saveProfitCenterAction, lockProfitCenterAction, deleteProfitCenterAction |  |
| page.tsx | ProfitCentersPage |  |
| ProfitCenters.tsx | ProfitCenters |  |
| **app/config/purchasing-groups/** | | |
| actions.ts | savePurchasingGroupChangesAction |  |
| page.tsx | PurchasingGroupsPage |  |
| PurchasingGroupsGrid.tsx | PurchasingGroupsGrid |  |
| **app/config/release-strategies/** | | |
| actions.ts | saveReleaseGroupAction, deleteReleaseGroupAction, saveReleaseStrategyAction, setReleaseStrategyStatusAction, deleteReleaseStrategyAction |  |
| page.tsx | ReleaseStrategiesPage |  |
| ReleaseStrategies.tsx | ReleaseStrategies |  |
| **app/config/retained-earnings/** | | |
| actions.ts | maintainAction, deleteAction |  |
| page.tsx | RetainedEarningsPage |  |
| RetainedEarnings.tsx | RetainedEarnings |  |
| **app/config/sales-areas/** | | |
| actions.ts | saveSalesAreaAction, deactivateSalesAreaAction, reactivateSalesAreaAction, salesAreaValueHelpAction |  |
| page.tsx | SalesAreasPage |  |
| SalesAreaForm.tsx | SalesAreaForm |  |
| SalesAreasList.tsx | SalesAreasList |  |
| **app/config/sales-orgs/** | | |
| actions.ts | saveSalesOrgDefinitionAction, deactivateSalesOrgAction |  |
| DeactivateSalesOrgForm.tsx | DeactivateSalesOrgForm |  |
| page.tsx | SalesOrgsPage |  |
| SalesOrgDefinitionForm.tsx | SalesOrgDefinitionForm |  |
| **app/config/sales-orgs/assign-company/** | | |
| actions.ts | assignSalesOrgCompanyCodeAction |  |
| page.tsx | AssignSalesOrgCompanyCodePage |  |
| SalesOrgCompanyCodeAssignmentForm.tsx | SalesOrgCompanyCodeAssignmentForm |  |
| **app/config/sales-orgs/assign-distribution-channel/** | | |
| actions.ts | assignSalesOrgDistributionChannelAction, unassignSalesOrgDistributionChannelAction |  |
| AssignmentForm.tsx | SalesOrgDistributionChannelAssignmentForm |  |
| AssignmentsList.tsx | SalesOrgDistributionChannelAssignmentsList |  |
| page.tsx | AssignDistributionChannelPage |  |
| **app/config/sales-orgs/assign-division/** | | |
| actions.ts | assignSalesOrgDivisionAction, unassignSalesOrgDivisionAction |  |
| AssignmentForm.tsx | SalesOrgDivisionAssignmentForm |  |
| AssignmentsList.tsx | SalesOrgDivisionAssignmentsList |  |
| page.tsx | AssignDivisionPage |  |
| **app/config/settlement-configuration/** | | |
| actions.ts | saveStructureAction, saveAssignmentAction, removeAssignmentAction, saveProfileAction, saveOrderTypeAction, removeOrderTypeAction |  |
| page.tsx | SettlementConfigurationPage |  |
| SettlementMasters.tsx | SettlementMasters |  |
| **app/config/special-gl/** | | |
| actions.ts | maintainAction, deleteAction |  |
| page.tsx | SpecialGlPage |  |
| SpecialGl.tsx | SpecialGl |  |
| **app/config/storage-locations/** | | |
| actions.ts | saveStorageLocationAction, deactivateStorageLocationAction |  |
| DeactivateStorageLocationForm.tsx | DeactivateStorageLocationForm |  |
| page.tsx | StorageLocationsPage |  |
| StorageLocationForm.tsx | StorageLocationForm |  |
| **app/config/tax-codes/** | | |
| actions.ts | saveTaxCodeAction, deleteTaxCodeAction |  |
| page.tsx | TaxCodesPage |  |
| TaxCodes.tsx | TaxCodes |  |
| **app/config/tolerance-groups/** | | |
| actions.ts | saveToleranceGroupAction |  |
| page.tsx | ToleranceGroupsPage |  |
| ToleranceGroups.tsx | ToleranceGroups |  |
| **app/constrained-values/** | | |
| actions.ts | suggestConstrainedAction |  |
| **app/controlling/allocation-cycles/** | | |
| actions.ts | saveCycleAction, setSegmentAction, setNodeAction, deleteAction, executeAction, cancelRunAction |  |
| CycleForms.tsx | CycleForm, SegmentForm, NodeForm, DeleteForm, ExecutePanel, CancelRunForm |  |
| page.tsx | AllocationCyclesPage |  |
| **app/controlling/cost-center-planning/** | | |
| actions.ts | savePlanAction |  |
| page.tsx | CostCenterPlanningPage |  |
| PlanGrid.tsx | PlanGrid |  |
| **app/controlling/cost-center-report/** | | |
| CostCenterReportShell.tsx | CostCenterReportShell |  |
| page.tsx | CostCenterReportPage |  |
| **app/controlling/internal-order-display/** | | |
| page.tsx | InternalOrderDisplayPage |  |
| **app/controlling/internal-order-line-items/** | | |
| page.tsx | InternalOrderLineItemsPage |  |
| **app/controlling/internal-orders/** | | |
| actions.ts | saveInternalOrderAction |  |
| OrderForm.tsx | OrderForm |  |
| page.tsx | InternalOrdersPage |  |
| **app/controlling/order-settlement-collective/** | | |
| actions.ts | settleOrdersCollectiveAction |  |
| CollectiveForm.tsx | CollectiveForm |  |
| page.tsx | CollectiveOrderSettlementPage |  |
| **app/controlling/order-settlement/** | | |
| actions.ts | settleOrderAction |  |
| page.tsx | OrderSettlementPage |  |
| SettlementForm.tsx | SettlementForm |  |
| **app/controlling/original-budget-display/** | | |
| page.tsx | OriginalBudgetDisplayPage |  |
| **app/controlling/original-budget/** | | |
| actions.ts | saveOriginalBudgetAction |  |
| BudgetForm.tsx | BudgetForm |  |
| page.tsx | OriginalBudgetPage |  |
| **app/controlling/plan-revaluation/** | | |
| actions.ts | createPlanRevaluationAction |  |
| page.tsx | PlanRevaluationPage |  |
| RevaluationForm.tsx | RevaluationForm |  |
| **app/controlling/profit-center-report/** | | |
| page.tsx | ProfitCenterReportPage |  |
| ProfitCenterReportShell.tsx | ProfitCenterReportShell |  |
| **app/controlling/profit-center-report/export/** | | |
| route.ts | GET |  |
| **app/controlling/settlement-rules/** | | |
| actions.ts | saveSettlementRuleAction |  |
| page.tsx | SettlementRulePage |  |
| RuleForm.tsx | RuleForm |  |
| **app/finance/accruals/** | | |
| page.tsx | AccrualsPage |  |
| **app/finance/carryforward/** | | |
| page.tsx | ScreenPage |  |
| **app/finance/close-cockpit/** | | |
| page.tsx | ScreenPage |  |
| **app/finance/journal/new/** | | |
| page.tsx | PostJournalPage |  |
| **app/finance/subledger-tie-out/** | | |
| page.tsx | SubledgerTiePage |  |
| **app/finance/trial-balance/** | | |
| page.tsx | ScreenPage |  |
| **app/finance/vendor-ageing/** | | |
| page.tsx | VendorAgeingPage |  |
| **app/foundation/partners/** | | |
| actions.ts | savePartnerAction |  |
| company-actions.ts | saveSupplierCompanyAction |  |
| customer-company-actions.ts | saveCustomerCompanyAction |  |
| customer-partner-actions.ts | saveCustomerPartnerAction, changeCustomerPartnerStatusAction |  |
| customer-sales-area-actions.ts | saveCustomerSalesAreaAction |  |
| CustomerCompanyPanel.tsx | CustomerCompanyPanel |  |
| CustomerPartnerPanel.tsx | CustomerPartnerPanel |  |
| CustomerSalesAreaPanel.tsx | CustomerSalesAreaPanel |  |
| page.tsx | PartnersPage |  |
| partner-bank-profile-activation-actions.ts | activatePartnerBankProfileAction |  |
| partner-function-actions.ts | readSupplierPurchasingPartnerAssignmentsAction, saveSupplierPurchasingPartnerAction, removeSupplierPurchasingPartnerAction |  |
| PartnerBankDetailPanel.tsx | PartnerBankDetailPanel |  |
| PartnerBankMetadataPanel.tsx | PartnerBankMetadataPanel |  |
| PartnerBankProfileActivationPanel.tsx | PartnerBankProfileActivationPanel |  |
| PartnerForm.tsx | PartnerForm |  |
| purchasing-actions.ts | saveSupplierPurchasingAction |  |
| SupplierCompanyPanel.tsx | SupplierCompanyPanel |  |
| SupplierPartnerFunctionsPanel.tsx | SupplierPartnerFunctionsPanel |  |
| SupplierPurchasingPanel.tsx | SupplierPurchasingPanel |  |
| **app/foundation/partners/bank-profiles/** | | |
| page.tsx | PartnerBankProfilesPage |  |
| **modules/foundation/** | | |
| account-determination.ts | ACTIVITY, POSTING_EVENTS, postingEvent, listAccountDeterminations, listDeterminationCharts, listDeterminationValuationClasses, listGlAccountChoices, OBJECT_CLASS, determinationValuesSchema, determinationInputSchema, determinationDeleteInputSchema, AccountDeterminationError, saveAccountDetermination, deleteAccountDetermination | account_determination, chart_of_accounts, config_activity_status, gl_account, valuation_class |
| activity-price.ts | ACTIVITY_PRICE_CAPABILITY, ACTIVITY_PRICE_ROUTE, ACTIVITY_PRICE_OBJECT_CLASS, ActivityPriceError, calculateValuesSchema, calculateInputSchema, computePrices, previewActivityPrices, calculateActivityPrices, listCalculableActivities | activity_rate, activity_type, company_code, controlling_area_company, cost_center, cost_center_plan, gl_account |
| activity-rate-definition.ts | ACTIVITY, planningContext, listActivityRates, distinctCenters, distinctTypes, OBJECT_CLASS, activityRatesValuesSchema, activityRatesInputSchema, activityRateDeleteInputSchema, ActivityRateError, saveActivityRates, deleteActivityRate, countActivityRates, listActivityTypes, listCostCenterAreas, listCostCenters | activity_rate, activity_type, config_activity_status, controlling_area, cost_center, fiscal_year_period |
| activity-type-definition.ts | ACTIVITY, ACTIVITY_CATEGORIES, PRICE_INDICATORS, activityCategoryLabel, priceIndicatorLabel, parseValidCategories, canonicalValidCategories, listActivityTypes, listActivityUnits, OBJECT_CLASS, activityTypeValuesSchema, activityTypeInputSchema, activityTypeLockInputSchema, activityTypeDeleteInputSchema, ActivityTypeError, saveActivityType, setActivityTypePostingLock, deleteActivityType, listCostCenterAreas, COST_CENTER_CATEGORIES | activity_rate, activity_type, config_activity_status, controlling_area, unit_of_measure |
| bank-master.ts | CAPABILITY, OBJECT_CLASS, listBanks, listBankCountryChoices, bankValuesSchema, bankInputSchema, bankDeleteInputSchema, BankMasterError, saveBank, deleteBank | bank_master, country, house_bank |
| business-partner-schema.ts | industry, industryText, businessPartner, bpRole | bp_role, business_partner, industry, industry_text |
| business-partners.ts | PARTNER_ROLES, PartnerError, saveBusinessPartner, getBusinessPartner, listBusinessPartners, requireGeneralPartner | bp_role, business_partner, country |
| central-address-maintenance.ts | createCentralAddress | central_address |
| central-address-schema.ts | centralAddress | central_address |
| characteristic-definition.ts | ACTIVITY, DATA_FORMATS, CharacteristicError, listCharacteristics, saveCharacteristic, setCharacteristicStatus, deleteCharacteristic | characteristic, characteristic_value, class_assignment, currency, unit_of_measure |
| characteristic-schema.ts | characteristic, characteristicValue, classType, classificationClass, classAssignment, releaseGroup, releaseCode, releaseStrategy, releaseStrategyCriterion, releaseStrategyStep | characteristic, characteristic_value, class_assignment, class_type, classification_class, release_code, release_group, release_strategy, release_strategy_criterion, release_strategy_step |
| chart-of-accounts-maintenance.ts | chartOfAccountsValuesSchema, chartOfAccountsMaintenanceInputSchema, ChartOfAccountsMaintenanceError, chartOfAccountsF4Choices, listChartOfAccounts, saveChartOfAccounts, chartOfAccountsHasAccountsOrTransactions, groupChartOfAccountsValuesSchema, groupChartOfAccountsMaintenanceInputSchema, chartLifecycleInputSchema, groupLifecycleInputSchema, listGroupChartsOfAccounts, saveGroupChartOfAccounts, setChartOfAccountsActive, setGroupChartOfAccountsActive | change_document, chart_of_accounts, company_code, config_activity_status, document_index, gl_account, group_chart_of_accounts, journal_entry |
| class-definition.ts | ACTIVITY, CLASS_TYPE_DEFAULTS, ClassError, listClasses, saveClass, setClassStatus, deleteClass | characteristic, class_assignment, class_type, classification_class |
| company-code-assignments.ts | COMPANY_CODE_ASSIGNMENT_FIELDS, missingCompanyCodeAssignments, hasCompanyCodeAssignments, describeMissingCompanyCodeAssignments |  |
| company-code-coa-assignment.ts | companyCodeCoaAssignmentValuesSchema, companyCodeCoaAssignmentInputSchema, CompanyCodeCoaAssignmentError, assignCompanyCodeCoa | chart_of_accounts, company_code, config_activity_status |
| company-code-definition.ts | companyCodeDefinitionValuesSchema, companyCodeDefinitionInputSchema, CompanyCodeDefinitionError, defineCompanyCode | company_code, country, currency |
| constrained-kinds.ts | CONSTRAINED_KINDS, CLOSED_KINDS |  |
| constrained-values.ts | suggestConstrainedValues, CLOSED_KINDS, CONSTRAINED_KINDS | bp_role, business_partner, company_code, cost_center, currency, customer_company_code, gl_account, gl_account_company, material, material_plant, material_uom_conversion, parked_supplier_invoice, plant, profit_center, purchase_order, purchasing_group, purchasing_org, purchasing_org_plant, purchasing_quotation, purchasing_rfq, purchasing_rfq_event, storage_location, supplier_company_code, supplier_invoice, supplier_purchasing_org, tax_code, unit_of_measure |
| controlling-area-company-assignment.ts | controllingAreaCompanyAssignmentValuesSchema, controllingAreaCompanyAssignmentInputSchema, ControllingAreaCompanyAssignmentError, assignCompanyCodeToControllingArea, assignCompanyCodeToControllingAreaInTransaction, unassignCompanyCodeFromControllingArea | change_document, change_document_item, chart_of_accounts, company_code, controlling_area, controlling_area_company, fiscal_year_variant |
| controlling-area-company-compatibility.ts | ControllingAreaCompanyCompatibilityError, lockCompanyCodeOxxAssignments, assertCompanyCodeFinancialSettingsCompatible | chart_of_accounts, company_code, controlling_area, controlling_area_company, fiscal_year_variant |
| controlling-area-maintenance.ts | controllingAreaValuesSchema, controllingAreaMaintenanceInputSchema, ControllingAreaMaintenanceError, controllingAreaF4Choices, listControllingAreas, saveControllingArea, controllingAreaHasRecordedTransactions, lockControllingAreaForCompanyCode, getControllingAreaVersion | Currency, change_document, chart_of_accounts, company_code, config_activity_status, controlling_area, controlling_area_company, currency, document_index, fiscal_year_variant, journal_entry |
| cost-allocation-cycle.ts | ALLOCATION_DEFINE_CAPABILITY, ALLOCATION_EXECUTE_CAPABILITY, DISTRIBUTION_EXECUTE_CAPABILITY, ALLOCATION_CYCLE_ROUTE, ASSESSMENT_EVENT, ALLOCATION_DOCUMENT_TYPE, ALLOCATION_OBJECT_CLASS, ALLOCATION_RUN_OBJECT_CLASS, AllocationCycleError, executeCapabilityFor, listCycles, getCycle, saveCycle, setSegment, setSender, setReceiver, deleteCycle, allocateAmount, allocatePass, allocateGroups, previewAssessment, runAssessment, cancelAssessmentRun, listRuns, RECEIVER_RULES, ALLOCATION_CATEGORIES | account_determination, controlling_area, controlling_area_company, cost_allocation_cycle, cost_allocation_receiver, cost_allocation_run, cost_allocation_segment, cost_allocation_sender, cost_center, cost_center_group, cost_center_group_leaf, currency, journal_entry, journal_entry_line |
| cost-center-definition.ts | ACTIVITY, COST_CENTER_CATEGORIES, isCostCenterCategory, listCostCenterAreas, listCostCenters, listAreaCompanyCodes, OBJECT_CLASS, costCenterValuesSchema, costCenterInputSchema, costCenterLockInputSchema, costCenterDeleteInputSchema, CostCenterError, countCostCenterDocuments, saveCostCenter, setCostCenterPostingLock, deleteCostCenter | activity_rate, config_activity_status, controlling_area, controlling_area_company, cost_center, cost_center_node_assignment, journal_entry, journal_entry_line |
| cost-center-hierarchy.ts | ACTIVITY, MAX_HIERARCHY_DEPTH, flattenNodes, resolveGroupMembers, listHierarchy, OBJECT_CLASS_NODE, OBJECT_CLASS_ASSIGNMENT, OBJECT_CLASS_GROUP, OBJECT_CLASS_LEAF, CostCenterHierarchyError, hierarchyHeaderInputSchema, saveHierarchyHeader, hierarchyNodeInputSchema, saveHierarchyNode, hierarchyDeleteInputSchema, deleteHierarchyNode, periodPlacementInputSchema, placeCostCenterPeriod, unplaceCostCenterPeriod, costCenterGroupInputSchema, saveCostCenterGroup, costCenterGroupDeleteInputSchema, deleteCostCenterGroup, groupLeafInputSchema, addGroupLeaf, removeGroupLeaf, listCostCenterAreas | config_activity_status, controlling_area, cost_center, cost_center_group, cost_center_group_leaf, cost_center_hierarchy, cost_center_node, cost_center_node_assignment |
| cost-center-planning.ts | COST_CENTER_PLANNING_CAPABILITY, COST_CENTER_PLANNING_ROUTE, COST_CENTER_PLANNING_OBJECT_CLASS, DEFAULT_PLAN_VERSION, CostCenterPlanningError, costCenterPlanValuesSchema, saveCostCenterPlanSchema, spreadAnnualTotal, listCostCentersFor, planningGrid, saveCostCenterPlan, listPlanningAreas, planningCurrencyDecimals | change_document, company_code, controlling_area, controlling_area_company, cost_center, cost_center_plan, currency, gl_account, gl_account_company, journal_entry, journal_entry_line |
| cost-center-report.ts | COST_CENTER_REPORT_CAPABILITY, DEFAULT_PLAN_VERSION, CostCenterReportError, calculateCostCenterReport | activity_rate, controlling_area, controlling_area_company, cost_center, cost_center_group, cost_center_group_leaf, cost_center_node, cost_center_node_assignment, cost_center_plan, gl_account, journal_entry, journal_entry_line |
| customer-companies.ts | CustomerCompanyError, normalizeInterestIndicator, normalizeToleranceGroup, saveCustomerCompany, getCustomerCompany, listCustomerCompanies, requireCustomerCompany, customerCompanyChoices | bp_role, business_partner, company_code, customer_company_code, gl_account, journal_entry_line, payment_terms |
| customer-company-schema.ts | customerCompany | customer_company_code |
| customer-sales-area-schema.ts | customerSalesArea | customer_sales_area |
| customer-sales-areas.ts | CustomerSalesAreaError, saveCustomerSalesArea, getCustomerSalesArea, listCustomerSalesAreas, requireCustomerSalesArea, customerSalesAreaChoices | bp_role, business_partner, company_code, customer_sales_area, plant, sales_area, sales_org, sales_org_text, shipping_condition |
| distribution-channel-division-maintenance.ts | distributionChannelDefinitionValuesSchema, divisionDefinitionValuesSchema, distributionChannelMaintenanceInputSchema, divisionMaintenanceInputSchema, distributionChannelDeactivationInputSchema, divisionDeactivationInputSchema, DistributionDimensionMaintenanceError, saveDistributionChannelDefinition, saveDivisionDefinition, deactivateDistributionChannel, deactivateDivision, getDistributionChannelDefinitionVersion, getDivisionDefinitionVersion | change_document, distribution_channel, division, sales_area, sales_org_distribution_channel, sales_org_division |
| document-type-definition.ts | ACTIVITY, listDocumentTypes, listIntervalChoices, OBJECT_CLASS, ACCOUNT_TYPE_LETTERS, REVERSAL_MODES, documentTypeValuesSchema, documentTypeInputSchema, documentTypeDeleteInputSchema, documentTypeActiveInputSchema, DocumentTypeError, saveDocumentType, setDocumentTypeActive, deleteDocumentType | config_activity_status, document_type, journal_entry, number_range |
| employee-tolerance-definition.ts | ACTIVITY, listEmployeeToleranceGroups, listToleranceCompanies, OBJECT_CLASS, toleranceGroupValuesSchema, toleranceGroupInputSchema, ToleranceGroupError, saveEmployeeToleranceGroup | company_code, config_activity_status, employee_tolerance_group |
| exchange-rate-maintenance.ts | ACTIVITY, RATE_TYPES, listExchangeRates, listCurrencyChoices, OBJECT_CLASS, exchangeRateValuesSchema, exchangeRateInputSchema, exchangeRateDeleteInputSchema, ExchangeRateError, saveExchangeRate, deleteExchangeRate | config_activity_status, currency, exchange_rate |
| factory-calendar-constants.ts | WEEKDAYS |  |
| factory-calendar.ts | FACTORY_CALENDAR_ROUTE, FACTORY_CALENDAR_CAPABILITY, FactoryCalendarError, addDaysIso, weekdayIndex, countWorkingDays, workingDaysBetween, isWorkingDay, loadFactoryCalendars, sampleMonth, saveCalendarPeriod, deleteCalendarPeriod, saveHolidayCalendar, deleteHolidayCalendar, addHolidayDay, removeHolidayDay, WEEKDAYS | factory_calendar, factory_calendar_period, holiday_calendar, holiday_calendar_day |
| fiscal-year-variant-assignment.ts | fiscalYearVariantAssignmentValuesSchema, fiscalYearVariantAssignmentInputSchema, FiscalYearVariantAssignmentError, assignFiscalYearVariant, describePostedYears | company_code, config_activity_status, fiscal_year_variant, journal_entry |
| fiscal-year-variant-maintenance.ts | FiscalYearVariantError, listFiscalYearVariants, fiscalYearVariantChoices, saveFiscalYearVariant, setFiscalYearVariantActive, saveFiscalYearPeriods | company_code, controlling_area, fiscal_year_period, fiscal_year_variant |
| house-bank-definition.ts | ACTIVITY, listHouseBanks, listHouseBankCompanies, listBankChoices, HOUSE_BANK_OBJECT_CLASS, BANK_ACCOUNT_OBJECT_CLASS, listHouseBankCurrencies, listGlAccountChoices, houseBankValuesSchema, houseBankInputSchema, houseBankDeleteInputSchema, bankAccountValuesSchema, bankAccountInputSchema, bankAccountDeleteInputSchema, HouseBankError, saveHouseBank, deleteHouseBank, saveBankAccount, deleteBankAccount | bank_account, bank_master, company_code, config_activity_status, currency, gl_account, house_bank |
| industry-definition.ts | ACTIVITY, IndustryError, INDUSTRY_DEFAULTS, listIndustries, saveIndustry, setIndustryActive, deleteIndustry | business_partner, industry, industry_text |
| internal-order-budget-display.ts | displayOriginalBudget |  |
| internal-order-budget.ts | ORIGINAL_BUDGET_CHANGE_CAPABILITY, ORIGINAL_BUDGET_DISPLAY_CAPABILITY, ORIGINAL_BUDGET_ROUTE, ORIGINAL_BUDGET_OBJECT_CLASS, InternalOrderBudgetError, saveBudgetProfile, assignOrderTypeBudgetProfile, getOriginalBudget, changeOriginalBudget | controlling_area, internal_order, internal_order_budget_profile, internal_order_original_budget, internal_order_original_budget_year, internal_order_type_budget_profile, journal_entry_line, number_range |
| internal-order-cost-report.ts | INTERNAL_ORDER_COST_REPORT_CAPABILITY, INTERNAL_ORDER_COST_REPORT_ROUTE, INTERNAL_ORDER_MAINTAIN_ROUTE, InternalOrderCostReportError, holdsInternalOrderCostReportAuthority, getInternalOrderCostReport | internal_order, journal_entry, journal_entry_line |
| internal-order-display.ts | displayInternalOrder |  |
| internal-order.ts | INTERNAL_ORDER_MAINTAIN_CAPABILITY, INTERNAL_ORDER_DISPLAY_CAPABILITY, INTERNAL_ORDER_OBJECT_CLASS, INTERNAL_ORDER_ROUTE, InternalOrderError, createInternalOrder, changeInternalOrder, getInternalOrder, listInternalOrders, internalOrderChoices | app_user, company_code, controlling_area, controlling_area_company, cost_center, internal_order, internal_order_type, journal_entry, journal_entry_line, profit_center |
| number-ranges.ts | NUMBER_OBJECTS, NUMBER_RANGE_ACTIVITY, NUMBER_OBJECT_DEFAULTS, seedNumberRangeObjects, rangeKey, listNumberRanges, journalRangeReadiness, maintainNumberRange, rangeAllocations, listNumberRangeObjects, saveNumberRangeObject, adjustNumberRangeCurrent | company_code, config_activity_status, document_type, number_range, number_range_allocation, number_range_object |
| order-settlement.ts | ORDER_SETTLEMENT_CAPABILITY, ORDER_SETTLEMENT_COLLECTIVE_CAPABILITY, ORDER_SETTLEMENT_ROUTE, ORDER_SETTLEMENT_COLLECTIVE_ROUTE, OrderSettlementError, orderSettlementPosting, settleOrder, settleOrdersCollective | allocation_structure_assignment, company_code, controlling_area, cost_center, fiscal_year_period, fiscal_year_variant, gl_account, internal_order, internal_order_type, internal_order_type_settlement_profile, journal_entry, journal_entry_line, settlement_distribution_rule, settlement_document, settlement_profile |
| output-notify.ts | OUTPUT_ACTOR, SALES_OUTPUT_NOTIFICATION_CLASS, MATERIAL_DOC_OUTPUT_NOTIFICATION_CLASS, enqueueOutputFailed |  |
| output-schema.ts | OUTPUT_APPLICATIONS, OUTPUT_DOCUMENT_CATEGORIES, OUTPUT_MEDIA, DISPATCH_TIMES, OUTPUT_STATUSES, OUTPUT_STATUS_ALIASES, OUTPUT_PARTNER_FUNCTIONS, outputType, outputConditionRecord, outputMessage, documentLayout | document_layout, output_condition_record, output_message, output_type |
| partner-bank-country-profile-schema.ts | partnerBankCountryProfile | partner_bank_country_profile |
| partner-bank-detail-view.ts | getPartnerBankMaskedDetail | partner_bank |
| partner-bank-profile-activation-audit-schema.ts | partnerBankProfileActivationAudit | partner_bank_profile_activation_audit |
| partner-bank-profile-activation-view.ts | resolvePartnerBankProfileActivationRows, listPartnerBankProfileActivationRows | country, partner_bank_country_profile |
| partner-bank-profile-activation.ts | createPartnerBankProfileActivationService, activatePartnerBankProfile |  |
| partner-bank-profile-readiness.ts | createPartnerBankProfileReadinessReader, readPartnerBankProfileReadiness | partner_bank_country_profile |
| partner-bank-reads.ts | PARTNER_BANK_METADATA_DISPLAY_CAPABILITY, PartnerBankMetadataAccessError, lookupPartnerBankMetadata, listPartnerBankMetadata | partner_bank |
| partner-bank-schema.ts | partnerBank | partner_bank |
| payment-method-schema.ts | PAYMENT_METHOD_DIRECTIONS, paymentMethod | payment_method |
| payment-methods.ts | PaymentMethodReadError, PaymentMethodError, getPaymentMethod, listPaymentMethods, savePaymentMethod, retirePaymentMethod | country, payment_method |
| payment-term-dates.ts | BASELINE_SOURCES, calendarDate, calculatePaymentSchedule |  |
| payment-terms-schema.ts | paymentTerms | payment_terms |
| payment-terms.ts | PaymentTermsError, savePaymentTerms, listPaymentTerms, getPaymentTerms, paymentSchedule, STANDARD_PAYMENT_TERMS, applyPaymentTermDefaults | payment_terms |
| plan-revaluation.ts | PLAN_REVALUATION_CAPABILITY, PLAN_REVALUATION_ROUTE, PLAN_REVALUATION_OBJECT_CLASS, PLAN_REVALUATION_NOT_EXECUTED, PlanRevaluationError, planRevaluationEligibility, getPlanRevaluationOrder, createPlanRevaluationOrder | controlling_area, fiscal_year_variant, internal_order, number_range, plan_revaluation_order, plan_revaluation_order_item |
| plant-company-code-assignment.ts | plantCompanyCodeAssignmentValuesSchema, plantCompanyCodeAssignmentInputSchema, PlantCompanyCodeAssignmentError, assignPlantCompanyCode | company_code, config_activity_status, plant |
| plant-maintenance.ts | plantDefinitionValuesSchema, plantDefinitionModeSchema, plantMaintenanceInputSchema, PlantMaintenanceError, getPlantDefinitionVersion, savePlantDefinition | change_document, country, plant |
| posting-period-variant-assignment.ts | ACTIVITY, listPostingPeriodVariantAssignments, postingPeriodVariantAssignmentValuesSchema, postingPeriodVariantAssignmentInputSchema, PostingPeriodVariantAssignmentError, assignPostingPeriodVariant | company_code, config_activity_status, journal_entry, posting_period_variant |
| posting-period-variant-definition.ts | ACTIVITY, OBJECT_CLASS, INTERVAL_OBJECT_CLASS, DEFAULT_INTERVALS, describeInterval, describeUsedBy, listPostingPeriodVariants, postingPeriodVariantValuesSchema, postingPeriodVariantInputSchema, postingPeriodVariantDeleteInputSchema, PostingPeriodVariantError, describeIntervalSet, savePostingPeriodVariant, deletePostingPeriodVariant | company_code, config_activity_status, posting_period_rule, posting_period_variant |
| profit-center-definition.ts | ACTIVITY, listProfitCenters, listResponsibleUsers, OBJECT_CLASS, profitCenterValuesSchema, profitCenterInputSchema, profitCenterLockInputSchema, profitCenterDeleteInputSchema, ProfitCenterError, countProfitCenterDocuments, saveProfitCenter, setProfitCenterPostingLock, deleteProfitCenter, listCostCenterAreas | app_user, config_activity_status, controlling_area, journal_entry, journal_entry_line, profit_center, profit_center_node_assignment |
| profit-center-hierarchy.ts | ACTIVITY, MAX_HIERARCHY_DEPTH, flattenNodes, resolveGroupMembers, listHierarchy, OBJECT_CLASS_NODE, OBJECT_CLASS_ASSIGNMENT, OBJECT_CLASS_GROUP, OBJECT_CLASS_LEAF, ProfitCenterHierarchyError, hierarchyHeaderInputSchema, saveHierarchyHeader, hierarchyNodeInputSchema, saveHierarchyNode, hierarchyDeleteInputSchema, deleteHierarchyNode, periodPlacementInputSchema, placeProfitCenterPeriod, unplaceProfitCenterPeriod, profitCenterGroupInputSchema, saveProfitCenterGroup, profitCenterGroupDeleteInputSchema, deleteProfitCenterGroup, groupLeafInputSchema, addGroupLeaf, removeGroupLeaf, listCostCenterAreas | config_activity_status, controlling_area, profit_center, profit_center_group, profit_center_group_leaf, profit_center_hierarchy, profit_center_node, profit_center_node_assignment |
| profit-center-report.ts | PROFIT_CENTER_REPORT_CAPABILITY, LEADING_LEDGER, DEFAULT_MAX_HITS, MAX_HITS_CAP, ProfitCenterReportError, listProfitCenterLines, profitCenterLinesCsv | controlling_area, controlling_area_company, journal_entry, journal_entry_line, profit_center, profit_center_group, profit_center_group_leaf |
| purchasing-group-maintenance.ts | purchasingGroupDefinitionValuesSchema, purchasingGroupChangeSetSchema, PurchasingGroupMaintenanceError, listPurchasingGroupDefinitions, getPurchasingGroupDefinitionVersion, savePurchasingGroupChanges | change_document, purchasing_group |
| purchasing-org-company-code-assignment.ts | purchasingOrgCompanyCodeAssignmentValuesSchema, purchasingOrgCompanyCodeAssignmentInputSchema, PurchasingOrgCompanyCodeAssignmentError, readPurchasingOrgCompanyCodeAssignment, assignPurchasingOrgCompanyCode | company_code, config_activity_status, purchasing_org |
| purchasing-org-maintenance.ts | purchasingOrgDefinitionValuesSchema, purchasingOrgMaintenanceModeSchema, purchasingOrgMaintenanceInputSchema, purchasingOrgDeactivationInputSchema, PurchasingOrgMaintenanceError, getPurchasingOrgDefinitionVersion, savePurchasingOrgDefinition, deactivatePurchasingOrg | change_document, purchasing_org |
| purchasing-org-plant.ts | PURCH_ORG_PLANT_NOT_AUTHORIZED, PurchasingOrgPlantAuthorizationError, purchasingOrgMayBuyForPlant, assertPurchasingOrgForPlant | plant, purchasing_org, purchasing_org_plant |
| release-categories.ts | RELEASE_CATEGORY_LABELS |  |
| release-strategy-definition.ts | ACTIVITY, RELEASE_ATTRIBUTES, CATEGORY_CLASS_TYPE, ReleaseStrategyError, listReleaseConfiguration, saveReleaseGroup, deleteReleaseGroup, saveReleaseStrategy, setReleaseStrategyStatus, deleteReleaseStrategy, criterionMatches, determineRelease, RELEASE_CATEGORY_LABELS | characteristic, characteristic_value, class_assignment, classification_class, release_code, release_group, release_strategy, release_strategy_criterion, release_strategy_step |
| report-exports.ts | costCenterReportExport, profitCenterReportExport, FOUNDATION_REPORT_EXPORTS |  |
| retained-earnings-vocabulary.ts | RETAINED_EARNINGS_ACTIVITY, RETAINED_EARNINGS_ROUTE, RETAINED_EARNINGS_EVENT, STANDARD_RETAINED_EARNINGS_INDICATOR |  |
| retained-earnings.ts | RetainedEarningsError, listRetainedEarnings, maintainRetainedEarnings, deleteRetainedEarnings, *./retained-earnings-vocabulary | account_determination, chart_of_accounts, gl_account |
| sales-area-maintenance.ts | salesAreaValuesSchema, salesAreaMaintenanceInputSchema, salesAreaKeyInputSchema, SalesAreaMaintenanceError, salesAreaF4Choices, listSalesAreas, saveSalesArea, deactivateSalesArea, reactivateSalesArea, getSalesAreaVersion | change_document, config_activity_status, customer_sales_area, distribution_channel, division, sales_area, sales_org, sales_org_distribution_channel, sales_org_division, sales_org_text |
| sales-org-company-code-assignment.ts | salesOrgCompanyCodeAssignmentValuesSchema, salesOrgCompanyCodeAssignmentInputSchema, SalesOrgCompanyCodeAssignmentError, assignSalesOrgCompanyCode | company_code, config_activity_status, sales_org |
| sales-org-distribution-channel-assignment.ts | salesOrgDistributionChannelValuesSchema, salesOrgDistributionChannelAssignmentInputSchema, SalesOrgDistributionChannelAssignmentError, lockSalesOrgDistributionChannelPair, salesOrgDistributionChannelF4Choices, listSalesOrgDistributionChannelAssignments, assignSalesOrgDistributionChannel, unassignSalesOrgDistributionChannel | config_activity_status, distribution_channel, sales_area, sales_org, sales_org_distribution_channel |
| sales-org-division-assignment.ts | salesOrgDivisionValuesSchema, salesOrgDivisionAssignmentInputSchema, SalesOrgDivisionAssignmentError, lockSalesOrgDivisionPair, salesOrgDivisionF4Choices, listSalesOrgDivisionAssignments, assignSalesOrgDivision, unassignSalesOrgDivision | config_activity_status, division, sales_area, sales_org, sales_org_division |
| sales-organization-maintenance.ts | salesOrgAddressValuesSchema, salesOrgDefinitionValuesSchema, salesOrgMaintenanceModeSchema, salesOrgMaintenanceInputSchema, salesOrgDeactivationInputSchema, SalesOrgMaintenanceError, getSalesOrgDefinitionVersion, saveSalesOrgDefinition, deactivateSalesOrg | bp_role, business_partner, central_address, change_document, country, currency, customer_sales_area, factory_calendar, purchasing_org, sales_area, sales_org, sales_org_distribution_channel, sales_org_division, sales_org_text |
| schema.ts | groupChartOfAccounts, chartOfAccounts, fiscalYearVariant, fiscalYearPeriod, postingPeriodVariant, postingPeriodRule, companyCode, plant, storageLocation, purchasingOrg, purchasingOrgPlant, purchasingGroup, factoryCalendar, holidayCalendar, holidayCalendarDay, factoryCalendarPeriod, salesOrg, salesOrgText, distributionChannel, salesOrgDistributionChannel, division, salesOrgDivision, salesArea, controllingArea, controllingAreaCompany, costCenter, costCenterHierarchy, costCenterNode, costCenterNodeAssignment, costCenterGroup, costCenterGroupLeaf, profitCenterHierarchy, profitCenterNode, profitCenterNodeAssignment, profitCenterGroup, profitCenterGroupLeaf, activityType, activityRate, profitCenter, creditControlArea, exchangeRate, houseBank, bankAccount, taxCode, specialGlConfig, accountDetermination, documentType, employeeToleranceGroup, costCenterPlan, internalOrderType, internalOrder, settlementProfile, internalOrderTypeSettlementProfile, allocationStructure, allocationStructureAssignment, settlementDistributionRule, settlementDocument, internalOrderBudgetProfile, internalOrderTypeBudgetProfile, internalOrderOriginalBudget, internalOrderOriginalBudgetYear, planRevaluationOrder, planRevaluationOrderItem, ALLOCATION_CATEGORIES, SENDER_RULES, RECEIVER_RULES, ALLOCATION_RUN_STATUSES, costAllocationCycle, costAllocationSegment, costAllocationSender, costAllocationReceiver, costAllocationRun, *./payment-terms-schema, *./payment-method-schema, *./business-partner-schema, *./partner-bank-schema, *./partner-bank-country-profile-schema, *./partner-bank-profile-activation-audit-schema, *./supplier-company-schema, *./supplier-purchasing-schema, *./supplier-partner-schema, *./customer-company-schema, *./customer-sales-area-schema, *./central-address-schema | account_determination, activity_rate, activity_type, allocation_structure, allocation_structure_assignment, bank_account, chart_of_accounts, company_code, controlling_area, controlling_area_company, cost_allocation_cycle, cost_allocation_receiver, cost_allocation_run, cost_allocation_segment, cost_allocation_sender, cost_center, cost_center_group, cost_center_group_leaf, cost_center_hierarchy, cost_center_node, cost_center_node_assignment, cost_center_plan, credit_control_area, distribution_channel, division, document_type, employee_tolerance_group, exchange_rate, factory_calendar, factory_calendar_period, fiscal_year_period, fiscal_year_variant, group_chart_of_accounts, holiday_calendar, holiday_calendar_day, house_bank, internal_order, internal_order_budget_profile, internal_order_original_budget, internal_order_original_budget_year, internal_order_type, internal_order_type_budget_profile, internal_order_type_settlement_profile, plan_revaluation_order, plan_revaluation_order_item, plant, posting_period_rule, posting_period_variant, profit_center, profit_center_group, profit_center_group_leaf, profit_center_hierarchy, profit_center_node, profit_center_node_assignment, purchasing_group, purchasing_org, purchasing_org_plant, sales_area, sales_org, sales_org_distribution_channel, sales_org_division, sales_org_text, settlement_distribution_rule, settlement_document, settlement_profile, special_gl_config, storage_location, tax_code |
| services.ts | ConfigError, listCompanyCodes, getCompanyCodeDetail, upsertCompanyCode, listGlAccounts, upsertGlAccount, setGlAccountBlocks, deleteGlAccount, glAccountUsage, glAccountAuditVersion, listPeriodRules, updatePeriodRule, listPlants, listConfigurationChoices, withTenant | account_determination, change_document, chart_of_accounts, company_code, customer_company_code, fiscal_year_variant, gl_account, gl_account_group, journal_entry_line, plant, posting_period_rule, storage_location, supplier_company_code |
| settlement-configuration-keys.ts | SETTLEMENT_CONFIG_ACTIVITY, SETTLEMENT_CONFIG_ROUTE, SETTLEMENT_CONFIG_LOCKS, settlementConfigArgument, settlementConfigLock, settlementConfigAdvisoryKey |  |
| settlement-configuration-masters.ts | SETTLEMENT_CONFIG_CAPABILITY, allocationStructureInputSchema, allocationAssignmentInputSchema, allocationAssignmentKeyInputSchema, settlementProfileInputSchema, orderTypeSettlementProfileInputSchema, orderTypeSettlementProfileKeyInputSchema, SettlementMastersError, listSettlementProfileDocumentTypes, listAllocationStructures, getAllocationStructure, saveAllocationStructure, saveAllocationStructureAssignment, removeAllocationStructureAssignment, listSettlementProfiles, getSettlementProfile, saveSettlementProfile, listOrderTypeSettlementProfiles, assignOrderTypeSettlementProfile, removeOrderTypeSettlementProfile, structureDependents, SETTLEMENT_CONFIG_ACTIVITY, SETTLEMENT_CONFIG_LOCKS, SETTLEMENT_CONFIG_ROUTE, settlementConfigLock | allocation_structure, allocation_structure_assignment, change_document, document_type, gl_account, internal_order, internal_order_type, internal_order_type_settlement_profile, journal_entry, journal_entry_line, settlement_distribution_rule, settlement_document, settlement_profile |
| settlement-configuration.ts | SETTLEMENT_RULE_CAPABILITY, SETTLEMENT_RULE_ROUTE, SHARED_MASTER_FIELDS, SettlementConfigurationError, getSettlementConfiguration, lockSettlementRuleForOrder, saveOrderSettlementConfiguration | allocation_structure_assignment, company_code, cost_center, gl_account, internal_order, internal_order_type_settlement_profile, settlement_distribution_rule, settlement_document, settlement_profile |
| special-gl.ts | SPECIAL_GL_ACTIVITY, SpecialGlError, listSpecialGlConfigs, maintainSpecialGlConfig, deleteSpecialGlConfig | gl_account, special_gl_config, vendor_down_payment |
| standard-config.ts | STANDARD_PACKAGE_VERSION, STANDARD_ACCOUNT_GROUP, STANDARD_STATEMENT_VERSION, applyStandardPackage | account_determination, asset_class, asset_transaction_type, chart_of_accounts, depreciation_area, depreciation_key, distribution_channel, division, document_type, exchange_rate, financial_statement_assignment, financial_statement_node, financial_statement_version, fiscal_year_period, fiscal_year_variant, gl_account, gl_account_group, incompletion_group, posting_period_rule, posting_period_variant, purchasing_group, reversal_reason, sales_account_determination, sales_billing_plan_type, sales_condition_type, sales_document_type, sales_partner_function, sales_pricing_procedure, sales_pricing_procedure_step, sales_procedure_determination, sales_returns_configuration, supplier_partner_function |
| storage-location-maintenance.ts | storageLocationDefinitionValuesSchema, storageLocationMaintenanceModeSchema, storageLocationMaintenanceInputSchema, storageLocationDeactivationInputSchema, StorageLocationMaintenanceError, getStorageLocationVersion, saveStorageLocation, deactivateStorageLocation | change_document, plant, storage_location |
| supplier-companies.ts | SupplierCompanyError, normalizeSupplierPaymentMethods, assertSupplierPaymentMethodEligibility, saveSupplierCompany, getSupplierCompany, listSupplierCompanies, requireSupplierCompany, supplierCompanyChoices | bp_role, business_partner, company_code, gl_account, journal_entry_line, payment_method, payment_terms, supplier_company_code |
| supplier-company-schema.ts | supplierCompany | supplier_company_code |
| supplier-partner-schema.ts | SUPPLIER_PARTNER_FUNCTION_CODES, supplierPartnerFunction, supplierPurchasingPartner | supplier_partner_function, supplier_purchasing_partner |
| supplier-purchasing-partner-writes.ts | SupplierPurchasingPartnerError, saveSupplierPurchasingPartner, removeSupplierPurchasingPartner | bp_role, business_partner, purchasing_org, supplier_partner_function, supplier_purchasing_org, supplier_purchasing_partner |
| supplier-purchasing-partners.ts | listSupplierPartnerFunctions, listSupplierPartnerChoices, listSupplierPurchasingPartners | bp_role, business_partner, supplier_partner_function, supplier_purchasing_partner |
| supplier-purchasing-schema.ts | supplierPurchasing | supplier_purchasing_org |
| supplier-purchasing.ts | DELIVERY_TERMS, SupplierPurchasingError, saveSupplierPurchasing, getSupplierPurchasing, listSupplierPurchasing, requireSupplierPurchasing, supplierPurchasingChoices | bp_role, business_partner, company_code, currency, payment_terms, plant, purchasing_group, purchasing_org, supplier_purchasing_org |
| tax-code-definition.ts | ACTIVITY, listTaxCodes, listCountryChoices, OBJECT_CLASS, taxCodeValuesSchema, taxCodeInputSchema, taxCodeDeleteInputSchema, TaxCodeError, saveTaxCode, deleteTaxCode | config_activity_status, country, journal_entry_line, tax_code |

## Routes (66)
`/config/account-determination` · `/config/activity-rates` · `/config/activity-types` · `/config/banks` · `/config/characteristics` · `/config/classes` · `/config/company-codes` · `/config/company-codes/assign-chart-of-accounts` · `/config/controlling-area` · `/config/controlling-area/assign-company-code` · `/config/cost-center-hierarchy` · `/config/cost-centers` · `/config/distribution-channels` · `/config/divisions` · `/config/document-types` · `/config/exchange-rates` · `/config/factory-calendars` · `/config/house-banks` · `/config/industries` · `/config/mrp-controllers` · `/config/number-range-objects` · `/config/number-ranges` · `/config/payment-methods` · `/config/payment-terms` · `/config/plants` · `/config/posting-period-variants` · `/config/posting-period-variants/assign-company-codes` · `/config/posting-periods` · `/config/profit-center-hierarchy` · `/config/profit-centers` · `/config/purchasing-groups` · `/config/release-strategies` · `/config/retained-earnings` · `/config/sales-areas` · `/config/sales-orgs` · `/config/sales-orgs/assign-company` · `/config/sales-orgs/assign-distribution-channel` · `/config/sales-orgs/assign-division` · `/config/settlement-configuration` · `/config/special-gl` · `/config/storage-locations` · `/config/tax-codes` · `/config/tolerance-groups` · `/controlling/allocation-cycles` · `/controlling/cost-center-planning` · `/controlling/cost-center-report` · `/controlling/internal-order-display` · `/controlling/internal-order-line-items` · `/controlling/internal-orders` · `/controlling/order-settlement-collective` · `/controlling/order-settlement` · `/controlling/original-budget-display` · `/controlling/original-budget` · `/controlling/plan-revaluation` · `/controlling/profit-center-report` · `/controlling/profit-center-report/export` · `/controlling/settlement-rules` · `/finance/accruals` · `/finance/carryforward` · `/finance/close-cockpit` · `/finance/journal/new` · `/finance/subledger-tie-out` · `/finance/trial-balance` · `/finance/vendor-ageing` · `/foundation/partners` · `/foundation/partners/bank-profiles`

## Tables owned (98)
account_determination, activity_rate, activity_type, allocation_structure, allocation_structure_assignment, bank_account, bp_role, business_partner, central_address, characteristic, characteristic_value, chart_of_accounts, class_assignment, class_type, classification_class, company_code, controlling_area, controlling_area_company, cost_allocation_cycle, cost_allocation_receiver, cost_allocation_run, cost_allocation_segment, cost_allocation_sender, cost_center, cost_center_group, cost_center_group_leaf, cost_center_hierarchy, cost_center_node, cost_center_node_assignment, cost_center_plan, credit_control_area, customer_company_code, customer_sales_area, distribution_channel, division, document_layout, document_type, employee_tolerance_group, exchange_rate, factory_calendar, factory_calendar_period, fiscal_year_period, fiscal_year_variant, group_chart_of_accounts, holiday_calendar, holiday_calendar_day, house_bank, industry, industry_text, internal_order, internal_order_budget_profile, internal_order_original_budget, internal_order_original_budget_year, internal_order_type, internal_order_type_budget_profile, internal_order_type_settlement_profile, output_condition_record, output_message, output_type, partner_bank, partner_bank_country_profile, partner_bank_profile_activation_audit, payment_method, payment_terms, plan_revaluation_order, plan_revaluation_order_item, plant, posting_period_rule, posting_period_variant, profit_center, profit_center_group, profit_center_group_leaf, profit_center_hierarchy, profit_center_node, profit_center_node_assignment, purchasing_group, purchasing_org, purchasing_org_plant, release_code, release_group, release_strategy, release_strategy_criterion, release_strategy_step, sales_area, sales_org, sales_org_distribution_channel, sales_org_division, sales_org_text, settlement_distribution_rule, settlement_document, settlement_profile, special_gl_config, storage_location, supplier_company_code, supplier_partner_function, supplier_purchasing_org, supplier_purchasing_partner, tax_code

## Depends on
finance, inventory, output, platform/auth, platform/change, platform/db, platform/i18n, platform/job, platform/lock, platform/notification, platform/numbering, platform/periods, platform/posting, platform/security, platform/tables, platform/tenancy, sales, ui/fields, ui/kit, ui/lock, ui/output

## Used by
dev/walkthrough-volume.ts, finance, inventory, output, people, platform, platform/attention, platform/periods, platform/posting, platform/tenancy, production, purchasing, sales, ui/fields

## Tests (79)
activity-price, asset-acquisition, asset-depreciation, asset-retirement, batch-class, batch-management-img, batch-number-range, batch-sort-sequence, business-partners, capacity-load, characteristic-definition, class-definition, company-code-assignments, company-code-coa-assignment-contract, company-code-definition-contract, config-settlement-master-contract, controlling-area-company-assignment-contract, controlling-area-ui-contract, controlling-settlement-concurrency, controlling-settlement-reversal-contract, controlling-settlement-rule-contract, cost-allocation-cycle, cost-allocation-distribution, cost-center-planning, cost-center-report, credit-control-area-atomicity, credit-control-area-maintenance, customer-companies, customer-down-payment, customer-sales-areas, document-reversal, factory-calendar, finance-release, industry-definition, internal-order-budget, internal-order-cost-report, internal-order, invoice-account-assignment, material-number-range-groups, number-range-objects, order-settlement, parked-invoice, partner-bank-detail-panel, partner-bank-detail-view, partner-bank-panel, partner-bank-profile-activation-panel, partner-bank-profile-activation-service, partner-bank-profile-activation-view, partner-bank-profile-readiness-service, partner-bank-reads, partner-display-page-auth, payment-terms, payroll-background, payroll-followup, payroll-posting, plan-revaluation, plant-company-code-assignment-contract, plant-maintenance-contract, production-activity-costing, production-order-bom, production-order-settlement, production-order-wip, profit-center-report, purchasing-org-plant-assignment, quotation-comparison, release-acts, release-strategy-definition, release-waiting, salary-payment, sales-delivery-terms, sales-output, standard-structure-builder, statement-version-onboarding, supplier-companies, supplier-purchasing-partner-writes, supplier-purchasing-partners, supplier-purchasing, vendor-down-payment, work-center
