// `""` is how the form says "this number field is not set", and the server has
// to read it exactly as "absent".
//
// The integrations dialog writes an empty string rather than deleting the key —
// deliberately, because that is what initialConfig seeds an unset number field
// with, so `pristine` and the form agree and the dialog is not born dirty (see
// the `onUnset` prop at integrations-panel.tsx). That makes a CONTRACT out of
// something nothing was checking: every reader of an `unsetHint` field must
// resolve `""` to whatever it resolves a missing key to.
//
// The three that ship today all happen to. Each spells the same ladder —
// `typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ?
// parseInt(raw, 10) : NaN`, then a `Number.isFinite && > 0` test — and `""`
// falls out of it as NaN. A FOURTH field whose reader spelled `cfg.x ?? DEFAULT`
// would resolve to the empty string instead of the default and nothing would
// say so: `""` is falsy, so a service would run at whatever `Number("")` or a
// truthiness test made of it, and the card would still look configured.
//
// This runs the REAL resolvers on the REAL descriptors rather than asserting
// over source text. The resolvers are private to the manager, which is the
// point — a guard that reimplemented the ladder would go green on a bug living
// in the copy under test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-unset-blank-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { integrationManager, INTEGRATION_DESCRIPTORS } = await import("./integration-manager.js");

/** The manager's private surface: the state map the resolvers read, and the
 *  resolvers themselves. Driving the real ones is the whole point — see the
 *  header. */
type Manager = {
  states: Map<string, { id: string; enabled: boolean; connection: string; message: string | null; config: Record<string, unknown> }>;
  getPropresenterTarget: () => unknown;
  getRossTslConfig: () => unknown;
  getSensourceConfig: () => Promise<unknown>;
};
const mgr = integrationManager as unknown as Manager;

/** How the server resolves each integration that has an unsettable number
 *  field, and the rest of a config realistic enough that the resolution is not
 *  trivially empty on both sides. */
const RESOLVE: Record<string, { base: Record<string, unknown>; resolve: () => unknown | Promise<unknown> }> = {
  propresenter: {
    base: { name: "Main", host: "192.168.1.100", port: 1025 },
    resolve: () => mgr.getPropresenterTarget(),
  },
  "ross-tsl": {
    base: { host: "192.168.1.60", feeds: [] },
    resolve: () => mgr.getRossTslConfig(),
  },
  sensource: {
    base: { clientId: "client-id", locationId: "loc-1", pollSeconds: 30, zoneIds: [] },
    resolve: () => mgr.getSensourceConfig(),
  },
};

/** Every field in every shipped descriptor that declares `unsetHint`. */
const UNSETTABLE = INTEGRATION_DESCRIPTORS.flatMap((d) =>
  d.configSchema.filter((f) => f.unsetHint != null).map((f) => ({ id: d.id, key: f.key })),
);

function put(id: string, config: Record<string, unknown>): void {
  mgr.states.set(id, { id, enabled: false, connection: "disconnected", message: null, config });
}

describe("a number field the form can leave blank", () => {
  it("has exactly three of them, and a resolver for each", () => {
    // EXACT, and both halves matter. The first is the same count
    // integration-number-fields.test.tsx asserts from the renderer's side. The
    // second is what stops a FOURTH unsettable field being added with nobody
    // checking how its reader treats "": there is no resolver for it here, so
    // this fails until somebody writes one down.
    assert.deepEqual(
      UNSETTABLE.map((u) => `${u.id}.${u.key}`).sort(),
      ["propresenter.pollMs", "ross-tsl.port", "sensource.attendancePollSeconds"],
    );
    const missing = [...new Set(UNSETTABLE.map((u) => u.id))].filter((id) => RESOLVE[id] == null);
    assert.deepEqual(missing, [], `no resolver in this file for: ${missing.join(", ")}`);
  });

  for (const { id, key } of UNSETTABLE) {
    it(`${id}: "${key}" resolves the same blank as absent`, async () => {
      const { base, resolve } = RESOLVE[id];

      put(id, { ...base });
      const absent = await resolve();

      put(id, { ...base, [key]: "" });
      const blank = await resolve();

      assert.deepEqual(
        blank,
        absent,
        `${id}.${key} = "" resolved to something other than an unset ${key}`,
      );
    });

    it(`${id}: "${key}" never leaves an empty string in the resolved config`, async () => {
      // The other way the contract can break: a reader that passes `""` through
      // rather than falling back. `""` is falsy, so a service handed one runs at
      // whatever a truthiness test or Number("") makes of it — and the card goes
      // on reading as configured either way.
      const { base, resolve } = RESOLVE[id];
      put(id, { ...base, [key]: "" });
      const resolved = (await resolve()) as Record<string, unknown>;
      const empty = Object.entries(resolved).filter(([, v]) => v === "");
      assert.deepEqual(empty.map(([k]) => k), [], `${id}: resolved config carries an empty string`);
    });
  }

  it("resolves something real, so the comparison above is not two empty objects", async () => {
    // A resolver that threw, or a state map the test never populated, would make
    // every deepEqual above pass on `{}` against `{}`.
    put("propresenter", { ...RESOLVE.propresenter.base });
    assert.deepEqual(await RESOLVE.propresenter.resolve(), { host: "192.168.1.100", port: 1025, pollMs: null });

    put("ross-tsl", { ...RESOLVE["ross-tsl"].base });
    assert.deepEqual(await RESOLVE["ross-tsl"].resolve(), { host: "192.168.1.60", port: null, feeds: [] });

    put("sensource", { ...RESOLVE.sensource.base });
    const s = (await RESOLVE.sensource.resolve()) as Record<string, unknown>;
    assert.equal(s.clientId, "client-id");
    assert.equal(s.pollSeconds, 30);
    assert.equal(s.attendancePollSeconds, 30, "an unset attendance interval falls back to the poll interval above");
  });
});
