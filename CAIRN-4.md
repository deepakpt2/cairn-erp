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

## §1.4 Requirements — later clarifications, continued

Rows continue the register in `CAIRN-3.md` §1.4 from R-73.

| ID | Requirement | Interpretation |
|---|---|---|
| R-74 | **Only the tenant key is unique. The tenant name is not.** | This retracts half of R-68, which recorded the owner as asking for a name and a four-character key "both unique". Two tenants may share a name; the key is what identifies one. The creation form must not claim otherwise in its hint or enforce it in validation, and no uniqueness constraint on the name is proposed. Recorded here because it was ruled before the field set was drafted and the draft carried the wrong version forward. |
| R-75 | **The standard package becomes an option of Creation Type, not a separate control.** | The owner chose to fold the package into the creation-type field rather than keep it as a checkbox beside it: one field with three options — *empty tenant*, *standard general data*, and *copy from an existing tenant*, the last shown and refused with a remedy. This supersedes both the earlier ruling that the package option "stays on the creation page as is" (it stays on the page, but as an option of this field) and the contract draft's statement that the package is no longer applied at creation. Since `INTL-STD-3` the package holds only data that is true for any company, so choosing it at creation no longer contradicts creating a tenant without a company. |
| R-76 | **The payment-terms activity belongs to its screen, not to the package.** | Settling the defect B-249 raised: `applyPaymentTermDefaults` writes the terms and files a change document under `CFG.FIN.PAYTERMS.DEFINE` without marking that activity, so a tenant that took the package was asked by the workbench for work already done. The owner chose the screen as the owner of the mark rather than the package. Nothing had to change: `payment-terms.ts` already calls `markActivityComplete` on both the no-change and the changed paths, and the package applier files only the document. The accepted consequence is that a packaged tenant shows the activity not started until someone maintains payment terms through the screen, and the package's marks stay at eleven. |

---

## §2.1 Decision register, continued

Rows continue the register in `CAIRN-3.md` §2.1 from D-142.

| ID | Decision | Rationale | Date |
|---|---|---|---|
| D-143 | **A creation type of "standard general data" applies the package at creation and nothing else; "copy from an existing tenant" is rendered, refused and writes nothing; and the proposed per-tenant package action on `/clients` is not built.** The contract draft at B-242 proposed a separate ADMINISTRATOR-gated action on the tenant list so that a tenant created empty could take the package later. With the package selectable at creation, that action is no longer load-bearing for anything — least of all for the harness, whose `onboard()` can choose the option instead of navigating to a second screen to find it. Building new surface that nothing requires, in an SCR whose subject is removing surface, is the wrong trade; if the owner later wants an empty tenant to be able to take the package, it is a small SCR of its own. | Owner ruling R-75, applied on 2026-10-17. | 2026-10-17 |

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

| D-142 | **Activity marks travel with the rows that satisfy them.** When the company-specific half of the package moved to the structure builder, the eighteen marks moved with it rather than staying in tenant creation. The screens gate on the workbench — the Controlling Area panel refuses to create anything while `CFG.ORG.COMPANYCODE.DEFINE` is incomplete — so a tenant whose structure exists but whose workbench does not say so is a tenant that cannot be configured further. The alternative, leaving the marks in `createTenant`, would have recreated the exact lie the split exists to remove: a tenant told it has configured what no screen was asked about. | Owner ruling that the package keep only general data, applied on 2026-10-16 after two browser targets refused to proceed. | 2026-10-16 |

---

### 26.261 B-245 — SCR-032 sequenced into five published steps, and two errors in yesterday's count corrected `DECIDED · NOTHING IMPLEMENTED`

The owner chose the order and the numbering (R-73/D-140): the package is split before the tenant screen is reduced, and both are one SCR with two published stages, so OBBP stays SCR-033. Nothing is written twice — reducing the screen first would mean defaulting the company code to `1000` and the company name to the tenant's name, logic the split would immediately delete.

