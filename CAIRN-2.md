# CAIRN — Project Log & Technical Specification (continued)

**Part 2 of 2 · Last updated:** 2026-10-12 (v1.40)
**Continues:** [CAIRN.md](CAIRN.md) · **Sections:** §26.45–§30

---

## §26 · Phase 1 screen inventory (continued)

### 26.45 B-029 — Supplier purchasing partner assignment write service `COMPLETE · EDITOR / BROWSER ACCEPTANCE PASSED IN §26.49`

**Scope:** added `src/modules/foundation/supplier-purchasing-partner-writes.ts` with tenant-scoped,
audited create/update, atomic replacement and removal operations. Writes require an existing focal Supplier
role and purchasing-organisation segment, an active purchasing organisation and function, and an active
related Supplier role in the same tenant. The fixed `SUPPLIER` relation remains enforced by the schema.
There are no effective dates, plant/sub-range overrides, reciprocal links or separate pay-to role.

**Cardinality and defaults:** the service takes the active function's tenant configuration under lock and
serializes writes per focal supplier / purchasing organisation / function. `allows_multiple=false` permits
at most one assignment; a second is rejected. `allows_multiple=true` permits several and does not auto-pick
a default. At most one multiple-role assignment may be default: explicitly choosing another transfers the
default atomically and versions/audits the previous default. No default is promoted when a default is
removed. A unique function cannot be marked default; a single unique assignment is the only choice and the
approved optional-default rule applies to multiple-valued functions.

**Concurrency/audit:** expected version is `0` for create and the current row version for update, replace or
remove. Stale edits fail with a reload remedy. Replacing is transactional, versions the new row from the
replaced row, and records removal plus creation history; default transfers version and audit both affected
rows. No-op saves do not write history. The optional default is never inferred from insertion order.

**Verification:** `npm run typecheck`, `npm run test -- tests/supplier-purchasing-partner-writes.test.ts`
(**4/4**), the full Vitest suite (**339/339 across 22 files**), the browser harness (**65/65**) and
`git diff --check` passed. DB tests cover unique rejection, multiple assignment with no default, default
transfer, version conflicts, atomic replacement/removal, supplier/function/segment validation, concurrent
unique-role adds, change history and tenant isolation. Testing used only disposable development tenants in
the isolated B-026 PostgreSQL database. No schema/migration, action, capability, UI, or PO determination
behavior was added in B-029; B-030 later adds session-derived protected server actions (§26.46). B-031 adds display-only UI (§26.47), and B-032 adds assignment controls (§26.48); browser acceptance and PO determination remain pending.


### 26.46 B-030 — Protected supplier partner-function server actions `COMPLETE · BROWSER ACCEPTANCE PASSED IN §26.49`

**Scope:** added `src/app/foundation/partners/partner-function-actions.ts`. The read action returns the
Cairn-owned catalogue and scoped supplier/purchasing-organisation assignments only when the session has
`PROC.SUPPLIER.PURCHASING.DISPLAY`, `PROC.SUPPLIER.PURCHASING.MAINTAIN`, or `AUDIT.WORKSPACE`. Save
and remove actions independently require `PROC.SUPPLIER.PURCHASING.MAINTAIN`. Each action requires a
verified session; tenant and audit actor come only from that session. Forged `client`/`changedBy` form
values are ignored. Mutations revalidate `/foundation/partners`. No new capability was needed; the existing
purchasing authority boundary is reused.

**Verification:** extended `tests/action-security.test.ts` for tenant/actor derivation, a display-only read,
maintain-only mutation denial, anonymous requests, scoped readback and audit actor. Focused action-security
tests pass **30/30**; full Vitest passes **342/342 across 22 files**. `npm run typecheck`, `npm run build`,
browser harness (**65/65**), IP lint (**172 files**) and `git diff --check` passed. No UI,
capability/schema change, migration or PO determination was added in B-030. B-031 later adds a display-only panel (§26.47), and B-032 adds assignment editing (§26.48); browser acceptance remains pending.


### 26.47 B-031 — Supplier partner-function read panel `COMPLETE · EDITOR / BROWSER ACCEPTANCE PASSED IN §§26.48–49`

**Scope:** added `SupplierPartnerFunctionsPanel` to the existing `SUPPLIER_PURCHASING` view. The
server-rendered panel groups assignments by configured function and shows Cairn label/code, unique or
multiple setting, inactive-function state, assigned Supplier number/name/status, inactive-role or block
indicators, and the default marker. It explains the focal Supplier fallback, shows an explicit empty state,
and, for multiple assignments with no default, states that a consuming transaction must ask the user to
choose. Text is routed through the i18n catalogue.

The page fetches catalogue and assignment rows only when the selected partner has an active Supplier role
and the session holds purchasing DISPLAY/MAINTAIN or AUDIT.WORKSPACE authority. Tenant scope comes from
the server session. The panel is display-only: no add/replace/remove controls were added in this slice.

**Verification:** typecheck, full Vitest (**342/342 across 22 files**), browser harness (**65/65**),
production build, IP lint (**173 files**) and `git diff --check` passed. No dedicated live-browser acceptance of this panel has run yet. B-032 later adds the assignment editor (§26.48); browser acceptance remains a separate batch. No schema/migration, service, action or PO determination changes were made in B-031.


### 26.48 B-032 — Supplier partner-function assignment editor `COMPLETE · BROWSER ACCEPTANCE PASSED IN §26.49`

**Scope:** extended the Supplier Purchasing partner-function panel for maintainers. A unique function with
no current assignment can add one; with one current row it can atomically replace it. If legacy data has
multiple rows under a unique function, the UI blocks add/replace and offers row-level removal to resolve
it. Multiple-valued functions can add distinct Suppliers, optionally set a default, change/unset a default
on an existing row, and remove assignments. For a multiple-configured function, the no-default reminder
appears whenever one or more assignments exist and none is default, including the single-assignment case.
Removal does not promote another row. Each mutation requires a reason and uses the row version; the
existing server actions derive tenant/actor and enforce maintain authority. Controls remain hidden from
read-only users.

Supplier choices come from same-tenant active Supplier roles; status/block state is included in option
labels. The picker shows at most 200 candidates and discloses that limit even when every returned choice is
already assigned. Assignment controls are not enabled until the focal supplier purchasing-organisation
segment exists. The standard package still seeds
all three functions as unique; this batch does not add a cardinality-configuration editor, so multiple/default
controls appear only for a tenant whose function is already configured as multiple. No assignment is
created automatically and no default is inferred.

**Verification:** `npm run typecheck`, full Vitest (**343/343 across 22 files**), browser harness (**65/65**),
production build, IP lint (**173 files**) and `git diff --check` passed. Dedicated live-browser acceptance
passed in B-033 (§26.49). No schema/migration or PO determination behavior was added in B-032.


### 26.49 B-033 — Supplier partner-function editor browser acceptance `AUTOMATED ACCEPTANCE PASSED`

**Scope:** extended the bounded `supplier-purchasing` Playwright target to exercise the assignment editor
through the actual Supplier Purchasing page and protected server actions. Onboarding created disposable
development tenant `T990`; focal and related Supplier identities were created through the UI. The target
confirmed the standard three-function catalogue is unique and empty, and that editor controls remain
withheld until the focal purchasing-organisation segment exists. After the segment was saved, the unique
`ORDERING_PARTNER` flow successfully added, replaced and removed an assignment, with persisted readback.

To cover future multiple configuration without adding cardinality UI or changing the standard defaults,
the test changed only `DELIVERY_PARTNER.allows_multiple` in this disposable fixture. The browser then
added two distinct related Suppliers, verified the no-default reminder with one assignment, added an
optional default, unset it, transferred it to the other row, and removed the current default. The remaining
assignment was not promoted and correctly remained without a default. A read-only `AUDITOR` could see the
assignment and no-default explanation but received no assignment forms/buttons; a warehouse-only user
could not read purchasing data/history. The common target also verified signed-out redirect and recorded
no browser runtime errors.

**Data safety:** `T990` was created through onboarding and cleaned up by the guarded fixture cleanup. A
post-run query confirmed zero matching development-tenant rows. Only this disposable tenant's multiple
rule was changed for test coverage; no owner/production data, deployment, PO, receipt, invoice, or other
transaction behavior was touched. This automated browser acceptance is not an owner walkthrough/sign-off.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (**65/65 across 5 files**),
`npm run smoke:browser -- --target supplier-purchasing` (passed; no page errors), and `git diff --check`
passed. Playwright Chromium and its Linux runtime dependencies were installed in the sandbox for this run.
No product schema or migration changed.


### 26.50 B-034 — Supplier company-code pending defaults placeholders `IMPLEMENTATION COMPLETE · LIVE BROWSER ACCEPTANCE PENDING`

**Scope:** added a four-field **Additional company-code defaults** group to the Supplier company-code
maintenance and authorised display-only views: Payment methods, Dunning procedure, Cash discount, and
Tolerance group. Each field is an explicitly disabled, read-only form control showing “Master
configuration pending”; the group explains that these are planning-only and not saved. In the editable
view the group is outside the existing save form and its controls have no `name`, so they cannot enter
`FormData`. The helper is shared with the read-only view. No `CompanyFields`, server action, service,
schema, migration, capability, save/persistence, or business behavior was added or changed.

**Dependency decision:** the owner selected Payment Methods as the first related master. B-035 captured
its v1 semantics; B-036–B-045 implemented and accepted the master. At B-034 close, all four Supplier
placeholders were disabled. B-098 now adds only the nullable Supplier payment-method storage column; its
control remains disabled pending country/direction validation, protected save behavior, UI and acceptance.
Dunning procedure, cash discount, and tolerance group remain disabled until their own required masters exist.

**Verification:** `npm run typecheck`, `npm run build`, `npm run lint:ip` (173 files),
`npm run test:browser-harness` (65/65), and `git diff --check` passed. The `supplier-company` Playwright
target now asserts the presence of exactly four disabled, non-submitted fields. Live browser acceptance
was not run: this worktree has no configured `DATABASE_URL` for the isolated development database, and
a read-only connection check failed authentication before any fixture was created or database mutation
was attempted. No owner/production data was accessed. Owner walkthrough/sign-off remains pending.


### 26.51 B-035 — Payment Methods master v1 semantics and scope `OWNER APPROVED · SCHEMA ADDED IN B-036`

**Outcome:** captured the owner-approved v1 definition contract only. No source, schema, migration, seed,
service, UI, supplier/customer integration, or payment behavior changed in B-035.

**Decision D-058:** the master is tenant-scoped and country-specific. Its natural key is
`(client, country, paymentMethodCode)`, where `country` is the existing ISO country reference and the
method code is 1–2 uppercase ASCII letters/digits. Codes may be reused in another country with a distinct
meaning. Each definition has a description, one allowed-direction value (`OUTGOING`, `INCOMING`, or
`BOTH`), and an active flag. The master contains definitions only; the standard configuration package
ships no generic methods.

Later code-backed company defaults resolve methods using the company code’s country and direction:
Supplier company defaults require an outgoing method, Customer company defaults an incoming method. The
existing Customer company field remains format-only until its own integration batch; this decision does
not change its current validation or stored values. Method permissions per Supplier/Customer, house-bank
eligibility, payment-medium/file formats, payment proposals/execution, and payment clearing are out of
this master slice and remain separate work. Supplier placeholders from B-034 stay disabled until the
master and its relevant integration are implemented.

**Verification:** owner-approved design recorded in D-058 and §14.6. B-036 adds the schema/RLS layer
(§26.52), B-037 adds read services (§26.53), and B-038 adds audited maintenance services (§26.54).
Their migrations and focused DB acceptance subsequently passed on a disposable local PostgreSQL 17.11
cluster (§26.55). `git diff --check` passed. No database connection or data change was required in B-035.


### 26.52 B-036 — Payment Methods master schema and tenant RLS `IMPLEMENTED · ISOLATED DB ACCEPTANCE PASSED (§26.55)`

**Scope:** added the `payment_method` table and registered it through the Foundation schema root. The
natural key is `(client, country, method_code)`; the tenant key cascades from `client`, and `country`
references the shared ISO country table. The table stores description, allowed direction, active state,
version, and standard audit columns. Database checks enforce the 1–2 uppercase alphanumeric code, a
nonblank description, one of `OUTGOING`/`INCOMING`/`BOTH`, and positive version. B-036 covered storage
and RLS only; read/write services were implemented separately in B-037/B-038 (§26.53–54). No method seed,
UI, company-field integration, payment permission, or payment execution is included.

**Migrations:** additive DDL is `0012_payment_method_master.sql`; forced tenant RLS, a default-deny
`cairn.client` policy, and `cairn_app` CRUD grants are `9014_payment_method_policies.sql`. The application
role cannot read or write another tenant’s rows or operate unscoped. Both files run through the existing
checksum-tracked migration runner; no prior migration was edited.

**Tests:** added `tests/payment-method-schema.test.ts` for same-code reuse across countries, duplicate-key
and database-domain rejection, RLS read/write isolation, forced-RLS flags, defaults, and tenant-cascade
cleanup. Its DB acceptance was pending at the B-036 implementation checkpoint; it subsequently passed 3/3
in the fresh disposable PostgreSQL 17.11 run (§26.55), alongside application of all 28 migrations.

**Verification:** `npm run typecheck`, `npm run build`, `npm run lint:ip` (177 files),
`npm run test:browser-harness` (65/65), and `git diff --check` passed. Isolated schema/migration acceptance
subsequently passed (§26.55). No owner/production database was accessed.


### 26.53 B-037 — Payment Methods tenant-scoped read services `IMPLEMENTED · DB ACCEPTANCE PASSED (§26.55)`

**Scope:** added `src/modules/foundation/payment-methods.ts` with read-only `getPaymentMethod` and
`listPaymentMethods` functions. Both validate inputs, execute through `withTenant`, and explicitly constrain
by tenant. The get key is tenant + country + method code; country and method code are trimmed and
canonicalised to uppercase only after ASCII-format validation. `getPaymentMethod` returns inactive rows
for review and returns `null` when the key does not exist.

`listPaymentMethods` is country-scoped and ordered by code. It includes inactive definitions by default;
`activeOnly: true` filters them out. A requested `OUTGOING` or `INCOMING` use includes definitions with
that direction **and** `BOTH`, so callers can use it for future Supplier/Customer choices. It does not
accept `BOTH` as a requested use. The B-037 batch added no write path; audited writes are separate B-038
work (§26.54). No action, UI, seed, payment behavior, or partner-field integration was added.

**Tests:** added `tests/payment-methods.test.ts` for country/code resolution and canonicalization, country
separation, direction + `BOTH` behavior, inactive handling, tenant isolation, and invalid-key/filter refusal.
At the B-037 implementation checkpoint its DB tests were pending; the read-service cases subsequently
passed in the focused 8/8 service-test run (§26.55). No database mutation was attempted in B-037 itself.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (65/65), `npm run lint:ip` (179 files),
and `git diff --check` passed. Isolated DB acceptance for B-036–B-038 subsequently passed (§26.55).
No owner/production database was accessed.


### 26.54 B-038 — Payment Methods audited create/change/retire service only `IMPLEMENTED · DB ACCEPTANCE PASSED (§26.55)`

**Scope:** extended `src/modules/foundation/payment-methods.ts` with `savePaymentMethod` for create/change
and `retirePaymentMethod` for non-destructive retirement. Both validate the tenant + country + method-code
key, required actor, reason, and expected version, then execute inside `withTenant` with an explicit full
key filter. Create requires expected version 0 and persists version 1; changes require the exact current
version and increment it. Advisory transaction locks serialize service writes to the same key. The country
must exist in the shared reference catalogue. An unchanged save is silent and creates no history.

Retirement sets `isActive=false`, increments the version, and retains the definition for review; a repeated
retire at the current version is a no-op. All actual writes use `recordChange` with required reason/actor
and before/after field snapshots. The supported audit types remain `CREATE` and `CHANGE`; retirement is
audited as a `CHANGE` to the active flag, without inventing a `RETIRE` change type. No configuration
activity completion is assumed. There is no server action, UI, seed, payment execution, Supplier/Customer
integration, or migration in this batch.

**Tests:** extended `tests/payment-methods.test.ts` with create/change/retire history, versions and stale
write rejection, no-op behavior, retained inactive reads, same country/code isolation across tenants, and
invalid/missing write cases. The focused DB run passed `tests/payment-methods.test.ts` (8/8) and
`tests/payment-method-schema.test.ts` (3/3); the B-038 lifecycle, stale-version, audit, no-op, and soft-retire
cases all passed (§26.55).

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (65/65), `npm run lint:ip` (179 files),
and `git diff --check` passed. B-036–B-038 DB acceptance passed on a disposable local PostgreSQL 17.11
cluster; it was stopped and its temporary data directory removed after confirming fixture cleanup. No
owner/production data was used. Configuration UI and Supplier integration remain separate follow-on batches.


### 26.55 B-036–B-038 — Disposable PostgreSQL database acceptance `PASSED`

**Setup:** PostgreSQL 17.11 server binaries were already available in the workspace environment, though not
on `PATH`. To avoid reusing the pre-existing local cluster of unknown provenance, created a brand-new,
temporary cluster and `cairn_b038_test` database on loopback only (port 55433). No `.env.local` change was
made; the app and migration URLs were supplied only to the commands for this isolated test database.
Applied all 28 migrations, including `0012_payment_method_master.sql` and
`9014_payment_method_policies.sql`, then loaded shared reference fixtures required by the tests.

**Results:** `npx vitest run tests/payment-method-schema.test.ts tests/payment-methods.test.ts` passed:
2 files, 11/11 tests. The schema/RLS suite passed 3/3; the Payment Methods service suite passed 8/8,
covering B-037 reads and B-038 create/change/retire, tenant isolation, optimistic versions, audit history,
no-op and retained-inactive behavior. The application role passed its non-elevated role check.

**Cleanup:** test teardown succeeded, and a read-only check confirmed zero development test tenants remained.
The temporary PostgreSQL process was stopped and its data directory removed. The existing local cluster,
owner/production databases, and their data were not accessed. No package, application schema, or migration
file was changed for this acceptance outcome.


### 26.56 B-039 — Payment Methods protected write actions and capability registration `DONE`

**Scope:** added `src/app/config/payment-methods/actions.ts` with session-protected create/change and retire
actions. Both require `CFG.FIN.PAYMENTMETHOD.DEFINE`; the tenant and actor come only from the verified
session, while reason, expected version, and method fields are parsed from the form and validated by the
B-038 service. Forged `client` and `changedBy` form values are ignored. Expected version is rejected when
missing rather than silently treating it as a create. Successful writes revalidate the future Payment
Methods route and configuration workbench. The action module does not add a page or read action.

Added the grantable `CFG.FIN.PAYMENTMETHOD.DEFINE` capability to `scripts/seed.ts` and localized success
messages. No Payment Method data is seeded and no role grants are changed. At the B-039 boundary, no
workbench activity existed, so these actions did not depend on an activity-status row; B-040 subsequently
registered the activity and added lifecycle completion (§26.57). No UI, schema/migration, payment
execution, or Supplier/Customer integration was added in B-039.

**Tests:** extended `tests/action-security.test.ts` for authorized create + soft retire, session-derived
tenant/actor despite forged form fields, denial without the capability, and anonymous redirects. On a fresh
disposable PostgreSQL 17.11 database with migrations and global/reference seed applied,
`npx vitest run tests/action-security.test.ts -t 'Payment Method'` passed all 3 selected tests (30 unrelated
tests skipped). The capability catalogue row was verified; teardown left zero test tenants.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (65/65), `npm run lint:ip` (180 files),
and `git diff --check` passed. The temporary database process and data directory were removed; the
pre-existing local cluster and owner/production databases were not accessed. B-040 activity/status
lifecycle is recorded in §26.57; B-041 read-only UI and later browser acceptance remain separate.


### 26.57 B-040 — Payment Methods workbench activity and status lifecycle only `DONE`

**Scope:** registered `CFG.FIN.PAYMENTMETHOD.DEFINE` (“Define payment methods”) in the configuration
activity catalogue, with the existing client-definition prerequisite, `STANDARD` stage, and future route
`/config/payment-methods`. Seed now backfills a missing `NOT_STARTED` status row for existing tenants;
`ON CONFLICT DO NOTHING` preserves any status already recorded. Standard tenant setup can also initialize
the registered activity for new tenants. This batch adds no workbench route, term-registry entry, or UI.

**Completion behavior:** successful Payment Method create/change and retire operations mark the activity
`COMPLETED` in the same tenant transaction as the maintenance and audit write. Valid no-op save and
already-inactive retire confirmations also mark it complete; validation, concurrency, or persistence
failures do not. Activity status is not reset by re-seeding. No method data is seeded and Supplier/Customer
integration remains out of scope.

**Tests and acceptance:** extended `tests/payment-methods.test.ts` to seed status rows for its tenant
fixtures and assert that a successful write completes the activity. On a fresh disposable PostgreSQL 17.11
cluster/database, applied all 28 migrations and reference seed; `npx vitest run
tests/payment-method-schema.test.ts tests/payment-methods.test.ts` passed 11/11 tests, and
`npx vitest run tests/action-security.test.ts -t 'Payment Method'` passed 3 selected tests (30 unrelated
tests skipped). A dedicated seed check confirmed a newly backfilled row starts `NOT_STARTED`, then remains
`COMPLETED` after re-seeding. The temporary cluster was stopped and its test data directory removed; the
pre-existing local cluster and owner/production databases were not used.

**Verification:** `npm run typecheck`, `npm run test:browser-harness` (65/65), `npm run lint:ip`
(180 files), and `git diff --check` passed. No application migration or payment-method data seed was
added. No UI or browser acceptance is included.
B-041 (workbench route, registry entry, and read-only list/detail/history) is next; see §25.5.2 and the
batch queue. No commit or push was made; the full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.58 B-041 — Payment Methods workbench route, registry entry and read-only UI `DONE`

**Scope:** built `/config/payment-methods` as an authenticated, read-only review screen. The verified
session supplies the tenant; the screen offers the global country catalogue, lists that tenant's
country-specific definitions (including inactive rows), and displays a selected method and its audited
change history. Added the route to the workbench's built-route allowlist and registered
`CFG.FIN.PAYMENTMETHOD.DEFINE` in the term registry so both entry points resolve. New labels are localized
through the English catalogue. B-041 added no create/change/retire controls, new actions, method data, or
Supplier/Customer integration; B-042 subsequently added create/change forms (§26.59), with retire UI in
B-043.

**Verification:** `npm run typecheck`, `npm run lint:ip` (181 files), `npm run test:browser-harness`
(65/65), and `git diff --check` passed. This batch did not run dedicated Payment Methods database or
live-browser acceptance; B-045 remains the separate browser run. The B-044 target is recorded in §26.61. Process check found no Cairn app,
Vitest, or PostgreSQL process running; the persistent platform Jupyter service was left untouched. No
commit or push was made; the full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.59 B-042 — Payment Methods create/change editor form only `DONE`

**Scope:** added the client-side `PaymentMethodForm` for capability-authorized creation and change on the
B-041 route. The page shows create/change controls only when the session holds
`CFG.FIN.PAYMENTMETHOD.DEFINE`; the form submits only to B-039's protected save action, which continues to
derive tenant and actor from the verified session. Create requires a country-scoped 1–2 character code;
existing codes are immutable. Both modes require description, allowed direction, active state and a
maintenance reason. Create sends expected version zero; change sends the version read by the page. Success
provides a link to the saved definition, while validation/authority errors retain a remedy. Read-only users
have no editor controls. No retire control, new action, method seed, or partner integration was added;
versioned soft retirement is B-043.

**Verification:** `npm run typecheck`, `npm run build` (Payment Methods route compiled as dynamic),
`npm run lint:ip` (182 files), `npm run test:browser-harness` (65/65), and `git diff --check` passed.
No dedicated Payment Methods database or live-browser acceptance was run; B-045 remains the separate
browser run after the B-044 target implementation (§26.61). No commit or push was made; the
full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.60 B-043 — Payment Methods soft-retire confirmation UI only `DONE`

**Scope:** added `RetirePaymentMethodForm` to the detail view for authorized users when the selected method
is active. It uses B-039's existing protected retire action, submitting the page's expected version, the
country/method key, and a required maintenance reason. A disclosure/confirmation step explains that
retirement marks the definition inactive but retains its record and audit history; an acknowledgment
checkbox is required before submitting. The action remains a versioned soft change, never a delete. On
success the user can reopen the saved definition; action errors and remedies remain visible. Inactive rows
show no retire control. No new action, schema, seed, or Supplier/Customer integration was added.

**Verification:** `npm run typecheck`, `npm run build` (Payment Methods route compiled as dynamic),
`npm run lint:ip` (183 files), `npm run test:browser-harness` (65/65), and `git diff --check` passed.
The generic harness is not Payment Methods browser acceptance; no dedicated database or live-browser run
was made. The B-044 browser target is recorded in §26.61; B-045 is next. No commit or push was made; the
full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.61 B-044 — Payment Methods dedicated browser acceptance target only `IMPLEMENTED`

**Scope:** added the isolated browser target `payment-methods` on reserved development key `T989`, runnable
as `npm run smoke:browser:payment-methods`. The existing runner creates the tenant through the UI and only
removes it if the key is the exact owned development fixture. The scenario covers workbench discovery and
initial status, empty country catalogue, UI create/change/soft-retire with version and audit evidence,
activity completion, and a no-payment-authority user who can display the active method/history but has no
create/change/retire controls. It also tries forged `client=0100` and `edit=1` query parameters. The
read-only user's identity/role is a test-only fixture; business method records are created through the UI.
The post-signout route check now targets `/config/payment-methods`.

**Verification:** `npm run typecheck`, browser-harness target-selection tests (66/66), `npm run lint:ip`
(183 files), `npm run smoke:browser -- --list`, and `git diff --check` passed. This verifies target
registration, not the browser acceptance itself. No Cairn app or PostgreSQL process/DB URL was running or
configured during this batch; B-045 will set up a fresh disposable development database, run this target,
and verify cleanup. No commit or push was made; the full-system/user-runnable UI-test publish trigger
remains in §25.4.


### 26.62 B-045 — Payment Methods fresh-database browser acceptance and fixture cleanup `PASSED`

**Environment:** ran `npm run smoke:browser:payment-methods` against a newly initialized disposable PostgreSQL 17.11 database (`cairn_b045_test`) with all 28 repository migrations and the reference/application seeds. The guarded target created development fixture `T989` through the onboarding UI. No pre-existing local database, owner tenant, or production data was used.

**Browser acceptance:** the dedicated target passed all steps: onboarding left accounting intervals unconfigured; the Payment Methods workbench exposed the new tenant's empty catalogue; authorized create/change kept the method code immutable and produced versioned history/audit evidence under the signed-in actor; the configuration activity completed; a display-only user could view but not maintain the definition; forged `client=0100` and `edit=1` query parameters did not grant cross-tenant access or edit controls; and versioned soft retirement preserved the inactive definition and history. The retirement success feedback was initially lost on revalidation because the parent unmounted the form when the detail became inactive. The UI was corrected to keep the form component mounted for editable detail and pass its active state, allowing the success message to render before the inactive control hides; the retirement feedback assertion then passed. The browser sign-in helper waits for `domcontentloaded` on the root redirect. This is automated acceptance only; product-owner walkthrough/sign-off remains pending under §24.1.

**Cleanup and verification:** target cleanup removed the owned T989 fixture. Direct post-run checks returned zero fixture tenants, zero `payment_method` rows, and zero `app_user` rows for T989. The Next.js app and PostgreSQL test server were stopped, and `/tmp/cairn-b045-pg` was removed. `npm run typecheck`, the dedicated browser target, `npm run test:browser-harness` (66/66), `npm run lint:ip` (183 files), and `git diff --check` passed. This batch changed no database schema, migration, seed data, payment execution, or Supplier/Customer integration. No commit or push was made; the full-system/user-runnable UI-test publish trigger remains in §25.4.


### 26.63 B-046 — Business-partner bank/contact v1 rules `AGREED`

**Owner-approved scope (D-059):** bank details are multiple partner-wide records, shared where one partner
has both Supplier and Customer roles. Fields are account holder, bank country, bank name/code, IBAN or
local account number, BIC/SWIFT, valid-from/to, and active state. Full bank identifiers must be encrypted
at rest, masked in ordinary views and change history, and revealed only through a separate audited
authority; generic change history must never hold the plaintext identifiers. No company-code or role
assignment, default payment selection, payment-method permission, house-bank eligibility, or payment
execution is added here.

Contacts are multiple partner-wide named people; the existing general email/phone stay as organisation-
level values. Each contact has name, title/function, email, phone, validity dates and active state, with at
most one primary at a time per partner. Log contact-data views and changes; mask personal email/phone in
history; end-date/inactivate records, with hard deletion only through an approved retention/privacy
workflow.

**Implementation gates:** country-specific bank-field requiredness and format validation, plus encryption-
key provisioning/rotation and the separate reveal/audit path, remain to be defined and implemented before
full bank identifiers can be stored. The current general partner schema has no bank/contact record tables;
its change history records supplied before/after values, and no bank-field encryption/reveal path exists.
B-047 is next to define bank field requiredness/validation. This was a requirements-only batch: no source,
schema, database, or real partner data changed. No commit or push; the full-system publish trigger remains
in §25.4.

**Status update:** B-047 subsequently approved the profile-driven requiredness, validation, and date
rules (D-060; §26.64). Initial country coverage and encryption-key/reveal implementation remain.


### 26.64 B-047 — Partner bank country-profile validation and date semantics `AGREED`

**Owner-approved validation policy (D-060):** account holder and bank country are required. A country
profile decides whether IBAN or local account number is required, and whether bank code/BIC is mandatory;
bank name is optional. Saving fails closed if no profile exists for the bank country. Normalize IBAN to
uppercase without spaces; verify that its country prefix matches the bank country, then check the
country-specific length and MOD-97 checksum. Validate supplied BIC/SWIFT syntax, but do not claim to verify
that the bank or account exists. Local account formats follow their country profile.

Valid-from is required; valid-to is optional. Both endpoints are inclusive; reject a valid-to date earlier
than valid-from. Overlapping validity periods are allowed because several accounts may be valid
simultaneously. Active state is separate from dates, and bank records are never hard-deleted.

**Boundary:** this approves the validation policy, not country-profile data coverage or implementation.
No profile rows, code, schema, database or bank identifiers were added. Encryption-key provisioning,
rotation and audited reveal infrastructure must still precede storage of real/full account identifiers.
Initial country coverage is the next requirements step, B-048. No commit or push; the full-system publish
trigger remains in §25.4. `git diff --check` passed.

**Status update:** B-048 subsequently selected `IN`, `KW`, `GB`, `US`, and `JP` as the initial profile set;
no country-profile records exist yet (§26.65). B-049 begins source-backed profile verification with KW.


### 26.65 B-048 — Initial partner bank-profile country set selected `AGREED`

Owner selected the first country-profile coverage as `IN`, `KW`, `GB`, `US`, and `JP` (ISO-2 codes;
D-061). All five already exist in the shared 30-country reference seed. This selects profile-authoring
scope only: no country validation profile has been defined or enabled, and D-060 continues to reject
bank records for every country until its required profile exists. Other countries remain outside the
initial set unless explicitly added later.

No code, schema, country-profile rows, database, or real bank identifiers changed. `git diff --check`
passed. B-049 will verify the KW profile requirements from authoritative sources before any profile is
implemented. No commit or push; the full-system publish trigger remains in §25.4.

**Status update:** B-049 subsequently verified the KW rules from CBK and the SWIFT Registry (D-062; §26.66).
The country profile is still not implemented; B-050 will verify IN next.


