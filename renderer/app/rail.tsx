// Persistent navigation. Brand header (identity - always shown, never
// configurable), then the destinations. The footer chrome - version, theme
// toggle, collapse - lands with the parity pass.

import { Link, useRouterState } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { BrandLogo } from "../components/brand-logo";
import { useStageState } from "../main/use-stage-state";
import { DESTINATIONS } from "./destinations";
import { cn } from "../lib/cn";

export function Rail() {
  const { state } = useStageState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="flex flex-col w-56 shrink-0 border-r border-line bg-surface">
      <div className="flex items-center gap-2 h-12 px-3 shrink-0">
        {state?.appLogo && (
          <BrandLogo
            logo={state.appLogo}
            monochrome={state.appLogoMonochrome}
            className="size-5 rounded select-none"
          />
        )}
        <span className="text-caption1 font-title text-fg truncate select-none">
          {state?.appName ?? "Stage Utility"}
        </span>
      </div>

      <div className="flex flex-col gap-0.5 px-2 py-2 min-h-0 overflow-y-auto">
        {DESTINATIONS.map((d) => {
          const active = pathname === d.path || pathname.startsWith(`${d.path}/`);
          return (
            <Link
              key={d.path}
              to={d.path}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-body transition-colors",
                active ? "bg-fill text-fg" : "text-fg-muted hover:bg-fill-hover hover:text-fg",
              )}
            >
              {d.icon}
              <span className="truncate">{d.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="mt-auto px-2 py-2 border-t border-line">
        {/* Settings is still its own document in Phase 1a; it becomes routes in
            Phase 1b. A full navigation is correct here, not a router Link. */}
        <a
          href="/settings"
          className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-body text-fg-muted hover:bg-fill-hover hover:text-fg transition-colors"
        >
          <SettingsIcon className="size-4" />
          <span>Settings</span>
        </a>
      </div>
    </nav>
  );
}
