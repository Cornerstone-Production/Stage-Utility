// target-list.ts — what the LAN output target lists (OSC targets, RossTalk
// targets, wireless connections) do the same way: refuse an unknown id, refuse a
// malformed patch, and name a new entry without colliding.
//
// Each manager keeps its own list, store and side effects (a socket, a driver, a
// credential fold). This file owns only the part that was copied three times and
// had drifted: RossTalk's route passed the raw body straight through, so
// {"name":""}, {"name":5} and {"config":"x"} were stored, where OSC and wireless
// validated.

import type * as http from "node:http";

import { firstFree } from "./first-free.js";
import { errorMessage } from "./errors.js";
import { error } from "./routes/context.js";
import { isRecord } from "../types/is-record.js";

/** An id no entry in the list has. Declares 404, which handlerErrorStatus passes through. */
export class UnknownTargetError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "UnknownTargetError";
  }
}

/** A patch the list will not take. Declares 400. */
export class InvalidTargetPatchError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidTargetPatchError";
  }
}

/** The entry with `id`, or an UnknownTargetError (404) naming the list. */
export function requireTarget<T extends { id: string }>(list: readonly T[], id: string, label: string): T {
  const found = list.find((t) => t.id === id);
  if (!found) throw new UnknownTargetError(`${label}: unknown id ${id}`);
  return found;
}

/** Position of the entry with `id`; the same refusal as requireTarget. */
export function requireTargetIndex<T extends { id: string }>(list: readonly T[], id: string, label: string): number {
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) throw new UnknownTargetError(`${label}: unknown id ${id}`);
  return idx;
}

/**
 * A name for a new entry: what the caller gave, trimmed, else "<label> <n>" with
 * n the first number nothing in the list already carries from the count up
 * (deleting "Target 1" of two then adding must not hand out a second "Target 2").
 */
export function newTargetName(given: string | undefined, label: string, existing: readonly { name: string }[]): string {
  const trimmed = given?.trim();
  if (trimmed) return trimmed;
  const names = new Set(existing.map((t) => t.name));
  const first = existing.length + 1;
  return firstFree(`${label} ${first}`, (s) => names.has(s), (_base, n) => `${label} ${first + n - 1}`);
}

/**
 * What a `config` field may hold: text (blank allowed: a cleared host), a port
 * (an integer 1 to 65535), a positive number, or one of a fixed set of words.
 */
export type ConfigFieldRule = "string" | "port" | "positive" | readonly string[];

/** The config fields RossTalk targets keep. */
export const ROSSTALK_CONFIG_RULES: Record<string, ConfigFieldRule> = {
  host: "string",
  port: "port",
  family: ["carbonite", "ultrix"],
};

/** The config fields OSC targets keep. */
export const OSC_CONFIG_RULES: Record<string, ConfigFieldRule> = {
  host: "string",
  port: "port",
  subscribeAddress: "string",
  subscribeIntervalSec: "positive",
};

function violatesRule(value: unknown, rule: ConfigFieldRule): boolean {
  if (rule === "string") return typeof value !== "string";
  if (rule === "port") return typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535;
  if (rule === "positive") return typeof value !== "number" || !Number.isFinite(value) || value <= 0;
  return typeof value !== "string" || !rule.includes(value);
}

/** The fields every target list lets an operator edit. */
export interface TargetPatch {
  name?: string;
  providerId?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/**
 * Read an edit off a request body. A field that is absent is left alone; a field
 * that is present must be the right shape, or the whole edit is refused with an
 * InvalidTargetPatchError (400) and nothing is stored. A name must have text in
 * it: the panels never send a blank one, and a blank saved over a name is a
 * target the operator can no longer tell apart.
 *
 * Two deliberate differences, named as options. `providerId` is wireless-only.
 * `configRules` is the shape of a `config`: OSC and RossTalk have a fixed set of
 * fields and refuse an unknown key or a wrong type. A wireless connection's
 * config is whatever its provider declares, and its secrets are folded (and
 * logged) by the manager, so it passes no rules and is only held to being an object.
 */
export function parseTargetPatch(
  raw: Record<string, unknown>,
  opts: { providerId?: boolean; configRules?: Record<string, ConfigFieldRule> } = {},
): TargetPatch {
  const patch: TargetPatch = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new InvalidTargetPatchError("name must be a non-empty string");
    }
    patch.name = raw.name.trim();
  }
  if (opts.providerId && raw.providerId !== undefined) {
    if (typeof raw.providerId !== "string" || raw.providerId === "") {
      throw new InvalidTargetPatchError("providerId must be a non-empty string");
    }
    patch.providerId = raw.providerId;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new InvalidTargetPatchError("enabled must be a boolean");
    patch.enabled = raw.enabled;
  }
  if (raw.config !== undefined) {
    if (!isRecord(raw.config)) throw new InvalidTargetPatchError("config must be an object");
    const rules = opts.configRules;
    if (rules) {
      for (const [key, value] of Object.entries(raw.config)) {
        const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
        if (rule === undefined) throw new InvalidTargetPatchError(`config.${key} is not a setting of this target`);
        if (violatesRule(value, rule)) throw new InvalidTargetPatchError(`config.${key} is not a valid ${Array.isArray(rule) ? rule.join(" or ") : rule}`);
      }
    }
    patch.config = raw.config;
  }
  return patch;
}

/**
 * The edit in a PATCH or POST body that takes either the fields themselves or
 * `{patch: {…}}`. A `patch` that is present but not an object is refused rather
 * than read as an empty edit.
 */
export function wrappedPatch(body: Record<string, unknown>): Record<string, unknown> {
  if (body.patch === undefined) return body;
  if (!isRecord(body.patch)) throw new InvalidTargetPatchError("patch must be an object");
  return body.patch;
}

/**
 * Run a route's work on a target list and answer an unknown id as 404. Not in
 * handlerErrorStatus: that answers for every route, and a 404 declared by some
 * unrelated error would start reading as "not found" instead of a fault.
 * Anything else is rethrown for the server's own error path.
 */
export async function answeringUnknownTarget(res: http.ServerResponse, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof UnknownTargetError)) throw err;
    error(res, errorMessage(err), 404);
  }
}
