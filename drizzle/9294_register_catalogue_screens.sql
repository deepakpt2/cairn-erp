-- 9294_register_catalogue_screens.sql
--
-- Registry rows for built screens that the screen catalogue lists and the term registry did not.
-- Data only: each row names a route that already exists and a code the screen already carries.
-- Authorization is untouched; the capability each page asks for is unchanged.
--
-- Not added: alias rows (no reference code is asserted without a source), conformance tiers
-- (assessed per screen, not here), and the launchpad. /platform/users/access shares its code with
-- /platform/users and so has no row of its own (our_code is unique).

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select v.id, v.our_code, null, v.title, v.term_type, v.module, v.description,
       'TIER_1_BUILT', v.route, null, null, true, 'MIGRATION_9294', now(), null, null
  from (values
    ('9294a000-0000-4000-8000-000000000001', 'CFG.PLT.ROLE.MAINTAIN', 'Roles and capabilities', 'CONFIG_ACTIVITY', 'PLT', 'Define roles and the capabilities each role holds.', '/platform/roles'),
    ('9294a000-0000-4000-8000-000000000002', 'CFG.PLT.USER.MAINTAIN', 'Central user administration', 'CONFIG_ACTIVITY', 'PLT', 'Create and maintain users and assign their roles.', '/platform/users'),
    ('9294a000-0000-4000-8000-000000000003', 'CFG.SALES.BATCHDETERMINATION.DEFINE', 'Batch determination', 'CONFIG_ACTIVITY', 'SD', 'Define how a batch is chosen for a sales delivery line.', '/config/batch-determination'),
    ('9294a000-0000-4000-8000-000000000004', 'PROC.DELIVERYCOMPLETION.CONFIGURE', 'Configure delivery completion', 'TRANSACTION', 'PROC', 'Set the tolerances that mark a purchase order line as delivered.', '/config/delivery-completion'),
    ('9294a000-0000-4000-8000-000000000005', 'FIN.AR.CREDITMEMO.POST', 'Enter customer credit memo', 'TRANSACTION', 'FIN', 'Post a credit memo to a customer account.', '/sales/credit-memo'),
    ('9294a000-0000-4000-8000-000000000006', 'CFG.FND.PARTNER.BANKPROFILE.ACTIVATE', 'Partner-bank country profiles', 'CONFIG_ACTIVITY', 'FND', 'Activate the bank-detail profile that applies to a partner country.', '/foundation/partners/bank-profiles'),
    ('9294a000-0000-4000-8000-000000000007', 'INV.SERIAL.MAINTAIN', 'Serial numbers', 'TRANSACTION', 'INV', 'Maintain serial numbers of serialised materials.', '/inventory/serial-numbers'),
    ('9294a000-0000-4000-8000-000000000008', 'PLT.NOTIFY.DISPLAY', 'Notifications', 'TRANSACTION', 'PLT', 'Read the notifications sent to the signed-in user.', '/platform/notifications'),
    ('9294a000-0000-4000-8000-000000000009', 'PROC.GRIR.RECONCILE', 'Reconcile GR/IR', 'TRANSACTION', 'PROC', 'Reconcile goods received against invoices received.', '/purchasing/grir-reconciliation'),
    ('9294a000-0000-4000-8000-000000000010', 'SALES.BILLING_PLAN.MAINTAIN', 'Billing plans', 'TRANSACTION', 'SD', 'Maintain billing plans that spread a charge over dates.', '/sales/billing-plans'),
    ('9294a000-0000-4000-8000-000000000011', 'SALES.REBATE.MAINTAIN', 'Rebate agreements', 'TRANSACTION', 'SD', 'Maintain rebate agreements with customers.', '/sales/rebate-agreements'),
    ('9294a000-0000-4000-8000-000000000012', 'SALES.OUTPUT.PROCESS', 'Output: what the customer receives', 'TRANSACTION', 'SD', 'Process the output a sales document sends to the customer.', '/sales/output'),
    ('9294a000-0000-4000-8000-000000000013', 'SALES.RETURNS.ORDER.CREATE', 'Returns from customers', 'TRANSACTION', 'SD', 'Enter and process a return from a customer.', '/sales/returns'),
    ('9294a000-0000-4000-8000-000000000014', 'SALES.CREDIT.REQUEST.CREATE', 'Credit memo requests', 'TRANSACTION', 'SD', 'Request a credit memo for a customer.', '/sales/credit-memo-request'),
    ('9294a000-0000-4000-8000-000000000015', 'CFG.SALES.DOCTYPE.DEFINE', 'Sales document types', 'CONFIG_ACTIVITY', 'SD', 'Define the sales document types.', '/config/sales-document-types'),
    ('9294a000-0000-4000-8000-000000000016', 'CFG.SALES.PRICING.DEFINE', 'Pricing procedures', 'CONFIG_ACTIVITY', 'SD', 'Define the pricing procedures.', '/config/pricing-procedure'),
    ('9294a000-0000-4000-8000-000000000017', 'CFG.SALES.ACCOUNT_DETERMINATION.DEFINE', 'Revenue account determination', 'CONFIG_ACTIVITY', 'SD', 'Define which revenue account a billing posts to.', '/config/sales-account-determination'),
    ('9294a000-0000-4000-8000-000000000018', 'CFG.SALES.INCOMPLETION.DEFINE', 'Incompletion', 'CONFIG_ACTIVITY', 'SD', 'Define which fields a sales document must carry before it can proceed.', '/config/incompletion'),
    ('9294a000-0000-4000-8000-000000000019', 'CFG.SALES.SHIPPING_POINT.DEFINE', 'Shipping points', 'CONFIG_ACTIVITY', 'SD', 'Define the shipping points.', '/config/shipping-points'),
    ('9294a000-0000-4000-8000-000000000020', 'CFG.SALES.RETURNS.DEFINE', 'The returns chain', 'CONFIG_ACTIVITY', 'SD', 'Define the steps a customer return passes through.', '/config/sales-returns'),
    ('9294a000-0000-4000-8000-000000000021', 'CFG.SALES.SPLIT.DEFINE', 'Billing split criteria', 'CONFIG_ACTIVITY', 'SD', 'Define the criteria that split a billing into several documents.', '/config/billing-split'),
    ('9294a000-0000-4000-8000-000000000022', 'SALES.ANALYSIS.LIST', 'Sales analysis', 'TRANSACTION', 'SD', 'Analyse sales by customer, material and period.', '/sales/analysis'),
    ('9294a000-0000-4000-8000-000000000023', 'SALES.DOCUMENTS.LIST', 'Sales documents', 'TRANSACTION', 'SD', 'List sales documents.', '/sales/documents'),
    ('9294a000-0000-4000-8000-000000000024', 'SALES.INCOMPLETION.PROCESS', 'Incomplete documents', 'TRANSACTION', 'SD', 'List the sales documents that are incomplete and what each lacks.', '/sales/incomplete'),
    ('9294a000-0000-4000-8000-000000000025', 'SALES.INVOICE_LIST.CREATE', 'Invoice lists', 'TRANSACTION', 'SD', 'Combine billing documents into an invoice list.', '/sales/invoice-lists'),
    ('9294a000-0000-4000-8000-000000000026', 'PEOPLE.AUTHORITY.VIEW', 'Authority', 'TRANSACTION', 'PEOPLE', 'See who holds authority to approve, and over what.', '/people/authority')
  ) as v(id, our_code, title, term_type, module, description, route)
 where not exists (select 1 from public.term_registry r where r.id = v.id or r.our_code = v.our_code);
