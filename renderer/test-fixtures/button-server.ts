// button-server.ts — an in-memory server for the Button pickers' tests.
//
// What the Button inspector and Home's Presses sheet talk to: the rule list (a POST
// is kept so the next read sees it, a PATCH is merged), the command manifest, usage,
// the action registry, and a small Companion export with a reference key and a page
// control. Shared so the two tests answer the same questions the same way.
//
// Imports nothing from Testing Library, as fetch-log.ts does not.

import type { ParamDef, Rule } from "@main/types/automation.js";
import type { CuesLive } from "../main/use-cue-live.js";
import { reply, stubFetchWithLog } from "./fetch-log.js";

export const OWNER = { viewId: "booth", objectId: "o1" };

export const ACTIONS: { id: string; label: string; params: ParamDef[] }[] = [
  { id: "display.refresh", label: "Refresh displays", params: [] },
  { id: "display.blank", label: "Blank displays", params: [] },
  { id: "companion.press", label: "Press a Companion button", params: [] },
  { id: "log.message", label: "Write a log message", params: [{ key: "message", label: "Message", type: "string" }] },
];

export const manifest = (): CuesLive => ({
  manifest: {
    version: 1,
    server: { name: "t", lanUrl: null },
    switches: [
      { id: "projectors", name: "Projectors", room: "Booth", on: "projectors_on", off: "projectors_off", toggle: false, state: "off", available: true },
      { id: "obs_record", name: "OBS recording", room: "", on: "obs_record_on", off: "obs_record_off", toggle: false, state: "off", available: true, builtin: true },
    ],
    buttons: [
      { id: "stage_reset", name: "Stage reset", room: "", cue: "stage_reset", available: true },
      { id: "btn_other", name: "Someone else's", room: "", cue: "btn_other", available: true },
    ],
  },
  states: new Map(),
});

const btn = (page: number, row: number, col: number, label: string, pageName = "Projectors") => ({
  page, pageId: `id${page}`, pageName, row, col, label, drives: [], actionIds: [`act.${page}.${row}.${col}`],
  stateSource: null, learnConnections: [], bg: "#333333", fg: "#ffffff",
});

const BUTTONS = [
  btn(17, 0, 0, "Projectors ON"),
  btn(17, 2, 0, "Proj Shutter"),
  btn(20, 0, 0, "Startup", "Lighting"),
  btn(61, 0, 0, "Foyer ON", "Foyer TVs"),
];
const PAGES = [
  { page: 17, name: "Projectors", labelled: 2 },
  { page: 20, name: "Lighting", labelled: 1 },
  { page: 50, name: "Nothing here", labelled: 0 },
  { page: 61, name: "Foyer TVs", labelled: 1 },
];

const key = (row: number, col: number, label: string, extra: Record<string, unknown> = {}) => ({
  row, col, kind: "button", label, bg: "#333333", fg: "#ffffff", icon: null, pickable: true, ...extra,
});
const pageView = (page: number) => {
  const name = PAGES.find((p) => p.page === page)?.name ?? "";
  const keys =
    page === 17
      ? [
          key(0, 0, "Projectors ON"),
          key(2, 0, "Proj Shutter"),
          // A reference is drawn as what it points at and picks that button's own place.
          key(1, 3, "Proj Shutter", { kind: "reference", target: { page: 17, row: 2, col: 0 } }),
          key(0, 7, "", { kind: "page-control", pickable: false }),
        ]
      : page === 20
        ? [key(0, 0, "Startup")]
        : [key(0, 0, "Foyer ON")];
  return { ok: true, page, name, cols: 8, rows: 4, keys };
};

export interface Server {
  rules: Rule[];
  posts: Record<string, unknown>[];
  patches: { id: string; patch: Record<string, unknown> }[];
}

/**
 * An in-memory server for this panel. Rules POSTed are kept (so the next read sees them),
 * a PATCH is merged, and `refuse` answers every write with a 400.
 */
export function serve(opts: {
  rules?: Rule[];
  usage?: Record<string, unknown>;
  refuse?: boolean;
  companionDown?: boolean;
  /** Companion answers, with no page that has anything on it. */
  noPages?: boolean;
  /** Holds every rule write (POST or PATCH) until this settles, so a test can act while one is in flight. */
  hold?: Promise<void>;
  /** Answers first: a request it answers (anything but undefined) is not the shared server's. */
  extra?: (url: string, init?: RequestInit) => unknown;
} = {}): Server & { restore: () => void } {
  const s: Server & { restore: () => void } = { rules: opts.rules ?? [], posts: [], patches: [], restore: () => {} };
  const held = <T>(answer: T): T | Promise<T> => (opts.hold ? opts.hold.then(() => answer) : answer);
  const f = stubFetchWithLog((url, init) => {
    const own = opts.extra?.(url, init);
    if (own !== undefined) return own;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/api/automation/registry")) return reply(200, { triggers: [], conditions: [], actions: ACTIONS });
    if (path.startsWith("/api/cues/manifest")) return reply(200, manifest().manifest);
    if (path.startsWith("/api/cues/usage")) return reply(200, opts.usage ?? {});
    if (path.startsWith("/api/companion/buttons")) {
      return opts.companionDown
        ? reply(200, { ok: false, reason: "Companion refused the connection", buttons: [], pages: [] })
        : reply(200, { ok: true, buttons: opts.noPages ? [] : BUTTONS, pages: opts.noPages ? [] : PAGES, cachedAt: 1 });
    }
    const pageAt = /^\/api\/companion\/pages\/(\d+)/.exec(path);
    if (pageAt) return reply(200, pageView(Number(pageAt[1])));
    if (path === "/api/automation/rules") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        s.posts.push(body);
        if (opts.refuse) return reply(400, { error: 'The cue name "btn_x" is already used by "Walk"' });
        const made = { ...body, id: `rule-${s.posts.length}`, issues: [] } as unknown as Rule;
        s.rules.push(made);
        return held(reply(201, made));
      }
      return reply(200, { rules: s.rules, settings: {} });
    }
    const one = /^\/api\/automation\/rules\/([^/]+)$/.exec(path);
    if (one && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      s.patches.push({ id: one[1]!, patch });
      if (opts.refuse) return reply(400, { error: "refused" });
      const at = s.rules.findIndex((r) => r.id === one[1]);
      const merged = { ...s.rules[at], ...patch } as Record<string, unknown>;
      if (patch.ownedBy === null) delete merged.ownedBy;
      s.rules[at] = merged as unknown as Rule;
      return held(reply(200, { ...merged, issues: [] }));
    }
    return reply(200, {});
  });
  s.restore = f.restore;
  return s;
}

export const owned = (cue: string, action: Rule["action"], over: Partial<Rule> = {}): Rule => ({
  id: "own-1",
  name: "Shutter",
  enabled: true,
  trigger: { id: "call.by-name", params: { name: cue, homeAssistant: "hidden" } },
  conditions: [],
  action,
  cooldownSec: 0,
  oncePerService: false,
  ownedBy: OWNER,
  ...over,
});

export const PRESS_17_2_0: Rule["action"] = {
  id: "companion.press",
  params: { page: 17, row: 2, col: 0, pageId: "id17", label: "Proj Shutter", actionIds: "act.17.2.0", status: "in-place", lastSeenAt: "x", movedFrom: "" },
};

