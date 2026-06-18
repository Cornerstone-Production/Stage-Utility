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

/**
 * Responsive two-panel shell with three states:
 *  - desktop expanded  → inline sidebar at `expandedWidth`
 *  - desktop collapsed → inline icon rail at `railWidth` (parent toggles `collapsed`)
 *  - mobile            → sidebar hidden; a hamburger opens it as a slide-over drawer
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

  if (isMobile) {
    return (
      <div className={cn("flex flex-col h-full w-full overflow-hidden", className)}>
        <div className="flex items-center gap-2 h-11 shrink-0 px-2 border-b border-gray-a4 bg-gray-2">
          <Button variant="transparent" size="small" iconOnly aria-label="Open navigation" onClick={() => setDrawerOpen(true)}>
            <MenuIcon className="size-5 text-gray-11" />
          </Button>
          {mobileTitle && <span className="text-[14px] font-semibold text-gray-12 truncate">{mobileTitle}</span>}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

        <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogPrimitive.Portal>
            <DialogOverlay />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              className="fixed left-0 top-0 z-50 h-full w-64 max-w-[82vw] overflow-hidden shadow-xl focus:outline-none"
            >
              <DialogPrimitive.Title className="sr-only">Settings navigation</DialogPrimitive.Title>
              <SidebarChromeProvider value={chrome}>{sidebar}</SidebarChromeProvider>
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
