import { useState, type CSSProperties } from "react";
import { Loader2Icon, RadioTowerIcon } from "lucide-react";

import { invoke } from "../lib/api";
import { toast } from "../components/ui";

interface RossTalkButtonConfig {
  targetId?: string | null;
  commandId?: string | null;
  params?: Record<string, string | number>;
  label?: string;
  raw?: string;
}

/**
 * A custom-layout RossTalk button. Fires its command at its target on tap, but only
 * on a real display / operator surface (`interactive`) — never in the editor or the
 * preview iframe, where a tap would otherwise command a live switcher.
 *
 * There is no feedback binding: RossTalk is send-only, so a button is a trigger and
 * never an indicator.
 */
export function RossTalkButton({
  config,
  interactive,
  simulate,
  ts,
}: {
  config: RossTalkButtonConfig;
  interactive: boolean;
  /** Global simulate mode — shown so a simulated tap is never mistaken for a real one. */
  simulate: boolean;
  ts: CSSProperties;
}) {
  const [busy, setBusy] = useState(false);

  async function fire() {
    if (!interactive || busy) return;
    if (!config.targetId) {
      toast.error("RossTalk button has no target selected");
      return;
    }
    if (!config.commandId && !config.raw) {
      toast.error("RossTalk button has no command selected");
      return;
    }
    setBusy(true);
    try {
      const r = await invoke<{ line: string; simulated: boolean }>("rosstalk:send", {
        targetId: config.targetId,
        commandId: config.commandId ?? undefined,
        params: config.params ?? {},
        raw: config.raw,
      });
      if (r.simulated) toast.info(`Simulated: ${r.line}`);
    } catch (e) {
      toast.error(`RossTalk failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={fire}
      disabled={!interactive || busy}
      aria-label={config.label || config.commandId || "RossTalk"}
      style={{
        ...ts,
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.4em",
        border: "none",
        borderRadius: "inherit",
        cursor: interactive ? "pointer" : "default",
      }}
    >
      {busy ? <Loader2Icon className="animate-spin" style={{ width: "1em", height: "1em" }} /> : null}
      <span>{config.label || config.commandId || "RossTalk"}</span>
      {simulate ? (
        <RadioTowerIcon
          style={{ width: "0.9em", height: "0.9em", opacity: 0.6 }}
          aria-label="Simulate mode — this button will not reach the device"
        />
      ) : null}
    </button>
  );
}
