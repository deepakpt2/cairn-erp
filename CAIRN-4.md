# CAIRN — Project Log & Technical Specification (continued)

**Product:** Cairn — an enterprise resource planning system
**Hostname:** cairn.deepakpt.com
**Document status:** AGREED baseline (2026-10-08 Go) — implementation IN BUILD; screen sign-off remains per §24.1
**Created:** 2026-10-16 (v2.62) · **Part 4 of 4 — this is the live part**
**Continues:** [CAIRN.md](CAIRN.md) (§0–§26.35) · [CAIRN-2.md](CAIRN-2.md) (§26.36–§30 through v1.69) · [CAIRN-3.md](CAIRN-3.md) (§0.3, §1.4 R-24–R-72, §2.1 D-093–D-139, §26.167–§26.259, §30 v1.70–v2.61)
**Owner:** Deepak (product owner) · Built with Arena.ai Agent Mode

---

## §0.3 Document-set size and rotation rule `AGREED · v1.70`

The rule recorded in `CAIRN-3.md` §0.3 (R-24 / D-093) is unchanged and binding: no part may exceed
400,000 bytes; a live part rotates as soon as it passes 360,000 bytes; the next part continues section
and version numbering without a gap; both the outgoing and the incoming part carry a continuation
notice; a rotated part is frozen to pointer edits and corrections that cannot be deferred; size is
measured on disk in the same turn any canonical file is edited.

**Set status at v2.62 (2026-10-16):**

| Part | Sections | Size at rotation check | State |
|---|---|---|---|
| `CAIRN.md` | §0–§26.35 | 395,959 bytes (99.0 % of ceiling) | **FROZEN** — pointer edits only |
| `CAIRN-2.md` | §26.36–§30 (through v1.69) | 398,255 bytes (99.6 % of ceiling) | **FROZEN** — pointer edits only |
| `CAIRN-3.md` | §0.3, §1.4 R-24–R-72, §2.1 D-093–D-139, §26.167–§26.259, §30 v1.70–v2.61 | 354,009 bytes at rotation | **FROZEN** — pointer edits only |
| `CAIRN-4.md` | §0.3, §26.260+ (next), §30 continued from v2.62 | new — this part | **LIVE** |

## §1.4 Requirements — later clarifications, continued

Rows continue the register in `CAIRN-3.md` §1.4 from R-72.

| ID | Requirement | Interpretation |
|---|---|---|
| R-73 | **The package is split before the tenant screen is reduced, and both are one SCR with two published stages** | The owner chose the order that writes nothing twice: the screen removes the four fields the package currently requires, so reducing the screen first would mean defaulting the company code to `1000` and the company name to the tenant's name, and the split would then delete that logic. Numbering follows the loop's one-SCR-per-round rule with two published stages inside it: SCR-032 carries the split and the screen, and OBBP stays SCR-033. Each stage is published green on its own, and stages are not merged to shorten the process. |

---

## §2.1 Decision register, continued

Rows continue the register in `CAIRN-3.md` §2.1 from D-139.

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D-140 | **SCR-032 runs as five published steps, and the fixture builder lands before anything is removed.** Step A1 adds a shared builder for the standard structure — company code, controlling area, plant, sales organisation, purchasing organisation — written against the same services the screens call, wired into `tests/helpers.createTenant` and the harness's `onboard()`, with the package still whole; green at that point proves the builder reproduces what the package was providing. Step A2 reduces the package to general data, and the proof is that the eighteen dependent test files and the twelve dependent targets are **untouched** and still green. Steps B1–B3 then reduce the screen, its backend and its acceptance. A builder written after the removal would have nothing to be checked against, and a removal made before the builder exists would turn eighteen test files and twelve targets red at once with no way to tell which failure was the split and which was the fixture. | Owner ruling received on 2026-10-16. | 2026-10-16 |

---

**Where new work is recorded from v2.62 onward:** new requirements continue the §1.4 register from
R-72 in `CAIRN-3.md` (opened here when the first one is recorded), new decisions continue the §2.1
register from D-139 (likewise), completed batches as §26.260+ entries, and change-log versions as §30
rows continued below. The §0.1 update protocol — same-turn recording, append-never-rewrite, one ID per
decision — remains binding across all parts.

---

## §26 · Phase 1 screen inventory — continued

Continues §26 of `CAIRN-3.md` from §26.259 (B-243). Same rules: append only, one entry per recorded
batch, with what was done, what was verified and what remains open.

### 26.260 B-244 — The split's blast radius measured before any of it is built `MEASURED · NOTHING IMPLEMENTED · SEQUENCING OPEN`

