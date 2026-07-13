# Stage Utility — Design & Style Guide

> **⚠️ Design overhaul in progress (`feat/design-overhaul`).** Parts of this guide
> are now historical. The foundation has changed — see
> [`docs/design-overhaul/DESIGN_OVERHAUL.md`](docs/design-overhaul/DESIGN_OVERHAUL.md)
> for the plan. Locked so far:
> - **Type:** IBM Plex Sans (all UI/headings) + IBM Plex Mono (all numerals). **All-sans, no serif.** Outfit retired. (§2.3 below is stale.)
> - **Neutral:** aliased to Radix **slate** (cool, AV register — not warm/cream).
> - **Accent:** themeable `--brand-accent` (one hex → whole ramp via `color-mix`), set per-org in **Branding → Accent color**; semantic status green/red/amber stay separate.
> - **Material:** one elevation ramp (`--su-shadow-1/2`) + `.su-card` / `.su-card-live` utilities (Pi-safe, no `backdrop-filter`); the `.glass-*` utils are being consolidated onto it in Phase 2.
>
> This guide gets a full rewrite once Phases 2–3 (component restyling) land.

A reference for the app's current visual system: tokens, components, and the two
distinct visual "worlds." This documents **what exists today** (grounded in the
code, with file references) so it can serve as a baseline for polish or a future
overhaul. Where the system is inconsistent, that's called out in
[§9 Observations](#9-observations--overhaul-opportunities).

---

## 1. Two worlds

The app renders two visually distinct surfaces from one codebase:

| | **Kiosk / Display** | **Settings / Admin** |
|---|---|---|
| Where | Stage monitors, `/`, `/display-N`, `/scriptview` | Settings window (`settings-window.html`) |
| Entry | `index.html` → `renderer/main/*` | `settings-window.html` → `renderer/settings/*` |
| Theme | **Always dark**, fixed | **Light or dark**, user-toggleable |
| Color model | Mostly **hardcoded hex / white-opacity** | **Radix color scales** (`gray-11`, `blue-9`, …) |
| Type sizing | **Responsive** (`clamp()`, `vmin`, fractions of canvas height) | **Fixed** px / Apple-HIG utility classes |
| Density | Spacious, legible-at-distance | Compact, information-dense |
| Aesthetic | Dark "glass tiles" over a near-black stage | Radix-flavored settings app, form-first |

They share the **Outfit** brand font, the Apple-HIG type scale, Lucide icons, and
a family resemblance in the "glass" surface treatment — but their color and sizing
systems are largely separate today.

---

## 2. Foundations

### 2.1 Tailwind

- **Tailwind v4** (`@tailwindcss/vite`), configured **in CSS** — there is no
  `tailwind.config.js`. The theme lives in an `@theme { … }` block in
  `renderer/styles.css`, with `@source` globs pointing at `main/`, `settings/`,
  `components/`, `lib/`.
- Class merging uses **`cn()`** (`renderer/lib/cn.ts` = `clsx` + `tailwind-merge`).
- No custom breakpoints — standard Tailwind, and the app only really uses **`sm:`
  (640px)** as the mobile↔desktop hinge (plus `max-sm:`).

### 2.2 Color

**Two systems, by world:**

**A) Settings — Radix color scales** (`@radix-ui/colors`, imported in
`renderer/styles.css` and mapped into Tailwind via `@theme`). Light+dark scales for
`gray, blue, green, red, amber, orange, yellow` (+ alpha `a1–a12`). The `.dark`
class on `<html>` flips every scale. Accent = **blue**.

Semantic mapping (the important part — use these, not raw hex, in settings):

| Role | Token |
|---|---|
| Primary text | `text-gray-12` |
| Secondary text | `text-gray-11` |
| Muted / descriptions | `text-gray-10` / `gray-9` |
| Faint (grips, hints) | `text-gray-7` / `gray-8` |
| App surface | `bg-gray-1` / `bg-gray-2` |
| Subtle fill (inputs, ghost hover) | `bg-gray-a2` / `gray-a3` |
| Borders | `border-gray-a4` (light) → `gray-a6` (input/focus) |
| Primary action | `blue-9` → hover `blue-10` → active `blue-11`; focus ring `blue-8` |
| Destructive | `red-9/10/11` (fills), `red-10` (icons) |
| Success | `green-9/10/11`, `green-a2/a5` (banners) |
| Caution / unsaved | `amber-6` border, `amber-2/90` fill, `amber-11` icon/text |

