// companion-state-source.ts — where a button's own device already says what it is doing.
//
// PURE: no I/O, no export parsing. companion-export.ts calls this while it walks
// the document and hangs the answer on each button; the import, the reconcile
// and the rule editor all read it from there.
//
// A cue pair reports what it ASKED FOR unless somebody tells this app where the
// truth is — which until now meant a Companion CUSTOM VARIABLE the operator's
// own buttons set. That is real work, done by hand, for every device, and an
// install with few custom variables and forty on/off pairs could not have an
// honest switch on most of them. (The 5.0.3+9703 install this was built against
// has ten custom variables and forty pairs. An earlier comment here said it had
// none at all, which was wrong.)
//
// But the modules already publish it. `$(VCR-Overhead-Light:power_state)` is the
// kasa module's own reading of the plug, updated by its 2-second poll, and
// Companion serves it at /api/variable/<label>/<name>/value. Nothing has to be
// maintained; the connection just has to be identified.
//
// WHICH CONNECTION is the whole problem, because a button may drive several.
// Three pieces of evidence, in this order:
//
//   1. a FEEDBACK with definitionId "powerState". That is the feedback an
//      operator adds to make the key light up when the device is on, so its
//      connection is by construction the device the key is about. Every
//      `powerState` feedback on the real install is on a kasa plug, a Vizio, a
//      PJLink projector or a Panasonic camera.
//   2. the connection of the button's FIRST action, when its module is one this
//      knows. A kasa BULB carries a `color` feedback rather than a `powerState`
//      one, so the feedback alone would miss every light in the building.
//   3. any OTHER feedback. A MACRO key — three internal button presses, no
//      device action at all, and one `obs-studio:recording` feedback — is the
//      real install's "REC START", and the first two pieces of evidence find
//      nothing on it. Last, so a key whose action already names a device this
//      knows keeps being about what it does.
//
// WHICH FACT is the second problem, because a device publishes more than one. A
// recorder has no power state and an OBS box has a stream and a recording on one
// connection, so a module may have SEVERAL rows and the button says which — a
// row carries the definitionId fragments of the actions and feedbacks it belongs
// to (`rec`, `stop`, `transport_status` for a deck's transport), and a row with
// none is the whole connection, which is what a power switch is.
//
// The button's ACTIONS are read before its feedbacks: what a key DOES is what it
// is about, and an OBS stream key that lights up from a `recording` feedback is
// still a stream key. The feedback only has to name the device.
//
// A module this does not know is NO inference — never a guess at a variable
// name. A wrong one is a switch that reads unknown forever, or worse, a switch
// reading the wrong device's power.
//
// EVERY ROW IS VERIFIED, and the source is on the row: read live off this
// install's own Companion, or read out of the module's source at the version
// the install runs. Neither the variable name nor the on value is ever guessed,
// because both failures are silent — a name Companion does not have reads
// unknown forever, and an on value spelled wrong reads unknown at exactly the
// moment the device is doing the thing. `obs-studio`'s streaming value shipped
// as `On-Air` on a guess and was `Live`.

/** What a module publishes for one of its connections, and what its two answers look like. */
export interface InferredStateSource {
  /** The binding, `<connection label>:<variable name>`. See parseVariableRef. */
  variable: string;
  /** The value that means on, spelled as the module writes it — `On`, not `on`. */
  onValue: string;
  /** The value that means off, or `*` — see STATE_ANY_OTHER. */
  offValue: string;
  /** The module it was inferred from, so a caller can say why. */
  moduleId: string;
}

/** One connection as the export declares it. */
export interface ExportConnection {
  /** The label a variable reference names it by (`VCR-Overhead-Light`). */
  label: string;
  moduleId: string;
}

/** An action or a feedback, reduced to the two fields that matter here. */
export interface ControlEntry {
  connectionId: string;
  definitionId: string;
}

