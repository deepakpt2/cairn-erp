# CAIRN — Project Log & Technical Specification (continued)

**Product:** Cairn — an enterprise resource planning system
**Hostname:** cairn.deepakpt.com
**Document status:** AGREED baseline (2026-10-08 Go) — implementation IN BUILD; screen sign-off remains per §24.1
**Created:** 2026-10-13 (v1.70) · **Part 3 of 3 — this is the live part**
**Continues:** [CAIRN.md](CAIRN.md) (§0–§26.35) · [CAIRN-2.md](CAIRN-2.md) (§26.36–§30 up to v1.69)
**Owner:** Deepak (product owner) · Built with Arena.ai Agent Mode

---

## §0.3 Document-set size and rotation rule `AGREED · v1.70`

**Owner instruction, 2026-10-13 (recorded as R-24 / D-093).**

| Rule | Detail |
|---|---|
| **Hard ceiling** | No part of the canonical log may ever exceed **400 KB (400,000 bytes)**. The 400 KB figure is read conservatively (decimal KB, the smaller interpretation), so either reading of "400kb" is satisfied. |
| **Rotation trigger** | A live part **rotates as soon as it passes 360 KB (360,000 bytes)** — i.e. once it is "becoming closer" to the ceiling, the next numbered file is started rather than waiting for the limit. |
| **New part** | The next part is created as `CAIRN-<n>.md`, continues section numbering and the change-log version sequence without a gap, and is declared the live part. |
| **Continuation notice** | The last part announces that the set continues in the new part; the new part names every earlier part it continues. Both directions are mandatory. |
| **Frozen parts** | A rotated part is frozen: further edits are limited to pointer/continuation lines and corrections that cannot be deferred (each such edit must keep the part under the ceiling). New substantive content is appended only in the live part. |
| **Measurement** | Byte size on disk (`stat -c %s`), checked in the same turn any canonical file is edited. |

**Set status at v1.70 (2026-10-13):**

| Part | Sections | Size at rotation check | State |
|---|---|---|---|
| `CAIRN.md` | §0–§26.35 | 395,959 bytes (99.0 % of ceiling) | **FROZEN** — pointer edits only |
| `CAIRN-2.md` | §26.36–§30 (through v1.69) | 398,255 bytes (99.6 % of ceiling) | **FROZEN** — pointer edits only |
| `CAIRN-3.md` | §0.3, §1.4, §2.1, §26.167+ (next), §30 continued | new — this part | **LIVE** |

**Where new work is recorded from v1.70 onward:** new requirements as §1.4 rows, new decisions as
§2.1 rows, completed batches as §26.167+ section entries (§26.36-style), and change-log versions as
§30 rows continued below. The §0.1 update protocol (same-turn recording, append-never-rewrite,
one ID per decision) remains binding across all parts.

---

## §1.4 Requirements — later clarifications, continued `AGREED · v1.70`

Rows continue the register in `CAIRN.md` §1.1–§1.2. Owner instructions of 2026-10-13.

| ID | Requirement | Interpretation |
|---|---|---|
| R-24 | **Project-log files never exceed 400 KB** | No part of the canonical log may pass 400 KB (400,000 bytes). When a live part passes 360 KB, start the next numbered file, declare it the live part, and state the continuation in both directions. Rotated parts are frozen except pointer/correction edits. Operational detail in §0.3 / D-093. |
| R-25 | **Small increments; never risk the agent interface** | Batches are sized so the agent web interface cannot time out and the working environment cannot run out of memory: one heavy operation at a time (build, browser run or database acceptance), bounded output, and long work split across batches rather than streamed in one. This refines R-22 without weakening its preservation rules. |
| R-26 | **Completion report after every batch** | Every completed batch ends with an explicit report: (a) the **main process** it belongs to, (b) the **current step** inside the approved roadmap (§25.5), (c) the **next step**, and (d) any **data/decisions required from the owner** before that step can proceed. A batch that cannot state all four is not complete. |
| R-27 | **SAP parity: functional and visually familiar** | Functionality follows SAP standard behaviour and field semantics for the equivalent process; the UI must feel familiar to an SAP user (screen flow, field order, grid/logon conventions). It is never exact UI copy: labels, wording, comments, icons and visual identity are Cairn's own (D-034, §19.5 and the trademark lint remain binding). |
| R-28 | **Mobile-ready UI** | Every new or changed page must remain usable on a phone-sized viewport (initially 390 px wide): primary flows readable and operable without page-level horizontal scrolling (wide grids may scroll inside their own container). The §24.1 page cycle gains a mobile check; the detailed acceptance bar is confirmed with the owner at the first mobile-reviewed page. |
| R-29 | **Local environment and secrets** | The repo URL, PAT and database connection string live only in `.env.local`, which is gitignored and verified untracked. If the configured remote database is unreachable from the working environment, use a local database instead and remove the unreachable connection string from `.env.local`. Secrets never appear in the log, commits, test output or UI. |
| R-30 | **SAP transaction-code gate before UI design** | Before any page is designed, the agent presents the SAP transaction code(s) the page corresponds to. The owner then supplies the form-field data to be captured. UI design/implementation starts only after those fields are provided. |