**B) Kiosk — hardcoded values.** The display code uses raw hex and white-opacity
directly. The recurring palette:

| Value | Meaning / use |
|---|---|
| `#0a0a0a` (`--kiosk-bg`, `.kiosk-surface`) | The stage backdrop (neutral near-black, intentionally **not** blue-tinted) |
| `#7fe3c4` | **Live / active / on-pace** teal — live countdown, current slide, "LIVE" |
| `#2dd496` | Tile-accent teal (green card fill/border, current-row highlight `#2dd49618`) — *note: drifts from `#7fe3c4`, see §9* |
| `#22c55e` | Status "on" dot (e.g. live-mode indicator) |
| `#f59e0b` | "Recorded" / amber toggle dot |
| `#14161c` | Dark table header/footer bar |
| `red-10` (Radix, referenced by var) | Over-time / recording / error |
| `#9db8ff`, `#8ab4ff`, `#5b9cff` | Light-blue accents (script columns, sparkline stroke) |
| `text-white/85` → `/70` → `/45` → `/40` → `/35` → `/25` → `/15` | Text/hairline hierarchy by opacity |
| `rgba(0,0,0,0.50)` + `blur(20px) saturate(1.6)` | The brand top-bar glass |
| Channel palette (`channel-color.ts`) | 6 stable per-channel caption colors: `#e6e6ea`, `#7fe3c4`, `#f0c060`, `#9db8ff`, `#f0a0c0`, `#b9e08a` |

### 2.3 Typography

**Fonts:** body = system UI stack; **`font-title` = "Outfit"** (self-hosted woff2,
`renderer/fonts/Outfit-Regular.woff2`) used for brand/titles.

**Apple-HIG scale** (utility classes in `renderer/styles.css`, `size / line-height`):

| Class | Size / LH | Notes |
|---|---|---|
| `text-large-title` | 34 / 41 | |
| `text-title1` | 28 / 34 | |
| `text-title2` | 22 / 28 | |
| `text-title3` | 20 / 25 | section headings |
| `text-headline` | 17 / 22, **600** | strong label |
| `text-body` | 17 / 22 | |
| `text-callout` | 16 / 21 | |
| `text-subheadline` | 15 / 20 | |
| `text-footnote` | 13 / 18 | |
| `text-caption1` | 12 / 16 | metadata |
| `text-caption2` | 11 / 13 | tiny label / uppercase section headers |

Alongside these, components frequently use raw `text-[11px|12px|13px|14px|15px]`
(13px is the workhorse for form labels/inputs). See §9.

**Kiosk sizing is fluid, not fixed:** big readouts use `clamp()` + `vmin`
(clock `clamp(2rem,9vmin,5rem)`; captions `clamp(1.5rem,4.5vmin,3.25rem)`), and
custom-layout objects size as a **fraction of canvas height** so a layout renders
identically at any resolution. Numeric readouts use **`tabular-nums`**.

### 2.4 Spacing & density

4px Tailwind scale. Conventional usage:
- **Sections:** `flex flex-col gap-6`
- **Field row internals:** `gap-1.5`
- **Button rows:** `flex flex-wrap gap-2`
- **Field padding:** `px-3 py-2.5`
- **Card/panel padding:** `p-2.5` or `p-4`
- **Section wrapper:** `px-5 max-sm:px-3 pt-5 max-sm:pt-4 pb-[50vh]` (the `pb-[50vh]` gives scroll runway)

### 2.5 Radius

Tailwind defaults, applied consistently by scale: `rounded-md` (6px, controls),
`rounded-lg` (8px, fieldsets/cards), `rounded-xl` (12px, dialogs/prominent cards),
`rounded-full` (pills/dots). Kiosk objects use a **fractional** `cornerRadius`
(~`0.0148` of canvas height ≈ 16px on 1080p).

### 2.6 Elevation, glass & motion

- **Focus ring (universal):** `focus-visible:ring-2 focus-visible:ring-blue-8`.
- **Glass utilities** (`renderer/styles.css`):
  - `.glass-card` — `rgba(255,255,255,0.04)` + 1px white inner border + soft drop shadow.
  - `.glass-dark` — `rgba(0,0,0,0.40)` + inset top highlight + shadow.
