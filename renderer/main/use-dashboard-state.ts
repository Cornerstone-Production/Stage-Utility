import { useState, useEffect } from "react";
import { invoke, onNotification } from "../lib/api";
import { useStageState } from "./use-stage-state";

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
  const [propresenter, setPropresenter] = useState<ProPresenterStatusDTO | null>(null);

  // Hydrate immediately on mount — these channels only broadcast on change, so a
  // freshly-loaded dashboard would otherwise show "offline" / blank until the next
  // slide change or poll tick. Fetch the current values right away.
  useEffect(() => {
    let cancelled = false;
    invoke<ProPresenterStatusDTO>("propresenter:getStatus")
      .then((s) => { if (!cancelled && s) setPropresenter(s); })
      .catch(() => { /* not configured yet — ignore */ });
    invoke<PcoLiveDTO | null>("pco:getLive")
      .then((l) => { if (!cancelled && l) setPcoLive(l); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const unsubLive = onNotification("pco:live", (p) => setPcoLive(p as PcoLiveDTO));
    const unsubPro = onNotification("propresenter:status", (p) =>
      setPropresenter(p as ProPresenterStatusDTO),
    );
    return () => {
      unsubLive();
      unsubPro();
    };
  }, []);

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