### 26.66 B-049 — Kuwait (KW) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** the Central Bank of Kuwait states that Kuwait's registered IBAN format
was activated on 2011-01-01 and links its implementation manual. The CBK manual describes the KW IBAN as
30 characters: `KW`, two check digits, a 26-character BBAN consisting of a four-letter bank code and a
22-character account component; it says the account-holding bank generates the customer's IBAN and the
electronic form contains no spaces. The SWIFT Registration Authority's current IBAN Registry Release 103
(Sep 2026) confirms `KW2!n4!a22!c`, total length 30, BBAN length 26, and a four-letter bank identifier in
BBAN positions 1–4. Sources: [CBK IBAN page](https://www.cbk.gov.kw/en/payment-systems/iban), [CBK implementation manual](https://www.cbk.gov.kw/en/images/iban-9721_v60_tcm10-9721.pdf), and [SWIFT IBAN Registry](https://www.swift.com/resource/iban-registry-pdf).

**KW profile specification (D-062):** account holder and bank country are required; country is `KW`.
Require a bank-issued IBAN; do not accept a separate local account number and do not generate an IBAN from
one. Normalize by removing spaces and uppercasing, then require exactly 30 characters matching
`^KW[0-9]{2}[A-Z]{4}[A-Z0-9]{22}$` and a valid MOD-97 check. The four-letter bank identifier is embedded
at normalized IBAN positions 5–8; derive it rather than asking for a separately entered bank code. Bank
name is optional. BIC/SWIFT is optional for this partner-data capture slice; validate syntax if supplied,
but leave payment-routing requirements to the later payment workflow. No validation claims that a bank
or account exists. Valid-from/to and active-state behavior follow D-060.

**Boundary:** this records verified KW profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
encryption-key/reveal/audit path is implemented. B-050 will verify India's profile next. No commit or push;
the full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.67 B-050 — India (IN) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** RBI's NEFT FAQ says a beneficiary's bank-branch IFSC and account
number are supplied for NEFT beneficiary identification. It defines IFSC as an 11-character
alphanumeric code identifying a participating bank-branch: positions 1–4 identify the bank, position 5
is `0`, and positions 6–11 identify the branch. RBI's 2013 Technical Committee report describes
bank-specific variation in account-number structures and discusses an India IBAN design; the RBI release
issued with that report invited comments before implementation was considered. The current SWIFT IBAN
Registry Release 103 (Sep 2026) has no `IN` IBAN profile. Sources: [RBI NEFT FAQ](https://www.rbi.org.in/scripts/faqview.aspx?id=60), [RBI Technical Committee report](https://www.rbi.org.in/scripts/PublicationReportDetails.aspx?ID=695), [RBI consultation press release](https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=27975), and [SWIFT IBAN Registry](https://www.swift.com/resource/iban-registry-pdf).

**IN profile specification (D-063):** account holder and bank country are required; country is `IN`.
Require the local bank account number and the beneficiary-branch IFSC as the profile's bank code;
do not accept an IBAN for this profile. Normalize IFSC to uppercase and require exactly 11 characters
matching `^[A-Z]{4}0[A-Z0-9]{6}$`. This is syntax validation only: do not perform live directory lookup,
claim the branch/account exists, or equate IFSC with BIC/SWIFT. Treat the local account number as an
opaque bank-specific identifier: preserve leading zeros and do not impose a country-wide length, syntax,
checksum, padding or truncation rule. Bank name is optional. BIC/SWIFT is optional for this non-payment
partner-data slice; if supplied, apply the generic syntax check and leave later payment-routing needs to
the payment workflow. RBI also lists account type in NEFT beneficiary instructions; it remains a
transaction-specific field outside D-059's bank-master field set. Validity dates and active state follow
D-060.

**Boundary:** this records verified IN profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
encryption-key/reveal/audit path is implemented. B-051 will verify the GB profile next. No commit or push;
the full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.68 B-051 — United Kingdom (GB) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** SWIFT IBAN Registry Release 103 (Sep 2026) lists the UK format as
`GB2!n4!a6!n8!n`, length 22. Pay.UK's UK IBAN standard explains the BBAN components: a four-letter
institution code derived from the bank BIC, six-digit sort code, and eight-digit account number. Sources:
[SWIFT IBAN Registry Release 103](https://www.swift.com/resource/iban-registry-pdf) and [Pay.UK Standard — UK IBAN format](https://www.wearepay.uk/wp-content/uploads/2018/10/Pay.UK-Standard-Format-of-the-IBAN-issued-in-the-UK-October18.pdf).

**GB profile specification (D-064):** account holder and bank country are required; country is `GB`.
Require a bank-issued IBAN; do not accept a local-account-only entry. Normalize by removing spaces and
uppercasing, then require exactly 22 characters matching `^GB[0-9]{2}[A-Z]{4}[0-9]{14}$` and a valid
MOD-97 check. Derive the four-letter institution identifier from normalized IBAN positions 5–8 for the
existing bank-code field; the sort code is positions 9–14 and account number positions 15–22. Do not ask
for duplicate local account/sort-code entry. Bank name is optional. BIC/SWIFT is optional for this
non-payment master-data slice; syntax-check if supplied, but do not assert bank/account existence or
payment-rail eligibility. Validity dates and active state follow D-060.

**Boundary:** this records verified GB profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
approved encryption-key/reveal/audit safeguards exist. B-052 and B-053 record US and JP next. No commit
or push; the full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.69 B-052 — United States (US) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** the American Bankers Association's Routing Number Policy specifies a
nine-digit routing number made up of the Federal Reserve routing symbol, institution identifier and
check digit. It also states that regular routing numbers may be used for electronic transactions; that
does not identify which number is correct for a particular payment rail. Sources: [ABA Routing Number Policy & Procedures](https://www.aba.com/news-research/analysis-guides/routing-number-policy-procedures), [ABA routing-number registry information](https://www.aba.com/about-us/routing-number), and the [Apache Commons Validator ABA check-digit reference](https://commons.apache.org/proper/commons-validator/apidocs/org/apache/commons/validator/routines/checkdigit/ABANumberCheckDigit.html). SWIFT IBAN Registry Release 103 (Sep 2026) has no `US` IBAN profile: [SWIFT IBAN Registry](https://www.swift.com/resource/iban-registry-pdf).

**US profile specification (D-065):** account holder and bank country are required; country is `US`.
Require the local account number and a nine-digit ABA routing transit number (RTN), stored in the
existing bank-code field; do not accept an IBAN. Require `^[0-9]{9}$`; the first two digits must be in ABA's bank/legacy-thrift routing-symbol ranges
`01–12` or `21–32`. Validate the ABA check digit with the standard 3-7-1 mod-10 rule:
`3(d1+d4+d7)+7(d2+d5+d8)+(d3+d6+d9) ≡ 0 (mod 10)`. Treat the account number as an opaque
bank-specific value: preserve leading zeros and impose no U.S.-wide length, syntax, checksum, padding
or truncation rule. Validate the RTN's structure/check digit only; do not look up an active directory,
claim institutional assignment, infer ACH/wire/check eligibility, or claim account existence. Bank name
is optional. BIC/SWIFT is optional for this non-payment master-data slice; syntax-check if supplied.
Validity dates and active state follow D-060.

**Boundary:** this records verified US profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
approved encryption-key/reveal/audit safeguards exist. B-053 records JP next. No commit or push; the
full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.70 B-053 — Japan (JP) bank-validation profile specification `VERIFIED`

**Authoritative profile sources:** SWIFT IBAN Registry Release 103 (Sep 2026) contains no `JP` IBAN
profile. The Japanese Bankers Association's code directory lists four-digit financial-institution codes;
MUFG documents a three-digit branch code and the associated account number. Japan Post Bank instructs
customers to use its transfer-specific institution/store/account representation and provides official
conversion guidance from its separate symbol/number format. Sources: [SWIFT IBAN Registry Release 103](https://www.swift.com/resource/iban-registry-pdf), [Japanese Bankers Association code directory](https://www.zenginkyo.or.jp/abstract/outline/organization/member-01/), [MUFG branch-code/account-number guidance](https://www.bk.mufg.jp/ebusiness/gplus/listofbranchesinjapan.html), and [Japan Post Bank transfer-format guidance](https://www.jp-bank.japanpost.jp/kojin/sokin/furikomi/kouza/kj_sk_fm_kz_1.html).

**JP profile specification (D-066):** account holder and bank country are required; country is `JP`.
Require a local account number and the domestic institution-plus-branch identifier; do not accept an
IBAN. To fit D-059's approved field set without adding a branch column, the existing bank-code field
carries the four-digit institution code followed by the three-digit branch/store code as one seven-digit
value matching `^[0-9]{7}$`; preserve leading zeros. Treat the bank-supplied account number as opaque and
exact; impose no nationwide length, syntax, checksum, padding or truncation rule. For Japan Post Bank,
use the bank's transfer-format branch/store code and account number from its official guidance; do not
algorithmically convert the separate symbol/number identifier in this profile. Bank name and BIC/SWIFT
are optional for this non-payment master-data slice; syntax-check BIC if supplied. Account type and
payment-rail-specific requirements remain outside D-059. No live directory, branch/account-existence or
network-eligibility claim. Validity dates and active state follow D-060.

**Boundary:** this records verified JP profile rules only. It does not implement or activate a country
profile and adds no code, schema, database row, or bank data. Full identifiers remain blocked until the
approved encryption-key/reveal/audit safeguards exist. B-051–B-053 are now complete; all five D-061
initial-country specifications are recorded, but none is implemented or enabled. No commit or push; the
full-system publish trigger remains in §25.4. `git diff --check` passed.


### 26.71 B-054 — Versioned bank-data encryption primitive `IMPLEMENTED — NOT INTEGRATED`

**Decision and scope (D-067):** the owner selected a versioned app-managed keyring whose high-entropy
keys are supplied through deployment secrets, with key IDs, retention of prior keys during rotation,
and no external KMS. This batch implements only the server-side cryptographic primitive in
`src/platform/security/bank-data-encryption.ts`; it neither reads deployment configuration nor stores or
reveals bank data.

**Cryptographic contract:** AES-256-GCM, a fresh random 96-bit nonce per encryption, and a 128-bit
authentication tag. The canonical unpadded-base64url envelope is
`cbd1.<key-id>.<nonce>.<ciphertext>.<tag>`. Key material must be 32 bytes; key IDs match
`^[A-Za-z0-9_-]{1,32}$`. The envelope version, key ID, tenant/client, partner number, bank-record ID,
and stable field name are serialized as authenticated associated data, so moving ciphertext between
keys, tenants, partners, rows, or fields fails authentication. Encryption always uses the supplied
keyring's active key; decryption resolves the key ID from the supplied keyring, allowing retained
old-key reads while a later bounded re-encryption process remains future work. Nonempty UTF-8 values
are limited to 4,096 bytes; context components must be nonempty and bounded, and field names must be
stable ASCII identifiers. Errors expose no plaintext, ciphertext, context, or key material.

`encryptBankData` and `decryptBankData` intentionally do not load or provision keys, authorize a caller,
write a reveal audit, mask normal views/history, or access the database. A caller must not expose the
plaintext result except through the future separately authorized and audited reveal path. Focused tests
cover round-trip and ciphertext secrecy, nonce uniqueness, tenant/partner/record/field and key-ID
binding, ciphertext tampering, missing prior keys, active-key rotation behavior, malformed envelopes,
and invalid key material/context. Six tests pass; `npm run typecheck` and `git diff --check` pass.

**Boundary:** no key configuration or real key material was read, written, or committed. No schema,
migration, database, profile, contact, bank-record service, UI, masking/history filter, reveal authority,
or bank identifier was added. Test inputs are non-bank placeholders with ephemeral test-only keys.
B-055's separate keyring configuration is recorded in §26.72; bank-record storage remains blocked until
the full D-059/D-060/D-067/D-068 security gate is complete. No commit or push; §25.4's full-system publish
trigger remains authoritative.


### 26.72 B-055 — Fail-closed deployment-secret keyring configuration `IMPLEMENTED — NOT INTEGRATED`

**Configuration contract (D-068):** the runtime secret is `CAIRN_BANK_DATA_KEYRING_JSON`, a JSON object
with exactly two properties: `activeKeyId` and `keys`. `keys` maps each valid key ID to canonical,
unpadded base64url encoding of exactly 32 bytes; the active ID must exist, there must be 1–16 keys, and
unknown top-level properties, malformed JSON, invalid IDs, noncanonical encoding, wrong key sizes, and
oversized values fail closed. High-entropy bytes must be generated by a cryptographically secure source;
the parser checks byte size/encoding, not entropy. Prior IDs/keys must remain available until ciphertext
written with them has been re-encrypted and verified.

`src/platform/security/bank-data-keyring.ts` exposes a lazy environment loader and a pure parser. Importing
the module does not read the environment. Missing or invalid configuration throws one generic typed error
without echoing the supplied JSON or key bytes; there is no generated, hard-coded, or development fallback.
Docker Compose passes the variable only into the application container, not the migration job. `.env.example`
and `.env.development.example` contain comments/placeholders only; no actual key values were read, written,
or committed. No current service calls the loader, so this does not enable or authorize bank-data access.

Seven pure tests pass for active/retained keys, unset configuration, malformed/unsupported shapes, missing
active keys, encoding/size/ID validation, key-count limits, and generic error redaction. The focused encryption
and keyring suites pass 13/13; `npm run typecheck` and `git diff --check` pass. No database setup or test
global cleanup ran.

**Boundary:** no deployment key was generated or provisioned; tests used only ephemeral test keys. No
database, schema, key-rotation/re-encryption job, profile, bank/contact service, reveal authority,
masking/history safeguard, or bank identifier was added. B-056's pure envelope helper is recorded in §26.73;
operational migration and key retirement remain future work. Full partner-bank storage remains blocked until
the D-059/D-060/D-067/D-068 security gate is complete. No commit or push; §25.4's full-system publish trigger
remains authoritative.


### 26.73 B-056 — Authenticated bank-data envelope re-encryption helper `IMPLEMENTED — PURE`

**Contract (D-069):** `reencryptBankData(envelope, context, keyring)` first fully authenticates and decrypts
the envelope using the key ID and context-bound associated data. If the envelope is already under the active
key ID, it returns the original string only after that verification succeeds. Otherwise, it encrypts the
transient plaintext with the supplied active key and a fresh nonce, returning a new versioned envelope; it
never returns or logs plaintext. Invalid/tampered ciphertext, a mismatched client/partner/record/field, or a
missing retained old key fails closed with the existing generic cryptography error.

The helper is pure with respect to storage: it does not update a row, write audit/history, authorize a reveal,
retire keys, or schedule a bulk migration. Callers must own any transaction, persistence, re-encryption
progress tracking, post-migration verification, and old-key retirement. The prior key must remain available
until all ciphertext using it has been migrated and verified.

Two added focused tests cover old-to-active re-encryption, ciphertext-only return, same-key idempotence,
verification before no-op, tamper/context refusal, and missing-prior-key failure. The encryption suite passes
8/8 and, with the seven B-055 keyring tests, the focused security suites pass 15/15. Typecheck and diff check
pass; tests use ephemeral keys and no database setup/global cleanup.

**Boundary:** no database, schema, bank field, real key, bank identifier, reveal authority, masking/history
safeguard, operational re-encryption job, or key-retirement behavior was added. Bank storage stays blocked;
B-057's history redaction boundary and separately audited reveal remain prerequisites. No commit or push;
§25.4's full-system publish trigger remains authoritative.

**Status update (v0.72):** B-057's write/read history redaction is recorded in §26.74. Ordinary-view masking,
separately audited reveal, and operational rotation/old-key retirement remain outstanding.


### 26.74 B-057 — Partner bank/contact history redaction `IMPLEMENTED — HISTORY ONLY`

**Privacy contract (D-070):** the generic `recordChange` path now applies an allowlisted projection before
serializing snapshots for the canonical object classes `partner_bank` and `partner_contact`. Bank IBAN,
local-account/account-number/account-identifier values (including ciphertext-column aliases) are replaced
with the fixed `[masked]` marker. Named-contact email and phone fields are likewise fully masked; no last
characters or length are retained. Approved non-sensitive fields such as account holder, country, bank name,
bank code/BIC, contact name/title/function, validity, active state and primary state remain in history.
Unknown and nested fields are dropped rather than serialized.

For these classes the generic free-form `reason` and caller-supplied field labels are omitted, because they
could smuggle sensitive values; safe field labels are regenerated from field names. Sensitive changes whose
before/after values both project to `[masked]` are still recorded when their in-memory source values differ;
true no-ops remain silent. The source values are used only for this equality check and never enter history.
`changeHistory` also reprojects stored values on read, replaces stored field labels, strips reasons and drops
unknown fields, providing defense in depth for any older/miswritten item. Organization-level
`business_partner` email/phone history remains unchanged. Future writers must use the exported canonical
object-class constants and opaque record IDs; alternate object classes are not covered by this policy.

Five isolated tests cover bank and contact masking on create/change, unknown-field and reason/label
suppression, masked change vs true no-op, read-time redaction of stored values, and preservation of general
partner email/phone. Typecheck and `git diff --check` pass; no database setup/global cleanup ran.

**Boundary:** this safeguards generic history only. It does not implement ordinary-view masking, at-rest
column integration, reveal authorization/audit, bank/contact storage, or key rotation operations. No schema,
migration, database, real bank identifier, or deployment key was added. B-058 must specify the separate
audited reveal contract; bank storage remains blocked until the full security gate is complete. No commit or
push; §25.4's full-system publish trigger remains authoritative.

**Status update (v0.73):** B-058 has specified the reveal contract (§26.75, D-071); audit-log hardening and
all reveal/view/storage implementations remain pending.


### 26.75 B-058 — Bank-data reveal authorization and audit contract `SPECIFIED — NOT IMPLEMENTED`

**Owner-selected policy (D-071):** a reveal requires both `FND.PARTNER.DISPLAY` and the dedicated
`SEC.PARTNER.BANK.REVEAL` capability, using the normal capability-pattern matcher. `FND.*` and `AUDIT.*`
do not match the `SEC` namespace, but the Administrator's `*` does grant reveal. Check the verified session
and both authorities before reading/decrypting a record. Missing-capability messages follow D-045; no
unauthorized request may expose whether a bank record exists.

One operation may request one or more allowlisted account-identifier fields—IBAN and/or local account number.
It does not reveal bank code/BIC, named-contact email/phone, or other fields. Require exactly one controlled
purpose code: `PARTNER_SUPPORT`, `DATA_CORRECTION`, `AUDIT_REVIEW`, or `LEGAL_REGULATORY`; no free-text
reason is accepted or logged.

Every authenticated operation attempt, successful or denied, is recorded in the existing tenant-scoped
`audit_access_log`. Success uses `event_type=READ`; missing authority uses `CAPABILITY_DENIED`; other
validation, record, or cryptographic denials use `READ` with a fixed denial code. Use
`transaction_code=SEC.PARTNER.BANK.REVEAL`, `object_type=partner_bank`, and an opaque bank-record `object_key`.
Tenant, actor ID and username come only from the verified session; the fixed-schema `detail` may contain the
partner key, selected field names, outcome, approved purpose code and fixed denial code. Never log identifier
values, ciphertext, key IDs/material, or raw invalid input. An unauthenticated request redirects to sign-in;
without a verified tenant/actor, no tenant-scoped reveal event is written.

The success audit row must commit before any plaintext is returned. If audit persistence fails, deny the reveal
and return no plaintext. Authorization, field/purpose validation, missing-record and cryptographic failures
also return no plaintext; non-authorization failures use a generic response that does not distinguish record
existence or expose cryptographic details. B-059 must first add database-enforced UPDATE/DELETE protection
for runtime access to `audit_access_log` (the current runtime grants include both). This batch changed no code,
capability catalogue, schema, migration, database or data; no tests were applicable. No commit or push; bank
data remains blocked pending implementation of the complete security gate.

**Status update (v0.74):** B-059 revoked direct runtime mutation of `audit_access_log` (§26.76). The owner
explicitly retained the existing whole-tenant `ON DELETE CASCADE` as a lifecycle/retention exception (D-072).


### 26.76 B-059 — Runtime audit-log mutation protection `IMPLEMENTED — DIRECT DML`

Added immutable migration `drizzle/9015_audit_access_log_append_only.sql`. It revokes `UPDATE`, `DELETE`,
and `TRUNCATE` from `cairn_app` on `audit_access_log`; existing `SELECT` and `INSERT` grants remain, so
runtime history can still be read and written. The change is narrowly scoped to this table. No trigger is
needed for direct DML because PostgreSQL rejects the operation at privilege check.

The owner explicitly selected the existing full-tenant `client` → `audit_access_log` `ON DELETE CASCADE`
as a permitted lifecycle/retention exception. B-059 leaves that FK and tenant-delete behavior unchanged;
whole-tenant deletion can still remove that tenant's logs through the cascade. This is the stated limit of
the direct-row append-only guarantee (D-072), not protection against every privileged lifecycle action.

Added `tests/audit-access-log-append-only.test.ts` to verify runtime SELECT/INSERT remain allowed, UPDATE/
DELETE/TRUNCATE are denied, and a tenant cascade still cleans the isolated development fixture. The integration
test was not run because no confirmed disposable development database was available; no database or owner/
production data was accessed. Typecheck and `git diff --check` pass. No reveal endpoint, capability entry,
bank data, or new audit table was added. No commit or push; §25.4's full-system publish trigger remains.

**Status update (v0.75):** B-060 adds the verified-session reveal gate and safe attempt/final-outcome writer
(§26.77, D-073). It remains a non-data boundary; no bank identifier is stored or returned.


### 26.77 B-060 — Session-bound reveal authorization and audit writer `IMPLEMENTED — NO DATA PATH`

Added `src/platform/security/bank-data-reveal.ts`. It requires a verified `SessionContext`, checks both
`FND.PARTNER.DISPLAY` and `SEC.PARTNER.BANK.REVEAL` using the existing matcher, validates requested fields
against `iban`/`localAccountNumber`, restricts purpose to the four D-071 codes, and accepts only safe-format
partner/bank-record keys. Tenant, actor ID and username are taken from the session; request-supplied identity,
free text, unknown fields and invalid key text are never copied into the audit detail.

`authorizeAndRecordBankRevealAttempt` inserts a safe `READ` or `CAPABILITY_DENIED` event. For an allowed
request its `AUTHORIZED` outcome means only that the gate passed—not that plaintext was read. The future
data service must then call `recordBankRevealOutcome` with terminal `SUCCESS` or a fixed-code `DENIED`, in the
same transaction, and return plaintext only after commit. Audit-write failures throw a generic denial error;
a caller must return logged denials from the transaction rather than throw inside it and roll back the event.
Neither helper reads data, decrypts ciphertext, nor returns plaintext.

Registered `FND.PARTNER.DISPLAY` and `SEC.PARTNER.BANK.REVEAL` in the idempotent global capability seed;
no role grant, command route or user interface was added, and the seed was not run. Normal role-pattern
semantics remain: Administrator `*` grants reveal, while `FND.*`/`AUDIT.*` do not. Seven isolated fake-Tx
tests pass for explicit/wildcard authority, session-derived actor/tenant, safe audit metadata, denied/invalid
requests, terminal outcomes and audit-write failure. Typecheck and `git diff --check` pass. No database,
key, bank record, decryption path or UI was used or added. No commit or push; §25.4's full-system publish
trigger remains authoritative.

**Status update (v0.76):** B-061 specifies ordinary-view identifier masking in §26.78 (D-074); implementation
remains a separate pure-projection batch. History stays fully masked, and the audited reveal gate is unchanged.


### 26.78 B-061 — Normal-view bank-identifier masking format `SPECIFIED — NOT IMPLEMENTED`

Owner selected a fixed `••••` marker for list/summary views and `••••` followed by the final four characters
for detail views of IBAN and local account number. Do not retain the country prefix or original identifier
length. If an identifier has four or fewer characters, show only `••••` so a short local account can never
become fully visible through the suffix rule. Use the final four characters as stored; never normalize or
change the underlying local account value for display. This does not alter bank code/BIC treatment, named
contact behavior or the full-value audited reveal flow. History remains fully `[masked]` under D-070.

B-061 was a policy-only batch: no code, UI, bank data, database or tests changed. D-074 records the choice;
B-062 implements the pure view projection only. No commit or push; §25.4's full-system publish trigger remains
authoritative.

**Status update (v0.77):** B-062 adds the pure allowlisted projection in §26.79 (D-075); no normal-view
route currently uses it. B-063 begins the first country-profile validator, KW only.


### 26.79 B-062 — Pure normal-view bank-identifier projection `IMPLEMENTED — NOT INTEGRATED`

Added `src/platform/security/partner-bank-view.ts`. `projectPartnerBankNormalView` reuses B-057's strict
`partner_bank` allowlist, then applies D-074: list mode returns fixed `••••`; detail mode returns `••••` plus
only the last four characters when the value exceeds four characters. Short values remain fully masked; empty,
null and undefined values remain empty/absent. Ciphertext aliases, unknown fields and nested non-sensitive
values are omitted; safe allowlisted metadata is preserved. A malformed nested value in an identifier field
is replaced by the fixed mask rather than exposed.

Three pure tests cover list and detail formats, suffix/length/country-prefix hiding, short values, empty values,
ciphertext omission, and unknown/nested-field dropping. The new tests plus B-057 history and B-060 reveal
boundary suites pass 15/15. Typecheck and `git diff --check` pass; no database, bank record, decryption, route
or UI was used or added. This helper does not authorize reads and no existing view calls it yet. No commit or
push; §25.4's full-system publish trigger remains authoritative.

**Status update (v0.78):** B-063 implements the pure KW profile helper (§26.80, D-076). It is not persisted,
activated, or connected to any bank-data flow.


### 26.80 B-063 — Pure Kuwait (`KW`) bank-profile validator `IMPLEMENTED — NOT ACTIVATED`

Added `src/platform/security/bank-profile-kw.ts`. It requires a non-empty account holder and country `KW`,
normalizes the IBAN to uppercase after removing ASCII spaces, and validates the exact 30-character
`KW` + check digits + four-letter bank code + 22-character alphanumeric account format. MOD-97 is checked
with a streaming remainder. The profile rejects any separate non-empty local account number and derives the
bank code from IBAN positions 5–8; an optional supplied bank code is accepted only if it matches that derived
value. Optional BIC/SWIFT is normalized and syntax-checked only; no directory, bank or account-existence
lookup occurs. Failures return fixed error codes, never raw input.

Four pure tests pass using only a synthetic KW-format identifier; they cover normalization/derivation, optional
BIC, KW-only/IBAN-only requiredness, structure/checksum, and mismatch/invalid-BIC failures. Typecheck and
`git diff --check` pass. No database, profile registry/activation, schema, bank storage, actual bank value,
decryption, or UI was used or added. This helper is not called by any save path. B-064 (IN profile) is next;
no commit or push; §25.4's full-system publish trigger remains authoritative.

**Status update (v0.79):** B-064 adds the pure IN profile helper (§26.81, D-077). It is not persisted,
activated, or connected to any bank-data flow.


### 26.81 B-064 — Pure India (`IN`) bank-profile validator `IMPLEMENTED — NOT ACTIVATED`

Added `src/platform/security/bank-profile-in.ts`. The pure helper requires a non-empty account holder and
country `IN`. It requires a non-empty local account number and returns it exactly as supplied, preserving
leading zeros and any bank-specific representation; it imposes no India-wide account-number length, syntax,
checksum, padding, or truncation rule. Non-string account input is rejected with a fixed error. The profile
rejects a non-empty IBAN. It requires IFSC in the existing `bankCode` field, trims and uppercases it, and
validates exactly `^[A-Z]{4}0[A-Z0-9]{6}$`. Optional BIC/SWIFT is normalized and syntax-checked only. No
IFSC directory, bank, branch, account-existence, or payment-rail lookup occurs; account type remains outside
this bank-master profile. Failures expose only fixed error codes, and unknown input properties are not returned.

Five isolated tests pass with synthetic identifiers only. They cover IFSC/BIC/country normalization, exact
opaque account preservation without a national format/length rule, required fields, IBAN rejection, invalid
IFSC/BIC and rejection of non-string account input. Typecheck and `git diff --check` pass. No profile registry
or activation, persistence, schema, database, bank storage/data, decryption, save path, route, or UI was used
or added. The helper is not enabled or called by any save path. No commit or push; §25.4's full-system publish
trigger remains authoritative.

**Status update (v0.80):** B-065 adds pure GB, US and JP validators (§26.82, D-078–D-080). All five
initial-country validators are still unregistered, unactivated and disconnected from bank-data flows.


### 26.82 B-065 — Pure GB, US and JP bank-profile validators `IMPLEMENTED — NOT ACTIVATED`

Added `src/platform/security/bank-profile-gb.ts`, `bank-profile-us.ts` and `bank-profile-jp.ts`.

**GB:** Requires account holder and country `GB`; removes ASCII spaces, uppercases, enforces the 22-character
`GB` + check digits + four-letter institution code + 14-digit format, and validates MOD-97. Derives the bank
code from IBAN positions 5–8, checks any supplied bank code for consistency, and rejects a separate non-empty
local account number. Optional BIC receives syntax-only validation; no account/branch lookup or payment-rail
claim is made.

**US:** Requires account holder, country `US`, an opaque non-empty local account number, and a nine-digit ABA
routing transit number in `bankCode`. It enforces the `01–12` or `21–32` routing-symbol range and the 3-7-1
mod-10 check digit. The account number is preserved exactly with no U.S.-wide length, pattern, checksum,
padding or truncation rule. Optional BIC receives syntax-only validation. No live directory, assignment/currentness,
payment-rail or account-existence claim is made; a non-empty IBAN is rejected.

**JP:** Requires account holder, country `JP`, an opaque non-empty local account number and exactly seven ASCII
digits in `bankCode` for the institution-plus-branch composite. Leading zeros in both identifiers are preserved;
no nationwide local-account format/length/checksum or padding/truncation rule is imposed. Optional BIC receives
syntax-only validation. No directory/account lookup or Japan Post symbol/number conversion is performed; for
Japan Post the caller must supply the transfer-compatible representation described by D-066. A non-empty IBAN
is rejected.

Four GB, five US and five JP isolated tests pass with synthetic fixtures only (14 total). They cover country and
identifier normalization, GB structure/MOD-97/derived bank code, US routing range/check digit, JP composite
format, opaque account preservation, optional/invalid BIC, required fields and IBAN/local-account rejection.
Typecheck and `git diff --check` pass. No profile registry or activation, persistence, schema, database, bank
data, encryption/decryption, save path, route or UI was used or added. These helpers are not called by any save
path. No commit or push; §25.4's full-system publish trigger remains authoritative.

**Status update (v0.81):** B-066 enforces `FND.PARTNER.DISPLAY` before partner data reads on the actual
`/foundation/partners` route (§26.83, D-081). No reveal path is added; opaque bank-record-ID handling remains
unresolved and blocks any future reveal execution path.


### 26.83 B-066 — Partner display-route authorization `IMPLEMENTED — NO BANK DATA PATH`

`src/app/foundation/partners/page.tsx` now checks the session's `FND.PARTNER.DISPLAY` capability immediately
after session resolution and before awaiting route/search parameters or calling partner, company, country, or
history read services. A missing capability receives the explicit missing-authority message without any partner
data query. The page code label now identifies the display authority. `FND.PARTNER.MAINTAIN` remains a separate
write authority enforced by the existing UI condition and server actions; supplier/customer segment reads retain
their own capability checks.

Added `tests/partner-display-page-auth.test.tsx`. Its denial case verifies the actual page guard is evaluated
before `searchParams` can be read. The isolated route test passes; typecheck and `git diff --check` pass. The test
used a mocked session and no database. No bank data, reveal route, decryption, or bank-record-ID handling was
added; B-060's ID-opacity concern remains a blocker before any reveal execution path. No commit or push;
§25.4's full-system publish trigger remains authoritative.

**Status update (v0.82):** B-067 defines server-generated UUIDv4 bank-row IDs and tightens the reveal
boundary's shape check (§26.84, D-082). This does not establish ID provenance; a tenant/partner-scoped row
lookup is still required before any reveal path.


### 26.84 B-067 — Bank-record ID generation contract `IMPLEMENTED — NO STORAGE OR REVEAL`

Added `src/platform/security/bank-record-id.ts`. `generateBankRecordId()` uses Node's cryptographic `randomUUID`
to create a canonical lowercase UUIDv4; `BankRecordId` is a compile-time brand, and `isBankRecordId()` checks
UUIDv4 shape only. B-060's reveal-audit boundary now accepts only that shape and returns `INVALID_OBJECT_KEY`
for malformed/sequential IDs, writing a null audit object key rather than echoing the invalid input.

This is not proof that a well-shaped UUID was generated by the app or belongs to the requested partner. The
future repository must generate IDs with this helper and resolve every requested row under the session-derived
tenant, selected partner and supplied ID, then use the matched row's ID for audit/encryption context. It must
never treat a raw client-provided UUID as a trusted record reference. No partner-bank table, row creation, lookup,
persistence, database, bank value, reveal path or decryption was added; the opacity blocker remains until that
scoped data path is implemented and verified.

Three ID-helper tests and eight B-060 boundary tests pass (11 total), including a test documenting that UUID
shape alone cannot attest provenance. Typecheck and `git diff --check` pass. No commit or push; §25.4's
full-system publish trigger remains authoritative.

**Status update (v0.83):** B-068 enforces the UUIDv4 record-ID format at the encryption-context boundary
(§26.85, D-083). Tenant/partner-scoped row lookup is still absent and remains a prerequisite before reveal.


### 26.85 B-068 — UUIDv4 enforcement in bank-data encryption context `IMPLEMENTED — NO STORAGE OR REVEAL`

`src/platform/security/bank-data-encryption.ts` now types `BankDataContext.bankRecordId` as `BankRecordId` and
runtime-validates it with `isBankRecordId()` before including it in GCM associated data. Encrypt, decrypt and
re-encrypt therefore reject noncanonical/non-v4 record IDs with the existing generic crypto error. Valid row IDs
remain bound to the authenticated client, partner, field and key ID as before.

The pure crypto layer does not establish where a valid-shaped ID came from. A future bank repository must create
row IDs with `generateBankRecordId()` and load records using authenticated tenant + selected partner + ID before
any reveal operation; B-068 does not implement that lookup. Eight encryption tests, three ID-helper tests and
eight B-060 audit-boundary tests pass (19 total). Typecheck and `git diff --check` pass. No schema, persistence,
database, bank data, reveal route or decryption caller was added. No commit or push; §25.4's full-system publish
trigger remains authoritative.

**Status update (v0.84):** B-069 adds a pure batch re-encryption transformer (§26.86, D-084). It operates
only on rows supplied by a caller; no database scan or old-key retirement verification is implemented.


### 26.86 B-069 — Pure batch bank-data re-encryption `IMPLEMENTED — NO PERSISTENCE`

Added `reencryptBankDataBatch` to `src/platform/security/bank-data-encryption.ts`. It accepts one bounded
caller-supplied set of records, validates UUIDv4 row IDs and per-field authenticated context, re-encrypts each
non-null envelope with the active key, authenticates and preserves already-current envelopes, preserves nulls,
and returns ciphertext-only row projections plus a changed-field count. It does not mutate inputs, return
plaintext, read/write a database, log values, or persist partial results; an invalid envelope fails the call.

Three new batch tests cover re-encryption, current-key no-op, null preservation, input immutability, ciphertext-only
output and fail-closed invalid input. Together with the ID and reveal-boundary suites, 22 focused tests pass.
Typecheck and `git diff --check` pass. No actual bank values, schema, database scan, persistence, operational
monitoring, exhaustive re-encryption verification or old-key retirement was used or added. A future runner must
process all rows in bounded tenant-scoped transactions, verify every envelope against the active key and retire
prior keys only after verified completion. No commit or push; §25.4's full-system publish trigger remains
authoritative.

**Status update (v0.93):** B-078 closes B-077's live-acceptance gap on a fresh disposable PostgreSQL 17.11 cluster.
The custom runner applied all 32 lexical SQL migrations, then the T992 Business Partner target passed for both the
maintainer and a display-only user: Bank Details showed the empty state without Save or reveal controls. The Drizzle
journal/snapshots ending at 0008 are not read by this runner and did not affect acceptance; future Drizzle Kit
migration generation still requires a separate metadata reconciliation. The target cleaned up T992, verified absent;
the cluster used only a private Unix socket with TCP disabled and was removed. `npm run typecheck`, browser-harness
(66/66), and `git diff --check` pass. No owner/production or persistent development database, bank rows, or real
identifiers were accessed. B-076's view remains read-only; encryption-key retirement, encrypted writes/reveal, and
contact UI remain separate gates. No commit or push.

**Status update (v0.94):** After B-078, the owner explicitly instructed a one-time publication of the pending bank-data
batch to `main`, overriding §25.4's full-system gate for this batch only. The standing no-partial-push rule remains
for future batches. Commit `9a39286` was pushed successfully; §26.96 records the publication. No credential was
included in the commit, remote URL, or source.


### 26.87 B-070 — Active-key verification for supplied batches `IMPLEMENTED — NO GLOBAL RETIREMENT PROOF`

Added `verifyBankDataBatchOnActiveKey` to `src/platform/security/bank-data-encryption.ts`. It requires a keyring
with exactly one key—the active key—then checks each non-null envelope's key ID and authenticates/decrypts it
against the record's client, partner, UUIDv4 row ID and field context. It returns only the active key ID and
record/field counts; it does not return plaintext. Retained-key rings and prior-key envelopes fail closed.

Two tests cover a successfully re-encrypted batch, rejection of an old-key envelope, and refusal of a keyring
that still includes prior keys. Thirteen encryption tests plus three ID-helper and eight audit-boundary tests pass
(24 total). Typecheck and `git diff --check` pass. The verifier only speaks for supplied rows; it does not prove
a database scan was complete, cover concurrent writes, persist results, or authorize retiring any key. No database,
real bank data, schema, reveal path, or commit/push was used.


### 26.88 B-071 — Pure partner-bank country-profile dispatcher `IMPLEMENTED — NOT INTEGRATED`

Added `validatePartnerBankProfile` in `src/platform/security/partner-bank-profile.ts`. It trims and uppercases
the country code, then dispatches only to the implemented KW, IN, GB, US, or JP pure validator. Missing country
returns `COUNTRY_REQUIRED`; any other country returns `PROFILE_UNAVAILABLE`; there is no fallback profile.
Country-specific validation remains in the individual profile helpers and follows D-060–D-066/D-076–D-080.

Added three synthetic dispatcher tests covering all five country paths, country-code normalization, and missing/
unsupported-country rejection. The dispatcher suite and all five profile suites passed: 26 tests across six files.
`npm run typecheck` passes. This helper does not activate profile validation in an application save path, persist
records, create schema or database state, establish profile readiness beyond these helpers, or contain real bank
data. No lookup, reveal path, commit, or push was added.


### 26.89 B-072 — Ciphertext-only partner-bank schema and read-only RLS `IMPLEMENTED — TESTED IN B-073`

Added `partner_bank` to the typed Foundation schema and registered it at the schema root. Migration
`0013_partner_bank_master.sql` defines the partner-wide row with a server-generated UUIDv4 key, required
holder/country, optional bank metadata, validity dates, active/version/audit fields, and exactly one of two
account-identifier envelope columns: `iban_ciphertext` or `local_account_number_ciphertext`. There are no
plaintext identifier columns. Database checks require the `cbd1` envelope shape, UUIDv4 variant/version,
nonblank holder, valid date order and positive version; overlapping validity remains allowed. Tenant deletion
follows D-041's client cascade; deleting a partner row directly is blocked while bank records exist.

Migration `0013_partner_bank_master.sql` enables and forces RLS immediately, with no policy yet, so the table
default-denies even if the existing `9000` migration or its default privileges grant DML. Migration
`9016_partner_bank_policies.sql` installs the scoped SELECT policy, revokes all app-role privileges previously
granted by `9000`, and grants only SELECT; the app cannot insert, update, delete or truncate partner-bank rows.
Four typed-schema/static-contract tests and `npm run typecheck` passed at B-072 completion; at that point, no
migration had been applied. B-073's disposable acceptance later caught PostgreSQL's repetition-count limit in
the initial envelope regex. Migration `0014_partner_bank_envelope_bound.sql` replaces those constraints using a
PostgreSQL-safe nonempty payload pattern and a 5,540-character total-envelope cap, without editing `0013`.
See §26.90 for final live acceptance. The shape constraint does not authenticate ciphertext. No bank-row service, save path, scoped lookup, bank data, UI, reveal path, commit or push was added.


### 26.90 B-073 — Disposable PostgreSQL acceptance for partner-bank schema `PASSED — CLUSTER REMOVED`

Downloaded/extracted PostgreSQL 17.11 binaries under a temporary `/tmp` directory, initialized a fresh local
cluster with host connections disabled, and applied every SQL migration in `drizzle/` in lexical order. The
cluster used only local Unix-socket connections. Synthetic development tenants `T991`/`T992`, partners, and
placeholder envelopes were created only inside this disposable database; the cluster, package files, and test
rows were removed by the cleanup trap. No configured, owner, production, or persistent development database was
contacted.

The first fixture insert exposed a PostgreSQL ARE repetition-count limit: the initial migration's `{1,5462}`
regex could not be evaluated. Kept migration `0013` unchanged and added `0014_partner_bank_envelope_bound.sql`.
It uses a nonempty URL-safe payload pattern plus a total-envelope cap of 5,540 characters, matching the 4,096-byte
plaintext limit; the 5,540-character boundary was accepted and 5,541 was rejected. All migrations, including
`0014` and `9016`, then applied successfully.

Live checks passed: multiple same-partner records with overlapping validity were accepted; missing/both identifier
envelopes, plaintext in a ciphertext column, a non-v4 UUID, blank holder, inverted dates, version zero, unknown
country and oversize envelope were rejected. Forced RLS flags were both true. The `cairn_app` role had SELECT but
not INSERT/UPDATE/DELETE/TRUNCATE; unscoped reads returned no rows, tenant-scoped reads saw only their tenant,
and cross-tenant reads were hidden. App-role DELETE was denied, direct partner deletion was blocked while bank
rows existed, and tenant deletion cascaded to the synthetic bank rows under D-041. Five typed-schema/static
contract tests and `npm run typecheck` pass; `git diff --check` passes.

This proves the migration/constraint/RLS behavior only on the temporary PostgreSQL cluster. It does not prove
ciphertext authenticity, operational key rotation or global retirement, nor add a bank-row service, write path,
scoped lookup, UI, reveal path or contact storage. No commit or push.


### 26.91 B-074 — Read-only, scoped partner-bank metadata lookup `IMPLEMENTED — NO REVEAL OR UI`

Added `lookupPartnerBankMetadata` in `src/modules/foundation/partner-bank-reads.ts`. It requires
`FND.PARTNER.DISPLAY` through the existing capability matcher, validates the session-derived tenant, selected partner
number and canonical UUIDv4 row ID, then calls `withTenant` using the session tenant. Its single-row query binds
`partner_bank.client`, `partner_bank.partner_number`, and `partner_bank.bank_record_id` together. The result is a
strict allowlist of non-ciphertext metadata plus `bankRecordId` from the matched database row; encrypted IBAN and
local-account columns are not selected, and no account-identifier plaintext, decryption or reveal authority is involved.
Invalid selectors, invalid returned row IDs and absent rows return `null`; callers cannot supply a tenant.

Four focused tests verify authorization denial without a query, the tenant/partner/row-ID SQL predicates and bound
values, the metadata-only projection, and invalid/missing-row behavior. `npm run typecheck` and `git diff --check`
pass. Tests use a fake tenant transaction and Drizzle PostgreSQL SQL rendering; no live or persistent database was
accessed. No writes, audit/reveal integration, save path, route, UI, masking projection, bank values, commit or push
were added. Normal bank identifiers remain subject to D-074 masking, and any future reveal must retain all existing
authorization, audit-before-return, fail-closed audit, encryption, provenance and key-retirement gates. The metadata
lookup is not an encrypted-row reveal loader.


### 26.92 B-075 — Read-only, scoped partner-bank metadata list `IMPLEMENTED — NO REVEAL OR UI`

Added `listPartnerBankMetadata` to `src/modules/foundation/partner-bank-reads.ts`, reusing the single-row metadata
allowlist from B-074. It requires `FND.PARTNER.DISPLAY`, validates the session-derived tenant and selected partner,
then runs through `withTenant` with explicit predicates on `partner_bank.client` and `partner_bank.partner_number`.
No caller-supplied tenant is accepted. The projection excludes both encrypted account-identifier columns and any
plaintext IBAN/local-account field; every returned row ID is UUIDv4-checked and comes from that database row.

The query returns all matching rows, including inactive and out-of-validity history, without an implicit truncation.
Rows are ordered by `validFrom` descending and UUIDv4 row ID ascending for deterministic display. Invalid selectors or
an invalid-shaped row ID fail closed as `null`; a valid partner with no rows returns an empty list.

Four added tests cover display denial without a query, tenant/partner predicates and parameters, stable ordering,
inactive-row inclusion, metadata-only projection, invalid selectors, empty results, and malformed database IDs. The
focused metadata-read suite passes 8/8; `npm run typecheck` and `git diff --check` pass. Tests use a fake tenant
transaction and Drizzle PostgreSQL SQL rendering; no live or persistent database was accessed. Tests use only synthetic
metadata placeholders; no bank rows were persisted. No real account identifiers, ciphertext, decryption, writes,
audit/reveal path, masking projection, route, UI, or commit/push were added. Ordinary-view
masking and all existing encryption, UUID-provenance, key-retirement, and audited-reveal gates remain unchanged.



### 26.93 B-076 — Display-only masked bank metadata tab `IMPLEMENTED — NO LIVE DB/BROWSER ACCEPTANCE`

Added the explicit `BANKS` tab to the selected-partner navigation in `src/app/foundation/partners/page.tsx` and a
server-rendered `PartnerBankMetadataPanel`. The query runs only when that tab is selected; the existing general view
and other segments do not call the partner-bank list service. The route's existing `FND.PARTNER.DISPLAY` guard remains
before search-parameter reads, and the panel receives only B-075's session-tenant/partner-scoped metadata result.

The panel is display-only and shared across Supplier/Customer roles. It shows account holder, country, bank name/code,
BIC, validity dates and active state. The identifier column renders only the fixed `••••` list mask from D-074, with an
accessible “masked” label. Bank-record IDs are used only as render keys and are not printed; ciphertext and full
identifier values are not queried or passed to the component. No edit, save, reveal, detail-suffix, or history action
is exposed on this tab. It is available only to the already-authorized partner-display route.

Two panel-render tests cover safe metadata, fixed masking, row-ID/ciphertext omission and empty/unavailable states. Two
route tests verify display denial avoids the bank read and the explicit `BANKS` tab alone invokes the list service with
the authenticated session and matched partner. The focused tests pass 4/4; typecheck, production build,
and `git diff --check` pass. A temporary
Vitest configuration used JSX automatic mode and disabled destructive global setup; it was removed. No live database,
migration application, browser acceptance, actual bank row or real account identifier was used. The new tab requires
the bank migrations in the target database; acceptance must use a fresh disposable development database only.

This does not add bank/contact maintenance, operational key rotation/re-encryption, old-key retirement, normal-detail
suffix display, audited reveal/decryption, or contact views. D-074's summary mask is integrated only for this tab; the
full bank-data gate remains closed. No commit or push; §25.4's full-system publish trigger remains authoritative.



### 26.94 B-077 — Business Partner browser target coverage for bank metadata `IMPLEMENTED — ACCEPTED IN B-078`

Extended `scripts/browser-smoke/checks.ts`'s existing `business-partners` target (reserved development fixture T992).
After creating the partner through the UI, the target opens the `BANKS` tab, verifies the no-record empty state, and
asserts that neither save nor reveal controls appear. It returns to General data and later repeats the empty-state and
no-maintenance/no-reveal checks after signing in as a display-only warehouse user. The target creates no bank row or
bank/account value; the fixed-mask rendering remains covered by B-076's component test. The target label was updated
to describe its bank-summary coverage.

At B-077 completion, `npm run typecheck` and `npm run test:browser-harness` (66/66) passed, and
`npm run smoke:browser -- --list` confirmed the updated Business Partner target was selectable. Live acceptance was
then pending because no confirmed disposable database was available; §26.95 records the subsequent B-078 acceptance.
The target's fixture guard still refuses to delete a tenant unless it matches the exact reserved T992 development
fixture. No commit or push; §25.4's full-system publish trigger remains authoritative.


### 26.95 B-078 — Drizzle metadata review and disposable B-077 browser acceptance `PASSED — CLUSTER REMOVED`

**Metadata review.** At this revision, `drizzle/meta/_journal.json` and snapshots end at `0008`, while the SQL
folder continues through `0014` and policy files through `9016`. `src/platform/db/migrate.ts` does not read Drizzle
metadata: it applies every `drizzle/*.sql` file in lexical order and records its filename/checksum in
`cairn_migration`. The discrepancy therefore did not affect the fresh-database acceptance procedure. Metadata was not
changed; future Drizzle Kit generation/snapshot-diff behavior remains unreviewed and must be resolved separately
before relying on that workflow.

**Disposable acceptance.** Extracted PostgreSQL 17.11 binaries under `/tmp`, initialized a fresh cluster with TCP
listening disabled, host authentication rejected, and a private Unix socket only. A local migration role had
`BYPASSRLS`; `cairn_app` was non-superuser and did not bypass RLS. The custom runner applied all 32 SQL migrations;
shared reference and global catalogue seeds loaded into that disposable database. No configured, unverified,
persistent development, owner, or production database was contacted.

`npm run smoke:browser:business-partners` passed on the built app against the disposable database. The T992 fixture
was created through onboarding and cleaned by the target; a post-run query confirmed no T992 development fixture
remained. Maintainer and display-only partner viewer both saw the Bank Details empty state with no Save or reveal
controls. The existing partner create/maintain/no-op, dual-role, block/unblock, invalid-country, search, and history
checks also passed. No bank record, bank/account value, ciphertext, or real identifier was created or read.

The browser harness now satisfies the optional owner-token form field with a per-run random value only if that field
is rendered; the runner remains development-only. Its synthetic T992 warehouse viewer is granted
`FND.PARTNER.DISPLAY` without `FND.PARTNER.MAINTAIN`, so the view-only assertion exercises an authorized display user.
`npm run typecheck`, `npm run test:browser-harness` (66/66), and `git diff --check` pass. The app and cluster were
stopped; temporary cluster and extracted package files were removed. The PAT in `.env.local` was not read or
revealed; its contents were left unchanged and the file was restored. No commit or push; §25.4's full-system publish
trigger remains authoritative.


### 26.96 B-079 — Owner-directed publication of the bank-data batch `PUSHED TO MAIN`

After B-078, on 2026-10-11 the owner explicitly directed a push of the pending bank-data worktree to `main`. This was
a one-time exception to §25.4's full-system publish gate; the standing no-partial-push instruction remains in force
for future batches. The 47-file source/test/migration/documentation batch was committed as
`9a39286 feat: add partner bank-data foundations and read-only view` (4,464 insertions, 39 deletions) and fast-forward
pushed from `39e3d35` to the documented repository's `main`; `origin/main` now tracks the branch.

The PAT in ignored `.env.local` was used only for authentication through a temporary askpass helper. Its value was
not staged, committed, placed in the remote URL/Git configuration, or displayed; the helper was removed. A staged-file
check confirmed none of the 47 paths contained the PAT or recognizable GitHub-token material. `.env.local` remains
ignored and untracked. No database or bank data was accessed for publication.


### 26.97 B-080 — Scoped D-074 detail mask reader `IMPLEMENTED — NOT UI-INTEGRATED`

Added server-side `getPartnerBankMaskedDetail` in `src/modules/foundation/partner-bank-detail-view.ts`. It requires
actual `FND.PARTNER.DISPLAY`, derives tenant from the authenticated session, and loads exactly one row with tenant,
selected partner, and UUIDv4 bank-row ID bound together. After matching all three values, it uses the database row's
client, partner number, and row ID as authenticated-decryption context. The query selects only approved metadata and
the two ciphertext columns; it selects no identifier plaintext column. Exactly one non-null, non-empty identifier
envelope is required. The service applies the existing D-074 detail projection internally and returns only the identifier kind
and `••••` plus the final four characters; it returns no plaintext, ciphertext, or row ID. Crypto errors remain generic.

The caller must provide the keyring explicitly; the deployment keyring loader is not yet connected. This service is
not wired to a route or UI and provides no save control, full-value reveal authority, reveal audit operation, or
plaintext-returning response. Six focused synthetic-envelope tests use a fake tenant transaction and verify
capability denial, tenant/partner/row-ID predicates, ciphertext-only selection, IBAN/local-account masking,
row mismatch and malformed-envelope rejection, and generic authenticated-decryption failure. The focused suite (6/6),
`npm run typecheck`, browser harness (66/66), and `git diff --check` pass. No database, real bank data, browser
acceptance, commit or push. §25.4's full-system publish trigger remains authoritative; a read-only detail UI is a
separate next slice.


### 26.98 B-081 — Read-only D-074 bank-detail UI integration `IMPLEMENTED — LIVE SYNTHETIC ACCEPTANCE IN §26.99`

The Business Partner Bank Details tab now adds a `View details` link per metadata row. The opaque UUIDv4 is carried
as the `bank` selector only; the page passes it with the authenticated session and matched partner to
`getPartnerBankMaskedDetail`, whose tenant + partner + row-ID query and row-derived crypto context remain the
security boundary. The server loads the versioned deployment keyring on demand only for an explicitly selected
bank detail. The new read-only detail panel receives only the safe DTO and shows the account kind, fixed `••••`
mask plus final four characters, and allowlisted bank metadata. It also provides a back-to-list link. Keyring
configuration and authenticated-decryption errors render a generic unavailable state; other server/database errors
are not converted into record-not-found responses.

No save/edit controls, full-value reveal, reveal authority/audit path, plaintext response, schema, or write behavior
was added. No keyring secret was provisioned, no real bank data or database row was used, and no live browser/database
acceptance was run. Four isolated no-database focused test files pass 14/14 (scoped reader 6, metadata panel 2,
detail panel 2, route integration/authorization 4); `npm run typecheck`, production build, browser harness (66/66),
IP lint (223 files), and `git diff --check` pass. No commit or push; §25.4's full-system publication trigger remains
authoritative.


### 26.99 B-082 — Synthetic D-074 masked-detail browser acceptance `PASSED — CLUSTER REMOVED`

Extended the guarded `business-partners` browser target with one synthetic encrypted `partner_bank` fixture because
there is no product write path. The fixture writer requires an explicit `CAIRN_SMOKE_FIXTURE_DATABASE_URL` and
refuses writes unless the database is `cairn_test`, the server address is `127.0.0.1`, the connection is elevated,
and the exact `T992` owned browser tenant is marked development with the UI-created partner present and no prior bank
row. A fresh random UUIDv4 and a synthetic-only identifier were encrypted using a per-run test keyring; the keyring
file was mode 0600 under `/tmp` and removed after the run. App reads continued through `cairn_app` with its
SELECT-only bank-table privilege.

On a fresh local PostgreSQL 17.11 cluster, the browser target applied all 32 migrations and shared seeds, onboarded
T992 through the UI, confirmed the empty bank state, inserted only the guarded synthetic ciphertext fixture, and
passed for both the maintainer and a display-only viewer. Both saw the fixed list mask and detail `••••4321`; neither
page contained the synthetic full value or ciphertext, and neither offered Save or reveal controls. No page errors.
Post-run verification showed zero T992 tenant, partner, and bank rows; the app and database were stopped, and the
cluster, extracted PostgreSQL package, and test keyring were removed. `npm run smoke:browser:business-partners`,
`npm run typecheck`, browser harness (66/66), IP lint (223 files), and `git diff --check` pass. No owner/production
or persistent development database, real bank data, schema change, commit or push. §25.4 remains the full-system
publish gate.


### 26.100 B-083 — Initial fail-closed bank-profile readiness boundary `IMPLEMENTED — EXTENDED BY B-085`

At B-083 completion, `src/platform/security/partner-bank-profile-readiness.ts` provided a pure deny-only readiness
query for the owner-approved D-061 authoring set (`IN`, `KW`, `GB`, `US`, `JP`). It normalized country input and
returned `PROFILE_NOT_READY` for every approved country until persisted configuration existed; missing and unsupported
countries also denied. Validator availability or a successful pure validation was not treated as profile readiness.
B-085 later extends this module with row/revision resolution and adds a read-only database lookup (§26.102); readiness
still does not grant bank-save authority.

B-083 added no profile persistence, readiness activation, country-profile data, validator-to-save integration, save
service, schema/migration, or bank values. Eight focused synthetic/no-DB tests passed at that batch, including all five
approved countries and the validator-success/readiness separation; typecheck, IP lint (225 files), and `git diff --check`
passed. No DB, browser acceptance, commit or push. §25.4's full-system publication trigger remains authoritative.


### 26.101 B-084 — Shared global bank-profile readiness registry `IMPLEMENTED — ACCEPTED IN §26.103`

Following the selected global governance model, added `partner_bank_country_profile` as a shared, country-keyed
registry with source-policy revision (`D-062`–`D-066`), readiness status (`NOT_READY`/`READY`), version and audit
columns. The country FK binds each row to global reference data; no tenant key or RLS is appropriate for this shared
policy table. Additive migration `0015_partner_bank_country_profile.sql` creates it, and `9017` revokes all runtime
privileges then grants only `SELECT` to `cairn_app` (the application cannot activate or rewrite profiles).

`seed-reference.ts` defines idempotent rows for the five D-061 countries, initially `NOT_READY`. A repeated seed for
the same policy revision preserves status/version; changing the policy revision resets that row to `NOT_READY`, bumps
version and records a system change. At B-084 completion, the static B-083 resolver was not yet wired to this table
and no runtime readiness reader existed; B-085 adds the read-only lookup in §26.102. There is still no activation action,
profile authoring UI, bank save path or reveal path.

Twelve focused no-database schema/readiness tests passed at B-084 completion; typecheck, IP lint (229 files), and
`git diff --check` passed. No database or migration was executed in B-084, and no Drizzle Kit metadata snapshot was
reconciled. B-086 later applied and accepted the migrations/seeds on a fresh disposable cluster (§26.103); no
owner/production or real bank data was used. No commit or push. §25.4 remains the full-system publish gate.


### 26.102 B-085 — Read-only global profile-readiness service `IMPLEMENTED — ACCEPTED IN §26.103`

Added `readPartnerBankProfileReadiness` in `src/modules/foundation/partner-bank-profile-readiness.ts`. Missing and
unsupported country inputs are rejected before DB access. For one of the five approved countries, the service verifies
the runtime application role, then selects only `policy_revision` and `readiness_status` from the global registry using
the normalized country key; it does not establish a tenant scope because the table is shared reference configuration.
Database/role errors propagate, so callers must fail closed. The pure resolver returns ready only for an explicit
`READY` registry row whose policy revision matches the current D-062–D-066 mapping. This is profile readiness only,
not permission to save bank data.

`createPartnerBankProfileReadinessReader` supports deterministic no-database service tests. The tests cover preflight
no-query behavior, ready state, stale revisions, not-ready/missing rows, and registry failure. Combined profile
resolver/schema/service suites passed 19/19; typecheck, IP lint (231 files), and `git diff --check` passed. No database
migration/seed was executed in B-085; B-086 later accepted the reader against the app role on a disposable cluster
(§26.103). No activation route, bank save/reveal path, UI or real bank data. No commit or push; §25.4 remains the
full-system publish gate.


### 26.103 B-086 — Disposable PostgreSQL acceptance for B-084/B-085 `PASSED — CLUSTER REMOVED`

Initialized a fresh PostgreSQL 17.11 cluster under `/tmp`, created a new `cairn_test` database, and applied all 34
lexical migrations, including `0015` and `9017`. `npm run seed:reference` created exactly five global profile rows for
IN/KW/GB/US/JP at `NOT_READY`, with policy revisions D-063, D-062, D-064, D-065 and D-066 respectively. The database
identity query reported the expected test database, local address/port and elevated migration role.

Verified the global registry has no RLS, `cairn_app` can read all five rows, and that role has no INSERT/UPDATE/DELETE
privilege; an attempted UPDATE was denied. The B-085 service, using `cairn_app`, reported KW not-ready initially,
then ready only after a synthetic `READY` status was set in this disposable DB for matching D-062. A same-revision
reference-seed rerun preserved that status/version. After staging a stale revision, the seed reset the row to D-062
and `NOT_READY`, incremented version and set `changed_by=SYSTEM`; the runtime service returned not-ready again. The
other four profiles remained blocked. This temporary status toggle was not a product activation.

Final counts were zero tenants, partners and bank rows, with the five global profile rows. The PostgreSQL server was
stopped, temporary cluster/package/test script removed, and final listener check showed port 55433 closed. No remote,
owner/production or persistent database, real bank data, bank-save/reveal path, commit or push. `npm run db:migrate`,
`npm run seed:reference`, the runtime-role check and B-085 service integration all passed; §25.4 remains the
full-system publish gate.


### 26.104 B-087 — Register profile-activation capability and fixed evidence code `IMPLEMENTED — NO ACTION`

Following the owner-approved activation contract, added the stable capability identifier
`CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` and fixed evidence code `PROFILE_VALIDATION_ACCEPTED` in
`src/platform/security/partner-bank-profile-activation.ts`. The global seed catalogue registers the capability as
Foundation `CONFIGURE`, non-posting. It adds no `role_capability` grants; existing Administrator `*` wildcard
semantics remain unchanged, and other roles receive no new authority by this batch.

This is catalogue-only groundwork. No activation action, profile mutation, dedicated global audit table, role grant,
UI or database seed was added/run. Two focused tests verify catalogue registration, no seeded grants, controlled
evidence and existing wildcard semantics; combined profile registry/readiness/capability suites pass 21/21.
Typecheck, IP lint (233 files), and `git diff --check` pass. No commit or push; §25.4 remains the full-system
publication gate.


### 26.105 B-088 — Pure partner-bank profile activation command contract `IMPLEMENTED — NO MUTATION`

Added `validatePartnerBankProfileActivationCommand` to the profile activation security module. It accepts only the
four approved fields: country, expected policy revision, expected row version, and fixed evidence code. It
canonicalizes an approved country, requires an exact match to its current D-062–D-066 policy revision, requires a
positive PostgreSQL `integer` version, and accepts only `PROFILE_VALIDATION_ACCEPTED`. Unknown fields/free-text are
rejected; the output fixes the transition target to `READY`, with no deactivate or caller-selected target status.

This is a pure contract only: it does not check session capability, read current row status, write the profile,
create audit evidence, or authorize activation. Eleven focused command tests plus readiness/schema/capability suites
pass (32/32); typecheck, IP lint (234 files), and `git diff --check` pass. No database, migration, seed, UI, bank data,
commit or push. §25.4 remains the full-system publication gate.


### 26.106 B-089 — Global profile-activation audit schema `IMPLEMENTED — DISPOSABLE DB-ACCEPTED §26.109`

Added `partner_bank_profile_activation_audit` as a global fixed-field table for the approved app activation contract.
It records an event UUIDv4, actor tenant key + user UUID snapshot, country, policy revision, `NOT_READY`→`READY`
transition, previous/new row versions, fixed `PROFILE_VALIDATION_ACCEPTED` evidence, and timestamp. There are no
free-text fields or actor foreign keys that could make tenant/user deletion erase global evidence. Constraints bind
the country to reference data, validate the 2–4-character actor key/revision shapes, require the one-way state transition, and require
`new_version = previous_version + 1`.

Migration `0016_partner_bank_profile_activation_audit.sql` creates the table; `9018` revokes all direct `PUBLIC` and
`cairn_app` privileges. It is global, so it has no tenant RLS. No activation writer, capability-checked action, or
status mutation is implemented yet; a later narrow atomic writer must append the audit event and change the registry
in one transaction. Three focused schema-contract tests plus the profile/readiness/activation suites pass (35/35);
typecheck, IP lint (238 files), and `git diff --check` pass. At B-089 completion no migration had been applied; B-092
later applied and accepted it on a disposable local PostgreSQL cluster (§26.109). No persistent/remote database,
bank data, commit or push. §25.4 remains the full-system publication gate.


### 26.107 B-090 — Private atomic activation database function `IMPLEMENTED — DISPOSABLE DB-ACCEPTED §26.109`

Added `cairn_activate_partner_bank_profile` in migration `9019_partner_bank_profile_activation_function.sql`.
The function validates UUIDv4 event identity, the 2–4-character actor tenant key, uppercase country, current-format
policy revision, positive expected integer version, and the fixed evidence code. It locks the global country row,
requires the expected policy revision and version, refuses an already-READY row, and updates only
`NOT_READY`→`READY`, incrementing the version and setting the registry actor/timestamp. It then inserts the dedicated
global audit event with the locked before-state and new version in the same PostgreSQL function call; an insert failure
aborts the statement and rolls back the readiness update. No target status or free text is accepted.

The SECURITY DEFINER routine uses only schema-qualified tables and `search_path = pg_catalog`. At B-090 completion,
`PUBLIC` and `cairn_app` EXECUTE were explicitly revoked; B-091 later adds the narrow app grant only alongside the
capability-checked, verified-session action, and B-092 accepts the whole path on a disposable cluster (§26.109).
Three static function-contract tests plus readiness/schema/activation suites pass (38/38); typecheck, IP lint (240
files), and `git diff --check` pass. No persistent/remote database, role-capability grants, bank data, commit or push.
§25.4 remains the full-system publication gate.


### 26.108 B-091 — Capability-checked activation service and server action `IMPLEMENTED — DISPOSABLE DB-ACCEPTED §26.109`

Added a server-side activation service and `activatePartnerBankProfileAction`. The service requires the exact
`CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` capability (preserving Administrator `*` matching), validates the strict
command, and derives both actor client and UUID from the verified session. The action reads only country, expected
policy revision and expected version; it supplies fixed `PROFILE_VALIDATION_ACCEPTED` evidence itself. No caller can
choose actor identity, target state, evidence text or another mutation. The service invokes only the atomic database
function inside `withTenant(session.client, ...)`, so the application-role guard and tenant scope are established
before the global operation; success is returned only after the transaction commits.

Migration `9020_partner_bank_profile_activation_function_runtime.sql` grants only EXECUTE on that exact function to
`cairn_app`, while preserving revoked direct UPDATE/INSERT/DELETE privileges on the registry/audit tables. It adds
no `role_capability` grants. Eight service tests and two server-action/grant contract tests, plus the profile/readiness/
activation suites, pass (48/48); typecheck, IP lint (245 files), and `git diff --check` pass. At B-091 completion no
migration/seed had been applied; B-092 later exercised the migrations and activation on a disposable local cluster
(§26.109). At B-091 completion the action was not UI-wired; B-093 later adds the dedicated page (§26.110). No
persistent/remote database, bank save/reveal, bank data, commit or push. Remote DB identity remains unverified; §25.4
remains the full-system publication gate.


### 26.109 B-092 — Disposable PostgreSQL acceptance for audited profile activation `PASSED — CLUSTER REMOVED`

Provisioned a fresh PostgreSQL 17.11 cluster under `/tmp`; it listened only on a private Unix socket with TCP disabled.
The custom lexical migration runner applied all 38 SQL migrations, including `0015`–`0016` and `9017`–`9020`.
`seed:reference` and `seed` completed. The five global profile rows were all `NOT_READY`; the activation capability
was present as non-posting Foundation `CONFIGURE` with no `role_capability` grant. No user, tenant, partner, or bank
record was seeded.

The actual server-side activation service called the atomic function through `cairn_app`/`withTenant` using a
synthetic capability-bearing session: KW changed from `NOT_READY` version 1 to `READY` version 2, and the audit row
matched the session-derived tenant/user, country, D-062 revision, before/after status, versions and fixed evidence.
Two simultaneous GB calls at version 1 produced exactly one activation/audit event; the other returned
`PROFILE_ALREADY_READY`. Direct function checks rejected stale policy revision, stale version, unavailable profile,
invalid evidence and malformed country without changing profile rows.

Privilege checks confirmed `cairn_app` is NOSUPERUSER/NOBYPASSRLS, retains profile SELECT but has no profile UPDATE/
INSERT, and has no direct SELECT/INSERT/UPDATE/DELETE/TRUNCATE on the audit table. It has EXECUTE only on the narrow
activation function; PUBLIC does not. Direct audit read/insert and profile update attempts failed with
`insufficient_privilege`. A deliberate duplicate audit-event fixture caused SQLSTATE `23505`; the function call
rolled back the preceding status update, leaving IN `NOT_READY` version 1. The collision fixture was deleted.
Final disposable counts: zero tenants, partners and bank records; two successful activation audit events (KW and GB).

The run exercised the service with a synthetic `SessionContext`; it did not perform a browser/cookie login flow.
All temporary cluster, downloaded package, test script and logs were removed. No remote, owner, persistent development
or production database was contacted; no persistent profile state, commit or push. B-093 subsequently added the
separate UI route (§26.110); browser acceptance remains pending. Bank-record saves/plaintext reveal remain out of
scope. §25.4 remains the full-system publication gate.


### 26.110 B-093 — Capability-gated global profile activation page `IMPLEMENTED — BROWSER ACCEPTANCE PENDING`

Added `/foundation/partners/bank-profiles` as a separate global configuration page rather than placing country policy
activation inside an individual partner's bank-record view. The page requires a verified session and the exact
`CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` capability; its link is shown from Partners only to that capability. A
read-only server query builds the five-country view model with current/registry policy revision, status and row version.
Missing, stale-revision or invalid rows fail closed and have no activation form. Only a current-revision `NOT_READY`
row gets an action with country, expected policy revision and expected version. The server action still supplies the
fixed evidence code and derives actor from session; the page offers no status override, free-text rationale, bank-row
save or plaintext reveal.

Added readiness/status translations, a view-model resolver, and UI/page-contract tests. The focused profile,
activation, panel and existing bank-display suites pass 59/59; typecheck, IP lint (251 files), and `git diff --check`
pass. No database or seed was run in this batch; B-092 remains the disposable PostgreSQL acceptance. The new route
has not had browser acceptance, and no persistent/remote profile state, bank data, commit or push was touched.
§25.4 remains the full-system publication gate.


### 26.111 B-094 — Cookie-backed browser acceptance for B-093 route and action `PASSED — DISPOSABLE INFRASTRUCTURE REMOVED`

Built the production standalone Next app and exercised it in headless Chromium against a fresh PostgreSQL 17.11 cluster.
The cluster lived under `/tmp`, accepted TCP only on loopback `127.0.0.1:55494` plus a private Unix socket, and hosted only
`cairn_b094`. The run verified its database identity before applying all 38 lexical SQL migrations, `seed:reference`,
and `seed`. The seeded activation capability was non-posting Foundation `CONFIGURE`; all five approved profiles began
`NOT_READY` at version 1. `role_capability` was empty before fixtures. The runtime `cairn_app` role was
`NOSUPERUSER NOBYPASSRLS`, had profile SELECT but no profile mutation, and had no direct activation-audit access.

Created a temporary `T094` tenant, three synthetic users and cookie-backed server sessions only in that database: a
`FND.PARTNER.DISPLAY` viewer, an exact-capability activator, and an `ADMINISTRATOR` role holding `*`. These four
temporary role-capability rows were acceptance fixtures, not seed changes or grants to any persistent role.

Browser checks passed: anonymous access redirected to sign-in; the display-only viewer saw no navigation link, was
denied on direct route access, and was refused by the actual server action when a form rendered for an authorized user
was submitted with the viewer cookie. The denied JP attempt left its profile at `NOT_READY` version 1 and emitted no
activation-audit event. The exact capability exposed all five current policy/revision/status/version rows and their activation controls.
The exact-capability user activated KW and the `ADMINISTRATOR` `*` user activated GB, each through the browser UI from
`NOT_READY` v1 to `READY` v2; each completed row lost its action, with no reverse control. Forged extra form values for
actor, evidence, target status and rationale did not affect the result. Exactly two activation-audit rows recorded the session-derived
`T094` actors, D-062/KW and D-064/GB, `NOT_READY`→`READY`, versions 1→2, and fixed evidence
`PROFILE_VALIDATION_ACCEPTED`. IN, JP and US remained `NOT_READY` v1. No browser page errors; zero partner or bank rows;
no Save/reveal path was exposed.

The production build and browser acceptance passed. The app and PostgreSQL processes were stopped; the disposable
cluster/database, downloaded PostgreSQL package, browser binaries/dependencies, fixture tokens/script and `.next` build
were removed, and ports 3000/55494 were closed. No remote, owner, persistent development or production database was
contacted; no bank identifiers, persistent profile change, commit or push. Bank-record saves and plaintext reveal remain
out of scope. §25.4 remains the full-system publication gate.


### 26.112 B-095 — Fail-closed browser acceptance for stale and missing profile rows `PASSED — DISPOSABLE INFRASTRUCTURE REMOVED`

Built the production standalone Next app and exercised it in headless Chromium against a freshly initialized PostgreSQL
17.11 cluster under `/tmp`. The cluster listened only on loopback `127.0.0.1:55495` plus a private Unix socket and hosted
only `cairn_b095`; before migrations, the run verified database name, loopback address, port, server version, primary
status and zero public tables. Applied all 38 lexical SQL migrations, `seed:reference` and `seed`. All five approved
profiles began at their current D-062–D-066 policy revisions, `NOT_READY`, version 1; `role_capability` was empty. The
runtime `cairn_app` role was `NOSUPERUSER NOBYPASSRLS`, had profile SELECT but no UPDATE, and had no activation-audit
SELECT access.

Created only disposable local tenant `T095` and a synthetic user/role with the exact
`CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` capability. This one role grant was an acceptance fixture, not a seed or
persistent grant. The fixture made KW stale (`D-061` vs current `D-062`) and removed the JP registry row; IN, GB and US
remained current `NOT_READY` version 1.

Chromium verified an anonymous route request redirected to sign-in, then signed in through the real cookie-backed UI.
The page rendered the closed five-country view: stale KW displayed `Policy revision mismatch` and missing JP displayed
`Registry row missing`; neither row had a form or button. Current IN/GB/US rows each retained exactly one activation
form with the current expected policy revision and version 1. Three activation controls appeared in total. No
activation was submitted; no Save or Reveal control, browser page error or console error was observed.

Post-run verification found four registry rows (KW stale; JP absent; IN/GB/US still `NOT_READY` version 1), zero
activation-audit rows, zero partners and zero bank rows. The app and database were stopped; the cluster, extracted
PostgreSQL package/client, browser binaries and system dependencies, temporary fixture scripts, `.next` build,
`node_modules`, and transient Playwright caches were removed. No remote, owner, persistent development or production DB,
real bank identifiers, activation, commit or push was involved. Bank-record saves and plaintext reveal remain out of
scope; §25.4 remains the full-system publication gate.


### 26.113 B-096 — Owner-directed publication of the complete B-080–B-095 partner-bank batch `PUBLISHED — FAST-FORWARD`

The owner explicitly directed a full commit and push of the complete pending partner-bank batch. All 45 staged paths
were committed as `3035c9b` (`feat: add partner bank profile readiness and activation`) with the repository identity
`deepakpt2`, then fast-forward pushed from `057e19c` to `deepakpt2/cairn-erp:main`. The remote branch and local `main`
were verified at the new commit; the worktree is clean. No force push was used.

For authentication, the PAT was read from ignored `.env.local` and supplied only through a temporary askpass helper.
The token was not staged, committed, written into the remote URL/config, or emitted in logs; `.env.local` remains
untracked/ignored and is not in the commit. This publication was expressly owner-directed and applies only to the
complete pending B-080–B-095 batch; §25.4 remains the gate for future publication. No database was contacted or
changed during publication; no real bank values were included.


### 26.114 B-097 — Owner-reported B-023/B-024 walkthrough outcome `COMPLETE — OWNER REPORTED PASS`

On 2026-10-12, the owner confirmed that both the B-023 Customer company and B-024 Customer Sales area
walkthroughs were complete and selected “All checks passed.” This is an owner-reported result. No
per-step notes, screenshots, or test-environment details were supplied, and the agent did not
independently re-run the walkthroughs or access the application, host, or database for verification.

The report closes only the B-023/B-024 owner-walkthrough outcomes; it is not an overall M1 sign-off,
production approval, or deployment instruction. The walkthrough procedures remain in §§26.33, 26.35
and 26.37. This documentation-only update made no application or database changes.


### 26.115 B-098 — Supplier company-code Payment Methods storage only `SCHEMA ADDED · MIGRATION NOT APPLIED`

Added nullable `payment_methods varchar(40)` to the existing tenant/company-code-scoped
`supplier_company_code` segment and registered it in the typed Drizzle schema. Additive migration
`0017_supplier_company_payment_methods.sql` adds only that column; the existing tenant RLS policy
continues to protect the table, so no separate policy migration was introduced. Added a static schema
contract covering the nullable column, composite company key, and non-destructive migration.

This is storage only. It adds no Supplier write-path behavior, country/direction lookup, validation
against active `OUTGOING`/`BOTH` Payment Methods, server action, UI control, seed row, or payment
execution. The Supplier field remains disabled. No database migration was applied, and no persistent,
remote, owner, or production database was accessed or changed.

**Verification:** the no-database schema-contract test is registered in the browser-harness configuration;
`npm run test:browser-harness` passed **68/68 across 6 files**, including both new contract checks.
`npm run typecheck`, `npm run lint:ip` (253 files), and `git diff --check` passed. The normal Vitest
configuration invokes database global setup and failed before collection with
`ECONNREFUSED 127.0.0.1:5432`; the connection was refused and no database was reached or modified.

**Follow-up:** B-099 canonicalizes and validates explicitly submitted codes against active
`OUTGOING`/`BOTH` definitions for the company-code country (§26.116). B-100 wires the session-derived
protected action and eligible choices (§26.117). The UI remains disabled pending its separate implementation
and browser acceptance. Any database acceptance must apply migration 0017 only to a verified disposable
database. Payment execution, bank-record saves and plaintext reveal remain outside this slice.


### 26.116 B-099 — Supplier Payment Methods save-service validation only `IMPLEMENTED · DATABASE ACCEPTANCE NOT RUN`

Extended `saveSupplierCompany` with optional `paymentMethods` input. Supplied code sets are trimmed,
uppercased, deduplicated, sorted, limited to ten unique one-or-two-character alphanumeric codes, and
validated in the same tenant transaction against the assigned company code's country. Each selected
method must exist for that tenant/country and be active with `OUTGOING` or `BOTH` direction. The lookup
locks matching definition rows `FOR SHARE`, so concurrent direction/active-state maintenance cannot
invalidate the check before the Supplier save commits. Unknown, inactive, wrong-country, and
`INCOMING`-only choices fail with a generic validation error.

An omitted field preserves existing data for legacy callers; an explicit blank clears the set. The value
participates in normal no-op/version handling and is recorded as security-relevant history. It does not
affect company-segment completeness or enable a payment transaction. The protected action and Supplier
UI are unchanged, so the field remains disabled and this service path is not yet user-reachable.

Added pure normalization/eligibility tests and DB-backed service cases for outgoing/BOTH acceptance,
canonicalization, country/direction/activity denials, explicit clear, omitted-field preservation, history,
no-op and completeness independence. The database cases were not run because no verified disposable
PostgreSQL test database was available; no migration or seed was applied and no database was accessed.

**Verification:** `npm run test:browser-harness` passed **74/74 across 7 files**; `npm run typecheck`,
`npm run lint:ip` (254 files), and `git diff --check` passed.

**Follow-up:** B-100 adds the session-derived protected action and active country/outgoing choices
(§26.117). The editable selector and browser acceptance remain separate work. No payment execution,
bank-record save, plaintext reveal, remote DB access, commit, or push occurred in this batch.


### 26.117 B-100 — Protected Supplier Payment Methods action and eligible choices only `WIRED · UI PENDING`

The existing `FIN.SUPPLIER.COMPANY.MAINTAIN` action now conditionally forwards `paymentMethods` only
when the form includes that field. Tenant and actor continue to come exclusively from the verified session;
legacy forms that omit the field preserve the stored assignment, while an explicit blank remains a clear.
No new capability or action route was introduced. The Supplier form still has no Payment Methods
control, so the field is not yet user-accessible.

`supplierCompanyChoices` now returns active Payment Methods for the selected company code's country,
scoped by tenant and filtered to `OUTGOING` or `BOTH`. It does not include inactive, incoming-only, or
other-country methods. The existing company, account, and payment-term choice queries also carry explicit
tenant predicates.

Added a database-free action/choice source-contract test and a DB-backed choice-service case. The DB case
was not run because no verified disposable PostgreSQL environment was available; migration 0017 was not
applied and no database was accessed.

**Verification:** `npm run test:browser-harness` passed **76/76 across 8 files**; `npm run typecheck`,
`npm run lint:ip` (255 files), and `git diff --check` passed.

**Next:** render the eligible methods in a capability-gated Supplier company-code selector, while preserving
authorised display-only values and existing omitted-field behavior. Keep the UI/browser acceptance and any
disposable migration test as separate bounded work; do not add payment execution. No bank-record save,
plaintext reveal, remote DB access, commit, or push occurred.


### 26.118 B-101 — capability-gated Supplier Payment Methods selector `IMPLEMENTED · LIVE BROWSER ACCEPTANCE SEPARATE`

Wired `supplierCompanyChoices.paymentMethods` and the stored company-code value into the existing
Supplier company panel. The Payment Methods checkbox editor appears only for users with the existing
`FIN.SUPPLIER.COMPANY.MAINTAIN` capability; authorized display-only users continue to see the saved code
set without controls. No new capability was added. Choices remain constrained by B-100 to active,
same-tenant, same-country `OUTGOING`/`BOTH` methods.

The editor supports at most ten selected codes, preserves saved selections that are still eligible, and
shows previously saved but now-ineligible codes as checked items that must be unchecked before a save can
succeed. A hidden comma-delimited field is submitted even when empty, so clearing every selection remains
an explicit clear; legacy callers omitting the field still preserve the stored value through B-100. The
Dunning procedure, Cash discount, and Tolerance group placeholders remain disabled pending their masters.
This is a supplier default only; it does not execute payments.

Added English help/status strings and a no-database UI source-contract test. **Verification:**
`npm run test:browser-harness` passed **78/78 across 9 files**; `npm run typecheck`, `npm run lint:ip`
(256 files), and `git diff --check` passed. DB-backed Supplier tests were not run. Migration 0017 remains
unapplied; no database was accessed. Live browser acceptance was not run and remains a separate batch.
No commit or push occurred.

**Next:** run live browser acceptance separately and, only against a verified disposable database, test
migration/service acceptance. Keep payment execution, bank-record saves and plaintext reveal outside scope.


### 26.119 B-102 — Supplier Payment Methods browser acceptance target preparation `TARGET UPDATED · LIVE RUN BLOCKED`

Updated the `supplier-company` Playwright target for the B-101 selector. It now expects only the three
remaining company defaults to be disabled; verifies the initially empty explicit field; creates synthetic
KW and US definitions through the Payment Methods UI; confirms same-country active `OUTGOING`/`BOTH`
filtering, the ten-selection cap and reload persistence; and exercises authorized display-only access,
retirement/stale-choice removal and explicit clear. Added a database-free browser-target source-contract
test. No new database fixtures were created during this preparation.

**Verification:** `npm run test:browser-harness` passed **81/81 across 10 files**; `npm run typecheck`,
`npm run lint:ip` (257 files), and `git diff --check` passed. The live target was not run: no database URL
or local PostgreSQL service/tools were available, and migration 0017 remains unapplied. A fresh disposable,
migrated database is required. No database was accessed or modified. No commit or push.

**Next:** perform migration/service acceptance on a verified disposable database in a separate batch; then
run this live browser target against a fresh disposable, migrated test database. Do not use an owner,
production or unidentified remote database.


### 26.120 B-103 — Supplier Payment Methods migration and service acceptance `PASSED · DISPOSABLE LOCAL ONLY`

With owner authorization, installed PostgreSQL 17.11 and created a fresh disposable `cairn_test` cluster
bound only to `127.0.0.1`. Before applying any migration or seed, verified over TCP that the target was
`cairn_test` on loopback, PostgreSQL 17.11, as the disposable-cluster `postgres` migration superuser.
The app connection was separately verified as `cairn_app` with `NOSUPERUSER` and `NOBYPASSRLS`.

Applied all **39** lexical SQL migrations, including `0017_supplier_company_payment_methods.sql`, then
ran the global-definition and shared-reference seeds. The DB-backed `tests/supplier-companies.test.ts`
suite passed **25/25**, covering persisted outgoing/BOTH choices, tenant/country/direction validation,
explicit clear, omitted-field preservation, history/version handling and completeness independence.

After testing, verified 39 migration records and the 0017 record, with **zero tenants, partners, Supplier
company-code rows, Payment Method rows or partner-bank rows**. Stopped and removed the disposable cluster,
its temporary data and the PostgreSQL packages installed for this batch. No owner/production/remote
connection was used. The live browser target was not run; it remains a separate batch. No commit or push.


### 26.121 B-104 — Supplier Payment Methods live-browser acceptance `PASSED · DISPOSABLE LOCAL ONLY`

Used the freshly provisioned `cairn_test` PostgreSQL 17.11 cluster bound only to `127.0.0.1:55432`.
Its local identity was verified before the B-104 setup applied the existing 39 migrations and two shared
seeds. This was browser-only acceptance: B-104 did not rerun migrations/seeds or the Supplier service suite
from B-103. No owner, production or remote database was accessed.

Built the optimized Next standalone app and ran only `npm run smoke:browser:supplier-company` in headless
Playwright Chromium v1248. The single target passed with no browser runtime errors. The run covered the
empty/no-choice state and disabled pending defaults; same-country active `OUTGOING`/`BOTH` filtering;
exclusion of incoming-only and other-country methods; ten selectable methods with the eleventh disabled;
save/reload persistence; non-finance denial and authorized display-only access without controls; retiring
saved `B1`, removing the stale choice, and explicitly clearing the remaining selection. Synthetic payment
method definitions were created through the audited Payment Methods service as isolated fixtures so the
browser target remained focused on Supplier company selection; the `B1` retirement and Supplier edits were
performed through the UI. The fixture setup is not a substitute for the separate Payment Methods UI target.

The smoke runner removed its `T991` fixture. Verified zero tenants, partners, Supplier company-code rows,
Payment Method rows and partner-bank rows after the run. Stopped the app and removed the disposable cluster,
temporary database data/logs, PostgreSQL packages installed for this batch and the Playwright Chromium
binary cache. Apt autoremove also removed 29 newly installed Chromium runtime packages that were no longer
needed; shared system dependencies were retained. `npm run build` passed; final browser-harness, typecheck,
IP lint and diff-check results are recorded in the v1.19 change log. No commit or push.


### 26.122 B-105 — Company Code define capability registration only `CAPABILITY READY · ACTION/UI PENDING`

Started the Enterprise Structure roadmap at SCR-012 by registering `CFG.ORG.COMPANYCODE.DEFINE` in the
global capability catalogue as module `FND`, action `CONFIGURE`, and non-posting. A database-free contract
test checks the seed entry, confirms this batch adds no tenant-role grants, and preserves exact-capability
and Administrator `*` behavior.

This is only capability registration: it is not yet wired to the Company Code route, a server action, or a
form, and it grants no default role. No schema or migration changed; no seed was executed and no database
was accessed. Typecheck, browser harness, IP lint and diff-check results are recorded in the v1.20 change
log. No remote database, commit or push.

**Next:** add the protected Company Code define path in a separate bounded batch, keeping the define/assign
order in §6.2 and the current Company Code assignment-field constraints explicit.


### 26.123 B-106 — Owner-directed publication of B-098–B-105 `PUBLISHED`

On explicit user instruction, which superseded the earlier publication hold for this batch only, staged
and committed the pending Supplier Payment Methods and Company Code capability work (19
source/schema/test/document paths) as
`8eac55f4cf51d3260be259859bbe38464264c124`, then fast-forward pushed `main` from
`f3119c6d2966beb5da44f17d028bb104dba00fb5` to `deepakpt2/cairn-erp:main`. `.env.local` was not staged;
the authorized token was supplied only through a temporary askpass helper and was not logged or placed in
the remote URL. No database was accessed, no migration/seed was applied and no runtime data changed.

**Next:** continue with the next bounded Company Code define-path batch in §26.122. No owner/production DB
is authorized by this publication record.


### 26.124 B-107 — Company Code define/assign schema and read gates `LOCAL ACCEPTANCE PASSED · WRITE PATH PENDING`

The owner selected to align the schema with the define/assign sequence in §6.2. Added migration
`0018_company_code_assignments_nullable.sql` to allow the chart-of-accounts, fiscal-year-variant, and
posting-period-variant fields to remain unset when a Company Code is defined. Existing assignments are
not rewritten. Migration `9021_company_code_refs_allow_unassigned.sql` replaces the legacy reference
trigger so each non-null assignment still has to reference a tenant-local definition; it permits a
valid stepwise assignment without requiring the later steps to be complete.

Updated the Foundation schema and Company Code detail/list views to represent unassigned values. Supplier
and Customer company-code choices/maintenance require chart-of-accounts assignment. Posting-period status
and journal posting refuse incomplete Company Codes; number-range readiness reports incomplete
assignments, the journal form omits unassigned codes, and a direct posting-period URL shows an assignment
message rather than attempting to load missing variants. No definition action, assignment action or
write-form UI was added in this batch.

**Acceptance:** on a fresh, loopback-only PostgreSQL 17.11 database, all 41 migrations applied, followed
by the local reference and global-catalog seeds. Six related DB test files passed 115/115, covering the
new define/assign sequence, valid partial assignment, retained reference validation, detail/choice reads,
posting-period and journal-posting denials, plus existing posting, range, Supplier and Customer suites.
Final verification found all three columns nullable, both B-107 migrations applied, zero test tenants and
zero Company Code rows. The temporary cluster and PostgreSQL packages were removed. Browser harness
87/87, typecheck, IP lint (264 files), production build and diff check pass. No remote DB was accessed;
B-103 migration/service acceptance and B-104 live-browser acceptance were not rerun or conflated with this
schema batch. No commit or push.

**Next:** add the protected create-only Company Code define service/action, deriving tenant and actor from
the verified session and leaving the three assignments unset. Build each later assignment as its own
protected, dependency-ordered step under §6.2.


### 26.125 B-108 — protected create-only Company Code definition `SERVICE/ACTION COMPLETE · FORM PENDING`

Added `company-code-definition.ts` as a strict, create-only service. Its input contains only the definition
fields: Company Code, name, country, currency, and optional city/tax-registration number. It rejects unknown
fields (including CoA/FYV/PPV), validates the country and an active currency against the global reference
catalogues, serializes same-tenant/code attempts, and refuses an existing key without changing it. A new
row is inserted with all three assignment columns explicitly `NULL`; the same transaction writes the
`CREATE` change document and marks `CFG.ORG.COMPANYCODE.DEFINE` complete.

Added the server action in `/config/company-codes/actions.ts`. It requires a verified session and the exact
`CFG.ORG.COMPANYCODE.DEFINE` capability before invoking the service; tenant and actor come only from the
session. The action ignores forged tenant/actor/assignment form fields, reports authorization/validation
errors safely, and revalidates the configuration routes. No form or user-runnable UI is wired yet, and no
assignment action is included.

**Acceptance:** fresh loopback-only PostgreSQL 17.11; all 41 migrations plus reference and global-catalog
seeds applied. Seven focused DB suites passed 118/118, including create with null assignments, audit and
activity completion, duplicate no-overwrite, reference rejection, B-107 sequence behavior, and existing
posting/range/Supplier/Customer tests. Final counts: 0 test tenants and 0 Company Code rows. Temporary
cluster/packages removed. Browser harness 91/91, typecheck, IP lint (268 files), production build, and diff
check pass. No remote DB or live-browser acceptance; B-103 and B-104 remain separate. No commit or push.

**Next:** add the capability-gated Company Code definition form and connect it to the action, keeping the
list/detail view readable but the write path protected. Company Code assignment activities remain separate
and dependency-ordered under §6.2.


### 26.126 B-109 — capability-gated Company Code definition form `UI COMPLETE · LIVE BROWSER PENDING`

Added a definition form to `/config/company-codes`, rendered only when the verified session has
`CFG.ORG.COMPANYCODE.DEFINE`. Country choices and active currency choices are loaded from the global
reference tables only for an authorized maintainer. The form accepts Company Code, name, country,
currency, optional city and optional tax-registration number, and submits only these fields to B-108's
protected action. It exposes no client/actor fields and no CoA/FYV/PPV fields. The existing Company Code
list remains readable without the define capability; those users receive a read-only authority notice.
The form reports action status, resets after success, and disables submission if either reference list is
empty.

**Acceptance:** browser-harness contract suite 93/93, typecheck, IP lint (270 files), production build,
and diff check pass. No DB access, migration, seed, or live-browser test in this UI-only batch; B-103/B-104
and the separate Company Code browser target are not conflated. The build used an explicit loopback-only
unavailable URL to prevent accidental remote access. No commit or push.

**Next:** B-110 — cookie-backed live-browser acceptance of the Company Code define form/action on a
verified disposable local PostgreSQL database; test denied/allowed authority, field forgery resistance,
create-only behavior, null assignments and visible refresh; remove all fixtures and temporary
infrastructure. Do not use an owner/production database.


### 26.127 B-110 — cookie-backed Company Code definition browser acceptance `PASSED · DISPOSABLE LOCAL ONLY`

Added the independently selectable `company-code-definition` Playwright target (reserved fixture T986) and
ran only that target. A fresh PostgreSQL 17.11 cluster under `/tmp` listened on `127.0.0.1:55496`; before any
migration or seed, verified database `cairn_b110`, current migration role `cairn`, loopback address/port,
primary status, PostgreSQL 17.11, and zero public-schema objects. The target runner now rejects non-loopback,
wrong-name/port, or wrong-role URLs before opening its preflight connections, then checks the live database
identity and that the runtime `cairn_app` role is not elevated. Applied the 41 lexical migrations and the two
shared global/reference seeds only as prerequisites for this browser environment. This does **not** claim new
migration or service acceptance; no database service suite ran for B-110.

The browser created T986 through the onboarding UI. Administrator access used the real sign-in and cookie flow.
The target verified country/currency choices (KW/KWD), absence of tenant/actor/assignment controls, and actual
create submission with forged hidden `client=0100`, `changedBy=spoofed.actor`, and CoA/FYV/PPV values. The
result stayed in T986, recorded `browser.admin` as creator/auditor, and retained all three assignments as NULL.
The success feedback remained visible while all form controls reset; the refreshed list showed the new row as
unassigned and did not offer posting periods. A duplicate submit was refused without overwriting the row or
adding history. A cookie-backed Auditor retained the readable list and received the read-only notice, without
a definition form or reference-choice controls. The target completed its sign-out/protected-route redirect and
reported no browser page errors.

The runner cleanup and final direct count check found zero T986 tenant, Company Code, user, change-history,
partner or bank rows. The server, cluster/data, extracted PostgreSQL package, downloaded Chromium/cache and
system packages, temporary env/password files, `.next`, `node_modules`, and the target screenshot were removed.
No owner/production/remote database was accessed, and no commit or push occurred.

**Verification:** typecheck passed; browser harness **94/94**; IP lint scanned 270 files; final diff check is
recorded in the v1.25 changelog. Next's internal type-check worker was SIGKILLed during both standard and
`--no-lint` build attempts, although the standalone `npm run typecheck` passed. For the production standalone
browser run, a temporary `typescript.ignoreBuildErrors` override was used with `--no-lint`, then immediately
restored; the production bundle and cookie-backed target passed. This is not recorded as a normal build pass.
The earlier cold dev-server attempt timed out during first-route compilation and created no tenant; the final
production standalone run is the accepted browser result.


### 26.128 B-111 — separate CoA-assignment capability registration for SCR-013 only `CAPABILITY READY · ASSIGNMENT ACTION/UI PENDING`

Added `CFG.ORG.COMPANYCODE.ASSIGN_COA` to the global capability catalogue in `scripts/seed.ts` as a
Foundation (`FND`) `CONFIGURE`, non-posting capability. This is deliberately separate from
`CFG.ORG.COMPANYCODE.DEFINE`: defining a Company Code does not assign its chart of accounts. SCR-013's
assignment activity was already registered with prerequisites for Company Code definition and CoA definition;
this batch does not change that activity or add a role-specific grant. Existing exact-capability, `CFG.*`
Configurator-pattern, and `*` Administrator-wildcard authorization behavior is preserved.

Expanded `tests/company-code-capability-contract.test.ts` to assert the new catalogue entry, the existing
SCR-013 activity and prerequisites, absence of explicit role-capability grants in the catalogue block, and
exact/wildcard/fail-closed checks. The seed source was not executed. No schema or migration, assignment
service/action, UI, CoA/FYV/PPV mutation, or database operation is included.

**Verification:** focused contract suite **3/3**; browser harness **15 files / 95 tests passed**; typecheck
and IP lint (270 files) passed; `git diff --check` passed. A first default Vitest invocation used the wrong
configuration: its global setup attempted `127.0.0.1:5432` and was refused before test collection. No database
connection or state access resulted; rerunning the focused test with the DB-free browser-harness config passed.
No production build, remote DB, commit or push.

**Next:** implement the protected CoA-assignment service/action in a separate bounded batch, gated by the new
capability and SCR-013 prerequisites; keep its UI and browser acceptance separate. B-111 performs no assignment.


### 26.129 B-112 — protected initial CoA-assignment service/action only `IMPLEMENTED · DB ACCEPTANCE PENDING`

Added `src/modules/foundation/company-code-coa-assignment.ts` for SCR-013. The strict service input accepts
only Company Code and chart keys plus trusted service-supplied tenant/actor context. In a tenant-scoped
transaction it serializes concurrent attempts, locks the Company Code row, verifies that both
`CFG.ORG.COMPANYCODE.DEFINE` and `CFG.FIN.COA.DEFINE` are completed, and requires an active chart of accounts
from the same tenant. It changes only the Company Code's CoA field; FYV and PPV remain untouched. The initial
assignment is audited as a security-relevant `CHANGE`, and SCR-013 completion is recorded in the same
transaction. Repeating the same assignment is idempotent; replacing a different existing CoA is refused until
reassignment semantics are separately approved.

Added `assignCompanyCodeCoaAction` alongside the existing definition action. It requires a verified session
and exact `CFG.ORG.COMPANYCODE.ASSIGN_COA` capability before service invocation. Tenant and actor come only from
the session; the form payload is limited to the Company Code and CoA keys. Successful/idempotent results use
English i18n messages and revalidate Company Codes, the workbench, posting periods and the new-journal route.
No assignment form or UI is wired in this batch.

Added a database-free contract suite and registered it in the browser-harness configuration. The existing
Company Code definition contract now scopes its assertions to the define action, preserving B-108's rule that
its request and service do not accept assignment fields.

**Verification:** new contract suite **4/4**; browser harness **16 files / 99 tests passed**; typecheck and IP
lint (272 files) passed; `git diff --check` passed. The database-backed service was not executed or accepted;
no database connection, migration or seed command was run, and no assignment was performed. No schema/migration,
UI, production build, remote DB, commit or push.

**Next:** B-113 — add/run focused service acceptance on a verified disposable local PostgreSQL database,
including successful assignment, tenant/reference/prerequisite denials, same-value retry, overwrite refusal,
audit/activity atomicity and cleanup. Verify actual database identity before any migration or seed; never use
an owner/production database.


### 26.130 B-113 — disposable local PostgreSQL acceptance for protected CoA assignment `PASSED · CLUSTER REMOVED`

A fresh PostgreSQL 17.11 cluster was bound only to `127.0.0.1:55497`; the disposable database was
`cairn_b113`. Before any migration or seed, verified database name, current migration role `cairn`, loopback
address/port, primary status, server version 17.11 (`170011`), zero public-schema objects, and the expected
elevated migration-role flags. No existing owner/local cluster or remote database was used. After that gate,
applied the 41 lexical migrations and ran the shared reference and global-catalog seeds solely to provision
the service-test environment. This is not new migration/seed acceptance. Runtime tests used `cairn_app`; its
`rolsuper` and `rolbypassrls` flags were both verified false.

The focused database suite passed **4/4**. It created an unassigned Company Code and assigned the active same-tenant
`CAIRN` chart. It verified that only CoA changed (FYV/PPV stayed NULL), the security-relevant `CHANGE` history
record and SCR-013 completion were recorded with the test actor, and retrying the same assignment added no
second history event. A different existing chart was refused without mutation. Missing Company Code, missing or
inactive chart, a chart defined only in another tenant, and each incomplete prerequisite were denied; failed
checks left the Company Code unassigned and added no assignment history. The first run exposed that the shared
`createTenant` test helper does not create workbench-status rows; the disposable fixture was corrected to add
the required prerequisite/status rows, and the final run passed.

Final direct counts found **zero** test tenants, Company Code rows or change-history rows. The PostgreSQL server
was stopped cleanly; cluster data, temporary cluster config and PostgreSQL OS account were removed, and all 11
temporary PostgreSQL-related packages were purged. `node_modules` was removed after verification. Typecheck,
browser harness **16 files / 99 tests**, IP lint (273 files), and final diff check pass. No owner/production/remote
database, commit or push. No schema change, new migration, UI or live-browser acceptance; no persistent assignment.

**Next:** implement the SCR-013 capability-gated assignment UI with active tenant-local CoA choices; keep live
browser acceptance as a separate batch. No manual screen walkthrough is possible until that UI is added.


### 26.131 B-114 — capability-gated SCR-013 CoA-assignment UI only `BUILT · LIVE-BROWSER ACCEPTANCE PENDING`

Added `CompanyCodeCoaAssignmentForm` to `/config/company-codes` as a separate SCR-013 step. Definition and
assignment authorities are evaluated independently: only a verified session with `CFG.ORG.COMPANYCODE.ASSIGN_COA`
receives active CoA choices, and only when at least one Company Code has no CoA assigned. Choices are queried
inside `withTenant` with an explicit tenant filter and `isActive = true`. Users without the assignment capability
retain the existing readable Company Code list and receive an authority notice; the define form remains governed
only by `CFG.ORG.COMPANYCODE.DEFINE`. A capability holder with no active CoA receives a clear empty-choice notice
instead of an unusable form.

Each unassigned Company Code row gets a selector only when active choices exist. Its payload contains only the
Company Code key and selected CoA; tenant and actor remain session-derived in B-112's action, and FYV/PPV are not
exposed. Already-assigned rows show their CoA without a replacement control, matching B-112's initial-assignment-only
service. Added English `en` messages for selection, no-choice, success/readout and the initial-only boundary.

Registered a database-free UI contract suite; the existing definition UI test was adjusted to assert the separate
`canDefine` gate after both capabilities were added to the same page. The SCR-013 inventory status now records
that the UI is built while live-browser acceptance remains pending.

**Verification:** new UI contract **3/3**; focused definition/assignment UI contracts **5/5**; browser harness
**17 files / 102 tests passed**; typecheck and IP lint (275 files) passed; `git diff --check` passed. No database,
migration, seed, assignment action, CoA mutation, live-browser run or production build. No remote DB, commit or push.

**Next:** B-115 — cookie-backed live-browser acceptance of SCR-013 on a verified disposable local PostgreSQL database.
Verify database identity before migration/seed setup; test capability separation, active-choice scope, successful
initial assignment, read-only access and UI refresh; clean every fixture and remove temporary infrastructure. Keep
this browser-only acceptance distinct from B-113 service acceptance; never use an owner/production database.


### 26.132 B-115 — cookie-backed SCR-013 CoA-assignment browser acceptance `PASSED · DISPOSABLE LOCAL ONLY`

Added and ran only the independently selectable `company-code-coa-assignment` target (reserved fixture T985).
Its identity guard is separate from B-110: runtime and migration URLs must use loopback PostgreSQL database
`cairn_b115` on port 55498 and the distinct `cairn_app` / `cairn` roles. Before setup, a direct preflight verified
127.0.0.1, port 55498, primary PostgreSQL 17.11 (`170011`), elevated migration role and zero public-schema
base tables. The target runner then rechecked live runtime/migration identity; `cairn_app` was NOSUPERUSER and
NOBYPASSRLS. Applied the 41 existing migrations and reference/global seeds only to prepare the browser database.
This does **not** claim migration/seed acceptance and does not rerun B-113 service acceptance.

The browser created T985 through onboarding and Company Code 2000 through the session-bound definition UI; all
three assignments began NULL. Test-only active `B115ACT` and inactive `B115OFF` chart rows were placed in T985
as existing choices; CoA definition/seed behavior was not under test. A definition-only user saw the definition
form but no assignment selector or chart values. A cookie-backed Auditor read the unassigned Company Code with
neither maintenance form nor choices. An assignment-only user saw the CoA selector, but no definition form; its
options exactly matched the tenant-local active chart rows and excluded the inactive row. That session assigned
`B115ACT` once. Forged `client=0100`, actor, FYV and PPV fields were ignored: the Company Code remained in T985,
`changedBy` was `company.assigner`, FYV/PPV remained NULL, and one security-relevant SCR-013 change item plus
activity completion were recorded. The assignment-only control disappeared immediately and after a fresh page
load; an Auditor then saw the saved chart read-only and no replacement control. Sign-out redirected from the
protected route and the browser reported no page errors.

The browser target's cleanup and a final direct query confirmed zero T985 tenant, Company Code, chart, user, role,
activity-status, change-document and change-item rows (and zero remaining tenants in the disposable database).
PostgreSQL and the app were stopped; cluster/data, temporary URL/password file, build and dependency output,
Playwright browser cache, acceptance screenshot, temporary configuration and 42 temporarily installed PostgreSQL/
Chromium dependency packages were removed. No remote, owner or production database was contacted.

**Verification:** browser target `company-code-coa-assignment` passed; browser harness **17 files / 104 tests**,
typecheck and IP lint (276 files) passed; `git diff --check` passed. The standalone production bundle compiled
for this cookie-backed run with `typescript.ignoreBuildErrors` temporarily enabled after the separate typecheck
passed; this is not recorded as a normal Next type-validation build. No B-113 service suite, migration/seed
acceptance, remote DB, commit or push.


### 26.133 B-116 — SCR-012 Company Code definition inventory reconciliation `DOCUMENTATION ONLY · COMPLETE`

The SCR-012 screen inventory still read `DRAFT`, although B-109 had completed the capability-gated definition
form and its automated UI contract, and B-110 had passed the cookie-backed live-browser acceptance. Updated the
inventory to record the built state and both acceptance results, while explicitly retaining **owner
walkthrough/sign-off pending** under §24.1. This reconciles existing evidence only: no source, schema, database,
migration, seed, or browser behavior changed, and no acceptance was rerun.

**Verification:** `git diff --check` passed. No remote DB, commit or push.


### 26.134 B-117 — SCR-014 Plant definition specification draft `BOUNDARY LATER DECIDED`

Started the next Enterprise Structure screen after Company Code definition/CoA-assignment acceptance. Added a
Tier B draft page spec for `CFG.ORG.PLANT.DEFINE` (OX10), using the existing tenant-scoped Plant schema as a
candidate field inventory only. It records the current read-only page and the candidate Plant code/name/country,
location, site-role, language and active fields; mandatory rules, defaults, and whether a default storage location
belongs on this screen are explicitly not approved.

At the end of B-117, the activity registry's separate `CFG.ORG.PLANT.DEFINE` and
`CFG.ORG.PLANT.ASSIGN_COMPANY` steps conflicted with the `NOT NULL` schema, so the boundary was left for the owner;
no code, schema, migration, seed, database or browser behavior changed in that batch. The owner subsequently
selected separate assignment: Plant definition may leave Company Code unset, and the later assignment activity
links it. D-086 records that decision; B-118 implements the nullable schema and null-safe consumers in §26.135.
The existing standard-onboarding Plant seed remains assigned. Candidate fields/defaults were pending at the end of
B-117; the owner later selected the field contract in D-087, and B-119 adds its schema fields in §26.136. The full
Plant maintenance/action/UI contract remains pending.

**Verification at B-117:** `git diff --check` passed. No remote DB, commit or push for B-117.


### 26.135 B-118 — Plant Company Code nullable schema and null-safe use `IMPLEMENTATION COMPLETE · DISPOSABLE DB ACCEPTANCE PASSED`

Implemented the owner-selected separate boundary from D-086. `plant.company_code` is nullable so Plant definition
can precede assignment; a composite `(client, company_code)` foreign key preserves tenant-local reference
integrity whenever the value is non-null. Additive migration `0019_plant_company_code_nullable.sql` drops only
`NOT NULL` and adds that validated reference constraint without rewriting existing values.

Null-safe behavior is coordinated across dependent paths: material choices exclude unassigned Plants; material-view
save and `requireUsableMaterial` refuse unassigned/inactive Plant or Company Code use; customer delivery validation
refuses an unassigned Plant and its same-company choices omit it; supplier purchasing refuses plant-scoped use
before assignment; the Plant list visibly labels the unset Company Code. The standard onboarding package remains
unchanged and continues to create its standard Plant assigned. No Plant-definition writer, Company Code assignment
writer, or live-browser acceptance is part of this batch. At the end of B-118 the other fields/defaults were still
pending; D-087/B-119 later approves and adds the schema fields (§26.136). Assignment replacement/reassignment
semantics remain unspecified.

**Disposable local acceptance:** created and identity-verified a fresh PostgreSQL 17.11 cluster/database
`cairn_b118` on loopback port 55518 before applying schema. Applied all 42 migrations (including 0019) and only
the reference/global seeds needed for the test fixture. Confirmed `plant.company_code` reports nullable, the
composite FK is validated, and `cairn_app` is NOSUPERUSER/NOBYPASSRLS. The Plant-specific migration/service tests
passed along with the full database suite (**562/562 tests across 68 files**); browser harness **106/106**,
typecheck, IP lint (**279 files**), production build and `git diff --check` passed. Final test tenant, Company Code,
Plant and change-document counts were zero. The disposable cluster/data, temporary PostgreSQL packages and
`node_modules`/build output were removed. No remote or owner/production database was accessed; no commit or push.


### 26.136 B-119 — Plant logistics/address schema extension `IMPLEMENTATION COMPLETE · DISPOSABLE DB ACCEPTANCE PASSED`

Implemented the SCR-014 field contract selected in D-087 as a schema-only extension. Migration
`0020_plant_logistics_fields.sql` adds nullable `region`, `postal_code`, `street`, `house_number` and
`factory_calendar` columns. Existing `city`, required two-character `country`, and `language` (two-character,
default `EN`) remain; the legacy free-text `address` is retained without rewrite or backfill. Production-site,
storage-site and active defaults remain true; `default_storage_location` stays nullable and unset. The optional
10-character Factory Calendar code has no master/reference check and no operational consumer. No Plant write
service, definition form, Company Code assignment flow, or Factory Calendar master was added.

The schema-contract test checks additive nullable columns, preservation of the legacy address, and absence of
Factory Calendar validation. The database round-trip test stores structured address values and an intentionally
unregistered `NO-MASTER` key, reads them back unchanged, and verifies both site-role defaults and active default
remain true while default storage location is NULL.

**Disposable local acceptance:** created a fresh PostgreSQL 17.11 cluster/database `cairn_b119` bound to loopback
port 55519. Before any migration or seed, preflight confirmed database, role, address, port, version `170011`,
UTF8 encoding, cluster data directory/system identifier, empty public schema, and restricted runtime role. Applied
all 43 migrations, then global and reference seeds only for acceptance. Full database suite passed **565/565 tests
across 69 files**; applied-migration count was 43 and final tenant, Company Code, Plant and change-document counts
were zero. `cairn_app` remained NOSUPERUSER/NOBYPASSRLS. Browser harness **108/108**, typecheck, IP lint
(**281 files**), production build and `git diff --check` passed. The build ran from a temporary source copy without
`.env.local`.

After acceptance, the disposable cluster/data and temporary credentials/configuration were removed, the 11
PostgreSQL packages installed for the run were purged, and project `node_modules` was removed. No remote or
owner/production database was accessed; no live-browser acceptance, commit or push. Future Factory Calendar
master/reference semantics and any Plant writer/UI remain separate work.


### 26.137 B-120 — SCR-014 SAP-grounded field status and lifecycle specification `SPEC COMPLETE · SERVICE/ACTION NEXT`

Resolved the remaining Plant-definition form rules before implementation. The owner selected the conservative
required-field mapping and both create/change support; owner also confirmed that the Cairn production/storage flags
may both be false. Required: Plant code, name and country. Optional: street, house number, postal code, city,
region and Factory Calendar. Language retains the existing `EN` default. The production/storage/active defaults
remain true, but neither production nor storage role is a mandatory minimum. Company Code stays on the distinct
assignment activity; default storage location remains unset. No delete behavior was selected.

**SAP evidence and scope:** SAP Learning's [Defining and Assigning Plants](https://learning.sap.com/courses/cross-functional-customizing-in-sap-s-4hana-materials-management/defining-and-assigning-plants)
lesson describes Plant as a logistics unit with address, language, country and region, and shows the Plant address
maintained separately from the general key/description. It lists general Plant data including key, description,
address, country, language and Factory Calendar, but its text does not prescribe a universal required marker for
each address subfield. A historical [SAP Community discussion](https://community.sap.com/t5/enterprise-resource-planning-q-a/plant-address-fields-mandatory/qaq-p/7150764)
suggests Name 1 is mandatory while making Street/Name 2 mandatory may require an enhancement; it is secondary,
release-specific evidence, not a normative S/4HANA field-status specification. SAP does not define Cairn's exact
`isProductionSite`/`isStorageSite` boolean pair. D-088 therefore records owner-selected Cairn rules rather than
claiming those rules are imposed by SAP. Factory Calendar remains the earlier D-087 exception: optional, unvalidated
and with no operational use until a separate master is designed and implemented.

Plant definition is to support create and change, under the existing session-derived authorization and change-audit
invariants. The exact capability/action contract, update allowlist, reference handling and concurrency behavior are
for B-121. This batch changed specification only: no source, schema, migration, seed, database, or UI behavior.
`git diff --check` passed; no remote database, commit or push.


### 26.138 B-122 — Cairn-specific Plant role flags clarified `OWNER DECISION RECORDED · DOC/COMMENT ONLY`

The owner asked why `isProductionSite` and `isStorageSite` exist although they are not SAP OX10 fields. They
predate B-119 in Cairn's initial schema and currently do only two things: default to true when a standard Plant is
created, and produce the Production/Storage badges on the read-only Plant page. No material, stock, purchasing or
production path currently gates behavior on either value. A Plant's storage locations remain separate records.

D-089 records the owner's choice to keep both as Cairn-specific descriptive metadata, preserve the true defaults,
permit both false, retain the read badges, and expose them in the future Plant definition/change form. They are not
presented as SAP-standard fields and do not imply operational capability. The schema comments now say this
explicitly. No structural schema, migration, database, service, form or operational behavior changed; only a
schema comment was clarified. `git diff --check` passed. No remote DB, commit or push.


### 26.139 B-121 — protected Plant definition create/change service/action `IMPLEMENTED · DB ACCEPTANCE NEXT`

Added `src/modules/foundation/plant-maintenance.ts` and `src/app/config/plants/actions.ts` for the approved SCR-014
create/change contract. The service input and nested definition-value object are strict. Required Plant code/name
and country are bounded by the current schema; country is normalized and checked against the global country
catalogue. Language defaults to `EN`, is normalized as a two-letter value, and has no separate reference lookup.
Street, house number, postal code, city and region are optional structured values. Factory Calendar remains an
optional 10-character key with no catalogue lookup or operational use. The two Cairn-specific role flags default
true and both false is valid.

The action requires a session and the exact registered, non-posting `CFG.ORG.PLANT.DEFINE` capability. It derives
tenant and actor only from the verified session, then submits the approved Plant-definition field set. The global
capability seed now registers this code; existing Configurator/Administrator wildcard grants remain the authority
source, with no new explicit role grant. The existing Plants page remains read-only and does not expose the action.

Create uses a tenant/Plant advisory lock, refuses duplicate keys, leaves Company Code and default storage location
unset, and uses the existing true active default. Change uses the same lock plus a row lock and writes only the
approved definition fields, preserving Company Code assignment, default storage location, legacy free-text
`address`, active status and technical audit columns. Neither Company Code nor default storage location is accepted
by the strict service contract or read by the action. Create/change write field-level audit snapshots under object
class `plant` and transaction `CFG.ORG.PLANT.DEFINE`; audit projection is explicitly limited to the allowed fields,
including labels that identify the two role flags as Cairn-specific descriptive metadata. No-op changes write no
Plant change document. Successful create/change/no-op calls complete the existing Plant definition activity.

The Plant table has no integer version column, and this task does not add a schema migration. For optimistic
concurrency, the service uses the count of this tenant Plant's change documents as its version token: records with
no Plant change documents begin at version 0; create and each actual audited change return the incremented count;
stale versions are refused. Disposable PostgreSQL 17 acceptance of this behavior is explicitly deferred to B-123.

**Verification:** the new DB-free service/action contract tests pass (14/14); browser harness **122/122 tests across
21 files**, typecheck, IP lint (**285 files**) and `git diff --check` pass. Dependencies were installed temporarily
for verification and removed. No database was contacted; no migration or seed was executed; the full DB suite, live
browser, UI, Company Code assignment path, Factory Calendar master/use and production build were not part of this
batch. No remote/owner/production DB, commit or push. B-123 was the separate disposable-local PostgreSQL 17 gate.


### 26.140 B-123 — B-121 Plant create/change service acceptance `DISPOSABLE POSTGRESQL 17 PASSED`

**Preflight before migration or seed:** created a fresh PostgreSQL 17.11 cluster/database `cairn_b123` on loopback
port 55520. Verified the cluster system identifier `7695769387670325566`, data directory
`/var/lib/postgresql/17/b123`, database name, version `170011`, UTF8 encoding, port and server address. The public
schema was empty and `cairn_migration` did not exist. The `cairn_app` runtime role was confirmed NOSUPERUSER and
NOBYPASSRLS before setup. All database connections explicitly used `127.0.0.1`; no connection used the separate
platform `169.254.0.21` port proxy.

After that preflight, applied the 43 already-approved migrations, including Plant migrations 0019 and 0020; no new
migration was added. Ran only the global capability/activity/registry/message seed and shared reference-data seed;
no tenant/business seed was run. Verified the exact `CFG.ORG.PLANT.DEFINE` row was non-posting Foundation
configuration and that reference countries KW and SA were present.

`tests/plant-maintenance.test.ts` passed **5/5** on PostgreSQL. The cases exercised: create defaults, unassigned
Company Code/default storage, create audit and activity completion; change-field allowlist and preservation of
Company Code/default storage/legacy address/inactive status; both descriptive role flags false and an unregistered
Factory Calendar key; no-op silence, version increment and stale-change refusal; country-reference refusal and
same-key tenant isolation with tenant-specific audit versions. The runtime connection used `cairn_app`, whose
NOSUPERUSER/NOBYPASSRLS flags remained intact.

**Cleanup and verification:** test tenants, test Plants, Plant change documents/items and Plant activity rows were
verified at zero before dropping the disposable cluster. Cluster/data, temporary credentials/configuration, the 11
PostgreSQL packages installed for this run and project `node_modules` were removed. Typecheck, browser harness
**122/122**, IP lint (**286 files**) and `git diff --check` pass. No full database suite, production build, live-browser
acceptance, UI, new migration, remote/owner/production DB, commit or push. B-121's service/action is DB-accepted;
SCR-014's UI and live-browser acceptance remain pending at B-123's completion.


### 26.141 B-124 — SCR-014 Plant definition UI `IMPLEMENTED · LIVE-BROWSER ACCEPTANCE PENDING`

B-124 adds the capability-gated create/change UI to the existing `/config/plants` page. The Plant and
storage-location list remains readable for authenticated users; only users with the exact
`CFG.ORG.PLANT.DEFINE` capability see the create button, per-Plant change controls and form. The page derives
the tenant from the verified session, obtains country choices only when an authorized definition form is
open, and resolves the existing Plant's change-document-count version token before rendering a change form.
The client form calls B-121's existing protected server action; it adds no write service or alternate write path.

The form follows D-087/D-088: required Plant code (10 characters), name (160), and country; optional street
(160), house number (40), postal code (20), city (80), region (80), and Factory Calendar key (10); language
defaults to `EN`. Change locks the Plant code and includes the audit-count version token. Company Code,
default storage location, active status, tenant and actor are not submitted as editable fields. Company Code
assignment remains separate. The Factory Calendar key is visibly identified as unvalidated and non-operational;
its optional value is not looked up or used. Both Cairn-specific descriptive site-role flags default true and may
both be unchecked; explanatory copy makes clear that neither is an operational gate. A maintenance reason is
optional. Existing Production/Storage badges are retained.

**Verification:** new DB-free UI contract tests pass **3/3**. The browser harness passes **125/125 tests across
22 files**, typecheck passes, IP lint scans **288 files** with no user-facing reference trademarks, and
`git diff --check` passes. Project dependencies were installed temporarily for verification and removed. No
application/database connection, database setup, migration, seed, production build or live browser was used.
B-125 is the distinct pending cookie-backed live-browser acceptance task, using its own identity-verified
disposable local PostgreSQL 17 fixture. No remote/owner/production database, Company Code assignment UI,
Factory Calendar master/use, commit or push.


## §27 · Open items `RESOLVED v0.2`

All ten items below were resolved by the product owner on 2026-10-08. Kept here (never deleted) with
their resolutions so the reasoning is traceable. **No items are currently open.**

| # | Item | Resolution | Ref |
|---|---|---|---|
| 1 | UI density vs airiness | **Compact by default**, with a comfortable mode. Product owner added a constraint: keep the density but **avoid visual imitation** — so grids stay dense in our own visual language, governed by the checklist in §19.5 | D-034 |
| 2 | Intercompany automation depth | **Automatic cross-company posting in M1**, with mirror documents, IC reconciliation accounts and elimination at consolidation (§14.7) | D-028 |
| 3 | Credit management | **Yes, with standard blocking behaviour** — order and delivery block on limit breach, controlled release with reason (§14.8) | D-029 |
| 4 | Returns flow | **Phase 3**, as recommended — not in the first O2C delivery | §25.3 |
| 5 | Mail server | **Product owner supplies SMTP data through the UI**; credentials encrypted at rest; screen `CFG.PLT.MAIL.DEFINE` (§22.8) | D-033 |
| 6 | Number display format | **Our own readable format** (`POF-2026-000123`), with an optional classic zero-padded display for users who prefer it | D-030 |
| 7 | Tenant creation | **Product owner creates their own tenant manually** through the UI, page by page during testing. **Agent creates the development tenant from the start** for build and test | D-006 |
| 8 | Backup retention and PITR | **14 daily / 8 weekly / 12 monthly**, WAL archiving on for point-in-time recovery, weekly verified restore (§22.6) | D-031 |
| 9 | Approval notifications | **Inbox always; email optional per user.** No workflow step may depend on email delivery (§17) | D-032 |
| 10 | Visual identity package | **Placeholder logo and neutral assets for now**; real identity package later. No code depends on the artwork (§19.2) | §19.2 |

### 27.1 Items expected to arise during the build

Recorded here as a standing reminder that the page cycle (§24.1) will surface new questions. Each
becomes a numbered item when raised, and is resolved rather than left to drift.

| Watch item | Raised by | Expected |
|---|---|---|
| Field-level details of each screen as it is gathered | Walkthroughs | Continuously through M1b–M1e |
| Intercompany transfer pricing markup percentage and account setup | Accountant user | Before M1e testing |
| Consolidation presentation format (management vs statutory layout) | Product owner | Before SCR-061 |
| Whether credit limits should be per credit control area or per sales area in practice | Product owner | During SCR-059 walkthrough |
| Print/PDF layout approval for each business document | Product owner | During §17 output work |

---

## §28 · Risk register `OPEN`

| ID | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| RK-01 | **Production order costing** is the hardest part of M1 — cost flow, rates, variance, settlement | M1 delay | High | Build last within M1d, isolate behind the costing engine, use the worked example in §13.2 as the acceptance case, and start with a single material |
| RK-02 | **MRP** is a large subsystem added late to scope | M1 delay | High | Implement after the manual-order path works; keep the online single-item run first, plant-wide run second |
| RK-03 | Scope breadth across nine modules | Sustained effort | Certain | Strict tiering (D-010), incremental phases, page-by-page cycle so value lands continuously |
| RK-04 | **Numbering under concurrency** producing duplicates or gaps | Data integrity, audit failure | Medium | Advisory locks + gap-free allocation, tested under concurrent load before M1c |
| RK-05 | Financial reporting performance at volume | Unusable reports | Medium | Balances table with drill-through rather than summing all lines; index strategy designed in Phase 0; performance tests in §24.3 |
| RK-06 | **i18n retrofit** if the locale layer is skipped under time pressure | Rework across every screen | Medium | Enforce no-hardcoded-strings lint rule from the first commit (R-19) |
| RK-07 | Container stack validated only at the end | Deployment surprises | Medium | Author compose early; product owner validates the stack on the host during M1a, not at the end |
| RK-08 | Divergence drift — quietly becoming "not SAP-like" | Fails R-02 intent | Medium | Divergence Register reviewed at every walkthrough (§3.3) |
| RK-09 | Single small development environment (2 vCPU, modest memory) slowing builds and tests | Slower cycles | High | Keep dependencies lean, avoid heavy build tooling, run targeted tests rather than the full suite each change |
| RK-10 | Docker unavailable in the agent sandbox | Cannot self-verify deployment | Certain | Native development here; container validation by the product owner (D-025) |
| RK-11 | Legal or trademark exposure on the product name or on reference aliases | Renaming, legal cost | Low | Own naming throughout; aliases used factually as search metadata only; trademark search recommended before branding spend |
| RK-12 | Statutory payroll expectation creeping back into scope | Legal exposure if built wrong | Low | Hard exclusion documented (R-11, DV-001) and surfaced in the product |
| RK-13 | Tenant isolation defect | Cross-tenant data exposure | Low | Row-level security plus a dedicated isolation test suite (§24.3), run every build |

---

## §29 · Glossary & alias examples `DRAFT`

Reference identifiers appear here and in the registry **only as search metadata** (R-01). They are a
courtesy to experienced users, never part of the product's own naming.

### 29.1 Core concepts

| Our term | Meaning | Reference alias |
|---|---|---|
| Client | Tenant; complete data and configuration partition | Mandant / client |
| Company code | Legal entity that keeps its own books | Buchungskreis / company code |
| Controlling area | Cost accounting boundary, may span company codes | Kostenrechnungskreis |
| Plant | Production or storage site; assigned to one company code in a separate step | Werk |
| Storage location | Stock area within a plant | Lagerort |
| Purchasing organisation | Entity that negotiates and issues purchase orders | Einkaufsorganisation |
| Sales organisation | Entity legally responsible for sales | Verkaufsorganisation |
| Document principle | No data change without a document | Belegprinzip |
| Document flow | The graph linking predecessor and successor documents | Belegfluss |
| Number range | Server-allocated, gap-free document numbering | Nummernkreis |
| Release strategy | Configurable multi-level approval by value and criteria | Freigabestrategie |
| Account determination | Configuration mapping business events to GL accounts | Kontenfindung |
| Condition technique | Rule-based pricing and output determination | Konditionstechnik |
| Movement type | Classifies a goods movement and drives its accounting | Bewegungsart |
| Good receipt / invoice receipt clearing | Interim account bridging goods receipt and invoice | Wareneingang/Rechnungsprüfung |
| Activity type | Measure of cost centre output, priced by a rate | Leistungsart |
| Bill of material | Structured component list for a product | Stückliste |
| Routing | Ordered operations with times and work centres | Arbeitsplan |
| Work centre | Resource where operations are performed, linked to a cost centre | Arbeitsplatz |
| Planned order | MRP proposal not yet converted to a real order | Planauftrag |
| Cost collector | Object that gathers costs before settlement | Kostensammler |
| Variance | Difference between actual and target cost | Abweichung |
| Settlement | Transfer of collected costs to receivers | Abrechnung |
| Subledger | Vendor and customer open item accounting | Nebenbuch |
| Tie-out | Reconciliation proving two views agree | Abstimmung |
| Universal journal | Single line-item table carrying all account assignments | ACDOCA concept |
| Evidence pack | Exported audit bundle with hash manifest | — |

### 29.2 Registry examples (searchable aliases)

| Search input | Lands on | Coverage |
|---|---|---|
| `ME21N` | `PROC.PO.CREATE` | Tier 1 built |
| `MIGO` | `INV.GR.POST` | Tier 1 built |
| `MIRO` | `PROC.INV.RECORD` | Tier 1 built |
| `MD04` | `PROD.MRP.STOCKREQ` | Tier 1 built |
| `CO01` | `PROD.ORDER.CREATE` | Tier 1 built |
| `VA01` | `SALES.ORDER.CREATE` | Tier 1 built |
| `VF01` | `SALES.BILLING.CREATE` | Tier 1 built |
| `FB50` | `FIN.JOURNAL.POST` | Tier 1 built |
| `F110` | `FIN.AP.PAYMENTRUN.EXECUTE` | Tier 1 built |
| `FS00` | `CFG.FIN.GLACCOUNT.CREATE` | Tier 2 configured |
| `OBYC` | `CFG.FIN.ACCTDET.DEFINE` | Tier 2 configured |
| `BSEG` | `journal_entry_line` (data model) | Reference |
| `MARA` | `material` (data model) | Reference |
| `VBAK` | `sales_order` (data model) | Reference |
| `MD61` | Long-term planning / forecast | Tier 3 mapped, not built |
| `CK40N` | Mass costing run | Tier 3 mapped, not built |
| `LTMC` | `FND.IMPORT.SESSION` | Tier 1 built |

---

## §30 · Change log `LIVE`

| Version | Date | Change | By |
|---|---|---|---|
| 0.1 | 2026-10-08 | Document created. Requirements register (R-01…R-21), decision register (D-001…D-027), conformance model and Divergence Register (DV-001…DV-014), naming and IP boundary, engine architecture, organisational model and multi-tenancy, Configuration Workbench and standard configuration package, full data model, master data model, module scope and transaction inventory (~300 Tier 1, ~90 Tier 2), golden flows with accounting entries, MRP design, production order costing, finance detail, People subset, audit workspace, output production, import pipeline, UI/UX system, repository architecture, worker and jobs, Docker deployment, security, testing and page-cycle protocol, phase plan and M1 acceptance criteria, Phase 1 screen inventory (57 screens), open items, risks, glossary. | Agent |
| 0.2 | 2026-10-08 | **All §27 open items resolved by the product owner.** New decisions D-028…D-034. Added: §14.7 Intercompany (automatic mirror posting, IC reconciliation accounts, elimination; in M1), §14.8 Credit management (blocking behaviour, exposure calculation, controlled release; in M1), §19.5 binding Anti-imitation checklist with automated trademark lint, credit control area added to the organisational model (§6.1), mail server configured through the UI with encrypted credentials (§22.8), notification policy — inbox always, email optional, no email-dependent workflow (§17), concrete backup policy with WAL archiving and weekly verified restore (§22.6), number display format decided (§4 grammar, D-030), §17 output list extended with consolidated statements, six new finance transaction codes, M1e scope extended with intercompany and credit, acceptance criteria 16–18 added, screens SCR-058…SCR-063 added (Phase 1 inventory now 63 screens). §25.1 M1e redefined. §27 converted from OPEN to RESOLVED with a forward-looking watch list. | Agent |
| 0.3 | 2026-10-08 | **M1a substrate built and tested.** New decisions D-035…D-040, all arising from the build itself. Delivered: PostgreSQL 17 schema (33 tables, 25 under row-level security with FORCE), `cairn_app`/`cairn` role split (D-040), migration runner with immutable checksums and the `9000+` hand-written convention (D-039), engines E3 numbering (gap-free, proven under 40-way concurrency and rollback), E4 locking (advisory locks, ordered acquisition, contention log), E5 document flow and index, E6 posting with exact decimal money (D-035) and a database-enforced balance invariant, E14 change documents, term registry (§4.4) with working command-bar resolution, Configuration Workbench rendering the 51-step define/assign chain with prerequisite gating, tenant onboarding creating client, settings, 10 roles, 13 number ranges and the workbench checklist in one transaction. **22 automated tests passing** across numbering, posting and tenant isolation. Next.js app builds and serves; development tenant 0100 created through the same service the UI uses. Four defects found and fixed during the build: duplicate primary keys, a missing module registration in the schema root, an unscoped workbench query that RLS correctly default-denied, and a wrong foreign key on `role_capability` (D-037). | Agent |
| 0.4 | 2026-10-08 | **M1b foundation screens built, and the first real defect found through them.** Delivered: posting period maintenance with a visual period grid per account type (`CFG.PLT.PERIODRULE.DEFINE`, backed by the period engine E7), G/L account master list (`FIN.GL.MASTER.LIST`, grouped by account class with search), plant and storage location maintenance (`CFG.ORG.PLANT.DEFINE`), journal entry list with document detail and a posting form that derives the fiscal year and period from the posting date. Configuration Workbench now links only to screens that exist and marks the rest "Screen pending" — no link in the product produces a 404. Registry extended to 13 terms and 12 aliases (`FIN.JOURNAL.POST`, `CFG.PLT.NUMBERRANGE.DEFINE`). **33 automated tests passing**, plus two end-to-end suites: `npm run smoke` (every page, rendered content, cross-tenant isolation through the web layer) and `npm run smoke:posting` (post a balanced document, read it back through the list and detail views, refuse an unbalanced one with the difference stated, refuse a closed period with the period and open range named, confirm the configuration change is recorded with field-level before/after detail and flagged security-relevant). Four defects found and fixed: **(1)** number ranges were only ever resolved for an exactly matching fiscal year, so a tenant with year-independent ranges could not post at all — resolved as D-042; **(2)** tenant deletion left orphans in 43 of 44 tenant-scoped tables — resolved as D-041; **(3)** test cleanup ran unscoped, so row-level security silently deleted nothing and stale test state leaked into later runs, surfacing as an unrelated numbering failure — cleanup is now scoped and fails loudly if it removes nothing; **(4)** the displayed document number carried no year when it came from a year-independent range. | Agent |
| 0.5 | 2026-10-08 | **Authentication, sessions, and the trademark lint — the layer every later screen now sits on.** Built: the logon screen (tenant, user, password, plain form, no client-side JavaScript required to sign in), `src/platform/auth/session.ts` (sign-in, lockout after five failed attempts, server-side sessions, sliding renewal, revocation, capability resolution through roles), `src/platform/auth/current.ts` (`getSession` / `requireSession` / `requireCapability`), and route handlers for sign-in and sign-out. Every protected page now takes its tenant from the session; `?client=` is ignored and the workbench tenant switcher is gone. A new `npm run lint:ip` walks the source tree and fails the build if a reference vendor's trademark appears anywhere a user could read it — the Term Registry is the only exemption, and it is exempted by content rather than by a path guess, so moving the registry cannot silently widen the exemption. It found one real occurrence (a comment in the test helpers) which was reworded. **Two defects found by the new tests and both fixed in the code rather than in the assertion:** (1) the first capability matcher granted any authority that *began with* a held pattern, so `PROC.PO.CREATE` would have granted `PROC.PO.CREATE.APPROVE` — now matched segment by segment with the held pattern required to account for the whole required path and no more; (2) sign-in threw inside the tenant transaction, so a rolled-back transaction discarded the failed-attempt counter and the audit row together — a lockout that never happened and an access log that recorded nothing, while the caller still saw the correct error. `signIn` now commits the attempt and raises the exception afterwards. Also fixed: redirects were absolute and pointed at `0.0.0.0:3000`, which would have sent users to a host that does not resolve behind the reverse proxy; they are now relative. **52 automated tests passing** (19 of them new), both smoke suites green and both rewritten to sign in through the real logon screen — so if signing in breaks, they fail. | Agent |
| 0.6 | 2026-10-09 | **Number range maintenance and real-browser acceptance.** D-045–D-048: capability-gated write actions with session-derived tenant/actor; company-scoped accounting ranges; configured type assignment to shared GENERAL; stable company/year/value journal keys separate from display; authoritative blocked/exhausted year-specific controls; safe interval maintenance with locking, immutable starts/formats, reserved blocked numbers and allocation drill-through. Fixed D-043 implementation drift: onboarding was still creating FI ranges although the standard package did not; customer tenants now require the visible maintenance step, while only the development fixture configures it automatically through the same service. Real Chromium walkthrough caught the administrator wildcard seed and an interior wildcard matcher defect; both repaired, including existing standard roles. Fixed misleading onboarding checklist state for tenant/roles/user, the unrestricted runtime database fallback, and migration-role silent RLS no-ops with privilege preflight checks. Production build and browser flow pass; **85 automated tests passing**, both HTTP smoke suites and trademark lint clean. Dev-server/Chromium memory stalls resolved by using a short production build and a lightweight production preview; R-22 records the short verified batch instruction. Header no longer claims the accepted baseline is awaiting red-line. §26.7 contains the page contract, verification, limitations and reproducible sandbox procedure; owner sign-off remains pending. | Agent |
| 0.7 | 2026-10-09 | **Preservation checkpoint and owner-requested 15-minute batch cap.** Records the interrupted material-master slice without claiming its UI release is complete: eight tenant tables/policies, four view services/forms, staged statuses, exact quantities/prices, versioned edits, operational gating, separate financial price authorities, development sample masters and extended tests. Last completed checks: TypeScript/IP lint clean and **110 automated tests passing**; material browser acceptance and production build/release remain pending. The prior number-range preview is left running. Saved a full readable PostgreSQL dump and a source archive with checksums under `checkpoints/2026-10-09_0127_UTC`; no database mutation, reset, reseed or deletion in this checkpoint. D-049 documents retained material semantics; D-050 and revised R-22 enforce one small batch, ≤10 minutes implementation plus verification/checkpoint time within 15 minutes total. §25.4 replaces broad execution runs with named test/view/backend slices; §26.8 records the exact retained state, backup and safe restore procedure. | Agent |
| 0.8 | 2026-10-09 | **B-001 complete within the 15-minute batch budget.** Split the monolithic browser acceptance into five independently runnable targets, with foundation-only default, fresh per-target guarded fixtures, pure argument/ownership validation, 120-second work deadline and bounded diagnostics/cleanup. Material cases no longer require other plant views first. Added explicit npm commands and a pure Vitest harness configuration with no database setup/purge. TypeScript/IP lint clean, **23 focused harness tests passing**, and the existing foundation browser flow passes in about 4 seconds; only its own temporary fixture was touched and preserved database counts match before/after. Saved a new database/source checkpoint without replacing B-000. No ERP feature, page, schema, migration or seed change; material targets still unexecuted pending B-002 publication. §25.4 queue updated and §26.9 records commands, boundaries and verification. | Agent |
| 0.9 | 2026-10-09 | **B-002 complete: Material Basic Data published and browser-verified within the 15-minute cap.** Rebuilt/restarted the production preview to publish retained material pages and session/launchpad changes. Expanded only the Basic target to test incomplete save, completion, unchanged resave, exact weight maintenance, actor/tenant forgery refusal, visible history/footer, search and basic-only copy. Found and fixed FND-001: action reset restored stale uncontrolled select defaults and could remove the saved unit; inner form now remounts from the committed view version. FND-002/FND-003 fix description metadata collision and SPA navigation synchronisation in the test, without arbitrary waits. Corrected production build, TypeScript/IP lint, **133 automated tests** and Basic-only browser acceptance pass. Preserved database counts match before/after, no reset/reseed/migration, fresh backup and review image saved. Other material view walkthroughs remain pending; B-003 Purchasing is next. §26.10 contains the verified contract, findings, live process/build identity and limitations; owner sign-off remains pending. | Agent |
| 0.10 | 2026-10-09 | **Owner-requested GitHub source publication checkpoint.** D-051 records the public repository/branch and source-only boundary. Repaired local Git metadata, fetched existing `main` history and retained the repository GPL v3 license unchanged. Added private-artifact/credential exclusions and a safe development environment template. No ERP feature, database reset, migration or reseed; B-003 Purchasing remains next. Normal fast-forward source push verified; §26.11 records the source commit and confirmation. No token or private artifacts are committed. | Agent |
| 0.11 | 2026-10-10 | **Owner-approved private local Git configuration.** D-052 supersedes the memory-only part of D-051: repository URL and supplied token saved in ignored/untracked `.env.local`, owner-only 0600, with server-only variable names. Credential values are absent from this log, committed source and environment examples; no push, token rotation, application/database change or reset. §26.12 records checks and the private-file boundary. B-003 Purchasing remains next. | Agent |
| 0.12 | 2026-10-10 | **Core Docker deployment files added after the owner found them missing.** D-053 ships app/db/migrate only; worker, pooling/cache and scheduled backups remain separate pending slices. Added multi-stage non-root standalone Dockerfile, build-secret exclusions, Compose with existing Traefik proxy/web/no-certresolver, safe secret template and restricted database-role initialization without resets. Standalone/tracing-root settings correct artifact location. Compose configuration, YAML/security/shell checks, secret-free standalone build, sign-in HTTP smoke, 23 focused tests and IP lint pass; no Docker engine exists here, so full image/container/database/Traefik deployment is explicitly unverified. No current database or private-credential upload. §22 implementation status and §26.13 contain scope, setup, checks and limitations. Normal source push and remote ref verified; deployment commit recorded in §26.13. | Agent |
| 0.13 | 2026-10-10 | **Docker database authentication repair after owner-reported 28P01.** D-054 adds a managed runtime credential synchronization/verification step before migrations and an explicit existing-volume local-admin recovery script. Enforces restricted app role, safe server-side password formatting, explicit owner/runtime URLs and no business-table changes. Legacy applied migration 9000 remains unchanged; its missing-role development fallback can no longer override fresh managed deployment credentials. Added 12 credential tests to pure harness; 35 focused tests, TypeScript/IP lint, shell syntax and standalone build pass. Actual host repair is not claimed; owner commands, env-file consistency, volume preservation and restart behavior are documented in §26.14. No database reset/data edits or secret publication. Normal source push verified; fix commit recorded in §26.14. Owner-host repair remains unverified. | Agent |
| 0.14 | 2026-10-10 | **Default `.env` Docker Compose deployment after owner clarification.** D-055 standardizes the production template and runbooks on automatically loaded `.env`, preserving the local development template separately and legacy Docker template compatibility. No repeated env-file flags or whole-file environment injection; existing real secret values are untouched/ignored. Plain Compose config validated in an isolated dummy project with matching DB/app/migrate credentials; shell/whitespace checks pass. In-place credential repair and fresh-log commands now use plain Compose. Actual host authentication remains pending owner execution; no database reset/edit or feature changes. §26.15 records the filename-versus-stored-password distinction, checks and preservation boundary. Normal source push verified; default-env commit recorded in §26.15. Host repair remains unverified. | Agent |
| 0.15 | 2026-10-10 | **Read-only split-connection diagnosis after fresh migration/app logs.** Migration verifies app-role login and seeds succeed while app still gets 28P01, so further password resets are stopped. Added a safe Docker inspection/DNS/optional login diagnostic plus five passing pure redaction tests. No secrets/connection strings printed, no database or deployment changes, no root-cause claim without host output. §26.16 records evidence, commands, possible shared-network `db` collision and interpretation. Host diagnosis/resolution remains pending; normal source push verified and diagnostic commit recorded in §26.16. | Agent |
| 0.16 | 2026-10-10 | **Confirmed wrong-target database DNS collision fixed in Compose.** Owner diagnostic proves app/migration credentials match but app resolves generic `db` to 172.18.0.9 instead of Cairn DB 172.31.0.2. D-056 adds private alias `cairn-postgres` and points all runtime/owner URLs to it; keeps service/volume, roles/secrets and existing Traefik unchanged. Compose resolved-config checks and 8 Python redaction/routing tests pass. Owner must apply the alias/recreate containers and verify DNS; no password reset, image rebuild, volume removal or ERP-data change. §26.17 records evidence, commands and expected outcomes. Normal routing fix push verified; commit recorded in §26.17. Host remediation not yet verified. | Agent |
| 0.17 | 2026-10-10 | **Production tenant admission security after owner concern.** D-057 closes anonymous signup: first setup requires deployment-owner token, later setup requires token plus verified provisioning capability; global transaction lock/init recheck before tenant insert prevents stale bootstrap admission. Independent server-action gate, server page wrapper and masked owner field added; production directory/launchpad require sign-in and filter own tenant. Safe optional server-only token configuration added; blank locks web provisioning, existing users/data unchanged. 53 focused tests, TypeScript/standalone build/IP lint and 8 Python regressions pass; no live host/PG concurrency claim or complete security sign-off. §26.18 supersedes public-onboarding advice and documents configuration/limits. Normal security push verified; commit recorded in §26.18. Host validation remains pending. | Agent |
| 0.18 | 2026-10-10 | **B-003 complete: material Purchasing UI accepted in a bounded batch.** Extended only its browser target for staged/complete/maintained plant data, exact tolerances/manufacturer part, unchanged-save preservation, unsupported-unit refusal, visible history/footer and warehouse read-only access. No MRP/valuation/PO feature changes or ERP product correction. Recovered discarded sandbox services by restoring the preserved B-002 database dump into a fresh empty DB—not a reset/reseed; original checkpoint counts match before/after. Standalone/typecheck, **163 Vitest tests**, 8 Python regressions, IP lint and real Purchasing-only browser pass. Fresh private DB/source/review checkpoint saved; owner remote data untouched. §26.19 records scope/results/limitations; B-004 planning settings is next. Normal verification-source push verified; commit recorded in §26.19. | Agent |
| 0.19 | 2026-10-10 | **B-004 complete: Material MRP settings UI accepted within its small-batch scope.** Tested staged/complete/maintained plant settings, exact quantities, unchanged resave, reorder net-change reflag, invalid lot refusal, visible history/footer and warehouse read-only authority. Found FND-004: null saved controller wrongly used a new-record default and auto-completed on resave; browser-safe value helper now distinguishes null/undefined, with five regressions. No existing-record rewrite or MRP engine/valuation/purchasing expansion. Typecheck/standalone build, **168 Vitest tests**, 8 Python tests, MRP acceptance and Purchasing regression pass; private DB counts unchanged. Fresh checkpoint saved; shared UI correction needs owner image rebuild. §26.20 records results/limitations and B-005 valuation is next. Normal correction/acceptance push verified; commit recorded in §26.20. | Agent |
| 0.20 | 2026-10-10 | **B-005 complete: Material Valuation UI accepted.** Expanded only its browser target for incomplete/complete/maintained/no-op settings, exact moving/standard prices and price unit, company-derived currency, forged/read-only stock-value refusal, positive unit validation, existing-stock change guard, visible financial history and separate finance-display/warehouse denial. Guard stock and auth identities are isolated SQL fixtures, not new postings or owner data. Fixed only a test column-name mismatch, not schema/product code. 168 Vitest tests, 8 Python tests, typecheck/IP lint and real valuation browser pass; data counts unchanged and private checkpoint saved. All four implemented views individually verified, not full material/operational conformance. §26.21 records limitations; B-006 payment-term backend is next. Normal valuation-acceptance push verified; commit recorded in §26.21. | Agent |
| 0.21 | 2026-10-10 | **B-006 complete: payment-term backend/defaults, UI pending.** Added one tenant-cascading forced-RLS master and additive 0003/9007 migrations (12 applied, existing immutable). Versioned/locked/audited service validates exact discount tiers, no-op/stale concurrency and active status; pure explicit-baseline UTC due/discount-date result carries master version for future document snapshots. Five additive standard defaults wired into fresh package activation and guarded development 0100 only; existing definitions/business records untouched. 19 new tests; 187 total, typecheck/standalone build/IP lint pass. Fixed-date/month-end/instalments and invoice/payment execution remain pending; no fake working UI route. §26.22 records contracts/preservation and B-007 page is next. Normal backend push verified; commit recorded in §26.22. | Agent |
| 0.22 | 2026-10-10 | **B-007 complete: protected payment-term maintenance UI.** Added own-code list/search/create/change/history and saved baseline-date preview, independent session/capability action, safe defaults/version behavior and checklist completion. Registered working screen/capability (39 caps/17 terms/16 aliases). Three new action-security tests and isolated browser case; 191 automated tests, 8 Python regressions, standalone/typecheck/IP lint and real form/date/error/history/search/checklist pass. Original records unchanged, no migrations or invoice/payment execution. R-23 records mandatory owner check instructions/dummy data; §26.23 includes TEST30/TEST2D expected dates and negative/stale/authority checks. B-008 partner general backend next. Normal maintenance UI push verified; commit recorded in §26.23. | Agent |
| 0.23 | 2026-10-10 | **B-008 complete: general business partner backend only.** Added two tenant-cascading forced-RLS tables and additive 0004/9008 migrations (14 applied). Validated/locked/versioned/audited general identity supports staged address, immutable category, supplier/customer dual roles, stable role deactivation, block/use gates and no-op preservation. No bank/company/purchasing/sales/operational capability fabricated. 16 new tests; 207 total, 8 Python regressions, typecheck/standalone/IP lint pass; original business/config rows unchanged, no partner fixtures retained or owner-host edits. §26.24 gives backend checks and future TESTSUPP01 dummy form data; UI is B-009 next. Normal general-backend push verified; commit recorded in §26.24. | Agent |
| 0.24 | 2026-10-10 | **B-009 complete: protected general partner maintenance UI.** Registered own create/display/maintain commands and capability (40 caps/20 terms/19 aliases), launchpad and general-only form/list/search/status/history with explicit pending segments. Server session/authority/context checks, safe business-only props, immutable category/number, staged saves, roles and blocking supported. Three action regressions plus browser target; 211 tests, 8 Python checks, typecheck/standalone/IP lint and real general lifecycle/read-only browser pass; no owner data or schema change. §26.25 provides TESTSUPP01/TESTCUST01 dummy records, expected/negative/stale checks; B-010 company backend next. Normal general UI push verified; commit recorded in §26.25. | Agent |
| 0.25 | 2026-10-10 | **B-010 complete: supplier company backend, UI pending.** Added company-scoped forced-RLS/cascading master and immutable 0005/9009 additions (16 migrations). Derives chart and validates active supplier/company, vendor reconciliation and payment terms; stages, blocks, versions, audits and preserves no-ops. General/use gates and linked-accounting recon protection; no invoice/bank/purchasing flow implied. 18 new tests; 229 total, 8 Python, standalone/typecheck/IP lint pass, original data preserved via dump restoration and fixture cleanup. §26.26 documents dummy 1000/200000/NET30 assignments, width/reclassification caveats and B-011 next. Normal backend push verified; commit recorded in §26.26. | Agent |
| 0.26 | 2026-10-10 | **B-011 complete: supplier company financial UI.** Active Supplier tab/company selector, derived chart/currency, valid reconciliation/terms, stages/version/no-op/block and scoped history; separate financial read/write authority at page/action. Registered command/caps (42/21/19), added three action tests and isolated browser target. 233 tests, 8 Python, standalone/typecheck/IP lint and live scoped form/refusal/history/non-finance browser pass; original data/schema preserved. §26.27 has dummy 1000/200000/NET30 and positive/negative/stale checks, screenshot/private checkpoint. No invoice/bank/purchasing expansion; B-012 backend next. Normal UI push verified; commit recorded in §26.27. | Agent |
| 0.27 | 2026-10-10 | **B-012 complete: supplier purchasing-organisation backend, UI pending.** Added forced-RLS/cascading master plus immutable 0006/9010 additions (18 applied). Validates active org/company/currency/group/optional terms, delivery code/location, stable supplier role, stages/blocks/version/audit and plant assignment; independent org data, no company defaults copied. 19 new tests; 252 total, 8 Python, standalone/typecheck/IP lint pass; original data unchanged. §26.28 gives future 1000/USD/001/FCA/Kuwait City/NET30 form data and negative checks; no PO/stock/payment/partner-function flow implied. User review remains pending and B-013 UI is next. Normal purchasing-backend push verified; commit recorded in §26.28. | Agent |
| 0.28 | 2026-10-10 | **B-013 complete: procurement-protected supplier purchasing UI.** Added active Supplier tab/org selector and currency/group/delivery/location/optional-term/block/reason/status/history panel; independent server action/tenant-actor/PROC authority, safe filtered choices and unset preservation. 44 caps/22 terms/19 aliases; three action tests plus browser target. 256 tests, 8 Python, build/typecheck/IP lint, Purchasing browser and Company regression pass; original data/schema unchanged. §26.29 keeps later owner review pending and provides dummy/positive/negative/stale checks. Explicit next customer company/sales-area split B-014…17 added; no PO/stock/payment functionality implied. Normal procurement UI push verified; commit recorded in §26.29. | Agent |
| 0.29 | 2026-10-10 | **B-014 complete: customer company backend, UI pending.** Added tenant/RLS/cascading company AR master and immutable 0007/9011 additions (20 applied), active customer/chart-account/terms validation, staged/block/version/audit/use checks and linked recon/chart protection. Supplier and customer data remain separate on one dual-role identity; no sales/invoice/credit flow implied. 20 new tests; 276 total, 8 Python, standalone/typecheck/IP lint pass. Original data preserved by dump recovery/fixture cleanup. §26.30 gives future 1000/110000/NET30 assignments and positive/negative limitations; B-015 form next. Normal AR backend push verified; commit recorded in §26.30. | Agent |
| 0.30 | 2026-10-10 | **B-015 complete: Customer company AR maintenance UI.** Added Customer-only tab/company selector/derived chart-currency/valid AR-terms/block/history panel, separate FIN Customer read/write caps and independent session-derived action. 46 caps/23 terms; caught/fixed i18n namespace collision at typecheck. Three action tests and browser target; 280 tests, 8 Python, standalone/typecheck/IP lint, Customer browser and two Supplier regressions pass. Original data/schema preserved, owner reviews/rollout pending. §26.31 includes TESTCUST01/1000/110000/NET30 dummy/checks; no billing/clearing/credit flow implied and B-016 backend next. Normal AR UI push verified; commit recorded in §26.31. | Agent |
| 0.31 | 2026-10-10 | **B-016 complete: customer sales-area backend, UI pending.** Added forced-RLS/cascading `customer_sales_area` master plus immutable 0008/9012 additions (22 applied, 70 tables). Validates active customer role, sales area/organisation/company and same-company delivering plant; delivery/pricing defaults, flags, blocks, staging, version, audit and operational gate. Pricing procedure and sales district are code-only until their masters exist. 22 new tests; 302 total, 8 Python, typecheck/build/IP lint pass; Customer company regression unchanged. §26.32 gives dummy TESTCUST01/1000/01/01/RVAA01 future data and limitations; B-017 sales-area UI is next. Next B-017 sales-area UI. | Agent |
| 0.32 | 2026-10-10 | **B-017 complete: customer sales-area maintenance UI, browser acceptance pending.** Added Sales area tab on active Customer partners with separate SALES.CUSTOMER.SALESAREA DISPLAY/MAINTAIN authority, scoped area selector, plant/procedure/district/flags/block/reason/status/history and server action. Catalogue now 48/24/21 with seed rerun required. 3 action tests and 1 choice test added; 306 Vitest, 8 Python, typecheck/build/IP lint pass; SSR checks for maintainer/reader/no-authority roles pass. No browser run (no Chromium in sandbox). §26.33 gives owner steps and B-018 selection is next. | Agent |
| 0.33 | 2026-10-11 | **B-018 complete: customer company payment-methods/dunning-procedure fields, backend only.** Additive migration 0009 adds nullable `payment_methods` varchar(40) and `dunning_procedure` varchar(4) to `customer_company_code` (23 applied). Service normalises the payment-method set (capitalise/dedupe/sort, ≤10 codes of 1–2 chars) and the dunning code (≤4 capital letters/digits), both code-only until their masters exist; fields join version/no-op/history/RLS pipeline and are flagged security-relevant; completeness gate and operational gate unchanged; server action forwards fields with no visible UI change. No new capability, no reseed. 9 new tests; 315 Vitest across 19 files, 8 Python, typecheck/build/IP lint (162 files) pass in a freshly provisioned dev cluster. §26.34 records semantics, owner steps and limitations; B-019 (matching UI) is the natural next. | Agent |
| 0.34 | 2026-10-11 | **B-019 complete: customer company payment-method/dunning UI only.** Exposed the B-018 fields in the existing company-code form and authorised read-only view, populated them from persisted tenant data, and retained the existing session-derived action, version/no-op, change-history and authority behavior. No schema, migration, capability, seed or payment/dunning execution change. Added a focused action assertion and extended the customer-company browser target for canonical save/reload/no-op/history/access checks; the DB-backed target is not run in this fresh workspace because PostgreSQL is unavailable. Typecheck, production build, IP lint and 58 pure harness tests pass. §26.35 records behavior and owner walkthrough steps; B-020 is the next selected backend slice. | Agent |
| 0.35 | 2026-10-11 | **B-020 implementation complete: customer-company interest-indicator/tolerance-group backend only; DB acceptance pending.** Added nullable varchar(4) fields and additive migration 0010, preserving 0009. Both optional code-only fields trim, uppercase and accept 1–4 alphanumeric characters; explicit blank clears and an omitted field preserves stored values for legacy callers. They join the existing version/no-op/security-relevant history pipeline but do not affect completeness or operational use. No UI, master FK, calculation, enforcement, seed or capability change. Added pure normalizer coverage, DB-backed lifecycle/audit/validation tests, and an action-security legacy-form regression; DB-backed tests and migration application remain unrun because PostgreSQL is unavailable. Typecheck, production build, IP lint (164 files), 64 pure harness tests and diff check pass. §26.36 records behavior and limitations; B-021 is to be selected next. | Agent |
| 0.36 | 2026-10-11 | **B-021 implementation complete: customer company interest-indicator/tolerance-group UI; browser acceptance pending.** The existing Customer company panel now passes stored values to editable controls and authorised display-only values; codes remain max-four-character alphanumeric inputs, canonicalised by the B-020 service. The existing action/session-derived authority and omitted-field compatibility remain intact. Extended the isolated customer-company browser target for canonical save/reload, no-op, clear/restore, history and display-only/non-finance boundaries. No schema, migration, capability, seed or service behavior change. Typecheck, production build, IP lint (164 files), 64 pure harness tests and diff check pass; DB-backed browser smoke cannot run without PostgreSQL. §26.37 records owner steps; B-022 remains for selection. | Agent |
| 0.37 | 2026-10-11 | **Owner-approved dependency-ordered completion roadmap.** Added §25.5 from outstanding B-020/B-021/B-017 acceptance through M1b–M1e, M1 release/sign-off, then Phases 2–9. Added pending B-022–B-024 acceptance gates and B-025 partner-function rule capture to the bounded queue. Roadmap packages must still be split into ≤10-minute one-outcome batches; no code, schema, migration or database changes in this update. §25.5 records the M1/Phase-2 scope reconciliation and keeps D-028/D-029 baseline acceptance in M1. | Agent |
| 0.38 | 2026-10-11 | **B-022 complete: isolated PostgreSQL migration/database acceptance passed.** Provisioned fresh local PostgreSQL 17.11, loopback-only on port 55432, using dedicated `cairn_b022_test`; applied all 24 SQL migrations including 0010 and seeded reference data. Customer-company and action-security DB suites pass, 65/65 tests. B-023 customer-company browser acceptance is next; the test server remains available locally. No owner/production DB or tenant touched. No code or migration-file changes were made; the schema was applied only to the disposable local test database. §26.38 records setup and results. | Agent |
| 0.39 | 2026-10-11 | **B-023 automated browser acceptance passed for B-019/B-021.** Ran the isolated `customer-company` Playwright target against the B-022 PostgreSQL database using a UI-created, disposable development fixture `T988`; all save/reload/no-op/clear/restore/history, finance display-only, non-finance denial, validation and sign-out checks passed, with no page errors. The harness cleaned up its fixture (zero matching rows afterward). Owner walkthrough/sign-off and B-024 sales-area browser acceptance remain pending. CAIRN updated; no code or migration-file changes in this batch. §26.39 records scope and result. | Agent |
| 0.40 | 2026-10-11 | **B-024 automated browser acceptance passed for B-017.** Added focused `customer-sales-area` Playwright target using disposable UI-created dev fixture `T987`; verified sales-area staged/completed saves, plant choice, canonical defaults, persisted readback, no-op, scoped block/unblock, history, and signed-out protection. Target passed within deadline with no browser errors; cleanup query confirmed zero matching fixture rows. Display-only/finance-only browser switching is not covered by this target; B-017 SSR/action checks remain documented and the owner walkthrough is pending. Typecheck, 65-test browser harness and diff check pass. §26.40 records scope and boundaries; no schema or migration changes. | Agent |
| 0.41 | 2026-10-11 | **B-025 supplier partner-function semantics approved; implementation pending.** Owner approved primary supplier as fallback plus ordering-address, goods-supplier and invoicing-party assignments; no separate pay-to role; directed, non-reciprocal relationships; per-role unique/multiple cardinality with one optional default and user selection when absent; current purchasing-organisation scope without effective dates or plant/sub-range overrides. Reference semantics checked against SAP Help and SAP Learning; Cairn codes/labels remain proprietary-safe. No code/schema changes. §26.41 records decisions; partner-function implementation is next in separate bounded batches. | Agent |
| 0.42 | 2026-10-11 | **B-026 supplier partner-function storage and RLS complete; service pending.** Added tenant-scoped function-rule and purchasing-assignment tables, own function keys, composite same-tenant foreign keys, version/audit fields and one-default partial unique index. Added migrations 0011/9013 and schema registration. Applied all 26 migrations in a fresh isolated PostgreSQL 17.11 `cairn_b026_test`; verified FORCE RLS, default-deny reads/writes and restricted app-role flags. Typecheck, 65-test browser harness and diff check pass. Catalogue not seeded; role cardinality enforcement/service/UI remain future batches. No owner/production data or transaction behavior touched. §26.42 records results. | Agent |
| 0.43 | 2026-10-11 | **B-027 supplier partner-function read services passed.** Added tenant-scoped catalogue and assignment queries, including function/cardinality labels, defaults, versions and related Supplier status; inactive relationships remain visible for maintenance. Database tests pass 2/2, covering ordering, tenant/scope isolation and unscoped default-deny reads; typecheck passes. No write/service action, UI, seed or schema migration in this batch. §26.43 records behavior; assignment mutation/cardinality enforcement follows in a separate bounded batch. | Agent |
| 0.44 | 2026-10-11 | **B-028 initializes the owner-approved supplier partner-function catalogue in standard tenants.** Advanced the standard package to `INTL-STD-2`; each tenant package run inserts missing Cairn-owned `ORDERING_PARTNER`, `DELIVERY_PARTNER`, and `INVOICE_SENDER` rows with explicit initial `allowsMultiple=false` and Cairn labels, preserving existing tenant settings on reapplication. Owner selected UNIQUE for all three. Added DB coverage for seeded values, preserving tenant edits on re-application, and B-027 query/isolation coverage (4/4 supplier tests). Typecheck, full Vitest suite, 65-test browser harness and diff check pass. No assignments, defaults, write service, enforcement, UI, schema or migration change. §26.44 records scope; assignment behavior remains pending. | Agent |
| 0.45 | 2026-10-11 | **B-029 supplier partner assignment write service passed.** Added tenant-scoped audited create/update, atomic replacement and remove; enforced active function/role/scope checks, configured unique/multiple cardinality, no default for unique functions, optional single default for multiple functions, default transfer, optimistic versions and per-slot concurrency locks. No-op writes are silent; removals and default changes are audited. Four focused DB tests, 339 total Vitest tests, typecheck, 65 browser-harness tests and diff check pass in the isolated development database. No UI, action/capability or PO determination. §26.45 records limits; protected UI is next. | Agent |
| 0.46 | 2026-10-11 | **B-030 protected supplier partner-function server actions passed.** Added scoped catalogue/assignment reads and create/replace/remove actions; read requires purchasing DISPLAY/MAINTAIN or AUDIT.WORKSPACE and writes require purchasing MAINTAIN. Tenant and actor are session-derived; forged client/actor values ignored; anonymous calls redirect. Three action-security regressions added (30/30 action-security tests). Full Vitest (342/342), typecheck/build, browser harness (65/65), IP lint (172 files) and diff check pass. No UI, new capability, migration or PO determination. §26.46 records scope; maintenance UI is next. | Agent |
| 0.47 | 2026-10-11 | **B-031 display-only supplier partner-function panel added.** Integrated the authority-gated read view into the Supplier Purchasing tab, grouped by function and showing cardinality, active state, related supplier status/blocking, default and empty/no-default states. New UI labels use i18n. Typecheck, full Vitest (342/342), browser harness (65/65), production build, IP lint (173 files) and diff check pass. Dedicated live-browser acceptance and editing controls remain pending. No schema, migration or PO behavior. §26.47 records scope; assignment editor next. | Agent |
| 0.48 | 2026-10-11 | **B-032 supplier partner-function assignment editor added.** Maintain users can add/replace unique assignments, add multiple assignments, designate/change/unset their optional default, and remove rows with reason/version controls. Pickers query same-tenant active Supplier roles, advertise the 200-row limit, and stay disabled until a purchasing-org segment exists. Existing session-derived actions remain the only write path; no cardinality setting is invented or changed. Typecheck, full Vitest (343/343), browser harness (65/65), production build, IP lint (173 files) and diff check pass. Dedicated editor browser acceptance and PO determination remain pending. §26.48 records limits; browser acceptance next. | Agent |
| 0.49 | 2026-10-11 | **B-033 dedicated supplier partner-function live-browser acceptance passed.** Extended the disposable `supplier-purchasing` Playwright target with segment-gate, unique add/replace/remove, configured-multiple add/default set/unset/transfer/removal, read-only Auditor and unrelated-authority checks. The multiple rule was altered only in the UI-created T990 dev fixture; guarded cleanup ran and post-run query confirmed no T990 fixture remains. No browser errors. `npm run typecheck`, browser harness (65/65), focused target and diff check pass; no app schema/migration, transaction behavior, owner/production data, commit or deployment. §26.49 records coverage and boundary. | Agent |
| 0.50 | 2026-10-11 | **B-034 Supplier company-code UI-only pending defaults.** Added disabled, read-only placeholders for payment methods, dunning procedure, cash discount, and tolerance group to both maintenance and authorised display-only panels; they are outside the save form, have no submitted names, and have no persistence/action/schema behavior. Updated the `supplier-company` browser target to assert four disabled, non-submitted fields. Typecheck, production build, IP lint, 65 browser-harness tests and diff check pass. Live Playwright acceptance remains pending because no authenticated isolated development `DATABASE_URL` was configured; the read-only connection check failed before a fixture or database mutation. Payment Methods is the owner-selected first master; B-035 captures its v1 semantics/scope. §26.50 records scope and boundary. | Agent |
| 0.51 | 2026-10-11 | **B-035 Payment Methods master v1 semantics approved.** Owner selected a tenant+country+1–2-character uppercase alphanumeric identity, a shared catalogue with `OUTGOING`/`INCOMING`/`BOTH` eligibility, description and active state, definitions-only scope, and no standard seed methods. Future Supplier/Customer code assignments resolve by company-code country and direction; current Customer code-only validation remains unchanged. Vendor/customer and house-bank permissions, payment-medium formats, and execution stay separate. No code/schema/seed/database changes; D-058 and §26.51 record the decision; B-036 schema/RLS is next. `git diff --check` passes. | Agent |
| 0.52 | 2026-10-11 | **B-036 Payment Methods schema and tenant RLS implemented.** Added `payment_method` to the typed Foundation schema with country/code primary key, ISO country and tenant FKs, direction/domain/code/description/version checks, audit metadata, and additive migrations `0012_payment_method_master.sql` / `9014_payment_method_policies.sql` (ENABLE + FORCE RLS and app-role grants). Added DB-backed schema/RLS tests for country reuse, constraints, isolation, defaults, and cascade. Typecheck, build, IP lint (177), 65 browser-harness tests and diff check pass. DB-backed test/migration application remains pending because isolated development credentials are unavailable; no database/owner data touched. §26.52 records limits; B-037 read service is next. | Agent |
| 0.53 | 2026-10-11 | **B-037 Payment Methods read services implemented.** Added tenant-scoped, validated get/list reads by country and code; list supports requested `OUTGOING`/`INCOMING` use (including `BOTH`) and optional active-only filtering while retaining inactive rows by default. Added DB-backed read tests for canonicalization, country resolution, filters, tenant isolation and invalid inputs; not run because isolated dev DB credentials are unavailable. No schema, migration, write service, UI, seed, payment execution, or partner-field integration. Typecheck, 65 browser-harness tests, IP lint (179 files) and diff check pass. §26.53 records limits; B-038 write service is next. | Agent |
| 0.54 | 2026-10-11 | **B-038 Payment Methods audited maintenance service implemented.** Added tenant-scoped, expected-version create/change and non-destructive retire with required actor/reason, same-key advisory transaction locks, optimistic concurrency, no-op silence, and before/after change history (retire is a `CHANGE` to `isActive`, using only supported change types). Added DB-backed lifecycle, stale-version, audit, no-op, soft-retire, and cross-tenant key-reuse tests; not run because isolated dev DB credentials are unavailable. Typecheck, browser harness (65/65), IP lint (179 files), and diff check pass. No action, UI, seed, payment execution, Supplier/Customer integration, migration, or DB access. §26.54 records limits; protected configuration UI is separate. | Agent |
| 0.55 | 2026-10-11 | **B-036–B-038 isolated PostgreSQL acceptance passed.** Initialized a fresh disposable local PostgreSQL 17.11 cluster; applied all 28 migrations and seeded only shared reference fixtures. Focused schema/RLS and Payment Methods service tests passed 11/11 (3 schema + 8 read/write service); application role check passed. Test tenants were cleaned (zero remained), and the server plus temporary data directory were removed. The pre-existing local cluster and owner/production databases were not accessed. No package, schema, or migration file changed. §26.55 records setup/results; protected configuration UI and Supplier integration remain separate. | Agent |
| 1.40 | 2026-10-12 | **Split the canonical project log into linked files capped at 400,000 bytes.** Preserved content and continuous section numbering: `CAIRN.md` contains §0–§26.44 and links to `CAIRN-2.md` for §26.45–§30. Updated the single-source-of-truth and repository references; no application code, decisions or scope changed. | Agent |
| 1.39 | 2026-10-12 | **B-124 implements the capability-gated SCR-014 Plant definition UI only.** `/config/plants` now supports authorized create/change through B-121's protected action, with the approved required/optional field contract, country choices loaded only for the define capability, audit-count change token, optional inert Factory Calendar key, and both Cairn-specific descriptive flags (including both false). Company Code assignment, active editing, default-storage editing, Factory Calendar master/use, and operational gates remain out of scope. UI contract 3/3, browser harness 125/125, typecheck, IP lint (288 files), and diff check pass. No database, migration/seed, production build, live-browser acceptance, remote DB, commit or push. §26.141 records scope; B-125 is the separate browser-acceptance task. | Agent |
| 1.38 | 2026-10-12 | **B-123 passes disposable PostgreSQL 17 acceptance for B-121 Plant create/change.** Fresh identity-verified PostgreSQL 17.11 `cairn_b123`, explicit 127.0.0.1:55520, system identifier recorded, empty schema and absent migration ledger verified before setup. Applied the 43 already-approved migrations and global/reference seeds only; no new migration. Targeted Plant service suite 5/5 covers create/defaults/audit/activity, change allowlist and preservation, both descriptive flags false, inert Factory Calendar, no-op/stale version and tenant isolation. `cairn_app` remained NOSUPERUSER/NOBYPASSRLS; test tenants/Plants/history/items/activity rows zero after tests. Cluster/data, temporary credentials/config, 11 temporary PostgreSQL packages and `node_modules` removed. Typecheck, browser harness 122/122, IP lint (286 files) and diff check pass. No full DB suite, new UI/live-browser acceptance, remote DB, commit or push. §26.140 records scope. | Agent |
| 1.37 | 2026-10-12 | **B-121 implements the protected Plant definition create/change service/action.** Exact registered `CFG.ORG.PLANT.DEFINE` capability, session-derived tenant/actor, strict definition-only allowlist, global country reference validation, inert Factory Calendar key, descriptive role flags, field-level change audit, audit-count optimistic version and activity completion. Create leaves Company Code/default storage location unset; change preserves those assignments and legacy address. New contract tests 14/14; browser harness 122/122, typecheck, IP lint (285 files), diff check pass. No UI, DB setup, migration/seed execution, DB acceptance, browser acceptance, remote DB, commit or push. B-123 is the separate verified-disposable-PostgreSQL-17 acceptance gate (§26.139). | Agent |
| 1.36 | 2026-10-12 | **B-122 clarifies the Cairn-specific Plant role flags.** D-089 keeps `isProductionSite` and `isStorageSite` as descriptive metadata (not SAP-standard fields or operational gates), preserves true defaults, allows both false, and retains the badges plus future form inputs. Schema comments now state the limited purpose. Documentation/comment only; no structural schema, migration, database, action, or UI behavior changed; only a schema comment was clarified. `git diff --check` passes. No remote DB, commit or push. §26.138 records the decision. | Agent |
| 1.35 | 2026-10-12 | **B-120 resolves the remaining SCR-014 field-status, Plant-role and lifecycle rules before implementation.** D-088 records required Plant code/name/country, optional structured-address fields, optional inert Factory Calendar, `EN` language default, both Cairn site-role flags permitted false, and create/change support. SAP Learning confirms the Plant/address/language/country/region/calendar field model but not universal address-field requiredness or a matching two-boolean role rule; owner-selected Cairn rules are recorded without claiming exact SAP status parity. Documentation only; no source, schema, migration, database or UI changes. `git diff --check` passes. No remote DB, commit or push. §26.137 records the evidence and B-121 scope. | Agent |
| 1.34 | 2026-10-12 | **B-119 delivers the approved SCR-014 Plant logistics/address schema.** D-087 records Plant code/name, optional non-operational Factory Calendar code, structured address, country and language; Company Code remains separate, defaults are retained, and default storage location remains unset. Migration 0020 adds only nullable logistics columns and preserves legacy address values. Fresh identity-verified disposable PostgreSQL 17.11 `cairn_b119` on 127.0.0.1:55519: applied 43 migrations and reference/global seeds; full database suite 565/565 across 69 files; final tenant/Company Code/Plant/change-document counts zero; `cairn_app` NOSUPERUSER/NOBYPASSRLS. Browser harness 108/108, typecheck, IP lint (281 files), production build and diff check pass. Disposable cluster/data, credentials/config, 11 temporary PostgreSQL packages and `node_modules` removed. No Factory Calendar master/use, Plant writer/UI, live-browser acceptance, remote DB, commit or push. §26.136 records scope. | Agent |
| 1.33 | 2026-10-12 | **B-118 implements the owner-selected Plant define/assign boundary.** D-086 records that `CFG.ORG.PLANT.DEFINE` may leave Company Code unset and `CFG.ORG.PLANT.ASSIGN_COMPANY` links it separately. Migration 0019 makes `plant.company_code` nullable and enforces tenant-local references for non-null values; material, delivery and purchasing consumers fail closed; the Plant list shows “Not assigned.” Standard onboarding assignment and unapproved candidate fields/defaults are preserved. Fresh identity-verified disposable PostgreSQL 17.11 `cairn_b118` on 127.0.0.1:55518: applied 42 migrations and reference/global seeds; full DB suite 562/562 across 68 files; final test tenant/company/plant/change-document counts zero; disposable data/packages removed. Browser harness 106/106, typecheck, IP lint (279 files), production build and diff check pass. No remote DB, live-browser acceptance, commit or push. §26.135 records scope. | Agent |
| 1.32 | 2026-10-12 | **B-117 starts the next screen, SCR-014 Plant define, with a draft page spec only.** Candidate fields and existing defaults are recorded for owner review, not approved. The spec flags that `CFG.ORG.PLANT.DEFINE` and `CFG.ORG.PLANT.ASSIGN_COMPANY` are separate activities while the current Plant schema requires `company_code`; owner decision is required before code or schema work. No source, database, migration, seed, or browser changes. `git diff --check` passes; no remote DB, commit or push. §26.134 records the open decision. | Agent |
| 1.31 | 2026-10-12 | **B-116 reconciles the stale SCR-012 inventory status.** The Company Code definition screen now records built status and the automated UI contract plus B-110 cookie-backed browser acceptance; owner walkthrough/sign-off remains pending under §24.1. Documentation only; no source, schema, database, migration, seed, browser behavior or acceptance rerun. `git diff --check` passed; no remote DB, commit or push. §26.133 records scope. | Agent |
| 1.30 | 2026-10-12 | **B-115 passes SCR-013 cookie-backed browser acceptance.** Only the independently guarded `company-code-coa-assignment` target ran on freshly verified disposable PostgreSQL 17.11 `cairn_b115` at 127.0.0.1:55498. Definition-only, assignment-only and Auditor sessions verified capability separation, tenant-local active choices/inactive exclusion, initial audited assignment, unchanged NULL FYV/PPV, forged tenant/actor/assignment-field resistance, read-only access and refreshed no-replacement UI. The 41 migrations and reference/global seeds were test prerequisites only; no migration/seed acceptance or B-113 service-suite rerun is claimed. Zero T985 tenant, code, chart, user, role, activity and change-history rows verified; app, cluster, browser cache/dependencies, temporary packages/files and build output removed. Browser harness 104/104, typecheck, IP lint (276 files), diff check pass. The standalone browser bundle used a temporary `ignoreBuildErrors` override after typecheck passed, so this is not a normal typed Next build. No remote DB, commit or push. §26.132 records scope. | Agent |
| 1.29 | 2026-10-12 | **B-114 adds the capability-gated SCR-013 CoA-assignment UI only.** The assignment capability is distinct from Company Code definition; active tenant-local chart choices are fetched only for authorized users with unassigned codes. Each form submits only Company Code and CoA; no replacement control is shown for assigned rows. Added explicit read-only/no-choice states and English messages. New UI contract 3/3, focused UI contracts 5/5, browser harness 102/102, typecheck, IP lint (275 files) and diff check pass. SCR-013 is built; live-browser acceptance remains pending. No DB, migration/seed, assignment execution, production build, remote DB, commit or push. §26.131 records scope; B-115 is the browser-only gate. | Agent |
| 1.28 | 2026-10-12 | **B-113 passes disposable-local PostgreSQL service acceptance for initial CoA assignment.** Verified fresh PG17.11 `cairn_b113` on 127.0.0.1:55497 before setup; applied 41 existing migrations plus reference/global seeds solely for the fixture, not as migration acceptance. Runtime `cairn_app` is NOSUPERUSER/NOBYPASSRLS. Four database tests pass: audited initial assignment preserving FYV/PPV NULLs, SCR-013 completion, same-value idempotency, overwrite refusal, missing/inactive/cross-tenant chart denial and both prerequisite gates. Final test tenant/company/audit counts zero; cluster/data, postgres account, temporary config and 11 packages removed. Browser harness 99/99, typecheck, IP lint (273), diff check pass. No owner/production/remote DB, UI, live browser, commit or push. §26.130 records scope. | Agent |
| 1.27 | 2026-10-12 | **B-112 implements the protected initial CoA-assignment service/action only.** Exact `CFG.ORG.COMPANYCODE.ASSIGN_COA`, session-derived tenant/actor, strict input, completed Company Code/CoA prerequisites, active same-tenant chart, initial assignment-only semantics, idempotent same-value retry, audited security-relevant change and atomic SCR-013 completion. No different-chart overwrite; no UI. Contract 4/4, browser harness 99/99, typecheck, IP lint (272 files) and diff check pass. No database-backed acceptance or connection, migration/seed, assignment execution, schema, production build, remote DB, commit or push. §26.129 records scope; disposable-local PostgreSQL service acceptance is next. | Agent |
| 1.26 | 2026-10-12 | **B-111 registers the separate CoA-assignment capability for SCR-013 only.** Added `CFG.ORG.COMPANYCODE.ASSIGN_COA` as FND/CONFIGURE/non-posting, independent of Company Code definition; the existing SCR-013 activity and prerequisites remain unchanged, and no role-specific grant was added. Contract tests cover registration, prerequisites, and exact/`CFG.*`/`*` authorization. Focused 3/3 and browser harness 95/95 pass; typecheck, IP lint (270 files), and diff check pass. No schema/migration, service/action/UI, assignment, DB access, migration or seed execution, or production build. The initial wrong-config Vitest attempt was refused at localhost:5432 before collection; the proper DB-free harness passed. No remote DB, commit or push. §26.128 records scope. | Agent |
| 1.25 | 2026-10-12 | **B-110 passes cookie-backed Company Code definition browser acceptance.** Only `company-code-definition` (T986) ran on a freshly verified disposable PostgreSQL 17.11 database bound to 127.0.0.1:55496. The 41 migrations and shared seeds were test setup only, not migration/service acceptance. Browser verified Administrator create and form reset, forged tenant/actor/assignment fields ignored, create audit/session actor, null assignments and refreshed read list; duplicate no-overwrite; cookie-backed Auditor read-only list without form/choices. T986 rows/tenant cleaned; app, cluster/data, Chromium/browser dependencies, extracted PG package, build and temporary files removed. Typecheck, browser harness 94/94, IP lint (270 files), and diff check pass. Normal Next type-check worker was SIGKILLed; standalone output used `--no-lint` plus a temporary `ignoreBuildErrors` override after standalone typecheck passed; override restored. No remote DB, commit or push. §26.127 records scope. | Agent |
| 1.24 | 2026-10-12 | **B-109 adds the capability-gated Company Code definition form.** Authorized users receive country and active-currency choices and can submit only definition fields to the B-108 action; display-only users retain read access but no form. No assignments, tenant/actor input fields, database access, seed, migration, or live-browser acceptance. Browser harness 93/93, typecheck, IP lint (270 files), production build, and diff check pass. No remote DB, commit or push. §26.126 records scope. | Agent |
| 1.23 | 2026-10-12 | **B-108 adds the protected create-only Company Code definition service/action.** The strict input accepts definition fields only, validates country/active currency references, serializes duplicate attempts, refuses overwrites and inserts CoA/FYV/PPV as null. The server action checks the exact capability and derives tenant/actor from the verified session. Audit history and workbench completion are recorded in the transaction. Fresh disposable local PostgreSQL 17.11: 41 migrations and reference/catalog seeds; seven DB suites 118/118; zero test tenants/Company Code rows and temporary cluster/packages removed. Browser harness 91/91, typecheck, IP lint (268 files), production build and diff check pass. No remote DB, form/UI, live-browser acceptance, commit or push. §26.125 records scope. | Agent |
| 1.22 | 2026-10-12 | **B-107 makes Company Code definition precede its three separate assignments.** Migration 0018 allows null CoA/FYV/PPV fields; migration 9021 retains tenant-local reference checks for every non-null assignment. Detail, partner choices, number-range readiness, period-status and posting paths handle incomplete codes explicitly. Fresh disposable local PostgreSQL 17.11: 41 migrations and reference/catalog seeds; six DB suites 115/115; final zero tenants/Company Code rows and temporary cluster/packages removed. Browser harness 87/87, typecheck, IP lint (264 files), production build and diff check pass. No remote DB, definition action, assignment UI, commit or push. §26.124 records scope. | Agent |
| 1.21 | 2026-10-12 | **B-106 publishes the pending B-098–B-105 batch to `main` on explicit owner instruction.** Commit `8eac55f4cf51d3260be259859bbe38464264c124` was fast-forward pushed from `f3119c6d2966beb5da44f17d028bb104dba00fb5` to `deepakpt2/cairn-erp:main`; 19 source/schema/test/document paths included. `.env.local` was excluded; the authorized token was supplied through temporary askpass and not logged or stored in the remote URL. No database access or migration/seed. §26.123 records scope. | Agent |
| 1.20 | 2026-10-12 | **B-105 begins Enterprise Structure at SCR-012 by registering the Company Code define capability only.** Added `CFG.ORG.COMPANYCODE.DEFINE` as module FND, CONFIGURE, non-posting; a no-DB contract test ensures no tenant-role grants and preserves wildcard semantics. No server action, UI, schema, migration, seed execution or database access. Browser harness 83/83, typecheck, IP lint (258 files), and diff check pass. No remote DB, commit or push. §26.122 records scope. | Agent |
| 1.19 | 2026-10-12 | **B-104 passes Supplier Payment Methods browser-only acceptance on disposable local PostgreSQL.** Verified local identity before B-104 setup applied the existing 39 migrations and two shared seeds; this batch did not rerun migration/service acceptance. The `supplier-company` target alone passed in headless Chromium v1248 against the optimized standalone Next build with no browser errors, covering filtering, ten-selection cap, persistence, authority boundaries, stale-choice removal and explicit clear. Synthetic definitions used audited service fixtures; Supplier selection and `B1` retirement were exercised in the UI. The runner left zero tenants, partners, Supplier company rows, Payment Method rows or partner-bank rows. App, cluster/data/logs, temporary PostgreSQL packages and Chromium binaries removed; apt autoremove removed 29 no-longer-needed runtime packages while shared system dependencies were retained. `npm run build`, browser harness 81/81, typecheck, IP lint (257 files) and diff check pass. No remote DB, commit or push. §26.121 records scope. | Agent |
| 1.18 | 2026-10-12 | **B-103 passes disposable migration/service acceptance for Supplier Payment Methods.** Fresh local PostgreSQL 17.11 bound only to 127.0.0.1; identity verified before migration/seed. Applied all 39 migrations (including 0017) and the two shared seeds; `tests/supplier-companies.test.ts` passes 25/25. Final counts: zero tenants, partners, Supplier company rows, Payment Method rows or partner-bank rows. Cluster/data/packages removed. No remote DB or live browser target; the latter remains separate. §26.120 records scope. No commit or push. | Agent |
| 1.17 | 2026-10-12 | **B-102 prepares the Supplier Payment Methods live-browser target.** The supplier-company target now covers empty/no-choice state, same-country OUTGOING/BOTH filtering, an 11th-choice disable after ten selections, persistence, authorized display-only, stale-choice removal and explicit clear. Added a no-DB target-contract test. Browser harness 81/81 and typecheck pass; IP lint and diff check pass. Live target was not run because no local disposable DB URL/service was available; migration 0017 remains unapplied and no database was accessed. §26.119 records the blocked gate. No commit or push. | Agent |
| 1.16 | 2026-10-12 | **B-101 adds the capability-gated Supplier Payment Methods selector.** The existing maintain capability controls the checkbox editor; display-only users retain saved-value access. Eligible methods are wired from the tenant/country-scoped choices, empty selection submits an explicit clear, and stale saved choices can be removed. The other three company defaults remain disabled. Browser harness 78/78, typecheck, IP lint (256 files), and diff check pass. DB tests and live browser acceptance remain separate; migration 0017 unapplied and no database accessed. §26.118 records scope. No commit or push. | Agent |
| 1.15 | 2026-10-12 | **B-100 wires the Supplier Payment Methods action and eligible-choice service.** The existing maintain action conditionally passes the new field while tenant/actor remain session-derived; the choice query returns only active same-country `OUTGOING`/`BOTH` methods with explicit tenant filters. No UI control or new capability yet. Browser harness 76/76, typecheck, IP lint (255 files), and diff check pass. DB choice test not run; no migration or database access. §26.117 records scope; selector UI and browser acceptance remain. No commit or push. | Agent |
| 1.14 | 2026-10-12 | **B-099 adds country/direction-aware Supplier Payment Methods save-service validation.** Canonicalizes code sets; validates all selected methods against the same tenant and company country, requiring active `OUTGOING`/`BOTH`, and locks definition rows during save. Explicit blank clears, omission preserves, and changes are security-relevant/versioned. Added pure tests plus DB service cases; the latter were not run without a verified disposable DB. Browser harness 74/74, typecheck, IP lint (254 files), and diff check pass. No action/UI, migration application, database access, commit or push. §26.116 records boundary; action/UI are next. | Agent |
| 1.13 | 2026-10-12 | **B-098 adds nullable Supplier company-code Payment Methods storage only.** Added the schema field, additive migration `0017`, a static schema contract, and registered it in the database-free browser-harness suite. No validation/service/action/UI or database migration was applied. Browser harness: 68/68; typecheck, IP lint (253 files), and diff check pass. Default Vitest global setup attempted `127.0.0.1:5432` and was refused before collection; no database was reached. §26.115 records limits; next is country/direction-aware save validation. No commit or push. | Agent |
| 1.12 | 2026-10-12 | **B-097 records the owner's reported pass for the B-023/B-024 walkthroughs.** Updated acceptance status based on the owner's confirmation that both walkthroughs were complete and all checks passed. Per-step evidence and test-environment details were not supplied; no independent verification, app/host/database access, deployment, commit, or push occurred in this documentation-only update. §26.114 records the scope and distinction. | Agent |
| 1.11 | 2026-10-12 | **B-096 publishes the complete pending B-080–B-095 partner-bank batch on explicit owner instruction.** All 45 paths committed as `3035c9b` and fast-forward pushed from `057e19c` to `deepakpt2/cairn-erp:main` as the repository user. The ignored `.env.local` PAT was supplied only through a temporary askpass helper; it was not committed, stored in the remote URL/config, or logged. `.env.local` is not in the commit; no database changed and no real bank values were included. §26.113 records scope. | Agent |
| 1.10 | 2026-10-12 | **B-095 passes real-browser fail-closed acceptance for stale and missing profile rows.** Fresh loopback PostgreSQL 17.11; all 38 migrations and both shared seeds passed. A disposable T095 exact-capability fixture made KW stale (D-061 vs current D-062) and removed JP's registry row. Chromium confirmed neither fail-closed row had an activation form, while current IN/GB/US `NOT_READY` rows retained controls with expected revision/version. No action submitted; zero activation audits, partners or bank rows; no browser errors or Save/Reveal controls. Production app, DB, fixture, PostgreSQL/browser dependencies and build removed. No remote/persistent DB, bank values, commit or push. §26.112 records scope. | Agent |
| 1.09 | 2026-10-12 | **B-094 passes cookie-backed browser acceptance for the capability-gated profile page/action.** Fresh PostgreSQL 17.11 loopback cluster; all 38 SQL migrations and both shared seeds passed. No role grant existed before temporary T094 fixtures. Chromium verified anonymous sign-in redirect, display-only route/action denial, exact-capability access and Administrator `*`; KW and GB transitioned only `NOT_READY` v1→`READY` v2. Forged actor/evidence/status/reason fields were ignored; exactly two activation-audit rows held session-derived actors and fixed evidence. No browser errors, partner/bank rows, or reveal/save controls. App, DB, fixtures, browser binaries/dependencies and build removed; no remote/persistent DB, bank values, commit or push. §26.111 records scope. | Agent |
| 1.08 | 2026-10-12 | **B-093 adds the capability-gated global partner-bank profile UI.** New `/foundation/partners/bank-profiles` route and Partners navigation link require `CFG.FND.PARTNER.BANKPROFILE.ACTIVATE`. Read-only view shows current policy, registry revision, readiness and version for the five approved profiles; missing/stale/invalid states fail closed. Only current `NOT_READY` rows get a one-way form with expected revision/version; fixed evidence and session-derived actor remain server-only. No bank-row save/reveal or role-capability grant. 59 focused profile/activation/UI/bank-display tests pass; typecheck, IP lint (251 files), diff check pass. No DB run or browser acceptance; no persistent state, commit or push. §26.110 records limits. | Agent |
| 1.07 | 2026-10-12 | **B-092 passes disposable PostgreSQL acceptance for the audited activation path.** On a fresh PG 17.11 Unix-socket-only cluster, all 38 lexical migrations and reference/global seeds applied. Verified five NOT_READY profiles, non-posting activation capability with no role grant, NOSUPERUSER/NOBYPASSRLS app role, exact function EXECUTE grant and denied direct profile/audit-table access. The real service/DB call activated synthetic KW and recorded matching audit; concurrent GB calls yielded one activation/event; stale/malformed requests denied; duplicate audit ID raised 23505 and rolled back the status change. Final disposable data: zero tenants, partners, bank rows; two activation events. Cluster, package and test script removed. No remote/persistent DB, bank identifiers, commit or push. §26.109 records scope; UI remains separate. | Agent |
| 1.06 | 2026-10-12 | **B-091 adds the capability-checked partner-bank profile activation service and server action.** Requires `CFG.FND.PARTNER.BANKPROFILE.ACTIVATE`, derives actor tenant/user only from the verified session, validates country/revision/version, fixes evidence server-side, and calls the atomic function inside tenant scope. Migration `9020` grants only exact-function EXECUTE to `cairn_app`; no role-capability grants or table DML. Eight service tests plus two action/grant contract tests and 38 previous focused tests pass (48/48 total); typecheck, IP lint (245 files), and diff check pass. No DB migration/seed applied, UI wired, profile changed, bank saved/revealed, commit or push. §26.108 records the boundary. | Agent |
| 1.05 | 2026-10-12 | **B-090 adds a private atomic activation database function.** It locks the global profile row, checks policy revision/status/expected version, changes only `NOT_READY`→`READY` with version +1, then inserts the fixed-field audit event in the same transaction. SECURITY DEFINER search path is locked to `pg_catalog`; `PUBLIC` and app EXECUTE are revoked, with no runtime grant. Three static function-contract tests plus profile/readiness/activation suites pass (38/38); typecheck, IP lint (240 files), and diff check pass. SQL not applied or live-tested; no capability service/action or profile change. §26.107 records the limits. No commit or push. | Agent |
| 1.04 | 2026-10-11 | **B-089 adds the global partner-bank profile activation audit schema.** Fixed-field table records actor tenant/user IDs, country, policy revision, one-way status transition, versions, fixed evidence and event timestamp; constraints reject free-text and inconsistent transitions. Migration `0016` creates the table; `9018` revokes all direct `PUBLIC`/app access. Three schema-contract tests plus profile/readiness/activation suites pass (35/35); typecheck, IP lint (238 files), and diff check pass. SQL not applied; no activation writer or profile mutation. No commit or push. §26.106 records the boundary. | Agent |
| 1.03 | 2026-10-11 | **B-088 adds a pure profile-activation command validator.** Requires an approved country, exact current D-062–D-066 policy revision, positive PostgreSQL integer version, and fixed `PROFILE_VALIDATION_ACCEPTED` evidence. Rejects unknown/free-text fields and fixes target status to `READY`; no session authorization, database mutation or audit writer. Eleven focused command tests plus resolver/schema/capability suites pass (32/32); typecheck, IP lint (234 files), diff check pass. No DB, seed, activation action, UI, bank data, commit or push. §26.105 records limits. | Agent |
| 1.02 | 2026-10-11 | **B-087 registers the profile-activation capability and fixed evidence code.** Added `CFG.FND.PARTNER.BANKPROFILE.ACTIVATE` to the global capability catalogue as non-posting Foundation configuration, without role grants; existing Administrator `*` semantics remain. Added fixed evidence `PROFILE_VALIDATION_ACCEPTED`. Two focused tests; combined profile suites pass 21/21, typecheck, IP lint (233 files), and diff check pass. No activation action, audit table, role grants, DB seed/run, UI, commit or push. §26.104 records the boundary. | Agent |
| 1.01 | 2026-10-11 | **B-086 passes disposable PostgreSQL acceptance for the global profile registry and readiness service.** Applied all 34 lexical migrations to fresh PostgreSQL 17.11, seeded five NOT_READY profiles, verified app-role SELECT-only privileges and denied UPDATE, then tested the B-085 service's not-ready → synthetic ready → same-revision preserve → stale-revision reset lifecycle. The profile table had no tenant/bank rows; final counts were zero tenants/partners/bank rows. Server, cluster, extracted package and test script removed; no remote/owner/production DB or real bank data. No activation, bank save/reveal, commit or push. §26.103 records results. | Agent |
| 1.00 | 2026-10-11 | **B-085 adds a read-only global bank-profile readiness service.** The runtime checks its app role and reads only the country’s policy revision/status; only an explicitly `READY` row matching the current D-062–D-066 policy revision resolves ready. Missing, stale, non-ready, missing-country and unsupported inputs fail closed; DB errors propagate. Six service tests plus the profile resolver/schema suites pass (19/19); typecheck, IP lint (231 files), and diff check pass. SQL was not applied at B-085 completion; B-086 later accepted migration/seed and runtime behavior. No activation, bank save/reveal, UI, commit or push. §26.102 records the boundary. | Agent |
| 0.99 | 2026-10-11 | **B-084 adds the global profile-readiness registry schema and seed.** Shared country-keyed table ties readiness to owner-approved policy revisions; the app role receives SELECT only. The reference seed defines IN/KW/GB/US/JP as initial `NOT_READY` rows, preserves status for the same revision, and resets to `NOT_READY` if policy revision changes. Twelve focused schema/readiness tests, typecheck, IP lint (229 files), and diff check pass. SQL migration/seed were not executed at B-084 completion; B-085 later adds the read-only reader and B-086 passes the disposable PostgreSQL acceptance. No bank save/reveal, commit, or push. §26.101/103 record the boundaries. | Agent |
| 0.98 | 2026-10-11 | **B-083 adds the initial pure deny-only bank-profile readiness boundary.** At B-083 completion, the D-061 authoring set (`IN`, `KW`, `GB`, `US`, `JP`) returned not-ready until persisted configuration existed; missing and unsupported countries failed closed. Tests proved validator success did not imply readiness. Eight focused no-DB tests, typecheck, IP lint (225 files), and diff check passed. No profile persistence/activation, save integration, schema, database, browser run, bank values, commit or push. B-085 later extends the resolver and adds a read-only registry service (§26.102). | Agent |
| 0.97 | 2026-10-11 | **B-082 passes live D-074 masked-detail acceptance with synthetic data only.** Extends the `business-partners` target with a strict fixture guard requiring an explicit elevated fixture URL, loopback `cairn_test`, and owned development T992 tenant. Fresh disposable PostgreSQL 17.11 with all 32 migrations/seeds; per-run 32-byte keyring and synthetic encrypted identifier. Maintainer and display-only viewer both see the fixed list mask and `••••4321` detail suffix without plaintext/ciphertext or Save/Reveal controls. T992 tenant/partner/bank row cleanup confirmed; app server stopped, cluster and extracted package removed, and keyring deleted. Target, typecheck, browser harness (66/66), IP lint (223 files), and diff check pass. No owner/production data, real bank data, schema change, commit or push. §26.99 records scope. | Agent |
| 0.96 | 2026-10-11 | **B-081 integrates the D-074 read-only bank detail view.** Metadata rows link to a selected record; the server loads the deployment keyring on demand and calls the scoped mask reader, while the panel receives only the D-074 safe DTO. Keyring/crypto failures show a generic unavailable state. Four focused no-DB suites pass 14/14; typecheck, production build, browser harness (66/66), IP lint (223 files) and diff check pass. No save, full-value reveal, key provisioning, database/live-browser acceptance, real data, commit or push. §26.98 records scope. | Agent |
| 0.95 | 2026-10-11 | **B-080 implements the scoped D-074 bank-detail mask reader, not yet UI-integrated.** Requires actual `FND.PARTNER.DISPLAY`; scopes the read by authenticated tenant, selected partner and UUIDv4 row ID; uses the matched row's identifiers for crypto context; returns only the D-074 suffix mask. Six synthetic focused tests, typecheck, browser harness (66/66) and diff check pass. No route/UI, save, full-value reveal, database, or real bank data. No commit or push; §25.4 full-system publish trigger remains. §26.97 records scope. | Agent |
| 0.94 | 2026-10-11 | **Owner-directed one-time publication of the bank-data batch to `main`.** Owner explicitly authorized an exception to the full-system publish gate for this batch only; future no-partial-push restriction remains. Committed 47 source/test/migration/doc paths as `9a39286 feat: add partner bank-data foundations and read-only view` and fast-forward pushed from `39e3d35` to `origin/main`. PAT from ignored `.env.local` used only for authentication through temporary askpass; no credential in source, commit, remote URL/config, or logs; staged-file secret check passed. §26.96 records scope. | Agent |
| 0.93 | 2026-10-11 | **B-078 reviews the Drizzle metadata gap and passes B-077's live browser target on a disposable PostgreSQL 17.11 database.** Confirms the custom runner ignores metadata and applies 32 lexical SQL migrations; Drizzle Kit metadata reconciliation remains separate. The T992 Business Partner target passes maintainer and display-only Bank Details checks; cleanup verified, private Unix socket only, TCP disabled, temporary cluster/app removed. Smoke onboarding uses only an ephemeral per-run value if its owner field is rendered; the synthetic viewer has `FND.PARTNER.DISPLAY` without maintain. Typecheck, browser-harness (66/66), and diff check pass. No bank records/values, persistent/owner/production DB, `.env.local` content access/change, commit or push. §26.95 records results. | Agent |
| 0.92 | 2026-10-11 | **B-077 extends Business Partner browser target coverage for the bank metadata tab.** The T992 target asserts the empty state and absence of save/reveal controls for maintainer and display-only users. Typecheck and browser-harness (66/66) pass; selection list confirms the target. Live browser/database acceptance was not run; no DB, bank rows or real identifiers touched. §26.94 records limits; no commit or push. | Agent |
| 0.91 | 2026-10-11 | **B-076 integrates a display-only Bank Details tab for Business Partners.** It loads B-075 metadata only on explicit selection and renders only allowlisted fields plus D-074's fixed `••••` list mask; no account identifiers, ciphertext, edit or reveal. Two panel and two route tests, typecheck, production build and diff check pass. No live database/browser acceptance, real bank data, commit or push; §26.93 records scope. | Agent |
| 0.90 | 2026-10-11 | **B-075 adds a display-authorized, read-only partner-bank metadata list.** The query is scoped by session tenant and selected partner, includes inactive records, returns only database row IDs and allowlisted non-ciphertext metadata, and uses deterministic order. Four new cases; focused suite 8/8 and typecheck pass. No DB access, persisted bank data, real identifiers, decryption, writes, reveal, or UI; §26.92 documents the boundary. No commit or push. | Agent |
| 0.89 | 2026-10-11 | **B-074 adds a display-authorized, read-only partner-bank metadata lookup.** Requires `FND.PARTNER.DISPLAY`, derives tenant from the authenticated session, and binds tenant + partner + UUIDv4 bank-row ID; returns allowlisted non-ciphertext metadata and the matched row's ID. Four focused tests and typecheck pass. No DB access, writes, decryption, reveal path or UI; §26.91 records the scope. No commit or push. | Agent |
| 0.88 | 2026-10-11 | **B-073 accepts partner-bank migrations and RLS on a fresh disposable PostgreSQL 17.11 cluster.** All migrations applied; live tests verified constraints including the 5,540-character envelope boundary, forced RLS, app-role SELECT-only privileges, tenant isolation, partner-delete block, and D-041 tenant cascade. The first run found PostgreSQL's regex repetition-count limit; additive migration `0014_partner_bank_envelope_bound.sql` corrected it without editing `0013`. The temporary cluster and synthetic fixtures were removed. Five static schema-contract tests, typecheck and diff check pass. No owner/production data, write service or reveal path; §26.90 records limits. No commit or push. | Agent |
| 0.87 | 2026-10-11 | **B-072 adds a ciphertext-only partner-bank table schema with forced tenant RLS and read-only app access.** The typed schema and additive migrations enforce UUIDv4/date/version/envelope-shape checks, retain client tenant cascade, and block direct partner deletion while rows exist. Four typed-schema/static-contract tests and typecheck pass; no migration application, persistent database or bank rows at B-072 completion. No write service, save path, UI or reveal path. §26.89 records the boundary. No commit or push. | Agent |
| 0.86 | 2026-10-11 | **B-071 adds a pure fail-closed dispatcher for the implemented KW/IN/GB/US/JP partner-bank validators.** Three dispatcher tests plus all five profile suites pass (26 total); typecheck and diff check pass. Missing/unsupported countries fail closed. The dispatcher is not connected to a save path or storage; no schema, database, or bank values. §26.88 records the boundary. No commit or push. | Agent |
| 0.85 | 2026-10-11 | **B-070 adds active-key-only verification for supplied ciphertext batches.** The verifier requires a one-key active keyring, checks key IDs and authenticates each non-null envelope/context, returning counts only. Two new tests; 24 focused ID/reveal/encryption tests pass; typecheck and diff check pass. It does not prove DB scan completeness or global key retirement; no database or bank data. D-085 / §26.87 document the limit. No commit or push. | Agent |
| 0.84 | 2026-10-11 | **B-069 adds a pure batch re-encryption transformer for supplied encrypted bank fields.** It authenticates each field context, re-encrypts old-key envelopes under the active key, preserves current envelopes and nulls, and returns ciphertext only; no DB read/write or key-retirement claim. Three new tests; 22 focused ID/reveal/encryption tests pass; typecheck and diff check pass. No actual bank data, schema, database scan, persistence or reveal path. D-084 / §26.86 document the boundary. No commit or push. | Agent |
| 0.83 | 2026-10-11 | **B-068 enforces the UUIDv4 bank-record ID policy at the encryption/decryption context boundary.** `BankDataContext.bankRecordId` uses the `BankRecordId` brand and receives runtime UUIDv4 validation before GCM AAD construction. Nineteen focused encryption/ID/audit tests pass; typecheck and diff check pass. This checks shape only; tenant/partner/ID-scoped lookup remains mandatory before any reveal path. No schema, persistence, database or bank data. D-083 / §26.85 document the boundary. No commit or push. | Agent |
| 0.82 | 2026-10-11 | **B-067 establishes server-generated UUIDv4 bank-record IDs and applies canonical-shape validation at the B-060 audit boundary.** Invalid/sequential IDs are denied and omitted from the audit object key; three ID helper tests plus eight reveal-boundary tests pass. Typecheck and diff check pass. UUID shape is not provenance: tenant/partner/ID-scoped row lookup remains mandatory before any reveal path. No bank table, row persistence, database, bank values, or reveal route. D-082 / §26.84 document the contract. No commit or push. | Agent |
| 0.81 | 2026-10-11 | **B-066 enforces `FND.PARTNER.DISPLAY` in the partner list/detail route before any partner-data reads.** Missing authority gets a fixed denial message before route parameters are awaited; existing maintenance actions remain independently gated by `FND.PARTNER.MAINTAIN`. One isolated route-guard regression test passes; typecheck and diff check pass. No bank data, reveal path, decryption or database use. D-081 / §26.83 document the authorization check; bank-record-ID opacity still blocks future reveal execution. No commit or push. | Agent |
| 0.80 | 2026-10-11 | **B-065 implements the remaining pure GB, US and JP bank-profile validators together.** GB enforces its 22-character IBAN structure/MOD-97 and derives the bank code; US validates ABA routing range/check digit with an opaque local account; JP requires the seven-digit institution/branch code with an opaque local account. Fourteen isolated synthetic-data tests pass; typecheck and diff check pass. No activation, persistence, schema, database, bank data, lookup, save path or UI. D-078–D-080 / §26.82 document the boundaries. No commit or push. | Agent |
| 0.79 | 2026-10-11 | **B-064 implements the pure India (`IN`) bank-profile validator only.** It requires holder/country, a local account number preserved exactly, and IFSC normalized/validated in `bankCode`; rejects a non-empty IBAN and syntax-checks optional BIC only. Five isolated synthetic-data tests pass; typecheck and diff check pass. No country-wide account-number rules, lookup, profile activation, persistence, schema, bank data, database, save path or UI. D-077 / §26.81 document the boundary. No commit or push. | Agent |
| 0.78 | 2026-10-11 | **B-063 implements the pure Kuwait (`KW`) bank-profile validator only.** It requires account holder and KW country; normalizes uppercase and ASCII spaces, validates the 30-character KW IBAN structure and MOD-97, rejects a separate non-empty local account number, derives bank code from IBAN positions 5–8 (and checks any supplied code), and syntax-checks optional BIC without external lookup. Four synthetic-data tests pass; typecheck and diff check pass. No profile registry/activation, persistence, schema, bank storage/data, database or UI. D-076 / §26.80 document the contract; B-064 India profile is next. No commit or push. | Agent |
| 0.77 | 2026-10-11 | **B-062 implemented a pure normal-view bank-identifier projection.** It reuses the B-057 strict bank-field allowlist, applies D-074 list/detail masks, fully masks values up to four characters, drops ciphertext and unknown/nested fields, and preserves safe metadata. Three new tests; focused B-057/B-060/B-062 privacy suites pass 15/15; typecheck and diff check pass. No bank schema, storage, data, database, decryption, route or UI. D-075 / §26.79 document the boundary; helper is not integrated into a view. B-063 Kuwait profile validator is next; no commit or push. | Agent |
| 0.76 | 2026-10-11 | **B-061 specified normal-view masking only.** Owner selected fixed `••••` in list/summary views and `••••` plus the final four characters in detail views for IBAN/local account identifiers; identifiers four or fewer characters remain fully masked, no original length or country prefix is shown, and history remains fully masked. D-074 / §26.78 record the rule. No code, UI, data or database changes; no tests applicable. B-062 pure projection is next; no commit or push. | Agent |
| 0.75 | 2026-10-11 | **B-060 added the session-bound bank-reveal authorization/audit writer boundary only.** The helper requires partner display plus reveal capability, validates IBAN/local-account fields and controlled purpose codes, takes actor/tenant from the verified session, and logs safe gate events plus terminal success/denial metadata without plaintext. Added capability catalogue seed entries but no role grants, route or UI; seed not run. Seven isolated fake-Tx tests pass; typecheck/diff check pass; no database, bank record or decryption. D-073 / §26.77 document that `AUTHORIZED` is not a completed reveal and terminal result must commit before plaintext return. B-061 normal-view mask format decision is next; no commit or push. | Agent |
| 0.74 | 2026-10-11 | **B-059 blocks direct runtime mutation of `audit_access_log`.** New immutable migration `9015_audit_access_log_append_only.sql` revokes UPDATE/DELETE/TRUNCATE from `cairn_app`, preserving SELECT/INSERT. The owner retained the existing whole-tenant `client` → log `ON DELETE CASCADE` as a lifecycle/retention exception (D-072). Added a development-tenant integration test for privileges, allowed writes and cascade cleanup; not run because no confirmed disposable DB was available. Typecheck and diff check pass; no database or owner/production data accessed. No reveal action, capability registration, bank data, commit or push. B-060 reveal authorization/audit writer boundary is next. | Agent |
| 0.73 | 2026-10-11 | **B-058 specified the separate bank-identifier reveal authorization and audit contract only.** Owner selected `SEC.PARTNER.BANK.REVEAL` plus `FND.PARTNER.DISPLAY`, normal wildcard matching (so Administrator `*` grants it), selected IBAN/local-account fields only, and required controlled purposes `PARTNER_SUPPORT`, `DATA_CORRECTION`, `AUDIT_REVIEW`, `LEGAL_REGULATORY`. Every authenticated attempt is audited; success must be committed before returning plaintext, and audit failure denies the reveal. Existing `audit_access_log` must be hardened against runtime UPDATE/DELETE before reveal implementation. D-071 / §26.75 record denial/logging behavior; no code, capability registration, schema, migration, database or data changed. B-059 append-only audit-log protection is next; no commit or push. | Agent |
| 0.72 | 2026-10-11 | **B-057 privacy projection integrated at generic history write and read boundaries.** Canonical `partner_bank`/`partner_contact` histories use allowlists; full IBAN/account identifiers and named-contact email/phone are replaced with `[masked]`, unknown/nested fields and free-form reasons/labels are omitted, and old stored items are redacted again on read. Organization-level `business_partner` contacts remain unchanged. Five isolated tests pass for create/change/no-op/read-redaction/general-contact behavior; typecheck and diff check pass; no database setup, bank storage, key or real identifiers. D-070 / §26.74 record exact scope and require future writers to use canonical object-class constants and opaque record IDs. B-058 audited-reveal contract remains next; ordinary-view masking and bank-data storage remain blocked. No commit or push; full-system publish trigger remains. | Agent |
| 0.71 | 2026-10-11 | **B-056 authenticated envelope re-encryption helper only.** Added `reencryptBankData`: it authenticates/decrypts using the recorded key ID and tenant/partner/record/field AAD, re-encrypts old-key envelopes with the supplied active key and fresh nonce, and verifies then no-ops already-current ciphertext. Generic failures; no persistence, audit/history, logging, key retirement, or bulk migration. Eight encryption tests plus seven keyring tests pass (15 total); typecheck and diff check pass. No schema, database, deployment keys, bank data, reveal authority, masking/history safeguards, or storage integration. D-069 / §26.73 records behavior; B-057 history redaction is next. No commit or push; full-system publish trigger remains. | Agent |
| 0.70 | 2026-10-11 | **B-055 fail-closed deployment-secret keyring configuration only.** Added lazy `CAIRN_BANK_DATA_KEYRING_JSON` parser for strict JSON with active key ID and 1–16 canonical unpadded base64url 32-byte keys; no fallback, generated/default key, raw-value error output, or integration into bank-data callers. Compose passes the secret only to the app; templates contain comments only. Seven keyring tests and six encryption tests pass (13 total), typecheck and diff check pass; no actual deployment key, schema, database, bank record, reveal/masking/history path or country-profile activation. D-068 / §26.72 record the contract; B-056 re-encryption helper is next. No commit or push; full-system publish trigger remains. | Agent |
| 0.69 | 2026-10-11 | **B-054 implements the versioned bank-data encryption primitive only.** D-067 records the selected app-managed keyring and AES-256-GCM contract: random 96-bit nonce, 128-bit tag, key ID and tenant/partner/record/field bound as AAD, active-key encryption and retained-prior-key decryption. Six isolated unit tests, typecheck and diff check pass. No deployment-secret loader/key material, reveal authority/audit, masking/history safeguards, schema/database integration, profile activation or bank identifiers. §26.71 documents the contract and strict boundary; B-055 keyring configuration is next. No commit or push; full-system publish trigger remains. | Agent |
| 0.68 | 2026-10-11 | **B-051–B-053 verified the remaining initial bank-validation profiles together.** D-064 records GB bank-issued IBAN-only validation (`GB`, 22 characters, MOD-97; bank/sort/account components embedded). D-065 records US local account + 9-digit ABA RTN with check digit, no active-directory or payment-rail claim. D-066 records JP local account + seven-digit institution/branch composite in the existing bank-code field, with Japan Post's official transfer-format exception. Source links are recorded in §§26.68–26.70. All five D-061 profiles now have research specifications (D-062–D-066), but none is implemented or enabled; no code/schema/database/profile rows/real bank values. Encryption/reveal/masking safeguards still block identifier storage. `git diff --check` passes; no commit or push. | Agent |
| 0.67 | 2026-10-11 | **B-050 India bank-validation profile verified from authoritative sources.** RBI's NEFT FAQ specifies branch IFSC and account number; IFSC syntax is 11 characters (`^[A-Z]{4}0[A-Z0-9]{6}$`). RBI's committee report describes bank-specific account-number formats and its India IBAN design was consultation-stage; current SWIFT Registry Release 103 has no IN profile. D-063 records required local account number + IFSC, opaque account-number handling, optional BIC for this non-payment master, no directory/account-existence lookup, and account type deferred to transactions. No profile implementation/activation, code/schema/database/profile rows/real bank values. §26.67 records the source-backed rules; B-051 GB is next. `git diff --check` passes. | Agent |
| 0.66 | 2026-10-11 | **B-049 Kuwait bank-validation profile verified from authoritative sources.** CBK documents Kuwait's IBAN adoption/activation and 30-character structure, account-bank issuance, and no-space electronic form; SWIFT's current Registry Release 103 (Sep 2026) confirms `KW2!n4!a22!c`, length 30, BBAN length 26 and embedded four-letter bank identifier. D-062 specifies bank-issued IBAN only for KW; no separate local-account entry, derived bank code, optional BIC in this non-payment master. Profile not implemented/activated; no code/schema/database/profile rows/real bank values. §26.66 records source-backed rules; India profile research B-050 is next. `git diff --check` passes. | Agent |
| 0.65 | 2026-10-11 | **B-048 initial bank-validation countries selected.** Owner selected `IN`, `KW`, `GB`, `US`, and `JP`; all exist in the current 30-country shared reference seed. This sets profile-authoring scope only; no country profiles, code/schema, database rows, or bank identifiers were added. D-061 and §26.65 record the set; all countries remain blocked until their profile exists. B-049 source-backed Kuwait profile verification is next. `git diff --check` passes. | Agent |
| 0.64 | 2026-10-11 | **B-047 partner-bank validation policy approved.** Country profiles are fail-closed: account holder/country required; profile selects the required IBAN or local account and bank-code/BIC fields; bank name optional. IBAN normalization, country match, country-length and MOD-97 validation; BIC syntax only, no account-existence claim. Valid-from required, valid-to optional/inclusive, overlaps allowed, active independent, no hard deletion. No profile rows, code, schema, database, or real identifiers added. D-060 and §26.64 record policy; initial supported countries (B-048) and encryption-key/reveal infrastructure remain. `git diff --check` passes. | Agent |
| 0.63 | 2026-10-11 | **B-046 partner bank/contact v1 rules approved.** Owner selected partner-wide valid-dated bank records with the standard holder/country/bank/IBAN-or-local-account/BIC fields, encryption-at-rest, masked views/history and separate audited reveal; no company/role/default/payment/house-bank execution behavior. Contact persons are multiple partner-wide records with one primary, date validity, logged reads/changes, masked personal email/phone history and retention-controlled deletion; existing general email/phone remain organisation-level. Country-specific field requiredness/validation and key provisioning/rotation remain prerequisites. No code/schema/database/real data changes. D-059 and §26.63 record approval; B-047 validation rules are next. `git diff --check` passes. | Agent |
| 0.62 | 2026-10-11 | **B-045 Payment Methods isolated browser acceptance passed.** Ran the dedicated target on a fresh disposable PostgreSQL 17.11 database after all 28 migrations and reference/application seeds. UI onboarding, create/change/history/audit/activity, display-only, forged tenant/edit and soft-retire checks passed. Fixed retirement-success feedback lost during revalidation and adjusted the browser helper's root redirect wait. Cleanup confirmed zero T989 tenant, method, and user rows; stopped the app/database and removed the temporary cluster. Typecheck, target, browser harness (66/66), IP lint (183 files), and diff check pass. No owner/production data, schema/migration/seed behavior, partner integration, commit or push. §26.62 records results; owner walkthrough/sign-off remains pending; the full-system publish trigger remains. | Agent |
| 0.61 | 2026-10-11 | **B-044 Payment Methods dedicated browser target implemented, not yet run.** Added `npm run smoke:browser:payment-methods` with guarded disposable T989 tenant setup/cleanup and UI coverage for workbench status, create/change/soft-retire, history, display-only access, and forged tenant/edit queries. Typecheck, target-selection browser harness (66/66), IP lint (183 files), smoke target listing, and diff check pass. No live browser/database acceptance or push; B-045 will execute the target on a fresh disposable development DB. §26.61 records the scope. | Agent |
| 0.60 | 2026-10-11 | **B-043 Payment Methods soft-retire confirmation UI.** Added capability-gated retirement for active methods, using the existing session-protected, versioned soft-retire action. Requires explicit acknowledgment and reason; the inactive definition and audit trail remain. No hard delete, new action, schema, seed, or partner integration. Typecheck, production build, IP lint (183 files), browser harness (65/65), and diff check pass. No dedicated Payment Methods database/browser acceptance, commit, or push; B-044 browser acceptance remains. §26.60 records the scope. | Agent |
| 0.59 | 2026-10-11 | **B-042 Payment Methods create/change editor form.** Added capability-gated create/change controls using the existing session-protected save action, immutable method code on change, required reason and expected-version checks, plus success/error feedback. No retire controls, new server action, method data seed, or partner integration. Typecheck, production build, IP lint (182 files), browser harness (65/65), and diff check pass. No dedicated Payment Methods browser/database acceptance, commit, or push; B-043 retire UI and B-044 browser acceptance remain. §26.59 records the scope. | Agent |
| 0.58 | 2026-10-11 | **B-041 Payment Methods read-only workbench route.** Added an authenticated, tenant-scoped country/method list, detail and change-history view; registered the route with the workbench and term registry. Inactive methods remain visible. No editor, new action, seeded method data, or Supplier/Customer integration. Typecheck, IP lint (181 files), browser harness (65/65), and diff check pass. No dedicated database/browser acceptance, commit, or push; B-042 create/change UI, B-043 retire UI, and B-044 browser acceptance remain. §26.58 records the scope. | Agent |
| 0.57 | 2026-10-11 | **B-040 Payment Methods workbench activity/status lifecycle.** Registered `CFG.FIN.PAYMENTMETHOD.DEFINE`; seed adds only missing tenant `NOT_STARTED` statuses and preserves existing progress, while successful create/change/retire and valid no-op confirmations complete the activity in the same transaction. The activity and seed backfill were verified on a fresh disposable PostgreSQL 17.11 cluster; 11 Payment Method service/schema tests and 3 Payment Method action-security tests passed. Typecheck, browser harness (65/65), IP lint (180 files), and diff check pass. No UI, registry entry, payment-method data, or Supplier/Customer integration; no commit or push. §26.57 records the outcome; B-041 read-only configuration UI is next. | Agent |
| 0.56 | 2026-10-11 | **B-039 Payment Methods protected write actions and capability registration.** Added create/change and soft-retire server actions guarded by `CFG.FIN.PAYMENTMETHOD.DEFINE`; tenant and actor are session-derived, forged form values ignored, missing expected version rejected, and success invalidates the Payment Methods/workbench paths. Added the capability catalogue entry and translated success messages without adding method data or a config activity. Action-security tests passed 3/3 for authorised create+retire, capability denial and anonymous redirects on a fresh isolated PostgreSQL 17.11 database; the capability row was verified and fixtures cleaned. Typecheck, browser harness (65/65), IP lint (180 files), and diff check passed. No UI, schema/migration, payment execution, or partner integration. §26.56 records behavior; B-040 status lifecycle followed, with UI still pending. | Agent |

---

*End of document. This file is updated in the same turn as any change to code, schema, decision or
scope — a code change without a corresponding entry here is not complete (§0.1).*
