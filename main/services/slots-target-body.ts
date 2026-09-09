// Reading a `target` off a request body.
//
// Shared by view-routes (POST …/slots) and preset-routes (POST …/apply): both
// choose which of a service type's two boards a write lands on, and the last
// time this repo had a validator in two route files the copies drifted.

import type { SlotsTarget } from "./slots-store.js";

/** Distinguishable from `undefined` — a target that was SENT and is malformed is
 *  a client error, where an absent one means "wherever a plain save goes". */
export const INVALID_TARGET = Symbol("invalid slots target");

export const TARGET_ERROR =
  'body.target must be { kind: "default", serviceTypeId } or { kind: "plan", planId, serviceTypeId }';

/**
 * Validate an optional `body.target`.
 *
 * Narrowed to literals rather than cast: `as` asserts a shape without proving
 * it, and this value chooses which of two boards a save overwrites — the one
 * place where guessing wrong silently rewrites a service type's standing board
 * with one week's exception.
 */
export function readSlotsTarget(v: unknown): SlotsTarget | undefined | typeof INVALID_TARGET {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") return INVALID_TARGET;
  const t = v as Record<string, unknown>;
  if (typeof t.serviceTypeId !== "string" || !t.serviceTypeId) return INVALID_TARGET;
  if (t.kind === "default") return { kind: "default", serviceTypeId: t.serviceTypeId };
  if (t.kind === "plan" && typeof t.planId === "string" && t.planId) {
    return {
      kind: "plan",
      planId: t.planId,
      serviceTypeId: t.serviceTypeId,
      sortDate: typeof t.sortDate === "string" ? t.sortDate : null,
    };
  }
  return INVALID_TARGET;
}
