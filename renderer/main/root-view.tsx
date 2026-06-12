import { Outlet } from "@tanstack/react-router";

export function RootView() {
  return (
    // Kiosk root: no window chrome, solid dark background, edge-to-edge
    <div className="h-full w-full overflow-hidden bg-[#0a0a0a]">
      <Outlet />
    </div>
  );
}