- **Motion:** `transition-colors` on interactive elements; Radix
  enter/leave via `data-[state]:animate-in/out` with `fade-in-0`/`zoom-in-95`/
  `slide-in-from-*`; sidebar width `transition-[width] duration-150`; view-to-view
  crossfade via `withViewTransition()` where supported. `motion-reduce` respected
  on skeletons.

---

## 3. The Kiosk / Display world

**Surface & chrome.** Every display sits on `.kiosk-surface` (`#0a0a0a`). Most open
with a **brand top bar**: `h-10`, `rgba(0,0,0,0.50)` + `backdrop-blur(20px)
saturate(1.6)`, `1px` white/9% bottom border; brand logo `size-5` + app name in
`text-caption1 font-title`; optional QR (top-right) when `showQr && remoteUrl`.

**Views** (`renderer/main/`): `dashboard-view` (2×2 metric tiles), `stage-display-view`
(confidence: remaining slides, clock, countdown, SPL, current/next), `transcription-view`
(full-screen captions), `script-view` / `spl-rundown-view` (rundown tables),
`display-picker-view` (`/` monitor picker), plus the `layout-renderer` custom canvas.

**Glass tiles** (dashboard/stage): near-invisible-at-rest cards — neutral
`border-white/8 bg-white/4`; accent tiles tint the teal `#2dd496` at ~8% fill / 13%
border; the current/live row highlights `bg-[#2dd49618]`.

**The custom-layout style system** — the most formalized part of the kiosk. A
`LayoutStyle` (`main/types/stage.ts`) whose sizing fields are **fractions of canvas
height**, applied by `boxStyle()`/`textStyle()` in `layout-renderer.tsx`:

```
fontSize, fontWeight, italic, uppercase, letterSpacing, color, textAlign, vAlign,
background, opacity, cornerRadius, padding, borderColor, borderWidth,
textShadow (0..1), boxShadow (0..1), lineClamp
```

- Text defaults: `#ffffff`, `fontSize 0.05·H`, weight 400.
- `textShadow` (legibility over video) and `boxShadow` (elevation) both scale by
  canvas height `H`, so shadows look right at any resolution.
- **Card presets** (`CARD_PRESETS` in `layout-editor.tsx`): `neutral` (glass), `green`,
  `red`, `amber`, `flat` — the one-click "glass tile" accents.
- **Surface presets** (`SURFACE_PRESETS`): `flat / glass / elevated / solid / outline` —
  the elevation/border dimension (composes with color accents).

**Brand logo** (`brand-logo.tsx`): two modes — **monochrome** (CSS mask filled with
`currentColor`, so it adapts to the surrounding text color — used on dark bars) or
**full-color** (`<img>`).

---

## 4. The Settings / Admin world

**Shell** (`settings-view.tsx` + `SplitView`/`Sidebar`): a two-pane split — a
sidebar (200px expanded / 56px icon rail, collapse persisted) over `bg-gray-2` with
a right border, and a scrolling content pane. On mobile it becomes a top bar +
hamburger **drawer** (`w-64 max-w-[82vw]`, edge-swipe to open, safe-area insets).
A `BrandHeader` (logo + auto-fitting app name) sits atop the sidebar; a Sun/Moon
theme toggle sits at the bottom. Ten sections: Plan, Views, ScriptView, Displays,
Integrations, Connect, Branding, History, Baptisms, Advanced.

**Theme.** `.dark` on `<html>`, key `stage-utility-theme`, with a no-flash inline
script in `settings-window.html` (falls back to `prefers-color-scheme`). Radix
scales do the rest.

**Section layout convention** (every section in `renderer/settings/sections/`):

```tsx
<div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
  <FieldSet title="…">          {/* rounded-lg border border-gray-a4 */}
    <FieldGroup>                {/* divide-y divide-gray-a4 */}
      <Field orientation="horizontal">   {/* stacks < sm, row ≥ sm */}
        <FieldContent>
          <FieldLabel>…</FieldLabel>              {/* 13px / medium / gray-12 */}
          <FieldDescription>…</FieldDescription>  {/* 11px / gray-10 */}
        </FieldContent>
        <Input | Switch | Select … />
      </Field>
    </FieldGroup>
  </FieldSet>
  {/* ad-hoc cards: rounded-xl border border-gray-a5 bg-gray-a2 p-4 */}
</div>
```

