import { useState, useEffect, useCallback } from "react";
import { invoke, onNotification } from "../lib/api";
import { useStageState } from "./use-stage-state";
import { useStatusChannel } from "./use-status-channel";

interface UseDashboardStateResult {
  state: StageState | null;
  isLoading: boolean;
  error: string | null;
  pcoLive: PcoLiveDTO | null;
  /**
   * Has the pco:live channel answered yet?
   *
   * `pcoLive === null` cannot carry this. Null is also the settled answer when
   * Planning Center is not configured, and it is literally what the server
   * hydrates with, so by value alone "no service" and "no answer yet" are the
   * same thing. A consumer that has to act on the difference — Home, which
   * hides cards by mood — needs to be told.
   */
  pcoLiveKnown: boolean;
  propresenter: ProPresenterStatusDTO | null;
}

/**
 * State for the dashboard display: the base StageState (branding/displays) plus
 * the two live channels — PCO Services Live countdown ("pco:live") and
 * ProPresenter status ("propresenter:status").
 */
export function useDashboardState(): UseDashboardStateResult {
  const { state, isLoading, error } = useStageState();
  const [pcoLive, setPcoLive] = useState<PcoLiveDTO | null>(null);
  const [pcoLiveKnown, setPcoLiveKnown] = useState(false);

  // ProPresenter is a StatusIntegration, so its hydrate and its pushes are
  // version-stamped and ordered by useStatusChannel — see the note there.
  const readPro = useCallback(() => invoke<ProPresenterStatusDTO>("propresenter:getStatus"), []);
  const propresenter = useStatusChannel<ProPresenterStatusDTO>(readPro, "propresenter:status");

  // pco:live is NOT one: it comes from the live controller, not an integration,
  // and carries no rev. It keeps the plain hydrate-then-subscribe shape.
  //
  // Either half answers the "is it known yet?" question, and so does the read
  // FAILING: an unreachable server is the answer "we are not going to know",
  // and a consumer waiting for a certainty that cannot arrive is a page that
  // never finishes loading. apiFetch caps the read at 15s, so this settles one
  // way or the other whatever the server does. (The failure itself is still not
  // reported here — it never was; a PCO that is down is surfaced on the
  // Integrations page, which is where an operator can act on it.)
  useEffect(() => {
    let cancelled = false;
    invoke<PcoLiveDTO | null>("pco:getLive")
      .then((l) => {
        if (cancelled) return;
        if (l) setPcoLive(l);
        setPcoLiveKnown(true);
      })
      .catch(() => { if (!cancelled) setPcoLiveKnown(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => onNotification("pco:live", (p) => {
    setPcoLive(p as PcoLiveDTO);
    setPcoLiveKnown(true);
  }), []);

  return { state, isLoading, error, pcoLive, pcoLiveKnown, propresenter };
}

/**
 * All configured ProPresenter instances + their live status (for custom layouts
 * that pick which auditorium an object reads from). Hydrates once, then stays
 * live on the "propresenter:instances" channel. Always includes id "default".
 */
export function usePropInstances(): PropInstancesDTO | null {
  const [instances, setInstances] = useState<PropInstancesDTO | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<PropInstancesDTO>("propresenter:getInstances")
      .then((d) => { if (!cancelled && d) setInstances(d); })
      .catch(() => { /* not configured yet — ignore */ });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => onNotification("propresenter:instances", (p) => setInstances(p as PropInstancesDTO)), []);
  return instances;
}