/**
 * The off value meaning "anything other than the on value".
 *
 * Declared in this leaf module and re-exported by cue-pairs.ts, which is where
 * a binding's other values live: cue-pairs imports companion-export and
 * companion-export imports this file, so declaring it there and importing it
 * here would close a cycle. One spelling, one definition, both importers.
 *
 * A STATUS variable has more than two answers — a deck's transport reads one of
 * eight words — so a row spells out only its ON value and leaves the rest to
 * this. See cue-states.ts for what it means when the value is compared.
 */
export const STATE_ANY_OTHER = "*";

/**
 * One thing a module publishes about one of its connections.
 *
 * `source` is not read by anything; it is the evidence, kept beside the row it
 * justifies, because a row nobody can re-check is a row nobody dares change.
 */
export interface StateRow {
  /** The module variable, spelled as the module registers it. */
  name: string;
  /** What it holds when the thing is on, spelled as the module writes it. */
  on: string;
  /** What it holds when the thing is off, or STATE_ANY_OTHER. */
  off: string;
  /**
   * Lower-cased fragments of the `definitionId` of an action or feedback this
   * row belongs to. A button on this connection carrying one of them is a
   * button about this fact.
   *
   * ABSENT means the whole connection — every button on it is about the one
   * thing the module publishes, which is what a smart plug or a projector is.
   * Present is what tells an OBS stream key from an OBS record key on the same
   * connection, and a deck's transport keys from its format keys.
   */
  when?: readonly string[];
  /** Where the name and the two values were verified. */
  source: string;
}

/**
 * What each module publishes, by module id, FIRST MATCHING ROW WINS.
 *
 * The values are capitalised because that is what the modules write, and the
 * comparison in cue-states.ts is case-sensitive on purpose — a binding whose
 * values were "on"/"off" against a variable holding "On" is a pair that reads
 * unknown forever with nothing on screen saying why.
 *
 * A POWER row is exact on both values and a STATUS row is `*` on the off value,
 * and the difference is deliberate. A projector warming up reports neither `On`
 * nor `Off`, and reading that as off is a pair somebody presses again mid
 * warm-up — so a power variable keeps its exact off value and reads unknown in
 * between. A recorder that is not recording is not "in between": every one of
 * its other transport words means the same thing to a switch.
 *
 * Every module on the install this was built against is either here or listed
 * in docs/integrations/companion.md as having no on/off state to read.
 *
 * EXPORTED for its own test, which is the only caller: the reconcile writes a
 * binding straight from a row without going through stateBindingProblem, so a
 * row with `*` in the on column — or with its two values the same — would be a
 * pair reading on whatever the device is doing, saved by housekeeping, with no
 * 400 anywhere to catch it. The test walks every row.
 */
