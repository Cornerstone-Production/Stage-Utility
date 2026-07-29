# Custom display URLs and tool links — design

**Status:** approved in conversation; ready for an implementation plan.

Two changes to how the app's URLs are surfaced and addressed.

| # | Change | Where |
|---|--------|-------|
| A | An optional, editable slug per display — `/left-mic` as well as `/display-1` | `stage.ts`, a new reserved-slug module, output routes, outputs settings |
| B | Static tool links on Connect; the two missing tiles on the `/` picker | `connect-section.tsx`, `display-picker-view.tsx` |

---

## A — Slug aliases for displays

### Why not simply rename the URL

The requested feature was "let me edit the display URLs instead of `/display-1`". Implemented
literally, that means editing a primary key. `getDisplayId()` returns
`window.location.pathname` verbatim (`stage-view.tsx:19-23`) and the app then resolves
`outputs.find((o) => o.id === displayId)`. The slug **is** the id.

Three consequences, worst first:

1. **Reserved words collide silently.** `root-view.tsx` tests the slug against `""`,
   `baptism`, `history`, `patch` and `scriptview` *before* falling through to the display,
   and the server handles `/settings`, `/log` and `/photos`. `preview-` is also reserved
   (`use-stage-state.ts:63`, `stage-view.tsx:334`). A display renamed to `history` would not
   raise a conflict — it would render the History page. That is worse than a duplicate,
   which at least is detectable.
2. **It orphans slot config.** `slots.json` is keyed by display id — 35 slots under
   `display-1`, 19 under `display-2` in the live config. A rename that does not re-key in the
   same write blanks a board. (That file already holds `view-2`, `view-8` and two hex keys,
   so these keys have drifted from output ids before.)
3. **Fixed addresses stop being fixed.** Two Raspberry Pis point at display URLs. Renaming
   is not just a one-time break: the address becomes something a volunteer can change months
   later with no idea a ceiling-mounted Pi depends on it.

### The shape

`Output` gains an optional slug. The id is never written again after creation.

```ts
export interface Output {
  id: string;
  name: string;
  /** Optional friendly URL for this display. `/display-1` always resolves via `id`;
   *  when set, `/left-mic` resolves here too. Never used as a storage key — slots
   *  and everything else stay keyed by `id`, so clearing a slug cannot orphan data. */
  slug?: string;
  viewId: string | null;
  blackout?: boolean;
  locked?: boolean;
}
```

**Resolution:** exact `id` match first, then `slug` match. The resolved **canonical id** is
what every downstream consumer uses — slot lookup, reload targeting (`stage-view.tsx:354`),
`preview-` handling. Nothing downstream ever sees a slug.

Because the id path never stops working, anything already pointed at `/display-1` — Pis,
bookmarks, printed QR codes — keeps working forever. That is the whole point of the design.

### Where resolution actually happens

Client-side only, and that is enough. `/api/state` takes no display parameter — it returns
the whole state and the kiosk selects its own slice with `state.slotsByDisplay[displayId]`
and `state.resolvedByOutput[displayId]` (`stage-view.tsx:415-531`). The server's other
`displayId` callers (`preset-routes.ts`, `scriptview-routes.ts`) take it from a POST body
sent by the settings UI, which always holds the real id.

So the renderer resolves the path slug to a canonical id **once**, as soon as state is
available, and every existing consumer keeps using ids exactly as it does today. Nothing on
the server changes for the render path.

The server still validates slugs on save — that is authoritative, and the settings UI simply
reports the rejection reason it returns rather than keeping its own copy of the reserved
list. No list-fetching endpoint is needed, and there is no second copy to drift.

### One authority for reserved words

The router, the server's route table and the slug validator must agree. If they drift, a
future page silently shadows a slug someone is already using — precisely the failure this
design exists to prevent.

The canonical list lives in **`main`**. The renderer cannot import it at runtime: the
`@main/*` tsconfig alias is types-only and Vite has no matching resolve alias, so adding one
would let renderer code pull in node-dependent backend modules. Rather than keep a second
copy that can drift, the renderer keeps **none** — it saves, and displays whatever rejection
reason the server returns.

Reserved: `""`, `settings`, `log`, `baptism`, `history`, `patch`, `scriptview`, `photos`,
plus any slug beginning `preview-`.

A test asserts every path `root-view.tsx` handles appears in the reserved list, so adding a
page without reserving it fails CI rather than breaking a live display.

### Validation

A slug is rejected when it is reserved, starts with `preview-`, matches another output's `id`
or `slug`, or contains anything outside `[a-z0-9-]`. Rejection is an error on save with the
reason stated, not a silent correction. Clearing the slug is always allowed and only removes
the alias.

### UI

An optional "Custom URL" field on each output card in the Displays tab, showing the resulting
address. The card keeps showing the permanent `/display-N` address too, so it is obvious that
the original never stops working.

---

## B — Tool links

`/baptism`, `/patch` and `/scriptview` are already tiled on the display picker at `/`
(`display-picker-view.tsx:118-134`). `/history` and `/log` are not surfaced anywhere and are
reachable only by typing the URL.

**Connect** gains a "Tools" group listing `/baptism`, `/history`, `/patch`, `/scriptview` and
`/log` with the copy/QR treatment display links already get. Connect's stated job is sharing
links, which is exactly what these are.

**The `/` picker** gains a `/history` tile. **`/log` stays off the picker** — it is an
operator diagnostic surface, not a volunteer destination — but does appear on Connect.

**QR codes encode the id URL, never the slug.** A scanned QR outlives the session it was
printed in; if it encoded `/left-mic` and someone later cleared that slug, every printed copy
would break. The slug is offered as a copyable "friendly link" instead.

### Not the Displays tab

The original suggestion was a section on the Displays tab. Rejected: that tab answers one
question — which View does this physical screen show — and these are not outputs. It would
give the tab a second, unrelated job and the section would be a static list that never
changes.

---

## Out of scope

- Renaming or re-keying `Output.id`.
- Slugs for anything other than displays.
- Redirecting `/display-1` to a slug: both addresses resolve, neither supersedes the other.
