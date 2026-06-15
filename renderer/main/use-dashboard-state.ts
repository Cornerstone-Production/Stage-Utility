import { useState, useEffect } from "react";
import { onNotification } from "../lib/api";
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
