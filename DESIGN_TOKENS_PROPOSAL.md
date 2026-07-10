# Proposal: A Shared Design-Token Layer

**Status:** Proposal (awaiting decisions in [§7](#7-decisions-for-you)).
**Companion:** [`STYLE_GUIDE.md`](./STYLE_GUIDE.md) documents the current state; this
proposes the first overhaul step it recommends — one source of truth both the kiosk
and settings worlds draw from.

---

## 1. Goal & principles

Today there are **two disconnected color systems** (kiosk = hardcoded hex + white
opacity; settings = Radix scales) and no shared definition of "the brand." This
proposal introduces a **semantic token layer** so:

- **One source of truth.** "Live," "surface," "accent," "danger" are defined once and
  reused everywhere — including custom-layout defaults.
- **Role-based, not value-based.** Components say `text-live` / `bg-surface`, not
  `#7fe3c4` / `bg-gray-2`. Re-skinning later = change the token, not 200 call sites.
- **Non-breaking.** Phase 0 seeds tokens with **today's exact values**, so nothing
  changes visually until we choose to.
- **Respects the two worlds.** The same token name resolves to the near-black stage
  palette on the kiosk and to Radix (light/dark) in settings.

Non-goals: rewriting components wholesale, changing layout/spacing behavior, or
touching the resolution-independent `LayoutStyle` math. This is about **color +
type naming**, migrated gradually.

---

## 2. Mechanism (fits Tailwind v4)

We already configure Tailwind in CSS (`@theme` in `renderer/styles.css`). Three tiers:

**Tier 1 — Primitives** (raw values, one place): the actual hexes/ramps.

**Tier 2 — Semantic tokens** (`--su-*` CSS vars), scoped by context:
```css
:root        { /* settings, light */  --su-surface: var(--gray-2);  --su-fg: var(--gray-12); … }
.dark        { /* settings, dark  */  /* Radix flips automatically; overrides only where needed */ }
.kiosk       { /* stage, always dark */ --su-surface: var(--stage-2); --su-fg: #fff; … }
```
The kiosk entry (`index.html`) adds a `kiosk` class to `<html>` (one line) so its
overrides are unambiguous. Settings inherits `:root`/`.dark`.

**Tier 3 — Tailwind utilities**: map semantics into `@theme` so we get real classes:
```css
@theme {
  --color-surface: var(--su-surface);
  --color-fg:      var(--su-fg);
  --color-accent:  var(--su-accent);
  --color-live:    var(--su-live);
  /* → generates bg-surface, text-fg, border-line, text-live, … */
}
```
Because the utilities resolve through `var()`, `bg-surface` is near-black on a
`.kiosk` page and Radix-gray in settings — automatically.

> We keep the raw Radix utilities (`gray-11`, `blue-9`, …) available; the semantic
> layer sits **on top**, so migration is opt-in, file by file.

---

## 3. The semantic token set

Proposed names and the value each resolves to per context. **Kiosk** column = stage
values (current code); **Settings** = Radix aliases (light / dark handled by Radix).

### Surfaces & lines
| Token → utility | Kiosk (stage) | Settings |
|---|---|---|
| `--su-bg` → `bg-bg` | `#0a0a0a` | `gray-1` |
| `--su-surface` → `bg-surface` | glass `rgba(255,255,255,.04)` | `gray-2` |
| `--su-surface-raised` → `bg-surface-raised` | `rgba(255,255,255,.06)` | `gray-3` |
| `--su-line` → `border-line` | `rgba(255,255,255,.09)` | `gray-a4` |
| `--su-line-strong` → `border-line-strong` | `rgba(255,255,255,.15)` | `gray-a6` |

### Foreground (text) ramp
| Token → utility | Kiosk | Settings |
|---|---|---|
| `--su-fg` → `text-fg` | `#fff` (white/90–100) | `gray-12` |
| `--su-fg-muted` → `text-fg-muted` | `white/70` | `gray-11` |
| `--su-fg-subtle` → `text-fg-subtle` | `white/45` | `gray-10` |
| `--su-fg-faint` → `text-fg-faint` | `white/25` | `gray-8` |

### Accent (interactive)
| Token → utility | Kiosk | Settings |
|---|---|---|
| `--su-accent` → `bg-accent` / `text-accent` | *(see §4.2)* | `blue-9` |
| `--su-accent-hover` | | `blue-10` |
| `--su-accent-active` | | `blue-11` |
| `--su-accent-ring` → `ring-accent` | | `blue-8` |
| `--su-on-accent` → `text-on-accent` | `#fff` | `#fff` |

### Status (semantic, shared)
| Token → utility | Value (both worlds) | Use |
|---|---|---|
| `--su-live-9` → `bg-live` | `#2dd496` (jade, fill) | live dot, active tile fill/border tint |
| `--su-live-11` → `text-live` | `#7fe3c4` (jade, text) | "LIVE", on-pace countdown, current item |
| `--su-danger-9/11` → `bg-danger`/`text-danger` | Radix `red-9/red-11` | over-time, recording, errors, destructive |
| `--su-warn-9/11` | `#f59e0b` / `amber-11` | caution, "recorded" state, unsaved |
| `--su-ok-9/11` | Radix `green-9/11` | success, RF/battery healthy |
| `--su-info-9/11` | `blue-9/11` | informational |

### Kiosk-only extras
| Token | Value | Use |
|---|---|---|
| `--su-glass-fill` | `rgba(255,255,255,.04)` | glass card fill |
| `--su-glass-border` | `rgba(255,255,255,.09)` | glass card hairline |
| `--su-bar` | `rgba(0,0,0,.50)` | brand top bar (with `blur(20px) saturate(1.6)`) |

---

## 4. Reconciliations

### 4.1 The live-accent teal (fixes "drift")
Rather than "pick one of `#7fe3c4` / `#2dd496`," **define a two-stop jade ramp** and
give each a role (mirroring Radix's `9 = fill`, `11 = text` convention):

- **`--su-live-9 = #2dd496`** → dots, fills, tile tints (`bg-live/…`, current-row
  `#2dd49618` becomes `bg-live/10`).
- **`--su-live-11 = #7fe3c4`** → text/lines ("LIVE", live countdown, current title).

Both existing colors survive, but **used intentionally** instead of interchangeably.
The lone `#22c55e` status-on dot folds into `--su-live-9` (or `--su-ok-9` if we want
"connected" ≠ "live"). *Starting values; fine-tune the hue in-browser once wired.*

### 4.2 Accent: blue vs. teal (a brand decision)
The admin's primary-action color is **blue**; the stage identity is **teal/green**.
Two coherent options:

- **Option A — Dual accent (recommended, low-risk):** keep **blue = "interactive
  control"** (admin buttons/toggles/focus) and **teal = "on-air / live identity"**
  (stage). Make it a *documented rule*, not an accident. `--su-accent` = blue in
  settings; the kiosk mostly uses `--su-live` and has little "accent" surface.
- **Option B — Unify on teal (bolder):** `--su-accent` = the jade ramp everywhere, so
  admin primary actions match the stage brand. More cohesive, but recolors every
  primary button and needs a contrast/AA check on the jade.

I lean A for the first pass (it's a rename, not a reskin) and revisit B if we want a
stronger single-brand feel.

### 4.3 Type scale (fixes "named scale vs. raw px")
The raw sizes in components **are** the named scale, just written inconsistently:

| Raw | Named equivalent |
|---|---|
| `text-[11px]` | `text-caption2` (11/13) |
| `text-[12px]` | `text-caption1` (12/16) |
| `text-[13px]` | `text-footnote` (13/18) |
| `text-[15px]` | `text-subheadline` (15/20) |

Proposal: **name a small "UI text" subset** for the form/control workhorses and
migrate raw `text-[Npx]` → named classes, so line-heights are consistent and future
type tweaks are one-place. Optionally add an ESLint rule discouraging new raw
`text-[…px]`. Lowest-churn, do it opportunistically alongside token migration.

---

## 5. What components look like after

```diff
- <span className="text-white/70 text-caption1">Starts in</span>
+ <span className="text-fg-muted text-caption1">Starts in</span>

- <div className="border-white/8 bg-white/4 rounded-xl">        {/* kiosk tile */}
+ <div className="border-line bg-surface rounded-xl">

- <tr className={isCurrent ? "bg-[#2dd49618]" : ""}>
+ <tr className={isCurrent ? "bg-live/10" : ""}>

- <span style={{ color: "#7fe3c4" }}>LIVE</span>
+ <span className="text-live">LIVE</span>

- <Button className="bg-blue-9 …">          {/* settings — unchanged under Option A */}
+ <Button className="bg-accent …">
```

Custom-layout defaults (`CARD_PRESETS`, object default styles) reference the same
tokens, so a stage restyle propagates to authored layouts too.

---

## 6. Migration plan (each phase ships independently)

- **Phase 0 — Seed (no visual change).** Add Tier 1–3 to `renderer/styles.css` with
  today's exact values + the `kiosk` root class. Nothing consumes them yet. Safe to
  ship immediately.
- **Phase 1 — Reconcile live-teal.** Introduce `--su-live-9/11`; replace the scattered
  `#7fe3c4` / `#2dd496` / `#22c55e` with `text-live` / `bg-live`. Small, visible-win.
- **Phase 2 — Kiosk surfaces & text.** Migrate `renderer/main/*` and the slot/panel
  components from white-opacity + hex to `bg-surface`/`text-fg-*`/`border-line`. Do it
  per view; each is self-contained.
- **Phase 3 — Settings alias.** Point `--su-*` at Radix and swap `gray-*`/`blue-*` for
  semantic utilities in `components/ui/*`. Mostly a visual no-op; unlocks future
  re-theming from one place.
- **Phase 4 — Type scale.** Migrate raw `text-[Npx]` → named classes; optional lint.
- **Phase 5 — (Optional) accent decision.** If we choose Option B, flip `--su-accent`
  to teal and QA contrast.

Each phase: `tsc` + `build` + eye-check on a display and in settings; commit to beta.

---

## 7. Decisions for you

1. **Accent model** — Option A (blue=control, teal=live; recommended) or Option B
   (unify on teal)?
2. **Live hue** — keep the `#2dd496` / `#7fe3c4` jade ramp as the reconciled live
   color, or do you want to try a different stage-accent hue (e.g. a cooler cyan or a
   warmer green) while we're at it?
3. **"Connected" vs "live"** — should a connected-but-not-live status dot be the same
   jade as live, or its own `--su-ok` green? (Affects how much "green" is on screen.)
4. **Token prefix / utility names** — `--su-*` + utilities like `bg-surface`/`text-fg`
   (my proposal), or a different convention?
5. **Scope** — start with **Phase 0 + 1** only (seed + reconcile teal, very low risk),
   or authorize the whole plan through Phase 4?

---

## 8. Risks & mitigations

- **Contrast regressions** (esp. Option B teal buttons) → check AA on text/among tiles
  before shipping each phase.
- **Tailwind v4 `var()`-in-`@theme`** works for colors, but arbitrary opacity
  (`bg-live/10`) requires the token be a real color (it is) — verified pattern.
- **Kiosk `.kiosk` root class** must be added to `index.html` only (not settings) so
  scoping is clean; a missing class = kiosk falls back to `:root` values (still dark,
  just Radix-gray surfaces) — degrades gracefully, not broken.
- **Churn** is bounded by phasing; Phase 0 is inert, so we can adopt the layer now and
  migrate call sites whenever.
