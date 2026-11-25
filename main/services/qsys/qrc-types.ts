// qrc-types.ts — shapes of the QRC (Q-SYS Remote Control) messages Stage Utility reads.
// Checked against QSC's QRC Commands reference; only the fields we use are typed.

export interface QrcComponent {
  /** The component's Code Name. */
  Name: string;
  Type: string;
  Properties: { Name: string; Value: string }[];
}

export interface QrcControl {
  Name: string;
  Type: string;
  Value: number | boolean | string;
  String: string;
  Position: number;
  Direction: string;
  /** Present on float controls only. */
  ValueMin?: number;
  ValueMax?: number;
  /** A combo box's list of choices, when the Core reports one. */
  Choices?: string[];
  /**
   * A button's name as the Core draws it. Not in GetControls: read with
   * Component.Get, and only for a selector's `Button N` controls (qsys-service.ts).
   */
  Legend?: string;
}

export interface QrcStatus {
  Platform?: string;
  State: "Idle" | "Active" | "Standby";
  DesignName: string;
  DesignCode: string;
  IsRedundant: boolean;
  IsEmulator: boolean;
}

/** One entry of a change-group push: `{ Id, Changes: QrcChange[] }`. */
export interface QrcChange {
  Component?: string;
  Name: string;
  Value: unknown;
  String: string;
  Position?: number;
}
