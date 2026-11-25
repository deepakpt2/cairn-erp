# Deliverable 1 — Audit of the existing dummy-data installer

**Audience:** the owner, before any refactoring starts.
**Scope:** what the existing installer covers today; how far that is from Phases 0–2 of the
Indian UAT brief; and whether its data is consistent with an Indian company code, an Indian
chart of accounts and GST.
**Repository state:** branch `development`, HEAD `aa8bc08b` (`Revalidate the dunning notice
amount…`), working tree clean except an untracked `.commandcode/`.
**Database access:** none. This audit is a source-code audit only. Nothing was connected to,
read from, or written to any database.

---

## 0. Session preflight (AGENTS.md)

| Check | Result |
|---|---|
| Root `AGENTS.md` read | YES |
| `docs/DEVELOPMENT-OPERATIONS.md` read | YES |
| `.env.local` inspected safely | **NOT PRESENT.** `.env`, `.env.test`, `.env.example`, `.env.docker.example`, `.env.development.example` exist; variable **names** inspected, no values printed. |
| Git branch and working tree checked | YES — `development`, only `?? .commandcode/` |
| GitHub authentication procedure identified | YES (§1 of the runbook: PAT via `http.extraheader`) — note the PAT variable lives in `.env.local`, which does not exist in this workspace, so a push from here is not currently possible without it |
| Test-server procedure identified | YES (§2: Pexpect, `107.173.201.115:2222`, `/home/cairn/ui-build/`) |
| Database restrictions understood | YES — `cairn_b210`, `cairn_hr_accept`, `cairn_demo` permanently prohibited; `cairn_acceptance` and `cairn_integration` persistent and out of scope |
| Intended database target | NOT APPLICABLE — read-only audit, no database operation |

No blocker for the audit itself. One blocker for later steps is stated now: **any refactored
installer must be exercised on a disposable `cairn_<topic>_<shorthand>` database** (§4 of the
runbook), never on the persistent or prohibited ones.

---

## 1. What the installer actually is

The "existing dummy-data install function" is `scripts/demo-provision.ts` plus 24 modules under
`src/platform/tenancy/demo-*.ts`. It is **not** an Indian dataset, and it was never meant to be
one: it provisions a fictional **Kuwaiti biscuit manufacturer** ("Vantage Foods", country `KW`,
currency `KWD`, time zone `Asia/Kuwait`).

Its shape is worth stating because the refactor has to keep the good half:

- **One-shot, phase-based, resumable.** 23 phases are declared in
  `src/platform/tenancy/demo-provisioning.ts:51-54` and dispatched by
  `scripts/demo-provision.ts:453-477`. Phases are appended, never reordered.
- **Ledgered.** `demo_installation` / `demo_installation_phase` record the claim, the frozen
  timeline, and each phase's status. There is deliberately **no `delete`, no reset, no force
  flag** (`docs/demo-restart-and-safety.md` §1).
- **Gated.** It runs only with `ENABLE_DUMMY_DATA` truthy, after migrations, reference data and
  the global seed, and refuses a database that already holds business data — decided by counting
  rows in every `client`-column table through `security definer` functions, never by a marker.
- **Mostly service-layer.** Most writes go through the same domain services the screens call
  (`saveCostCenter`, `createEmployee`, `postJournalEntry`, `createRequisitionForProvisioning`,
  …). A handful of rows that no service writes are inserted directly and are documented at the
  insertion point (`standard-structure.ts`, `demo-organisation.ts:369-383`).
- **Idempotent by adoption or request key.** Each phase recognises its own prior work
  (`DEMO-GR-*`, `DEMO-SAL-*`, `DEMO-PAYRUN-*`, …).

That architecture is a good base. What it is *not* is a fixture-driven, India-shaped,
parameterised installer. Those gaps are §7.

---

## 2. Coverage against Phase 0 — organisation structure

