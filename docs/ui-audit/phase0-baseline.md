# Phase 0 audit: baseline (2026-11-17)

Method: production build (`build:check`) on :3100, Playwright Chromium, signed in as `demo.admin` on tenant DMO1, 306 static routes (2 dynamic `[param]` pages skipped) at 390px and 1280px. Per-route numbers: `phase0-routes.csv`. Screenshots are kept out of the repo.

| Measure (390px unless stated) | Result |
|---|---|
| Routes loaded OK | 299 of 300 audited (`/menu` returns 404 without its `module` param) |
| Pages with horizontal page scroll | **5**: `/purchasing/contracts`, `/purchasing/scheduling-agreements` (724px wide), `/inventory/goods-issue` (665), `/finance/assets` (489), `/inventory/migo` (465) |
| Cause | Tables (`grid-table`) outside any scroll container; `/finance/assets` a flex row |
| Pages with inputs under 16px (iOS zoom on focus) | **299 of 299** (command bar input alone triggers it) |
| Controls under 40px tall, median per page | 24 of 33 at 390px (about 39 average at 1280px, so touch sizing is also missing on desktop) |
| Worst for small controls | `/inventory/material-document-output` 276, `/config/document-types` 200, `/config/gl-accounts` 173, `/registry` 123, `/config` 106 |
| Pages containing tables | 149 of 299 |

## What this changes in the plan
- Correction: the existing small-screen CSS already stops most tables pushing the page sideways (5 of 149 table pages overflow). The proposal's claim that tables push the page sideways was overstated; the real mobile gaps are **input font size, touch target size, and inconsistent structure**, not wholesale overflow.
- Phase 1 therefore leads with the 16px / 44px base and the shared table scroll container (fixes the 5 overflow pages).
- Config and registry screens carry the most tiny controls; they stay in the last roll-out wave.
