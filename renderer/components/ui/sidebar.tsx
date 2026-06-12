import * as React from "react";
import { cn } from "../../lib/cn";

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
      className={cn("flex flex-col h-full bg-gray-2 border-r border-gray-a4", className)}
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
  }

  const displayLabel = title ?? label;

  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-2 w-full rounded-md px-2.5 py-1.5 text-left",
        "text-[13px] font-medium transition-colors",
        isActive
          ? "bg-blue-9 text-white"
          : "text-gray-11 hover:bg-gray-a3 hover:text-gray-12",
        className,
      )}
      aria-current={isActive ? "page" : undefined}
      onClick={handleClick}
      {...props}
    >
      {icon && (
        <span className={cn("size-3.5 shrink-0", isActive ? "text-white/80" : "text-gray-9")}>
          {icon}
        </span>
      )}
      {displayLabel && <span className="truncate">{displayLabel}</span>}
      {children}
    </button>
  );
}
