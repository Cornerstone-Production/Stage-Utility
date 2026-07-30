# Stage Utility Roadmap — remaining work

Audit of the Asana "Stage Utility Roadmap" task on 2026-07-26. 24 sub-subtasks across
five sections; **13 verified complete in code and marked done in Asana**, 11 remain.

Completion was judged by reading the code on `beta`, not by memory — several items my
notes listed as outstanding (notably the history export) turned out to be fully built.

---

## Done and marked (13)

| Section | Item | Evidence on `beta` |
|---|---|---|
| UI | Transparent dropdowns | `--su-popover` glass token, `styles.css` |
| UI | Multi-select layers in editor | marquee + selection + clipboard, `layout-editor.tsx` |
| UI | Start from blank / optional template | "Start from" picker, `views-section.tsx:451` |
| UI | Declutter Advanced tab | 5 `Collapsible` groups, `advanced-section.tsx` |
| UI | Better spot for sidebar collapse | footer bar with theme toggles |
| UI | Plan tab not first / hide inactive types | default → Views; `allowedServiceTypeIds` disclosure |
| UI | Integrations mobile clipping | `min-w-0` fixes, `integrations-panel.tsx` |
| UI | Clean up Displays page | per-display cards with status dot, `outputs-section.tsx` |
| UI | Companion → Connect tab | `CompanionInfoPanel` in `connect-section.tsx:91` |
| History | Export attendance/SPL/history | `history-export.ts` + write-excel-file + Export builder UI |
| History | Stats per service type | `serviceTypeId` scoping in the history section |
| History | Hover tooltips on graph | crosshair/tooltip in `attendance-history-section.tsx` |
| History | History on its own URL | `history-view.tsx`, routed at slug `history` |

One caveat on the export: it produces a **multi-sheet .xlsx**, not the "CSV/MD" the
task named. The capability is there and configurable, so it is marked done — but if
CSV specifically matters for handing data to someone, that is a small follow-up
(§R11) rather than a reopen.

---

## Remaining (11), in recommended order

### R1. Integrations save/discard should match the patch sheet
**Asana:** `1216902079620655` · **Size:** XS · **Risk:** none

`integrations-panel.tsx` uses inline `<Button>Save</Button>` in three places (lines
~318, ~648, ~835), while the patch sheet and layout editor use the shared
`UnsavedBanner` (message + Save + Discard, with a `saving` state). The component
already exists and already takes everything needed.

**Do:** replace the three inline save controls with `UnsavedBanner`, wiring
`onSave`/`onDiscard`/`saving`. Discard needs a real reset — re-read the integration's
config from state rather than just clearing the dirty flag.

**Why first:** smallest item on the board, removes a visible inconsistency, and
touches one file.

---

### R2. Integration status object should be able to show record status
**Asana:** `1216902079620653` · **Size:** S · **Risk:** low

The `integration-status` layout object currently renders connection state only:

```ts
{ type: "integration-status"; integrationId?: string | null; label?: string; showLabel?: boolean }
```

Meanwhile OBS and REAPER already broadcast a real recording state, and there are
already dedicated `obs-status` / `reaper-status` objects. The ask is to let the
*generic* status object show "is it recording" instead of "is it connected", so one
object can cover any integration that has the concept.

**Do:** add `mode?: "connection" | "recording"` to the config, defaulting to
`"connection"` so existing layouts are untouched. In `recording` mode, read the
recording flag from whichever integration is selected (OBS and REAPER today) and fall
back to connection state with a muted look for integrations that have no record
concept. Add the mode selector to the inspector.

**Open question:** should `recording` mode also inherit the red fill that
`obs-status` uses, or stay a neutral chip? Recommend inheriting it — a recording
indicator that does not read as "recording" at a glance is not much use.

---

### R3. Three update modes — install now, restart when you choose
**Asana:** `1216546495355833` · **Size:** M · **Risk:** medium (touches the updater)

