import { Outlet } from "@tanstack/react-router";
import { DisplayPickerView } from "./display-picker-view";

export function RootView() {
  // The router uses memory history (ignores the URL), so branch on the real
  // path: "/" → display picker; "/display-N" → the kiosk StageView (Outlet).
  const slug = window.location.pathname.replace(/^\/+|\/+$/g, "");

  return (
    // Kiosk root: no window chrome, solid dark background, edge-to-edge
    <div className="h-full w-full overflow-hidden bg-[#0a0a0a]">
      {slug === "" ? <DisplayPickerView /> : <Outlet />}
    </div>
  );
}