**Two counts corrected, in the frozen part and here — and corrected again at §26.265, where the paragraph below is superseded.** D-139, §26.259 and row 2.61 said the package marks twenty-nine activities and the split drops seventeen. Counting all three appliers rather than the package's own loop gives **thirty**: twenty-six in that loop, three in `applyMaterialDefaults`, one in `applyPaymentTermDefaults`. The split keeps **twelve** and drops **eighteen**. The twelve kept are `CFG.FIN.COA.DEFINE`, `CFG.FIN.FYV.DEFINE`, `CFG.FIN.PPV.DEFINE`, `CFG.FIN.DOCTYPE.DEFINE`, `CFG.ORG.DISTCHANNEL.DEFINE`, `CFG.ORG.DIVISION.DEFINE`, `CFG.PROC.PURGROUP.DEFINE`, `CFG.FIN.EXRATE.MAINTAIN`, `CFG.INV.MATERIALTYPE.DEFINE`, `CFG.INV.MATERIALGROUP.DEFINE`, `CFG.PROD.MRPCONTROLLER.DEFINE` and `CFG.FIN.PAYTERMS.DEFINE`. The correction is carried in `CAIRN-3.md` as a note at its footer, which §0.3 permits in a frozen part because a count the next stage is checked against cannot wait. **Measured by execution at step B2, the truth is twenty-nine marked, eleven kept, eighteen dropped: the payment-terms applier files a change document under `CFG.FIN.PAYTERMS.DEFINE` but never marks that activity, so it was never one of the package's marks. See §26.265.**

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

### 26.263 B-247 — Step A2 finished: the browser stage found two real faults, one in the builder and one in a target `IMPLEMENTED · GREEN`

Step A2 was published as `78b1200` with its node-side gates green and its browser re-runs explicitly still pending. They are done now, and they earned their place: **three of the seven locally runnable affected targets failed**, and the failures separated cleanly into one product fault and one target fault.

**The discriminator.** Rather than guess whether A2 caused them, the two product files were checked out from `75cff49`, rebuilt, and the three targets re-run: all three passed. So the failures were A2's, not stale fixtures or a drifting environment, and the diagnosis could proceed on that footing. The tree was then restored to `78b1200` and rebuilt.

**Fault one, in the builder (two targets).** `controlling-area` timed out waiting for its create success notice, and the panel said why: *"Controlling Area prerequisites are incomplete: CFG.ORG.COMPANYCODE.DEFINE. Complete Company Code definition in the configuration workbench first."* `fiscal-year-variant-assignment` failed the same way at its no-op notice. The builder wrote the company code and marked nothing. The package had marked eighteen activities alongside its rows, and the screens gate on those marks, so the marks had to move with the rows (D-142). `applyStandardStructure` now marks the eighteen it satisfies and reports them as `result.activities`. Leaving the marks in `createTenant` was the other option and would have restored precisely the lie the split exists to remove.

**A discovery underneath it.** `markActivityComplete` is an update, and a tenant created through the tenant service gets a `config_activity_status` row for every activity, while a fixture made by `tests/helpers.createTenant` gets none — so the builder's marks had nothing to land on in the node tests, and the first version of the new assertion failed with zero rows rather than eighteen. The A1b test now inserts the eighteen rows as `NOT_STARTED` before rebuilding, which is the state a real tenant is in after the reduced package runs. The divergence itself is pre-existing and is raised below as an open item.

**Fault two, in the target (one target).** `payment-methods` failed `null !== ''` on `getAttribute('readonly')`, deterministically, while a diagnostic showed the product rendering `readonly=""` correctly. The cause was the target: the Change link navigates client-side through the detail view, whose retire form carries the code in `<input type="hidden" name="methodCode">`, and the assertion read the first match mid-navigation — a hidden input, which has no readonly attribute. The target now waits for the `edit=1` URL and scopes to `input[name="methodCode"]:not([type="hidden"])`. This is the one edit made to a target B-244 listed as dependent, and it changes when the assertion reads, not what it asserts.

**Browser results, against the production build on the reviewed database (`cairn_b210`, runtime role restricted, migration role elevated).**

| Target | Checkpoints | Result |
|---|---|---|
| `foundation` | 8 | passed — posts to `100000`/`200000` from the package's chart, workbench shows Completed |
| `controlling-area` | 9 | passed after the marks moved |
| `fiscal-year-variant-assignment` | 12 | passed after the marks moved |
| `material-mrp` | 8 | passed — plant `1000` from the builder |
| `sales-org-division` | 10 | passed — the standard pair and its sales area from the builder |
| `payment-methods` | 6 | passed after the target's locator was fixed |
| `payment-terms` | 5 | passed |

