import { useEffect, useRef, type ReactNode } from "react";

// Shared PCO plan rundown table. Both the "script" View-kind (ScriptView on a
// display) and the standalone ScriptView pages render through this so column
// behavior, section-header rows, live-item highlight, and auto-scroll live in
// one place. Callers supply the column spec; this owns the row structure.

/** SERVICE START / END headers get a stronger band than ordinary section rows.
 *  Mirrors the server-side detection in pco-service (kept loose on purpose). */
export function rundownHeaderKind(title: string): "start" | "end" | null {
  const t = title.trim().toUpperCase();
  if (/\bSERVICE\s+(START|BEGIN)\b|\bSTART OF SERVICE\b/.test(t)) return "start";
  if (/\bSERVICE\s+(END|DISMISS)\b|\bEND OF SERVICE\b/.test(t)) return "end";
  return null;
}

// Department → accent hue for row tinting. Keyword-matched (categories are named
// freely per org) with a neutral-blue fallback, in our palette — subtler than
// ScriptViewer's saturated fills.
export function departmentColor(dept: string): string {
  const d = dept.toLowerCase();
  if (d.includes("light")) return "#f59e0b";
  if (d.includes("video") || d.includes("graphic") || d.includes("pro") || d.includes("screen")) return "#22c55e";
  if (d.includes("audio") || d.includes("sound") || d.includes("foh")) return "#38bdf8";
  if (d.includes("vocal") || d.includes("band") || d.includes("music") || d.includes("md") || d.includes("key") || d.includes("drum")) return "#a78bfa";
  if (d.includes("stage") || d.includes("cam") || d.includes("director")) return "#ec4899";
  return "#5b9cff";
}

export interface RundownColumn {
  key: string;
  header: string;
  align?: "left" | "right";
  /** CSS width (e.g. "4rem"). */
  width?: string;
  headerClassName?: string;
  cellClassName?: string;
  render: (item: PlanItemDTO, ctx: { isCurrent: boolean }) => ReactNode;
}

export function RundownTable({
  items,
  columns,
  currentItemId,
  accentDepartment,
  footer,
  autoScroll = true,
  textSizeClass = "text-[clamp(0.8rem,1.6vmin,1.1rem)]",
}: {
  items: PlanItemDTO[];
  columns: RundownColumn[];
  currentItemId?: string | null;
  /** Tint a row when this note category has content for the item (department focus). */
  accentDepartment?: string | null;
  /** Optional sticky bottom band (e.g. total time), spanning all columns. */
  footer?: import("react").ReactNode;
  autoScroll?: boolean;
  textSizeClass?: string;
}) {
  const accentColor = accentDepartment ? departmentColor(accentDepartment) : null;
  const currentRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (autoScroll) currentRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentItemId, autoScroll]);

  return (
    <table className={`w-full border-collapse ${textSizeClass}`}>
      <thead className="sticky top-0 z-10 bg-[#14161c] text-white/45">
        <tr className="text-left">
          {columns.map((c) => (
            <th
              key={c.key}
              className={`px-3 py-2 font-medium ${c.align === "right" ? "text-right" : ""} ${c.headerClassName ?? ""}`}
              style={c.width ? { width: c.width } : undefined}
            >
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((it) => {
          if (it.itemType === "header") {
            const kind = rundownHeaderKind(it.title);
            return (
              <tr key={it.id} className={kind ? "bg-white/[0.1]" : "bg-white/[0.06]"}>
                <td
                  colSpan={columns.length}
                  className={`px-3 py-1.5 text-caption1 font-semibold uppercase tracking-wider ${kind ? "text-white/85" : "text-white/70"}`}
                >
                  {it.title}
                </td>
              </tr>
            );
          }
          const isCurrent = currentItemId != null && currentItemId === it.id;
          // Row tint when the accent department has content here (not while the
          // live-item highlight already owns the row).
          const accentActive = !!accentColor && !isCurrent && !!accentDepartment && !!it.notesByCategory[accentDepartment]?.trim();
          return (
            <tr
              key={it.id}
              ref={isCurrent ? currentRef : undefined}
              className={`border-b border-white/5 align-top ${isCurrent ? "bg-[#2dd49618]" : ""}`}
              style={accentActive ? { backgroundColor: `${accentColor}1f`, boxShadow: `inset 3px 0 0 0 ${accentColor}` } : undefined}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-3 py-2 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.cellClassName ?? ""}`}
                >
                  {c.render(it, { isCurrent })}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
      {footer != null && (
        <tfoot className="sticky bottom-0 z-10 bg-[#14161c]">
          <tr>
            <td colSpan={columns.length} className="px-3 py-2 border-t border-white/10 text-caption1 font-semibold uppercase tracking-wider text-white/70">
              {footer}
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
