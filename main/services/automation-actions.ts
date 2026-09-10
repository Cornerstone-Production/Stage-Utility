// automation-actions.ts — the ONLY part of the engine that touches hardware.
//
// Each provider honours `simulate` itself, so suppression happens at the one place
// that does I/O rather than being trusted to the engine. No provider throws: a
// failure is a returned result, so one bad device cannot stop the engine or block
// the next rule.

import { errorMessage } from "./errors.js";
import type { ActionDef, ActionResult } from "../types/automation.js";
import type { PcoLiveDTO } from "../types/stage.js";
import { advanceGuard } from "./automation-pco-items.js";
import { broadcast } from "./broadcaster.js";
import { companionApi } from "./companion-api.js";
import { missingSentence, readFingerprint } from "./companion-fingerprint.js";
import { oscManager } from "./osc-manager.js";
import { isReaperTransportCommand, reaperService } from "./reaper-service.js";
import { rosstalkManager } from "./rosstalk-manager.js";
import { stageController } from "./stage-controller.js";
import { matchRoster } from "./automation-roster-match.js";
import { signalStore } from "./signal-store.js";
// A separate module rather than nine more literals here: they share resolveLayer,
// byUuid, nameSegment and flagAction, and the verify-then-report reasoning is a
// page of comment that belongs beside the thing it governs.
import { PVP_ACTIONS } from "./pvp-actions.js";

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

export const AUTOMATION_ACTIONS: Record<string, ActionDef> = {
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

  ...PVP_ACTIONS,
};