Every one of them logged `✓ builder supplied the standard structure` on the way in, which is the harness reporting that the package no longer provides it and the builder did.

**One dependent target could not be run.** `sales-org-company-code` is in `STATIC_ACCEPTANCE_TARGETS`, so the runner requires `CAIRN_TEST_DATABASE_URL` to name the owner-supplied static test database before it will touch it, and that variable is not in `.env.local`. It is unverified, not passing.

**Verification.** Typecheck clean; `lint:ip` clean over 485 files; suite **1006 passed of 1006 across 128 files**; seven browser targets, 58 checkpoints, all green against the production build.

**Open.** (1) `sales-org-company-code` awaits the owner's static database credential, as OVXK does. (2) Whether `tests/helpers.createTenant` should insert workbench rows for every activity, so that node-side tests can observe marking at all — today they cannot. (3) The four fields on `CreateTenantInput` are still accepted and ignored; B1 removes them from the form and B2 from the interface.

---

### 26.264 B-248 — Step B1: the creation screen stops asking about a company `IMPLEMENTED · NOT DRIVEN IN A BROWSER`

The screen now asks what a tenant is, not what a company inside it is. Two sections are gone — enterprise structure (Company Code, Company Name) and financial basis (Chart of Accounts, Fiscal Year Variant) — and with them the `activateStandardPackage` checkbox, which R-75 folded into a new **Creation Type** field of three radios.

**The three options.** *Empty tenant* is the default and proceeds. *Standard general data* proceeds and applies the package; its hint lists what that means now — chart `CA01` with its accounts, fiscal year variant `K4` with its periods, posting period variant `C001`, document types, exchange rates, distribution channels, divisions, purchasing groups, material types, payment terms — and says plainly that nothing in it belongs to a company. *Copy from an existing tenant* is rendered and refused: selecting it shows the refusal and its remedy in a `role="alert"` region and disables submit. No source-tenant picker is rendered, because a picker for an option that cannot proceed collects input nobody reads — the same defect class as the required-and-ignored fields this SCR removes.

**Two rulings made it into the page rather than staying in the log.** R-74 is now a hint on the tenant name — two tenants may share a name; the key is what identifies one — and the form neither claims nor validates uniqueness for it. And there is no start option anywhere, because a created tenant is available at once, which is what `client.status` already recorded.

**The refusal is server-side too.** The action reads `creationType`, refuses `copy` with the catalogue's message and remedy, and maps `standard` to activating the package. A button disabled in the browser is not a refusal: a forged POST would otherwise have created a tenant nobody asked for. The action also keeps passing `CA01` and `K4` explicitly, for one step only — the form no longer collects them, and without them the tenant settings would record no fiscal year variant while the package creates `K4`. Step B2 removes the four fields from `CreateTenantInput` and lets the service own those defaults.

**Messages.** Nine keys retired with the fields they labelled; eleven arrived for the creation type, its three options and hints, the refusal, its remedy and the name.

**Verification, as far as a UI stage goes without its acceptance.** Typecheck clean; `lint:ip` clean over 485 files; production build clean; suite **1006 passed of 1006 across 128 files**; and the built page fetched over HTTP, which confirmed the three radios with `empty` checked, the new name hint, and the absence of Company code, Company name, Chart of accounts, Fiscal year variant, Enterprise structure, Financial basis and the package checkbox, with no i18n key leaked as text.

**Not accepted.** The screen has not been driven in a browser. That is step B3, with the new target `tenant-creation` on fixture client T971, which is also where the harness's `onboard()` moves to choosing *Standard general data* at creation instead of relying on a checkbox default.

**An interruption, recovered.** Wipe #9 landed mid-step and took the git identity and remote, `node_modules`, `.next`, PostgreSQL and the running server; `.env.local` and the staged log edit survived and the local head still matched the remote. `restore-env.sh` recovered it in 34 s, and the bootstrap tenant came back showing one company code — which is the A1 builder working through `scripts/create-dev-tenant.ts`, since the package no longer writes one.

---

### 26.265 B-249 — SCR-032 · B2: the tenant-creation service, and a count finally measured by execution `IMPLEMENTED · ACCEPTED IN A BROWSER`