| Phase 0 requirement | Present today | Where | Verdict |
|---|---|---|---|
| Company code | `1000` "Vantage Foods", KW/KWD | `demo-organisation.ts:61-78` | Exists, **wrong country/currency/code** |
| Controlling area | `A000` | same | Exists |
| Plant(s) | `1000` manufacturing, `2000` distribution | `demo-organisation.ts:66-71` | Exists (two plants) |
| Storage locations | 4 standard at `1000`, 3 at `2000` | `demo-organisation.ts:103-107` | Exists |
| Purchasing org | `1000` | `demo-organisation.ts:72` | Exists |
| Sales org / channel / division | `1000` / `01` / `01` | `demo-organisation.ts:72-73` | Exists |
| Shipping point | `1000`, `2000` | `demo-organisation.ts:76-77,396-427` | Exists |
| Chart of accounts | One delivered chart `CA01`, 60-ish generic accounts | `foundation/standard-config.ts:160-252` | Exists; **"International" generic chart, not Indian** |
| GL accounts BS/P&L | Full generic set 100000–620000 | same | Exists |
| GST config (CGST/SGST/IGST in & out) | **Not present.** Three fictional *output* rates `S5`/`Z0`/`E0` | `demo-masters.ts:89-93` | **GAP** — see §4 |
| GSTIN | Generic `tax_registration_number` / `tax_number` (≤40 chars) free text | `foundation/schema.ts:267`, `business-partner-schema.ts:42` | Field exists; **no GSTIN semantics/validation** |
| HSN / SAC | **No field on the material master** | `drizzle/0000_baseline.sql:6262` ff. | **GAP** |
| TDS (194C, 194J, 192) | **No withholding engine.** Account `221000` exists but nothing posts to it | `standard-config.ts:193`; no module reads it | **GAP** |
| Number ranges | Journal range `RF_BELEG` created; operational ranges from `createTenant` | `demo-organisation.ts:304-321` | Exists |
| Document types | Delivered by the standard package | `standard-config.ts:294` ff. | Exists |
| Posting periods | `K4` calendar-year variant + `C001` period variant | `standard-config.ts:518-560` | Exists; **calendar year, not Apr–Mar** |
| Account determination (inventory, GR/IR, consumption, revenue, tax, payroll) | 10 events incl. inventory by valuation class, GR/IR, consumption, TAX, PAYROLL_NET_PAY | `demo-procurement.ts:72-87`; `foundation/account-determination.ts:45-97` | Exists; **only one `TAX` account for both input and output** |
| CO objects (cost centres, profit centres, activity types) | 7 cost centres, 2 profit centres, 3 activity types | `demo-organisation.ts:115-129`; `demo-activity-price.ts` | Exists |

**Phase 0 verdict: structurally complete, nationally wrong.** Every object type the brief asks
for exists in the product and is exercised. Almost every *value* is Gulf-shaped.

---

## 3. Coverage against Phase 1 — HR

