# Patch sheet export

**Status:** design, not yet implemented.

## Goal

Get a patch sheet out of the app and into the hands of someone who is not sitting
at it — a visiting engineer, a printout taped to the rack, a file emailed to a
venue ahead of a load-in.

Import already exists (CSV and .xlsx, via `patch-import.tsx` and
`patch-xlsx.ts`). Export does not, so a sheet built in the app can only be read
in the app.

## What gets exported

`PatchFile` holds `sheets: PatchSheet[]`, each with `devices`, `endpoints`,
`variants` and `assignments`. A patch sheet's meaning lives in the signal path:
an endpoint is a chain of `PatchHop`s, each a connector on a device.

Two things follow.

**One sheet per export, not the whole file.** Sheets are tabs and are read
separately; a single flat file mixing them would need a sheet column on every
row and would please nobody.

**A variant has to be selectable.** `endpoints` is the default patch and
`variants` are the alternates. Exporting only the default would silently hand
someone the wrong document on any weekend that runs a variant. The export names
the variant it rendered, in the file and in the filename.

## Formats

| Format | For | Cost |
|---|---|---|
| **CSV** | the universal one — opens anywhere, imports back into this app, mails to a venue | none; hand-rolled, no dependency |
| **XLSX** | what most engineers actually keep patch sheets in; preserves column widths and device colour | a new dependency (see below) |
| **Print / PDF** | the copy taped to the rack | none if done as a print stylesheet in the browser |

**All three ship.** CSV first because it needs nothing new, then XLSX, then
print.

**XLSX uses `write-excel-file`** — the counterpart to the `read-excel-file` the
importer already uses, by the same author. Checked against the project's
dependency rule before adoption:

| | version | last published | license | transitives |
|---|---|---|---|---|
| `write-excel-file` | 4.1.1 | 56 days ago | MIT | one: `fflate` |
| `read-excel-file` (already in use) | 9.3.5 | 5 days ago | MIT | — |
| `fflate` | 0.8.3 | 13 days ago | MIT | none |

Actively maintained, permissively licensed, and a one-package tail with no
further dependencies of its own.

## Shape of the CSV

One row per endpoint, columns in the order an engineer reads them:

```
Channel, Label, Device, Connector, Kind, Path, Notes
```

`Path` renders the full hop chain as `Device:Connector -> Device:Connector`, so
the signal path survives a format that has no nesting. That is the column a
visiting engineer actually reads, and flattening it away would make the export
pretty and useless.

Rows are ordered by channel number, with non-numeric channels last in their
existing order — the same order the table shows, so the file matches the screen.

## Where it lives

Follows the precedents already in the app rather than inventing a pattern:

- **Route:** `GET /api/patch/export?sheetId=&variantId=&format=csv`, responding
  with `Content-Disposition: attachment` — the same shape as
  `archive-routes.ts`.
- **Rendering is server-side and pure.** A `patch-export.ts` module turns
  `(PatchSheet, variantId)` into rows, with no I/O, so it is unit-testable
  without a browser or a file.
- **UI:** an Export button on the patch tab beside the existing import, offering
  the formats that exist. The renderer already has `downloadJson` for preset
  export; this reuses the same download approach.

## Filename

`<sheet name>-<variant name>-<YYYY-MM-DD>.csv`, slugified. The date matters:
these get emailed and then live in someone's downloads folder for a year, and a
file called `patch.csv` is worthless by then.

## Error handling

- Unknown `sheetId` or `variantId` → 400 naming which was not found, not a 500.
- A sheet with no endpoints exports a header row and nothing else, rather than
  erroring. An empty patch is a legitimate state and the file should say so.
- A hop referencing a deleted device renders the raw id rather than dropping the
  hop. Losing a hop silently would misrepresent the signal path, which is the one
  thing this document exists to convey.

## Testing

- `patch-export.test.ts`: column order, hop-chain rendering, channel ordering
  with non-numeric channels, a variant overriding the default, an empty sheet, a
  dangling device reference.
- A round trip: export a sheet to CSV, feed it back through the existing
  importer, assert the endpoints match. This is the test that keeps export and
  import from drifting apart — they are the same document in two directions and
  nothing else forces them to agree.

## Not in scope

- PDF generation as a server-side library. Print-to-PDF from the browser covers
  it without a dependency; revisit only if the print output proves inadequate.
- Exporting every sheet at once as a workbook. Worth doing once XLSX exists,
  meaningless before then.
