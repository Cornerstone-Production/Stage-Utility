// What the Integrations card's Test connection says about a Q-SYS Core.
//
// `message` is the Test button's own answer. `rowMessage` is what the card's
// badge shows beside its "Connected" word, so it leaves that word out.

import type { QsysTestResult } from "./qsys-service.js";

export function qsysTestMessage(result: QsysTestResult): { ok: boolean; message: string; rowMessage: string } {
  if (!result.ok) return { ok: false, message: result.error, rowMessage: result.error };
  const reached = `${result.status.DesignName}${result.status.IsEmulator ? " (emulator)" : ""} — ${result.components} component(s)`;
  return { ok: true, message: `Connected to ${reached}`, rowMessage: reached };
}
