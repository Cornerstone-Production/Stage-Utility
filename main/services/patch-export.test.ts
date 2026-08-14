import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PatchEndpoint, PatchSheet } from "../types/stage.js";
import { setAppTimeZone } from "./app-timezone.js";
import { EXPORT_HEADERS, exportFilename, exportRows, rowCells } from "./patch-export.js";

const ep = (over: Partial<PatchEndpoint> & Pick<PatchEndpoint, "rackId" | "dir" | "index">): PatchEndpoint => over;

const sheet = (over: Partial<PatchSheet> = {}): PatchSheet => ({
  id: "s1",
  name: "FOH",
  kind: "analog",
  devices: [
    { id: "r1", name: "SD Rack", kind: "rack", inputs: 32, outputs: 8 },
    { id: "sn", name: "Snake A", kind: "snake", inputs: 12, outputs: 4 },
  ],
  endpoints: [
    ep({ rackId: "r1", dir: "in", index: 2, consoleChannel: "02", label: "Vox 2", mic: "SM58", phantom: false,
      path: [{ deviceId: "sn", connector: "2" }], notes: "spare", owner: "338 @ FOH" }),
    ep({ rackId: "r1", dir: "in", index: 1, consoleChannel: "01", label: "Kick", mic: "Beta91", phantom: true }),
  ],
  variants: [],
  assignments: { byServiceType: {}, byPlan: {} },
  ...over,
});

describe("exportRows", () => {
  it("orders rows by rack, then direction, then index", () => {
    const rows = exportRows(sheet());
    assert.deepEqual(rows.map((r) => r.console), ["01", "02"]);
  });

  it("renders the whole hop chain, which is the column an engineer reads", () => {
    const vox = exportRows(sheet()).find((r) => r.console === "02")!;
    assert.equal(vox.path, "Snake A:2");
  });

  it("leaves the path blank for a direct patch rather than inventing a hop", () => {
    const kick = exportRows(sheet()).find((r) => r.console === "01")!;
    assert.equal(kick.path, "");
  });

  it("names the endpoint's own rack and connector", () => {
    const kick = exportRows(sheet()).find((r) => r.console === "01")!;
    assert.equal(kick.rack, "SD Rack");
    assert.equal(kick.rackCh, "1");
  });

  it("uses a device's custom connector labels when it has them", () => {
    // A rack patched against generated labels ("B-1") would be misdescribed by
    // a bare index.
    const s = sheet({
      devices: [{ id: "r1", name: "SD Rack", kind: "rack", inputs: 32, outputs: 8, inLabels: ["B-1", "B-2"] }],
    });
    assert.deepEqual(exportRows(s).map((r) => r.rackCh), ["B-1", "B-2"]);
  });

  it("keeps phantom in its own column, so it survives a re-import as a boolean", () => {
    const rows = exportRows(sheet());
    const kick = rows.find((r) => r.console === "01")!;
    assert.equal(kick.source, "Beta91");
    assert.equal(kick.phantom, "48V");
    assert.equal(rows.find((r) => r.console === "02")!.phantom, "");
  });

  it("shows an output's feed type in the same column as an input's mic", () => {
    const s = sheet({
      endpoints: [ep({ rackId: "r1", dir: "out", index: 1, label: "Pastor IEM", feedType: "IEM" })],
    });
    assert.equal(exportRows(s)[0].source, "IEM");
    assert.equal(exportRows(s)[0].dir, "out");
  });

  it("leaves the console column blank when none is set, and still names the rack channel", () => {
    const s = sheet({ endpoints: [ep({ rackId: "r1", dir: "in", index: 7, label: "X" })] });
    assert.equal(exportRows(s)[0].console, "");
    assert.equal(exportRows(s)[0].rackCh, "7");
  });

  it("applies a variant's overrides through the shared resolver", () => {
    const s = sheet({
      variants: [{ id: "v1", name: "Baptism", overrides: { "r1:in:1": { label: "Handheld", mic: "SM58" } } }],
    });
    assert.equal(exportRows(s, "v1").find((r) => r.console === "01")!.label, "Handheld");
    // The default patch is untouched by the variant.
    assert.equal(exportRows(s, null).find((r) => r.console === "01")!.label, "Kick");
  });

  it("renders a hop whose device was deleted rather than dropping it", () => {
    // Silently losing a hop would misrepresent the signal path.
    const s = sheet({
      endpoints: [ep({ rackId: "r1", dir: "in", index: 1, path: [{ deviceId: "gone", connector: "7" }] })],
    });
    assert.equal(exportRows(s)[0].path, "gone:7");
  });

  it("names a deleted rack by its raw id too", () => {
    const s = sheet({ endpoints: [ep({ rackId: "vanished", dir: "in", index: 3 })] });
    assert.equal(exportRows(s)[0].rack, "vanished");
  });

  it("omits unused endpoints by default, and includes them on request", () => {
    const s = sheet({
      endpoints: [
        ep({ rackId: "r1", dir: "in", index: 1, label: "Kick" }),
        ep({ rackId: "r1", dir: "in", index: 2, unused: true }),
      ],
    });
    assert.equal(exportRows(s).length, 1);
    assert.equal(exportRows(s, null, { includeUnused: true }).length, 2);
  });

  it("returns no rows for an empty sheet rather than throwing", () => {
    assert.deepEqual(exportRows(sheet({ endpoints: [] })), []);
  });

  it("exposes headers matching the row fields, in reading order", () => {
    assert.deepEqual(
      [...EXPORT_HEADERS],
      ["Rack ch", "Console", "Dir", "Source / Name", "Mic / Feed", "48V", "Rack", "Path", "Owner", "Notes"],
    );
  });

  it("emits exactly one cell per header, so no column can silently shift", () => {
    for (const r of exportRows(sheet())) {
      assert.equal(rowCells(r).length, EXPORT_HEADERS.length);
    }
  });
});

