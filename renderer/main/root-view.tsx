import { Outlet } from "@tanstack/react-router";
import { DisplayPickerView } from "./display-picker-view";
import { BaptismOperatorView } from "./baptism-operator-view";
import { ScriptViewIndex } from "./scriptview-index-view";
import { ScriptViewPlan } from "./scriptview-plan-view";
import { HistoryView } from "./history-view";

export function RootView() {
  // The router uses memory history (ignores the URL), so branch on the real
  // path: "/" → display picker; "/baptism" → the standalone baptism operator
  // page; "/scriptview[/type/layout]" → the ScriptView dashboard; otherwise
  // "/display-N" → the kiosk StageView (Outlet).
  const slug = window.location.pathname.replace(/^\/+|\/+$/g, "");
  const parts = slug.split("/").map(decodeURIComponent);

  let content: React.ReactNode;
  if (slug === "") content = <DisplayPickerView />;
  else if (slug === "baptism") content = <BaptismOperatorView />;
  else if (slug === "history") content = <HistoryView />;
  else if (parts[0] === "scriptview") {
    content = parts.length >= 3
      ? <ScriptViewPlan serviceTypeParam={parts[1]} layoutParam={parts[2]} />
      : <ScriptViewIndex />;
  } else content = <Outlet />;

  return (
    // Kiosk root: no window chrome, edge-to-edge, on the shared kiosk surface so
    // a bg-transparent view (slots) shows the exact same color as kiosk-surface views.
    <div className="h-full w-full overflow-hidden kiosk-surface">
      {content}
    </div>
  );
}