**The service contract now says only what the screen can ask for.** `CreateTenantInput` loses `companyCode`, `companyName`, `city`, `country` and `activateStandardPackage` — deleted rather than made optional, because an input type that still accepts them invites a caller to ask for what the screen cannot supply — and gains `creationType?: TenantCreationType`, an exported union of `'empty' | 'standard' | 'copy'` so the form and the service name the same three options. Absent or unrecognised means empty, which is the safe reading of a post that did not answer the question.

**One source for the copy refusal.** The service raises it before any write, with the remedy, and the action's duplicate refusal is deleted. The form keeps its client-side alert built from the same catalogue entry, so a user still learns it without submitting. Two refusals of one thing in two layers is how they drift apart; the sentence now exists once and both layers use it.

**The package call shrinks to client, currency and activatedBy**, and `PackageResult` now returns `fiscalYearVariant` so the service records *what the package created* into tenant settings rather than duplicating the package's default in a second place. For an empty tenant that column is null, so "no variant" reads as no variant instead of as a default nobody chose.

**The harness change, and why it is an assertion rather than a report.** `onboard()` no longer fills a company-name field that does not exist; it checks the `standard` radio. It also now asserts `structure.created` where it used to log it either way. Creation no longer supplies the structure, so the builder being reached is what keeps the other thirty-two targets meaningful — a report would let that quietly stop being true. `scripts/create-dev-tenant.ts` passes `creationType: 'standard'` so a development tenant stays one the screens recognise.

**The third measurement of the same fact, and the first by execution.** A tenant created with the reduced package carries **fourteen** completed activities: three platform marks and **eleven** from the package. The twelfth I had counted, `CFG.FIN.PAYTERMS.DEFINE`, is not a mark at all — `applyPaymentTermDefaults` writes the terms and files a change document under that code, and never calls `markActivityComplete`. So the package marked **twenty-nine** activities before the split, twenty-six in its loop and three in the material applier; the split keeps **eleven** and drops **eighteen**; and 11 + 18 = 29 closes. It should have closed the second time as well. It did not, because both sides of that sum came from reading the same source: the first count missed an applier, the second invented a mark, and checking one reading against another reading can catch neither. Creating the thing and reading the database settles it in four seconds. The correction is carried into `CAIRN-3.md` as a second footer note, again under §0.3, because D-139, §26.259 and row 2.61 are the record the next stages are checked against.

**A defect the measurement exposed, raised rather than fixed.** Because that applier files evidence without marking its activity, a tenant that took the package is asked by the workbench for payment-term work already done — the same lie the split was ordered to remove, in the one place the split did not touch. Whether the applier should mark `CFG.FIN.PAYTERMS.DEFINE`, or the payment-terms screen should own it, is the owner's call and not this step's; changing it unasked would have made eleven twelve with no ruling behind it.

**Four new tests** (`tests/tenant-creation-service.test.ts`, against the real database). The empty path is executed for the first time: no company code, no chart, no accounts, no variant in tenant settings, and exactly three platform activities complete — specifically not `CFG.ORG.COMPANYCODE.DEFINE`, which the dead branch used to mark. The copy refusal is tested as a refusal with nothing behind it: no client row, no user, no workbench state, and a message that carries a remedy. The standard path is tested for what the package does create — chart `CA01` with 74 accounts, `K4` recorded in tenant settings, sixteen period rows — and for what it must not: no company code, controlling area, credit control area, plant, storage location, purchasing organisation, sales organisation or sales area. And R-74 is tested by execution rather than by reading a migration: two tenants share a name, while a repeated key is refused and leaves the original tenant alone.

**Verification.** `npm run typecheck` clean; `npm run lint:ip` clean over 485 files; production build clean; service suite **1010 tests across 129 files, all passing** (was 1006 across 128). The reduced screen was then driven in a production build against the reviewed database: **all 7 runnable targets green, 58 checkpoints** — foundation 8, controlling-area 9, fiscal-year-variant-assignment 12, material-mrp 8, sales-org-division 10, payment-methods 6, payment-terms 5 — with `foundation` showing on the workbench the difference between what creation now does and what the builder supplies. `sales-org-company-code` remains unverifiable here for the standing reason (static-database allowlist, no credential). Chromium and its system libraries had to be reinstalled first: the ninth wipe took both, and `restore-env.sh --browser` exists for exactly this and was not run after that wipe.

**Cost.** This step ran about 75 minutes against the 39-minute box, roughly ten of them recovering the browser, and the confirmation to keep going was not sought before the overrun — the third such overrun in five steps.

