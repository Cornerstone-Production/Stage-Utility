// Rail + context bar + page header + content. The one layout every operator
// surface renders inside, which is what makes the app feel like one program
// rather than a set of pages that happen to share a server.

import { Outlet, useRouterState } from "@tanstack/react-router";
import { Rail } from "./rail";
import { ContextBar } from "./context-bar";
import { DESTINATIONS } from "./destinations";

/**
 * Title + description for the active destination, matching the per-section
 * header the settings panel shows. Nested routes (a ScriptView plan) render
 * their own heading, so nothing is shown for them rather than a wrong one.
 */
function PageHeader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = DESTINATIONS.find((d) => d.path === pathname);
  if (!active) return null;
  return (
    <header className="px-5 max-sm:px-3 pt-6 max-sm:pt-5 shrink-0">
      <h1 className="text-title2 font-semibold text-fg leading-tight">{active.label}</h1>
      <p className="text-footnote text-fg-muted mt-1 max-w-[68ch]">{active.description}</p>
    </header>
  );
}

export function Shell() {
  return (
    // The rail carries `bg-rail` (grayer than the content in light, seamless in
    // dark) and the content sits on `bg-bg` — the relationship the token layer
    // already describes. The first pass had these the other way round.
    //
    // No divider rules between the rail, the context bar and the content: the
    // surfaces already separate them, and 1px lines everywhere read as seams.
    <div className="flex h-[100dvh] overflow-hidden bg-bg">
      <Rail />
      <div className="flex flex-col flex-1 min-w-0">
        <ContextBar />
        <PageHeader />
        <main className="flex-1 min-h-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
