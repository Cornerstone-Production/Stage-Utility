import { useState, useEffect, useCallback } from "react";
import { invoke, onNotification } from "../lib/api";
import { useStageState } from "./use-stage-state";
import { useStatusChannel } from "./use-status-channel";

interface UseDashboardStateResult {
  state: StageState | null;
  isLoading: boolean;
  error: string | null;
  pcoLive: PcoLiveDTO | null;
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

  // ProPresenter is a StatusIntegration, so its hydrate and its pushes are
  // version-stamped and ordered by useStatusChannel — see the note there.
  const readPro = useCallback(() => invoke<ProPresenterStatusDTO>("propresenter:getStatus"), []);
  const propresenter = useStatusChannel<ProPresenterStatusDTO>(readPro, "propresenter:status");

  // pco:live is NOT one: it comes from the live controller, not an integration,
  // and carries no rev. It keeps the plain hydrate-then-subscribe shape.
  useEffect(() => {
    let cancelled = false;
    invoke<PcoLiveDTO | null>("pco:getLive")
      .then((l) => { if (!cancelled && l) setPcoLive(l); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => onNotification("pco:live", (p) => setPcoLive(p as PcoLiveDTO)), []);

  return { state, isLoading, error, pcoLive, propresenter };
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
