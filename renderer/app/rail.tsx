// Persistent navigation.
//
// Built on the same Sidebar primitives the settings panel uses, rather than a
// lookalike: SidebarListItem already carries the type scale, the accent-tinted
// active row and icon, the row spacing and the collapsed-rail tooltip. A
// hand-rolled copy drifted from all four on the first attempt.
//
// The one difference is what a row DOES. Settings selects a tab; here it
// navigates, so onSelectedItemChange routes instead of setting state.
//
// Layout state (collapsed, width) is owned by Shell and passed down, because
// SplitView needs the same values to size the panel and to decide between the
// inline rail and the mobile drawer.

import { Fragment, useEffect, useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import {
  Sidebar,
  SidebarGroupLabel,
  SidebarList,
  SidebarListItem,
  useSidebarChrome,
} from "../components/ui/sidebar";
import { BrandHeader } from "../settings/brand-header";
import { BrandLogo } from "../components/brand-logo";
import { Tooltip } from "../components/ui/tooltip";
import { ThemeTogglePill } from "../components/ui/theme-toggle-pill";
import { useTheme } from "../lib/use-theme";
import { buildLabel } from "../lib/build-label";
import { useStageState } from "../main/use-stage-state";
import { invoke } from "../lib/api";
import { errorMessage } from "@main/services/errors";
import {
  ALL_DESTINATIONS,
  DESTINATIONS,
  NAV_GROUPS,
  SETTINGS_DESTINATIONS,
  type Destination,
} from "./destinations";
import { cn } from "../lib/cn";

interface RailProps {
  onToggleCollapsed: () => void;
  dragging: boolean;
  onStartResize: (e: React.PointerEvent<HTMLElement>) => void;
  onResetWidth: () => void;
}

export function Rail({
  onToggleCollapsed,
  dragging,
  onStartResize,
  onResetWidth,
}: RailProps) {
  const { state } = useStageState();
  const theme = useTheme();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // SplitView decides what "railed" means (collapsed AND not mobile) and puts it
  // in context. Reading it here rather than recomputing keeps the drawer from
  // rendering as an icon rail.
  const { collapsed: railed, isMobile } = useSidebarChrome();

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

  // Longest match first: /settings/branding must beat /settings.
  const active =
    [...ALL_DESTINATIONS]
      .sort((a, b) => b.path.length - a.path.length)
      .find((d) => pathname === d.path || pathname.startsWith(`${d.path}/`)) ?? null;

  return (
    <Sidebar className="relative">
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
        items={[...ALL_DESTINATIONS]}
        selectedItem={active ?? undefined}
        onSelectedItemChange={(d: Destination) => router.navigate({ to: d.path })}
        getItemKey={(d: Destination) => d.path}
      >
        {NAV_GROUPS.map((g) => {
          const items = DESTINATIONS.filter((d) => g.paths.includes(d.path));
          if (items.length === 0) return null;
          return (
            <Fragment key={g.label}>
              <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
              {items.map((d) => (
                <SidebarListItem key={d.path} item={d} icon={d.icon} title={d.label} />
              ))}
            </Fragment>
          );
        })}
        <SidebarGroupLabel>Settings</SidebarGroupLabel>
        {SETTINGS_DESTINATIONS.map((d) => (
          <SidebarListItem key={d.path} item={d} icon={d.icon} title={d.label} />
        ))}
      </SidebarList>

      <div className="mt-auto">
        {/* Version, theme and collapse. Rail-aware: collapsed stacks a compact
            toggle over the expand button so the wide pill and the version never
            clip the narrow rail. */}
        {railed ? (
          <div className="flex flex-col items-center gap-1.5 px-2 py-2.5">
            <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} vertical />
            <button
              type="button"
              aria-label="Expand sidebar"
              onClick={onToggleCollapsed}
              className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill hover:text-fg transition-colors"
            >
              <PanelLeftOpenIcon className="size-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            {/* Clipped, NOT ellipsised. `truncate` spends four characters on "…"
                to save the same four — "v1.…" where "v1.10" would have fit. The
                hover carries the whole build identity anyway: version, track,
                commit and date, which is what gets asked for when something
                needs diagnosing. */}
            <Tooltip
              label={versionError ? `Could not read the build version — ${versionError}` : buildLabel(updateStatus)}
              side="top"
            >
              <span className="min-w-0 overflow-hidden whitespace-nowrap text-clip text-[11.5px] leading-none text-fg-subtle tabular-nums">
                {versionError
                  ? "version unavailable"
                  : `${updateStatus?.version ? `v${updateStatus.version}` : ""}${updateStatus?.branch ? ` · ${updateStatus.branch}` : ""}`}
              </span>
            </Tooltip>
            <div className="flex items-center gap-1.5 shrink-0">
              <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} />
              {/* No collapse control in the mobile drawer: there is nothing to
                  collapse to. The drawer is open or dismissed. */}
              {!isMobile && (
                <button
                  type="button"
                  aria-label="Collapse sidebar"
                  onClick={onToggleCollapsed}
                  className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill hover:text-fg transition-colors"
                >
                  <PanelLeftCloseIcon className="size-4" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Resize handle on the right edge. Absent when collapsed (the icon rail is
          a fixed width) and on mobile (the drawer sizes itself).

          The hit area is 7px but only a 1px line lights up, so it is easy to
          grab without drawing a permanent seam. Double-click resets, which is
          the way back from a drag that went badly. */}
      {!railed && !isMobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={onStartResize}
          onDoubleClick={onResetWidth}
          className={cn(
            "absolute inset-y-0 right-0 z-10 w-[7px] cursor-col-resize",
            "after:absolute after:inset-y-0 after:right-0 after:w-px after:transition-colors",
            dragging ? "after:bg-accent" : "after:bg-transparent hover:after:bg-line-strong",
          )}
        />
      )}
    </Sidebar>
  );
}
