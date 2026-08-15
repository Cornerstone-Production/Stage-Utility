// A console button bound to an entry in the automation action registry.
//
// The general form of osc-button and rosstalk-button, which stay exactly as they
// are so existing layouts keep working. This is for everything else the registry
// can already do — advancing PCO Live, refreshing displays, sending a Companion
// signal — without each one growing its own object type.
//
// `interactive` is decided by the rendering context, not here: a wall display
// renders this as a readout and never binds the press. See render-context.ts.

import { useState, type CSSProperties } from "react";
import { Loader2Icon } from "lucide-react";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { toast } from "../components/ui";

export function ActionButton({
  config,
  interactive,
  ts,
}: {
  config: { type: "action-button"; actionId: string; params?: Record<string, unknown>; label?: string };
  interactive: boolean;
  ts: CSSProperties;
}) {
  const [busy, setBusy] = useState(false);

  async function fire() {
    if (!interactive || busy) return;
    if (!config.actionId) {
      toast.error("This button has no action selected");
      return;
    }
    setBusy(true);
    try {
      // The result is RETURNED by the server rather than thrown, because
      // ActionDef contracts never to throw. A failed action is still a failure
      // the operator must see - reporting "sent" for something that did not
      // happen is worse than saying nothing.
      const r = await invoke<{ ok: boolean; detail: string }>("action:invoke", {
        actionId: config.actionId,
        params: config.params ?? {},
      });
      if (!r?.ok) toast.error(r?.detail || "That action did not run");
    } catch (e) {
      toast.error(`Action failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={fire}
      disabled={!interactive || busy}
      aria-label={config.label || config.actionId || "Action"}
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
        pointerEvents: interactive ? "auto" : "none",
      }}
    >
      {busy ? <Loader2Icon className="size-[1em] animate-spin" /> : (config.label || "Action")}
    </button>
  );
}
