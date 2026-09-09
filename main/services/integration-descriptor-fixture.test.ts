// The renderer's descriptor fixture must match the descriptors the server ships.
//
// renderer/test-fixtures/integration-descriptors.ts is a copy, not an import,
// because importing the manager into a renderer test drags every device
// provider and store along. A copy drifts: Companion gained two config fields
// on the server and the fixture kept `configSchema: []`, so the dialog test that
// asserts "declares N fields and rendered none" had nothing to assert, and a
// dialog that never rendered those fields shipped in a beta. integration-ids
// .test.ts pins the LIST of ids; this pins what each descriptor declares.

import assert from "node:assert/strict";
import { test } from "node:test";

const { INTEGRATION_DESCRIPTORS } = await import("./integration-manager.js");
const { INTEGRATION_DESCRIPTOR_FIXTURE } = await import(
  "../../renderer/test-fixtures/integration-descriptors.js"
);

/** What the dialog renders from, stripped of nothing — a placeholder or a help
 *  string that drifts is a fixture describing a dialog that does not exist. */
function shape(d: { id: string; inbound?: boolean; description?: string; configSchema: unknown[] }) {
  return { id: d.id, inbound: d.inbound ?? false, description: d.description ?? "", configSchema: d.configSchema };
}

test("every shipped descriptor is in the fixture with the same fields", () => {
  const real = new Map(INTEGRATION_DESCRIPTORS.map((d) => [d.id, shape(d)]));
  const fixture = new Map(INTEGRATION_DESCRIPTOR_FIXTURE.map((d) => [d.id, shape(d)]));
  assert.deepEqual([...fixture.keys()].sort(), [...real.keys()].sort(), "the fixture lists different integrations");
  for (const [id, want] of real) {
    assert.deepEqual(
      fixture.get(id),
      want,
      `${id}: the fixture describes a different dialog than the server declares`,
    );
  }
});