| Phase 1 requirement | Present today | Where | Verdict |
|---|---|---|---|
| Org units (mgmt, finance, HR, purchase, stores, production, quality, maintenance, sales, dispatch) | 9 units, no Maintenance, no Dispatch | `demo-people.ts:69-79` | Partial — 9 vs the brief's ~11 |
| Jobs | 18 | `demo-people.ts:82-100` | Exists |
| Positions + cost centre per department | ~20 positions, tiered | `demo-people.ts:105-135` | Exists |
| First HR admin user | `demo.owner` (`PLATFORM_ADMIN`) + `demo.admin` (`ADMINISTRATOR`) | `demo-organisation.ts:89-100` | Exists |
| Roles with segregation of duties | 12 custom `DEMO_*` roles — buyer, planner, production clerk, 2 warehouse clerks, sales, accountant, controller, auditor, 2 HR, quality | `demo-people.ts:174-286` | Exists and is genuinely segregated |
| ≥ 50 employees | **23** (20 + joiner + leaver + late joiner) | `demo-people.ts:136-156`, `demo-payroll-run.ts:46-47`, `demo-payroll-offcycle.ts:25` | **NOT MET** — 23 of 50 |
| Mix of grades | Position *tiers* exist | `demo-people.ts` | Partial — tiers yes, no skilled/unskilled worker grade |
| Monthly vs daily wage | Proration by payable days exists; no daily-wage master | `people/payroll-run.ts:14-20` | Partial |
| 12–15 system users, rest employees only | 14 demo users + 2 founders = 16; 23 employees | `demo-people.ts:303-324` | Roughly right (16 accounts) |
| Payroll master: basic, HRA, conveyance, special allowance | BASIC / HOUSING / TRANSPORT | `demo-payroll.ts:43-50` | Partial — no special allowance, Gulf names |
| PF (employee + employer) | Modelled as PENSION + ERCONTRIB at 5 %/11 % | `demo-payroll.ts:47-48,68-69` | **Configuration, not statute** — see §4 |
| ESI by wage ceiling | **Not expressible.** Rule kinds are `FIXED` or `PERCENT_OF_BASE` only | `people/schema.ts:58`; `payroll-run.ts:284` | **GAP** — no ceiling/branch condition |
| Maharashtra professional tax | Same limitation | — | **GAP** (slab logic not expressible) |
| TDS u/s 192 | **No withholding engine** | — | **GAP** |
| Bank account (fictional) | `employee_bank_detail` exists (9321) | `people/schema.ts:1388` ff. | Engine exists; **demo creates none** |
| PAN / UAN / ESIC no. | Expressible as configured `employee_record` types (TEXT fields) | `people/schema.ts:205-275` | Engine exists; **demo defines no record types** |
| Leave types + opening balances | ANNUAL / SICK / UNPAID time types; `leave_quota` + `leave_ledger` with `OPENING` entries | `demo-payroll.ts:52-56`; `people/schema.ts:1195`; `leave-ledger.ts:12` | Types exist; **demo creates no quotas or opening balances** |
| Holiday calendar | `holiday_calendar` + `holiday_calendar_day` + factory calendar | `foundation/factory-calendar.ts` | Engine exists; **demo creates none** |

**Phase 1 verdict: the product has the machinery; the dataset uses the smallest possible slice of
it.** The two genuine product-level shortfalls are (a) statutory payroll (PF/ESI/PT/TDS) and
(b) the absence of 50 employees and of the leave/holiday/record-type master data.

---

## 4. Is the data consistent with an Indian company code, Indian CoA and GST?

Short answer: **no, on every one of the three counts.**

### 4.1 Company code, country, currency, fiscal year

- `DEMO_IDENTITY` is `KW` / `KWD` / `Asia/Kuwait` (`demo-organisation.ts:44-52`). The brief needs
  `IN` / `INR` / `Asia/Kolkata`. **`IN` and `INR` already exist in the reference data**
  (`scripts/standard-reference-data.ts:12`), so this is a data change, not a product gap.
- Company code is `1000`. The brief asks for `IN01`. That is legal: `company_code` is
  `varchar(10)` (`foundation/schema.ts:255`) and the only 4-character rule applies to the
  controlling-area→company assignment row (`^[A-Za-z0-9]{4}$`, baseline SQL `3324`), which
  `IN01` satisfies. The tenant key validator requires 2–4 alphanumerics
  (`tenancy/index.ts:641-647`), so `IN01` also works as the client key.
- **Fiscal year is calendar (Jan–Dec).** The standard package writes variant `K4` with
  `startMonth: 1` and `isCalendarYear: true` (`standard-config.ts:518-560`). The brief needs
  **Apr–Mar**. The product *can* express this: the FYV maintenance service supports
  `isCalendarYear: false` with a hand-maintained period list (`month`, `day`, `yearShift`,
  `fiscal-year-variant-maintenance.ts:218-232`). So Apr–Mar is **data work in the installer, not
  a product gap** — but it means the standard package's `K4` cannot simply be reused, and the
  company code must point at the new variant.

### 4.2 Indian chart of accounts

