// A dialog wide enough for the row inside it.
//
// DialogContent is max-w-lg by default — about 464px of content after its
// padding. Five integrations hold a repeater whose widest row cannot wrap:
// ross-tsl needs ~620px, wireless and rosstalk ~560px, osc and propresenter
// ~520px. All five would render with their rows broken across lines in the
// default dialog.
//
// The guard renders each of those five panels FOR REAL and reads the marker off
// the DOM, rather than comparing WIDE_DIALOG_IDS to a second hand-written list
// in this file — two lists agree with each other happily while both are wrong.
// The other direction (no integration outside these five renders a marked panel)
// is covered by integration-dialog.test.tsx, which mounts all sixteen bodies.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, blankState } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { WIDE_DIALOG_IDS, WIDE_PANEL_ATTR, integrationDialogClass } = await import(
  "./integration-dialog-size.js"
);
const { WirelessConnectionsPanel } = await import("./wireless-connections-panel.js");
const { OscTargetsPanel } = await import("./osc-targets-panel.js");
const { RossTalkTargetsPanel } = await import("./rosstalk-targets-panel.js");
const { RossTslFeedsPanel } = await import("./ross-tsl-feeds-panel.js");
const { ProPresenterInstancesPanel } = await import("./propresenter-instances-panel.js");

let server = installFakeServer();

beforeEach(() => {
  cleanup();
  server.restore();
  server = installFakeServer();
});

after(async () => {
  cleanup();
  await settle();
  server.restore();
  teardown();
});

/** Each repeater panel, paired with the integration whose dialog holds it. */
const REPEATER_PANELS: [string, () => React.ReactElement][] = [
  ["wireless", () => <WirelessConnectionsPanel />],
  ["osc", () => <OscTargetsPanel />],
  ["rosstalk", () => <RossTalkTargetsPanel />],
  ["ross-tsl", () => (
    <RossTslFeedsPanel state={blankState("ross-tsl")} onStateChange={() => {}} />
  )],
  ["propresenter", () => (
    <ProPresenterInstancesPanel state={blankState("propresenter")} onStateChange={() => {}} />
  )],
];

describe("the five repeater panels get a wide dialog", () => {
  for (const [id, node] of REPEATER_PANELS) {
    test(`${id} renders a panel that declares it cannot wrap`, async () => {
      const c = render(withQueryClient(node()));
      await settle();
      assert.ok(
        c.container.querySelector(`[${WIDE_PANEL_ATTR}]`),
        `${id}'s panel rendered without the wide marker, so its dialog would be sized as if its rows could wrap`,
      );
      assert.equal(
        WIDE_DIALOG_IDS.has(id),
        true,
        `${id} renders a panel whose rows cannot wrap but is not in WIDE_DIALOG_IDS`,
      );
    });
  }

  test("WIDE_DIALOG_IDS holds exactly the integrations checked above", () => {
    // An exact equality, not a floor: a floor is how a sixth repeater
    // integration would ship in a 672px dialog with nobody noticing.
    assert.deepEqual(
      [...WIDE_DIALOG_IDS].sort(),
      REPEATER_PANELS.map(([id]) => id).sort(),
    );
  });

  test("a wide integration gets max-w-3xl and everything else max-w-2xl", () => {
    assert.match(integrationDialogClass("ross-tsl"), /\bmax-w-3xl\b/);
    assert.match(integrationDialogClass("obs"), /\bmax-w-2xl\b/);
    assert.doesNotMatch(integrationDialogClass("obs"), /\bmax-w-3xl\b/);
  });

  test("every dialog is a full-screen sheet under sm, with the centring undone", () => {
    // A centred modal on a 390px phone is a modal with 16px of margin. Setting
    // inset-0 without unwinding the -translate-x-1/2 -translate-y-1/2 that
    // centres it puts the sheet half off the top-left corner.
    for (const id of ["obs", "wireless"]) {
      const cls = integrationDialogClass(id);
      for (const required of [
        "max-sm:inset-0",
        "max-sm:h-full",
        "max-sm:max-h-none",
        "max-sm:translate-x-0",
        "max-sm:translate-y-0",
      ]) {
        assert.ok(cls.includes(required), `${id}'s dialog is missing ${required}`);
      }
    }
  });
});
