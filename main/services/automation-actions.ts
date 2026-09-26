// automation-actions.ts — the ONLY part of the engine that touches hardware.
//
// Each provider honours `simulate` itself, so suppression happens at the one place
// that does I/O rather than being trusted to the engine. No provider throws: a
// failure is a returned result, so one bad device cannot stop the engine or block
// the next rule.

import { errorMessage } from "./errors.js";
import type { ActionDef, ActionResult } from "../types/automation.js";
import type { BaptismState, PcoLiveDTO } from "../types/stage.js";
import { advanceGuard } from "./automation-pco-items.js";
import { baptismTimerService } from "./baptism-timer-service.js";
import { broadcast } from "./broadcaster.js";
import { companionApi } from "./companion-api.js";
import { missingSentence, readFingerprint } from "./companion-fingerprint.js";
import { isObsOutputCommand, obsOutput, obsOutputNoun, type ObsOutputKind } from "./obs-service.js";
import { oscManager } from "./osc-manager.js";
import { propresenterManager } from "./propresenter-service.js";
import { isReaperTransportCommand, reaperService } from "./reaper-service.js";
import { rosstalkManager } from "./rosstalk-manager.js";
import { stageController } from "./stage-controller.js";
import { matchRoster } from "./automation-roster-match.js";
import { signalStore } from "./signal-store.js";
// A separate module rather than nine more literals here: they share resolveLayer,
// byUuid, nameSegment and flagAction, and the verify-then-report reasoning is a
// page of comment that belongs beside the thing it governs.
import { PVP_ACTIONS } from "./pvp-actions.js";
import { externKeyed } from "../types/extern-keyed.js";

const ok = (detail: string): ActionResult => ({ ok: true, detail });
const fail = (detail: string): ActionResult => ({ ok: false, detail });

/** A "key-value" param's stored JSON object, as a plain string map. Malformed
 *  config yields an empty table rather than throwing — the action then fails with
 *  "no entry in the table", which says more than a stack trace would. */
function parseRows(raw: unknown): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]));
  }
  const text = String(raw ?? "").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [String(k).trim(), String(v ?? "").trim()]),
    );
  } catch {
    return {};
  }
}

/**
 * The body of both OBS output actions, written once.
 *
 * Two actions rather than one with a second dropdown, because a cue pair's two
 * halves each carry ONE action with ONE command — and the two outputs are bound
 * to different state sources. What they share is this, so "simulate reaches
 * nothing" and "a command nobody chose is refused" cannot hold for recording and
 * quietly not for streaming.
 */
async function runObsOutput(
  kind: ObsOutputKind,
  params: Record<string, unknown>,
  simulate: boolean,
): Promise<ActionResult> {
  const command = String(params.command ?? "").trim();
  if (!isObsOutputCommand(command)) {
    return fail(command ? `"${command}" is not an OBS ${kind} command` : "no command chosen");
  }
  // Ahead of the service on purpose, exactly as reaper.transport is: a simulated
  // run must not read the snapshot either, so a rule can be written and tested
  // with OBS not running — which is when a rule is usually written.
  if (simulate) return ok(`would ${command} ${obsOutputNoun(kind)}`);
  const result = await obsOutput(kind, command);
  return result.ok ? ok(`${command}: ${result.detail}`) : fail(`${command}: ${result.detail}`);
}

/**
 * What `baptism.advance` just did, in words — for the Activity log, so a
 * Sunday-morning operator can see which of the five things one physical key did
 * without opening the timer. Describes the transition ACTUALLY taken (`before`
 * compared against `after`, both real BaptismState snapshots) rather than
 * predicting one from `before` alone: the baptismTimerService is the only place
 * that decides what advance() does in a given phase, and re-deriving that
 * decision here risks drifting from it. The one case that cannot be told from
 * `before` alone is the last person in a grouped session, whose advance() call
 * auto-finishes the whole session — caught by checking `after` first.
 */
function describeBaptismAdvance(before: BaptismState, after: BaptismState): string {
  if (after.phase === "idle" && before.phase !== "idle") return "finished the baptism session";
  if (before.phase === "idle") return "started a baptism session";
  if (before.armed) return "began person 1";
  if (before.phase === "testimony") {
    return before.mode === "grouped" ? "moved to the next testimony" : "marked baptized";
  }
  return "moved to the next person";
}

