# Slice F — coverage reconciliation for the FI/CO walkthrough (slices A–E)

Built from two artefacts, not from intention: the coverage block of the executed seed log
(`/tmp/sliceDE-run.log` on the test box, run of `walkthrough-seed-sliceDE.ts` against database
`cairn`, tenant `W100`) and the capability codes the FI/CO screens declare in
`src/app/finance/**/actions.ts`, `src/app/controlling/**` and `src/ui/shell/screen-catalog.ts`.

## 1. Coverage aggregation (item 1 of the brief)

| measure | value |
|---|---|
| coverage report lines in the executed run | 130 |
| distinct capability codes in those lines | 130 |
| duplicated codes remaining | none |

`cover()` in the execution copy ignores a code that has already been recorded, so the first
(authoritative) entry wins and the declared order is kept. The published
`walkthrough-seed.ts` is untouched (md5 `b31cf1c5255101df9e0f0e74f66aefc7` on the box and in the
working tree), so the three duplicate call sites still exist in the source and are deduped at
run time:
* `SALES.CUSTOMER.SALESAREA.MAINTAIN` — 1 call site in the published seed (slice B) plus 1 in the slice-D fragment, so 2 in the execution copy, 1 line in the report
* `PROD.ORDER.CREATE` — 2 call sites in the published seed (both inside slices A–C), 1 line in the report
* `PROD.CONFIRM.ORDER` — 2 call sites in the published seed (both inside slices A–C), 1 line in the report

Before the patch the same run reported 112 lines for 109 distinct codes (slice D alone); with
slice E spliced in and the dedupe applied, the report is 130 lines for 130 codes.

**Measured again after the statement-version change (Options A and C).** Counting every bullet the
seed prints (`grep -oP '^\s+· \K[A-Z0-9._-]+' | sort -u`) instead of only the lines inside the
coverage block gives 133 for the archived pre-change log `/tmp/sliceDE-run.log` and 136 for
`/tmp/f2-run.log`, the run this pass executed; the two sets differ by exactly
`FIN.RPT.TRIALBALANCE`, `FIN.RPT.BALANCESHEET` and `FIN.RPT.PROFITLOSS`, and nothing was lost. So
the 130/133 difference is the counting window, not the seed, and the 3-code gain is the point: the
three closing reports were blocked by a missing financial statement version and now run, because a
tenant stands that version from its own creation transaction. The step that reads it is labelled in
the log for what it is — a verification of the package's rows, whose fallback reuses the package's
own catalogue rather than a fixture of its own: `version INT stood by the standard configuration
package; 8 node(s) and 5 account range(s), 1 version(s) in total for this tenant`.

## 2. Slice E (FI/CO) — what was executed

Each row is a capability the screens declare **and** a step that ran in the seed; the detail is
the module's own output, printed by the run. Nothing here was recorded by a direct write to a
ledger, asset, valuation or audit table.

| code | evidence in the run |
|---|---|
| `FIN.JOURNAL.POST` | manual document JE-2026-000047 (1000/2026/47/2026) debiting 101000 for 1500.0000 |
| `FIN.JOURNAL.PARK` | document PK-0000001 parked at status PARKED with a balance of 0.00 |
| `FIN.JOURNAL.DISPLAY` | parked PK-0000001 read back and posted as 1000/2026/48 |
| `FIN.GL.CREATE` | 2 balanced line(s) posted to the general ledger of company 1000 |
| `FIN.DOCUMENT.REVERSE` | document 1000/2026/47/2026 reversed by 1000/2026/49/2026 in period 9 for 1500.0000 INR |
| `FIN.ASSET.CREATE` | asset AS-0000001/0000 in class 1000, status ACTIVE, 1 depreciation area(s) |
| `FIN.ASSET.ACQUIRE` | document 1000/2026/50 capitalises 60000.00 INR on AS-0000001; acquired value 60000.00 |
| `FIN.ASSET.CHANGE` | master of AS-0000001 changed at version 2: Walkthrough assembly fixture (line 2), inventory number WALK-FA-01-B |
| `FIN.ASSET.DEPRECIATE` | run 99aadf13-5b9f-4868-b051-ccee0255f703 at status COMPLETED: calculated 1000.00, posted 1000.00 on 1 asset(s) |
| `FIN.ASSET.RETIRE` | document 1000/2026/52 retires 6000.00 of acquisition value (scope PERCENT), 100.00 depreciation reversed, 54000.00 left |
| `FIN.ASSET.REPORT` | asset transactions, depreciation runs and the history sheet all read for the capitalised asset |
| `FIN.ACCRUAL.POST` | accrual document JE-2026-000053 of 900.00 INR, reversal promised on 2026-12-12 for reason 01 |
| `FIN.FX.VALUATE` | valuation FXMVRWKVUN at TEST on 2026-12-12: 0 item(s), gain 0.00, loss 0.00, test run: nothing posted |
| `FIN.CLOSE.CARRYFORWARD` | run CFMVRWKVUPLM2 at status COMPLETED: 19 account(s) read, 7229388.8 balance(s) carried into FY2027, 0 error(s) |
| `FIN.GL.CLEAR` | clearing document 1000/2026/55/2026 settles 1000/2026/3 against 1000/2026/2 on 210000; open balance now -41700.00 |
| `FIN.CLEARING.RESET` | reset RST-000001 re-opens 4 item(s) of clearing document 1000/2026/55/2026 |
| `FIN.CLOSE.COCKPIT` | task list WALK-E-CLOSE released for 1000 FY2026/9: 2 task(s) at RELEASED |
| `FIN.AR.AGEING` | customer ageing at 2026-12-12: 3 customer(s) in 30-60-90 day buckets, 72776.00 INR outstanding |
| `FIN.AP.AGEING` | vendor ageing at 2026-12-12: 0 supplier(s), 0.00 INR outstanding |
| `FIN.TAX.REPORT` | test report for IN over 2026-01-01 to 2026-12-12: 3 line(s), base 412380.00, output 28476.00, input 45014.40, net -16538.40 |
| `FIN.IC.POST` | 1000/2026/56/2026 in 1000 against 2000/2026/1/2026 in 2000 for 250.00 INR |