**Not accepted.** The new acceptance target `tenant-creation` and the re-run of the whole runnable set are step B3. This step drove the seven targets that share `onboard()`, which is the harness change it made; it did not drive the other seventeen.

---

### 26.266 B-250 — SCR-032 · B3: the creation screen accepted in a browser, and a re-run that found four reds it has not explained `ACCEPTED IN PART`

**A new target, bound to a reviewed database like every other.** `tenant-creation` runs on the reserved fixture key **T971**, which the registry had left free, and is bound by guard to `cairn_b210:5432` — the loopback database this environment actually has — so the contract test that requires every target to name a reviewed database covers it, and the suite grew by one case selecting it independently.

**What it drives, all of it through the screen.** The copy option is refused where the operator can see it: an alert naming the refusal and a remedy, and a submit button that is disabled, so nothing is written. The empty path creates a tenant and sends the operator to sign in as its first administrator, and the workbench then reports exactly the three platform activities — no chart, no variant, no company code — with `/config/company-codes` showing nothing. The standard path reports fourteen completed activities, eleven from the package beside the three platform ones, with `CFG.FIN.COA.DEFINE`, `CFG.FIN.FYV.DEFINE` and `CFG.FIN.PPV.DEFINE` present and `CFG.ORG.COMPANYCODE.DEFINE`, `CFG.FIN.FYV.ASSIGN`, `CFG.FIN.PPV.ASSIGN` and `CFG.ORG.PLANT.DEFINE` absent; chart `CA01` is visible; and the company-code list is *still* empty, which is the point of the split. R-74 is driven rather than argued: three tenants are created sharing one name, and a fourth attempt with a key already in use is refused on the form naming the conflict.

**Probes are destroyed by the check that creates them.** The runner cleans up only the target's own fixture, so this check creates `ZT91`, `ZT92` and `ZT93` through the form and destroys them itself — once before the run, in case a previous one failed, and again in a `finally` — then asserts that none of them outlived it. A reviewed database is never left holding a probe, and a cascade that stopped working would fail the target loudly instead of quietly accumulating tenants.

**Two harness facts worth keeping.** A sign-in with no `next` parameter lands on the tenant's home, not on `/config`, so a check that signs in must ask for the workbench explicitly. And the runner signs the session out after a check and then proves a protected route refuses it, so a check must not end on a public form with nobody signed in — this one ends by signing back into its own fixture.

**R-76 was verified in code before being written down.** The screen already owns the mark on both of its paths, and the package applier files only a change document, so the ruling needed no change and the state B-249 raised is the intended one. That open item is closed.

**The re-run the owner authorised, and what it did not show.** All thirty-four registered targets were run against the production build: **twenty green**, including the new one — foundation 8, material-basic 7, material-purchasing 8, material-mrp 8, material-valuation 9, payment-terms 5, supplier-company 7, customer-sales-area 4, controlling-area 9, controlling-area-company-assignment 13, chart-of-accounts 7, gl-accounts 28, chart-of-accounts-copy 8, fiscal-year-variant-assignment 12, fiscal-year-variants 14, posting-period-variants 12, sales-org-company-code 7, sales-org-division 10, payment-methods 6, tenant-creation 13. **Nine stopped at their own database guard** without opening a browser, because they demand disposable clusters on ports 55496–55530 that this environment does not have: company-code-definition, company-code-coa-assignment, plant-definition, plant-company-code-assignment, storage-locations, purchasing-orgs, purchasing-org-company-code, purchasing-groups and sales-orgs. **One needs a credential** this environment does not carry (`business-partners` requires `CAIRN_SMOKE_FIXTURE_DATABASE_URL`).

**Four are red, and are not accepted.** `supplier-purchasing` reaches its fourth checkpoint and then finds two delivery partner-function rows where it expects one after removing the current default through the UI. `distribution-channels` and `divisions` both time out waiting for the refusal that says the object is still referenced by Sales Area configuration. `customer-company` times out. Two of the four touch data the split moved from the package to the builder — sales areas and partner functions — so they are suspects rather than bystanders, but nothing here establishes that: no discriminator run against the previous commit has been made, and this log will not guess at a cause it has not tested. Investigating them is the next deliverable, not part of this one.

