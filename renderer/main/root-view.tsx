import { Outlet } from "@tanstack/react-router";

export function RootView() {
  // The kiosk serves exactly one thing now: a display at "/display-N", rendered
  // through the Outlet.
  //
  // It used to branch on window.location for the operator surfaces (/history,
  // /patch, /baptism, /scriptview) and for the display picker at "/". All of
  // those belong to the operator app (app.html), which the server routes them
  // to — see main/services/routes/operator-paths.ts. The picker's job is now
  // "Use this screen as a display" on Home.
  return (
    // Kiosk root: no window chrome, edge-to-edge, on the shared kiosk surface so
    // a bg-transparent view (slots) shows the exact same color as kiosk-surface views.
    <div className="h-full w-full overflow-hidden kiosk-surface">
      <Outlet />
    </div>
  );
}
