// Types for RossTalk control of Ross Video gear (Carbonite switcher, Ultrix router).
//
// Protocol: TCP 7788, plain ASCII, CR/LF terminated, case sensitive, SEND-ONLY.
// See docs/superpowers/specs/2026-07-26-rosstalk-design.md.

import type { ConnectionState } from "./integrations.js";

export type RossTalkFamily = "carbonite" | "ultrix";

/** One parameter of a command, used to render a form and to validate input. */
export interface RossTalkParam {
  key: string;
  label: string;
  type: "number" | "string" | "enum";
  /** number only */
  min?: number;
  max?: number;
  /** number only — zero-pad to this width, e.g. CC's `05`. */
  pad?: number;
  /** enum only */
  options?: string[];
  /** When true the param may be omitted (e.g. Ultrix XPT levels). */
  optional?: boolean;
  help?: string;
}

export interface RossTalkCommand {
  /** Stable id, unique across families, e.g. "cc", "xpt-ultrix". */
  id: string;
  label: string;
  /** Exactly one family — see the XPT/GPI divergence in the spec. */
  family: RossTalkFamily;
  params: RossTalkParam[];
  /** Build the wire line WITHOUT the CR/LF terminator. */
  format(values: Record<string, string | number>): string;
  help?: string;
}

export interface RossTalkTargetConfig {
  id: string;
  name: string;
  enabled: boolean;
  config: {
    host?: string;
    port?: number;
    family?: RossTalkFamily;
  };
}

/** A target plus runtime fields (in-memory only, never persisted). */
export interface RossTalkTarget extends RossTalkTargetConfig {
  connection: ConnectionState;
  message: string | null;
}