The delivered chart (`standard-config.ts:160-252`) is a generic "International" chart. Two
consequences for India:

1. **Missing accounts an Indian books set needs.** There is no PF payable, ESI payable,
   professional-tax payable, TDS payable by section, CGST/SGST/IGST input credit, CGST/SGST/IGST
   output payable, or gratuity provision. There *is* `221000 Withholding tax payable` and
   `140000 Input tax receivable`, but **neither is posted to by anything** (see 4.3).
   Adding accounts is supported (`/config/gl-accounts`), so this is data work.
2. **Gulf-specific naming.** `240000 End of service benefit provision` and `500200 End of service
   benefit expense` are Gulf end-of-service concepts with no Indian analogue. They can be left
   unused, but the UAT guide must not present them as Indian payroll.

**Verdict:** an Indian CoA is buildable as data; there is **no delivered India country chart
template**, so the installer must create the India-specific accounts itself.

### 4.3 GST — the important finding

The product's tax model is **one tax code per document line, and one `TAX` posting event per
chart**:

- `tax_code` holds `country`, `tax_code` (≤4), `tax_type` (≤4), `rate_percent`, and an
  `account_key` (`foundation/schema.ts:1387-1412`).
- Purchasing resolves input tax by `resolveAccount(..., 'TAX', '')`
  (`purchasing/invoice-verification.ts:435-452, 964-967`) — **valuation class and account key are
  both ignored**.
- Sales resolves output tax through sales account determination `MWS → 220000`
  (`sales/account-determination.ts:65`).
- The generic return run (`finance/tax-report.ts`) derives input vs output **from the debit/credit
  sign** of lines carrying a tax code, and posts a clearing transfer. That is a reasonable
  GSTR-3B-*style* netting, but it is not a GSTR-3B.

What that means for an Indian UAT, stated plainly:

| GST need | Supported? | Consequence |
|---|---|---|
| One rate per line (e.g. 18 %) | **Yes** | A single `G18` code works |
| CGST 9 % + SGST 9 % as two components on one line | **No** | No multi-component tax code; two codes on one line is not a thing |
| IGST 18 % for inter-state | **Yes, as a separate code** | But nothing decides *when* to use it — no place-of-supply logic |
| Separate input-tax and output-tax GL accounts | **No** | A single `TAX` account per chart receives both sides; the demo points it at `220000 "Output tax payable"`, so purchase tax debits a liability account. Netting works; presentation does not. |
| `tax_code.account_key` distinguishing VST/MWS | **Stored but dead** | `account_key` is maintainable on the tax-code screen and read by no posting path I could find |
| HSN/SAC on material | **No field** | — |
| GSTIN validation / state code / place of supply | **No** | Free-text tax number only |
| GSTR-1 invoice-wise outward return | **No** | Only the generic tax-return run |
| GST summary | **Partial** | `tax-report.ts` gives per-code input/output/base — usable as a GSTR-3B *style* summary, with the caveat above |

**This is the single largest Phase-0 gap.** It is a product limitation, not a data problem, and it
must not be "fixed" by changing posting logic without approval.

### 4.4 TDS

There is **no withholding-tax engine**. `221000 Withholding tax payable` exists in the chart but
no service computes, deducts or posts a withholding amount; outgoing payment and payment-run code
contain no TDS path. Sections 194C, 194J and 192 are therefore **all GAPs**, with no workaround
other than a manual journal — which the UAT guide may show as a manual entry only if it says so.

### 4.5 Payroll statutory position

The payroll module is explicitly statute-free by designed decision (DV-001):

> "Nothing statutory ships: no tax, no social-insurance rate, no country leave law."
> — `people/payroll-run.ts:26-32`

Pay components are `EARNING | DEDUCTION | EMPLOYER_CONTRIBUTION | EOS_PROVISION`
(`people/schema.ts:594`), and a structure rule is `FIXED` or `PERCENT_OF_BASE`
(`demo-payroll.ts:58`). So:

- **PF at 12 % of basic is expressible** *if* basic is the structure's `baseAmount` — i.e. one
  structure per PF-ceiling band. It will not cap at ₹15,000.
- **ESI at 0.75 %/3.25 % below the wage ceiling is not expressible** — there is no ceiling
  condition on a rule.
- **Professional tax slabs are not expressible** — no conditional/slab rule.
- **TDS u/s 192 is not expressible** — no tax engine at all.

This is exactly what `docs/OPEN-GAPS.md` P1 records ("Statutory payroll: tax, social insurance,
filing formats, country leave law — Spec — DV-001"). **The UAT guide must present PF/ESI/PT/TDS
as configured approximations, mark the ceiling/slab/statutory parts GAP, and never present the
numbers as compliant.**

### 4.6 Data realism

Names are Gulf (Nadia Al-Sabah, Yousef Karam…), cities are Kuwaiti, suppliers are
"Al-Rashid Flour Mills", customers are "Gulf Hypermarkets WLL". Every one must be replaced for
the steel-fabrication scenario. Prices are in KWD with 3-decimal precision — a real constraint on
the redesign, because the demo *chose* KWD partly because it has 3 decimals.

---

## 5. What the dataset contains today (for the gap arithmetic)

| Object | Count | Note |
|---|---|---|
| Phases declared | **23** | `A_FOUNDATION…D19_RELEASE`; docs still say "nineteen" |
| Materials | 12 | 4 raw, 2 packaging, 1 semi, 3 FG, 2 traded |
| Suppliers | 4 | |
| Customers | 3 | |
| Cost centres / profit centres | 7 / 2 | |
| Work centres | 2 | |
| Tax codes | 3 | all fictional output rates |
| Employees | **23** | 20 + joiner + leaver + late joiner |
| Accounts (users) | **16** | 2 founders + 14 `demo.*` |
| Roles | 12 | all custom, all segregated |
| Leave quotas / holiday calendars | **0 / 0** | |
| Employee record types | **0** | |
| Reconciliation checks | 12 | `tests/demo-reconciliation.test.ts` |

---

## 6. Documentation drift found during the audit

Not blockers, but they will mislead whoever follows this work:

1. `docs/demo-restart-and-safety.md` §3 and §7 say "nineteen phases" and list nineteen; the code
   declares **23** (`demo-provisioning.ts:51-54`). The doc table omits `D15`–`D19`.
2. The same doc §2 says a `COMPLETED` installation appends phases "a later build added (e.g.
   `D6_AUDIT`)"; that example is long superseded.
3. `docs/DEVELOPMENT-OPERATIONS.md` §10 lists the same nineteen phases.
4. `docs/DEVELOPMENT-OPERATIONS.md` §2 names `/home/cairn/ui-build/` as the test-host directory
   (having corrected itself away from `/home/cairn/cairn-erp/`), while `AGENTS.md` §3 still names
   `/home/cairn/cairn-erp/`. The runbook's own rule is "the host is what is true now" — this must
   be resolved before anyone runs the installer there.

---

## 7. The installer against the Step-2 requirements (what the refactor must add)

| Step-2 requirement | Today | Gap |
|---|---|---|
| Phases 0–2 data in fixture files, single source of truth | **All data is TS constants** inside 24 modules; no `fixtures/` directory exists anywhere in the repo | **GAP** |
| Loads through services/APIs, not raw SQL | Mostly true; rare documented direct inserts | **Met** (keep) |
| `--until=phase0\|phase1\|phase2` | **No argument parsing at all** (`scripts/demo-provision.ts` reads only env vars) | **GAP** |
| Reset company `IN01` and reload cleanly | **No reset path.** No `delete` grant, no `--reset`, no force flag, by design (`demo-restart-and-safety.md` §1) | **GAP** — must be added deliberately, without weakening the eligibility refusal |
| Idempotent | Yes — adoption + request keys + RESUME | **Met** |
| Does **not** create Phase 3 transactions | **It creates every Phase-3 transaction**: `D1_PROCUREMENT` … `D19_RELEASE` all post documents | **GAP** — the required default is the inverse of today's |
| Separate `--with-transactions` mode | None | **GAP** |
| Users & credentials list — in UI, exportable, production-disabled | **File only** (`credentials/demo-credentials.txt`, mode 0600). `/platform/users` lists accounts but shows **no password and no department**; one shared password, no per-user credentials; nothing disables it in a production build beyond `ENABLE_DUMMY_DATA` | **GAP** — and explicitly in scope to change |
| Per-user credentials, clearly dummy | One shared 20-char password generated at run time | **GAP** vs the brief's "generated users list with username, password, role, linked employee and department" |

