# Display URLs and tool links

## Every display has a permanent address

A display is reached at `/<id>` — `/display-1`, `/display-2`. That id is assigned once and
**never rewritten**. `slots.json` is keyed by it, and Raspberry Pis, bookmarks and printed QR
codes point at it, so it has to be stable forever.

## Optional friendly URLs

A display may also carry a **slug**: set "left-mic" on `display-1` and `/left-mic` resolves to
the same display. Both addresses work; neither supersedes the other.

This is deliberately an *alias*, not a rename. Editing the id itself would mean:

- **Orphaning slot config**, since `slots.json` is keyed by display id.
- **Breaking every fixed address** — and not only at rename time. A URL would become something
  a volunteer could change months later, with no idea a ceiling-mounted Pi depends on it.
- **Silent collisions with built-in pages** (see below).

Clearing a slug only removes the alias. Nothing is rekeyed, so nothing can be lost.

### Reserved paths

`main/services/reserved-slugs.ts` holds the one authority: `settings`, `log`, `photos`,
`baptism`, `history`, `patch`, `scriptview`, the empty path, and anything starting `preview-`.

This matters more than a duplicate check. `renderer/main/root-view.tsx` tests those paths
**before** falling through to the display, so a display slugged `history` would not raise a
conflict — it would render the History page instead. A duplicate is at least detectable; this
is not.

`reserved-slugs.test.ts` reads `root-view.tsx` and fails if the router handles a path that is
not reserved. Adding a page without reserving it breaks CI rather than a live display.

### Validation

Rejected, with the reason shown on the card: reserved paths, the `preview-` prefix, anything
matching another display's id or slug, and anything outside `[a-z0-9-]`. The server is
authoritative — the settings UI keeps no copy of the list, so the two cannot drift.

### Resolution

`renderer/main/resolve-display.ts` resolves a path to a canonical id: **id first, then slug**.
Ids win deliberately rather than relying on validation — if a bad slug ever reaches config by
another route, a display must stay reachable at its permanent address.

Resolution is client-side only, and that is sufficient: `/api/state` takes no display
parameter, and the kiosk selects its own slice with `state.slotsByDisplay[displayId]`. The
server's other `displayId` callers receive a real id in a POST body from the settings UI.

## Tool links

The standalone pages — `/baptism`, `/patch`, `/scriptview`, `/history`, `/log` — are listed
under **Settings → Connect → Tools**, whose job is already handing out links, with the same
copy/QR treatment display links get.

The display picker at `/` tiles `/scriptview`, `/baptism`, `/patch` and `/history`. **`/log`
is deliberately absent** from the picker: it is an operator diagnostic surface, not a
volunteer destination.

**QR codes encode the `/<id>` address, never a slug.** A printed QR outlives the session it
was made in; if it encoded `/left-mic` and someone later cleared that slug, every printed copy
would break.

These are not on the Displays tab on purpose. That tab answers one question — which View does
this physical screen show — and these are not outputs.

## Files

- `main/services/reserved-slugs.ts` — `RESERVED_SLUGS`, `RESERVED_SLUG_PREFIX`, `validateSlug()`
- `main/services/stage-controller.ts` — `setOutputSlug()`
- `main/services/routes/view-routes.ts` — `PATCH /api/outputs/:id { slug }`
- `renderer/main/resolve-display.ts` — `resolveDisplayId()`
- `renderer/settings/sections/outputs-section.tsx` — the "Also at" field
- `renderer/settings/sections/connect-section.tsx` — the Tools panel
- `renderer/main/display-picker-view.tsx` — the `/` tiles
