// companion-state-source.ts — where a button's own device already says what it is doing.
//
// PURE: no I/O, no export parsing. companion-export.ts calls this while it walks
// the document and hangs the answer on each button; the import, the reconcile
// and the rule editor all read it from there.
//
// A cue pair reports what it ASKED FOR unless somebody tells this app where the
// truth is — which until now meant a Companion CUSTOM VARIABLE the operator's
// own buttons set. That is real work, done by hand, for every device, and an
// install with no custom variables at all (the 5.0.3 one this was built against
// had none) could not have a single honest switch.
//
// But the modules already publish it. `$(VCR-Overhead-Light:power_state)` is the
// kasa module's own reading of the plug, updated by its 2-second poll, and
// Companion serves it at /api/variable/<label>/<name>/value. Nothing has to be
// maintained; the connection just has to be identified.
//
// WHICH CONNECTION is the whole problem, because a button may drive several. Two
// pieces of evidence, in this order:
//
//   1. a FEEDBACK with definitionId "powerState". That is the feedback an
//      operator adds to make the key light up when the device is on, so its
//      connection is by construction the device the key is about. Every
//      `powerState` feedback on the real install is on a kasa plug, a Vizio or
//      a PJLink projector.
//   2. the connection of the button's FIRST action, when its module is one this
//      knows. A kasa BULB carries a `color` feedback rather than a `powerState`
//      one, so the feedback alone would miss every light in the building.
//
// A module this does not know is NO inference — never a guess at a variable
// name. A wrong one is a switch that reads unknown forever, or worse, a switch
// reading the wrong device's power.

/** What a module publishes for one of its connections, and what its two answers look like. */
export interface InferredStateSource {
  /** The binding, `<connection label>:<variable name>`. See parseVariableRef. */
  variable: string;
  /** The value that means on, spelled as the module writes it — `On`, not `on`. */
  onValue: string;
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
 * The power variable each module publishes, read LIVE off a real Companion
 * 5.0.3 rather than out of a module's source.
 *
 * The VALUES are capitalised because that is what the modules write, and the
 * comparison in cue-states.ts is case-sensitive on purpose — a binding whose
 * values were "on"/"off" against a variable holding "On" is a pair that reads
 * unknown forever with nothing on screen saying why.
 */
const POWER_SOURCES: Readonly<Record<string, { name: string; on: string; off: string }>> = {
  // Both kasa modules answer On/Off on the same variable name.
  "tplink-kasasmartplug": { name: "power_state", on: "On", off: "Off" },
  "tplink-kasasmartbulb": { name: "power_state", on: "On", off: "Off" },
  "vizio-smartcast": { name: "power", on: "On", off: "Off" },
  "generic-pjlink": { name: "powerState", on: "On", off: "Off" },
};

/**
 * OBS, which is not a power switch and needs the button read as well as the
 * connection.
 *
 * `streaming` is On-Air/Off-Air. `recording` is a different thing on the same
 * connection — the install this was built against has three recording buttons
 * and no streaming one — so a recording toggle bound to `streaming` would
 * report a stream nobody started. Only a button whose actions are STREAMING
 * actions infers anything.
 *
 * The recording action ids were read live (`StartStopRecording`,
 * `start_recording`, `stop_recording`); the streaming ones were not, because
 * that install has no streaming button. Matched on the word rather than on a
 * list of ids for exactly that reason.
 */
const OBS_MODULE = "obs-studio";
const OBS_STREAMING = { name: "streaming", on: "On-Air", off: "Off-Air" };

/** The definitionId of the feedback that means "this key shows a device's power". */
const POWER_FEEDBACK = "powerstate";

/**
 * Where this button's device already reports its state, or null.
 *
 * `actions` is in the order the export lists them, because the first one is the
 * fallback evidence — a button whose first action is the projector and whose
 * second is a house-lights macro is about the projector.
 */
export function inferStateSource(
  button: { feedbacks: readonly ControlEntry[]; actions: readonly ControlEntry[] },
  connections: Readonly<Record<string, ExportConnection>>,
): InferredStateSource | null {
  const fromFeedback = button.feedbacks.find(
    (f) => f.definitionId.trim().toLowerCase() === POWER_FEEDBACK,
  )?.connectionId;
  const fromAction = button.actions[0]?.connectionId;

  for (const connectionId of [fromFeedback, fromAction]) {
    if (!connectionId) continue;
    const connection = connections[connectionId];
    // A connection with no label cannot be named in a variable reference at all,
    // whatever its module is.
    if (!connection?.label) continue;
    const source = sourceFor(connection.moduleId, button.actions, connectionId);
    if (source) {
      return {
        variable: `${connection.label}:${source.name}`,
        onValue: source.on,
        offValue: source.off,
        moduleId: connection.moduleId,
      };
    }
  }
  return null;
}

/** The variable this module publishes for this button, or null. */
function sourceFor(
  moduleId: string,
  actions: readonly ControlEntry[],
  connectionId: string,
): { name: string; on: string; off: string } | null {
  const id = moduleId.trim().toLowerCase();
  const power = POWER_SOURCES[id];
  if (power) return power;
  if (id !== OBS_MODULE) return null;
  // Only a streaming button. A recording one is the same connection and a
  // different fact, and there are three of those on the real install.
  const streams = actions.some(
    (a) => a.connectionId === connectionId && /stream/i.test(a.definitionId),
  );
  return streams ? OBS_STREAMING : null;
}
