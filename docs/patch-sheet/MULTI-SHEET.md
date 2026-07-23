# Patch sheet — multiple sheets, ownership, color coding

The patch is a set of **sheets** (tabs), each an independent patch surface of the
same shape. This mirrors how a real console patch spreadsheet is organized —
Analog stage patch, Dante, Waves SoundGrid, Monitoring — rather than one flat
patch or per-network devices.

## Sheets

`PatchFile` is now `{ sheets: PatchSheet[], updatedAt }`. A `PatchSheet` is what
the single patch used to be — `{ id, name, kind, devices, endpoints, variants,
assignments }` — so the whole editor (device manager, ripple, label generation,
variants, weekly assignment) operates on the active sheet unchanged.

- **Kinds** (`analog | dante | network | monitor | custom`) drive cosmetics only.
- A fresh install seeds four sheets: **Analog, Dante, WSG, Monitoring**. All are
  renamable and removable; a "+" adds more.
- **Migration:** a legacy single-patch `patch.json` (`{ devices, endpoints, … }`)
  is wrapped as the "Analog" sheet with the other three seeded — no data lost
  (`DataStore.load()` returns the file as-is; `patchStore.migrate()` wraps it).

The `/patch` volunteer view shows one tab per **populated** sheet (empty seeded
sheets are hidden) and resolves each sheet independently against the live plan.

## Ownership bands

Endpoints gain an optional `owner` tag (e.g. `338 @ FOH`). On non-analog sheets
the editor shows an **Owner** column (rippleable, copy-down), and both the editor
and the `/patch` view group channels under `Owned by …` subheadings when the
owner changes — matching the ownership band on a Dante patch sheet.

## Color coding

`PatchDevice.color` (`#rrggbb`, chosen from a preset palette in the device
manager) is shown on two separate visual channels so a rack's color and its
snakes' colors never fight:

- **Source device (snake/pocket) color → the per-row left stripe** — every channel
  fed by "Snake A" reads as one color (the "what changed" warn stripe takes
  precedence on changed rows).
- **Rack color → the rack's section header** (a color dot + a left stripe on the
  card), since the rack is the container the rows are grouped under, not a row
  source. In "By device" mode the group header carries the source device's color.

## Files

- `main/types/stage.ts` / `renderer/types.d.ts` — `PatchSheet`, `PatchSheetKind`, `PatchFile.sheets`, `PatchEndpoint.owner`, `PatchDevice.color`
- `main/services/patch-store.ts` — seed + `migrate()`
- `renderer/lib/patch-resolve.ts` — `resolvePatch(sheet, …)`
- `renderer/settings/sections/patch-section.tsx` — sheet tabs + active-sheet editing
- `renderer/settings/sections/patch-device-manager.tsx` — color palette
- `renderer/settings/sections/patch-table.tsx` — owner column + color stripe
- `renderer/main/patch-view.tsx` — sheet tabs + owner headers + color stripe