---

## 8. Preliminary GAP list (to be kept and extended as the guide is written)

Severity: **P0** blocks the scenario · **P1** forces a documented workaround · **P2** cosmetic.

### A. India configuration

| # | Gap | Sev |
|---|---|---|
| A1 | No CGST/SGST split — one rate per line, so an intra-state 18 % invoice cannot show 9 %+9 % | **P0** |
| A2 | No place-of-supply / state-code logic to choose CGST+SGST vs IGST; `region` fields are free text (`central-address-schema.ts:22`) | **P0** |
| A3 | Single `TAX` posting event: input and output tax cannot post to different GL accounts; `tax_code.account_key` is stored but unread | **P0** |
| A4 | No HSN/SAC on the material master | **P0** |
| A5 | No GSTIN validation, no GSTIN-derived state, no e-invoice/e-way-bill fields | **P1** |
| A6 | No GSTR-1; only a per-tax-code input/output run (usable as GSTR-3B *style*) | **P1** |
| A7 | No TDS engine — 194C, 194J and 192 impossible as postings; `221000` is unused | **P0** |
| A8 | No delivered India chart of accounts; PF/ESI/PT/TDS/CGST/SGST/IGST accounts must be created as data | **P1** |
| A9 | Standard FY variant is calendar-year; Apr–Mar must be built by the installer (supported, not delivered) | **P1** |

### B. Payroll & HR

| # | Gap | Sev |
|---|---|---|
| B1 | No statutory payroll: PF/ESI/PT/TDS are configured approximations, unsupported for ceilings and slabs (DV-001, `OPEN-GAPS.md` P1) | **P0** |
| B2 | Rule kinds are only `FIXED`/`PERCENT_OF_BASE` — no ceiling condition, no slab, no formula | **P0** |
| B3 | No overtime in payroll — `OVERTIME` time types exist but the run reads only unpaid absences (`payroll-run.ts:806-837`) | **P1** |
| B4 | No salary-advance feature (no employee advance subledger); workaround = deduction component + manual FI journal | **P1** |
| B5 | No final settlement / gratuity / full-and-final for a leaver (the demo only ends the position and salary) | **P1** |
| B6 | No daily-wage master (proration by days is the only support) | **P2** |
| B7 | Employee record types must be defined before PAN/UAN/ESIC can be held; demo defines none | **P1** |
| B8 | Leave quotas, opening balances and holiday calendars are supported but not seeded | **P1** |
| B9 | Only 23 employees provisioned vs the required 50+ | **P0** |

### C. Transactions, production and quality

| # | Gap | Sev |
|---|---|---|
| C1 | **Production order settlement does not post** (`production/order-settlement.ts:144-148`); WIP and variance are deferred (DV-003/DV-004) — so "settlement and variance" is display-only | **P0** |
| C2 | No inspection **plan** object — only lots, characteristics, results, usage decisions (`quality/schema.ts` has four tables, no plan) | **P1** |
| C3 | No QM notification / customer-complaint object; complaints are modelled through sales returns (`sales/schema.ts:111-116`) | **P1** |
| C4 | No vendor-return in the demo; movement `122`/`RETURN_TO_VENDOR` exists (`inventory/return-delivery.ts:61`) | **P1** |
| C5 | MRP exists (`production/mrp-run.ts`) but the installer never runs it | **P1** |
| C6 | Purchase requisition exists but the demo's procurement phase starts at PO; only `D19_RELEASE` raises PRs | **P1** |
| C7 | Depreciation run exists (`/finance/assets/depreciate`) but the installer never runs it | **P1** |
| C8 | Production cost centres receive **no activity cost at confirmation** — conversion cost shows up as a consumption-account balance by design (`DEVELOPMENT-OPERATIONS.md` §10) | **P1** |
| C9 | No payroll registers (PF/ESI/PT/TDS) as reports | **P1** |

