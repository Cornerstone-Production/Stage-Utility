// Shared integration types — frontend mirrors these shapes exactly.

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "ip-list";
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** Optional longer explanation shown behind an "i" info popover next to the label. */
  help?: string;
  /** Value pre-filled in the setup form when nothing is saved yet (so e.g. a poll
   *  interval shows 45 instead of 0/blank). Does not override a saved value. */
  default?: string | number;
  /**
   * Show this field only while another field in the same card holds this value.
   *
   * For an integration with two ways to connect, where showing both sets at once
   * means five fields of which three are noise. Presentation only: a hidden
   * field keeps whatever value it had, so switching back does not lose it.
   */
  showIf?: { key: string; equals: string };
}

export interface IntegrationDescriptor {
  id: string;
  kind: "lineup" | "wireless" | "control";
  label: string;
  /** Short paragraph shown in the settings panel's per-integration info "i":
   *  what it surfaces, how it connects, and where to set it up. */
  description?: string;
  configSchema: ConfigField[];
}

export interface IntegrationState {
  id: string;
  enabled: boolean;
  connection: ConnectionState;
  message: string | null;
  /** Non-secret config values; secret fields masked as "••••" */
  config: Record<string, unknown>;
  /** Whether the operator has actually set this integration up (creds/config or,
   *  for wireless/OSC, the master toggle). Independent of the live connection, so
   *  consumers can tell "not set up" apart from "set up but disconnected".
   *  Computed in getStates(); stored entries omit it. */
  configured?: boolean;
}
