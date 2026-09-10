// Inferring where a button's device already reports its own state.
//
// Every module row here was read LIVE off a Companion 5.0.3 — the variable name
// and the two values it holds — because inventing either is a binding that
// answers 404 forever, or one that matches neither value and reads unknown
// forever. Neither failure says anything on screen; both look like an operator
// who bound the wrong thing.
//
// The one row NOT read live is OBS `streaming`: that install has three
// recording buttons and no streaming one. Its RECORDING actions were read
// (`StartStopRecording`, `start_recording`, `stop_recording`), which is why the
// streaming test below is about a button being excluded rather than a list of
// action ids being matched.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { inferStateSource, type ExportConnection } from "./companion-state-source.js";
import { parseButtons } from "./companion-export.js";
import { companionExportFixture } from "./fixtures/companion-export.js";

const connections: Record<string, ExportConnection> = {
  plug: { label: "VCR-Overhead-Light", moduleId: "tplink-kasasmartplug" },
  bulb: { label: "Desk-Lamp", moduleId: "tplink-kasasmartbulb" },
  tv: { label: "MA-Foyer-TV-1", moduleId: "vizio-smartcast" },
  projector: { label: "MA_HL_Projector", moduleId: "generic-pjlink" },
  obs: { label: "Studio-OBS", moduleId: "obs-studio" },
  mixer: { label: "Mixer", moduleId: "yamaha-rcp" },
  unlabelled: { label: "", moduleId: "tplink-kasasmartplug" },
};

/** One button, said as the two lists the inference reads. */
const button = (
  feedbacks: { definitionId: string; connectionId: string }[],
  actions: { definitionId: string; connectionId: string }[],
) => ({ feedbacks, actions });

describe("inferStateSource, one row per module", () => {
  test("a kasa smart PLUG publishes power_state, On/Off", () => {
    assert.deepEqual(
      inferStateSource(button([{ definitionId: "powerState", connectionId: "plug" }], []), connections),
      {
        variable: "VCR-Overhead-Light:power_state",
        onValue: "On",
        offValue: "Off",
        moduleId: "tplink-kasasmartplug",
      },
    );
  });

  test("a kasa smart BULB publishes the same variable, and is found through its action", () => {
    // A bulb's feedback is `color`, never `powerState`. Read off the feedback
    // alone, every light in the building would infer nothing.
    assert.deepEqual(
      inferStateSource(
        button(
          [{ definitionId: "color", connectionId: "bulb" }],
          [{ definitionId: "powerOff", connectionId: "bulb" }],
        ),
        connections,
      ),
      {
        variable: "Desk-Lamp:power_state",
        onValue: "On",
        offValue: "Off",
        moduleId: "tplink-kasasmartbulb",
      },
    );
  });

  test("a Vizio television publishes power, not power_state", () => {
    assert.deepEqual(
      inferStateSource(button([{ definitionId: "powerState", connectionId: "tv" }], []), connections),
      {
        variable: "MA-Foyer-TV-1:power",
        onValue: "On",
        offValue: "Off",
        moduleId: "vizio-smartcast",
      },
    );
  });

  test("a PJLink projector publishes powerState", () => {
    assert.deepEqual(
      inferStateSource(
        button([{ definitionId: "powerState", connectionId: "projector" }], []),
        connections,
      ),
      {
        variable: "MA_HL_Projector:powerState",
        onValue: "On",
        offValue: "Off",
        moduleId: "generic-pjlink",
      },
    );
  });

  test("OBS infers `streaming` only for a STREAMING button", () => {
    const streaming = inferStateSource(
      button(
        [{ definitionId: "recording", connectionId: "obs" }],
        [{ definitionId: "StartStopStreaming", connectionId: "obs" }],
      ),
      connections,
    );
    assert.deepEqual(streaming, {
      variable: "Studio-OBS:streaming",
      onValue: "On-Air",
      offValue: "Off-Air",
      moduleId: "obs-studio",
    });

    // The same connection, the recording action. Bound to `streaming` it would
    // report a stream nobody started, every time somebody recorded.
    assert.equal(
      inferStateSource(
        button(
          [{ definitionId: "recording", connectionId: "obs" }],
          [{ definitionId: "StartStopRecording", connectionId: "obs" }],
        ),
        connections,
      ),
      null,
    );
  });
});

