// OSC types — shared between backend (osc-manager/codec) and the renderer
// (osc-button layout object). The frontend mirrors these shapes in types.d.ts.

import type { ConnectionState } from "./integrations.js";

/** One typed OSC argument as configured on a button. `T`/`F` carry no value. */
export interface OscArg {
  type: "i" | "f" | "s" | "T" | "F";
  value?: number | string;
}

/** Binds a button's "active" visual state to a feedback value at an address. */
export interface OscFeedbackBind {
  /** OSC address to watch on the button's target (e.g. "/ch/01/mix/on"). */
  address: string;
  /** Active when the latest value equals this; if omitted, active when truthy. */
  equals?: number | string | boolean;
  /** Color/fill applied while active (CSS color). */
  activeColor?: string;
}

/** Persisted config for one OSC target device. */
export interface OscTargetConfig {
  id: string;
  name: string;
  enabled: boolean;
  config: {
    host?: string;
    port?: number;
    /** Optional keepalive/subscribe message sent on connect + repeated (e.g. X32 "/xremote"). */
    subscribeAddress?: string;
    subscribeIntervalSec?: number;
  };
}

/** A target including runtime fields (connection/message are in-memory only). */
export interface OscTarget extends OscTargetConfig {
  connection: ConnectionState;
  message: string | null;
}

/** Live feedback snapshot (pushed on "osc:feedback"). Keyed "targetId::address". */
export interface OscFeedbackDTO {
  values: Record<string, number | string | boolean>;
}
