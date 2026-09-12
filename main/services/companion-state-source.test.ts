// Inferring where a button's device already reports its own state.
//
// Every module row is verified twice over — the variable name and the ON value
// read live off this install's Companion where the connection is enabled, and
// read out of the module's own source at the version the install runs — because
// inventing either is a binding that answers 404 forever, or one that matches
// neither value and reads unknown forever. Neither failure says anything on
// screen; both look like an operator who bound the wrong thing. The row in
// companion-state-source.ts carries its evidence in a `source` field.
//
// One value could not be read live: OBS `streaming`, because that install has
// three recording buttons and no streaming one. It shipped as `On-Air`, guessed
// from the off value, and the module writes `Live`.
//
// TWO ROWS PER MODULE is the case these tests are mostly about. A recorder has
// no power state and an OBS box has a stream and a recording on one connection,
// so which fact a button is about comes from what the button DOES — and a row
// picked off a feedback instead would report a recording nobody started.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  inferStateSource,
  STATE_ANY_OTHER,
  STATE_SOURCES,
  type ExportConnection,
} from "./companion-state-source.js";
import { parseButtons } from "./companion-export.js";
import { companionExportFixture } from "./fixtures/companion-export.js";

const connections: Record<string, ExportConnection> = {
  plug: { label: "VCR-Overhead-Light", moduleId: "tplink-kasasmartplug" },
  bulb: { label: "Desk-Lamp", moduleId: "tplink-kasasmartbulb" },
  tv: { label: "MA-Foyer-TV-1", moduleId: "vizio-smartcast" },
  projector: { label: "MA_HL_Projector", moduleId: "generic-pjlink" },
  obs: { label: "Studio-OBS", moduleId: "obs-studio" },
  deck: { label: "MA_HyperDeck_01", moduleId: "bmd-hyperdeck" },
  encoder: { label: "UltraEncode01-MA-PGM", moduleId: "magewell-ultrastream" },
  ptz: { label: "SA-PTZ-Camera", moduleId: "panasonic-cameras" },
  cine: { label: "MA-CAM-1", moduleId: "red-rcp2" },
  mixer: { label: "Mixer", moduleId: "yamaha-rcp" },
  // A video router. Its module publishes no variable for a crosspoint, and the
  // live install carries 69 `crosspoint_connected` feedbacks on it — the biggest
  // population of feedback-only evidence on the box.
  router: { label: "MA-Router", moduleId: "generic-swp08" },
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

  test("OBS is two rows, not one — see the next describe for which button picks which", () => {
    // The row list itself: what a STREAMING key gets. `Live` and `*`, because
    // OBS reports Starting, Stopping and Reconnecting as well as Off-Air, and a
    // switch has no use for the difference.
    assert.deepEqual(
      inferStateSource(
        button([], [{ definitionId: "StartStopStreaming", connectionId: "obs" }]),
        connections,
      ),
      {
        variable: "Studio-OBS:streaming",
        // `Live`, which is what obs-studio 3.15.3 writes
        // (`this.states.streaming ? 'Live' : 'Off-Air'`) and what master's
        // getOBSStreamingStateLabel returns. It shipped as `On-Air` — a guess
        // from the off value's spelling, on the one row nothing on the real
        // install could confirm — and a live stream read unknown.
        onValue: "Live",
        offValue: "*",
        moduleId: "obs-studio",
      },
    );
  });
});

describe("the table itself", () => {
  const rows = Object.entries(STATE_SOURCES).flatMap(([moduleId, list]) =>
    list.map((row) => ({ moduleId, ...row })),
  );

  test("EXACTLY the modules and rows that have been verified", () => {
    // Exact, not a floor. A row is a variable name and an on value read off a
    // real module, and a row nobody wrote a test and a docs line for is a
    // binding that reads unknown forever with nothing on screen saying why. A
    // new one fails here until it is named in all three places.
    assert.deepEqual(
      rows.map((r) => `${r.moduleId}:${r.name} ${r.on}/${r.off}`),
      [
        "tplink-kasasmartplug:power_state On/Off",
        "tplink-kasasmartbulb:power_state On/Off",
        "vizio-smartcast:power On/Off",
        "generic-pjlink:powerState On/Off",
        "panasonic-cameras:power ON/OFF",
        "panasonic-cameras:recording ON/OFF",
        "obs-studio:streaming Live/*",
        "obs-studio:recording Recording/*",
        "bmd-hyperdeck:status Record/*",
        "magewell-ultrastream:stream_status Streaming/*",
        "magewell-ultrastream:record_status Recording/*",
        "red-rcp2:recording Recording/*",
      ],
    );
  });

  test("no row can be saved as a binding that reads on whatever the device does", () => {
    // The RECONCILE writes a row straight into a rule's params without going
    // through stateBindingProblem, so these two are the only thing standing
    // between a bad row and a switch that lies. `*` in the on column would
    // match every value; two equal values could never be told apart.
    for (const row of rows) {
      const where = `${row.moduleId}:${row.name}`;
      assert.notEqual(row.on, STATE_ANY_OTHER, where);
      assert.notEqual(row.on, row.off, where);
      assert.notEqual(row.on.trim(), "", where);
      assert.notEqual(row.off.trim(), "", where);
      // Trimmed on both ends before comparison, so a value with whitespace on
      // it would never match what it was read from.
      assert.equal(row.on, row.on.trim(), where);
      assert.equal(row.off, row.off.trim(), where);
      // And the evidence, on the row, in the same object a reader changes.
      assert.notEqual(row.source.trim(), "", where);
    }
  });

  test("every `when` fragment is lower-cased, because definitionIds are compared lower-cased", () => {
    // `sdCardRec` as a fragment would match nothing at all — silently, on the
    // one module whose action ids are camelCase.
    for (const row of rows) {
      for (const fragment of row.when ?? []) {
        assert.equal(fragment, fragment.toLowerCase(), `${row.moduleId}:${row.name}`);
      }
    }
  });
});

