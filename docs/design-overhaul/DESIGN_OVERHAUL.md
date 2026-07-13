# Stage Utility — Design Overhaul Spec

**Status:** approved direction, pre-implementation · **Branch:** `feat/design-overhaul` (PR per phase into `beta`) · **Date:** 2026-07-12

This spec turns the design direction settled in brainstorming into an implementation plan across four phases. It is grounded in the `impeccable` critique snapshot (`.impeccable/critique/…__stage-utility-whole-app.md`, baseline **33/40 "Strong"**), whose core finding was: *the plumbing is authored, but the surface reads templated/AI-generated.* This overhaul fixes the surface.

---

## 1. Goal

Make Stage Utility feel **intentional, distinctive, and unmistakably a broadcast/AV instrument** — not a templated web app — while unifying the two disconnected visual systems (kiosk hex/opacity vs. settings Radix) into one token layer.

## 2. Non-goals (explicit)

- **No features are removed.** All 10 settings sections, integrations, the custom-layout editor, ScriptView, Baptisms, History, Displays, mic-slots, transcription, OSC/OBS, and the custom-layout style system are preserved. Cards stay (refined; still user-toggleable in the editor).
- Not a backend/data-model change. This is presentation + a small themeable-accent feature.
- Not a kiosk light mode (stage stays dark by design).

## 3. What is removed/replaced (cosmetic/technical only)

| Removed | Replaced by |
|---|---|
| Outfit font | IBM Plex Sans/Mono (self-hosted woff2) |
| Newsreader (never shipped) | — (all-sans; no serif in-app) |
| Dead `glass-card` / `glass-dark` / `glass-sheen` utils (unused) | one elevation/material system |
| 3D JPEG `public/app-icon.png` + blue-square logo default | a real crafted mark (Branding sub-project) |

One **new feature:** Branding → Accent color picker (themeable brand accent).

---

## 4. Design principles (the locked language)

