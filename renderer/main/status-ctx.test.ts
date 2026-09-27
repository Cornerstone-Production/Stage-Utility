// statusCtx pairs each status channel's value with ITS OWN `known` flag.
//
// Home's grid and the editor's preview build their context through it, and a
// flag copied from a neighbouring hook compiles cleanly: `obsKnown:
// d.reaperStatus.known` type-checks, then draws OFFLINE over a recording OBS
// until REAPER happens to answer, or a dash for ever if REAPER never does.
// Nothing renders either surface's real context in a test, so the mapping is
// pinned here: one source answered at a time, and exactly its own flag lit.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { installDom } from "../test-dom.js";

installDom();
const { statusCtx } = await import("./layout-renderer.js");

type Input = Parameters<typeof statusCtx>[0];

/** Each source, and the ctx flag it must light. Sorted, one per line. */
const FLAG_FOR = {
  baptismStatus: "baptismKnown",
  integrationsSnap: "integrationsKnown",
  obsStatus: "obsKnown",
  onlinePresence: "onlineKnown",
  reaperStatus: "reaperKnown",
  resiStatus: "resiKnown",
  scoresStatus: "scoresKnown",
  youtubeStatus: "youtubeKnown",
} as const;
type Source = keyof typeof FLAG_FOR;

/** Every source carrying a value that names it, and only `answered` known. */
function input(answered: Source | null): Input {
  const status = (s: Source) => ({ value: { from: s } as never, known: s === answered });
  return {
    obsStatus: status("obsStatus"),
    reaperStatus: status("reaperStatus"),
    resiStatus: status("resiStatus"),
    youtubeStatus: status("youtubeStatus"),
    scoresStatus: status("scoresStatus"),
    baptismStatus: status("baptismStatus"),
    integrationsSnap: {
      states: [{ from: "integrationsSnap" }] as never,
      labels: { from: "integrationsSnap" },
      known: answered === "integrationsSnap",
    },
    onlinePresence: { onlineOutputIds: ["onlinePresence"], known: answered === "onlinePresence" },
  };
}

const litFlags = (out: Record<string, unknown>) =>
  Object.entries(out).filter(([k, v]) => k.endsWith("Known") && v === true).map(([k]) => k).sort();

describe("statusCtx", () => {
  test("carries exactly the known flags a context needs", () => {
    const flags = Object.keys(statusCtx(input(null))).filter((k) => k.endsWith("Known")).sort();
    assert.deepEqual(flags, Object.values(FLAG_FOR).sort());
  });

  test("nothing answered: no flag is lit", () => {
    assert.deepEqual(litFlags(statusCtx(input(null))), []);
  });

  for (const [source, flag] of Object.entries(FLAG_FOR) as [Source, string][]) {
    test(`${source} answering lights ${flag} and nothing else`, () => {
      assert.deepEqual(litFlags(statusCtx(input(source))), [flag]);
    });
  }

  test("each value comes off the same hook as its flag", () => {
    const out = statusCtx(input(null));
    const from = (v: unknown) => (v as { from?: string } | null)?.from;
    assert.equal(from(out.obs), "obsStatus");
    assert.equal(from(out.reaper), "reaperStatus");
    assert.equal(from(out.resi), "resiStatus");
    assert.equal(from(out.youtube), "youtubeStatus");
    assert.equal(from(out.scores), "scoresStatus");
    assert.equal(from(out.baptism), "baptismStatus");
    assert.equal(from(out.integrations[0]), "integrationsSnap");
    assert.equal(from(out.integrationLabels), "integrationsSnap");
    assert.deepEqual(out.onlineOutputIds, ["onlinePresence"]);
  });
});
