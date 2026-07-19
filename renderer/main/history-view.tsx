import { useEffect } from "react";

import { ServiceHistorySection } from "../settings/sections/service-history-section";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "./use-stage-state";

// Public, read-only Service History at /history — a shareable link for staff
// outside Production. It renders the SAME ServiceHistorySection the Settings tab
// uses (so any update to History shows up here automatically), just in read-only
// mode (no edit-times / merge / delete) and without the settings chrome. The
// `dark` wrapper pins the settings look regardless of the kiosk theme on <html>.
export function HistoryView() {
  const { state } = useStageState();
  useEffect(() => {
    document.title = `${state?.appName ?? "Stage Utility"} — History`;
  }, [state?.appName]);

  return (
    <div className="dark flex h-[100dvh] flex-col overscroll-none bg-bg text-fg">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        {state?.appLogo && (
          <BrandLogo logo={state.appLogo} monochrome className="size-5 rounded text-fg" />
        )}
        <span className="text-callout font-title text-fg">{state?.appName ?? "Stage Utility"}</span>
        <span className="text-fg-subtle" aria-hidden="true">·</span>
        <span className="text-callout font-semibold text-fg">Service History</span>
        <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-caption2 text-fg-subtle">
          Read-only
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[1100px] px-5 pb-[40vh] pt-5 max-sm:px-3">
          <ServiceHistorySection readOnly />
        </div>
      </div>
    </div>
  );
}
