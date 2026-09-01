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
   *  interval shows its default instead of 0/blank). Must be the same value the
   *  service falls back to, or the form advertises a rate the service does not
   *  run. Does not override a saved value. */
  default?: string | number;
  /** Bounds for a `number` field, enforced by the input. Without them the field
   *  accepts 0 or a negative and the service silently clamps it, so the form
   *  shows one rate and the poller runs another. */
  min?: number;
  max?: number;
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
  /** ONE OR TWO SENTENCES, saying what this integration does — never how to set
   *  it up in the other application. Setup steps belong in `docs/integrations/`,
   *  which `docs` below points the operator at: they were paragraphs here, and a
   *  card grid of sixteen of them is a wall nobody reads. */
  description?: string;
  /**
   * The integration's page under `docs/integrations/`, WITHOUT the extension.
   *
   * Required, and deliberately not derived from `id` — `pvp`'s page is
   * `provideoplayer.md`, so deriving it would 404 on exactly one integration and
   * look right everywhere else. Required rather than optional because this is
   * where the setup steps went when the descriptions were cut down: a new
   * integration with nowhere to send the operator is the failure this field
   * exists to prevent, and the type checker will not let it compile.
   */
  docs: string;
  /**
   * The other end dials US — there is nothing for this app to connect to.
   *
   * Companion is the one: its module opens an HTTP/SSE connection to this
   * server. That makes an enable switch a lie, because nothing is gated on it —
   * turning it off left the module connecting and controlling the app exactly as
   * before — and it makes "disconnected" the wrong word for having no client
   * attached, which is the resting state of a listener rather than a fault.
   */
  inbound?: boolean;
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
  /** Mirrors the descriptor's `inbound` — carried on the state because the
   *  context bar and the health count read states, not descriptors, and an
   *  integration nobody dials cannot be "down". Computed in getStates(). */
  inbound?: boolean;
}