**Verification.** `npm run typecheck` clean; service suite **1011 tests across 129 files, all passing**; `npm run lint:ip` clean; the new target green in a production build against the reviewed loopback database, thirteen checkpoints in under seven seconds.

**Cost.** About 55 minutes against the 39-minute box, most of the overrun in the re-run the owner authorised and then in reading two failures closely enough to report them without inventing a cause.

**Not accepted.** The four red targets above; SCR-032 closes when they are explained and either fixed or shown to be older than the split.

---

## §30 · Change log (continued)

Continues the change log of `CAIRN-3.md` §30 from version 2.61. Same rules: append only, one row per
recorded change, date and reason stated.

| Version | Date | Change | By |
|---|---|---|---|
| 2.62 | 2026-10-16 | **Document set rotated to a fourth part, and the package split's blast radius measured (B-244, §26.260).** `CAIRN-3.md` passed the 360,000-byte rotation trigger, so this part begins and is declared live; `CAIRN-3.md` is frozen to pointer edits. Measured before building anything: 12 of 33 browser targets depend on something the split removes, six of them runnable in this environment; 18 of the 40 test files that create a tenant depend on package structure, and the other 109 files are unaffected; in `src` only `standard-config.ts` and `development-fixture.ts` write the company-specific objects. The tail has one shape - a shared builder for the standard structure, written against the services the screens call and used by `tests/helpers.createTenant` and the harness's `onboard()`, which leaves all 18 files and all 12 targets as they are. Nothing implemented; sequencing put to the owner with these numbers. | Agent |