### D. Installer mechanics (Step 2 itself)

| # | Gap | Sev |
|---|---|---|
| D1 | No fixture files; data is code | **P0** |
| D2 | No `--until=phase0\|phase1\|phase2` | **P0** |
| D3 | No reset-and-reload of company `IN01` | **P0** |
| D4 | Creates Phase-3 documents unconditionally; no master-data-only mode | **P0** |
| D5 | No in-app, exportable credentials list with username/password/role/employee/department; no production-build disable | **P0** |
| D6 | One shared password rather than per-user test credentials | **P1** |

---

## 9. What this means for the plan

Three findings change the shape of the work, and the owner should see them before Step 2:

1. **The installer is not "an Indian installer that needs fixtures" — it is a fully-featured
   Gulf demo that needs a national variant.** The phase machinery, the idempotency and the
   service-layer discipline are worth keeping. The dataset is a rewrite.
2. **GST and TDS are product gaps, not data gaps.** No amount of fixture work produces a
   CGST/SGST split or a TDS deduction, because the tax model has one rate per line and one `TAX`
   account per chart, and there is no withholding engine. The UAT guide will have to run the
   scenario at a single GST rate on one account, and mark the split, the place-of-supply decision,
   HSN, GSTIN and every TDS section **GAP**. I will not change posting logic to paper over this.
3. **Production order settlement and payroll statutory calculation do not post/compute.** Both are
   recorded product decisions (DV-001, DV-003, DV-004), so they are GAPs with documented
   workarounds, not bugs.

Two of the brief's Step-3 requirements are therefore only partly satisfiable *as written*:
"Expected journal entry … amount incl. GST" can be shown for a single rate, and "TDS" entries can
be shown only as manual journals clearly labelled as such.

---

## 10. Open questions for the owner (none block the audit; all block Step 2 or 3)

1. **GST rate strategy.** Given A1–A3: should the guide use **one consolidated rate per line**
   (e.g. `G18` → 18 % on a single GST account) with CDSG/SGST split marked GAP — or should the
   scenario deliberately use **IGST-only** transactions where a single code is defensible?
2. **FY variant.** Confirm Apr–Mar built as a new variant (data), pointing company code `IN01` at
   it, rather than reusing `K4`.
3. **Indian CoA.** Confirm the installer **adds** India-specific accounts to the delivered `CA01`
   chart (keeping the generic ones) rather than authoring a second chart.
4. **Payroll statutory.** Confirm that PF/ESI/PT/TDS are provisioned as **configured pay
   components at flat approximations**, with every ceiling/slab/statutory element marked GAP and
   no claim of compliance. If you would rather the guide show these as **manual FI journals**
   only, say so.
5. **Reset.** A reset for company `IN01` must not weaken the "refuse a database with business
   data" guard. Confirm you want a **guarded reset scoped to the demo tenant and keyed to the
   installation record**, not a broad `--force`.
6. **Production settlement.** Confirm the guide presents settlement as **calculation/display
   only**, with the variance shown where it actually lands (the consumption account), rather than
   implying a posted settlement document.
7. **Credentials.** Confirm per-user test passwords (not one shared password), written to both the
   file and an in-app, exportable list, and unavailable in a production build.

---

## 11. Recommendation

Proceed to Step 2 **only after** you have answered §10 and accepted §8's P0 gaps as GAPs rather
than as things to build. On that basis I would:

