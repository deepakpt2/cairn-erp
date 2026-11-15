# Foundation

**Purpose:** Enterprise structure/master data (business partners/customers/suppliers, bank master data, company codes, plants, purchasing orgs, sales orgs, payment terms/methods, tax codes, document types, number ranges, IMG config) + Controlling master data/reporting (controlling areas, cost/profit centers, internal orders, settlement config, plan revaluation). Bundles two SAP sub-areas (Enterprise Structure/Master Data OX-series + Controlling CO-OM): both "define once, reference everywhere" config. Largest module, 270 files.

## Files

### Business partners & bank master data
- `src/modules/foundation/business-partner-schema.ts` — global BP schema. Tables: `industry`, `industryText`, `businessPartner`, `bpRole`.
- `src/modules/foundation/business-partners.ts` — BP CRUD/role maintenance. Exports: `PARTNER_ROLES`, `PartnerError`, `saveBusinessPartner`, `getBusinessPartner`, `listBusinessPartners`, `requireGeneralPartner`.
- `src/modules/foundation/central-address-schema.ts` — Central Address Mgmt schema. Table: `centralAddress`.
- `src/modules/foundation/central-address-maintenance.ts` — Exports: `createCentralAddress`.
- `src/modules/foundation/customer-company-schema.ts` — Table: `customerCompany` (`customer_company_code`).
- `src/modules/foundation/customer-companies.ts` — customer company-code (FI) CRUD. Exports: `CustomerCompanyError`, `normalizeInterestIndicator`, `normalizeToleranceGroup`, `saveCustomerCompany`, `getCustomerCompany`, `listCustomerCompanies`, `requireCustomerCompany`, `customerCompanyChoices`.
- `src/modules/foundation/customer-sales-area-schema.ts` — Table: `customerSalesArea`; carries SD sales-area fields incl. `accountAssignmentGroup` (revenue determination), `shippingCondition` (shipping-point determination), `partialDeliveryIndicator`/`maxPartialDeliveries`, `invoiceListSchedule` (NONE/WEEKLY/MONTHLY, payer's invoice-list period).
- `src/modules/foundation/customer-sales-areas.ts` — customer sales-area (SD) CRUD; validates `shippingCondition` against sales' `shipping_condition` master, choices include active shipping conditions. Exports: `CustomerSalesAreaError`, `saveCustomerSalesArea`, `getCustomerSalesArea`, `listCustomerSalesAreas`, `requireCustomerSalesArea`, `customerSalesAreaChoices`.
- `src/modules/foundation/supplier-company-schema.ts` — Table: `supplierCompany` (`supplier_company_code`).
- `src/modules/foundation/supplier-companies.ts` — supplier company-code (FI) CRUD + payment-method eligibility. Exports: `SupplierCompanyError`, `normalizeSupplierPaymentMethods`, `assertSupplierPaymentMethodEligibility`, `saveSupplierCompany`, `getSupplierCompany`, `listSupplierCompanies`, `requireSupplierCompany`, `supplierCompanyChoices`.
- `src/modules/foundation/supplier-partner-schema.ts` — Tables: `supplierPartnerFunction`, `supplierPurchasingPartner`. Exports `SUPPLIER_PARTNER_FUNCTION_CODES` (`ORDERING_PARTNER`, `DELIVERY_PARTNER`, `INVOICE_SENDER`).
- `src/modules/foundation/supplier-purchasing-partners.ts` — read-side partner-function assignments. Exports: `listSupplierPartnerFunctions`, `listSupplierPartnerChoices`, `listSupplierPurchasingPartners`.
- `src/modules/foundation/supplier-purchasing-partner-writes.ts` — write-side. Exports: `SupplierPurchasingPartnerError`, `saveSupplierPurchasingPartner`, `removeSupplierPurchasingPartner`.
- `src/modules/foundation/supplier-purchasing-schema.ts` — Table: `supplierPurchasing` (`supplier_purchasing_org`).
- `src/modules/foundation/supplier-purchasing.ts` — supplier purchasing-org (MM) CRUD + Incoterms. Exports: `DELIVERY_TERMS`, `SupplierPurchasingError`, `saveSupplierPurchasing`, `getSupplierPurchasing`, `listSupplierPurchasing`, `requireSupplierPurchasing`, `supplierPurchasingChoices`.
- `src/modules/foundation/bank-master.ts` — global bank directory (country+key), platform-owned table. Exports: `CAPABILITY`, `listBanks`, `listBankCountryChoices`, `bankValuesSchema`, `BankMasterError`, `saveBank`, `deleteBank`.
- `src/modules/foundation/partner-bank-schema.ts` — per-partner bank (ciphertext-only) schema. Table: `partnerBank`.
- `src/modules/foundation/partner-bank-reads.ts` — reads non-sensitive bank metadata. Exports: `PARTNER_BANK_METADATA_DISPLAY_CAPABILITY`, `PartnerBankMetadataAccessError`, `lookupPartnerBankMetadata`, `listPartnerBankMetadata`.
- `src/modules/foundation/partner-bank-detail-view.ts` — masked single-record detail (IBAN/local-account). Exports: `PartnerBankMaskedIdentifierKind`, `getPartnerBankMaskedDetail`.
- `src/modules/foundation/partner-bank-country-profile-schema.ts` — country-profile readiness registry. Table: `partnerBankCountryProfile`.
- `src/modules/foundation/partner-bank-profile-activation.ts` — capability-checked activation; calls Postgres fn `cairn_activate_partner_bank_profile` via raw SQL. Exports: `createPartnerBankProfileActivationService`, `activatePartnerBankProfile`.
- `src/modules/foundation/partner-bank-profile-activation-audit-schema.ts` — append-only audit log. Table: `partnerBankProfileActivationAudit`.
- `src/modules/foundation/partner-bank-profile-activation-view.ts` — display rows for activation admin UI. Exports: `resolvePartnerBankProfileActivationRows`, `listPartnerBankProfileActivationRows`.
- `src/modules/foundation/partner-bank-profile-readiness.ts` — read-only readiness check pre-write, per country. Exports: `createPartnerBankProfileReadinessReader`, `readPartnerBankProfileReadiness`.
- `src/app/foundation/partners/page.tsx` — main BP Master screen (partner/company/sales-area/bank panels).
- `src/app/foundation/partners/bank-profiles/page.tsx` — admin: bank country-profile activation status.
- `src/app/foundation/partners/actions.ts` — action `savePartnerAction`.
- `src/app/foundation/partners/company-actions.ts` — action `saveSupplierCompanyAction`.
- `src/app/foundation/partners/customer-company-actions.ts` — action `saveCustomerCompanyAction`.
- `src/app/foundation/partners/customer-sales-area-actions.ts` — action `saveCustomerSalesAreaAction` (now also account assignment group + invoice-list schedule).
- `src/app/foundation/partners/customer-partner-actions.ts` — customer partner functions (KNVP) via `@/modules/sales/partners`, session-tenant + enqueue-lock check. Exports: `saveCustomerPartnerAction`, `changeCustomerPartnerStatusAction`, `CustomerPartnerActionState`.
- `src/app/foundation/partners/purchasing-actions.ts` — action `saveSupplierPurchasingAction`.
- `src/app/foundation/partners/partner-function-actions.ts` — actions: read/save/remove partner-function assignments.
- `src/app/foundation/partners/partner-bank-profile-activation-actions.ts` — action `activatePartnerBankProfileAction`.
- `src/app/foundation/partners/PartnerForm.tsx` — general BP data form.
- `src/app/foundation/partners/CustomerCompanyPanel.tsx` — customer company-code (FI) panel.
- `src/app/foundation/partners/SupplierCompanyPanel.tsx` — supplier company-code (FI) panel.
- `src/app/foundation/partners/CustomerSalesAreaPanel.tsx` — customer sales-area (SD) panel (incl. account assignment group, invoice-list schedule).
- `src/app/foundation/partners/CustomerPartnerPanel.tsx` — client: customer partner-function (SH/BP/PY; sold-to implicit) rows per sales area or all areas. Exports: `CustomerPartnerPanel`.
- `src/app/foundation/partners/SupplierPurchasingPanel.tsx` — supplier purchasing-org (MM) panel.
- `src/app/foundation/partners/SupplierPartnerFunctionsPanel.tsx` — partner-function assignment panel.
- `src/app/foundation/partners/PartnerBankMetadataPanel.tsx` — bank metadata listing panel.
- `src/app/foundation/partners/PartnerBankDetailPanel.tsx` — masked bank-detail panel.
- `src/app/foundation/partners/PartnerBankProfileActivationPanel.tsx` — country-profile activation panel (admin).

### Enterprise structure (company codes, plants, purchasing/sales orgs)
- `src/modules/foundation/company-code-definition.ts` — company code (OX02) CRUD; define-half of define/assign.
- `src/modules/foundation/company-code-assignments.ts` — generic company-code-linked config assignment helpers (credit control area etc.).
- `src/modules/foundation/company-code-coa-assignment.ts` — assigns CoA to company code (OB62); nullable FK until assigned.
- `src/modules/foundation/chart-of-accounts-maintenance.ts` — CoA group/CoA CRUD (OB13); uses finance's `glAccount`/`glAccountGroup` for usage checks.
- `src/modules/foundation/plant-maintenance.ts` — plant (OX10) CRUD incl. logistics fields.
- `src/modules/foundation/plant-company-code-assignment.ts` — assigns plant to company code; nullable-FK pattern.
- `src/modules/foundation/storage-location-maintenance.ts` — storage location (OX09) CRUD, scoped to plant.
- `src/modules/foundation/purchasing-org-maintenance.ts` — purchasing org (OX08) CRUD.
- `src/modules/foundation/purchasing-org-company-code-assignment.ts` — protected purchasing-org→company-code assignment (SCR-018/D-092); nullable FK on `purchasingOrg.companyCode`.
- `src/modules/foundation/purchasing-org-plant.ts` — purchasing org→plant assignment (`purchasingOrgPlant` composite table).
- `src/modules/foundation/purchasing-group-maintenance.ts` — purchasing group (buyer/team) definition; optional company/plant/org links.
- `src/modules/foundation/sales-organization-maintenance.ts` — sales org (OVX5) CRUD.
- `src/modules/foundation/sales-org-company-code-assignment.ts` — sales org→company code assignment.
- `src/modules/foundation/sales-org-distribution-channel-assignment.ts` — sales org→distribution channel assignment.
- `src/modules/foundation/sales-org-division-assignment.ts` — sales org→division assignment.
- `src/modules/foundation/distribution-channel-division-maintenance.ts` — distribution-channel/division master define/deactivate.
- `src/modules/foundation/sales-area-maintenance.ts` — sales area (org+channel+division) maintenance.
- `src/modules/foundation/fiscal-year-variant-maintenance.ts` — fiscal year variant/period definition (OB29).
- `src/modules/foundation/fiscal-year-variant-assignment.ts` — fiscal year variant→company code assignment.
- `src/modules/foundation/posting-period-variant-definition.ts` — posting period variant/interval-rule definition (OBBO).
- `src/modules/foundation/posting-period-variant-assignment.ts` — posting period variant→company code assignment.
- `src/modules/foundation/standard-config.ts` — "Standard package" (`INTL-STD-4`) bootstraps CoA, fiscal year/posting periods, document types, exchange rates, distribution channels/divisions, purchasing groups, supplier partner-function catalogue, payment terms, standard financial statement version for fresh tenant; now also seeds sales config (sales document types, returns chain + movements, condition types/pricing procedures/determination, revenue account determination, sales partner functions, billing plan types, incompletion groups). Exports: `STANDARD_PACKAGE_VERSION`, `applyStandardPackage`.
- `src/modules/foundation/services.ts` — legacy-style service layer (1100+ lines): company code, plant, posting-period-rule CRUD + **G/L account** CRUD (`listGlAccounts`, `upsertGlAccount`, `setGlAccountBlocks`, `deleteGlAccount`, `glAccountUsage`, `glAccountAuditVersion`, writes finance's `glAccount`). Also: `listCompanyCodes`, `getCompanyCodeDetail`, `upsertCompanyCode`, `listPeriodRules`, `updatePeriodRule`, `listPlants`, `listConfigurationChoices`.
- `src/app/config/company-codes/page.tsx`, `CompanyCodeDefinitionForm.tsx`, `CompanyCodeCoaAssignmentForm.tsx`, `actions.ts` — company code screen/actions.
- `src/app/config/company-codes/assign-chart-of-accounts/page.tsx`, `CoaAssignmentForm.tsx`, `actions.ts` — CoA assignment screen.
- `src/app/config/plants/page.tsx`, `PlantDefinitionForm.tsx`, `PlantCompanyCodeAssignmentForm.tsx`, `actions.ts` — plant definition/assignment screen.
- `src/app/config/storage-locations/page.tsx`, `StorageLocationForm.tsx`, `DeactivateStorageLocationForm.tsx`, `actions.ts` — storage location screen.
- `src/app/config/purchasing-groups/page.tsx`, `PurchasingGroupsGrid.tsx`, `actions.ts` — purchasing group screen.
- `src/app/config/sales-orgs/page.tsx`, `SalesOrgDefinitionForm.tsx`, `DeactivateSalesOrgForm.tsx`, `actions.ts` — sales org definition screen.
- `src/app/config/sales-orgs/assign-company/page.tsx`, `SalesOrgCompanyCodeAssignmentForm.tsx`, `actions.ts` — sales org→company code screen.
- `src/app/config/sales-orgs/assign-distribution-channel/page.tsx`, `AssignmentForm.tsx`, `AssignmentsList.tsx`, `actions.ts` — sales org→channel screen.
- `src/app/config/sales-orgs/assign-division/page.tsx`, `AssignmentForm.tsx`, `AssignmentsList.tsx`, `actions.ts` — sales org→division screen.
- `src/app/config/distribution-channels/page.tsx`, `DistributionChannelDefinitionForm.tsx`, `DeactivateDistributionChannelForm.tsx`, `actions.ts` — distribution channel screen.
- `src/app/config/divisions/page.tsx`, `DivisionDefinitionForm.tsx`, `DeactivateDivisionForm.tsx`, `actions.ts` — division screen.
- `src/app/config/sales-areas/page.tsx`, `SalesAreaForm.tsx`, `SalesAreasList.tsx`, `actions.ts` — sales area combination screen.
- `src/app/config/posting-periods/page.tsx`, `PeriodRules.tsx`, `actions.ts` — posting period rule screen (per fiscal year variant).
- `src/app/config/posting-period-variants/page.tsx`, `PostingPeriodVariants.tsx`, `actions.ts` — posting period variant screen.
- `src/app/config/posting-period-variants/assign-company-codes/page.tsx`, `PostingPeriodVariantAssignments.tsx`, `actions.ts` — variant→company code screen.

### Controlling (cost/profit centers, internal orders, settlement, plan revaluation)
- `src/modules/foundation/controlling-area-maintenance.ts` — controlling area (OKKP) CRUD. Exports: `controllingAreaValuesSchema`, `ControllingAreaMaintenanceError`, `controllingAreaF4Choices`.
- `src/modules/foundation/controlling-area-company-assignment.ts` — company codes→controlling area (OKKP assignment control). Exports: `assignCompanyCodeToControllingArea`, `assignCompanyCodeToControllingAreaInTransaction`.
- `src/modules/foundation/controlling-area-company-compatibility.ts` — validates company code fiscal year variant/currency vs controlling area pre-assignment; locks OXX assignments during check. Exports: `lockCompanyCodeOxxAssignments`, `assertCompanyCodeFinancialSettingsCompatible`.
- `src/modules/foundation/cost-center-definition.ts` — cost center master (KS01) CRUD.
- `src/modules/foundation/cost-center-hierarchy.ts` — hierarchy/group tree maintenance. Re-exports `listCostCenterAreas` from cost-center-definition.
- `src/modules/foundation/cost-center-report.ts` — actual/plan report query (S_ALR_87013611).
- `src/modules/foundation/profit-center-definition.ts` — profit center master (KE51) CRUD.
- `src/modules/foundation/profit-center-hierarchy.ts` — hierarchy/group tree maintenance.
- `src/modules/foundation/profit-center-report.ts` — actual/plan report query.
- `src/modules/foundation/activity-type-definition.ts` — activity type (KL01) master CRUD.
- `src/modules/foundation/activity-rate-definition.ts` — activity price/rate planning (KP26) by cost center/activity type/period.
- `src/modules/foundation/internal-order.ts` — internal order (KO01/KO02) create/change; create/change take `options.authorization` (`ServiceAuthorityContext`) and verify live authority + Company Code scope in-tx. Exports: `INTERNAL_ORDER_MAINTAIN_CAPABILITY`, `createInternalOrder`, `changeInternalOrder`, `getInternalOrder`, `listInternalOrders`, `internalOrderChoices`.
- `src/modules/foundation/internal-order-display.ts` — display-only (KO03) read path.
- `src/modules/foundation/internal-order-budget.ts` — original budget entry (KO22); uses platform locking.
- `src/modules/foundation/internal-order-budget-display.ts` — budget display-only (KO23) read path.
- `src/modules/foundation/order-settlement.ts` — KO88 (individual)/KO8G (collective) actual settlement; settles via `postJournalEntry` only when stored settlement profile + allocation-structure assignment + distribution rule resolve a receiver; imports `glAccount` from finance; `settleOrder`/`settleOrdersCollective` take `options.authorization` and verify authority + Company Code scope per order. Exports: `ORDER_SETTLEMENT_CAPABILITY`, `OrderSettlementError`.
- `src/modules/foundation/settlement-configuration.ts` — per-order settlement RULE (receiver category/percentage/account) + advisory lock before settling. Exports: `SETTLEMENT_RULE_CAPABILITY`, `getSettlementConfiguration`, `lockSettlementRuleForOrder`, `saveOrderSettlementConfiguration`.
- `src/modules/foundation/settlement-configuration-keys.ts` — DB-free shared constants (capability + lock keys); keeps client/action/module using one lock object name.
- `src/modules/foundation/settlement-configuration-masters.ts` — IMG settlement MASTER data: allocation structures, allocation-structure assignments, settlement profiles, order-type→profile links.
- `src/modules/foundation/plan-revaluation.ts` — KOP1: plan-revaluation definition (orders/year/periods/plan version); does not execute revaluation (KOPU not implemented). Exports: `PLAN_REVALUATION_CAPABILITY`, `PlanRevaluationError`.
- `src/app/config/controlling-area/page.tsx`, `ControllingAreaForm.tsx`, `ControllingAreasList.tsx`, `ControllingAreaValueHelp.tsx`, `actions.ts` — controlling area screen.
- `src/app/config/controlling-area/assign-company-code/page.tsx`, `ControllingAreaCompanyAssignmentUI.tsx`, `AssignmentControlField.tsx`, `actions.ts` — controlling area→company code screen.
- `src/app/config/cost-centers/page.tsx`, `CostCenters.tsx`, `actions.ts` — cost center master screen.
- `src/app/config/cost-center-hierarchy/page.tsx`, `CostCenterHierarchy.tsx`, `actions.ts` — cost center hierarchy screen.
- `src/app/config/profit-centers/page.tsx`, `ProfitCenters.tsx`, `actions.ts` — profit center master screen.
- `src/app/config/profit-center-hierarchy/page.tsx`, `ProfitCenterHierarchy.tsx`, `actions.ts` — profit center hierarchy screen.
- `src/app/config/activity-types/page.tsx`, `ActivityTypes.tsx`, `actions.ts` — activity type screen.
- `src/app/config/activity-rates/page.tsx`, `ActivityRates.tsx`, `actions.ts` — activity rate screen.
- `src/app/config/settlement-configuration/page.tsx`, `SettlementMasters.tsx`, `actions.ts` — settlement master screen.
- `src/app/controlling/cost-center-report/page.tsx`, `CostCenterReportShell.tsx` — cost center report screen.
- `src/app/controlling/profit-center-report/page.tsx`, `ProfitCenterReportShell.tsx`, `export/route.ts` — profit center report screen + export API route.
- `src/app/controlling/internal-orders/page.tsx`, `OrderForm.tsx`, `actions.ts` — internal order create/change screen; actions pass `{ authorization: { userId, sessionId } }` to the service.
- `src/app/controlling/internal-order-display/page.tsx` — internal order display-only screen.
- `src/app/controlling/original-budget/page.tsx`, `BudgetForm.tsx`, `actions.ts` — original budget entry screen.
- `src/app/controlling/original-budget-display/page.tsx` — original budget display-only screen.
- `src/app/controlling/order-settlement/page.tsx`, `SettlementForm.tsx`, `actions.ts` — individual settlement (KO88) screen; action passes session `authorization`.
- `src/app/controlling/order-settlement-collective/page.tsx`, `CollectiveForm.tsx`, `actions.ts` — collective settlement (KO8G) screen; action passes session `authorization`.
- `src/app/controlling/settlement-rules/page.tsx`, `RuleForm.tsx`, `actions.ts` — settlement rule screen.
- `src/app/controlling/plan-revaluation/page.tsx`, `RevaluationForm.tsx`, `actions.ts` — plan revaluation (KOP1) screen.

### Other config (payment terms/methods, tax/document types, number ranges, banks, exchange rates, characteristics/classes, release strategies, tolerance groups, retained earnings, special G/L, account determination, industries, constrained values)
- `src/modules/foundation/account-determination.ts` — automatic account determination (OBYC) by posting event + valuation class (new event `RETURNS_TRANSFER`/GBB, no seeded row); imports `valuationClass` from inventory. Exports: `ACTIVITY`, `POSTING_EVENTS`, `postingEvent`.
- `src/modules/foundation/characteristic-schema.ts` — classification schema. Tables: `characteristic`, `characteristicValue`, `classType`, `classificationClass`, `classAssignment`, `releaseGroup`, `releaseCode`, `releaseStrategy`, `releaseStrategyCriterion`, `releaseStrategyStep`.
- `src/modules/foundation/characteristic-definition.ts` — characteristic (CT04) master CRUD.
- `src/modules/foundation/class-definition.ts` — classification class (CL02) master CRUD.
- `src/modules/foundation/release-strategy-definition.ts` — release strategy (purchasing release procedure) definition/criteria/steps.
- `src/modules/foundation/constrained-kinds.ts` — DB-free "constrained value" kind vocabulary (company, plant, currency, purchasing-org, cost-center, profit-center, gl, tax, etc.), cross-module; `CLOSED_KINDS` (dropdown-able) vs open/searched.
- `src/modules/foundation/constrained-values.ts` — generic server-side value-help/autocomplete across those kinds. Exports: `suggestConstrainedValues`.
- `src/modules/foundation/document-type-definition.ts` — document type (OBA7) master CRUD incl. account-type-letter and reversal-mode vocabulary.
- `src/modules/foundation/employee-tolerance-definition.ts` — employee tolerance group (OBA4) master CRUD.
- `src/modules/foundation/exchange-rate-maintenance.ts` — exchange rate (OB08) by rate type/currency pair/date.
- `src/modules/foundation/house-bank-definition.ts` — house bank + account (FI12); links finance's `glAccount` and platform's `bankMaster`.
- `src/modules/foundation/industry-definition.ts` — industry master CRUD, multi-language text.
- `src/modules/foundation/number-ranges.ts` — number range object/interval maintenance (SNRO/FBN1), on platform numbering tables (new object `REBATE_AGR`). Exports: `NUMBER_OBJECTS`, `seedNumberRangeObjects`, `maintainNumberRange`, `saveNumberRangeObject`, `adjustNumberRangeCurrent`, `journalRangeReadiness`.
- `src/modules/foundation/output-schema.ts` — cross-module output (NAST) schema shared by inventory (IN) + sales (SD): output types, condition records (when/to whom/medium), output messages (status PENDING/PROCESSED/ERROR); re-exported by `src/platform/schema.ts`. Tables: `outputType`, `outputConditionRecord`, `outputMessage`. Exports also: `OUTPUT_APPLICATIONS`, `OUTPUT_DOCUMENT_CATEGORIES`, `OUTPUT_MEDIA`, `DISPATCH_TIMES`, `OUTPUT_STATUSES`, `OUTPUT_STATUS_ALIASES`, `OUTPUT_PARTNER_FUNCTIONS` (+ types).
- `src/modules/foundation/output-notify.ts` — `OUTPUT.FAILED` notification author: enqueues fan-out job only on a transition into ERROR. Exports: `enqueueOutputFailed`, `OUTPUT_ACTOR`, `SALES_OUTPUT_NOTIFICATION_CLASS`, `MATERIAL_DOC_OUTPUT_NOTIFICATION_CLASS`, `OutputNotificationClass`, `OutputFailedInput`.
- `src/modules/foundation/payment-method-schema.ts` — Table: `paymentMethod`.
- `src/modules/foundation/payment-methods.ts` — payment method (FBZP) master CRUD + retirement.
- `src/modules/foundation/payment-term-dates.ts` — pure baseline-date/schedule calculator (DOCUMENT_DATE/POSTING_DATE/ENTRY_DATE); no DB access.
- `src/modules/foundation/payment-terms-schema.ts` — Table: `paymentTerms`.
- `src/modules/foundation/payment-terms.ts` — payment terms (OBB8) master CRUD; uses `payment-term-dates.ts` for schedule calc.
- `src/modules/foundation/retained-earnings-vocabulary.ts` — DB-free constants/types (`RETAINED_EARNINGS_ACTIVITY`, `RETAINED_EARNINGS_EVENT`, `STANDARD_RETAINED_EARNINGS_INDICATOR`).
- `src/modules/foundation/retained-earnings.ts` — retained earnings account (OB53) maintenance; re-exports vocabulary module. Exports: `RetainedEarningsError`, `listRetainedEarnings`, `maintainRetainedEarnings`, `deleteRetainedEarnings`.
- `src/modules/foundation/special-gl.ts` — special G/L indicator (OBXR) config CRUD.
- `src/modules/foundation/tax-code-definition.ts` — tax code (FTXP) master CRUD by country.
- `src/modules/foundation/schema.ts` — central Drizzle schema (1800+ lines, ~60 tables/enums); see Database. No non-table exports.
- `src/app/config/account-determination/page.tsx`, `AccountDetermination.tsx`, `actions.ts` — account determination screen.
- `src/app/config/banks/page.tsx`, `Banks.tsx`, `actions.ts` — global bank master screen.
- `src/app/config/house-banks/page.tsx`, `HouseBanks.tsx`, `actions.ts` — house bank screen.
- `src/app/config/characteristics/page.tsx`, `Characteristics.tsx`, `actions.ts` — characteristic master screen.
- `src/app/config/classes/page.tsx`, `Classes.tsx`, `actions.ts` — classification class screen.
- `src/app/config/release-strategies/page.tsx`, `ReleaseStrategies.tsx`, `actions.ts` — release strategy screen.
- `src/app/config/document-types/page.tsx`, `DocumentTypes.tsx`, `actions.ts` — document type screen.
- `src/app/config/exchange-rates/page.tsx`, `ExchangeRates.tsx`, `actions.ts` — exchange rate screen.
- `src/app/config/industries/page.tsx`, `Industries.tsx`, `actions.ts` — industry master screen.
- `src/app/config/number-range-objects/page.tsx`, `NumberRangeObjects.tsx`, `actions.ts` — number range object screen.
- `src/app/config/number-ranges/page.tsx`, `RangeForm.tsx`, `actions.ts` — number range interval screen.
- `src/app/config/payment-methods/page.tsx`, `PaymentMethodForm.tsx`, `RetirePaymentMethodForm.tsx`, `actions.ts` — payment method screen.
- `src/app/config/payment-terms/page.tsx`, `TermsForm.tsx`, `actions.ts` — payment terms screen.
- `src/app/config/tax-codes/page.tsx`, `TaxCodes.tsx`, `actions.ts` — tax code screen.
- `src/app/config/tolerance-groups/page.tsx`, `ToleranceGroups.tsx`, `actions.ts` — tolerance group screen.
- `src/app/config/retained-earnings/page.tsx`, `RetainedEarnings.tsx`, `actions.ts` — retained earnings screen.
- `src/app/config/special-gl/page.tsx`, `SpecialGl.tsx`, `actions.ts` — special G/L indicator screen.
- `src/app/constrained-values/actions.ts` — exposes `suggestConstrainedValues` to repo-wide `ConstrainedField` UI component.

## Pages & API routes
- `/config/account-determination`, `/config/activity-rates`, `/config/activity-types`, `/config/banks`, `/config/characteristics`, `/config/classes`, `/config/company-codes` (+`/assign-chart-of-accounts`), `/config/controlling-area` (+`/assign-company-code`), `/config/cost-center-hierarchy`, `/config/cost-centers`, `/config/distribution-channels`, `/config/divisions`, `/config/document-types`, `/config/exchange-rates`, `/config/house-banks`, `/config/industries`, `/config/number-range-objects`, `/config/number-ranges`, `/config/payment-methods`, `/config/payment-terms`, `/config/plants`, `/config/posting-periods`, `/config/posting-period-variants` (+`/assign-company-codes`), `/config/profit-center-hierarchy`, `/config/profit-centers`, `/config/purchasing-groups`, `/config/release-strategies`, `/config/retained-earnings`, `/config/sales-areas`, `/config/sales-orgs` (+`/assign-company`, `/assign-distribution-channel`, `/assign-division`), `/config/settlement-configuration`, `/config/special-gl`, `/config/storage-locations`, `/config/tax-codes`, `/config/tolerance-groups` — IMG define/assign screens, one per config object.
- `/controlling/cost-center-report`, `/controlling/profit-center-report` (+`/export`) — CO-OM actual/plan reports.
- `/controlling/internal-orders`, `/controlling/internal-order-display` — create/change + display-only.
- `/controlling/original-budget`, `/controlling/original-budget-display` — original budget entry + display-only.
- `/controlling/order-settlement`, `/controlling/order-settlement-collective`, `/controlling/settlement-rules` — individual/collective settlement execution + rule maintenance.
- `/controlling/plan-revaluation` — plan revaluation definition (KOP1).
- `/foundation/partners` (+`/bank-profiles`) — BP Master (customer/supplier extensions, bank data) + bank-country-profile activation admin.
- `/constrained-values` — action endpoint backing shared `ConstrainedField` (not a visible page).

## Database
**Owns:**
- `src/modules/foundation/schema.ts` (~60 tables/enums): `groupChartOfAccounts`, `chartOfAccounts`, `fiscalYearVariant`, `fiscalYearPeriod`, `postingPeriodVariant`, `postingPeriodRule`, `companyCode`, `plant`, `storageLocation`, `purchasingOrg`, `purchasingOrgPlant`, `purchasingGroup`, `factoryCalendar`, `salesOrg`, `salesOrgText`, `distributionChannel`, `salesOrgDistributionChannel`, `division`, `salesOrgDivision`, `salesArea`, `controllingArea`, `controllingAreaCompany`, `costCenter`, `costCenterHierarchy`, `costCenterNode`, `costCenterNodeAssignment`, `costCenterGroup`, `costCenterGroupLeaf`, `profitCenterHierarchy`, `profitCenterNode`, `profitCenterNodeAssignment`, `profitCenterGroup`, `profitCenterGroupLeaf`, `activityType`, `activityRate`, `profitCenter`, `creditControlArea`, `exchangeRate`, `houseBank`, `bankAccount`, `taxCode`, `specialGlConfig`, `accountDetermination`, `documentType`, `employeeToleranceGroup`, `costCenterPlan`, `internalOrderType`, `internalOrder`, `settlementProfile`, `internalOrderTypeSettlementProfile`, `allocationStructure`, `allocationStructureAssignment`, `settlementDistributionRule`, `settlementDocument`, `internalOrderBudgetProfile`, `internalOrderTypeBudgetProfile`, `internalOrderOriginalBudget`, `internalOrderOriginalBudgetYear`, `planRevaluationOrder`, `planRevaluationOrderItem`.
- `business-partner-schema.ts`: `industry`, `industryText`, `businessPartner`, `bpRole`.
- `central-address-schema.ts`: `centralAddress`.
- `customer-company-schema.ts`: `customerCompany` (`customer_company_code`).
- `customer-sales-area-schema.ts`: `customerSalesArea`.
- `supplier-company-schema.ts`: `supplierCompany` (`supplier_company_code`).
- `supplier-partner-schema.ts`: `supplierPartnerFunction`, `supplierPurchasingPartner`.
- `supplier-purchasing-schema.ts`: `supplierPurchasing` (`supplier_purchasing_org`).
- `partner-bank-schema.ts`: `partnerBank`.
- `partner-bank-country-profile-schema.ts`: `partnerBankCountryProfile`.
- `partner-bank-profile-activation-audit-schema.ts`: `partnerBankProfileActivationAudit`.
- `characteristic-schema.ts`: `characteristic`, `characteristicValue`, `classType`, `classificationClass`, `classAssignment`, `releaseGroup`, `releaseCode`, `releaseStrategy`, `releaseStrategyCriterion`, `releaseStrategyStep`.
- `payment-method-schema.ts`: `paymentMethod`.
- `payment-terms-schema.ts`: `paymentTerms`.
- `output-schema.ts`: `outputType`, `outputConditionRecord`, `outputMessage` (`output_type`, `output_condition_record`, `output_message`; shared output queue written by sales + inventory).

(All paths above under `src/modules/foundation/`.)

**Reads/writes tables owned elsewhere:**
- `glAccount`, `glAccountGroup`, `journalEntryLine`, `financialStatementVersion`/`Node`/`Assignment`, `assetClass`, `assetTransactionType`, `depreciationArea`, `depreciationKey`, `reversalReason` — module `finance` (`src/modules/finance/schema.ts`, `gl-account-group-schema.ts`). Touched by `services.ts` (G/L CRUD), `standard-config.ts` (bootstrap), `chart-of-accounts-maintenance.ts`, `house-bank-definition.ts`, `order-settlement.ts` (via `postJournalEntry`), `special-gl.ts`, `retained-earnings.ts`, `tax-code-definition.ts`, `document-type-definition.ts`, others. Foundation owns CoA/company-code structure; G/L account master lives in finance.
- `valuationClass` — module `inventory` (`src/modules/inventory/schema.ts`). Read by `account-determination.ts`.
- `shippingCondition` — module `sales` (`src/modules/sales/schema.ts`). Read by `customer-sales-areas.ts`. `standard-config.ts` seeds sales config tables (`salesDocumentType`, `salesReturnsConfiguration`, `salesConditionType`, `salesPricingProcedure`/`Step`, `salesProcedureDetermination`, `salesAccountDetermination`, `salesPartnerFunction`, `salesBillingPlanType`, `incompletionGroup`).
- `bankMaster`, `country`, `currency`, `unitOfMeasure` — platform reference tables (`src/platform/tables/reference.ts`). `bank-master.ts`/`house-bank-definition.ts` read/write `bankMaster` directly; not a foundation schema despite the name.
- `numberRangeObject`, `numberRange`, `numberRangeAllocation` — platform numbering tables (`src/platform/tables/numbering.ts`). `number-ranges.ts`, `plan-revaluation.ts` (via `allocateNumber`) maintain/consume.
- `changeDocument`, `changeDocumentItem` — platform audit-trail tables (`src/platform/tables/audit-trail.ts`), written via `recordChange` from nearly every maintenance file.
- `configActivity`, `configActivityStatus` — platform registry tables (`src/platform/tables/registry.ts`), updated via `markActivityComplete` (IMG activation workbench).
- `client`, `clientSettings` — platform tenancy tables, referenced by nearly every foundation table's `client` FK.

## Depends on
- Modules:
  - `finance` — heavy/pervasive: company-code/CoA/settlement/standard-config/retained-earnings/special-GL/tax/document-type/house-bank files read/write `glAccount`, `glAccountGroup`, posting vocabulary (`gl-account-vocabulary.ts`), asset/financial-statement tables for bootstrap (22+ files import `../finance`).
  - `inventory` — `account-determination.ts` imports `valuationClass` from `../inventory/schema`.
  - `sales` — `standard-config.ts` (document types, returns, pricing, account determination, schema tables), `customer-sales-areas.ts` (`shippingCondition`, `SHIPPING_POINT_ROUTE`), `customer-partner-actions.ts` (`@/modules/sales/partners`), `CustomerPartnerPanel.tsx`.
- Platform:
  - `@/platform/db/client` (`withTenant`, `Tx`) — nearly every file; tenant-scoped transactions.
  - `@/platform/change` (`recordChange`) — audit trail on every maintenance/assignment write.
  - `@/platform/tenancy` (`markActivityComplete`) — marks IMG activities complete on define/assign.
  - `@/platform/tables/registry`, `/audit-trail`, `/reference`, `/numbering`, `/tenancy` — shared tables read/written directly (see Database).
  - `@/platform/numbering` (`allocateNumber`) — used by `plan-revaluation.ts` + other numbered objects.
  - `@/platform/periods` (`periodWindows`, `derivePosition`, `buildPeriodRows`) — used by settlement, standard-config, period-rule maintenance.
  - `@/platform/posting` (`postJournalEntry`, `PostingError`, decimal helpers) — used by `order-settlement.ts`.
  - `@/platform/lock` — advisory locking in settlement-rule and internal-order-budget maintenance.
  - `@/platform/auth/service-authority` (`verifyServiceAuthorityInTx`, `ServiceAuthorityContext`) + `auth/session` (`hasOrgAccess`) — in-service authority/Company Code checks in `internal-order.ts`, `order-settlement.ts`.
  - `@/platform/job/queue`, `@/platform/notification/jobs/fanout` — `output-notify.ts`.
  - `@/platform/auth` (`hasCapability`, `SessionContext`, `assertApplicationRole`) — gates nearly every write.
  - `@/platform/security/partner-bank-profile-activation`, `/partner-bank-profile-readiness`, per-country `bank-profile-*.ts`/`bank-data-encryption.ts` — foundation's activation/readiness files are thin wrappers around these.

## Used by
Nearly every module depends on foundation for master-data lookups. By consumer (reverse grep on `@/modules/foundation`/`src/modules/foundation`, excluding foundation's own dirs):
- `finance` (~17 files, src/modules/finance + src/app/finance) — cost/profit centers, company codes, controlling areas, BP/customer-company data for GL posting, credit control, carryforward, reports (trial balance, balance sheet, P&L, cash flow, close cockpit, accruals, vendor/customer invoices, ageing).
- `production` (~6 files) — cost centers/activity types/settlement config for order settlement and routing/work-center/BOM/production-version screens (plant, cost center).
- `sales` (1 file) — credit memo screen uses customer/sales area data; `src/modules/sales/output.ts` uses `output-schema.ts` + `output-notify.ts`.
- `inventory` — `material-document-output.ts` uses `output-schema.ts` + `output-notify.ts`.
- `purchasing` (1 file) — supplier info-record action uses supplier/purchasing-org data.
- `people` (1 file) — `org-structure.ts` uses cost center/company code structure for HR org assignment.
- `src/ui/fields/ConstrainedField.tsx` — calls constrained-values vocabulary/search directly.
- `scripts` (8 files: `seed.ts`, `smoke-posting.ts`, `create-dev-tenant.ts`, etc.) — exercise standard-config, number ranges, partner-bank activation capability constants.
- `tests` (140 files outside this module's own list) — use foundation fixtures (company code/cost center/controlling area setup) as scaffolding, plus this module's own 135 tests.

## Tests

**Business partner / bank:**
tests/business-partners.test.ts, tests/bank-master.test.ts, tests/house-bank-definition.test.ts, tests/partner-bank-schema-contract.test.ts, tests/partner-bank-country-profile-schema-contract.test.ts, tests/partner-bank-reads.test.ts, tests/partner-bank-detail-view.test.ts, tests/partner-bank-detail-panel.test.tsx, tests/partner-bank-panel.test.tsx, tests/partner-bank-profile-activation-action-contract.test.ts, tests/partner-bank-profile-activation-audit-schema-contract.test.ts, tests/partner-bank-profile-activation-capability.test.ts, tests/partner-bank-profile-activation-command.test.ts, tests/partner-bank-profile-activation-function-contract.test.ts, tests/partner-bank-profile-activation-page-contract.test.ts, tests/partner-bank-profile-activation-panel.test.tsx, tests/partner-bank-profile-activation-service.test.ts, tests/partner-bank-profile-activation-view.test.ts, tests/partner-bank-profile-readiness.test.ts, tests/partner-bank-profile-readiness-service.test.ts, tests/partner-display-page-auth.test.tsx

**Customer / supplier master data:**
tests/customer-companies.test.ts, tests/customer-company-codes.test.ts, tests/customer-sales-areas.test.ts, tests/supplier-companies.test.ts, tests/supplier-company-payment-method-action-contract.test.ts, tests/supplier-company-payment-method-browser-contract.test.ts, tests/supplier-company-payment-method-schema.test.ts, tests/supplier-company-payment-method-ui-contract.test.ts, tests/supplier-company-payment-methods.test.ts, tests/supplier-purchasing.test.ts, tests/supplier-purchasing-partners.test.ts, tests/supplier-purchasing-partner-writes.test.ts

**Company code & enterprise structure:**
tests/company-code-definition.test.ts, tests/company-code-definition-contract.test.ts, tests/company-code-definition-ui-contract.test.ts, tests/company-code-assignments.test.ts, tests/company-code-assignment-sequence.test.ts, tests/company-code-assignments-schema-contract.test.ts, tests/company-code-capability-contract.test.ts, tests/company-code-coa-assignment.test.ts, tests/company-code-coa-assignment-contract.test.ts, tests/company-code-coa-assignment-screen-contract.test.ts, tests/company-code-coa-assignment-ui-contract.test.ts, tests/chart-of-accounts-maintenance.test.ts, tests/chart-of-accounts-ui-contract.test.ts, tests/plant-maintenance.test.ts, tests/plant-maintenance-contract.test.ts, tests/plant-maintenance-action-contract.test.ts, tests/plant-definition-ui-contract.test.ts, tests/plant-logistics-fields-schema-contract.test.ts, tests/plant-company-code-assignment.test.ts, tests/plant-company-code-assignment-contract.test.ts, tests/plant-company-code-assignment-ui-contract.test.ts, tests/plant-company-code-nullable.test.ts, tests/plant-company-code-nullable-schema-contract.test.ts, tests/storage-location-maintenance.test.ts, tests/storage-location-maintenance-contract.test.ts, tests/storage-location-capability-contract.test.ts, tests/storage-location-schema-contract.test.ts, tests/storage-location-ui-contract.test.ts, tests/purchasing-org-maintenance.test.ts, tests/purchasing-org-maintenance-contract.test.ts, tests/purchasing-org-company-code-assignment-contract.test.ts, tests/purchasing-org-company-code-fk-migration-contract.test.ts, tests/purchasing-org-company-code-nullable-schema-contract.test.ts, tests/purchasing-group-maintenance.test.ts, tests/purchasing-group-maintenance-contract.test.ts, tests/purchasing-group-schema-contract.test.ts, tests/purchasing-group-schema-validation.test.ts, tests/purchasing-group-ui-contract.test.ts, tests/sales-org-maintenance.test.ts, tests/sales-org-maintenance-contract.test.ts, tests/sales-org-definition-ui-contract.test.ts, tests/sales-org-browser-target-contract.test.ts, tests/sales-org-company-code-assignment.test.ts, tests/sales-org-company-code-assignment-contract.test.ts, tests/sales-org-division-assignment.test.ts, tests/sales-org-division-assignment-contract.test.ts, tests/sales-org-division-ui-contract.test.ts, tests/distribution-channel-division-maintenance.test.ts, tests/distribution-channel-division-browser-target-contract.test.ts, tests/distribution-channel-division-capability-contract.test.ts, tests/distribution-channel-division-ui-contract.test.ts, tests/fiscal-year-variant-maintenance.test.ts, tests/fiscal-year-variant-assignment.test.ts, tests/posting-period-variant-definition.test.ts, tests/posting-period-variant-assignment.test.ts, tests/periods.test.ts, tests/standard-structure-builder.test.ts

**Controlling (cost/profit centers, internal orders):**
tests/cost-center-definition.test.ts, tests/cost-center-hierarchy.test.ts, tests/cost-center-report.test.ts, tests/cost-center-report-index-contract.test.ts, tests/profit-center-definition.test.ts, tests/profit-center-hierarchy.test.ts, tests/profit-center-report.test.ts, tests/profit-center-report-index-contract.test.ts, tests/activity-type-definition.test.ts, tests/activity-rate-definition.test.ts, tests/controlling-area-company-assignment.test.ts, tests/controlling-area-company-assignment-contract.test.ts, tests/controlling-area-company-assignment-browser-target-contract.test.ts, tests/controlling-area-ui-contract.test.ts, tests/internal-order.test.ts, tests/internal-order-budget.test.ts, tests/controlling-order-lock-enforcement.test.ts

**Settlement & plan revaluation:**
tests/order-settlement.test.ts, tests/config-settlement-assignment-event-lifecycle.test.ts, tests/config-settlement-configuration-registry.test.ts, tests/config-settlement-lock-object-contract.test.ts, tests/config-settlement-master-contract.test.ts, tests/controlling-settlement-concurrency.test.ts, tests/controlling-settlement-reversal-contract.test.ts, tests/controlling-settlement-rule-contract.test.ts, tests/plan-revaluation.test.ts, tests/settlement-masters.ts

**Other config (payment/tax/banks/characteristics/number ranges/misc):**
tests/account-determination.test.ts, tests/characteristic-definition.test.ts, tests/class-definition.test.ts, tests/document-type-definition.test.ts, tests/employee-tolerance-definition.test.ts, tests/exchange-rate-maintenance.test.ts, tests/industry-definition.test.ts, tests/number-range-objects.test.ts, tests/range-maintenance.test.ts, tests/payment-method-schema.test.ts, tests/payment-methods.test.ts, tests/payment-terms.test.ts, tests/release-strategy-definition.test.ts, tests/retained-earnings.test.ts, tests/retained-earnings-schema-contract.test.ts, tests/constrained-values.test.ts, tests/browser-target-constrained-driving.test.ts, tests/platform-lock-recovery-ux-contract.test.ts

## Scripts
scripts/browser-smoke/account-determination.ts, scripts/browser-smoke/activity-rates.ts, scripts/browser-smoke/activity-types.ts, scripts/browser-smoke/banks.ts, scripts/browser-smoke/characteristics.ts, scripts/browser-smoke/classes.ts, scripts/browser-smoke/closed-fields.ts, scripts/browser-smoke/cost-center-hierarchy.ts, scripts/browser-smoke/cost-centers.ts, scripts/browser-smoke/document-types.ts, scripts/browser-smoke/exchange-rates.ts, scripts/browser-smoke/fiscal-year-variant-assignment.ts, scripts/browser-smoke/house-banks.ts, scripts/browser-smoke/industries.ts, scripts/browser-smoke/number-range-objects.ts, scripts/browser-smoke/ox19-assignment.ts, scripts/browser-smoke/posting-period-variant-assignment.ts, scripts/browser-smoke/posting-period-variants.ts, scripts/browser-smoke/profit-center-hierarchy.ts, scripts/browser-smoke/profit-centers.ts, scripts/browser-smoke/release-strategies.ts, scripts/browser-smoke/retained-earnings.ts, scripts/browser-smoke/settlement-configuration.ts, scripts/browser-smoke/tax-codes.ts, scripts/browser-smoke/tolerance-groups.ts, scripts/seed.ts, scripts/smoke-posting.ts

## Non-obvious behavior / gotchas
- Nullable FKs (`companyCode.chartOfAccounts`/`.fiscalYearVariant`/`.postingPeriodVariant`, `purchasingOrg.companyCode`) are deliberate "define then assign" design. Trigger `cairn_assert_company_code_refs()` fires on write, names missing config activity; see `tests/plant-company-code-nullable.test.ts`, `tests/company-code-assignment-sequence.test.ts`.
- Platform owns tables resembling foundation's: `bankMaster`, `numberRangeObject`, `numberRange`, `numberRangeAllocation` live in `src/platform/tables/reference.ts`/`numbering.ts` though foundation's `bank-master.ts`/`number-ranges.ts` own the maintenance logic. Not every `src/modules/foundation/*.ts` owns its own table.
- Naming collision: `src/modules/foundation/partner-bank-profile-activation.ts` vs `src/platform/security/partner-bank-profile-activation.ts` (same for `-readiness.ts`). Foundation = DB-backed orchestration (tenant tx + Postgres fn `cairn_activate_partner_bank_profile`); platform/security = pure capability constant/validation, no DB.
- Partner bank data encrypted-at-rest, read-only at app layer today. `partnerBank.ibanCiphertext`/`localAccountNumberCiphertext` DB-check-constrained to envelope format `cbd1.<key>.<iv>.<tag>.<ct>`; another check enforces exactly one of IBAN/local-account populated. App DB role is SELECT-only — writes not live.
- `services.ts`/`standard-config.ts` write directly into finance's G/L and asset/financial-statement tables — biggest cross-module coupling: `upsertGlAccount`/`deleteGlAccount`/`setGlAccountBlocks` live in foundation though `glAccount` is defined in `src/modules/finance/schema.ts`.
- `output-schema.ts` "belongs to no module" by design (one queue for IN + SD output) but lives in foundation; `enqueueOutputFailed` fires only on a transition into ERROR, not on re-failures.
- `CustomerPartnerPanel.tsx`/`customer-partner-actions.ts` are not wired into `partners/page.tsx` (no importer) — dead UI as of this branch.
- Settlement has 3 similarly-named, easily conflated files: `settlement-configuration.ts` (per-order RULE, own advisory lock), `settlement-configuration-masters.ts` (IMG master data: allocation structures/profiles, order-type links), `settlement-configuration-keys.ts` (DB-free shared constants so browser lock and save lock name the same object). `order-settlement.ts` is the actual KO88/KO8G execution consuming all three.
- Plan revaluation (KOP1) only stores a definition — `plan-revaluation.ts` doesn't change plan amounts/budgets/journals; KOP2/KOP3/KOP4/KOPU out of scope (SAP tx codes named in comments to pin scope).
- `constrained-values.ts`/`constrained-kinds.ts` is cross-module but lives in foundation: covers purchasing (`purchase-order`, `material-rfq`), inventory (`material-stock`), finance (`gl`, `tax`), foundation (`cost-center`, `profit-center`) kinds; hosted here since most "closed" dropdown-able kinds are foundation's own data; consumed repo-wide via `src/ui/fields/ConstrainedField.tsx`.