| 2.63 | 2026-10-16 | **SCR-032 sequenced into five published steps; two activity counts corrected; an `else`-branch defect found (B-245, §26.261; R-73/D-140).** The package is split before the screen is reduced, both inside one SCR with two published stages, so OBBP stays SCR-033. The package marks twenty-nine activities - twenty-six in its own loop and three in the material applier - and the split keeps eleven and drops eighteen; these are the figures measured by execution at step B2, which corrected this row's first version (thirty marked, twelve kept, counting a payment-terms mark that the applier never writes). The correction is carried into the frozen part as a footer note, which §0.3 permits for a count the next stage is checked against. Counting found that `createTenant`'s `else` branch marks `CFG.ORG.COMPANYCODE.DEFINE` complete when the package is not activated, so an empty tenant is told a company code exists that nothing created; it goes with step A2. Five steps published green in order: builder, package reduction, screen, backend, acceptance - with the builder first so that eighteen test files and twelve targets can stay untouched as the proof of the split. Still open for step B1: how the package option and Creation Type coexist. | Agent |
| 2.64 | 2026-10-16 | **Step A1b: a snapshot test proved the builder and corrected two published claims (B-246, §26.262; D-141).** `tests/standard-structure-builder.test.ts` snapshots the structure the package writes, deletes it, rebuilds it and compares - thirteen tables and four change documents, field by field, with timestamps and the sales organisation's address number excluded. Its first run caught two gaps a grep for `insert(` could not see: the package creates the controlling area to company code link through `assignCompanyCodeToControllingAreaInTransaction`, and records three change documents through `recordChange`. The builder now does both, and the claim in `f4851ff` that `CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY` had no row behind it is withdrawn - what stands is that the plant, purchasing organisation and sales organisation assignments are satisfied by a `company_code` column rather than a link table. D-141 amends D-140: services where the package used services, direct inserts elsewhere. Teeth checked by mutation - dropping one change document fails two tests. Gates: tsc clean, lint:ip clean, 1005 of 1005 across 128 files in 68 s, up by exactly the three new tests. | Agent |
| 2.65 | 2026-10-16 | **Step A2 finished green in the browser, after it found two faults (B-247, §26.263; D-142).** Three of the seven locally runnable affected targets failed on the published A2 build. Rebuilding the previous commit's product code and re-running them showed all three passing, so the faults were A2's rather than the environment's. Two were the builder's: it wrote the company code and marked nothing, and the Controlling Area panel refuses to create while `CFG.ORG.COMPANYCODE.DEFINE` is incomplete, so the eighteen activity marks moved with the rows they describe. One was a target's: `payment-methods` read the first `[name="methodCode"]` element mid-navigation, which on the detail view is a hidden input from the retire form and has no readonly attribute; it now waits for the edit URL and scopes to the visible field. Underneath, `markActivityComplete` is an update and fixture tenants from `tests/helpers.createTenant` have no workbench rows at all, so the new assertion had to insert them first - a pre-existing divergence now recorded as an open item. Seven targets, 58 checkpoints, green against the production build on `cairn_b210`; suite 1006 of 1006 across 128 files; typecheck and lint:ip clean. `sales-org-company-code` remains unverified: it is on the static-database allowlist and needs the owner's `CAIRN_TEST_DATABASE_URL`. | Agent |
| 2.66 | 2026-10-17 | **Step B1: the tenant creation screen reduced to identity, creation type and the first administrator (B-248, §26.264).** Enterprise structure and financial basis left the form, and R-75 folded the package into a Creation Type field of three radios: empty tenant, standard general data, and copy from an existing tenant - the last rendered and refused with its remedy in a role=alert region and no source picker, because a picker for an option that cannot proceed collects input nobody reads. R-74 became a hint on the name: two tenants may share one, the key identifies them, and the form validates neither. The action refuses copy server-side as well, since a button disabled in the browser is not a refusal and a forged POST would otherwise create a tenant nobody asked for; it keeps passing CA01 and K4 for one step only, until B2 lets the service own those defaults. Nine message keys retired, eleven added. Gates: typecheck clean, lint:ip clean, production build clean, suite 1006 of 1006 across 128 files, and the built page fetched over HTTP to confirm the three options render with empty checked and none of the seven removed strings survive. Not driven in a browser - that is B3 with the new target tenant-creation on T971. Wipe #9 landed mid-step and was recovered in 34 s; the bootstrap tenant came back with one company code, which is the A1 builder working through the dev-tenant script. | Agent |
| 2.67 | 2026-10-17 | **SCR-032 · B2 published: the tenant-creation service reduced, and an activity count finally measured by execution (B-249, §26.265).** `CreateTenantInput` loses the four company fields and `activateStandardPackage` and gains `creationType` (`empty \| standard \| copy`); the copy refusal moves into the service ahead of any write and the action's duplicate is deleted, so that sentence exists once; tenant settings record the variant the package actually created, and null when it created none. The harness checks the `standard` radio and now asserts that the builder was reached instead of reporting it. Executing a creation and reading the database gives fourteen completed activities - three platform, eleven package - so a count corrected twice by reading is corrected a third time by measurement: twenty-nine marked before the split, eleven kept, eighteen dropped, and the twelfth I had counted was never a mark, because the payment-terms applier files a change document under `CFG.FIN.PAYTERMS.DEFINE` without marking it. That leaves a tenant asked for payment-term work already done, raised as a defect for the owner rather than fixed unasked. Typecheck, `lint:ip` and build clean; suite 1010 tests across 129 files; all 7 runnable targets green with 58 checkpoints in a production build. Cost about 75 minutes against a 39-minute box, ten of them reinstalling Chromium after the ninth wipe, and the third overrun not confirmed in advance. Step B3 not accepted. | Agent |
| 2.68 | 2026-10-17 | **SCR-032 · B3 published in part: the new `tenant-creation` target accepted, the re-run twenty green and four red unexplained (B-250, §26.266; R-76).** The target runs on reserved key T971 bound to the reviewed loopback database, and drives the copy refusal with its remedy and disabled submit, the empty path to a workbench reporting only the three platform marks, the standard path to fourteen marks with chart `CA01` and still no company code, three tenants sharing one name for R-74, and a repeated key refused on the form. Its probes are destroyed by the check that creates them, before and in a `finally`, with an assertion that none outlived it. R-76 settles the payment-terms mark as the screen's, and code inspection showed the screen already owns it, so nothing changed and that open item is closed. Running all thirty-four targets gave twenty green, nine stopped at guards for disposable clusters this environment does not have, one needing a fixture credential, and four red - `supplier-purchasing`, `customer-company`, `distribution-channels`, `divisions` - which are recorded as unexplained rather than diagnosed, because no discriminator run against the previous commit has been made. Typecheck clean, suite 1011 across 129 files. Cost about 55 minutes against a 39-minute box. SCR-032 does not close until those four are explained. | Agent |
---

*End of this part for now. This part is the live canonical log: it is updated in the same turn as any
change to code, schema, decision or scope (§0.1). When it passes 360,000 bytes, the next part
`CAIRN-5.md` begins and this file states that the set continues there (§0.3 / D-093).*