/** The two things the PCO Live action touches, behind a seam. Tests replace them;
 *  nothing else should. Kept deliberately narrow — the point is to be able to
 *  assert that one invocation issues at MOST one step, which is the guarantee
 *  that stops a rule running away through a live plan. */
export const liveDeps: {
  getLive: () => PcoLiveDTO | null;
  advance: () => Promise<void>;
} = {
  getLive: () => stageController.getLastLive(),
  advance: () => stageController.controlLive("next"),
};

export const AUTOMATION_ACTIONS: Record<string, ActionDef> = externKeyed({
  "log.message": {
    id: "log.message",
    label: "Write a log message",
    help: "Does nothing else. Use it to prove a rule fires at the right moment before pointing it at real gear.",
    params: [{ key: "message", label: "Message", type: "string" }],
    run: async (params) => ok(String(params.message ?? "(no message)")),
  },

  "companion.signal-from-roster": {
    id: "companion.signal-from-roster",
    label: "Set a Companion signal from the roster",
    help:
      "Publishes a value for a Companion Trigger to act on. Never contacts Dante and never presses a button. " +
      "On any failure it holds the previous value, so a scheduling mistake cannot take a live route away.",
    params: [
      { key: "signal", label: "Signal name", type: "string", help: "Companion reads $(stage:signal_<name>)" },
      { key: "marker", label: "Marker in notes", type: "string", help: "e.g. TB. Whole word, case-insensitive." },
      { key: "position", label: "Only this position", type: "string", optional: true, help: "Leave blank for any." },
      {
        key: "rows",
        label: "Send for each slot",
        type: "key-value",
        keyLabel: "Slot",
        valueLabel: "Send exactly",
        help: "Type the name exactly as it appears in Dante Controller. Nothing validates it.",
      },
    ],
    run: async (params, ctx) => {
      const signal = String(params.signal ?? "").trim();
      if (!signal) return fail("no signal name configured");

      const match = matchRoster(stageController.getTeamMembers(), {
        marker: String(params.marker ?? ""),
        position: String(params.position ?? ""),
      });
      if (!match.ok) {
        // Hold the previous value. Recording the reason is what turns this into a
        // red button in Companion rather than a silent nothing.
        if (!ctx.simulate) await signalStore.fail(signal, match.reason);
        return fail(match.reason);
      }

      const rows = parseRows(params.rows);
      const value = rows[String(match.slot)];
      if (!value) {
        const reason = `${match.member.name} is in slot ${match.slot}, which has no entry in the table`;
        if (!ctx.simulate) await signalStore.fail(signal, reason);
        return fail(reason);
      }

      const detail = `${signal} = "${value}" (${match.member.name}, slot ${match.slot})`;
      if (ctx.simulate) return ok(`SIMULATED ${detail}`);
      await signalStore.set(signal, value);
      return ok(detail);
    },
  },

  "companion.press": {
    id: "companion.press",
    label: "Press a Companion button",
    help:
      "Presses ONE button at a page/row/column, exactly as a finger would. Companion confirms it " +
      "delivered the press, never that the device did anything — so this reports \"dispatched\", not \"on\". " +
      "For a sequence, make a Companion button that runs the sequence and press that: one action is one press, " +
      "so a rule can never half-run a chain.",
    params: [
      { key: "page", label: "Page", type: "number", min: 1, max: 999 },
      { key: "row", label: "Row", type: "number", min: 0, max: 99 },
      { key: "col", label: "Column", type: "number", min: 0, max: 99 },
      {
        key: "label",
        label: "Button label",
        type: "string",
        optional: true,
        help: "What the button said when it was picked. Recorded in the log so a moved button is obvious.",
      },
      // pageId, actionIds, status, lastSeenAt and movedFrom are also stored on
      // this action and are deliberately NOT ParamDefs: they are written by the
      // picker and by the reconcile, never typed. A form field for "action ids"
      // is a field whose only use is to break the identity. See
      // companion-fingerprint.ts.
    ],
    run: async (params, ctx) => {
      const page = Number(params.page);
      const row = Number(params.row);
      const col = Number(params.col);
      if (![page, row, col].every(Number.isFinite)) {
        return fail("no Companion button chosen");
      }
      // Whole, non-negative numbers only. Every one of these goes into the press
      // URL as a path segment, so "1.5" is a coordinate Companion cannot have and
      // "../.." is a different request altogether. companionApi.press refuses the
      // same shapes for callers that do not come through here.
      if (![page, row, col].every((n) => Number.isInteger(n) && n >= 0)) {
        return fail(`p${page} r${row} c${col} is not a Companion coordinate — whole numbers, none negative`);
      }
      // The last reconcile could not find this button in Companion's export.
      // REFUSED, not pressed: the coordinates now hold either nothing or
      // somebody else's button, and Companion answers 204 for the first and a
      // cheerful 200 for the second. See companion-reconcile.ts.
      //
      // Here rather than only in the call route, because a rule can fire from
      // any trigger and from the editor's Test button, and a guard on one path
      // is a guard the other three walk around.
      const fingerprint = readFingerprint(params as Record<string, string | number>);
      if (fingerprint.status === "missing") {
        return fail(`${missingSentence(fingerprint)} — re-pick the button on this rule`);
      }
      const label = String(params.label ?? "").trim();
      const named = `p${page} r${row} c${col}${label ? ` "${label}"` : ""}`;
      if (ctx.simulate) return ok(`would press ${named}`);
      const result = await companionApi.press({ page, row, col });
      // "dispatched", never "on": Companion answers 200 the moment it hands the
      // press to the control. Whether the projector woke up is not in that answer
      // and must not be implied by this wording.
      return result.ok ? ok(`dispatched ${named}`) : fail(`${named}: ${result.detail}`);
    },
  },

  "rosstalk.command": {
    id: "rosstalk.command",
    label: "Send a RossTalk command",
    params: [
      { key: "targetId", label: "Target", type: "enum", optionsFrom: "rosstalk-targets" },
      { key: "commandId", label: "Command", type: "enum", optionsFrom: "rosstalk-commands" },
    ],
    run: async (params, ctx) => {
      try {
        // RossTalk has its OWN simulate too; they compose by AND, so a command
        // reaches the wire only when both are off.
        if (ctx.simulate) return ok(`would send ${String(params.commandId)}`);
        const r = await rosstalkManager.send(String(params.targetId), {
          commandId: String(params.commandId),
          params: params as Record<string, string | number>,
        });
        return ok(`${r.line}${r.simulated ? " (RossTalk simulate)" : ""}`);
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  },

  "osc.send": {
    id: "osc.send",
    label: "Send an OSC message",
    params: [
      { key: "targetId", label: "Target", type: "enum", optionsFrom: "osc-targets" },
      { key: "address", label: "Address", type: "string", help: "e.g. /ch/01/mix/on" },
    ],
    run: async (params, ctx) => {
      try {
        if (ctx.simulate) return ok(`would send ${String(params.address)}`);
        await oscManager.send(String(params.targetId), String(params.address), []);
        return ok(`sent ${String(params.address)}`);
      } catch (e) {
        return fail(errorMessage(e));
      }
    },
  },

  "reaper.transport": {
    id: "reaper.transport",
    label: "REAPER transport",
    help:
      "Drives REAPER through the same web interface the REAPER integration polls, so nothing else has to be set up " +
      "(Preferences → Control/OSC/web → \"Web browser interface\"). Record does NOTHING when REAPER is already " +
      "recording: REAPER's Record is a toggle, and a cue said twice would otherwise end the recording.",
    params: [
      {
        key: "command",
        label: "Command",
        type: "enum",
        options: [
          { value: "record", label: "Start recording" },
          { value: "stop", label: "Stop" },
          { value: "play", label: "Play" },
        ],
      },
    ],
    run: async (params, ctx) => {
      const command = String(params.command ?? "").trim();
      if (!isReaperTransportCommand(command)) {
        return fail(command ? `"${command}" is not a REAPER transport command` : "no command chosen");
      }
      // Ahead of the service on purpose: a simulated run must not read the
      // transport either, so a rule can be tested with REAPER off the network.
      if (ctx.simulate) return ok(`would send ${command}`);
      const result = await reaperService.transport(command);
      return result.ok ? ok(`${command}: ${result.detail}`) : fail(`${command}: ${result.detail}`);
    },
  },

  "obs.record": {
    id: "obs.record",
    label: "OBS recording",
    help:
      "Starts or stops OBS's recording over the SAME obs-websocket connection the OBS integration holds, so there " +
      "is nothing else to set up and no Companion button in the middle. Start does nothing when OBS is already " +
      "recording, and Stop does nothing when it is not — OBS answers a redundant one with a request error, which " +
      "would read as a failed cue over a recording that is running perfectly well.",
    params: [
      {
        key: "command",
        label: "Command",
        type: "enum",
        options: [
          { value: "start", label: "Start recording" },
          { value: "stop", label: "Stop recording" },
        ],
      },
    ],
    run: async (params, ctx) => runObsOutput("record", params, ctx.simulate),
  },

  "obs.stream": {
    id: "obs.stream",
    label: "OBS streaming",
    help:
      "Starts or stops OBS's stream over the SAME obs-websocket connection the OBS integration holds. Start does " +
      "nothing when OBS is already streaming and Stop does nothing when it is not, exactly as the recording action " +
      "does — and for the same reason.",
    params: [
      {
        key: "command",
        label: "Command",
        type: "enum",
        options: [
          { value: "start", label: "Start streaming" },
          { value: "stop", label: "Stop streaming" },
        ],
      },
    ],
    run: async (params, ctx) => runObsOutput("stream", params, ctx.simulate),
  },

  "obs.virtual-cam": {
    id: "obs.virtual-cam",
    label: "OBS virtual camera",
    help:
      "Starts or stops OBS's virtual camera over the SAME obs-websocket connection the OBS integration holds — the " +
      "output a video call picks up as a webcam. Start does nothing when it is already running and Stop does " +
      "nothing when it is not, exactly as the recording action does.",
    params: [
      {
        key: "command",
        label: "Command",
        type: "enum",
        options: [
          { value: "start", label: "Start virtual camera" },
          { value: "stop", label: "Stop virtual camera" },
        ],
      },
    ],
    run: async (params, ctx) => runObsOutput("virtualCam", params, ctx.simulate),
  },

  "propresenter.macro": {
    id: "propresenter.macro",
    label: "Trigger a ProPresenter macro",
    help:
      "Runs one of your own ProPresenter macros — whatever it does there, it does here. Needs ProPresenter's " +
      "Network API switched on (Preferences \u2192 Network), the same prerequisite as the ProPresenter integration. " +
      "The macro is stored by NAME, not by its uuid, so it survives a re-import and means the same thing on both " +
      "booth machines; rename it in ProPresenter and the rule stops finding it, and says so.",
    params: [
      {
        key: "instance",
        label: "ProPresenter",
        type: "enum",
        optionsFrom: "propresenter-instances",
        optional: true,
        // Blank is the primary, the same as everywhere else in the app that
        // names an instance (layout objects, the thumbnail proxy). Said out
        // loud on the form, because "it silently picked the main auditorium"
        // is not something to discover during a service.
        help: "Leave blank for the main one.",
      },
      { key: "macro", label: "Macro", type: "enum", optionsFrom: "propresenter-macros" },
    ],
    run: async (params, ctx) => {
      const macro = String(params.macro ?? "").trim();
      // Named before anything is contacted, the same as the REAPER transport
      // action refusing a command it does not have: a rule saved with the
      // dropdown untouched must say so, not dial a machine and get a 404.
      if (!macro) return fail("no macro chosen");
      // Ahead of the manager on purpose: a simulated run must reach nothing, so
      // a rule can be written and tested with the booth machine off — which is
      // when a rule is usually written.
      if (ctx.simulate) return ok(`would trigger "${macro}"`);
      const result = await propresenterManager.triggerMacro(String(params.instance ?? ""), macro);
      return result.ok ? ok(result.detail) : fail(result.detail);
    },
  },

  "pco.live.advance": {
    id: "pco.live.advance",
    label: "Advance PCO Live one item",
    help:
      "Takes exactly one step forward, the same as PCO's own next-item control. PCO has no jump action, so a rule can never skip ahead. Needs the connected account to be permitted to control Live for this service type; it never takes control from whoever is driving.",
    params: [
      {
        key: "guardTitle",
        label: "Only if the next item is",
        type: "string",
        optional: true,
        optionsFrom: "plan-items",
        help: "Leave blank to step forward unconditionally.",
      },
    ],
    run: async (params, ctx) => {
      try {
        const live = liveDeps.getLive();
        const verdict = advanceGuard(live?.nextItemTitle ?? null, String(params.guardTitle ?? ""));
        // A skip is a real outcome, not a silent no-op: the reason has to reach
        // the Activity log or a rule that never fires looks identical to one that
        // was never armed.
        if (!verdict.advance) return ok(`skipped - ${verdict.reason}`);
        if (ctx.simulate) return ok(`would advance - ${verdict.reason}`);
        // ONE step. Never a loop: PCO would fire every item stepped over.
        await liveDeps.advance();
        return ok(`advanced - ${verdict.reason}`);
      } catch (e) {
        // PCO's own wording (e.g. a 403 refusing an account that cannot control
        // Live) is the useful part — pass it through verbatim.
        return fail(errorMessage(e));
      }
    },
  },

  "display.refresh": {
    id: "display.refresh",
    label: "Refresh all displays",
    params: [],
    run: async (_params, ctx) => {
      if (ctx.simulate) return ok("would refresh displays");
      broadcast("display:refresh", { at: new Date().toISOString() });
      return ok("refreshed displays");
    },
  },

  "baptism.start": {
    id: "baptism.start",
    label: "Start a baptism session",
    help:
      "Begins a fresh session at person 1's testimony. Does nothing when a session is already " +
      "running — use Advance or Back to move it, not a second Start.",
    params: [],
    run: async (_params, ctx) => {
      if (baptismTimerService.getState().phase !== "idle") {
        return fail("a baptism session is already running");
      }
      if (ctx.simulate) return ok("would start a baptism session");
      baptismTimerService.start();
      return ok("started a baptism session");
    },
  },

  "baptism.advance": {
    id: "baptism.advance",
    label: "Advance the baptism timer",
    help:
      "The phase-aware primary press — whatever the operator panel's main button would do right " +
      "now: start a session from idle, begin person 1 once armed, close a testimony or a baptism, " +
      "and move to the next person. One button runs the whole service, so nobody has to know which " +
      "action is legal in which phase.",
    params: [],
    run: async (_params, ctx) => {
      // advance() falls through to next() in the baptism phase, and next()'s
      // grouped branch is a documented no-op (same reference back) for a
      // restored record with nobody at the current baptismIndex — the exact
      // shape undo() guards against below. Silently reporting success there
      // is the one thing this action must never do: it is what a physical key
      // fires. advanceWouldChange() is the SAME predicate next()'s own guard
      // runs on, so a dry run cannot say "would advance" over a state a real
      // press would refuse.
      const refusal = "the baptism timer did not move — this session was restored with nobody at this position";
      if (!baptismTimerService.advanceWouldChange()) return fail(refusal);
      if (ctx.simulate) return ok("would advance the baptism timer");
      const before = baptismTimerService.getState();
      const after = baptismTimerService.advance();
      if (after === before) return fail(refusal);
      return ok(describeBaptismAdvance(before, after));
    },
  },

  "baptism.back": {
    id: "baptism.back",
    label: "Step the baptism timer back",
    help: "Undoes the last press without losing the session — fixes a mis-tap.",
    params: [],
    run: async (_params, ctx) => {
      // undoWouldChange() is the same predicate undo()'s own guards run on —
      // see baptism.advance above for why a dry run must ask it too.
      if (!baptismTimerService.undoWouldChange()) return fail("nothing to undo");
      if (ctx.simulate) return ok("would step the baptism timer back");
      const before = baptismTimerService.getState();
      const after = baptismTimerService.undo();
      if (after === before) return fail("nothing to undo");
      return ok("stepped the baptism timer back");
    },
  },

  "baptism.pause": {
    id: "baptism.pause",
    label: "Pause or resume the baptism timer",
    help:
      "Toggles: pauses a running clock, resumes a paused one. Idle and armed have no clock running " +
      "to pause, and the action says so rather than doing nothing silently.",
    params: [],
    run: async (_params, ctx) => {
      const state = baptismTimerService.getState();
      if (state.phase === "idle") return fail("no baptism session is running");
      if (state.armed) return fail("armed and waiting for the first press — nothing is running to pause");
      const running = state.segmentStartedAt !== null;
      if (ctx.simulate) return ok(running ? "would pause the baptism timer" : "would resume the baptism timer");
      if (running) {
        baptismTimerService.pause();
        return ok("paused the baptism timer");
      }
      baptismTimerService.resume();
      return ok("resumed the baptism timer");
    },
  },

  "baptism.finish": {
    id: "baptism.finish",
    label: "Finish the baptism session",
    help: "Closes the in-progress person/segment, freezes the session, and logs it.",
    params: [],
    run: async (_params, ctx) => {
      if (baptismTimerService.getState().phase === "idle") return fail("no baptism session is running");
      if (ctx.simulate) return ok("would finish the baptism session");
      baptismTimerService.finish();
      return ok("finished the baptism session");
    },
  },

  ...PVP_ACTIONS,
});
