# Aion webapp UI conventions

The design system's source of truth is the code — this file is the map. Each
rule below names the file that owns it; when they disagree, the file wins.

## Tokens

- All colors are HSL triplets in `src/index.css`, consumed as `hsl(var(--x))`.
  The base block is copied verbatim from Aion-Platform — **never hand-tune it
  locally**; app-specific tokens (`--kc-*`, `--surface-rail`) go in the
  marked local-additions blocks below it.
- `--clay` is a statistical verdict (a backtest that lost money);
  `--destructive` is a failure (a backtest that crashed). Never collapse the
  two — doctrine in `src/components/ui/notice.tsx` and `badge.tsx`.
- `--type-*` (agenda) and `--kc-*` (keycard canvas) are identity hues only,
  never verdicts. Keycard maps go through `src/lib/keycardGraph/palette.ts`
  (`solid()`/`wash()`), not raw hex.
- `--surface-rail` is the sidebar chrome; dark aliases `--surface-1`.
- Dark mode is `.dark` redefining tokens — token classes need no `dark:`
  variant. `src/lib/regimeTone.ts` is deliberately raw Tailwind (needs a color
  space apart from primary/clay) and is pinned by `regimeTone.test.ts`.
- UserMenu avatar gradients and the sun/moon theme-toggle glyphs are
  deliberate raw-palette exceptions (identity/iconography, not semantics).

## Type

- Base face is Hanken Grotesk (loaded in `index.html`); `font-serif` is
  aliased to it (brand v2) — never rely on it meaning serif. `font-mono`
  (IBM Plex Mono) is for **data**: figures, expressions, identifiers. Chrome
  (tabs, labels, buttons) is sans.
- The micro scale is named in `tailwind.config.js`: `text-tiny` 9px,
  `text-micro` 10px, `text-label` 11px, `text-caption` 12px, `text-body-sm`
  13px. **No arbitrary `text-[Npx]`** — pick the nearest step.
- The eyebrow label is `<MicroLabel>` (`src/components/ui/micro-label.tsx`),
  pinned by its test: sans, micro, uppercase, tracking-wider, muted/70 — no
  added weight (uppercase + weight reads as block letters). Don't paste the
  string; use the component.
- `text-2xl` is the ceiling for hero numbers; `PageHeader`'s `text-lg` is the
  page-title size; `CardTitle` is `text-base`.

## Primitives (`src/components/ui`)

- **Panel vs Card**: Panel is the tight titled section (55px chrome, micro
  title); Card is the loose 24px-padded container. Their differing shadows
  (`shadow-sm` vs `shadow-card`) encode that hierarchy — keep both.
- **Notice** for every sentence the reader didn't ask for; tone per the
  clay/destructive/muted doctrine above. No hand-rolled error divs or
  destructive Cards.
- **Table / DataTable** (`ui/table.tsx`): the one `<th>` style. `numeric` on
  both header and cell for number columns. `Column<T>` lives here
  (re-exported by `CatalogBrowser`).
- **Skeleton / SkeletonText**: the house pulse is `animate-subtle-pulse`,
  never stock `animate-pulse`; `Loader2` spinners only inside a button or
  inline beside the busy action. **EmptyState**: the dashed card.
- **Tabs, three tiers**: `TabNav` = a page changing subject (sticky, under
  the header) · `Segmented` = a mode switch inside a panel · `RailTabs`
  (`ui/rail.tsx`) = the two halves of a rail. All sans. Radix Tabs is
  deliberately not used.
- **MetricTile** (`components/MetricTile.tsx`): every labelled figure;
  `hero` for the page-top size, `tone` to override sign-coloring.
  **RosterStatTile** is the icon-KPI tile (used well beyond the roster).
- **PageHeader** opens every standalone page (IndexHeader wraps it for list
  pages) and sets the browser tab title via `useDocumentTitle`. Sidebar
  headers are `h-[68px]` to meet its border — keep them aligned.

## Layout

- Header bleed `px-6 py-5`; body `p-6`; left rails `w-72`; borders
  `border-border/50` (canonical opacity — avoid drift to /30-/70 without
  reason); radius ladder only (`rounded-sm/md/lg/xl`, all derived from
  `--radius`) — no `rounded-[Npx]`.

## Copy

- Sentence case everywhere ("New portfolio", "Open orders"). "…" not "...".
  No emoji, no exclamation marks. Loading copy is a skeleton, not a sentence.

## Tests that pin style

`regimeTone.test.ts` (palette + JIT guard), `keycardFlow.test.ts`
(`hsl(var(--kc-*))` edge colors), `toFlow.test.ts` (`aion-edge-phase-*`
classes ↔ `src/styles/reactflow.css`), `macroFormat.test.ts` (zTint/tone
formats), `micro-label.test.tsx` (the label literal). Change these only in
lockstep with their tests.

## JIT rule

Tailwind only sees full literal class strings — never build class names by
interpolation (`text-${size}` breaks silently). Full-literal maps like
`agenda/typeStyles.ts` are verbose on purpose. Compose with `cn()`.

## Ops

- UI tests run **only inside the `qlib-ui` docker container**:
  `docker exec qlib-ui npm run test:unit`. Lint/tsc run natively.
- Windows host: node_modules is shared with the container — after a host-side
  `npm install/uninstall`, rerun `npm install` inside the container (and
  restart it if the mount goes stale).
