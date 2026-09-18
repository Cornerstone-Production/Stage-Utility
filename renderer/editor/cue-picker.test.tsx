// The Cue select on a cue-button object.
//
// RENDERED, not asserted over the array it builds: Select is a native <select>,
// so a group is an <optgroup> and the order in the document is the order an
// operator scrolls. A guard over the arrays would pass on a picker that listed
// its groups and then rendered neither.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - BOTH GROUPS, BUILT IN FIRST. That order is the point: the cues the app
//    ships need no rule behind them and are what most buttons are bound to.
//  - EVERY CUE IS STILL IN THE LIST. A filter that dropped one would be a cue
//    that cannot be bound to a button at all, with nothing saying why.
//  - AN EMPTY GROUP IS NOT RENDERED. An install with no cues of its own must
//    not show an empty "Your cues" heading.
//
// NOT unit-tested here: how the closed control looks. jsdom loads no stylesheet.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { CuePicker } = await import("./cue-picker.js");
type CuesLive = import("../main/use-cue-live.js").CuesLive;
type ManifestSwitch = CuesLive["manifest"]["switches"][number];
type ManifestButton = CuesLive["manifest"]["buttons"][number];

after(() => {
  cleanup();
  teardown();
});

const sw = (over: Partial<ManifestSwitch>): ManifestSwitch => ({
  id: "haze",
  name: "Haze",
  room: "Stage",
  on: "haze_on",
  off: "haze_off",
  toggle: false,
  state: "off",
  available: true,
  ...over,
});

const button = (over: Partial<ManifestButton>): ManifestButton => ({
  id: "confetti",
  name: "Confetti",
  room: "",
  cue: "confetti",
  available: true,
  ...over,
});

function mount(
  switches: ManifestSwitch[],
  buttons: ManifestButton[],
  onChange: (v: string) => void = () => {},
) {
  cleanup();
  const cues: CuesLive = {
    manifest: { version: 1, server: { name: "t", lanUrl: null }, switches, buttons },
    states: new Map(),
  };
  return render(
    React.createElement(CuePicker as never, { cues, value: "", onChange }),
  );
}

describe("the cue picker", () => {
  test("renders two groups, built in first, with every cue in one of them", () => {
    const { container } = mount(
      [
        sw({ id: "haze", name: "Haze" }),
        sw({ id: "obs_record", name: "OBS recording", room: "", builtin: true }),
      ],
      [
        button({ id: "confetti", name: "Confetti" }),
        button({ id: "display_refresh", name: "Refresh displays", builtin: true }),
      ],
    );
    const groups = [...container.querySelectorAll("optgroup")];
    assert.deepEqual(groups.map((g) => g.label), ["Built in", "Your cues"]);
    assert.deepEqual(
      groups.map((g) => [...g.querySelectorAll("option")].map((o) => o.value)),
      [
        ["obs_record", "display_refresh"],
        ["haze", "confetti"],
      ],
    );
    // The reading is unchanged: name, room, and which kind it is.
    const labels = [...container.querySelectorAll("optgroup option")].map((o) => o.textContent);
    assert.deepEqual(labels, [
      "OBS recording (switch)",
      "Refresh displays (button)",
      "Haze · Stage (switch)",
      "Confetti (button)",
    ]);
  });

  test("an empty group is left out", () => {
    const onlyBuiltin = mount([sw({ id: "obs_record", name: "OBS recording", builtin: true })], []);
    assert.deepEqual(
      [...onlyBuiltin.container.querySelectorAll("optgroup")].map((g) => g.label),
      ["Built in"],
    );
    const onlyMine = mount([sw({})], []);
    assert.deepEqual(
      [...onlyMine.container.querySelectorAll("optgroup")].map((g) => g.label),
      ["Your cues"],
    );
  });

  test("picking one reports the cue's id", () => {
    const picked: string[] = [];
    const { container } = mount(
      [sw({ id: "obs_record", name: "OBS recording", builtin: true })],
      [],
      (v) => picked.push(v),
    );
    fireEvent.change(container.querySelector("select")!, { target: { value: "obs_record" } });
    assert.deepEqual(picked, ["obs_record"]);
  });
});
