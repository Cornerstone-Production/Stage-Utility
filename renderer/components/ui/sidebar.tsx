import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";

// ── Chrome context ────────────────────────────────────────────────────────────
// Carries the responsive shell state down to items: whether the sidebar is a
// collapsed icon rail, whether we're on a mobile drawer, and how to close the
// drawer after a selection. Provided by SplitView (which owns the responsive
// layout) so items render icon-only + tooltip when railed.

interface SidebarChromeValue {
  collapsed: boolean;
  isMobile: boolean;
  closeDrawer?: () => void;
}

const SidebarChromeContext = React.createContext<SidebarChromeValue>({
  collapsed: false,
  isMobile: false,
});

export function SidebarChromeProvider({
  value,
  children,
}: {
  value: SidebarChromeValue;
  children: React.ReactNode;
}) {
  return <SidebarChromeContext value={value}>{children}</SidebarChromeContext>;
}

/**
 * The chrome state SplitView decided on: whether this is the collapsed icon rail
 * and whether we are on mobile.
 *
 * Sidebar content needs it to render its own footer — a collapse control and a
 * width handle only make sense inline, never in the mobile drawer. Recomputing
 * it from a media query instead would let the two disagree, which is how a
 * drawer ends up rendering as an icon rail.
 */
export function useSidebarChrome(): SidebarChromeValue {
  return React.use(SidebarChromeContext);
}

// ── Context ───────────────────────────────────────────────────────────────────

interface SidebarListContextValue {
  selectedItem: unknown;
  onSelectedItemChange: (item: unknown) => void;
  getItemKey: (item: unknown) => string;
}

const SidebarListContext = React.createContext<SidebarListContextValue | null>(null);

// ── Sidebar ───────────────────────────────────────────────────────────────────

interface SidebarProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Sidebar({ className, children, ...props }: SidebarProps) {
  return (
    <div
      className={cn("flex flex-col h-full bg-rail", className)}
      {...props}
    >
      {children}
    </div>
  );
}

// ── SidebarList ───────────────────────────────────────────────────────────────
//
// Props-based API:
//   <SidebarList
//     items={SECTIONS}
//     selectedItem={activeSection}
//     onSelectedItemChange={setActiveSection}
//     getItemKey={(s) => s.id}
//   >
//     {SECTIONS.map((s) => <SidebarListItem key={s.id} item={s} title={s.label} icon={s.icon} />)}
//   </SidebarList>

interface SidebarListProps<T = unknown> {
  items?: T[];
  selectedItem?: T;
  onSelectedItemChange?: (item: T) => void;
  getItemKey?: (item: T) => string;
  className?: string;
  children?: React.ReactNode;
}

export function SidebarList<T = unknown>({
  items: _items,
  selectedItem,
  onSelectedItemChange,
  getItemKey,
  className,
  children,
}: SidebarListProps<T>) {
  const contextValue: SidebarListContextValue = {
    selectedItem,
    onSelectedItemChange: onSelectedItemChange as ((item: unknown) => void) | undefined ?? (() => {}),
    getItemKey: getItemKey as ((item: unknown) => string) | undefined ?? (() => ""),
  };

  return (
    <SidebarListContext value={contextValue}>
      <div className={cn("flex flex-col gap-0.5 p-2", className)}>
        {children}
      </div>
    </SidebarListContext>
  );
}

// ── SidebarGroupLabel ─────────────────────────────────────────────────────────
// A quiet uppercase heading that clusters nav items (Content / Output / …).
// In the collapsed icon rail it degrades to a thin divider.

export function SidebarGroupLabel({ children }: { children: React.ReactNode }) {
  const chrome = React.use(SidebarChromeContext);
  if (chrome.collapsed && !chrome.isMobile) {
    return <div className="mx-2 my-1.5 h-px bg-line" aria-hidden="true" />;
  }
  return (
    <div className="px-2.5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle select-none first:pt-1">
      {children}
    </div>
  );
}

// ── SidebarListItem ───────────────────────────────────────────────────────────
//
// API:
//   <SidebarListItem item={section} icon={section.icon} title={section.label} />
//
// Active state is derived by comparing item reference (or key if getItemKey provided)
// against the selectedItem in context.

interface SidebarListItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** The item this row represents — compared against SidebarList's selectedItem. */
  item?: unknown;
  /** Icon rendered left of the label. */
  icon?: React.ReactNode;
  /** Label text. */
  title?: string;
  /** Label text (alternative to title). */
  label?: string;
  /** Override active state (bypasses context). */
  isActive?: boolean;
}

export function SidebarListItem({
  item,
  icon,
  title,
  label,
  isActive: isActiveProp,
  className,
  onClick,
  children,
  ...props
}: SidebarListItemProps) {
  const ctx = React.use(SidebarListContext);
  const chrome = React.use(SidebarChromeContext);
  const railed = chrome.collapsed && !chrome.isMobile;

  const isActive = isActiveProp ?? (() => {
    if (!ctx || item === undefined) return false;
    if (ctx.getItemKey && ctx.selectedItem !== undefined) {
      try {
        return ctx.getItemKey(item) === ctx.getItemKey(ctx.selectedItem);
      } catch {
        return item === ctx.selectedItem;
      }
    }
    return item === ctx.selectedItem;
  })();

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (ctx && item !== undefined) {
      ctx.onSelectedItemChange(item);
    }
    onClick?.(e);
    chrome.closeDrawer?.();
  }

  const displayLabel = title ?? label;

  const button = (
    <button
      type="button"
      className={cn(
        "flex items-center gap-2.5 w-full rounded-lg px-2.5 py-2 text-left",
        "text-[13.5px] font-medium transition-colors",
        railed && "justify-center px-0",
        isActive
          ? "bg-accent/12 text-fg"
          : "text-fg-muted hover:bg-fill hover:text-fg",
        className,
      )}
      aria-current={isActive ? "page" : undefined}
      aria-label={railed ? displayLabel : undefined}
      onClick={handleClick}
      {...props}
    >
      {icon && (
        <span className={cn("size-4 shrink-0", isActive ? "text-accent" : "text-fg-subtle")}>
          {icon}
        </span>
      )}
      {displayLabel && <span className={cn("truncate", railed && "sr-only")}>{displayLabel}</span>}
      {children}
    </button>
  );

  // In the collapsed rail, show the label as a hover tooltip instead.
  if (railed && displayLabel) {
    return (
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{button}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="right"
            sideOffset={8}
            className="z-50 select-none rounded-md bg-gray-12 px-2 py-1 text-caption1 font-medium text-gray-1 shadow-md"
          >
            {displayLabel}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    );
  }

  return button;
}
