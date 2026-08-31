import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { MenuIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { useIsMobile } from "../../lib/use-media-query";
import { DialogOverlay } from "./dialog";
import { Button } from "./button";
import { SidebarChromeProvider } from "./sidebar";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDrawerDrag } from "@renderer/lib/drawer-drag";

interface SplitViewProps {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  /** Desktop icon-rail collapse (controlled by the parent, persisted there). */
  collapsed?: boolean;
  /** Shown in the mobile top bar next to the hamburger (e.g. active section). */
  mobileTitle?: React.ReactNode;
  /** Right-aligned controls for the mobile top bar. On a phone that bar is the
   *  page header, so the active page's own actions belong on it. Passed in as an
   *  element rather than read from a context: this is a layout primitive, and it
   *  should not know what a page action is. */
  mobileActions?: React.ReactNode;
  /** Drop the mobile top bar and float the hamburger over the content instead.
   *  The caller hides its own band too — this primitive owns only its own. */
  chromeless?: boolean;
  expandedWidth?: number;
  railWidth?: number;
  /** Suppress the collapse width animation — set while the sidebar is being
   *  dragged, where a 150ms transition turns direct manipulation into lag. */
  resizing?: boolean;
  className?: string;
}

/**
 * Responsive two-panel shell with three states:
 *  - desktop expanded  → inline sidebar at `expandedWidth`
 *  - desktop collapsed → inline icon rail at `railWidth` (parent toggles `collapsed`)
 *  - mobile            → sidebar hidden; the hamburger opens it as a slide-over
 *                        drawer, which you can drag off to the left to close
 *
 * THE HAMBURGER IS THE ONLY WAY IN. There was also a 16px left-edge strip that
 * opened the drawer, and it is gone. It sat inside iOS Safari's back-gesture
 * zone with `touch-action: auto`, so an edge drag raced the browser's own
 * navigation and lost non-deterministically; nothing followed the finger (the
 * drawer appeared at `transform: none` ~20ms after release); and a drag under
 * the 48px threshold did nothing at all. Under Android's gesture navigation the
 * system takes the edge before Chrome sees it, so the same gesture silently did
 * nothing there. Claiming the edge also spends the browser's back gesture, which
 * is the operator's most reliable exit from a console with no chrome.
 *
 * Do not reintroduce it. See docs/superpowers/research/2026-08-30-console-chrome-free.md.
 *
 * The sidebar subtree is wrapped in a SidebarChromeProvider so its items render
 * icon-only + tooltip when railed and close the drawer on selection (mobile).
 */
