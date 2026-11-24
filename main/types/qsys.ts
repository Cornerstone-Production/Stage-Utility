// qsys.ts — shapes shared by the Q-SYS server code and the panels that read it.

/** One control on the Core: a component's Code Name and the control's name. */
export type QsysAddress = { component: string; control: string };

/** What a layout object stores: the control it reads or writes, and optionally a
 *  separate control that says whether it is lit (a snapshot Match, an LED). */
export type QsysBinding = QsysAddress & { indicator?: QsysAddress | null };

/** A volunteer panel's meters poll at the volunteer rate, a staff panel's at the staff rate. */
export type PanelKind = "volunteer" | "staff";

/** A map key for an address. NUL cannot appear in a Code Name or a control name. */
export function addressKey(a: QsysAddress): string {
  return `${a.component}\u0000${a.control}`;
}