The owner ruled that the blast radius be measured before the package split and the tenant screen are sequenced, so the numbers below are counts taken from the sources rather than estimates.

**Browser harness — 12 of 33 targets depend on something the split removes.** Each target's body was attributed individually and matched against the keys the package will stop creating:

| Target | Depends on | Runnable here |
|---|---|---|
| `foundation` | the package's G/L accounts — it posts to `100000` and `200000` — and an activity arriving Completed | yes |
| `controlling-area` | company code `1000`, controlling area `A000` | yes |
| `fiscal-year-variant-assignment` | controlling area `A000` | yes |
| `material-mrp` | plant `1000` | yes |
| `sales-org-company-code` | company code `1000`, sales organisation `1000` | yes |
| `sales-org-division` | sales organisation `1000` | yes |
| `plant-definition` | company code `1000` | no — guard bound to `cairn_b125` |
| `plant-company-code-assignment` | company code `1000`, plant `1000` | no — `cairn_b129` |
| `storage-locations` | company code `1000` | no — `cairn_b139` |
| `purchasing-orgs` | company code `1000`, plant `1000` | no — `cairn_b150` |
| `purchasing-org-company-code` | company code `1000` | no — `cairn_b151` |
| `sales-orgs` | sales organisation `1000` | no — `cairn_b153` |

Six of the twelve are bound to historical databases this environment does not run, so **six runnable targets** are affected. Four targets assert that an activity arrives Completed — `foundation`, `payment-methods`, `payment-terms` and `storage-locations` — which is fewer than feared, and only where the activity is one the package will stop marking does it bite.

**Service tests — 18 of the 40 files that create a tenant depend on package structure.** Of 127 test files, 40 call `tests/helpers.createTenant`, which applies the package directly; 18 of those 40 then use something the split removes: nine the company code `1000`, six the purchasing organisation, six the plant, four the sales organisation, two controlling area `A000`, one a sales area. The other 109 files do not create a tenant through the helper at all and are unaffected.

**Application source — the split is contained.** Only `standard-config.ts` and `development-fixture.ts` write the company-specific objects; the six files matching "sales area" are the sales-area screen's own code, which is unaffected by what the package creates. No screen reads the package's output as a constant, so nothing in `src` outside those two files has to change.

**What the measurement decides.** The tail is bounded, and it has one shape: a shared builder for the standard structure — company code, controlling area, plant, sales organisation, purchasing organisation — written against the same services the screens call, and used by `tests/helpers.createTenant` and by the harness's `onboard()`. With that builder, the 18 test files and the 12 targets stay exactly as they are, and what was implicit in the package becomes an explicit fixture step. Without it, 18 test files and 12 targets are each edited by hand.

**Not implemented.** No code, schema or test has been written for the split or for the tenant screen. The sequencing question the measurement was ordered to inform is put to the owner with these numbers.

| D-141 | **The builder calls a service where the package called a service, and inserts directly everywhere else.** D-140 said the builder would be written against the services the screens call. That is amended: eleven of the thirteen objects are inserted directly with `onConflictDoNothing`, because the screen services demand what a fixture cannot supply — a reason for every change, an expected version, retirement guards — while two go through real services, `assignCompanyCodeToControllingAreaInTransaction` and `recordChange`, because the package used those too and their rows and audit trail are part of what fixtures were written against. Which is which was settled by comparing snapshots rather than by argument. | Owner latitude over design process, exercised on 2026-10-16 after measurement. | 2026-10-16 |

---

### 26.261 B-245 — SCR-032 sequenced into five published steps, and two errors in yesterday's count corrected `DECIDED · NOTHING IMPLEMENTED`

The owner chose the order and the numbering (R-73/D-140): the package is split before the tenant screen is reduced, and both are one SCR with two published stages, so OBBP stays SCR-033. Nothing is written twice — reducing the screen first would mean defaulting the company code to `1000` and the company name to the tenant's name, logic the split would immediately delete.

**Two counts corrected, in the frozen part and here.** D-139, §26.259 and row 2.61 said the package marks twenty-nine activities and the split drops seventeen. Counting all three appliers rather than the package's own loop gives **thirty**: twenty-six in that loop, three in `applyMaterialDefaults`, one in `applyPaymentTermDefaults`. The split keeps **twelve** and drops **eighteen**. The twelve kept are `CFG.FIN.COA.DEFINE`, `CFG.FIN.FYV.DEFINE`, `CFG.FIN.PPV.DEFINE`, `CFG.FIN.DOCTYPE.DEFINE`, `CFG.ORG.DISTCHANNEL.DEFINE`, `CFG.ORG.DIVISION.DEFINE`, `CFG.PROC.PURGROUP.DEFINE`, `CFG.FIN.EXRATE.MAINTAIN`, `CFG.INV.MATERIALTYPE.DEFINE`, `CFG.INV.MATERIALGROUP.DEFINE`, `CFG.PROD.MRPCONTROLLER.DEFINE` and `CFG.FIN.PAYTERMS.DEFINE`. The correction is carried in `CAIRN-3.md` as a note at its footer, which §0.3 permits in a frozen part because a count the next stage is checked against cannot wait.