1. Introduce `fixtures/in01/` (JSON) for Phase 0, 1 and 2, referenced by both the installer and
   the UAT guide.
2. Keep the 23-phase ledger and idempotency; add `--until` and `--with-transactions`, and change
   the default to Phase 2.
3. Extend the credential feature to per-user test credentials with an in-app, exportable list,
   gated off in production builds.
4. Add a guarded, installation-keyed reset for `IN01` only.
5. Write the UAT guide against the fixtures, with the GAP list in §8 carried into it verbatim.

No application change is proposed. No database was touched.

---

# Addendum — decisions taken after this audit

The owner answered §10. These are the rulings, recorded here so a later reader knows why the
refactor took the shape it did. They are not reopened by later work.

| # | Question | Ruling |
|---|---|---|
| 1 | Scope | Replace the Kuwait dataset with India `IN01`. Keep the installer framework (phase ledger, idempotency, service-layer loading). The old dataset stays in git history. |
| 2 | Structure | Split fixtures into `core/`, `country/IN/`, `company/IN01/`. A second country is a new `country/XX` pack plus a company folder, **no installer change**. Anything hard-coded to one country in the app is a GAP. |
| 3 | International slice | One foreign vendor (China, USD) and one foreign customer (UAE, USD) in `IN01`. FX is real; customs duty, Bill of Entry and import IGST are GAPs shown as TARGET (GAP). |
| 4 | GST | A single consolidated rate per line posting to the one `TAX` account. CGST/SGST/IGST split, separate input/output accounts, HSN and GSTIN semantics recorded as GAPs, with the compliant entry shown as TARGET (GAP). |
| 5 | TDS | GAP. No manual journals for 194C/194J; the vendor payment is shown without TDS and the target entry beside it. |
| 6 | Fiscal year | Build Apr–Mar as a new variant **if it is configuration**. It was not: `derivePosition` could not resolve January–March. The defect was reported, approved, fixed (`28bed70d`), and the variant is now configuration. |
| 7 | Statutory payroll | Provision through the payroll engine as flat approximations — PF 12 %/12 %, ESI 0.75 %/3.25 % for fixture-marked employees, PT ₹200 flat, TDS 192 a pre-calculated fixed amount. Ceiling logic, PT slabs and the 192 calculation are GAPs. Components live in `country/IN`. |
| 8 | Employees | 50+ (52 built). Seed leave quotas, holiday calendar and employee record types through services; where no service exists, record a GAP rather than writing to the database. **One such gap was found:** no service creates a factory calendar (`02-gap-list.md` B10). |
| 9 | Production settlement | GAP. Expected settlement and variance entries are TARGET (GAP); the checklist marks the variance check not testable. |
| 10 | Credentials | Users/credentials view with department, test-only, disabled in production builds; the 0600 file stays. |
| 11 | Doc drift | Correct the "nineteen phases" references and document the India dataset. Done. |
| 12 | Partly satisfiable | See below. |
| 13 | Localisation summary | Added to the GAP list as its own section. |

## The two partly-satisfiable requirements, restated

1. **"Expected journal entry … amount incl. GST"** can show only a single consolidated rate. The
   split cannot be posted. The guide shows the posted entry and a TARGET (GAP) entry beside it.
2. **TDS in P2P (194C/194J)** has no posting. The vendor payment is shown without TDS plus a
   TARGET (GAP) entry. The reconciliation line "TDS liability = register" is marked **not
   verifiable — GAP**.

Both are reflected in `05-uat-guide.md` and its reconciliation checklist.

## Two further rulings given with the approvals

- **Reset**: guarded, scoped to the demo tenant, keyed to the installation record; refuses if a
  tester has written anything or the record is missing; needs `--reset-demo IN01 --confirm IN01`;
  disabled in production; no general delete grant or force flag. Built as ruled.
- **Passwords**: per-user, generated at install time, shown in the test-only view and the 0600
  file, never logged elsewhere. Built as ruled.
