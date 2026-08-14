// Persistent navigation. Brand header (identity - always shown, never
// configurable), the destinations, then the footer chrome carried over from the
// settings shell: version + build identity, the three-way theme toggle, and the
// persisted collapse control.

import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, SettingsIcon } from "lucide-react";
import { BrandLogo } from "../components/brand-logo";
import { Tooltip } from "../components/ui/tooltip";
import { ThemeTogglePill } from "../components/ui/theme-toggle-pill";
import { useTheme } from "../lib/use-theme";
import { useSidebarCollapsed } from "../lib/use-sidebar-collapsed";
import { buildLabel } from "../lib/build-label";
import { useStageState } from "../main/use-stage-state";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { DESTINATIONS } from "./destinations";
import { cn } from "../lib/cn";

export function Rail() {
  const { state } = useStageState();
  const theme = useTheme();
  const { collapsed, toggle } = useSidebarCollapsed();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // The footer's version readout. A failure here must not blank the navigation,
  // but it is not swallowed either: the reason is kept and shown in the tooltip,
  // so an operator can tell "still loading" from "the check failed" instead of
  // reading the same empty label for both.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<UpdateStatus>("update:status")
      .then((s) => { if (!cancelled) setUpdateStatus(s); })
      .catch((e: unknown) => { if (!cancelled) setVersionError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, []);

  return (
    <nav
      className={cn(
        "flex flex-col shrink-0 border-r border-line bg-surface",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <div className={cn("flex items-center h-12 shrink-0", collapsed ? "justify-center px-2" : "gap-2 px-3")}>
        {state?.appLogo && (
          <BrandLogo
            logo={state.appLogo}
            monochrome={state.appLogoMonochrome}
            className="size-5 rounded select-none shrink-0"
          />
        )}
        {!collapsed && (
          <span className="text-caption1 font-title text-fg truncate select-none">
            {state?.appName ?? "Stage Utility"}
          </span>
        )}
      </div>

      <div className={cn("flex flex-col gap-0.5 py-2 min-h-0 overflow-y-auto", collapsed ? "px-2" : "px-2")}>
        {DESTINATIONS.map((d) => {
          const active = pathname === d.path || pathname.startsWith(`${d.path}/`);
          const link = (
            <Link
              key={d.path}
              to={d.path}
              className={cn(
                "flex items-center rounded-lg py-2 text-body transition-colors",
                collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
                active ? "bg-fill text-fg" : "text-fg-muted hover:bg-fill-hover hover:text-fg",
              )}
            >
              {d.icon}
              {!collapsed && <span className="truncate">{d.label}</span>}
            </Link>
          );
          // Collapsed to icons, the label is the only thing naming the
          // destination, so it has to survive as a tooltip.
          return collapsed ? (
            <Tooltip key={d.path} label={d.label} side="right">
              {link}
            </Tooltip>
          ) : (
            link
          );
        })}
      </div>

      <div className="mt-auto">
        <div className={cn("border-t border-line py-2", collapsed ? "px-2" : "px-2")}>
          {/* Settings is still its own document in Phase 1a; it becomes routes in
              Phase 1b. A full navigation is correct here, not a router Link. */}
          <a
            href="/settings"
            className={cn(
              "flex items-center rounded-lg py-2 text-body text-fg-muted hover:bg-fill-hover hover:text-fg transition-colors",
              collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
            )}
          >
            <SettingsIcon className="size-4 shrink-0" />
            {!collapsed && <span>Settings</span>}
          </a>
        </div>

        {/* Carried from the settings shell. Rail-aware: collapsed stacks a
            compact toggle over the expand button so the wide pill and the
            version never clip the narrow rail. */}
        {collapsed ? (
          <div className="flex flex-col items-center gap-1.5 border-t border-line px-2 py-2.5">
            <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} vertical />
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={toggle}
              className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill-hover hover:text-fg transition-colors"
            >
              <PanelLeftOpenIcon className="size-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2.5">
            {/* The label truncates in the rail, so the hover carries the whole
                build identity — version, track, commit and date. That is what
                gets asked for when something needs diagnosing. */}
            <Tooltip
              label={versionError ? `Could not read the build version — ${versionError}` : buildLabel(updateStatus)}
              side="top"
            >
              <span className="min-w-0 text-[11.5px] leading-none text-fg-subtle tabular-nums truncate">
                {versionError
                  ? "version unavailable"
                  : `${updateStatus?.version ? `v${updateStatus.version}` : ""}${updateStatus?.branch ? ` · ${updateStatus.branch}` : ""}`}
              </span>
            </Tooltip>
            <div className="flex items-center gap-1.5 shrink-0">
              <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} />
              <button
                type="button"
                aria-label="Collapse sidebar"
                onClick={toggle}
                className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill-hover hover:text-fg transition-colors max-sm:hidden"
              >
                <PanelLeftCloseIcon className="size-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
