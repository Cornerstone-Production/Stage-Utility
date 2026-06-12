// Shared integration types — frontend mirrors these shapes exactly.

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "ip-list";
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export interface IntegrationDescriptor {
  id: string;
  kind: "lineup" | "wireless" | "control";
  label: string;
  configSchema: ConfigField[];
}

export interface IntegrationState {
  id: string;
  enabled: boolean;
  connection: ConnectionState;
  message: string | null;
  /** Non-secret config values; secret fields masked as "••••" */
  config: Record<string, unknown>;
}
