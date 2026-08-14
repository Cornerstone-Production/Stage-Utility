// Persistent navigation.
//
// Built on the same Sidebar primitives the settings panel uses, rather than a
// lookalike: SidebarListItem already carries the type scale, the accent-tinted
// active row and icon, the row spacing and the collapsed-rail tooltip. A
// hand-rolled copy drifted from all four on the first attempt.
//
// The one difference is what a row DOES. Settings selects a tab; here it
// navigates, so onSelectedItemChange routes instead of setting state.

import { useEffect, useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, SettingsIcon } from "lucide-react";
import {
  Sidebar,
  SidebarChromeProvider,
  SidebarList,
  SidebarListItem,
} from "../components/ui/sidebar";
import { BrandHeader } from "../settings/brand-header";
import { BrandLogo } from "../components/brand-logo";
import { Tooltip } from "../components/ui/tooltip";
import { ThemeTogglePill } from "../components/ui/theme-toggle-pill";
import { useTheme } from "../lib/use-theme";
import { useSidebarCollapsed } from "../lib/use-sidebar-collapsed";
import { useIsMobile } from "../lib/use-media-query";
import { buildLabel } from "../lib/build-label";
import { useStageState } from "../main/use-stage-state";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import { DESTINATIONS, type Destination } from "./destinations";
import { cn } from "../lib/cn";

export function Rail() {
  const { state } = useStageState();
  const theme = useTheme();
  const { collapsed, toggle } = useSidebarCollapsed();
  const isMobile = useIsMobile();
  const railed = collapsed && !isMobile;
  const router = useRouter();
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

  const active =
    DESTINATIONS.find((d) => pathname === d.path || pathname.startsWith(`${d.path}/`)) ?? null;

  return (
    <SidebarChromeProvider value={{ collapsed: railed, isMobile }}>
      <Sidebar className={cn("shrink-0 border-r border-line", railed ? "w-14" : "w-56")}>
        {railed ? (
          state?.appLogo ? (
            <div className="flex flex-col items-center pt-2">
              <BrandLogo
                logo={state.appLogo}
                monochrome={state.appLogoMonochrome}
                className="size-8 rounded-md text-fg"
              />
            </div>
          ) : null
        ) : (
          <BrandHeader
            name={state?.appName ?? "Stage Utility"}
            logo={state?.appLogo ?? null}
            monochrome={state?.appLogoMonochrome ?? false}
          />
        )}

        <SidebarList
          items={[...DESTINATIONS]}
          selectedItem={active ?? undefined}
          onSelectedItemChange={(d: Destination) => router.navigate({ to: d.path })}
          getItemKey={(d: Destination) => d.path}
        >
          {DESTINATIONS.map((d) => (
            <SidebarListItem key={d.path} item={d} icon={d.icon} title={d.label} />
          ))}
        </SidebarList>

        <div className="mt-auto">
          {/* Settings is still its own document in Phase 1a; it becomes routes in
              Phase 1b, at which point it joins the list above. Quieter and
              smaller than a destination because it is not one. */}
          <a
            href="/settings"
            className={cn(
              "flex items-center gap-2.5 mx-2 rounded-lg px-2.5 py-1.5",
              "text-caption1 font-medium text-fg-subtle transition-colors",
              "hover:bg-fill hover:text-fg",
              railed && "justify-center px-0",
            )}
            aria-label={railed ? "Settings" : undefined}
          >
            <SettingsIcon className="size-3.5 shrink-0" />
            {!railed && <span>Settings</span>}
          </a>

          {/* Version, theme and collapse. Rail-aware: collapsed stacks a compact
              toggle over the expand button so the wide pill and the version
              never clip the narrow rail. */}
          {railed ? (
            <div className="flex flex-col items-center gap-1.5 px-2 py-2.5">
              <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} vertical />
              <button
                type="button"
                aria-label="Expand sidebar"
                onClick={toggle}
                className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill hover:text-fg transition-colors"
              >
                <PanelLeftOpenIcon className="size-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 px-3 py-2.5">
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
                  className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill hover:text-fg transition-colors max-sm:hidden"
                >
                  <PanelLeftCloseIcon className="size-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </Sidebar>
    </SidebarChromeProvider>
  );
}