Uppercase micro-labels use `text-caption2 uppercase tracking-wider text-gray-9`.

**Interaction patterns:**
- **Buttons:** `accent` (blue, primary) · `filled` (gray, secondary) · `transparent`
  (ghost/icon). Sizes `small` (h-6) / `medium` (h-8). Icon-only auto-tooltips from
  `aria-label`.
- **Inline editing:** commit-on-blur + Enter-to-blur (local state, then persist).
- **Reorder:** dnd-kit sortable lists with a `GripVerticalIcon` (`text-gray-7`) handle.
- **Feedback:** `toast.success/error/info` (bottom-right, 4s); `confirm({…, destructive})`
  alert dialog (red confirm when destructive); `UnsavedBanner` (amber sticky bar or
  floating pill) for dirty state.
- **"Test connection":** button shows a loading label + writes an ok/error message.

**Iconography:** Lucide only, **no emojis** (hard rule). `size-4` (nav/buttons),
`size-3.5` (compact), `size-5` (prominent); default `text-gray-11`, semantic colors
for status (`green-10` ok, `red-10` danger, `amber-11` caution). Icons pair with a
label except in icon-only buttons.

---

## 5. Component library (`renderer/components/ui/`)

Radix-backed where interactive; custom where layout. All via `cn()`.

| Component | Radix? | Key styling |
|---|---|---|
| **Button** | no | variants accent/filled/transparent × small/medium; `rounded-md font-medium`; ring `blue-8` |
| **Input** | no | `h-7 rounded-md border-gray-a6 bg-gray-a2 text-[13px]`; focus `border/ring blue-8` |
| **NumberInput** | no | input + chevron steppers; hides native spinner; `tabular-nums`; `suffix` unit; commit-on-blur |
| **Switch** | yes | `h-5 w-9` track; on `bg-blue-9`, off `bg-gray-a6`; white `size-4` thumb |
| **Select** | yes | trigger like Input; content `bg-gray-2 border-gray-a6 shadow-md`; item `pl-8` w/ check |
| **Dialog** | yes | overlay `bg-black/40 backdrop-blur-sm`; content `max-w-lg rounded-xl bg-gray-1 p-6 shadow-xl` |
| **confirm / ConfirmHost** | yes (AlertDialog) | promise API; `destructive` → red confirm |
| **Field / FieldSet / FieldGroup / …** | no | the form-row system (see §4); horizontal stacks < sm |
| **Sidebar / SidebarList / …Item** | no | nav rail; active `bg-blue-9 text-white`, inactive `text-gray-11` |
| **SplitView** | no | responsive two-pane shell; desktop rail/expanded, mobile drawer |
| **ScrollArea / ScrollBar** | yes | thin thumb `bg-gray-a6`; kiosk uses a custom auto-hiding `.so-scroll` |
| **Separator** | yes | `bg-gray-a4`, 1px |
| **EmptyState** | no | dashed border, `gray-8` icon, `text-callout` title + `caption2` hint + CTA |
| **Skeleton / SkeletonRows** | no | `animate-pulse rounded-md bg-gray-a3` (motion-reduce aware) |
| **Status** | no | colored dot (`green/yellow/red/blue/gray-9`) + `text-[12px]` label |
| **InfoHint** | yes (Popover) | `size-4` `(?)` trigger → `max-w-[16rem]` popover |
| **Collapsible** | no | chevron header + summary (shown collapsed) + region |
| **Toast / Toaster** | yes | `bottom-4 right-4`; `bg-gray-2 border-gray-a6`; success/error icon |
| **UnsavedBanner** | no | amber sticky bar or floating pill; `backdrop-blur-xl` |
| **ButtonGroup** | no | `inline-flex` wrapper for segmented toggles |
| **TooltipProvider / ErrorBoundary** | yes / no | app-level plumbing |

---

## 6. Cross-cutting conventions

