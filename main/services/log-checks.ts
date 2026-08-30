// log-checks.ts — the health strip at the top of /log.
//
// The page was a raw tail and nothing else. Every subsystem does log, and logs
// well, but the buffer holds 10,000 lines across restarts and one subsystem
// alone (stage-controller) accounts for ~80 of the call sites — so "is Planning
// Center actually talking to us right now?" was a question you answered by
// reading, and only if you already knew which line to look for. An integration
// that has been quietly retrying since Thursday emits nothing at all: the
// services log the FIRST failure and then back off silently on purpose.
//
// So the state has to come from state, not from lines. All of it is already
// computed for the Integrations panel; none of it reached the one page an
// operator opens when something is wrong.
//
// Kept deliberately small. Not everything the server knows belongs here — only
// what someone standing at a console with a service starting would act on.

import type { IntegrationDescriptor, IntegrationState } from "../types/integrations.js";

/** How an integration reads at a glance. */
export type CheckState = "ok" | "warn" | "down" | "idle" | "off";

export interface IntegrationCheck {
  id: string;
  label: string;
  state: CheckState;
  /** The integration's own message, or null. Already free of secrets — the
   *  states this is built from mask secret config before it leaves the manager. */
  detail: string | null;
}

export interface LogChecks {
  version: string;
  uptimeSec: number;
  /** The app time zone every timestamp on the page is rendered in. */
  timeZone: string;
  /** True when no zone is configured and the app is following the host clock. */
  followingHost: boolean;
  /** Counts over the whole buffer, so "any errors today?" is answerable without
   *  scrolling 10,000 lines. */
  errors: number;
  warnings: number;
  integrations: IntegrationCheck[];
}

export interface LogChecksInput {
  version: string;
  uptimeSec: number;
  timeZone: string;
  followingHost: boolean;
  errors: number;
  warnings: number;
  states: readonly IntegrationState[];
  descriptors: readonly Pick<IntegrationDescriptor, "id" | "label">[];
}

/**
 * How one integration reads.
 *
 * "Configured but not connected" is the case worth showing loudly — an operator
 * who set something up and sees nothing on the display wants to know the app has
 * not reached it. An integration nobody has configured is not a fault and is
 * dropped entirely rather than listed as five grey rows of noise.
 *
 * `inbound` (Companion) is the exception the state model already carries: nothing
 * dials it, so having no client attached is its resting state, not a failure.
 */
export function checkStateFor(s: IntegrationState): CheckState {
  if (!s.enabled) return "off";
  if (s.connection === "connected") return "ok";
  if (s.inbound) return "idle";
  if (s.connection === "error") return "down";
  return "warn"; // disconnected / connecting, with config in place
}

/** Build the strip. Pure, so log-checks.test.ts can drive every branch without
 *  a server, a socket or a configured integration. */
export function buildLogChecks(input: LogChecksInput): LogChecks {
  const labels = new Map(input.descriptors.map((d) => [d.id, d.label]));
  const integrations = input.states
    .filter((s) => s.configured)
    .map((s) => ({
      id: s.id,
      label: labels.get(s.id) ?? s.id,
      state: checkStateFor(s),
      detail: s.message ?? null,
    }))
    // Worst first: the whole point is that a problem is at the front of the strip
    // rather than wherever the integration happens to sit in registration order.
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.label.localeCompare(b.label));

  return {
    version: input.version,
    uptimeSec: Math.max(0, Math.round(input.uptimeSec)),
    timeZone: input.timeZone,
    followingHost: input.followingHost,
    errors: input.errors,
    warnings: input.warnings,
    integrations,
  };
}

const ORDER: readonly CheckState[] = ["down", "warn", "idle", "ok", "off"];
