# How to start — the five commands

Everything a tester needs before opening `05-uat-guide.md`. Assumes a disposable database and
`CAIRN_ENV=development`.

---

## 0. Set the environment once

```bash
# A DISPOSABLE database. Never cairn_b210, cairn_hr_accept, cairn_demo,
# cairn_acceptance or cairn_integration.
export DB=cairn_in01_work

export DATABASE_URL="postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/$DB"
export MIGRATION_DATABASE_URL="postgresql://cairn_integration_migrator:cairn_migrator_dev@127.0.0.1:5432/$DB"
export CAIRN_ENV=development
export CAIRN_DEMO_LOGIN_URL=http://localhost:3000
```

---

## 1. Create and prepare the database (first time only)

```bash
psql 'postgresql://cairn_integration_migrator:cairn_migrator_dev@127.0.0.1:5432/postgres' \
     -c "create database $DB owner cairn_integration_migrator"

npm run db:migrate
npm run db:init-reference
```

The reference seed is **not optional**: without it the company has no currency, country or unit
of measure and the first phase fails on a foreign key.

---

## 2. Reset (every re-run after a first install)

```bash
npx tsx scripts/in01-install.ts --reset-demo IN01 --confirm IN01
```

Notes:

- Both `IN01`s matter. The first names the company; the second is the confirmation you type.
- It refuses — and deletes nothing — if a tester has written anything, if a founder account has
  changed anything since the install completed, or if any document stands. That is the guard
  working, not a failure. The message says which row and which account.
- It is disabled outside `CAIRN_ENV=development`.
- If it refuses and you want to start over regardless, **drop the database and go back to step 1**.
  A reset is not the tool for that, deliberately.

---

## 3. Install to Phase 2

```bash
npx tsx scripts/in01-install.ts --until=phase2
```

Takes about a minute. It prints the account list as it finishes. To stop at an earlier phase:

```bash
npx tsx scripts/in01-install.ts --until=phase0    # organisation only
npx tsx scripts/in01-install.ts --until=phase1    # + people and accounts
```

Re-running the same `--until` is safe: every phase adopts what already stands and reports 0 new
objects.

---

## 4. Get the credentials

Two ways, same rows:

**The file** (mode 0600, the single source of truth for passwords):

```bash
cat credentials/demo-credentials.txt
```

**In the app** — start it and open the test-only view:

```bash
npm run dev            # http://localhost:3000
```

Then sign in as `in01.admin` and open:

```
http://localhost:3000/platform/users/test-credentials
```

That page returns **404 outside a development build**, by design. The ordinary user directory at
`/platform/users` never shows a password.

> **If the file is lost**, the passwords cannot be recovered — the database holds only a hash.
> Reset (step 2) and reinstall (step 3) to issue new ones.

---

## 5. Run the Phase 3 scenarios, in this order

The chains share stock, so the order matters. Later steps read what earlier ones left.

| # | Chain | Sign in as | Guide |
|---|---|---|---|
| 1 | **Procure to pay** — PR → PO → GR → invoice → payment | `in01.buyer`, then `in01.storekeeper`, then `in01.ap` | 3.1.1 → 3.1.6 |
| 2 | **Production** — MRP → order → issue → confirm → receipt | `in01.planner`, `in01.supervisor`, `in01.qc` | 3.2.1 → 3.2.5 |
| 3 | **Order to cash** — quotation → order → delivery → billing → payment | `in01.sales`, `in01.dispatch`, `in01.ar` | 3.3.1 → 3.3.6 |
| 4 | **Import** — USD purchase and export sale | `in01.buyer`, `in01.storekeeper`, `in01.ap` | 3.4 |
| 5 | **HR and payroll** — attendance, leave, run, post, pay | `in01.hr`, `in01.admin` | 3.5 |
| 6 | **Month-end close** — GR/IR, depreciation, accruals, allocation, statements, GST | `in01.controller`, `in01.ap` | 4.1 → 4.8 |
| 7 | **Reconciliation checklist** — the eleven checks | `in01.auditor` (read-only) | the checklist at the end |

### Why this order

- **P2P before production** so the raw-material receipt from 3.1.3 feeds the component issue in
  3.2.2. There is opening stock too, so production will not fail without it — but the numbers the
  guide quotes assume the receipt happened.
- **Production before O2C** so 3.2.4's finished goods are what 3.3.3 delivers. The distribution
  centre also has opening stock of finished racks, so a delivery works either way; the guide's
  figures assume the production receipt.
- **HR and payroll after the operational chains** so the cost centres carry the month's activity
  before payroll posts against them.
- **Close last**, and only when the checklist passes.

### Quick sanity check before you start

After step 3, sign in as `in01.admin` and confirm:

| Screen | Should show |
|---|---|
| `/config/company-codes` | Company code **`IN01`**, currency INR, fiscal year `A4` |
| `/config/plants` | Plants `1000` and `2000`, both assigned to `IN01` |
| `/people/employees` | **52** employees |
| `/inventory/materials` | **13** materials |
| `/platform/users` | **15** accounts |

If the company code is anything other than `IN01`, the fixtures and the installer are out of
step — that is a bug, not a setup problem.

---

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `Company code IN01 already exists` | Re-running Phase 0 without a reset | Expected; the phase adopts it. Ignore. |
| `Tenant IN01 does not exist` on reset | Already reset, or never installed | Nothing to reset. Go to step 3. |
| Reset refuses naming `IN01.BUYER` or similar | A tester signed in and changed data | Correct behaviour. Drop the database and go to step 1 if you want a clean slate. |
| Reset refuses naming `in01.admin` **after** the install | An administrator edited data by hand after setup | Same: drop and rebuild, or keep the data. |
| `relation ... does not exist` | Migrations not run | Step 1. |
| `Currency INR does not exist` | Reference seed not run | `npm run db:init-reference`. |
| Installer refuses `--with-transactions` | Phase 3 has no dataset yet (GAP D1) | Expected. Follow the guide by hand. |