Database effects read back afterwards (`cairn`, `client = W100`, `journal_entry.origin_class`):
`asset_acquisition` 1, `asset_depreciation_run` 1, `asset_retirement` 1, `gl_clearing` 1,
`intercompany_posting` 2, `parked_journal` 1, plus `journal_entry` 3 (the manual journal and its
reversal and the accrual), `accrual_document` 1, `asset_transaction` 1, `asset_depreciation_run` 1,
`asset_retirement` 1, `parked_journal_header` 1 / `_line` 2, `dunning_run` 1 (proposal, no accounts),
`intercompany_clearing_config` 1, `intercompany_document_header` 1.

## 3. Blocked, unsupported, not tested

| workflow | class | why, in the module's own words |
|---|---|---|
| `FIN.AP.CLEAR` vendor clearing + `FIN.CLEARING.RESET` on the vendor document | **blocked by data** | "supplier V10000 in company 1000 holds 7 open item(s) for -109822.00 with no selection that nets to zero" — V10000's open items do not contain a balanced pair. The `FIN.CLEARING.RESET` capability was still executed, on the G/L clearing document the GR/IR step produced (`RST-000001`, 4 items re-opened). |
| `FIN.AR.DUNNING.RUN` finalization | **blocked by data** | "the run at 2026-12-12 proposed no account: no customer invoice of 1000 is past its baseline date". A `dunning_run` row with `dunning_run_account = 0` stands as the evidence; the invoices the walkthrough posts are too recent to be overdue. Fabricating an overdue invoice would need a baseline-date change in slice D, which is a data decision for the owner. |
| `FIN.RPT.TRIALBALANCE`, `FIN.RPT.PROFITLOSS`, `FIN.RPT.BALANCESHEET` | **executed since the standard package stands the version (was: blocked by configuration)** | the blocker this note recorded — "no financial statement version stands for client W100" — is gone: `applyStandardPackage` (INTL-STD-4) installs `INT` with its 8 nodes and 5 ranges inside the tenant's creation transaction, so the walkthrough tenant needs no later `npm run seed` and no hand-written fixture. Read-back: `client=W100 version=INT chart=CA01 active=true created_by=WALKTHROUGH`. The reports ran through the finance services and returned 8 statement rows with turnover `5349109.60` debit against `5349109.60` credit, 2 balance-sheet rows, and a profit-and-loss statement of `-586529.20 INR`; the equality of that turnover with the raw journal lines is proved in `tests/statement-version-onboarding.test.ts`, not in the seed. Nothing is persisted by the reports. See §7 of `notes/statement-version-gap.md`.
| `FIN.JOURNAL.LIST`, `FIN.GL.BALANCE`, `FIN.AR.CLEAR`, `FIN.AP.PAYMENTRUN.EXECUTE`, `FIN.AR.DOWNPAYMENT.CLEAR` and the other codes listed in section 4 | **not tested in this run** | the capability is declared by a screen but no step of slices A–E recorded it: the function exists, the walkthrough does not exercise it, so it is neither verified nor refuted. |

Codes the FI/CO screens declare that the run does not report:

* `CFG.FIN.ACCTDET.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.COA.COPY` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.COA.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.DOCTYPE.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.EXRATE.MAINTAIN` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.FYV.ASSIGN` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.FYV.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.GLACCOUNT.CHANGE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.GLACCOUNT.CREATE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.GLACCOUNT.DISPLAY` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.GLACCOUNT.TRANSFER` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.HOUSEBANK.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.IC.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.PAYTERMS.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.PPV.ASSIGN` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.PPV.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.RETAINED.DEFINE` — src/ui/shell/screen-catalog.ts
* `CFG.FIN.TOLERANCE.DEFINE` — src/ui/shell/screen-catalog.ts
* `CO.BUDGET.ORIGINAL.CHANGE` — src/ui/shell/screen-catalog.ts
* `CO.BUDGET.ORIGINAL.DISPLAY` — src/ui/shell/screen-catalog.ts
* `CO.ORDER.DISPLAY` — src/ui/shell/screen-catalog.ts
* `CO.ORDER.MAINTAIN` — src/ui/shell/screen-catalog.ts
* `CO.PLANREVAL.CREATE` — src/ui/shell/screen-catalog.ts
* `CO.SETTLE.COLLECTIVE` — src/ui/shell/screen-catalog.ts
* `CO.SETTLE.ORDER` — src/ui/shell/screen-catalog.ts
* `CO.SETTLE.RULE` — src/ui/shell/screen-catalog.ts
* `FIN.AP.BALANCE` — src/ui/shell/screen-catalog.ts
* `FIN.AP.CLEAR` — src/ui/shell/screen-catalog.ts
* `FIN.AP.CREDITMEMO.POST` — src/ui/shell/screen-catalog.ts
* `FIN.AP.INVOICE.POST` — src/ui/shell/screen-catalog.ts
* `FIN.AP.PAYMENT.POST` — src/ui/shell/screen-catalog.ts
* `FIN.AP.PAYMENTRUN.EXECUTE` — src/ui/shell/screen-catalog.ts
* `FIN.AR.BALANCE` — src/ui/shell/screen-catalog.ts
* `FIN.AR.CLEAR` — src/ui/shell/screen-catalog.ts
* `FIN.AR.DOWNPAYMENT.CLEAR` — src/ui/shell/screen-catalog.ts
* `FIN.AR.DOWNPAYMENT.POST` — src/ui/shell/screen-catalog.ts
* `FIN.AR.DOWNPAYMENT.REQUEST` — src/ui/shell/screen-catalog.ts
* `FIN.AR.DUNNING.RUN` — src/ui/shell/screen-catalog.ts
* `FIN.AR.INVOICE.POST` — src/ui/shell/screen-catalog.ts
* `FIN.AR.PAYMENT.ENTER` — src/ui/shell/screen-catalog.ts
* `FIN.CLOSE.PERIOD` — src/ui/shell/screen-catalog.ts
* `FIN.CONSOLIDATE` — src/ui/shell/screen-catalog.ts
* `FIN.DOC.FLOW` — src/ui/shell/screen-catalog.ts
* `FIN.GL.BALANCE` — src/ui/shell/screen-catalog.ts
* `FIN.JOURNAL.LIST` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.BALANCESHEET` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.CASHFLOW` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.CONSOLIDATE` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.CONSOLIDATE.STMT` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.COSTCENTER.ACTUAL` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.PROFITCENTER` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.PROFITLOSS` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.SUBLEDGER.TIE` — src/ui/shell/screen-catalog.ts
* `FIN.RPT.TRIALBALANCE` — src/ui/shell/screen-catalog.ts

## 4. Status boundaries

* **type check**: `npx tsc --noEmit -p tsconfig.sliceDE.json` on the executed bytes — 12 errors, all
  the pre-existing A–C diagnostics (re-measured on the final copy: still 12, none in slice E) at lines 602, 603, 992, 1066, 1087 (×2), 1531, 1602, 1831, 1846,
  1915, 1955; 0 errors anywhere between `async function seedFiCo` and `async function main`.
* **runtime**: `npx tsx walkthrough-seed-sliceDE.ts --client=W100` on the freshly provisioned `cairn`
  (`npm run test:db -- --database cairn --fresh --yes`, exit 0) — as published in pass 80: exit 0,
  `WALKTHROUGH READY`, 3 skipped steps out of 119. Re-executed after the statement-version change
  (copy md5 `9e8928e416a5748f958bbcc167043c9f`, identical on both sides, 120 step call sites):
  exit 0, `WALKTHROUGH READY`, **2** skipped steps — vendor clearing and dunning, both blocked by
  data — because the closing-reports step now runs.
* **database effect**: read back with `psql` as above; `cairn_b210` (the guarded browser-acceptance
  database) was queried read-only and still shows 368 tables and 0 `W100` materials.
* **browser acceptance: NOT RUN for the slice-D and slice-E screens.** The smoke harness only targets
  guard-locked databases, so those screens have not been opened in a browser. Database execution is
  not browser acceptance, and this document does not claim it. One correction since: the three
  **closing-report** screens named in the statement-version gap (`/finance/trial-balance`,
  `/finance/balance-sheet`, `/finance/profit-loss`) have now been opened, on `cairn_b210` under a
  read-only ruling, with the trial balance and the invalid-version refusal verified against the
  services — see `notes/statement-version-browser-acceptance.md`. The coverage lines they carry in
  section 2 remain browser-verified *display* of derived figures only: that tenant holds no postings,
  so the numbers on screen are zero there, as the note records.

## 5. Recommended next step

Either add a financial-statement-version definition activity to the finance configuration module
(which would unblock the three closing reports for every tenant, not just this seed) or record the
gap in the function catalogue as an explicit unsupported pair: the reports read a version that
nothing can create. Then a browser acceptance pass of the new FI/CO screens on the dedicated box
would turn the runtime evidence into on-screen evidence.