---

## §2.1 Decision register, continued `AGREED · v1.70`

Rows continue the register in `CAIRN.md` §2 (through D-092).

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D-093 | **Document-set rotation policy.** Ceiling 400,000 bytes per part; rotate when a live part passes 360,000 bytes; new part `CAIRN-<n>.md` continues numbering and version sequence; continuation declared in both directions; rotated parts frozen except pointer edits. §0.3 records the current part sizes. | Owner instruction 2026-10-13. At the check, `CAIRN.md` was 395,959 and `CAIRN-2.md` 398,255 bytes — both effectively at the ceiling — so `CAIRN-3.md` is created now as the live part. | 2026-10-13 |
| D-094 | **Bounded-batch protocol v2 and the completion-report contract.** (1) Batch sizing must protect the agent interface (no plausible timeout, no out-of-memory): one heavy operation at a time, bounded logs, split long work. (2) Every completed batch reports main process / current step / next step / required owner data (R-26). (3) The §24.1 page cycle gains, before design: the SAP tcode presentation and the owner's form-field data (R-30); and, before acceptance: a mobile-viewport check (R-28). (4) §25.4 remains binding for time budgets, preservation and the publish trigger. | Owner instruction 2026-10-13; operationalises R-25, R-26, R-28 and R-30. | 2026-10-13 |
| D-095 | **Environment and secret-handling policy.** Repo URL, PAT and database connection string are kept only in `.env.local` (gitignored, permissions 600); no secret is written to the canonical log, commits, output or UI. Where the remote database is unreachable from the working environment, the local development database is used and the unreachable string is removed from `.env.local` (owner retains it in their own records). **Recorded finding (2026-10-13):** `db.yyskxzdytncsatwjkiva.supabase.co:5432` resolves to IPv6 only from the workspace sandbox and no IPv6 route exists there; general outbound network verified working (GitHub reachable). The Supabase string was therefore removed from `.env.local` per R-29, and the local development database (`127.0.0.1:5432/cairn`, split `cairn`/`cairn_app` roles) is the working target. The PAT remains owner-rotated; it is used only when the owner instructs a push. | Owner instruction 2026-10-13; keeps working credentials out of the repository and unblocks local development. | 2026-10-13 |
| D-096 | **Verified remote test database target (Supavisor session pooler).** The owner-supplied replacement string (`…@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`, login `postgres.<ref>`) is verified working from the workspace sandbox with the project's own postgres.js driver: IPv4 DNS + TCP reachable, login OK, no TLS requirement, server PostgreSQL 17.11, `public` schema empty (no Cairn migrations applied yet), login role NOT superuser but `rolbypassrls=true` with `createrole`/`createdb` — i.e. it satisfies the migration runner's elevated-role check and must never be used as the runtime connection. Consequences: the string is stored in `.env.local` as `CAIRN_TEST_DATABASE_URL` and `MIGRATION_DATABASE_URL`; `DATABASE_URL` stays on the local fallback until a non-elevated application role is provisioned on the test database; migrations/seeds and the role split on the test database are the next database batch and require owner go-ahead because they write to the remote database. This supersedes the local-only interim of D-095 for test purposes (the policy of D-095 itself stands). | Owner instruction 2026-10-13 ("check if this works; if yes add to `.env.local` and use as test database"). Verification evidence recorded in §30 v1.71. | 2026-10-13 |

