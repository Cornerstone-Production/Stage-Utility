// What the Integrations card's Test connection says about a Q-SYS Core.

import type { QsysTestResult } from "./qsys-service.js";

export function qsysTestMessage(result: QsysTestResult): { ok: boolean; message: string } {
  return result.ok
    ? {
        ok: true,
        message: `Connected to ${result.status.DesignName}${result.status.IsEmulator ? " (emulator)" : ""} — ${result.components} component(s)`,
      }
    : { ok: false, message: result.error };
}