export const STATE_SOURCES: Readonly<Record<string, readonly StateRow[]>> = {
  // Both kasa modules answer On/Off on the same variable name.
  "tplink-kasasmartplug": [
    { name: "power_state", on: "On", off: "Off", source: "live read, VCR-Overhead-Light" },
  ],
  "tplink-kasasmartbulb": [
    { name: "power_state", on: "On", off: "Off", source: "live read, Ethan-Office-Desk-Lamp-Left" },
  ],
  "vizio-smartcast": [{ name: "power", on: "On", off: "Off", source: "live read, Box-Foyer-TV" }],
  "generic-pjlink": [
    { name: "powerState", on: "On", off: "Off", source: "live read, MA_HL_Projector" },
  ],
  // A PTZ camera: a real power state, and an SD card recording that is a
  // different fact on the same connection. Both are the module's OFF/ON enum,
  // which is `OFF`/`ON` in capitals and not `Off`/`On`.
  "panasonic-cameras": [
    {
      name: "power",
      on: "ON",
      off: "OFF",
      when: ["power"],
      source: "live read SA-PTZ-Camera/power = ON; src/variables.js v1.2.0 ['power','power',ENUM_OFF_ON]",
    },
    {
      name: "recording",
      on: "ON",
      off: "OFF",
      when: ["sdcardrec", "sdrecstate"],
      source: "live read SA-PTZ-Camera/recording = OFF; src/variables.js v1.2.0 ['recording','recordSD',ENUM_OFF_ON]",
    },
  ],
  // OBS: a stream and a recording on one connection. The install this was built
  // against has three recording buttons and no streaming one, so a recording
  // toggle bound to `streaming` would report a stream nobody started.
  "obs-studio": [
    {
      name: "streaming",
      on: "Live",
      off: STATE_ANY_OTHER,
      when: ["stream"],
      source: "obs-studio 3.15.3 index.js `this.states.streaming ? 'Live' : 'Off-Air'`",
    },
    {
      name: "recording",
      on: "Recording",
      off: STATE_ANY_OTHER,
      when: ["record"],
      source: "live read MA_Video_Mac_Mini_OBS/recording = Stopped; 3.15.3 index.js sets Recording/Paused/Stopped",
    },
  ],
  // A HyperDeck has no power state at all: `status` is its TRANSPORT, and the
  // module capitalises the first letter of the protocol's own word — so
  // `record` on the wire is `Record` in the variable, beside Stopped, Preview,
  // Play, Forward, Rewind, Jog and Shuttle.
  "bmd-hyperdeck": [
    {
      name: "status",
      on: "Record",
      off: STATE_ANY_OTHER,
      when: ["rec", "stop", "transport_status"],
      source:
        "bmd-hyperdeck 2.5.0 src/variables.ts `newValues['status'] = capitalise(instance.transportInfo.status)`, " +
        "TransportStatus.RECORD = 'record' (hyperdeck-connection dist/enums.d.ts)",
    },
  ],
  // An UltraEncode streams and records, and its two status variables read
  // `Streaming`/`Stream` and `Recording`/`Record` — the idle spellings are one
  // letter off the busy ones, which is why the ON value is the only one written
  // here and `Record` is NOT it.
  "magewell-ultrastream": [
    {
      name: "stream_status",
      on: "Streaming",
      off: STATE_ANY_OTHER,
      when: ["stream"],
      source: "live read UltraEncode01-MA-PGM/stream_status = Streaming; src/variables.ts v1.0.1 'Streaming' : 'Stream'",
    },
    {
      name: "record_status",
      on: "Recording",
      off: STATE_ANY_OTHER,
      when: ["record"],
      source: "src/variables.ts v1.0.1 'Recording' : 'Record' — the live read was `Record`, which is IDLE",
    },
  ],
  // A RED camera reports its record state as one of five words, and an empty
  // string until the camera answers at all — which is what the live read
  // returned, the cameras being powered down.
  "red-rcp2": [
    {
      name: "recording",
      on: "Recording",
      off: STATE_ANY_OTHER,
      when: ["record"],
      source:
        "red-rcp2 1.4.8 src/main.js RECORD_STATE stateMap { 0:'Idle', 1:'Recording', 2:'Finalizing', " +
        "3:'Pre-Recording', 4:'Encoding' }",
    },
  ],
};

/** The definitionId of the feedback that means "this key shows a device's power". */
const POWER_FEEDBACK = "powerstate";

/**
 * Where this button's own device already reports its state, or null.
 *
 * `actions` is in the order the export lists them, because the first one is the
 * fallback evidence — a button whose first action is the projector and whose
 * second is a house-lights macro is a button about the projector.
 *
 * Three kinds of evidence, in this order: the `powerState` feedback, the first
 * action, then any other feedback. The first one that names a connection whose
 * module has a row this button matches wins; a connection with no label, an
 * unknown module and a known module with no matching row all fall through to
 * the next.
 */
