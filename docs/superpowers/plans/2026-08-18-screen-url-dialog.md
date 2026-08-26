# Screen URL Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit a screen's URLs in a centred dialog opened from its three-dot menu, instead of an accordion inside the card.

**Architecture:** The existing `showSlug` block moves verbatim into the existing `Dialog` primitive. The one behavioural change is that the slug saves on an explicit Save rather than on blur, so a server rejection stays visible.

**Tech Stack:** React 19, the repo's `Dialog` (`renderer/components/ui/dialog.tsx`), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-18-screen-url-dialog-design.md`
**Mockup:** https://claude.ai/code/artifact/8d84782a-dd78-46e9-b788-589580c7f7d5

## Global Constraints

- No emojis anywhere — UI, code, comments, commit messages.
- A guard ships with proof: reintroduce the bug, watch it go red, say so in the commit.
- Drive the real UI in a browser against a **copy** of the config. Never `~/.stage-utility`.
- Run `npm run lint && npm run type-check && npm test && npm run build` before committing.

## File Structure

| File | Responsibility |
|---|---|
| `renderer/settings/sections/screen-urls-dialog.tsx` | The dialog: permanent URL, slug field, Save/Cancel, error. |
| `renderer/settings/sections/outputs-section.tsx` | Menu item opens it; the inline block and `showSlug` go. |

---

### Task 1: The dialog

**Files:**
- Create: `renderer/settings/sections/screen-urls-dialog.tsx`
- Modify: `renderer/settings/sections/outputs-section.tsx`

**Interfaces:**
- Produces: `<ScreenUrlsDialog open onOpenChange outputName outputUrl baseUrl slug onSave />`
  where `onSave(slug: string): Promise<void>` rejects with the server's reason.

- [ ] **Step 1: Build it**

State: `value` (the field), `error`, `busy`. On submit it trims and lowercases,
calls `onSave`, and on success closes; on rejection it sets `error` and stays
open. Cancel and Escape close without saving. `onOpenChange(false)` resets
`value` back to the stored slug so a discarded edit does not persist in the
component.

The form is a `<form onSubmit>` so Enter saves without a mouse.

- [ ] **Step 2: Swap the trigger**

In `OutputRow`, replace `setShowSlug((v) => !v)` with `setUrlsOpen(true)`, drop
the `showSlug` state and the whole `{showSlug && (...)}` block, and render
`<ScreenUrlsDialog … onSave={onSetSlug} />`. The menu label becomes `URLs and
friendly link` with no Hide state, since a dialog has its own close.

- [ ] **Step 3: Prove the rejection stays visible**

The server refuses a reserved slug. With a test server on a copied data dir:

```bash
# In the browser: open the dialog, type "history", press Save.
# Expected: dialog STAYS OPEN, shows the server's reason, and GET /api/stage
# still reports the previous slug.
```

Then reintroduce the bug — change Save to close the dialog before awaiting
`onSave` — and confirm the rejection becomes invisible. That is the defect this
task exists for.

- [ ] **Step 4: Drive the rest in a browser**

Open from the menu; card height does not change. Escape discards. Enter saves. A
valid slug saves, closes, and the card's URL line updates.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run type-check && npm test && npm run build
git add renderer/settings/sections/
git commit -m "feat(screens): edit a screen's URLs in a dialog"
```

## Self-review

Spec coverage: dialog from the menu → Task 1 step 2; explicit Save with the
error held open → step 1 and proven in step 3; Escape/Cancel discard → step 4;
Enter saves → step 1; card stops resizing → step 4. No gaps.
