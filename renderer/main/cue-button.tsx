// A cue from the manifest, with its state on it. The general form of a
// Companion "toggle" button for a panel: the label, the device it drives, and a
// mark that says what the device is DOING, from the same reading Home Assistant
// gets. A switch shows the state it is in, never the state it was asked for —
// except in the settle window after a press, where it shows what was asked and
// says it is settling.
//
// `interactive` is decided by the rendering context, not here: a wall display
// renders this as a readout and never binds the press. See render-context.ts.

import { useState, type CSSProperties } from "react";
import { Loader2Icon } from "lucide-react";

import { invoke } from "../lib/api";
import { cueEntry, type CuesLive } from "./use-cue-live";

export interface CallAnswer {
  status: number;
  ok?: boolean;
  detail?: string;
  error?: string;
  reason?: string;
  skipped?: boolean;
}

/** The seam a test replaces; production posts the cue. */
export const cueButtonDeps = {
  call: (name: string): Promise<CallAnswer> => invoke<CallAnswer>("cues:call", { name }),
};

export type CueButtonState = "unbound" | "idle" | "on" | "settling" | "stale" | "unavailable";

/**
 * How a switch is coloured.
 *
 * `live` is a switch whose ON means on air or recording — red when on, green
 * when the device is connected and off, which reads as standby. Absent is the
 * rendering every switch had before: green when on, grey when off.
 *
 * Read off the manifest entry (see ManifestSwitch.tone); only the cues the app
 * ships carry it today.
 */
export type CueTone = "live" | undefined;

/** What the button shows, from the manifest entry and the live row. Exported for
 *  the test and the inspector preview. */
export function cueButtonState(
  cues: CuesLive | null,
  id: string,
): { state: CueButtonState; sub: string; name: string; tone: CueTone } {
  const entry = cueEntry(cues, id);
  if (!entry) return { state: "unbound", sub: "", name: "", tone: undefined };
  const name = entry.row.name;
  // A BUTTON has no tone: it is momentary and there is nothing to read back, so
  // there is no on state to colour.
  const tone: CueTone = entry.kind === "switch" ? entry.row.tone : undefined;
  if (!entry.row.available) {
    return { state: "unavailable", sub: "Button missing in Companion", name, tone };
  }
  if (entry.kind === "button") return { state: "idle", sub: entry.row.room, name, tone };
  const row = entry.row;
  const live = cues?.states.get(row.id) ?? {
    state: row.state,
    reason: row.reason,
    settling: row.settling,
    commanded: row.commanded,
  };
  if (live.settling) {
    return { state: "settling", sub: `Turning ${live.commanded ?? "on"}…`, name, tone };
  }
  if (live.state === "unknown" && row.stateSource) {
    return { state: "stale", sub: live.reason ?? "Reading unavailable", name, tone };
  }
  if (live.state === "on") return { state: "on", sub: row.room, name, tone };
  return { state: "idle", sub: row.room, name, tone };
}

export function CueButton({
  config,
  cues,
  interactive,
  ts,
}: {
  config: { type: "cue-button"; cue: string; label?: string; showDevice?: boolean };
  cues: CuesLive | null;
  interactive: boolean;
  ts: CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const { state, sub, name, tone } = cueButtonState(cues, config.cue);
  // A `live` switch that is OFF and readable is the device on STANDBY: its
  // reading came back, so whatever it drives is connected and idle. `idle` is
  // reached only when the state was read as off — an unreadable one is `stale`
  // and an unbound one has no tone — so the green ring cannot claim standby for
  // a recorder nobody can reach.
  const liveOn = tone === "live" && state === "on";
  const liveStandby = tone === "live" && state === "idle";
  const entry = cueEntry(cues, config.cue);
  const canFire = interactive && !busy && entry !== null && state !== "unavailable";

  async function fire() {
    if (!canFire || !entry) return;
    const target =
      entry.kind === "button"
        ? entry.row.cue
        : state === "on"
          ? entry.row.off
          : entry.row.on; // unknown or stale presses ON
    setBusy(true);
    setSaid(null);
    try {
      const r = await cueButtonDeps.call(target);
      if (r.status === 200) {
        if (r.skipped) setSaid(r.detail ?? "Already there");
      } else if (r.status === 202) setSaid("Needs confirmation; use the rules page");
      else setSaid(r.error ?? r.detail ?? "Refused");
    } catch {
      // The only case with no body to read a reason out of. Said on the button
      // rather than logged away: this is the answer to the operator's press.
      setSaid("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const label = config.label || name || "Unbound";
  const line2 = said ?? (config.showDevice === false ? "" : sub);

  return (
    <button
      type="button"
      data-state={state}
      data-tone={tone}
      onClick={fire}
      disabled={!canFire}
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
        cursor: canFire ? "pointer" : "default",
        pointerEvents: interactive ? "auto" : "none",
        opacity: state === "unavailable" ? 0.4 : 1,
        boxShadow: liveOn
          ? "inset 0 0 0 0.12em var(--red-9)"
          : state === "on"
            ? "inset 0 0 0 0.12em var(--green-9)"
            : liveStandby
              ? "inset 0 0 0 0.08em var(--green-9)"
              : state === "stale"
                ? "inset 0 0 0 0.08em var(--amber-9)"
                : undefined,
        outline: state === "stale" ? "0.08em dashed var(--amber-9)" : undefined,
        outlineOffset: state === "stale" ? "-0.16em" : undefined,
        background:
          state === "settling"
            ? "color-mix(in srgb, var(--brand-accent) 30%, transparent)"
            : ts.background,
      }}
    >
      <span
        aria-hidden
        style={{
          width: "0.55em",
          height: "0.55em",
          borderRadius: "50%",
          background: liveOn
            ? "var(--red-9)"
            : state === "on"
              ? "var(--green-9)"
              : state === "settling"
                ? "var(--amber-9)"
                : "var(--su-fg-faint)",
        }}
      />
      <span
        style={{
          fontWeight: 600,
          letterSpacing: "0.02em",
          textTransform: "uppercase",
          lineHeight: 1.05,
        }}
      >
        {busy ? <Loader2Icon className="size-[1em] animate-spin" /> : label}
      </span>
      {line2 && (
        <span
          style={{
            fontSize: "0.55em",
            opacity: 0.75,
            color: state === "stale" ? "var(--amber-9)" : undefined,
            lineHeight: 1.1,
          }}
        >
          {line2}
        </span>
      )}
    </button>
  );
}
