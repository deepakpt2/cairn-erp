# Deliverable 7 — Proposal: turning Phase 3 into automated E2E tests

**Status: proposal only. Nothing here is built.** The brief asks for a proposal, and Phase 3 has
no dataset yet (GAP D1), so a test suite written now would test steps that do not exist.

---

## 1. What is already in place

Three things make this cheaper than it looks:

1. **The repository already has a browser harness.** `scripts/browser-smoke.ts` and
   `scripts/browser-smoke/targets.ts` drive real browsers against real screens, with a target
   registry, a database guard (`database-guards.ts`), and 20+ existing targets. The Playwright
   dependency and the launch pattern are established; this is not a greenfield choice.
2. **The dataset is fixture-driven.** `fixtures/company/IN01/company.json` is the single source of
   truth, so a test can import the same file the installer reads and assert against the same
   numbers rather than a copy.
3. **The reconciliation already exists as a shape.** `tests/demo-reconciliation.test.ts` proves the
   twelve checks are assertable against a provisioned database; the India version would be the
   same checks against `IN01`.

## 2. What to build, in order

### Step 1 — Make Phase 3 installable (prerequisite, GAP D1)

Nothing below can run until `--with-transactions` exists. Proposal:

- A `fixtures/company/IN01/transactions.json` (or a `fixtures/company/IN01/month/` directory) that
  holds the month's documents as data: orders, receipts, invoices, payments, absences, adjustments.
- `--with-transactions` installs it **through the same services**, as the current phases do, with
  request keys so a re-run adopts rather than duplicates.
- The installer refuses `--with-transactions` unless the master-data phases have completed.

This is the same discipline the existing installer already follows; it is a data exercise, not an
architecture one.

### Step 2 — A data-level test that the installed month reconciles

Before any browser is involved:

```
tests/in01-reconciliation.test.ts
```

Skip unless a database marked `IN01_RECONCILED=1` is present, exactly as
`demo-reconciliation.test.ts` does today. Assertions, one per reconciliation line:

| Test | Assertion |
|---|---|
| trial balance | Σ debit = Σ credit over `journal_entry_line` for `IN01` |
| stock = inventory G/L | Σ stock value per valuation class = `120000`…`120300` |
| AP / AR | Subledger open items = `200000` / `110000` |
| GR/IR | `210000` = 0 |
| GST | `220000` for the period = (output − input) from the tax run |
| payroll | Σ(gross − deductions) = Σ net pay = `251000`, cleared by the bank |
| FX | the USD payable clears at the invoice rate; the difference is on `570000` |

The variance and TDS lines become **explicitly skipped tests with a reason string naming the GAP**,
so the suite's output states the gap rather than hiding it:

```ts
it.skip('production variance reconciles (GAP C1: settlement does not post)', () => {});
it.skip('TDS liability equals the register (GAP A7: no withholding engine)', () => {});
```

### Step 3 — Playwright journeys, one per chain

Four specifications, each a single happy path plus the one refusal that proves segregation:

```
tests/e2e/in01-p2p.spec.ts
tests/e2e/in01-production.spec.ts
tests/e2e/in01-o2c.spec.ts
tests/e2e/in01-payroll.spec.ts
```

Each spec:

1. Signs in **by role** — `IN01.BUYER` for the requisition, `IN01.STOREKEEPER` for the receipt,
   `IN01.AP` for the invoice. The credential file supplies the passwords; the spec reads it rather
   than hard-coding them.
2. Drives the screens the guide names, filling the exact fixture values.
3. Asserts the document number, the status and the **journal** — the (account, Dr/Cr, amount)
   triples from the guide's tables.
4. Ends with a refusal: `IN01.SALES` attempting a goods issue must be refused, with the message
   naming the missing capability.

### Step 4 — A screenshot per guide step

Each numbered step in `05-uat-guide.md` gets one screenshot at a stable filename
(`docs/uat-india/screens/3.1.3-goods-receipt.png`). Playwright's `toHaveScreenshot` would be too
brittle for a UI still changing; a plain capture attached to the run artifact is enough, and it
keeps the guide honest — a step whose screenshot no longer matches its text is a step to fix.

## 3. How it runs

- **Sequential, one database.** The suite provisions `cairn_in01_e2e_YYYYMMDD_<run>` (the runbook's
  disposable-database pattern), installs `--until=phase2 --with-transactions`, runs the data test,
  then the four specs, then drops the database. Never the persistent or prohibited ones.
- **One browser at a time.** The runbook's "at most one Next.js instance on the test host" rule
  applies; Playwright starts the app, runs, and stops it.
- **CI-ready exit codes.** A failure names the guide step (`3.1.4 invoice verification`) so a
  reader can jump straight to it.

## 4. What cannot be automated, and why

| Area | Why |
|---|---|
| CGST/SGST split | Nothing posts it (GAP A1). A test would assert a posting that does not exist. |
| TDS 194C/194J | No engine (GAP A7). |
| Production settlement/variance | `posts: false` (GAP C1). |
| Customs duty, Bill of Entry, import IGST | No module (GAP C4). |
| QM notification | No object (GAP C3). |
| Statutory payroll registers | No reports (GAP B8). |
| Salary-advance subledger | No subledger (GAP B4). |

These become tests the moment the gaps close, not before. Writing them now would produce a suite
that asserts a fiction, which is worse than an empty file.

## 5. Effort and risk, in order

1. **Phase 3 fixtures** — the largest piece, and the blocker for everything else.
2. **Reconciliation test** — small once the data exists; the assertions are already written for the
   demo dataset and can be adapted.
3. **Four Playwright specs** — moderate; the harness and the role-based sign-in are the new parts.
4. **Screenshots** — mechanical.

The risk is not technical. It is that Phase 3 has more product gaps than Phases 0–2, so a suite
written to the *guide* would fail on C1, A1, A3, A7 and C4 by design. The proposal above is
deliberately written to assert what the product does and to skip, by name, what it does not.