describe("which connection the inference reads", () => {
  test("the powerState FEEDBACK wins over the first action", () => {
    // A key that lights up for the projector and whose first action is the
    // television is a key about the projector.
    const inferred = inferStateSource(
      button(
        [{ definitionId: "powerState", connectionId: "projector" }],
        [{ definitionId: "power", connectionId: "tv" }],
      ),
      connections,
    );
    assert.equal(inferred?.variable, "MA_HL_Projector:powerState");
  });

  test("with no powerState feedback it is the FIRST action, not any of them", () => {
    const inferred = inferStateSource(
      button(
        [],
        [
          { definitionId: "power", connectionId: "tv" },
          { definitionId: "power", connectionId: "projector" },
        ],
      ),
      connections,
    );
    assert.equal(inferred?.variable, "MA-Foyer-TV-1:power");
  });

  test("a module this does not know infers nothing — never a guessed name", () => {
    assert.equal(
      inferStateSource(button([], [{ definitionId: "fader", connectionId: "mixer" }]), connections),
      null,
    );
    // An action on Companion's own `internal` connection, which is in no
    // export's instances at all.
    assert.equal(
      inferStateSource(
        button([], [{ definitionId: "button_pressrelease", connectionId: "internal" }]),
        connections,
      ),
      null,
    );
    assert.equal(inferStateSource(button([], []), connections), null);
  });

  test("a connection with no label cannot be named in a variable reference", () => {
    assert.equal(
      inferStateSource(
        button([{ definitionId: "powerState", connectionId: "unlabelled" }], []),
        connections,
      ),
      null,
    );
  });
});

describe("through the real parser, on the fixture export", () => {
  const buttons = parseButtons(companionExportFixture());
  const at = (page: number, row: number, col: number) =>
    buttons.find((b) => b.page === page && b.row === row && b.col === col);

  test("every button carries its inferred source, or null", () => {
    // The fixture's own inferring buttons, EXACTLY. A floor here would go on
    // passing with the feedback array dropped from the parse — the button that
    // matters would just quietly stop inferring.
    assert.deepEqual(
      buttons
        .filter((b) => b.stateSource)
        .map((b) => `${b.page}:${b.row}:${b.col} ${b.stateSource!.variable}`),
      [
        "1:0:1 Projectors:powerState",
        "1:0:2 Projectors:powerState",
        "1:2:3 Projectors:powerState",
        "1:3:0 Projectors:powerState",
        "2:2:0 VCR-Overhead-Light:power_state",
        "2:2:1 Desk-Lamp:power_state",
        "3:2:1 Studio-OBS:streaming",
        "3:3:0 MA-Foyer-TV-1:power",
      ],
    );
  });

  test("the VCR light toggle is the whole case, end to end", () => {
    assert.deepEqual(at(2, 2, 0)?.stateSource, {
      variable: "VCR-Overhead-Light:power_state",
      onValue: "On",
      offValue: "Off",
      moduleId: "tplink-kasasmartplug",
    });
  });

  test("a macro button on `internal` is found by its feedback and nothing else", () => {
    // Every action is an internal key press. Without the control's own
    // feedbacks[] in the parse this button infers nothing.
    assert.equal(at(3, 3, 0)?.stateSource?.variable, "MA-Foyer-TV-1:power");
    assert.deepEqual(at(3, 3, 0)?.drives, []);
  });

  test("the OBS recording toggle beside the streaming one infers nothing", () => {
    assert.equal(at(3, 2, 0)?.stateSource, null);
    assert.equal(at(3, 2, 1)?.stateSource?.variable, "Studio-OBS:streaming");
  });
});
