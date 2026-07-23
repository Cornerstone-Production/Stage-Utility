# Patch sheet — ripple fill & connector labels

Bulk-entry aids for the patch editor, so wiring a snake across a rack isn't a
channel-by-channel slog.

## Ripple fill (DiGiCo-style)

In the patch table's **By rack** mode, a **Ripple** bar arms an auto-fill:

- **Channels** — how far the fill reaches: `2 / 4 / 6 / 8 / 10 / 12`, or **To end**
  (the rest of the rack).
- **Fill** — which columns ripple: **From, Console** (on by default), plus
  **Source, Mic, 48V** for inputs / **To, Console, Dest, Feed** for outputs.

With ripple armed, the moment you set a **checked** field on a row it auto-fills
the run below — no Apply button. Set rack input 1's From to `Snake A / 1` and
inputs 1–12 immediately become `Snake A 1…12`. Numeric fields **increment**,
text/toggles **copy**. It fills **downward from the row you edit** and clamps to
the rack's last channel. Focusing a cell highlights the rows the next edit will
touch.

The increment is trailing-number aware and preserves prefix + zero-padding:
`1→2`, `B-1→B-2`, `09→10`; a value with no number (e.g. `L`) copies unchanged.

**Device rollover (From/To):** the source hop is device-aware — it respects each
device's channel count (set at the top of the tab) and rolls over to the next
source device when one runs out. Rippling `From Snake A / 1` down a rack with two
12-channel snakes fills `Snake A 1…12` then `Snake B 1…12`, then stops (no
phantom sources). It walks each device's generated labels when present
(`A-1…A-4` → `B-1…B-4`), else `1..count`, in device-list order. A free-typed
connector not matching any device slot falls back to a plain numeric increment.

No data-model change — ripple writes ordinary endpoint values; the armed
count/fields are ephemeral UI state, so it can never corrupt a saved patch.

Implementation: `renderer/lib/patch-ripple.ts` (pure `bumpValue` / `bumpHops` /
`rippleEndpoints`, unit-tested) + the `RippleBar` and `edit()` router in
`renderer/settings/sections/patch-table.tsx`.

## Connector labels

In the device manager each device has a **generate labels** action (list icon):
enter a **prefix** (e.g. `B-`) and **start #**, then label its inputs/outputs
sequentially — `B-1…B-12`. Stored on `PatchDevice.inLabels` / `outLabels`. The
labels autocomplete in the From/To path cells (a `<datalist>`) and ripple
cleanly afterward. `generateLabels()` lives in `patch-ripple.ts`.

## Related fixes (same change)

- **/patch scrolled**: the public view was `min-h-[100dvh]` inside the app
  shell's `overflow-hidden` wrapper, so it was clipped. Now `h-full
  overflow-y-auto` — its own scroll container, like the kiosk views.
- **Open patch sheet**: a header link in Settings → Patch opens `/patch` in a new
  tab, mirroring "Open ScriptView".
