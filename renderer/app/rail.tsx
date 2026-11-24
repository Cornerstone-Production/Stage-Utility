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

import { Fragment, useState, type ReactNode } from "react";
import { ConsoleRailIcon } from "../components/console-rail-icon";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { EyeOffIcon, LockIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PencilIcon } from "lucide-react";
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
import { ContextMenu, type ContextMenuItem } from "../components/ui/context-menu";
import { useContextMenuState, useContextMenuTrigger } from "../components/ui/context-menu-trigger";
import { useTheme } from "../lib/use-theme";
import { plural } from "@main/services/plural";
import { buildLabel } from "../lib/build-label";
import { withViewTransition } from "../lib/view-transition";
import { resetCurrentRoute } from "./route-reset";
import { consolePageFor, resolvePage, sidebarConsoleList } from "./active-page";
import { useStageState } from "../main/use-stage-state";
import { errorMessage } from "@main/services/errors";
import { useUpdateStatus } from "./queries";
import { useNotSetUpCount } from "./screens/use-devices";
import { advancedRailPath, useAdvancedSignals } from "./advanced-signals";
import { ALL_DESTINATIONS, destinationsById, type Destination } from "./destinations";
import { consoleMemberId, isConsoleId, LOCKED_PAGE } from "@main/services/sidebar-arrangement";
import { useCustomize, useResolvedSidebar } from "./customize-mode";
import { movePage, sectionOf } from "./sidebar-edits";
import { RailEditor } from "./rail-editor";
import { cn } from "../lib/cn";

/** The Screens page's route: the row that carries the count of screens not set up. */
const SCREENS_PATH = "/screens";
/** The Advanced destination's route, whose row carries the update dot and the host names count. */
const ADVANCED_PATH = "/settings/advanced";

/** A count on a nav row. The row positions it; this is only what it looks like.
 *  Smaller in the collapsed rail, where the row is 40x32 and the badge sits in its
 *  corner over the icon. */
