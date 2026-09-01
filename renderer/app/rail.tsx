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

import { Fragment } from "react";
import { ConsoleRailIcon } from "../components/console-rail-icon";
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
import { withViewTransition } from "../lib/view-transition";
import { resetCurrentRoute } from "./route-reset";
import { consolePageFor, consoleViewList, resolvePage } from "./active-page";
import { useStageState } from "../main/use-stage-state";
import { errorMessage } from "@main/services/errors";
import { isUpdateAvailable } from "@main/services/update/availability";
import { useUpdateStatus } from "./queries";
import {
  ALL_DESTINATIONS,
  DESTINATIONS,
  NAV_GROUPS,
  SETTINGS_DESTINATIONS,
  UNGROUPED_PATHS,
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
  // The LIVE status, not a one-shot fetch. This was invoked once on mount, so
  // both the dot below and the version label at the foot of the rail went stale
  // the moment anything changed and stayed stale until a reload.
  const { data: updateStatus, error: updateError } = useUpdateStatus();
  const versionError = updateError ? errorMessage(updateError) : null;
  const updateAvailable = isUpdateAvailable(updateStatus);

  // A rail entry per console View, from the same helper the shell titles a
  // console with. The rail row and the page title cannot disagree about a
  // console's name if only one place decides what it is called.
  // Each console's page, built ONCE and used for both jobs below: the candidate
  // list the matcher runs over, and the row itself. It used to be built twice
  // per console per render, and the second copy's path was then re-spelled by
  // hand a third time to decide whether the row was selected.
  const consoleEntries = consoleViewList(state?.views).map((view) => ({
    view,
    page: consolePageFor(view),
  }));

  // Which page is current. resolvePage is the app's ONE matcher; the rail used
  // to carry its own copy of the longest-prefix rule, over a candidate list that
  // knew nothing about the nested routes.
  //
  // Resolved before the destinations are built, because a console's icon has to
  // know whether it is the current page — it wears the operator's colour only
  // while selected.
  const activePath = resolvePage(pathname, consoleEntries.map((c) => c.page))?.page.path ?? null;

  const consoles: Destination[] = consoleEntries.map(({ view, page }) => ({
    // path, label and description all come from consolePageFor, so the rail row
    // and the page header cannot name the same console two different things.
    ...page,
    // A PLAIN GLYPH. Nothing interactive goes in here: the row itself is a
    // <button>, and putting one inside it is invalid markup whose outer button
    // swallows the click — the page navigated every time an icon was touched.
    // Right-clicking the glyph opens the set, from a portal.
    icon: <ConsoleRailIcon viewId={view.id} label={view.name} active={activePath === page.path} />,
    Component: () => null, // routing is by path; the route table owns the component
  }));

  const active = [...ALL_DESTINATIONS, ...consoles].find((d) => d.path === activePath) ?? null;

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
        items={[...ALL_DESTINATIONS, ...consoles]}
        selectedItem={active ?? undefined}
        onSelectedItemChange={(d: Destination) => {
          // Re-selecting the item you are already on resets that route rather
          // than navigating nowhere: TanStack treats a navigate() to the current
          // path as a no-op, so without this, clicking "History" while inside a
          // service did nothing at all.
          //
          // EXACTLY on it, though. `active` matches by prefix so a child route
          // lights its parent up in the rail — which is right — but it also made
          // clicking Screens from /screens/<id>/edit reset the EDITOR instead of
          // going back to the grid. From a child route this is a navigation, not
          // a reset.
          if (d.path === active?.path && pathname === d.path) {
            resetCurrentRoute();
            return;
          }
          // Crossfade between destinations. Feature-detected and skipped under
          // prefers-reduced-motion inside the helper.
          withViewTransition(() => router.navigate({ to: d.path }));
        }}
        getItemKey={(d: Destination) => d.path}
      >
        {/* Home first, above the group labels — it is the front door, not a
            member of a category. */}
        {DESTINATIONS.filter((d) => UNGROUPED_PATHS.includes(d.path)).map((d) => (
          <SidebarListItem key={d.path} item={d} icon={d.icon} title={d.label} />
        ))}
        {/* One row per console, above the fixed groups: a console is a place you
            work, and the spec's rail puts them one click from anywhere rather
            than behind a picker. Absent entirely until a console exists, so an
            install that has none sees the rail it has today. */}
        {consoles.length > 0 && (
          <Fragment key="consoles">
            <SidebarGroupLabel>Consoles</SidebarGroupLabel>
            {consoles.map((c) => (
              <SidebarListItem
                key={c.path}
                item={c}
                icon={c.icon}
                title={c.label}
              />
            ))}
          </Fragment>
        )}
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
        {SETTINGS_DESTINATIONS.map((d) => {
          // Advanced is where an update is installed, so it is where the dot
          // goes. It follows AVAILABILITY, not whether the toast fired: dismiss
          // a toast and the dot stays until the update is actually taken.
          const flagged = updateAvailable && d.path === "/settings/advanced";
          return (
            <SidebarListItem
              key={d.path}
              item={d}
              icon={d.icon}
              title={d.label}
              ariaLabel={flagged ? `${d.label}, update available` : undefined}
              badge={flagged ? <span title="Update available" className="block size-1.5 rounded-full bg-accent" /> : undefined}
            />
          );
        })}
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
              className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill hover:text-fg transition-colors duration-(--motion-instant)"
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
                  className="rounded-lg p-1.5 text-fg-subtle hover:bg-fill hover:text-fg transition-colors duration-(--motion-instant)"
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