describe("a module with more than one row, and the button that picks it", () => {
  test("a HyperDeck's transport: `status` is Record, and anything else is off", () => {
    // The deck publishes no power state at all. `status` is its transport, and
    // the module capitalises the protocol's own word — `record` on the wire is
    // `Record` in the variable.
    for (const definitionId of ["rec", "recAppend", "stop"]) {
      assert.deepEqual(
        inferStateSource(button([], [{ definitionId, connectionId: "deck" }]), connections),
        {
          variable: "MA_HyperDeck_01:status",
          onValue: "Record",
          offValue: "*",
          moduleId: "bmd-hyperdeck",
        },
        definitionId,
      );
    }
    // A macro key whose only deck evidence is the transport FEEDBACK — the
    // shape the real install's "REC START" has, whose actions are all internal
    // key presses.
    assert.equal(
      inferStateSource(
        button(
          [{ definitionId: "transport_status", connectionId: "deck" }],
          [{ definitionId: "rec", connectionId: "deck" }],
        ),
        connections,
      )?.variable,
      "MA_HyperDeck_01:status",
    );
  });

  test("a deck key that is not about the transport infers nothing", () => {
    // Formatting a disk. Bound to `status` it would be a switch reporting
    // whether the deck is recording, on a key that cannot start a recording.
    assert.equal(
      inferStateSource(
        button([], [{ definitionId: "formatPrepare", connectionId: "deck" }]),
        connections,
      ),
      null,
    );
  });

  test("an UltraEncode has a stream row and a record row on ONE connection", () => {
    assert.deepEqual(
      inferStateSource(button([], [{ definitionId: "stream", connectionId: "encoder" }]), connections),
      {
        variable: "UltraEncode01-MA-PGM:stream_status",
        onValue: "Streaming",
        offValue: "*",
        moduleId: "magewell-ultrastream",
      },
    );
    // `Recording`, NOT `Record`. The module writes `Record` when it is IDLE —
    // one letter apart — so a row taking the live read at face value would have
    // been a switch that reads on whenever the encoder is not recording.
    assert.deepEqual(
      inferStateSource(button([], [{ definitionId: "record", connectionId: "encoder" }]), connections),
      {
        variable: "UltraEncode01-MA-PGM:record_status",
        onValue: "Recording",
        offValue: "*",
        moduleId: "magewell-ultrastream",
      },
    );
  });

  test("a Panasonic camera's power and SD recording are ON/OFF in capitals", () => {
    assert.deepEqual(
      inferStateSource(
        button(
          [{ definitionId: "powerState", connectionId: "ptz" }],
          [{ definitionId: "power", connectionId: "ptz" }],
        ),
        connections,
      ),
      { variable: "SA-PTZ-Camera:power", onValue: "ON", offValue: "OFF", moduleId: "panasonic-cameras" },
    );
    assert.deepEqual(
      inferStateSource(button([], [{ definitionId: "sdCardRec", connectionId: "ptz" }]), connections),
      {
        variable: "SA-PTZ-Camera:recording",
        onValue: "ON",
        offValue: "OFF",
        moduleId: "panasonic-cameras",
      },
    );
    // A preset RECALL key. `presetRecallScope` contains "rec", which is why the
    // recording row matches `sdCardRec` and `sdRecState` and not the word.
    assert.equal(
      inferStateSource(
        button([], [{ definitionId: "presetRecallScope", connectionId: "ptz" }]),
        connections,
      ),
      null,
    );
  });

  test("a RED camera's record toggle reads `recording`, off for its four other words", () => {
    assert.deepEqual(
      inferStateSource(
        button([], [{ definitionId: "toggle_recording", connectionId: "cine" }]),
        connections,
      ),
      { variable: "MA-CAM-1:recording", onValue: "Recording", offValue: "*", moduleId: "red-rcp2" },
    );
    // An exposure key on the same camera is not a record key.
    assert.equal(
      inferStateSource(
        button([], [{ definitionId: "increase_exposure_adjust", connectionId: "cine" }]),
        connections,
      ),
      null,
    );
  });

  test("OBS records and streams on one connection, and the ACTION decides which", () => {
    // The real install's OBS keys all carry a `recording` FEEDBACK, streaming
    // ones included. Picked off the feedback, a stream key would report a
    // recording nobody started — so actions are read first.
    assert.equal(
      inferStateSource(
        button(
          [{ definitionId: "recording", connectionId: "obs" }],
          [{ definitionId: "StartStopStreaming", connectionId: "obs" }],
        ),
        connections,
      )?.variable,
      "Studio-OBS:streaming",
    );
    assert.deepEqual(
      inferStateSource(
        button(
          [{ definitionId: "recording", connectionId: "obs" }],
          [{ definitionId: "StartStopRecording", connectionId: "obs" }],
        ),
        connections,
      ),
      {
        variable: "Studio-OBS:recording",
        onValue: "Recording",
        offValue: "*",
        moduleId: "obs-studio",
      },
    );
    // A macro key with no OBS action at all: the feedback is the only evidence,
    // and it names the recording.
    assert.equal(
      inferStateSource(
        button(
          [{ definitionId: "recording", connectionId: "obs" }],
          [{ definitionId: "button_pressrelease", connectionId: "internal" }],
        ),
        connections,
      )?.variable,
      "Studio-OBS:recording",
    );
  });

  test("an OBS key that is neither infers nothing", () => {
    assert.equal(
      inferStateSource(
        button([], [{ definitionId: "set_scene", connectionId: "obs" }]),
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

  // The dangerous half of the case above, and the reason it is separate: a
  // FEEDBACK is the FIRST evidence inferStateSource looks at, and `powerState`
  // is the one it looks for by name. A device whose state exists only as a
  // feedback — a router crosspoint, a console fader — must still infer nothing,
  // because an HTTP client cannot read a feedback's result. Offered a source
  // here, the pair would bind to a name Companion answers 404 for and read
  // unknown forever with nothing on screen saying why.
  test("a FEEDBACK-only device is offered nothing, including a powerState one", () => {
    for (const definitionId of ["powerState", "crosspoint_connected", "MIXER_Current/Cue/StInCh/On"]) {
      for (const connectionId of ["router", "mixer"]) {
        assert.equal(
          inferStateSource(button([{ definitionId, connectionId }], []), connections),
          null,
          `${connections[connectionId]!.moduleId} was offered a source from its ${definitionId} feedback`,
        );
      }
    }
  });

  // And with a feedback AND an action, both on the unknown module: neither piece
  // of evidence may become a guess.
  test("a feedback-only device with actions of its own is still offered nothing", () => {
    assert.equal(
      inferStateSource(
        button(
          [{ definitionId: "crosspoint_connected", connectionId: "router" }],
          [{ definitionId: "set_crosspoint", connectionId: "router" }],
        ),
        connections,
      ),
      null,
    );
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
        // The recording key infers now, where it used to infer nothing: the
        // fact it is about has a row of its own rather than being excluded from
        // the streaming one.
        "3:2:0 Studio-OBS:recording",
        "3:2:1 Studio-OBS:streaming",
        "3:3:0 MA-Foyer-TV-1:power",
        "5:0:0 MA_HyperDeck_01:status",
        "5:0:1 UltraEncode01-MA-PGM:record_status",
        "5:1:0 MA_HyperDeck_01:status",
        "5:1:1 MA_HyperDeck_01:status",
        "5:2:0 UltraEncode01-MA-PGM:record_status",
        "5:2:1 UltraEncode01-MA-PGM:stream_status",
        "5:3:0 SA-PTZ-Camera:power",
        "5:3:1 SA-PTZ-Camera:power",
        "5:3:2 SA-PTZ-Camera:recording",
        "5:4:0 MA-CAM-1:recording",
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

  test("the OBS recording toggle beside the streaming one reads the OTHER variable", () => {
    assert.equal(at(3, 2, 0)?.stateSource?.variable, "Studio-OBS:recording");
    assert.equal(at(3, 2, 1)?.stateSource?.variable, "Studio-OBS:streaming");
  });

  test("a deck key that is not a transport key still infers nothing", () => {
    // `Format Decks` drives the deck and is not about its transport, so the
    // page's one non-inferring button is that and only that.
    assert.equal(at(5, 5, 0)?.stateSource, null);
    assert.deepEqual(at(5, 5, 0)?.drives, ["bmd-hyperdeck"]);
  });
});
