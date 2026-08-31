// automation-conditions.ts — the cross-cutting qualifiers.
//
// The test for whether something belongs here rather than as a trigger param: does
// it apply across triggers? "Which PCO item" only means something to the plan
// trigger (a param). "Only on Sundays" applies to every trigger (a condition).
//
// The list stays short on purpose. If a rule needs something narrower, the answer
// is a better trigger, not a query language. The one bulk exception is the
// per-integration "is connected" set, which is generated from one list rather than
// hand-written once per integration — see INTEGRATIONS in automation-triggers.ts.

import type { ConditionCtx, ConditionDef } from "../types/automation.js";
import { hasContent, type PvpLayerDTO } from "../types/pvp.js";
import { zonedMinuteOfDay, zonedParts } from "./app-timezone.js";
import { INTEGRATIONS } from "./automation-triggers.js";

/** "HH:MM" -> minutes since midnight, or null. */
function hhmm(v: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "<id> is connected" for one integration. Reads the same INTEGRATIONS list the
 *  triggers do, so a new integration cannot get triggers but no condition. */
function isConnectedCondition(id: string, label: string): ConditionDef {
  return {
    id: `${id}.is-connected`,
    label: `${label} is connected`,
    // Connection state is pushed by the integration manager whether anyone is
    // watching or not, so there is no throttled poll behind this one.
    channel: null,
    params: [],
    holds: (ctx) => ctx.integrations?.[id] === "connected",
  };
}

/**
 * A ProVideoPlayer layer condition.
 *
 * Generated from one predicate because the four differ only in the question and
 * the words, and hand-writing them four times is how one of them ends up reading
 * `lastCueName` — the residual field that never clears, and that four idle
 * layers were observed all naming at once.
 *
 * Two rules hold for every one of them:
 *
 *  - A null workspace NEVER holds. null means PVP has never connected, and an
 *    unreachable machine must not make "nothing is on screen" true and gate a
 *    rule on a fiction. Unknown is not a value.
 *  - A BLANK layer name does not hold. Deliberately unlike the triggers, where
 *    blank means "any": a condition is a qualifier, and "some layer, I did not
 *    say which" is the workspace condition, which exists separately and says so
 *    in its own label.
 */
function pvpLayerCondition(
  id: string,
  label: string,
  holds: (l: PvpLayerDTO) => boolean,
): ConditionDef {
  return {
    id,
    label,
    // On the factory, so a fifth layer condition gets its demand for free.
    channel: "pvp:status",
    params: [
      {
        key: "layer",
        label: "Layer",
        type: "string",
        help: "The layer's name in ProVideoPlayer. Renaming the layer in PVP stops the rule.",
      },
    ],
    holds: (ctx, params) => {
      const layers = ctx.pvpLayers;
      if (!layers) return false;
      const want = String(params.layer ?? "").trim().toLowerCase();
      if (!want) return false;
      const l = layers.find((x) => x.name.trim().toLowerCase() === want);
      return !!l && holds(l);
    },
  };
}

export const AUTOMATION_CONDITIONS: Record<string, ConditionDef> = {
  ...Object.fromEntries(
    INTEGRATIONS.map((i) => [`${i.id}.is-connected`, isConnectedCondition(i.id, i.label)]),
  ),

  "obs.is-recording": {
    id: "obs.is-recording",
    label: "OBS is recording",
    channel: "obs:status",
    params: [],
    holds: (ctx) => ctx.obsRecording === true,
  },

  "pvp.layer-has-content": pvpLayerCondition(
    "pvp.layer-has-content",
    "A ProVideoPlayer layer has content",
    // The PRESENCE of media, which parseWorkspace derived from the presence of
    // the playingMedia key. Never the cue name: it is residual and four idle
    // layers were observed all still naming the same cue.
    hasContent,
  ),
  "pvp.layer-is-playing": pvpLayerCondition(
    "pvp.layer-is-playing",
    "A ProVideoPlayer layer is playing a video",
    // `state`, which parseWorkspace derives from playbackRate and timeRemaining
    // — NOT PVP's own isPlaying, which a still image reports true. So "video"
    // covers a paused clip as well as a rolling one: both are a video on that
    // layer, which is the question this condition asks.
    (l) => l.state === "video",
  ),
  "pvp.layer-is-hidden": pvpLayerCondition(
    "pvp.layer-is-hidden",
    "A ProVideoPlayer layer is hidden",
    (l) => l.hidden,
  ),
  "pvp.layer-is-muted": pvpLayerCondition(
    "pvp.layer-is-muted",
    "A ProVideoPlayer layer is muted",
    (l) => l.muted,
  ),

  "pvp.workspace-has-content": {
    id: "pvp.workspace-has-content",
    label: "ProVideoPlayer has something on screen",
    channel: "pvp:status",
    // Deliberately no layer param — this is the "any layer at all" question, and
    // giving it one would duplicate pvp.layer-has-content with a worse label.
    params: [],
    holds: (ctx) => !!ctx.pvpLayers && ctx.pvpLayers.some(hasContent),
  },

  "reaper.is-recording": {
    id: "reaper.is-recording",
    label: "REAPER is recording",
    channel: "reaper:status",
    params: [],
    holds: (ctx) => ctx.reaperRecording === true,
  },

  "resi.is-streaming": {
    id: "resi.is-streaming",
    label: "Resi is streaming",
    channel: "resi:status",
    params: [],
    holds: (ctx) => ctx.resiStreaming === true,
  },

  "youtube.is-streaming": {
    id: "youtube.is-streaming",
    label: "YouTube is streaming",
    channel: "youtube:status",
    params: [],
    holds: (ctx) => ctx.youtubeStreaming === true,
  },

  "baptism.phase-is": {
    id: "baptism.phase-is",
    label: "Baptism phase is",
    channel: "baptism:state",
    params: [{
      key: "phase", label: "Phase", type: "enum",
      options: [
        { value: "idle", label: "Idle" },
        { value: "testimony", label: "Testimony" },
        { value: "baptism", label: "Baptism" },
      ],
    }],
    // A null phase means the timer has never run this session — no phase holds,
    // including "idle", because we do not know that it is idle.
    holds: (ctx, params) => ctx.baptismPhase !== null && ctx.baptismPhase === String(params.phase ?? ""),
  },

  "service.is-live": {
    id: "service.is-live",
    label: "A service is live",
    // Read from the controller's own state, which the live poller keeps current
    // for its own reasons -- nothing throttles it on a browser check.
    channel: null,
    params: [],
    holds: (ctx) => ctx.pcoLive?.mode === "item",
  },

  "service.type-is": {
    id: "service.type-is",
    label: "Service type is",
    channel: null,
    params: [{ key: "serviceTypeId", label: "Service type", type: "enum", optionsFrom: "service-types" }],
    holds: (ctx, params) => {
      const want = String(params.serviceTypeId ?? "");
      return !!want && ctx.serviceTypeId === want;
    },
  },

  "time.day-of-week": {
    id: "time.day-of-week",
    label: "Day of week is",
    channel: null,
    params: [{
      key: "days",
      label: "Days",
      type: "multi-enum",
      options: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => ({ value: String(i), label: d })),
    }],
    holds: (_ctx, params, now) => {
      const raw = String(params.days ?? "").trim();
      // Unconfigured must not silently block every rule that carries it.
      if (!raw) return true;
      const days = raw.split(",").map((d) => Number(d.trim()));
      // The APP's zone, not the host's: on a UTC server "Sunday" ends at 19:00
      // local, so an evening rule would read the wrong day for its last five hours.
      return days.includes(zonedParts(now).weekday);
    },
  },

  "time.between": {
    id: "time.between",
    label: "Time is between",
    channel: null,
    params: [
      { key: "from", label: "From", type: "string", help: "HH:MM, 24-hour" },
      { key: "to", label: "To", type: "string", help: "HH:MM, 24-hour" },
    ],
    holds: (_ctx, params, now) => {
      const from = hhmm(params.from);
      const to = hhmm(params.to);
      if (from === null || to === null) return true; // unconfigured -> no opinion
      // Wall-clock in the APP's zone. An operator typing "18:30" means half six
      // where they are, never half six UTC.
      const cur = zonedMinuteOfDay(now);
      // A window may cross midnight (22:00 -> 02:00).
      return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
    },
  },
};

/** Every condition must hold. An unknown id fails CLOSED: a rule referencing a
 *  condition this build does not have must not fire. */
export function allConditionsHold(
  list: { id: string; params: Record<string, string | number> }[],
  ctx: ConditionCtx,
  now: number,
): boolean {
  for (const c of list) {
    const def = AUTOMATION_CONDITIONS[c.id];
    if (!def) return false;
    if (!def.holds(ctx, c.params, now)) return false;
  }
  return true;
}
