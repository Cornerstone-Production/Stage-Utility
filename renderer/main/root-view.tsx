import { Outlet } from "@tanstack/react-router";
import { DisplayPickerView } from "./display-picker-view";

export function RootView() {
  // The kiosk router uses memory history (ignores the URL), so branch on the
  // real path: "/" is the display picker, and everything else is "/display-N"
  // rendering the kiosk StageView through the Outlet.
  //
  // The operator surfaces — /history, /patch, /baptism, /scriptview — used to be
  // handled here as chrome-free islands with no navigation. They belong to the
  // operator app (app.html) now, which the server routes them to; see
  // main/services/routes/operator-paths.ts.
  const slug = window.location.pathname.replace(/^\/+|\/+$/g, "");

  return (
    // Kiosk root: no window chrome, edge-to-edge, on the shared kiosk surface so
    // a bg-transparent view (slots) shows the exact same color as kiosk-surface views.
    <div className="h-full w-full overflow-hidden kiosk-surface">
      {slug === "" ? <DisplayPickerView /> : <Outlet />}
    </div>
  );
}
