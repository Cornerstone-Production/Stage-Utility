# Stage Utility — Design & Style Guide

> Reflects the design overhaul on `feat/design-overhaul`. The plan and principles
> behind it live in
> [`docs/design-overhaul/DESIGN_OVERHAUL.md`](docs/design-overhaul/DESIGN_OVERHAUL.md);
> this guide documents **what the code does now**, grounded in file references.

The overhaul unified two previously disconnected visual systems (the kiosk's
hardcoded hex/opacity vs. the settings' Radix scales) onto **one semantic token
layer** (`--su-*`), swapped the type system to **IBM Plex** (all-sans, mono for
numerals), made the **brand accent themeable** from a single hex, and introduced a
**material/elevation ramp** (`.su-card` / `.su-card-live`) that is Pi-safe. Semantic
status colors (live green / over red / caution amber) are kept deliberately separate
from the brand accent.

---

## 1. Two worlds

The app renders two visually distinct surfaces from one codebase. They now share a
token layer, a type system, and a material — so they read as one product in two
registers rather than two apps.

| | **Kiosk / Display** | **Settings / Admin** |
|---|---|---|
| Where | Stage monitors, `/`, `/display-N`, `/scriptview` | Settings window (`settings-window.html`) |
| Entry | `index.html` (`.kiosk` on `<html>`) → `renderer/main/*` | `settings-window.html` → `renderer/settings/*` |
| Theme | **Always dark**, fixed (`.kiosk` token overrides) | **Light or dark**, user-toggleable (`.dark`) |
| Type sizing | **Responsive** (`clamp()`, `vmin`, fractions of canvas height) | **Fixed** px / Apple-HIG utility classes |
| Density | Spacious, legible-at-distance | Compact, information-dense |
| Aesthetic | Confidence-monitor: near-black stage, live state leads | Cursor/Claude/Linear-restraint admin, form-first |

Both draw color from the same `--su-*` semantic tokens (resolved per world), the same
IBM Plex families, the Apple-HIG size scale, Lucide icons, and the `.su-card`
material.

---

## 2. Foundations

### 2.1 Tailwind

- **Tailwind v4** (`@tailwindcss/vite`), configured **in CSS** — no
  `tailwind.config.js`. The theme lives in an `@theme { … }` block in
  `renderer/styles.css`, with `@source` globs pointing at `main/`, `settings/`,
  `components/`, `lib/`.
- Class merging uses **`cn()`** (`renderer/lib/cn.ts` = `clsx` + `tailwind-merge`).
- Standard breakpoints; the app hinges mobile↔desktop on **`sm:` (640px)** (plus `max-sm:`).

### 2.2 Type system — IBM Plex

Self-hosted via `@fontsource` (woff2 bundled into `dist` at build; no runtime CDN, so
kiosks stay on a closed LAN). Imported at the top of `renderer/styles.css`:

- **IBM Plex Sans** (`--font-sans`) — the entire UI: body, labels, headings.
  Weights 400/500/600 loaded. **All-sans: there is no serif in-app.**
- **IBM Plex Mono** (`--font-mono`) — every numeric / instrument readout: clock,
  countdown, SPL, RF, tables, timers. Weights 400/500/600.

`font-title` is a utility (in `@layer utilities`) that now maps to **IBM Plex Sans**
(the name is kept to avoid call-site churn; pair with `font-semibold` where a heading
needs emphasis). There is no separate display/brand face.

**Apple-HIG size scale** (utility classes in `renderer/styles.css`, `size / line-height`):

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
| `text-footnote` | 13 / 18 | form workhorse (inputs, buttons, field labels) |
| `text-caption1` | 12 / 16 | metadata |
| `text-caption2` | 11 / 13 | tiny / uppercase micro-labels |

**Kiosk sizing is fluid:** hero readouts use `clamp()` + `vmin` (e.g. the stage
countdown `clamp(1.4rem,6vmin,3rem)` in Plex Mono; see `stage-display-view.tsx`), and
custom-layout objects size as a **fraction of canvas height** so a layout renders
identically at any resolution. Numeric readouts use `font-mono` + `tabular-nums`.

### 2.3 Color — the `--su-*` semantic token layer

Color flows through **one semantic token layer**, defined in `renderer/styles.css` and
exposed to Tailwind via `@theme` (which generates the utilities `bg-surface`,
`text-fg`, `text-fg-muted`, `border-line`, `bg-accent`, `ring-focus`, `bg-live-9`,
`text-live-11`, `bg-danger-9`, `text-warn-11`, `bg-ok-9`, `text-info-11`, …).

The two-tier structure:

- **Tier 1 — primitives.** The Radix color scales are imported and mapped into
  Tailwind. **Neutral = Radix `slate`** (a subtly cool, blue-tinted gray — the
  AV/instrument register, *not* warm cream). Slate is aliased onto the `--color-gray-*`
  names so existing `gray-*` utilities go cool-neutral in one place, no call-site churn.
  Blue/green/red/yellow/orange/amber round out the palette. A couple of brand
  primitives (`--live-9: #22c55e` emerald, `--live-11: #86efac`) sit here too.
- **Tier 2 — semantic vars** (`--su-*`), the layer everything actually consumes:

| Token | Role |
|---|---|
| `--su-bg` / `--su-surface` / `--su-surface-raised` | app / card / raised surfaces |
| `--su-line` / `--su-line-strong` | hairline / control borders |
| `--su-fg` / `-muted` / `-subtle` / `-faint` | text hierarchy (primary → faint) |
| `--su-accent` / `-hover` / `-active` / `--su-on-accent` | brand accent + text-on-accent |
| `--su-focus` | focus ring (= brand accent) |
| `--su-field` | input / control fill |
| `--su-fill` / `-hover` / `-active` | interaction fill (ghost / filled) |
| `--su-live-9` / `-11` | **live / on-pace** (green) |
| `--su-danger-9` / `-11` | **over / error** (red) |
| `--su-warn-9` / `-11` | **caution / unsaved** (amber) |
| `--su-ok-*`, `--su-info-*` | success / informational |

**Theming per world:**
- `:root` — the settings light defaults (slate + Radix scales).
- `.dark` on `<html>` — flips the Radix slate scale; accent hover/active *lighten*
  (`color-mix … white`) rather than darken; the elevation ramp switches to
  inset-highlight + soft drop shadow.
- `.kiosk` on `<html>` — always-dark near-black stage. `--su-bg` = `--kiosk-bg`
  (`#0a0a0a`, a neutral near-black chosen over a blue-tinted one); surfaces and text
  become white-opacity steps (`rgba(255,255,255,0.04 … 0.92)`); accent + status tokens
  inherit the brand values.

### 2.4 Themeable brand accent

The brand accent is a **single hex** (`--brand-accent`, default `--blue-9`). The whole
ramp derives from it via `color-mix()`:

```css
--su-accent:        var(--brand-accent);
--su-accent-hover:  color-mix(in srgb, var(--brand-accent), black 12%);  /* light */
--su-accent-active: color-mix(in srgb, var(--brand-accent), black 22%);
/* .dark / .kiosk lighten instead: color-mix(… white 14% / 26%) */
```

So one picked color works legibly in both themes. It is set per-org in **Branding →
Accent color** (`renderer/settings/sections/branding-section.tsx`): preset swatches
(`ACCENT_PRESETS` — a considered blue plus a few distinct hues), a native custom-hex
picker, and a **Default** button that clears the override. The chosen hex is injected
into `--brand-accent` on the root at runtime; empty falls back to the built-in default.
The accent appears sparingly — primary action, active nav, focus ring, on-toggle.

**Semantic status colors are sacred and separate from brand:** green = live/on-pace,
red = over, amber = caution. They are never themed and, on stage, they *lead* the
hierarchy while the brand accent is near-absent.

### 2.5 Material / elevation

Depth is a **two-step shadow ramp**, retuned per theme, and **Pi-safe — plain box
shadows, no `backdrop-filter`** (which is expensive on Raspberry Pi):

- `--su-shadow-1` — raised card. Light: soft double drop shadow. Dark/kiosk: inset top
  highlight + soft drop shadow (the quiet, material feel).
- `--su-shadow-2` — dialog / popover (deeper).

Two card utilities (in `@layer utilities`) build on the tokens:

- **`.su-card`** — the one refined surface: `--su-surface` fill + `--su-line` hairline +
  `--su-shadow-1`, `rounded-[0.875rem]`. This is the standard card across kiosk and admin.
- **`.su-card-live`** — the **"live owns the screen"** primitive: an on-pace-green edge
  (`--su-live-9`) + soft glow. Swap to red for over-time by setting `--su-live-9` to
  the danger color on the element. Used on the current/live zone in the kiosk.

`.su-card` is now used across `stage-display-view.tsx`, `dashboard-view.tsx`,
`display-picker-view.tsx`, `slot-panel.tsx`, and `status-strip.tsx`.

### 2.6 Spacing, radius, motion

- **Spacing** (4px scale): sections `flex flex-col gap-6`; field internals `gap-1.5`;
  button rows `gap-2`; field padding `px-3 py-2.5`; section wrapper
  `px-5 max-sm:px-3 pt-5 max-sm:pt-4 pb-[50vh]` (the `pb-[50vh]` gives scroll runway).
- **Radius:** `rounded-md` (6px, controls), `rounded-lg` (8px, fieldsets), `rounded-xl`
  (12px, dialogs), `.su-card`'s `0.875rem` (14px), `rounded-full` (pills/dots). Kiosk
  objects use a fractional `cornerRadius` (~`0.0148·H`).
- **Focus (universal):** `focus-visible:ring-2 focus-visible:ring-focus` (the accent).
- **Motion:** `transition-colors` on interactive elements; Radix enter/leave via
  `data-[state]:animate-in/out` (`fade-in-0`/`zoom-in-95`/`slide-in-from-*`); sidebar
  width `transition-[width]`; view-to-view crossfade via `withViewTransition()` where
  supported. State-conveying only, `motion-reduce` respected.

---

## 3. Components (`renderer/components/ui/`)

Radix-backed where interactive; custom where layout. All via `cn()`. The primitives
now consume **semantic tokens** (`bg-accent`, `bg-fill`, `text-fg`, `border-line-strong`,
`bg-field`, `ring-focus`) rather than raw Radix scales, so a theme or accent change
flows through automatically.

| Component | Key styling (token-based) |
|---|---|
| **Button** | variants `accent` (`bg-accent text-white` → `hover:bg-accent-hover`), `filled` (`bg-fill text-fg`), `transparent` (`text-fg-muted hover:bg-fill`); sizes `small` (h-6, `text-caption1`) / `medium` (h-8, `text-footnote`); `rounded-md font-medium`; ring `ring-focus`. Icon-only auto-tooltips from `aria-label`. |
| **Input** | `h-7 rounded-md border-line-strong bg-field text-footnote text-fg`; focus `border-focus ring-1 ring-focus`; `placeholder:text-gray-a8`. |
| **NumberInput** | input + chevron steppers (`ChevronUp/Down`), hides native spinner, `tabular-nums`, optional `suffix`; commits live on change **and** on each stepper click (`onChange` fires for dirty-tracking, `onCommit` on settle). The convention for all numeric fields — never a raw `<input type="number">`. |
| **Switch** | `h-5 w-9` track; on `bg-accent` (`dark:bg-accent/85`), off `bg-gray-a6`; white `size-4` thumb; ring `ring-focus`. |
| **Select** | trigger like Input (`border-line-strong bg-field`, `ring-focus`); content `bg-surface border-line-strong shadow-md`; item `pl-8` with check; `SelectLabel` = uppercase `text-caption2 tracking-wider text-gray-9`. Skips empty-value items defensively. |
| **Sidebar / SidebarList / SidebarListItem** | `bg-surface border-line` rail. **Grouped nav:** `SidebarGroupLabel` renders a quiet uppercase `text-[10px] tracking-wider text-fg-subtle` heading (degrades to a thin `bg-line` divider in the collapsed icon rail). Active item is **quiet** — `bg-accent/12 text-fg` with an `text-accent` icon (not a saturated fill); inactive `text-fg-muted hover:bg-fill`. Railed items show a right-side tooltip. |
| **Field / FieldSet / FieldGroup / FieldContent / FieldLabel / FieldDescription** | the form-row system: `FieldSet` = `rounded-lg border-line`; `FieldGroup` = `divide-y divide-gray-a4`; `Field` = `px-3 py-2.5 bg-bg`, horizontal stacks below `sm`; `FieldLabel` = `text-footnote font-medium text-fg`; `FieldDescription` = `text-caption2 text-fg-subtle`. |

Other primitives in the folder follow the same token conventions (Dialog, confirm /
AlertDialog, ScrollArea, Separator, EmptyState, Skeleton, Status, InfoHint,
Collapsible, Toast, UnsavedBanner, ButtonGroup, TooltipProvider, ErrorBoundary).

---

## 4. The Kiosk / Display world

Every display sits on `.kiosk-surface` (`--kiosk-bg` `#0a0a0a`, flat — no gradient — so
all view kinds match the slots view). Most open with a brand top bar (logo + app name
in `text-caption1 font-title`, optional QR).

`--kiosk-surface-1` (`#171717`) is the one step up, for sticky table chrome (rundown
header/footer bands) and empty-image placeholders. Both are strictly R=G=B: a near-black
with any blue bias reads "blueish" beside the neutral app shell, so ad-hoc darks like
`#14161c` or `#1a1a2e` must not come back — reach for the token.

Glass bars use `backdrop-filter: blur(20px)` **without** `saturate()`: over a coloured
stage background the saturation boost amplifies exactly the hue cast the neutral rule
exists to prevent.

**Department accents** (`rundown-table.tsx` `departmentColor`) are drawn from the same
palette the patch sheet offers, spread amber / green / blue / teal / red with a neutral
grey fallback — no purple or magenta. They must stay 6-digit hex: callers append an
alpha suffix (`` `${color}1f` ``).

**Hero readouts** (`stage-display-view.tsx`, `dashboard-view.tsx`): clock / countdown /
SPL / RF render in **IBM Plex Mono** at fluid `clamp()`+`vmin` scale with
`tabular-nums`. The current/live item uses the **live-owns-the-screen** treatment —
on-pace `text-live-11`, flipping to `text-red-10` when over. Panels are `.su-card`.

**Custom-layout style system** — the most formalized part of the kiosk. A `LayoutStyle`
(`main/types/stage.ts`) whose sizing fields are **fractions of canvas height**, applied
by `boxStyle()`/`textStyle()` in `layout-renderer.tsx` (`fontSize`, `fontWeight`,
`color`, `background`, `cornerRadius`, `borderColor/Width`, `textShadow`, `boxShadow`,
`lineClamp`, …). `CARD_PRESETS` / `SURFACE_PRESETS` (`layout-editor.tsx`) provide
one-click card accents (neutral / green / red / amber / flat) and elevation dimensions;
saved layouts continue to work.

**Brand logo** (`brand-logo.tsx`): monochrome (CSS mask filled with `currentColor`,
adapts to surrounding text color) or full-color `<img>`.

---

## 5. The Settings / Admin world

**Shell** (`settings-view.tsx` + `SplitView` / `Sidebar`): a two-pane split — a sidebar
(`bg-surface border-r border-line`, expanded / collapsed icon rail, persisted) over a
scrolling content pane; on mobile a top bar + hamburger drawer. The nav is **grouped**
via `SidebarGroupLabel` (Content / Output / Identity / System) with quiet uppercase
labels and a **quiet active state** (accent-tint fill, accent icon — no saturated
block). Sections: Plan, Views, ScriptView, Displays, Integrations, Connect, Branding,
History, Baptisms, Advanced.

**Theme.** `.dark` on `<html>`, key `stage-utility-theme`, no-flash inline script in
`settings-window.html` (falls back to `prefers-color-scheme`). Radix slate does the rest.

**Section layout convention** (every section in `renderer/settings/sections/`):

```tsx
<div className="px-5 max-sm:px-3 flex flex-col gap-6 pt-5 max-sm:pt-4 pb-[50vh]">
  <FieldSet title="…">
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel>…</FieldLabel>
          <FieldDescription>…</FieldDescription>
        </FieldContent>
        <Input | Switch | Select | NumberInput … />
      </Field>
    </FieldGroup>
  </FieldSet>
</div>
```

**Iconography:** Lucide only, **no emojis** (hard rule). Default `text-gray-*`, semantic
tokens for status (`text-ok-11` / `text-danger-11` / `text-warn-11`, or Radix
`red-10` for destructive icons). Commit-on-blur for persisted text fields; dnd-kit for
reorderable lists; toast + `confirm()` for feedback.

---

## 6. Public-repo neutrality

The app **ships brand-neutral** — the tool's own blue-family accent default, a generic
mark, and the name "Stage Utility." No org identity is hardcoded (never Cornerstone).
An org applies its real identity entirely through **Branding**: the **accent** (one hex
→ full ramp) and the **logo** (with a monochrome recolor option). This keeps the public
repo generic while letting any deployment look like itself.

---

## 7. File map

| Area | File |
|---|---|
| Tokens, fonts, type scale, `.su-card` material, `.glass-*` legacy | `renderer/styles.css` |
| Theme boot (no-flash) | `index.html` (`.kiosk`), `settings-window.html` (`.dark`) |
| UI primitives | `renderer/components/ui/*` |
| Accent picker | `renderer/settings/sections/branding-section.tsx` |
| Kiosk views | `renderer/main/*` (`stage-display-view.tsx`, `dashboard-view.tsx`, …) |
| Custom-layout renderer + style system | `renderer/main/layout-renderer.tsx`, `main/types/stage.ts` (`LayoutStyle`) |
| Card/surface presets | `renderer/settings/sections/layout-editor.tsx` |
| Settings shell + sections | `renderer/settings/settings-view.tsx`, `renderer/settings/sections/*` |
| Slot/panel kiosk components | `renderer/components/slots-columns.tsx`, `slot-panel.tsx`, `status-strip.tsx`, `brand-logo.tsx` |
| Class helper | `renderer/lib/cn.ts` |

---

## 8. Known follow-ups

- **Phase 4 — custom-layout editor polish.** The dense `layout-editor.tsx` still needs
  the material-ramp + accent + field-grouping treatment (group the ~17 flat style
  fields; surface presets on the new ramp; Layers-panel tidy). No behavior change planned.
- **Brand mark parked.** The crafted, flat, scalable SVG mark is a separate focused
  sprint; a neutral placeholder is used meanwhile (`brand-logo.tsx`, `public/app-icon.png`).
- **`.glass-*` holdouts.** The legacy `.glass-card` / `.glass-dark` / `.glass-sheen`
  utilities remain defined in `renderer/styles.css` but are effectively unused now that
  the kiosk cards migrated to `.su-card` (`slot-panel.tsx` even documents deliberately
  skipping `.glass-card`). They're pending removal once confirmed dead. (The
  `glass-green/red/amber` entries in `layout-editor.tsx` are preset *labels*, not the CSS
  utility.)