export function SplitView({
  sidebar,
  children,
  collapsed = false,
  mobileTitle,
  mobileActions,
  chromeless = false,
  expandedWidth = 200,
  railWidth = 56,
  resizing = false,
  className,
}: SplitViewProps) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const railed = collapsed && !isMobile;

  // Never leave a drawer open when we transition back to desktop.
  useResyncOn([isMobile], () => {
    if (!isMobile) setDrawerOpen(false);
  });

  const closeDrawer = React.useCallback(() => setDrawerOpen(false), []);
  const chrome = { collapsed: railed, isMobile, closeDrawer };

  // Drag the drawer off to the left to close it, with the drawer under the
  // finger the whole way. There is no open-swipe — see the note above.
  // Destructured, not held as an object: the lint rule reads a member access on
  // a hook result that carries refs as a ref read during render.
  const { drawerRef, overlayRef, onPointerDown, onPointerMove, onPointerUp, onPointerCancel } =
    useDrawerDrag(closeDrawer);

  if (isMobile) {
    return (
      <div className={cn("flex flex-col h-full w-full overflow-hidden", className)}>
        {/* Top bar — pads past the status bar so the hamburger stays reachable in
            standalone (added-to-homescreen) mode where the page extends to the top. */}
        {!chromeless && (
          <div className="shrink-0 border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
            <div className="flex items-center gap-2 h-11 px-2">
              <Button variant="transparent" size="small" iconOnly aria-label="Open navigation" onClick={() => setDrawerOpen(true)}>
                <MenuIcon className="size-5 text-fg-muted" />
              </Button>
              {mobileTitle && <span className="text-[14px] font-semibold text-fg truncate">{mobileTitle}</span>}
              {mobileActions && <div className="ml-auto flex items-center gap-1.5 shrink-0">{mobileActions}</div>}
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

        {/* THE ONLY WAY OUT, so it never fades and never dims.
            Of every route off a chrome-free console this is the only one that
            exists in every container: the browser's toolbar and address bar are
            absent in an installed home-screen app, and "back" needs history a
            bookmarked console does not have.

            Two things it deliberately is not. It does not fade after inactivity
            and return on tap — on a live console the first press would land on
            the reveal instead of the fader underneath it. And it does not dim to
            stay pressable, which would make the one guaranteed exit the least
            visible thing on a screen an operator reaches for under pressure.

            BOTTOM-LEFT. Bottom, because the top of an 844px phone is the hardest
            place to reach one-handed and is exactly the band this is giving back.
            Left, because the drawer comes from the left, so the control and the
            panel it opens agree about direction. Inset above the safe area so
            Safari's bottom bar and the home indicator do not sit under it.

            IT OVERLAPS WHATEVER IS UNDER IT, and takes the tap. A console IS
            buttons, so any fixed position covers something on some layout and the
            app cannot know which. Two things keep that honest rather than
            hiding it: it is exactly its own 44px footprint, with no reserved lane
            and no larger hit region — a 44px band across the bottom would give
            back half of what this change won — and it carries its own opaque
            ground so it is legible over a near-black canvas, which is what the
            operator needs to see it and move their object out from under it.
            44x44 is 0.6% of a 390x844 screen; the chrome it replaces is 10.5%. */}
        {chromeless && (
          <Button
            variant="transparent"
            iconOnly
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
            // Its OWN ground, not the page's. A console canvas is near-black in
            // both themes, so a control wearing the page tokens comes out at
            // about 1.1:1 on it — the same trap the console's Edit button hit.
            // The popover surface carries its own contrast over anything.
            className={cn(
              "fixed left-3 z-40 size-11 rounded-full",
              "bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]",
              "border border-line-strong bg-popover/95 shadow-lg backdrop-blur-xl",
            )}
          >
            <MenuIcon className="size-5 text-fg" />
          </Button>
        )}

        <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogPrimitive.Portal>
            <DialogOverlay ref={overlayRef} />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              ref={drawerRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              // pan-y hands the browser the vertical axis — the sidebar inside
              // scrolls, and that scroll stays native — and leaves us the
              // horizontal one, declaratively. It is also the reason nothing
              // here needs a non-passive listener to call preventDefault, which
              // a React synthetic touch handler could not do anyway.
              style={{ touchAction: "pan-y" }}
              // bg-rail, not bg-surface: on mobile this drawer IS the rail, so
              // anything showing through it — an overscroll bounce, a rounding
              // gap — should be the rail's colour rather than the content's.
              className="fixed left-0 top-0 z-50 flex h-full w-64 max-w-[82vw] flex-col overflow-hidden bg-rail pt-[env(safe-area-inset-top)] shadow-xl focus:outline-none"
            >
              <DialogPrimitive.Title className="sr-only">Settings navigation</DialogPrimitive.Title>
              <SidebarChromeProvider value={chrome}>
                <div className="flex-1 min-h-0 overflow-y-auto">{sidebar}</div>
              </SidebarChromeProvider>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full w-full overflow-hidden", className)}>
      <div
        className={cn(
          // SCROLLS VERTICALLY, clips horizontally.
          //
          // It was overflow-hidden on both axes, so a rail taller than the
          // window simply lost its bottom: at 620px tall with a few consoles
          // added, Settings and everything under it sat at y=717 with no way to
          // reach them. The rail grows with the operator's consoles, so "it fits"
          // is not something this can assume.
          //
          // Horizontal stays hidden: the collapse animates WIDTH, and a label
          // mid-transition would otherwise put a scrollbar under the rail.
          "shrink-0 h-full overflow-y-auto overflow-x-hidden",
          // Animate the collapse, but never while dragging: a width transition
          // mid-drag rubber-bands behind the pointer.
          !resizing && "transition-[width] duration-(--motion-quick)",
        )}
        style={{ width: `${railed ? railWidth : expandedWidth}px` }}
      >
        <SidebarChromeProvider value={chrome}>{sidebar}</SidebarChromeProvider>
      </div>
      <div className="flex-1 min-w-0 h-full overflow-hidden">{children}</div>
    </div>
  );
}