Today `AutoUpdateSettings` is `{ enabled, dayOfWeek, hour }` and `applyUpdate()`
always ends by killing the process so the service manager restarts it. There is no way
to take the new build without taking the restart.

`POST /api/update/restart` already exists, so the deferred half is half-built.

**Do:** replace the boolean with a mode:

```ts
export type UpdateMode =
  | "manual"        // check + apply + restart all operator-driven
  | "auto-install"  // apply automatically, restart when the operator says
  | "auto-full";    // current behavior: apply and restart in the window
```

Keep `dayOfWeek`/`hour` for the two auto modes. Split the apply script so the
kill-and-restart step is conditional, and surface "an update is installed and waiting
for a restart" in the UI with a Restart button. Migration: existing
`enabled: true` → `auto-full`, `enabled: false` → `manual`.

**Why it matters:** this is the item with real operational value — it lets an update
land Saturday and restart Monday, instead of gambling on the window.

**Care needed:** the existing service-activity lock (`serviceActivity()`) must still
block a *restart* during a live service, even in `auto-full`.

---

### R4. Hide/disable unused integrations
**Asana:** `1216546495355839` · **Size:** M · **Risk:** low

The panel lists all 11 integrations whether or not they are set up, which is most of
the page for a site using three of them. The task text muses about a marketplace and
user-submitted integrations, then rejects it as out of scope — so the real ask is
decluttering.

**Do:** auto-collapse integrations that are neither enabled nor configured into a
"Not set up (N)" disclosure at the bottom, expandable to add one. No per-integration
hide toggle, no manage mode, no persisted preference — the state already tells us
which are in use, so nothing new needs storing.

**Open question:** should an integration that is enabled but erroring stay in the
main list? Recommend yes — an error is exactly what you want to see.

---

### R5. README split into a docs folder
**Asana:** `1216546495355844` · **Size:** M · **Risk:** none

`docs/` now exists (integrations, ops, patch-sheet, design-overhaul, superpowers) but
README.md is still **592 lines / 19 top-level sections**, and the two overlap.

**Do:** keep in the README only what a newcomer needs in the first five minutes —
what it is, screenshots, quick start, deployment pointer, and a docs index. Move the
rest into `docs/`:

| README section | Destination |
|---|---|
| Deployment, Configuration, URLs & ports | `docs/ops/install-and-config.md` |
| Data model & concepts, API reference | `docs/reference/` |
| Attendance & service history, ScriptView, Baptisms | `docs/features/` |
| Reliability & efficiency, Backups & portability, Data/secrets | `docs/ops/` |
| Project structure, npm scripts, Development notes | `docs/contributing.md` |

Integrations already has `docs/integrations/` — the README section becomes a link.
Leave redirects: every moved section keeps a one-line stub in the README pointing at
its new home, so existing links and bookmarks do not die silently.

---

### R6. Release flow — automated version numbers and releases
**Asana:** `1216546495355845` · **Size:** M · **Risk:** medium (CI + tags)

`package.json` has said `1.0.0` since the beginning, and the in-app updater surfaces
that string, so every install reports v1.0.0 regardless of age. CI is build-only
(`ci.yml`); there is no release workflow.

**The blocker is unchanged from the last review:** a fully automated bump needs a
commit convention to decide major/minor/patch, or everything becomes a patch. This
repo's messages are already close to Conventional Commits (`feat(...)`, `fix(...)`,
`refactor(...)`, `docs(...)`) — adopting it formally is a small step.

**Do (recommended):**
1. Adopt Conventional Commits, enforced by a CI check on PR titles only (not every
   commit — too noisy for a solo repo).
2. Push to `beta` → prerelease `X.Y.Z-beta.N`, tag, GitHub prerelease.
3. Merge to `main` → promote to `X.Y.Z`, tag, GitHub Release with generated notes.
4. Tag-driven, so it never rewrites history — respects the never-force-push rule.

**Decision needed from you:** adopt Conventional Commits, or keep manual version
bumps with just the release/tag automation? Everything else follows from that.

---

