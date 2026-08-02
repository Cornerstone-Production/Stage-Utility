// automation-triggers.ts — the trigger registry.
//
// PURE: no I/O, no wall-clock reads beyond the `now` passed in. Every entry turns a
// pair of state SNAPSHOTS into a yes/no "did this fire", which is what converts the
// broadcaster's constantly-repeated state into edges.
//
// THE CONTRACT: didFire MUST return false when `prev` is null. On startup the engine
// has no previous snapshot; treating that as a transition would fire every rule at
// once after an update or crash mid-service, unattended. Asserted for every trigger
// in automation-triggers.test.ts.

import type { ParamDef, TriggerDef } from "../types/automation.js";
import { dueAt } from "./automation-due-time.js";
import { findItemByTitle } from "./automation-pco-items.js";

type Live = {
  mode?: string;
  currentItemTitle?: string | null;
  serviceTimeStartsAt?: string | null;
  serverNow?: string;
  itemSchedule?: { title: string; dueAt: string }[];
};
type People = { total?: { attendance?: number | null; occupancy?: number | null } | null };
type Rec = { connected?: boolean; recording?: boolean };

const asLive = (v: unknown): Live => (v && typeof v === "object" ? (v as Live) : {});
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const metricOf = (v: unknown, metric: string): number | null => {
  const t = (v && typeof v === "object" ? (v as People).total : null) ?? null;
  const n = t ? (metric === "occupancy" ? t.occupancy : t.attendance) : null;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const METRIC: ParamDef = {
  key: "metric",
  label: "Metric",
  type: "enum",
  options: [
    { value: "attendance", label: "Attendance (entered)" },
    { value: "occupancy", label: "Occupancy (in room)" },
  ],
};

function def(t: TriggerDef): TriggerDef {
  return t;
}

export const AUTOMATION_TRIGGERS: Record<string, TriggerDef> = {
  "pco.service-started": def({
    id: "pco.service-started",
    label: "Service goes live",
    channel: "pco:live",
    params: [],
    help: "Fires the moment PCO Live moves from pre-service into the plan.",
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asLive(prev).mode !== "item" && asLive(next).mode === "item";
    },
  }),

  "pco.service-ended": def({
    id: "pco.service-ended",
    label: "Service ends",
    channel: "pco:live",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return asLive(prev).mode === "item" && asLive(next).mode !== "item";
    },
  }),

  "pco.item-reached": def({
    id: "pco.item-reached",
    label: "Plan reaches an item",
    channel: "pco:live",
    params: [{ key: "title", label: "Item title contains", type: "string", help: "Case-insensitive, matches part of the title" }],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const want = String(params.title ?? "").trim().toLowerCase();
      if (!want) return false;
      const before = (asLive(prev).currentItemTitle ?? "").toLowerCase();
      const after = (asLive(next).currentItemTitle ?? "").toLowerCase();
      // Fire on the transition INTO a matching item, not while sitting on it.
      return !before.includes(want) && after.includes(want);
    },
  }),

  "pco.item-due": def({
    id: "pco.item-due",
    label: "Plan item is due",
    channel: "pco:live",
    params: [
      {
        key: "title",
        label: "Item",
        type: "string",
        optionsFrom: "plan-items",
        help: "Case-insensitive, matches part of the title. Renaming the item in PCO stops the rule.",
      },
      {
        key: "anchor",
        label: "Relative to",
        type: "enum",
        options: [
          { value: "item", label: "The item's own time" },
          { value: "service-start", label: "The service start" },
        ],
      },
      {
        key: "offsetMinutes",
        label: "Offset (minutes)",
        type: "number",
        min: -720,
        max: 720,
        help: "Negative fires before, positive after.",
      },
    ],
    help:
      "Fires once, when the chosen moment passes. An item is exact if a plan time is named after it; otherwise its time is estimated from item lengths and drifts if the service runs long.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const before = asLive(prev);
      const after = asLive(next);

      // THE EDGE IS IN TIME, not in the payload — nothing about the live state
      // changes when an item falls due. serverNow is the clock the payload was
      // built against, and consecutive snapshots' windows are contiguous by
      // construction, so the due moment lands in exactly one of them: fires once,
      // and never twice, with no state kept here. Using the engine's own `now` as
      // the upper bound instead would overlap successive windows and double-fire.
      const from = Date.parse(before.serverNow ?? "");
      const to = Date.parse(after.serverNow ?? "");
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return false;

      const item = findItemByTitle(after.itemSchedule ?? [], String(params.title ?? ""));
      if (!item) return false; // unknown item: never guess at a moment to fire

      const due = dueAt({
        anchor: params.anchor === "service-start" ? "service-start" : "item",
        itemTimeIso: item.dueAt,
        serviceStartIso: after.serviceTimeStartsAt ?? null,
        offsetMinutes: Number(params.offsetMinutes) || 0,
      });
      if (due === null) return false;

      return due > from && due <= to;
    },
  }),

  "occupancy.crossed-above": def({
    id: "occupancy.crossed-above",
    label: "People count rises above",
    channel: "people:count",
    params: [{ key: "threshold", label: "Threshold", type: "number", min: 0, max: 100000 }, METRIC],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const metric = String(params.metric ?? "attendance");
      const a = metricOf(prev, metric);
      const b = metricOf(next, metric);
      if (a === null || b === null) return false; // no baseline, no crossing
      const th = Number(params.threshold);
      return Number.isFinite(th) && a <= th && b > th;
    },
  }),

  "occupancy.crossed-below": def({
    id: "occupancy.crossed-below",
    label: "People count falls below",
    channel: "people:count",
    params: [{ key: "threshold", label: "Threshold", type: "number", min: 0, max: 100000 }, METRIC],
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      const metric = String(params.metric ?? "attendance");
      const a = metricOf(prev, metric);
      const b = metricOf(next, metric);
      if (a === null || b === null) return false;
      const th = Number(params.threshold);
      return Number.isFinite(th) && a >= th && b < th;
    },
  }),

  "recording.started": def({
    id: "recording.started",
    label: "Recording starts",
    channel: "obs:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      return !asRec(prev).recording && asRec(next).recording === true;
    },
  }),

  "recording.stopped": def({
    id: "recording.stopped",
    label: "Recording stops",
    channel: "obs:status",
    params: [],
    didFire: (prev, next) => {
      if (prev === null) return false;
      const p = asRec(prev);
      const n = asRec(next);
      // A recorder dropping off the network is UNKNOWN, not "stopped" — firing a
      // stop rule because a machine went offline would be wrong.
      if (n.connected === false) return false;
      return p.recording === true && n.recording === false;
    },
  }),
};

export function triggersForChannel(channel: string): TriggerDef[] {
  return Object.values(AUTOMATION_TRIGGERS).filter((t) => t.channel === channel);
}