**A defect found while counting.** `createTenant` has an `else` branch: when the standard package is *not* activated it still marks `CFG.ORG.COMPANYCODE.DEFINE` complete. An empty tenant is therefore told its company code is defined when nothing created one — the same class of lie the split exists to remove, on the path the split makes normal. It goes with step A2, and it explains part of why the empty-tenant branch has never been exercised: the one thing it reports is false.

**The five steps.**

| Step | Deliverable | Proof it is green |
|---|---|---|
| A1 | A shared builder for the standard structure — company code, controlling area, plant, sales organisation, purchasing organisation — written against the services the screens call, wired into `tests/helpers.createTenant` and the harness's `onboard()`, package still whole | The builder reproduces what the package provides, so nothing downstream changes |
| A2 | The package reduced to general data: twelve objects kept, eighteen activity marks dropped, the `else`-branch mark removed | The eighteen dependent test files and the twelve dependent targets are **untouched** and green; the six runnable affected targets re-run |
| B1 | The tenant screen reduced: name, key, creation type, administrator; identity stays; structure and finance leave | The screen renders and refuses as contracted, with the empty path executed for the first time |
| B2 | Its backend: `CreateTenantInput` loses four fields rather than making them optional, `creationType` accepts empty and refuses copy with a remedy, `CreatedTenant` shrinks | Service tests over the empty path, the copy refusal and the key refusal |
| B3 | Acceptance: the new target `tenant-creation` on fixture client T971, plus a re-run of the six affected targets | Every checkpoint green against the production build on the reviewed database |

**Still open, and deliberately not decided here.** How the package option and Creation Type coexist on the reduced screen. The question was asked before the inventory arrived and has not been answered; now that the package creates no company-specific structure, "empty tenant" and "preload the general catalogue" no longer contradict each other, so the three-option field is coherent — but it is a ruling for step B1, not an inference at step A1.

**Not implemented.** No code, schema or test written. The next step is A1.

---

### 26.262 B-246 — Step A1b: a snapshot test proved the builder, and corrected two things already published `IMPLEMENTED · GREEN`

`tests/standard-structure-builder.test.ts` (three tests) creates a fixture tenant, snapshots the structure the standard package wrote, deletes it, rebuilds it with `applyStandardStructure`, and asserts the second snapshot equals the first. It is the check that step A2 depends on: eighteen test files and twelve browser targets are not allowed to change, so "the builder reproduces the package's structure" has to be demonstrated rather than intended. It runs while the package still writes those rows, because afterwards there is nothing left to compare against.

**It caught two real gaps on its first run, and both were mine.** The builder wrote eleven objects and missed two things the package did that a grep for `insert(` cannot see:

1. **The controlling area to company code link.** The package creates it by calling `assignCompanyCodeToControllingAreaInTransaction` at `standard-config.ts:498`, not by inserting into `controlling_area_company`. The test failed on the foreign key when deleting `controlling_area`, which is the only reason the omission surfaced.
2. **Three change documents.** The package records `sales_org_distribution_channel`, `sales_org_division` and `sales_area` through `recordChange`, and the OX19 service records a fourth for its own link. Audit rows are part of the state a fixture tenant has, so the builder now writes the same four, with the same object keys, types and activity codes.

**A published claim, corrected.** The commit message for `f4851ff` said that `CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY` is marked complete with no row behind it, on the strength of the package's insert list not containing `controlling_area_company`. That is **wrong**: the package does create the link, through the service named above. What survives of the finding is narrower and still true — the other three assignment activities the package marks (`CFG.ORG.PLANT.ASSIGN_COMPANY`, `CFG.PROC.PURORG.ASSIGN_COMPANY`, `CFG.ORG.SALESORG.ASSIGN_COMPANY`) are satisfied by a `company_code` *column* on the child row rather than by a link table, so no assignment row exists for them either, and the columns are written by the same inserts that define the objects.

**The pattern behind both errors is worth naming.** This is the second measurement in SCR-032 to come out wrong in the same direction: the activity count was taken from a fixed-width window after `for (const code of [` and missed two of the three appliers, and the package's writes were taken from `insert(x)` and missed every call that goes through a service. Both times one syntactic form was read and everything else assumed absent. The snapshot comparison cannot make that mistake, which is the argument for having given A1b its own step instead of folding it into A1.