- **`cn()`** for all class composition (safe Tailwind conflict resolution).
- **No emojis** anywhere in UI/code/output — Lucide icons or text only.
- **`tabular-nums`** on every numeric readout (clocks, timers, SPL, RF).
- **Commit-on-blur** for text/number fields that persist to the server.
- **dnd-kit** for all reorderable lists (views, outputs, slots, scriptview layouts).
- **Safe-area insets** (`env(safe-area-inset-*)`) on kiosk + mobile chrome.
- **Fractional sizing** for anything on the custom-layout canvas (resolution-independent).

---

## 7. Quick token cheat-sheet

```
Kiosk surface     #0a0a0a          Live/active       #7fe3c4
Tile accent teal  #2dd496          Status "on" dot   #22c55e
Over/error        red-10           Recorded amber    #f59e0b
Table bar         #14161c          Brand-bar glass   rgba(0,0,0,.5)+blur(20px)

Settings text     gray-12 / 11 / 10 / 9 / 7   (primary → faint)
Settings surface  gray-1 / gray-2  ·  fills gray-a2/a3  ·  borders gray-a4/a6
Primary action    blue-9 → 10 → 11 ·  ring blue-8
Destructive red-9/10/11 · Success green-9/10/11 · Caution amber-6/2/11

Type   13px = form workhorse · caption2(11) uppercase labels · title3(20) headings
Radius md(6) controls · lg(8) fieldsets · xl(12) dialogs · full pills
Space  sections gap-6 · fields gap-1.5 · buttons gap-2 · field pad px-3 py-2.5
Focus  ring-2 ring-blue-8   ·   Font  Outfit (font-title)
```

---

## 8. File map

| Area | File |
|---|---|
| Tokens, fonts, glass, type scale | `renderer/styles.css` |
| Theme boot (no-flash) | `index.html`, `settings-window.html` |
| UI primitives | `renderer/components/ui/*` |
| Kiosk views | `renderer/main/*` |
| Custom-layout renderer + style system | `renderer/main/layout-renderer.tsx`, `main/types/stage.ts` (`LayoutStyle`) |
| Card/surface presets | `renderer/settings/sections/layout-editor.tsx` |
| Settings shell + sections | `renderer/settings/settings-view.tsx`, `renderer/settings/sections/*` |
| Slot/panel kiosk components | `renderer/components/slots-columns.tsx`, `slot-panel.tsx`, `status-strip.tsx`, `brand-logo.tsx` |
| Class helper | `renderer/lib/cn.ts` |

---

## 9. Observations & overhaul opportunities

Honest notes on where the system is inconsistent — good starting points if we do a
polish pass or overhaul:

1. **Two disconnected color systems.** Settings uses semantic Radix tokens; the kiosk
   uses hardcoded hex + white-opacity. There's no shared token layer, so the "brand"
   isn't defined in one place. *Opportunity:* promote the kiosk palette into CSS
   variables (`--live`, `--surface`, `--accent`, …) so both worlds and the custom
   layouts reference one source of truth.
2. **Accent teal drift.** "Live/active" is `#7fe3c4` in some places and `#2dd496`
   (+ its alpha tints) in others. They read as the same idea but aren't the same
   color. Pick one live-accent and derive the tile tints from it.
3. **Type scale vs. raw px.** There's a clean Apple-HIG scale (`text-body`,
   `text-caption1`, …) but components lean heavily on ad-hoc `text-[13px]`/`[11px]`.
   Consolidating onto the named scale (or aligning the two) would tighten typography.
4. **Radix accent = blue, kiosk accent = teal/green.** The admin's primary action
   color (blue) and the stage's identity color (teal) diverge. Intentional? Worth
   deciding deliberately.
5. **Glass defined in three places.** `.glass-card`/`.glass-dark` utilities,
   `CARD_PRESETS`, and `SURFACE_PRESETS` all encode "glass" with slightly different
   values. Could unify into one elevation ramp.
6. **No documented spacing/radius scale** beyond Tailwind defaults — conventions are
   consistent by habit, not enforced. A short set of named rules (or component
   coverage) would keep new sections on-pattern.
7. **Kiosk has no light mode** (correct for stage use) — but if any display is ever
   used in a bright/lobby context, there's no path. Probably fine to leave.

None of these are bugs; they're the seams a design overhaul would smooth. The system
is coherent and tasteful already — the biggest single lever is **a shared token
layer** (item 1) that both worlds draw from.