1. **Broadcast instrument, not web dashboard.** Cool neutrals, high contrast, content/status leads, chrome recedes. Reference register: Cursor, Claude, Linear, OBS, QLab.
2. **All-sans type; personality lives in the numerals + materials + restraint.** IBM Plex Sans for everything; IBM Plex Mono for every numeric/instrument readout. No serif in the app.
3. **Near-monochrome; accent used sparingly.** The themeable brand accent (default a considered blue) appears only on active nav, primary action, focus, and on-toggle. Rarity makes it read as intentional.
4. **Semantic status colors are sacred and separate from brand.** green = live/on-pace, red = over, amber = caution. On stage these *lead*; the brand accent barely appears.
5. **Soft, real materials — Pi-safe.** One elevation ramp; refined cards with a distinct **live variant**; depth via layered gradients + inset highlight + soft shadow (NOT `backdrop-filter`, which is expensive on Raspberry Pi).
6. **Generous space, quiet chrome.** Neutral sidebar that's a faint offset of content (no saturated color block); hairline separation; breathing room.
7. **Public-repo neutral, org-themeable.** Ships brand-neutral (tool's own blue-family default + generic mark + name "Stage Utility"); any org applies its real identity — accent hex, logo — via the Branding tab. Never hardcode Cornerstone.

---

## 5. Foundation system (the shared layer — Phase 1 builds this)

### 5.1 Typography

- Self-host IBM Plex Sans + IBM Plex Mono woff2 under `renderer/fonts/` (replace `Outfit-Regular.woff2`). Remove the Outfit `@font-face`.
- `renderer/styles.css`: set the base UI family to Plex Sans; add a `--font-mono` → Plex Mono and route the existing `tabular-nums` numeric readouts (clocks, timers, SPL, RF, tables) onto Plex Mono. Keep the Apple-HIG size scale utilities; retune weights for Plex (Plex 600 for headings/headline).
- `font-title` utility: repoint from Outfit to Plex Sans 600 (there is no serif). Keep the name to avoid churn, or rename to `font-display`.
- Editorial serif: **not used in-app.** If ever wanted for docs/landing, route through a single `--font-editorial` var so it's a one-place swap (design note only; not built).

### 5.2 Color & tokens

Extend the existing 3-tier token layer in `renderer/styles.css` (`--su-*`). Do **not** rebuild it.

- **Neutrals:** keep cool. Settings light = clean near-white with a whisper of cool tint (NOT cream). Settings dark + kiosk = existing near-black/Radix-dark. Radix gray scales still flip on `.dark` for neutrals + semantics — no change to that mechanism.
- **Brand accent (themeable):** replace blue-9-as-identity in `--su-accent*` with a single brand-accent hex that resolves per theme. Ship a neutral blue-family default (the tool's own values). Derive `--su-accent-hover`, `--su-accent-active`, `--su-accent-weak`, and a **dark-mode-safe lightness** from the one hex via `color-mix()`/OKLCH so one picked color works in both themes and legibly on both light and near-black surfaces.
- **Semantic status (unchanged intent, consolidated):** `--su-live-*` (green on-pace), over/danger (red), warn (amber). These are NOT the brand accent. Fix the drift (see §8).
- **On stage:** brand accent is near-absent; the live-state green/red own the hierarchy.

### 5.3 Material / elevation

- One elevation ramp replacing `glass-card`/`glass-dark`/`SURFACE_PRESETS`/`CARD_PRESETS`-glass. Steps e.g. `--elev-0` (flat), `--elev-1` (raised card), `--elev-2` (dialog/popover), each a tuned (border/inset-highlight/shadow) set per theme.
- **Card = the refined surface:** subtle raised fill + hairline border + soft shadow; near-borderless on dark.
- **Live-state variant:** a card/zone that is currently live gets the on-pace green border + soft glow (gradient + box-shadow, no backdrop-filter). This is the "live owns the screen" primitive, reusable across dashboard, stage, slots.
- The custom-layout `LayoutStyle.boxShadow`/`background` presets re-map onto this ramp (keeps saved layouts working; `boxShadow` already exists per prior work).

### 5.4 Motion

- 150–250ms, ease-out; state-conveying only (hover/focus/active/enter-leave, live→over transition). No decorative page-load choreography. `prefers-reduced-motion` honored (already partially in place).

### 5.5 Theming plumbing (new accent feature)

Follow the house settings-plumbing chain: `settings-store.ts` (branding.accent hex field + default) → `stage.ts`/`types.d.ts` (state) → `stage-controller.ts` (setter + broadcast + patch) → `remote-server.ts` (POST route) → `renderer/lib/api.ts` → `renderer/settings/types.ts` + `settings-view.tsx` (handler) → `branding-section.tsx` UI. At runtime, inject the chosen hex into `--su-accent` on the root and let `color-mix()` derive the ramp. Branding picker = preset swatches + custom hex + "sample from logo". Guard secure-context APIs (prod is plain HTTP).

---

## 6. Phase 1 — Foundation

**Outcome:** the token/type/material layer both worlds draw from, plus the accent feature and the audit bug fixes. Mostly non-visual-breaking; instantly shifts the whole feel.

**Tasks**
1. Fonts: add Plex Sans/Mono woff2; swap `@font-face` + base family + `font-title`; route numerics to Plex Mono; remove Outfit.
2. Tokens: extend `--su-*` with the themeable brand accent + `color-mix` ramp; cool-neutral light surface; consolidate status tokens; keep Radix `.dark` flip.
3. Material: add the `--elev-*` ramp + refined-card + live-variant utilities; delete dead glass utils; re-map `CARD_PRESETS`/`SURFACE_PRESETS`.
4. Accent feature: full plumbing chain + Branding picker UI + runtime var injection.
5. Bug fixes (§8).
6. Rewrite the stale `STYLE_GUIDE.md` to document the new system.

**Files:** `renderer/styles.css`, `renderer/fonts/*`, `index.html`/`settings-window.html` (font preloads, theme boot), `renderer/components/ui/*` (verify token usage), `renderer/settings/sections/branding-section.tsx`, the plumbing chain files, `main/services/settings-store.ts`, `STYLE_GUIDE.md`.

**Verify:** `npx tsc --noEmit` + `npm run build` clean; restart backend; hard-refresh; both worlds render with Plex + new accent; pick an accent in Branding → live-updates both themes; kiosk unaffected functionally; contrast AA on body text.

**Risks:** font swap shifts metrics (retune sizes/weights); accent contrast on both themes (the `color-mix` dark-safe step must be verified); `.dark` flip regressions.

## 7. Phase 2 — Stage / kiosk surfaces

**Outcome:** the confidence-monitor language across the kiosk.

**Tasks**
1. Extract one `KioskCard` primitive (accent/live/idle variants) — kills the duplicated `Tile`/`Cell` in `dashboard-view.tsx` and `stage-display-view.tsx`.
2. Hero readouts: clock/countdown/SPL/RF in Plex Mono at scale; the **live-owns-the-screen** treatment (on-pace green → over red) on the current item.
3. Restyle `dashboard-view`, `stage-display-view`, `display-picker-view`, `transcription-view`, mic-slots (`slots-columns`/`slot-panel`), `spl-rundown`/`script-view` tables, and empty/loading states (kill the generic scaffold empty state).
4. Contrast fixes for stage (raise `--su-fg-faint` off 2.3:1).
5. Custom-layout objects (`layout-renderer.tsx`) inherit Plex + the material ramp; `PeopleGraph`/graph accents use the tokens.

**Files:** `renderer/main/*`, `renderer/components/slots-columns.tsx`, `slot-panel.tsx`, `status-strip.tsx`, `brand-logo.tsx`, `layout-renderer.tsx`.

**Verify:** each display route at 1080p + a scaled window; live vs idle vs over states legible at distance; Pi-safe (no backdrop-filter); custom layouts still render identically.

## 8. Bug fixes (folded into Phase 1/2)

- **[P0]** `bg-surface0` undefined → invisible ProPresenter progress fill (`dashboard-view.tsx:190`) → use a real token (`bg-live-11`/`bg-fg`).
- **[P1]** hardcoded third green `text-[#5dcaa5]` (`dashboard-view.tsx:285`, `stage-display-view.tsx:296`) → `text-live-11`.
- **[P2]** Integrations port field renders `0` while real value sits in sub-label → bind the field to the actual value.
- **[a11y]** `--su-fg-faint` ≈ 2.3:1 on `#0a0a0a` (below AA) → raise; `placeholder:text-gray-a8` unreadable → strengthen.

## 9. Phase 3 — Settings / admin polish

**Outcome:** the Cursor/Claude-restraint settings language, everywhere.

**Tasks**
1. Grouped sidebar (Content / Output / Identity / System) with quiet labels; quiet active state (accent-tint fill, desaturated); desaturate dark toggles.
2. All-sans headings; refined status cards; consistent control vocabulary; more air.
3. Rework History's **hero-metric cliché** (big-number + sparkline ×4) into something less templated; consistent semantic number colors.
4. Retire the blue-square logo (uses the new mark once the Branding sub-project lands).
5. Empty states that teach; skeleton loading; command-palette/keyboard-nav across sections (power-user gap — optional stretch).

**Files:** `renderer/settings/settings-view.tsx`, `renderer/components/ui/sidebar.tsx`, `split-view.tsx`, all `renderer/settings/sections/*`, `renderer/components/ui/*` (Switch, Field, EmptyState, Skeleton).

**Verify:** all 10 sections at desktop + mobile widths, light + dark; nav grouping reduces scan cost; no functional regressions.

## 10. Phase 4 — Custom-layout editor (optional)

Apply the material ramp + accent + grouping to the dense `layout-editor.tsx` (~2,748 lines): group the ~17 flat style fields (Type / Fill / Border / Shadow / Layout), surface presets on the new ramp, tidy the Layers panel. Motion pass. No behavior change.

## 11. Branding sub-project (parallel, parked)

The brand **mark** is its own focused design sprint (the current 3D JPEG is being replaced). Ships a crafted, flat, scalable SVG mark (tool's own — not Cornerstone's C), themeable via the existing `brand-logo.tsx` monochrome mask. Cornerstone applies its real C logo via Branding upload. Not blocking Phases 1–3; a neutral placeholder mark is used meanwhile.

## 12. Rollout

- Branch `feat/design-overhaul` off `beta`; **one PR per phase** into `beta` (isolate, review, revert-friendly).
- Standard rules: no auto-merge to `main`, no force-push `beta`/`main`, concise PRs.
- Each phase: `tsc --noEmit` + `npm run build` clean, backend restart where needed, Playwright visual pass on affected surfaces, then PR.
- Re-run `/impeccable critique` after Phase 2 and Phase 3 to track the score off the 33/40 baseline.

## 13. Token/file reference (starting points)

- Tokens/type/material: `renderer/styles.css` (`@theme`, `:root --su-*`, `.kiosk`, `@layer utilities`).
- Theme boot: `index.html`, `settings-window.html`.
- Primitives: `renderer/components/ui/*`.
- Kiosk: `renderer/main/*`; custom-layout: `renderer/main/layout-renderer.tsx` + `main/types/stage.ts` `LayoutStyle`.
- Settings shell + sections: `renderer/settings/*`.
- Brand mark: `renderer/components/brand-logo.tsx`, `public/app-icon.png`.
- Accent-feature plumbing chain: see §5.5.
