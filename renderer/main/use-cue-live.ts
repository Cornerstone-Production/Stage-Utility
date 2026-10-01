// Live cue state for the cue-button object: the manifest (which cues exist,
// what they are called, whether each can be pressed) plus the per-pair state
// pushed on the "cues:all" channel. Hydrates from the manifest read, which
// carries each switch's current state, then applies pushes as they come.
//
// Not useStatusChannel: that hook expects every push to be a whole new value,
// and this channel pushes one pair at a time.

import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";
import type { CueManifest, ManifestButton, ManifestSwitch } from "@main/services/cue-manifest";
import type { CuesEvent } from "@main/services/cue-live";
import type { CueStateName } from "@main/services/cue-states";

export interface LiveState {
  state: CueStateName;
  reason?: string;
  settling?: true;
  commanded?: "on" | "off";
}

export interface CuesLive {
  manifest: CueManifest;
  states: Map<string, LiveState>;
  /** A manifest event arrived with a newer version; the hook re-reads. */
  staleManifest?: true;
}

/** One event folded into the live picture. Pure; the hook and the tests share it. */
export function applyCueEvent(live: CuesLive, e: CuesEvent): CuesLive {
  if (e.type === "manifest") {
    return e.version === live.manifest.version ? live : { ...live, staleManifest: true };
  }
  const next: LiveState = { state: e.state };
  if (e.reason) next.reason = e.reason;
  if (e.settling) {
    next.settling = true;
    next.commanded = e.commanded;
  }
  const states = new Map(live.states);
  states.set(e.id, next);
  return { ...live, states };
}

/** The manifest entry a button is bound to, or null when unbound or gone. */
export function cueEntry(
  live: CuesLive | null,
  id: string,
): { kind: "switch"; row: ManifestSwitch } | { kind: "button"; row: ManifestButton } | null {
  if (!live || !id) return null;
  const sw = live.manifest.switches.find((s) => s.id === id);
  if (sw) return { kind: "switch", row: sw };
  const b = live.manifest.buttons.find((x) => x.id === id);
  return b ? { kind: "button", row: b } : null;
}

function fromManifest(manifest: CueManifest): CuesLive {
  const states = new Map<string, LiveState>();
  for (const s of manifest.switches) {
    const row: LiveState = { state: s.state };
    if (s.reason) row.reason = s.reason;
    if (s.settling) {
      row.settling = true;
      row.commanded = s.commanded;
    }
    states.set(s.id, row);
  }
  return { manifest, states };
}

/**
 * The live cues, plus whether the manifest read has answered — success, an
 * empty answer or a failure. A push alone does not count: it carries one pair
 * and no manifest, so before the read lands every button is still unresolved,
 * and "Unbound" then is a claim about a manifest nobody has seen.
 */
export function useCueLiveStatus(enabled: boolean): { value: CuesLive | null; known: boolean } {
  const [live, setLive] = useState<CuesLive | null>(null);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = () =>
      invoke<CueManifest>("cues:manifest")
        .then((m) => {
          if (!alive) return;
          setKnown(true);
          if (!m) return;
          setLive((prev) => {
            // Pushes that landed during the read win over the read's snapshot.
            const fresh = fromManifest(m);
            if (!prev) return fresh;
            for (const [id, s] of prev.states) if (!fresh.states.has(id)) fresh.states.set(id, s);
            return fresh;
          });
        })
        .catch(() => {
          /* Not swallowed: `known` goes true with no manifest, so every cue
             button on the page renders "Unbound" and fires nothing, which is
             the failure, said on the screen the operator is looking at. The
             next manifest event or a remount re-reads. */
          if (alive) setKnown(true);
        });
    void read();
    const off = onNotification("cues:all", (payload) => {
      const e = payload as CuesEvent;
      setLive((prev) => (prev ? applyCueEvent(prev, e) : prev));
      if (e.type === "manifest") void read();
    });
    return () => {
      alive = false;
      off();
    };
  }, [enabled]);

  return { value: live, known };
}

/** The cues alone, for the inspector's picker, which says "Loading cues…"
 *  rather than drawing a claim off a `null`. */
export function useCueLive(enabled: boolean): CuesLive | null {
  return useCueLiveStatus(enabled).value;
}
