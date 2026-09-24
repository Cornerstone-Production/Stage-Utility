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
import { validateParams } from "@main/services/automation-param-validation";
import { toast } from "../components/ui";
import { useAutomationActions } from "./use-automation-actions";

export function ActionButton({
  config,
  interactive,
  editing,
  ts,
}: {
  config: { type: "action-button"; actionId: string; params?: Record<string, unknown>; label?: string };
  interactive: boolean;
  /** True only inside the layout editor's own canvas — see LayoutRenderCtx.
   *  Gates the "Needs setup" marker below so it can never reach a live display
   *  or a kiosk route, only the surface an operator is actively configuring. */
  editing?: boolean;
  ts: CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const { actions, error: registryError } = useAutomationActions();
  const action = actions?.find((a) => a.id === config.actionId) ?? null;
  // Only once the registry has actually answered: a read that has not landed
  // yet must not brand a perfectly good action-button as broken. A read that
  // FAILED is a third state, distinct from both — see registryError below —
  // so it is deliberately excluded here rather than folded into "unknown".
  const unknown = !!config.actionId && !!actions && !action;
  const label = config.label || action?.label || config.actionId || "Action";
  // EDITOR ONLY. A display or a console never sees this — pressing the button
  // there still refuses exactly as it does today (action-invoke.ts), with
  // nothing new on screen for an audience or an operator mid-service to read.
  const needsSetup = editing && action
    ? validateParams(action.params ?? [], (config.params ?? {}) as Record<string, unknown>).length > 0
    : false;

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
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <button
        type="button"
        onClick={fire}
        disabled={!interactive || busy}
        aria-label={label}
        style={{
          ...ts,
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.15em",
          border: "none",
          borderRadius: "inherit",
          cursor: interactive ? "pointer" : "default",
          pointerEvents: interactive ? "auto" : "none",
          opacity: unknown || registryError ? 0.6 : 1,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "0.4em" }}>
          {busy ? <Loader2Icon className="size-[1em] animate-spin" /> : label}
        </span>
        {/* Said plainly rather than left to a press: pressing an unknown action
            already gets a toast off the server's own "unknown action" refusal
            (action-invoke.ts), but that only ever shows once the operator has
            already tried it. A layout built against a renamed or removed
            action must not render identically to a working one until then. */}
        {unknown && (
          <span style={{ fontSize: "0.5em", opacity: 0.85, color: "var(--red-9)", lineHeight: 1.1 }}>
            unknown action
          </span>
        )}
        {/* A distinct failure from "unknown": the list itself could not be
            read, so nothing can be said about whether config.actionId is
            valid — showing "unknown action" here would be a claim this button
            has no basis for. */}
        {registryError && (
          <span style={{ fontSize: "0.5em", opacity: 0.85, color: "var(--amber-9)", lineHeight: 1.1 }}>
            action list could not be loaded
          </span>
        )}
      </button>
      {/* The layout still saves either way — a button is part of a screen, so
          a missing field marks the button instead of blocking the whole
          layout. See Button.dc.html. */}
      {needsSetup && (
        <span
          data-needs-setup="true"
          style={{
            position: "absolute",
            top: "-10px",
            right: "-10px",
            fontSize: "11px",
            lineHeight: "13px",
            fontWeight: 500,
            padding: "2px 6px",
            borderRadius: "4px",
            // The semantic warn token, not the raw --amber-* scale: this
            // renders on a kiosk surface, and styles.css's kiosk-in-light-app
            // override exists exactly because --amber-11 alone fails contrast
            // at this size there. --color-warn-9/-11 pick that up; --amber-*
            // does not.
            color: "var(--color-warn-11)",
            background: "color-mix(in srgb, var(--color-warn-9) 20%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-warn-9) 55%, transparent)",
          }}
        >
          Needs setup
        </span>
      )}
    </div>
  );
}
