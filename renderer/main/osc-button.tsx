import { useState, type CSSProperties } from "react";
import { invoke } from "../lib/api";
import { toast } from "../components/ui";
import { Loader2Icon } from "lucide-react";

// OscArg / OscFeedbackBind are ambient global types (see renderer/types.d.ts).
interface OscButtonConfig {
  targetId?: string | null;
  label?: string;
  address: string;
  args?: OscArg[];
  feedback?: OscFeedbackBind | null;
}

/**
 * A custom-layout OSC button. Fills its object box and fires the configured
 * address/args at its target on tap — but only on a real display / operator
 * surface (`interactive`), never in the editor or preview iframe. When a feedback
 * value makes it `active`, it fills with the configured color.
 */
export function OscButton({
  config,
  active,
  interactive,
  ts,
}: {
  config: OscButtonConfig;
  active: boolean;
  interactive: boolean;
  ts: CSSProperties;
}) {
  const [busy, setBusy] = useState(false);

  async function fire() {
    if (!interactive || busy) return;
    if (!config.targetId) {
      toast.error("OSC button has no target selected");
      return;
    }
    if (!config.address?.startsWith("/")) {
      toast.error("OSC address must start with '/'");
      return;
    }
    setBusy(true);
    try {
      await invoke("osc:send", {
        targetId: config.targetId,
        address: config.address,
        args: config.args ?? [],
      });
    } catch (e) {
      toast.error(`OSC failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const background = active ? (config.feedback?.activeColor || "var(--red-9)") : undefined;

  return (
    <button
      type="button"
      onClick={fire}
      disabled={!interactive || busy}
      aria-label={config.label || config.address}
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
        background,
        cursor: interactive ? "pointer" : "default",
        pointerEvents: interactive ? "auto" : "none",
      }}
    >
      {busy ? <Loader2Icon className="size-[1em] animate-spin" /> : (config.label || config.address || "Button")}
    </button>
  );
}