describe("exportFilename", () => {
  const DAY = Date.parse("2026-08-03T12:00:00Z");

  it("slugifies, includes the variant, and dates the file", () => {
    assert.equal(exportFilename("FOH Inputs", "Baptism Week", "csv", DAY), "foh-inputs-baptism-week-2026-08-03.csv");
  });

  it("omits the variant segment for the default patch", () => {
    assert.equal(exportFilename("FOH", null, "csv", DAY), "foh-2026-08-03.csv");
  });

  it("falls back to 'patch' when a name slugifies to nothing", () => {
    assert.equal(exportFilename("!!!", null, "xlsx", DAY), "patch-2026-08-03.xlsx");
  });

  it("dates the file in the app's zone, not the server's clock", () => {
    // 03:35 UTC on the 4th is still the evening of the 3rd in Chicago. A file
    // exported then must not claim to be tomorrow's patch.
    setAppTimeZone("America/Chicago");
    try {
      assert.equal(exportFilename("FOH", null, "csv", Date.parse("2026-08-04T03:35:00Z")), "foh-2026-08-03.csv");
    } finally {
      setAppTimeZone(null);
    }
  });
});

describe("exporting what the This week tab shows", () => {
  // The divergence this file's header says the shared resolver exists to
  // prevent. The tab passed variantId=null (its "variant" is the sentinel
  // "__week", not a real one) and the route took no planId, so the download was
  // the untouched DEFAULT patch while the screen showed variant + tweaks. An
  // engineer who swapped a mic for the week taped a sheet to the rack showing
  // the old patch, with nothing in the file or its name to say so.
  const weekly = () =>
    sheet({
      variants: [{ id: "v1", name: "Christmas", overrides: { "r1:in:1": { rackId: "r1", dir: "in", index: 1, label: "Kick (sub)" } } }],
      assignments: {
        byServiceType: {},
        byPlan: { p1: { variantId: "v1", tweaks: { "r1:in:2": { rackId: "r1", dir: "in", index: 2, mic: "e935" } } } },
      },
    } as Partial<PatchSheet>);

  it("applies the plan's variant AND its week tweaks", () => {
    const rows = exportRows(weekly(), null, { plan: { planId: "p1", serviceTypeId: null } });
    const kick = rows.find((r) => r.console === "01");
    const vox = rows.find((r) => r.console === "02");
    assert.equal(kick?.label, "Kick (sub)", "the plan's variant must be applied");
    assert.equal(vox?.source, "e935", "this week's tweak must be applied");
  });

  it("without the plan context it is still the plain default — the bug, pinned", () => {
    const rows = exportRows(weekly(), null);
    assert.equal(rows.find((r) => r.console === "01")?.label, "Kick", "no context, no resolution");
  });

  it("falls back to the service type's standing variant when the plan names none", () => {
    const s = sheet({
      variants: [{ id: "v1", name: "Christmas", overrides: { "r1:in:1": { rackId: "r1", dir: "in", index: 1, label: "Kick (sub)" } } }],
      assignments: { byServiceType: { st1: "v1" }, byPlan: {} },
    } as Partial<PatchSheet>);
    const rows = exportRows(s, null, { plan: { planId: "p-unknown", serviceTypeId: "st1" } });
    assert.equal(rows.find((r) => r.console === "01")?.label, "Kick (sub)");
  });

  it("names a week export for the week, not for the variant underneath it", () => {
    // Labelling it "christmas" would put a file on the rack claiming to be the
    // standing patch when it carries one Sunday's tweaks.
    const name = exportFilename("FOH", "this-week", "csv", Date.parse("2026-08-09T12:00:00Z"));
    assert.match(name, /^foh-this-week-/);
  });
});