**Teeth, checked by mutation.** Removing the `sales_area` change document from the builder fails two of the three tests with "expected 3 to deeply equal 4"; restoring it passes. The comparison is not vacuous.

**What the test pins, and what A2 inherits.** Thirteen tables — the twelve company-specific objects plus `controlling_area_company` — and four change documents, compared field by field with timestamps and the sales organisation's `address_number` excluded. The address is excluded because `central_address` has no natural key, so a rebuild allocates a fresh number and orphans the package's; the test asserts the replacement exists and carries the same country instead of pretending the column matches. A second call is asserted to change nothing and to allocate no further address. Step A2 reduces the package and this test must still pass with the builder as the only writer, which is the whole point of building it first.

**Verification.** Typecheck clean; `lint:ip` clean over 485 files; suite **1005 passed of 1005 across 128 files** in 68 s, up from 1002/127 by exactly the three new tests; no existing file edited except `tests/helpers.ts`, `scripts/create-dev-tenant.ts` and `scripts/browser-smoke/checks.ts`, all three wired in step A1 and unchanged here.

**Open.** The `else`-branch mark (B-245) and the three column-satisfied assignment marks still fall in step A2. Nothing in the browser has been run: A1 and A1b are node-side, and the production build has not been made since the last wipe.

---

## §30 · Change log (continued)

Continues the change log of `CAIRN-3.md` §30 from version 2.61. Same rules: append only, one row per
recorded change, date and reason stated.

| Version | Date | Change | By |
|---|---|---|---|
| 2.62 | 2026-10-16 | **Document set rotated to a fourth part, and the package split's blast radius measured (B-244, §26.260).** `CAIRN-3.md` passed the 360,000-byte rotation trigger, so this part begins and is declared live; `CAIRN-3.md` is frozen to pointer edits. Measured before building anything: 12 of 33 browser targets depend on something the split removes, six of them runnable in this environment; 18 of the 40 test files that create a tenant depend on package structure, and the other 109 files are unaffected; in `src` only `standard-config.ts` and `development-fixture.ts` write the company-specific objects. The tail has one shape - a shared builder for the standard structure, written against the services the screens call and used by `tests/helpers.createTenant` and the harness's `onboard()`, which leaves all 18 files and all 12 targets as they are. Nothing implemented; sequencing put to the owner with these numbers. | Agent |

| 2.63 | 2026-10-16 | **SCR-032 sequenced into five published steps; two activity counts corrected; an `else`-branch defect found (B-245, §26.261; R-73/D-140).** The package is split before the screen is reduced, both inside one SCR with two published stages, so OBBP stays SCR-033. The package marks thirty activities, not twenty-nine - twenty-six in its own loop, three in the material applier, one in payment terms - and the split keeps twelve and drops eighteen; the correction is carried into the frozen part as a footer note, which §0.3 permits for a count the next stage is checked against. Counting found that `createTenant`'s `else` branch marks `CFG.ORG.COMPANYCODE.DEFINE` complete when the package is not activated, so an empty tenant is told a company code exists that nothing created; it goes with step A2. Five steps published green in order: builder, package reduction, screen, backend, acceptance - with the builder first so that eighteen test files and twelve targets can stay untouched as the proof of the split. Still open for step B1: how the package option and Creation Type coexist. | Agent |
| 2.64 | 2026-10-16 | **Step A1b: a snapshot test proved the builder and corrected two published claims (B-246, §26.262; D-141).** `tests/standard-structure-builder.test.ts` snapshots the structure the package writes, deletes it, rebuilds it and compares - thirteen tables and four change documents, field by field, with timestamps and the sales organisation's address number excluded. Its first run caught two gaps a grep for `insert(` could not see: the package creates the controlling area to company code link through `assignCompanyCodeToControllingAreaInTransaction`, and records three change documents through `recordChange`. The builder now does both, and the claim in `f4851ff` that `CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY` had no row behind it is withdrawn - what stands is that the plant, purchasing organisation and sales organisation assignments are satisfied by a `company_code` column rather than a link table. D-141 amends D-140: services where the package used services, direct inserts elsewhere. Teeth checked by mutation - dropping one change document fails two tests. Gates: tsc clean, lint:ip clean, 1005 of 1005 across 128 files in 68 s, up by exactly the three new tests. | Agent |
---

*End of this part for now. This part is the live canonical log: it is updated in the same turn as any
change to code, schema, decision or scope (§0.1). When it passes 360,000 bytes, the next part
`CAIRN-5.md` begins and this file states that the set continues there (§0.3 / D-093).*
