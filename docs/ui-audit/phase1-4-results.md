# UI modernisation results (branch `ui-change`)

Measured with Playwright against the production build (`build:check`, native server on :3100), demo tenant DMO1, 300 routes (`/menu` is 404 by design).

| Metric (390 px wide) | Baseline | After Phase 4 part 1 |
|---|---|---|
| Routes with horizontal page overflow | 5 | 0 |
| Controls under 44 px (all routes) | ~10,000 (est. half of 20,132 across both widths) | 5,482 |
| Text under 12 px | ~3,100 | 0 |
| Tables wider than the viewport (scroll inside `.table-scroll`) | 5 | 7 (all scroll inside their own container) |

Remaining small targets are mostly links inside table cells and config tables; compact desktop density is kept on purpose.

## What changed
- Phase 1: tokens, mobile base styles (16 px inputs, 44 px targets), table scroll wrapper.
- Phase 2: shell (sidebar icons, command bar on its own row, Radix session menu, Lucide bell), sticky `.action-row` on phones.
- Phase 3: `src/ui/kit` (Button, Chip, Notice, Card, Page, Field, FormGrid, ActionRow, Table, KeyValue, Dialog); sales and purchasing orders migrated. Item grid labels each cell on phones.
- Phase 4 part 1: one status palette (`signal-*` tokens) replaces red/amber/green utilities in 174 files.

Business logic, service functions and `actions.ts` are untouched. `development` keeps the old look.
