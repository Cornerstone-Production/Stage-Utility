import { Outlet } from "@tanstack/react-router";
import { DisplayPickerView } from "./display-picker-view";

export function RootView() {
  // The router uses memory history (ignores the URL), so branch on the real
  // path: "/" → display picker; "/display-N" → the kiosk StageView (Outlet).
  const slug = window.location.pathname.replace(/^\/+|\/+$/g, "");

  return (
    // Kiosk root: no window chrome, edge-to-edge, on the shared kiosk surface so
    // a bg-transparent view (slots) shows the exact same color as kiosk-surface views.
    <div className="h-full w-full overflow-hidden kiosk-surface">
      {slug === "" ? <DisplayPickerView /> : <Outlet />}
    </div>
  );
}
