// automation-actions.ts — the ONLY part of the engine that touches hardware.
//
// Each provider honours `simulate` itself, so suppression happens at the one place
// that does I/O rather than being trusted to the engine. No provider throws: a
// failure is a returned result, so one bad device cannot stop the engine or block
// the next rule.

import type { ActionDef, ActionResult } from "../types/automation.js";
import type { PcoLiveDTO } from "../types/stage.js";
import { advanceGuard } from "./automation-pco-items.js";
import { broadcast } from "./broadcaster.js";
import { oscManager } from "./osc-manager.js";
import { rosstalkManager } from "./rosstalk-manager.js";
import { stageController } from "./stage-controller.js";

const ok = (detail: string): ActionResult => ({ ok: true, detail });
const fail = (detail: string): ActionResult => ({ ok: false, detail });

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
        return fail(e instanceof Error ? e.message : String(e));
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
        return fail(e instanceof Error ? e.message : String(e));
      }
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
        return fail(e instanceof Error ? e.message : String(e));
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
};