---

## §26 · Phase 1 screen inventory — continued

*§26.167 onward is reserved for the next completed batches (initially: the pending ledger entries
for SCR-018, SCR-019 and SCR-020 per §25.4, which are coded and pushed but not yet recorded —
see §30 v1.70). Section entries here follow the §24.2 template and the §26.36 style.*

---

## §30 · Change log (continued)

Continues the change log of `CAIRN-2.md` §30 from version 1.69. Same rules: append only, one row per
recorded change, date and reason stated.

| Version | Date | Change | By |
|---|---|---|---|
| 1.70 | 2026-10-13 | **Document set rotated to a third part and the 2026-10-13 owner instructions registered.** Owner instructions recorded as R-24–R-30 and D-093–D-095: (1) canonical log parts never exceed 400 KB and rotate at 360 KB into the next numbered file with a continuation notice in both directions (§0.3); (2) increments stay small enough to protect the agent web interface from timeouts/out-of-memory (R-25); (3) every completed batch reports main process, current step, next step and required owner data (R-26/D-094); (4) strict SAP functional parity and visual familiarity without copying UI text (R-27); (5) mobile-ready UI at phone width with a new page-cycle check (R-28); (6) repo URL, PAT and DB string live only in the gitignored `.env.local`, and an unreachable remote DB is replaced by a local database and removed from `.env.local` (R-29/D-095); (7) before any UI page is designed, the SAP tcode(s) for the page are presented and the owner supplies the form fields (R-30). **Rotation executed:** at check, `CAIRN.md` was 395,959 bytes and `CAIRN-2.md` 398,255 bytes (both ≈99 % of the ceiling), so both are frozen with pointer-only edits and this file becomes the live part; §0.3 records the sizes. **Environment:** `.env.local` created at repo root (mode 600, verified untracked via `git check-ignore`), holding the repo URL, the owner's temporary PAT and local development connection strings; the Supabase string was removed because `db.yyskxzdytncsatwjkiva.supabase.co` resolves IPv6-only and the sandbox has no IPv6 route (general outbound network verified against GitHub). Local PostgreSQL 17.11 is available for provisioning (matches the documented disposable-acceptance environment). **Pending, not part of this entry:** the ledger entries for the already-pushed SCR-018/SCR-019/SCR-020 batches (B-151–B-153) and the IP-lint regression introduced by the SCR-020 commit (`febccf5`, 16 trademark occurrences; `npm run lint:ip` fails) — both are the next batches. No code, database, migration or seed change in this entry; documentation and local environment files only; no commit or push. | Agent |
| 1.71 | 2026-10-13 | **Owner-supplied replacement test-database string verified and adopted (D-096).** The new string uses the Supavisor session pooler (`aws-0-ap-northeast-2.pooler.supabase.com:5432`, login `postgres.<ref>`) and works from the workspace sandbox: IPv4 resolution (the earlier direct host is IPv6-only), TCP reachable, login OK, no TLS requirement, PostgreSQL 17.11, `createrole`/`createdb` present, `rolbypassrls=true` (qualifies as the migration runner's elevated role), and the `public` schema empty — no Cairn migration has ever been applied there and no project roles exist yet. The string is now stored in `.env.local` as `CAIRN_TEST_DATABASE_URL` and `MIGRATION_DATABASE_URL` (mode 600, verified untracked); `DATABASE_URL` deliberately remains the local fallback because the application connection must be NOSUPERUSER/NOBYPASSRLS and the test database has no such role yet. No write of any kind was performed against the test database — all checks were read-only (`select`); migrations, seeds and the role split there are the next database batch and require owner go-ahead. No code, schema, migration or seed change; documentation and local environment files only; no commit or push of this entry beyond the local docs commit. | Agent |

---

*End of this part for now. This part is the live canonical log: it is updated in the same turn as any
change to code, schema, decision or scope (§0.1). When it passes 360,000 bytes, the next part
`CAIRN-4.md` begins and this file states that the set continues there (§0.3 / D-093).*
