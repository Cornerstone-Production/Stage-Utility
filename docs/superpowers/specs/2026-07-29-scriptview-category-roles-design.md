# ScriptView — category roles

**Status:** approved in conversation; ready for an implementation plan.

Make ScriptView layouts work on any church's Planning Center setup, whatever they call
their note categories.

---

## The problem, with numbers

Layouts are **global**, their columns are stored as exact category **names**, and nothing
resolves those names against the service type being viewed
(`resolveScriptViewSpec` returns `layout.columns` unfiltered). Categories are defined
**per service type**, and names vary — badly.

Measured on one church, 20 service types, 130 category rows, **29 distinct names**:

| Name | Service types |
|---|---|
| Band | 19 |
| Vocals | 19 |
| Audio/Visual | 13 |
| Person | 11 |
| Audio | 7 |
| Lighting | 5 |
| Stage Manager | 1 |

- `Audio` and `Audio/Visual` both exist; **IFC defines both**.
- `MD + Playback Tech`, `MD & Playback Tech`, `Playback Tech` — three spellings of one role.
- `EG 1 (Lead)` and `EG 1 (LEAD)` differ only in case.
- `sequence` is null on **59 of 130** rows, so it cannot be relied on for ordering.
- Category counts run **0 to 14**; one service type has none.

So today an "Audio" layout renders an empty `Audio` column on the 13 service types that
say `Audio/Visual`, and an `Audio` row accent tints nothing there. Hardcoded starter
layouts are a symptom of the same fault.

## Why keyword inference alone fails

A candidate six-role keyword vocabulary was tested against all 29 names:

- `band` matched **9 categories in one service type** (Band, EG, Drums & Bass, Keys, AG,
  Strings, Aux Keys, MD + Playback Tech, Stage Manager) — that is not a role, it is
  "musicians".
- `Stage Manager` matched *band* because "man**ag**er" contains "ag".
- `video` collected Photography, Videography, Photo Booth and Graphics together.
- `Communicators` and `Other` matched nothing.

Inference can **seed** membership. It cannot be the source of truth.

## The model: a role is an editable alias set

```ts
interface CategoryRole {
  id: string;
  /** Shown as the column header. */
  name: string;
  /** PCO category names that mean this role, in priority order. */
  members: string[];
}
```

Stored once, app-wide, in `scriptview-roles.json`.

```
Audio    → ["Audio", "Audio/Visual"]
Lighting → ["Lighting"]
Guitars  → ["AG", "EG", "EG 1 (Lead)", "EG 1 (LEAD)", "EG 2 (Rhythm)"]
```

A layout column references a **role id**, not a name. Viewing any service type, the role
resolves against whatever that service type actually defines — so one Audio layout works
across all 20 service types, and across any church, because the aliases are theirs.

### Resolving a role on one item

**Join the non-empty members, in the role's member order.** That single rule covers every
case the operator described:

- one member has a note → that note shows
- the first member is blank → the next one shows
- more than one has a note → they merge, first-listed first

Measured note: the duplicate case is rare. IFC defines both `Audio` and `Audio/Visual`
but carries **no item notes at all** on any recent plan, so its duplicate is vestigial
config. The rule is still correct; it will seldom fire.

### Managing roles

A panel under Settings → ScriptView:

- **List** every role with its members.
- **Add / rename / delete** a role. Deleting one removes it from any layout that used it.
- **Add or remove a member**, choosing from every category name PCO reports across the
  configured service types — so the operator picks real names rather than typing them.
- **Reorder members**, since order is the priority chain.
- **Unassigned categories** are listed separately: any PCO category belonging to no role.
  That is how `Communicators` and `Other` get noticed rather than silently lost.

### Seeding

On first run after PCO is configured, roles are generated from the live categories:
one role per distinct category name, named after it, containing just that name. Lossless
and never wrong. Keyword matching then *suggests* merges — "Audio/Visual looks like it
belongs with Audio" — which the operator accepts or ignores. Suggestions are never applied
automatically, given the false-positive rate above.

## Starter layouts

`DEFAULT_LAYOUTS` stops hardcoding category names. A fresh install creates nothing until
PCO is configured; once it is, starters are generated from the roles that actually exist,
and a starter with no matching role is skipped. A church with only Band and Vocals gets
those two, not four broken layouts.

## Migration

Existing layouts store category names. On load:

1. For each distinct name used by any layout, create a role of the same name with that
   single member.
2. Rewrite each layout's `columns` to the matching role ids, preserving order.
3. Rewrite `accentDepartment` to a role id.

Lossless — every layout renders exactly as before. The operator then merges roles
(dragging `Audio/Visual` into `Audio`) to gain cross-service-type portability.

## Testing

Pure, no network:

- Resolution: one member with a note; first blank and second populated; both populated
  (merged, in member order); no member present in this service type (column hidden).
- Migration: names become single-member roles; column order preserved; `accentDepartment`
  carried across; running it twice changes nothing.
- Seeding: one role per distinct name; a service type with zero categories produces zero
  roles rather than failing.
- Unassigned: a category in no role is reported, and a category in two roles is reported
  too, since that makes resolution ambiguous.

## Out of scope

- Per-service-type layouts.
- Reading roles or colors from PCO — neither exists (`ItemNote` carries only
  `category_name / content / created_at / updated_at`).
- Changing the row color system, which is settled.

## Not to be forgotten

`scriptview-roles.json` **must be added to `CONFIG_FILES`** in `config-snapshot.ts` in the
same change, or it is silently absent from every backup. The drift test added earlier will
fail until it is, which is the point.