function CountBadge({ count, compact }: { count: number; compact: boolean }) {
  return (
    <span
      className={cn(
        "grid place-items-center rounded-full bg-accent font-semibold tabular-nums text-white",
        compact ? "h-4 min-w-4 px-1 text-[10px]" : "h-[18px] min-w-[18px] px-[5px] text-[11px]",
      )}
    >
      {count}
    </span>
  );
}

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

  // The resize handle's only other way in on a coarse pointer: `onDoubleClick`
  // resets the width for a mouse, but a finger has no double-click. There is
  // no existing rail-level menu to add a second item to — ConsoleRailIcon's
  // menu is per-console and about icons, not the rail itself — so this is a
  // menu of exactly one item, opened the same way every other touch-only menu
  // in the app is (see context-menu-trigger.ts).
  const [resizeMenu, setResizeMenu] = useState<{ x: number; y: number } | null>(null);
  const resizeTrigger = useContextMenuTrigger((point) => setResizeMenu(point));

  // The footer's version readout. A failure here must not blank the navigation,
  // but it is not swallowed either: the reason is kept and shown in the tooltip,
  // so an operator can tell "still loading" from "the check failed" instead of
  // reading the same empty label for both.
  // The LIVE status, not a one-shot fetch. This was invoked once on mount, so
  // both the dot below and the version label at the foot of the rail went stale
  // the moment anything changed and stayed stale until a reload.
  const { data: updateStatus, error: updateError } = useUpdateStatus();
  const versionError = updateError ? errorMessage(updateError) : null;
  // Devices heard on the network and not set up. From every page, not just
  // Screens: the server records them with no scan, and tells this tab on the
  // channel Screens already listens to, so a screen switched on is noticed here.
  const notSetUpCount = useNotSetUpCount();
  // Names the server was reached by that wait for an accept or a dismiss, on the
  // Host names card under Advanced. A count of NAMES, not requests: one display
  // asks every few seconds, and the number to act on is how many need a decision.
  const advancedSignals = useAdvancedSignals(state);
  const { updateAvailable, hostNamesWaiting, duplicateServers } = advancedSignals;

  // A rail entry per console View the operator has not hidden from the sidebar.
  // A hidden console is still a page — the shell titles it from the full list —
  // so only the LIST is narrower here. The page builder is the one the shell
  // titles a console with, so the rail row and the page title cannot disagree
  // about a console's name if only one place decides what it is called.
  // Each console's page, built ONCE and used for both jobs below: the candidate
  // list the matcher runs over, and the row itself. It used to be built twice
  // per console per render, and the second copy's path was then re-spelled by
  // hand a third time to decide whether the row was selected.
  const consoleEntries = sidebarConsoleList(state?.views).map((view) => ({
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
    // The sidebar's id for it: the view's, never the path.
    id: consoleMemberId(view.id),
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

  // Every row the sidebar can draw, by its id: a page's route, a console's path.
  // A Map, because the ids come from a saved arrangement.
  const byId = destinationsById([...ALL_DESTINATIONS, ...consoles]);
  const customize = useCustomize();
  const resolved = useResolvedSidebar();

  /** A row's status mark and its spoken form. */
  function marksFor(d: Destination): { badge?: ReactNode; ariaLabel?: string } {
    if (d.path === SCREENS_PATH) {
      const waiting = notSetUpCount;
      return waiting > 0
        ? { badge: <CountBadge count={waiting} compact={railed} />, ariaLabel: `${d.label}, ${waiting} not set up` }
        : {};
    }
    if (d.path !== ADVANCED_PATH) return {};
    // Advanced is where an update is installed, so it is where the dot goes. It
    // follows AVAILABILITY, not whether the toast fired: dismiss a toast and the
    // dot stays until the update is actually taken. Host names waiting for a
    // decision live there too, and take the badge as a count, the way Screens
    // counts devices not set up.
    const names = hostNamesWaiting;
    const duplicate = duplicateServers > 0;
    const said: string[] = [];
    if (duplicate) said.push("another server is using this server's id");
    if (updateAvailable) said.push("update available");
    if (names > 0) said.push(`${plural(names, "host name")} waiting`);
    let badge: ReactNode;
    // Red, and first: screens are switching between two servers now. The
    // other marks are things waiting, not things wrong.
    if (duplicate) badge = <span title="Another server is using this server's id" className="block size-1.5 rounded-full bg-danger-9" />;
    else if (names > 0) badge = <CountBadge count={names} compact={railed} />;
    else if (updateAvailable) badge = <span title="Update available" className="block size-1.5 rounded-full bg-accent" />;
    return { badge, ariaLabel: said.length > 0 ? `${d.label}, ${said.join(", ")}` : undefined };
  }

  // The rail's own menu: from a heading, the brand or empty space, and under
  // every page's own items.
  const railMenuItems: ContextMenuItem[] = [
    { label: "Customize sidebar…", icon: <PencilIcon className="size-3.5" />, onSelect: () => customize.open("sidebar") },
    ...(isMobile
      ? []
      : [
          {
            label: railed ? "Expand sidebar" : "Collapse sidebar",
            icon: railed ? <PanelLeftOpenIcon className="size-3.5" /> : <PanelLeftCloseIcon className="size-3.5" />,
            onSelect: onToggleCollapsed,
          },
          { label: "Reset sidebar width", onSelect: onResetWidth },
        ]),
  ];

  /** A page's menu: Hide and Move to, so a one-off change never needs the mode.
   *  A console offers Hide only: it stays in Consoles. */
  function rowMenuItems(d: Destination): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (d.id === LOCKED_PAGE) {
      items.push({ label: "Advanced can't be hidden", icon: <LockIcon className="size-3.5" />, disabled: true });
    } else {
      items.push({
        label: `Hide “${d.label}”`,
        icon: <EyeOffIcon className="size-3.5" />,
        onSelect: () => customize.hide(d.id, d.label),
      });
    }
    if (!isConsoleId(d.id)) {
      const current = sectionOf(resolved, d.id);
      const targets = resolved.sections.filter((s) => s !== current && s.kind !== "consoles");
      if (targets.length > 0) {
        items.push({ heading: true, label: "Move to" });
        for (const s of targets) {
          items.push({
            label: s.label || "Top, beside Home",
            onSelect: () =>
              customize.apply((r) => movePage(r, d.id, s.id, Infinity), `Moved ${d.label} to ${s.label || "the top"}.`, true),
          });
        }
      }
    }
    return [...items, { separator: true }, ...railMenuItems];
  }

  const [railMenu, setRailMenu] = useState<{ x: number; y: number } | null>(null);
  const railTrigger = useContextMenuTrigger((point) => setRailMenu(point));

  // Customize mode draws the same sidebar as an editor, in place.
  if (customize.customizing) {
    return (
      <Sidebar className="relative bg-[color-mix(in_srgb,var(--su-rail),var(--su-accent)_4%)] shadow-[inset_-2px_0_0_var(--su-accent)]">
        <RailEditor byId={byId} marksFor={marksFor} />
        <RailFooter
          railed={false}
          isMobile={isMobile}
          theme={theme}
          versionError={versionError}
          updateStatus={updateStatus}
          onToggleCollapsed={onToggleCollapsed}
        />
      </Sidebar>
    );
  }

  return (
    <Sidebar
      className="relative"
      onContextMenu={railTrigger.onContextMenu}
      onPointerDown={railTrigger.onPointerDown}
      onPointerMove={railTrigger.onPointerMove}
      onPointerUp={railTrigger.onPointerUp}
      onPointerCancel={railTrigger.onPointerCancel}
      onClickCapture={railTrigger.onClickCapture}
      style={railTrigger.style}
    >
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
          // The Advanced row goes to the tab its mark is about (Updates for the
          // dot, Network for the count), not to a page that opens on General.
          const to = d.path === ADVANCED_PATH ? advancedRailPath(advancedSignals) : d.path;
          withViewTransition(() => router.navigate({ to }));
        }}
        getItemKey={(d: Destination) => d.path}
      >
        {/* The operator's arrangement, drawn from the one resolver the server
            validates against: the unnamed top group (Home), then each section
            under its heading. A section with nothing in it is not drawn. A
            console appears only once one exists, so an install that has none
            sees no Consoles heading. */}
        {resolved.sections.map((section) => {
          const rows = section.members.map((id) => byId.get(id)).filter((d): d is Destination => d !== undefined);
          if (rows.length === 0) return null;
          return (
            <Fragment key={section.id}>
              {section.kind !== "top" && <SidebarGroupLabel>{section.label}</SidebarGroupLabel>}
              {rows.map((d) => (
                <RailRow key={d.id} d={d} {...marksFor(d)} menuItems={() => rowMenuItems(d)} />
              ))}
            </Fragment>
          );
        })}
      </SidebarList>

      <RailFooter
        railed={railed}
        isMobile={isMobile}
        theme={theme}
        versionError={versionError}
        updateStatus={updateStatus}
        onToggleCollapsed={onToggleCollapsed}
      />

      {/* Resize handle on the right edge. Absent when collapsed (the icon rail is
          a fixed width) and on mobile (the drawer sizes itself).

          The hit area is 7px but only a 1px line lights up, so it is easy to
          grab without drawing a permanent seam — widened to 16px under a
          coarse pointer (`coarse:w-4`), where 7px is under a finger's own
          width, while the line itself stays the same thin `after:w-px`.
          Double-click resets, which is the way back from a drag that went
          badly, for a mouse — a finger has no double-click, so a tap-and-hold
          opens the one-item menu below instead (see `resizeTrigger` and its
          comment above). This handle already owns `after:` for the visible
          line, so the reset item rides `useContextMenuTrigger` directly
          rather than the shared `.touch-target` class, which would collide
          with it on the same pseudo-element. */}
      {!railed && !isMobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={(e) => {
            onStartResize(e);
            resizeTrigger.onPointerDown(e);
            // The press is this handle's: the rail around it must not time the same
            // finger into its own menu as well.
            if (e.pointerType !== "mouse") e.stopPropagation();
          }}
          onPointerMove={resizeTrigger.onPointerMove}
          onPointerUp={resizeTrigger.onPointerUp}
          onPointerCancel={resizeTrigger.onPointerCancel}
          onContextMenu={(e) => {
            // Its own one-item menu, not the rail's as well.
            e.stopPropagation();
            resizeTrigger.onContextMenu(e);
          }}
          onClickCapture={resizeTrigger.onClickCapture}
          onDoubleClick={onResetWidth}
          style={resizeTrigger.style}
          className={cn(
            "absolute inset-y-0 right-0 z-10 w-[7px] coarse:w-4 cursor-col-resize",
            "after:absolute after:inset-y-0 after:right-0 after:w-px after:transition-colors",
            dragging ? "after:bg-accent" : "after:bg-transparent hover:after:bg-line-strong",
          )}
        />
      )}
      {resizeMenu && (
        <ContextMenu
          x={resizeMenu.x}
          y={resizeMenu.y}
          items={[{ label: "Reset sidebar width", onSelect: onResetWidth }]}
          onClose={() => setResizeMenu(null)}
        />
      )}
      {railMenu && (
        <ContextMenu x={railMenu.x} y={railMenu.y} items={railMenuItems} onClose={() => setRailMenu(null)} />
      )}
    </Sidebar>
  );
}