export function inferStateSource(
  button: { feedbacks: readonly ControlEntry[]; actions: readonly ControlEntry[] },
  connections: Readonly<Record<string, ExportConnection>>,
): InferredStateSource | null {
  const fromPowerFeedback = button.feedbacks.find(
    (f) => f.definitionId.trim().toLowerCase() === POWER_FEEDBACK,
  )?.connectionId;
  const fromAction = button.actions[0]?.connectionId;
  // Every OTHER feedback, LAST. A key whose actions are three internal button
  // presses and whose only device evidence is an `obs-studio:recording`
  // feedback is a real key on the real install — its "REC START" — and read
  // off the power feedback and the first action alone it infers nothing at all.
  // Behind the action on purpose: where the action already names a module this
  // knows, the action is what the key DOES and it keeps the answer it had.
  const fromOtherFeedbacks = button.feedbacks
    .filter((f) => f.connectionId !== fromPowerFeedback)
    .map((f) => f.connectionId);

  for (const connectionId of [fromPowerFeedback, fromAction, ...fromOtherFeedbacks]) {
    if (!connectionId) continue;
    const connection = connections[connectionId];
    // A connection with no label cannot be named in a variable reference at all,
    // whatever its module is.
    if (!connection?.label) continue;
    const row = rowFor(connection.moduleId, {
      actions: definitionIdsOn(button.actions, connectionId),
      feedbacks: definitionIdsOn(button.feedbacks, connectionId),
    });
    if (row) {
      return {
        variable: `${connection.label}:${row.name}`,
        onValue: row.on,
        offValue: row.off,
        moduleId: connection.moduleId,
      };
    }
  }
  return null;
}

/** The definitionIds this button carries on ONE connection, lower-cased. */
function definitionIdsOn(entries: readonly ControlEntry[], connectionId: string): string[] {
  return entries
    .filter((e) => e.connectionId === connectionId)
    .map((e) => e.definitionId.trim().toLowerCase());
}

/**
 * The row this button is about on this module, or null.
 *
 * ACTIONS before feedbacks, both times over the whole row list: a key's actions
 * are what it is about, and its feedbacks only say which device. Read the other
 * way round, an OBS stream key carrying a `recording` feedback — which is a real
 * button on the real install — would report a recording nobody started.
 */
function rowFor(
  moduleId: string,
  ids: { actions: readonly string[]; feedbacks: readonly string[] },
): StateRow | null {
  const rows = STATE_SOURCES[moduleId.trim().toLowerCase()];
  if (!rows) return null;
  for (const definitionIds of [ids.actions, ids.feedbacks]) {
    for (const row of rows) {
      // No `when` is the whole connection, so it matches on the first pass and
      // needs no evidence from the button at all.
      if (!row.when) return row;
      if (row.when.some((fragment) => definitionIds.some((id) => id.includes(fragment)))) return row;
    }
  }
  return null;
}

/**
 * The connection labels on this button that NO table row covers.
 *
 * Its actions' connections and its feedbacks', in that order and de-duplicated:
 * the same evidence inferStateSource walks, minus the ranking, because learning
 * probes every connection rather than picking one.
 *
 * A connection whose module HAS rows is excluded even when the button matched
 * none of them. The module is known, its rows were verified, and a button that
 * matched no row is a button about something the module does not publish — an
 * OBS scene key, a deck's format key. Probing there would bind a scene key to
 * `recording`.
 *
 * A connection with no label is excluded: a variable reference names a
 * connection by its label and there is nothing to ask for.
 */
export function learnableConnections(
  button: { feedbacks: readonly ControlEntry[]; actions: readonly ControlEntry[] },
  connections: Readonly<Record<string, ExportConnection>>,
): string[] {
  const out: string[] = [];
  for (const entry of [...button.actions, ...button.feedbacks]) {
    const connection = connections[entry.connectionId];
    if (!connection?.label) continue;
    if (STATE_SOURCES[connection.moduleId.trim().toLowerCase()]) continue;
    if (!out.includes(connection.label)) out.push(connection.label);
  }
  return out;
}
