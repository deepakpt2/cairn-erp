# Cairn UI Refresh Proposal

Status: proposal, for approval. Scope: look and feel only, plus making every screen usable on a phone. No change to business rules, service functions in `src/modules/*`, `actions.ts`, routes, permissions, the database, or what each screen shows.

Revision note: an earlier draft proposed a component-library rebuild, command palette, PWA, dashboards and card layouts. That was dropped. This is an ERP: users want a pleasant, clean screen with everything they need visible at once.

## 1. Principles

1. **Everything stays on the screen.** No accordions, tabs, "show more", hidden columns, drawers for content, or card views that drop fields. If a screen shows a field or column today, it shows it afterwards, on desktop and on mobile.
2. **Same layout, better finish.** Same pages, same positions of fields, buttons and tables. Users should recognise their screens immediately.
3. **Density is a feature.** Rows stay compact. We improve readability (alignment, contrast, spacing rhythm, type), not whitespace.
4. **No fancy features.** No animations beyond basic hover and focus, no dashboards, no new widgets.
5. **CSS-first.** Most of the change lands in design tokens and the existing shared classes, so hundreds of pages improve without being edited.

## 2. Where we are today

| Area | Finding |
|---|---|
| Stack | Next 15, React 19, Tailwind 3.4. No component library. 308 pages, 429 `<table>`s. |
| Styling | Tokens in `tailwind.config.ts`; shared classes in `globals.css` (`.grid-table`, `.btn-*`, `.chip-*`, `.field-*`, `.panel`, `.section-head`). |
| Look | Warm paper, teal accent, 2px radii, 10.5–18px type (body 13.5px), light only. Functional but plain and a little harsh: tight borders everywhere, small type, flat grey headers. |
| Mobile | Sidebar is already a drawer below `md`. Pages are desktop layouts squeezed down; breakpoints are inconsistent (about 2,400 `sm:`, 400 `lg:`, 34 `md:`); wide tables rely on a small-screen override. |
| Keep | Server rendering, no-JS command bar, tabular numerals, contrast fixes, focus ring, RTL-safe logical properties. |

## 3. Visual refresh (all screens, mostly via tokens and shared classes)

- **Typography:** self-hosted Inter (via `next/font`, tabular figures on) for crisper numbers and text. Body 14px (from 13.5px), table text 13px, clear title/section/label scale. Same density, easier to read.
- **Colour:** keep the warm neutral and teal identity, but soften it: lighter borders, a subtle tinted table header instead of a heavy grey one, gentle row hover, calmer status chips (soft background, dark text, plus a small icon or text so meaning never depends on colour alone). Re-check all pairs for 4.5:1 contrast.
- **Shape and depth:** 4–6px radius on controls and panels (from 2px), hairline borders, a very light shadow on popups only.
- **Forms:** consistent label/field alignment, clear focus and error states, error text under the field, disabled and read-only states that look different from editable fields. Same fields in the same places.
- **Buttons:** one primary per area, clear secondary and danger styles, consistent height.
- **Tables:** sticky header on long lists, right-aligned tabular numbers, clearer totals row, readable row separators, selected-row highlight. Same columns.
- **Icons:** a small set of Lucide icons only where they replace nothing visible: status chips, the search field, notification bell, sort arrows. No icon-only navigation.
- **Page chrome:** cleaner top bar and sidebar styling (same items, same order), breadcrumb unchanged, status bar restyled. The command bar stays exactly as it works today.
- **Optional dark theme:** cheap once tokens are variables; off by default. Include only if you want it.

## 4. Mobile and tablet (everything visible, nothing folded)