/**
 * One page or console in the sidebar, with its own right-click and long-press
 * menu.
 *
 * Its own trigger, on the ROW: the row is a <button>, and a trigger on the rail
 * around it treats a press on a control inside as that control's own (see
 * context-menu-trigger.ts), so the rail's menu would never open from a row on a
 * phone. A console's glyph keeps its own menu for the icon: a press there is
 * left to it.
 */
function RailRow({
  d,
  badge,
  ariaLabel,
  menuItems,
}: {
  d: Destination;
  badge?: ReactNode;
  ariaLabel?: string;
  menuItems: () => ContextMenuItem[];
}) {
  const { menu, open, close } = useContextMenuState();
  const trigger = useContextMenuTrigger((point) => open(point, menuItems()));
  return (
    <>
      <SidebarListItem
        item={d}
        icon={d.icon}
        title={d.label}
        ariaLabel={ariaLabel}
        badge={badge}
        onContextMenu={(e) => {
          // The rail's own menu must not open on top of this one.
          e.stopPropagation();
          trigger.onContextMenu(e);
        }}
        onPointerDown={(e) => {
          trigger.onPointerDown(e);
          // The press is this row's: the rail around it must not time the same finger
          // into its own menu as well. A console's glyph stops its press before it
          // gets here, so the glyph's icon menu is the only one it opens.
          if (e.pointerType !== "mouse") e.stopPropagation();
        }}
        onPointerMove={trigger.onPointerMove}
        onPointerUp={trigger.onPointerUp}
        onPointerCancel={trigger.onPointerCancel}
        onClickCapture={trigger.onClickCapture}
        style={trigger.style}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />}
    </>
  );
}

/** Version, theme and collapse. Rail-aware: collapsed stacks a compact toggle
 *  over the expand button so the wide pill and the version never clip the
 *  narrow rail. */
function RailFooter({
  railed,
  isMobile,
  theme,
  versionError,
  updateStatus,
  onToggleCollapsed,
}: {
  railed: boolean;
  isMobile: boolean;
  theme: ReturnType<typeof useTheme>;
  versionError: string | null;
  updateStatus: ReturnType<typeof useUpdateStatus>["data"];
  onToggleCollapsed: () => void;
}) {
  return (
    <div className="mt-auto">
      {railed ? (
        <div className="flex flex-col items-center gap-1.5 px-2 py-2.5">
          <ThemeTogglePill mode={theme.mode} setMode={theme.setMode} vertical />
          <button
            type="button"
            aria-label="Expand sidebar"
            onClick={onToggleCollapsed}
            className="touch-target rounded-lg p-1.5 text-fg-subtle hover:bg-fill hover:text-fg transition-colors duration-(--motion-instant)"
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
                className="touch-target rounded-lg p-1.5 text-fg-subtle hover:bg-fill hover:text-fg transition-colors duration-(--motion-instant)"
              >
                <PanelLeftCloseIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