### R7. History tab / status / top bar on mobile
**Asana:** `1211817834830156` · **Size:** S–M · **Risk:** none · **Filed today**

I initially marked this done off the older mobile commits (`1cc506c`,
`1f91013`, `4681beb`) and then reverted it — you filed this **today**, so whatever
those fixed, something is still wrong.

**Blocked on you:** which part, and at what width? The history *table* already drops
columns under `max-sm:`, so my guess is the status strip or the top bar rather than
the table. A screenshot at the width you saw it would turn this into a quick fix.

---

### R8. Overhaul occupancy layout
**Asana:** `1216546495355834` · **Size:** L · **Risk:** low · **Needs direction**

The last pass established this is not really about the occupancy dashboard — it is
"give the custom-layout editor and its objects the same refinement the History tab
got". That is a design batch, not a bug.

Now partly overtaken: the layout-object registry (PR #130) makes adding, removing and
reworking object types cheap, which was the main friction.

**Do first (cheap, unblocks the rest):** the object audit — walk all 35 types and
decide keep / rework / drop. The registry makes each of those a single entry change.

**Then:** the occupancy layout itself, once there is a direction for what it should
show. Recommend treating this as its own brainstorm rather than folding it in here.

---

### R9. Ecobee integration
**Asana:** `1211817834830155` · **Size:** L · **Risk:** medium (external API, OAuth)

The only item on the board that is a genuinely new integration. Your notes on it:

> check current temp, start cooling when in-room attendance reaches >50 people ·
> PCO integration: copy Events2HVAC · Companion: control HVAC from stream decks

Three separable capabilities, and they should not be built as one:

1. **Read + display** — current temp/humidity as layout objects. Straightforward, and
   it slots into the existing integration pattern (`StatusIntegration`, poll, badge).
2. **Attendance-driven control** — start cooling when occupancy crosses a threshold.
   This is a *rule*, and it is the same rule engine the RossTalk automation needs.
3. **PCO-schedule-driven control** — pre-cool before a service. Also a rule, just with
   a time trigger.

**Recommendation:** build (1) as a normal integration, and let (2) and (3) fall out of
the shared rule engine rather than hard-coding Ecobee-specific automation. That engine
now has two customers, which is a good argument for building it properly once.

**Note:** Ecobee's API is OAuth with refresh tokens and a rate-limited cloud
endpoint — unlike every current integration, which is LAN or a static PCO token. The
secrets store handles it, but token refresh is new machinery.

---

### R10. Make the Stage Utility icon
**Asana:** `1216546495355842` · **Size:** S · **Risk:** none · **Parked**

Still parked. `public/app-icon.png` is a neutral placeholder. This is a design task,
not an engineering one — it needs someone to draw something, and it blocks nothing.

---

### R11. Empty subtask
**Asana:** `1216902079620656` · **Size:** — 

An Integrations subtask with **no name and no notes**. Either it was created by
accident or the title was lost. Needs a name or deletion — I have not touched it.

---

## Suggested sequencing

**Quick wins, one sitting:** R1 (save/discard) → R2 (record status) → R4 (hide unused).
All three are Integrations-panel work, all low risk, and together they make the page
noticeably better.

**Then the operational one:** R3 (update modes). Highest real-world value on the list.

**Then housekeeping:** R5 (README split), R6 (release flow) — R6 needs your decision
on commit conventions first.

**Needs input before it can start:** R7 (screenshot), R8 (direction), R9 (scope call
on the rule engine), R10 (a drawing), R11 (a title).

## Cross-cutting observation

**R9's automation and the deferred RossTalk automation are the same feature.** Both
want "when X happens in Stage, do Y to a device" — occupancy crossing a threshold,
a service going live, a plan advancing. Building one rule engine with pluggable
triggers and actions serves Ecobee, RossTalk, and anything after them. Building
Ecobee-specific thermostat automation now means building it twice.

That is the strongest argument for doing the rule engine as a real piece of work
rather than as an appendix to whichever integration needs it first.