- **Page layout:** content stacks in a single column on small screens. Field groups that sit side by side on desktop stack in the same order. All fields remain visible and in sequence; no collapsing.
- **Tables:** keep them as tables, with **all columns**. Inside the table's own bordered container, scroll horizontally with a sticky first column (document number or key). Header stays sticky. The page itself never scrolls sideways. No conversion to cards, because cards hide or reorder data.
- **Totals and key actions:** Save, Post, Release and other primary buttons stay in the same order as desktop, but the action row is sticky at the bottom on small screens so it is reachable without scrolling back up.
- **Touch comfort:** 16px inputs (stops iOS zoom), 44px minimum height for buttons and inputs on touch screens, `inputmode` for number fields, native date pickers. Spacing between rows increases slightly on touch only, via a media query, not a separate layout.
- **Navigation:** the existing drawer menu stays, restyled. The command bar stays at the top.
- **Breakpoints:** standardise on `md` (768px) as the shell switch and drop ad-hoc breakpoints as pages are touched.
- **Meta tags:** `theme-color`, and safe-area padding. No PWA, offline mode or app install.

## 5. Optional: Classic / Refreshed switch

Because the refresh is token-based, both looks can coexist cheaply. `data-theme="classic" | "refreshed"` on `<html>` swaps the tokens (radius, font, colours, spacing). Layout and content are identical in both. The setting lives in the personal menu and a cookie, applied server-side so there is no flash. It also gives an instant rollback while the refresh settles. Cost: about 3–4 days. Recommended if some users are cautious about change; skip it if you'd rather ship one look.

## 6. Delivery plan

| Phase | Scope | Effort |
|---|---|---|
| 0. Audit | Playwright screenshots of all 308 pages at 390, 768 and 1280px. List pages that break on mobile (overflow, clipped buttons, tiny targets). Agree the palette and type on 3–4 sample screens | 1 wk |
| 1. Tokens and shared classes | Move tokens to CSS variables; new font, colours, radii, table header, chips, buttons, fields via the existing classes in `globals.css`. Every screen changes at once with no page edits. Optional theme switch | 1–2 wks |
| 2. Shell | Restyle command bar, session bar, sidebar, status bar, notification bell; mobile drawer polish; sticky action row | 1 wk |
| 3. Mobile fixes | One shared scroll-container pattern for tables (sticky first column and header); single-column stacking for form grids; fix pages found in Phase 0, module by module | 3–4 wks |
| 4. Polish | Accessibility pass (contrast, focus, targets), print/PDF views unchanged and checked, final regression screenshots | 1 wk |

Total about 7–9 weeks for one developer, and the visible refresh arrives after about 3. Phase 1 is the biggest single improvement for the least risk.

## 7. Engineering rules

- Changes are in `tailwind.config.ts`, `globals.css`, `src/ui/*` and page layout classes. **Service functions and `actions.ts` are not modified.**
- No new component library. If one popup or select needs behaviour we lack, we add a single Radix primitive for it; otherwise nothing new. Lucide is added for the few icons above. Either needs `npm install`, then `docker compose restart app`.
- Update `docs/codemap/shared.md` and run `node scripts/codemap-index.mjs` if files move.
- Existing tests keep passing; tests that assert on markup are fixed together with the page that changes.
- Visual regression with Playwright at the three widths on a sample of pages, one browser at a time because of workbench memory.
- Print and PDF output (`DocumentPrint`, exports) are not restyled by the refresh unless you ask.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Users dislike change | Same layout and density; optional Classic switch |
| Larger type pushes content wider or taller | Check in Phase 0 on the densest screens; tune the scale before rollout |
| Some wide screens still awkward on a phone | Table scroll with sticky key column; list any that need a per-page fix |
| Tests assert on markup or strings | Triage in Phase 0 and fix with each change |
| Scope creep into features | Look and feel only; ideas go to `docs/OPEN-GAPS.md` |

## 9. Decisions needed

1. Approve softening the existing teal and warm identity (rather than a new palette).
2. Approve Inter as the font.
3. Include the Classic / Refreshed switch (section 5)?
4. Include the optional dark theme?
5. Mobile scope: all screens made usable (recommended), or only the field-work screens first (approvals, goods movement, stock count, time and leave)?
