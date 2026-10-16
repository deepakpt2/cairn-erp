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

---

## §30 · Change log (continued)

Continues the change log of `CAIRN-3.md` §30 from version 2.61. Same rules: append only, one row per
recorded change, date and reason stated.

| Version | Date | Change | By |
|---|---|---|---|
| 2.62 | 2026-10-16 | **Document set rotated to a fourth part, and the package split's blast radius measured (B-244, §26.260).** `CAIRN-3.md` passed the 360,000-byte rotation trigger, so this part begins and is declared live; `CAIRN-3.md` is frozen to pointer edits. Measured before building anything: 12 of 33 browser targets depend on something the split removes, six of them runnable in this environment; 18 of the 40 test files that create a tenant depend on package structure, and the other 109 files are unaffected; in `src` only `standard-config.ts` and `development-fixture.ts` write the company-specific objects. The tail has one shape - a shared builder for the standard structure, written against the services the screens call and used by `tests/helpers.createTenant` and the harness's `onboard()`, which leaves all 18 files and all 12 targets as they are. Nothing implemented; sequencing put to the owner with these numbers. | Agent |

---

*End of this part for now. This part is the live canonical log: it is updated in the same turn as any
change to code, schema, decision or scope (§0.1). When it passes 360,000 bytes, the next part
`CAIRN-5.md` begins and this file states that the set continues there (§0.3 / D-093).*
