import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { MenuIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { useIsMobile } from "../../lib/use-media-query";
import { DialogOverlay } from "./dialog";
import { Button } from "./button";
import { SidebarChromeProvider } from "./sidebar";

interface SplitViewProps {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  /** Desktop icon-rail collapse (controlled by the parent, persisted there). */
  collapsed?: boolean;
  /** Shown in the mobile top bar next to the hamburger (e.g. active section). */
  mobileTitle?: React.ReactNode;
  expandedWidth?: number;
  railWidth?: number;
  className?: string;
}

const SWIPE_MIN = 48; // px of horizontal travel to count as a swipe

/**
 * Responsive two-panel shell with three states:
 *  - desktop expanded  → inline sidebar at `expandedWidth`
 *  - desktop collapsed → inline icon rail at `railWidth` (parent toggles `collapsed`)
 *  - mobile            → sidebar hidden; a hamburger (or edge-swipe) opens it as a
 *                        slide-over drawer; swipe left to close
 *
 * The sidebar subtree is wrapped in a SidebarChromeProvider so its items render
 * icon-only + tooltip when railed and close the drawer on selection (mobile).
 */
export function SplitView({
  sidebar,
  children,
  collapsed = false,
  mobileTitle,
  expandedWidth = 200,
  railWidth = 56,
  className,
}: SplitViewProps) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const railed = collapsed && !isMobile;

  // Never leave a drawer open when we transition back to desktop.
  React.useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  const closeDrawer = React.useCallback(() => setDrawerOpen(false), []);
  const chrome = { collapsed: railed, isMobile, closeDrawer };

  // Touch swipe: edge-swipe right opens the drawer, swipe left closes it.
  const touchStart = React.useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onSwipeEnd = (act: (dx: number) => void) => (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) act(dx);
  };

  if (isMobile) {
    return (
      <div className={cn("flex flex-col h-full w-full overflow-hidden", className)}>
        {/* Top bar — pads past the status bar so the hamburger stays reachable in
            standalone (added-to-homescreen) mode where the page extends to the top. */}
        <div className="shrink-0 border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
          <div className="flex items-center gap-2 h-11 px-2">
            <Button variant="transparent" size="small" iconOnly aria-label="Open navigation" onClick={() => setDrawerOpen(true)}>
              <MenuIcon className="size-5 text-fg-muted" />
            </Button>
            {mobileTitle && <span className="text-[14px] font-semibold text-fg truncate">{mobileTitle}</span>}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

        {/* Left-edge swipe target to open the drawer (only while closed). */}
        {!drawerOpen && (
          <div
            className="fixed left-0 top-0 z-30 h-full w-4"
            onTouchStart={onTouchStart}
            onTouchEnd={onSwipeEnd((dx) => { if (dx > 0) setDrawerOpen(true); })}
          />
        )}

        <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogPrimitive.Portal>
            <DialogOverlay />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              onTouchStart={onTouchStart}
              onTouchEnd={onSwipeEnd((dx) => { if (dx < 0) closeDrawer(); })}
              className="fixed left-0 top-0 z-50 flex h-full w-64 max-w-[82vw] flex-col overflow-hidden bg-surface pt-[env(safe-area-inset-top)] shadow-xl focus:outline-none"
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
        className="shrink-0 h-full overflow-hidden transition-[width] duration-150"
        style={{ width: `${railed ? railWidth : expandedWidth}px` }}
      >
        <SidebarChromeProvider value={chrome}>{sidebar}</SidebarChromeProvider>
      </div>
      <div className="flex-1 min-w-0 h-full overflow-hidden">{children}</div>
    </div>
  );
}
