import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * A short note under a control or a card's preview: neutral, or warm (`tone="warn"`)
 * when something is wrong but nothing is broken (a delayed picture, a struggling
 * screen, audio that cannot be heard). The warn classes are the app's one
 * "warning box"; every warning of that kind is drawn with this.
 */
export function Callout({
  tone = "neutral",
  children,
  className,
  ...rest
}: { tone?: "neutral" | "warn"; children: ReactNode; className?: string } & Omit<React.HTMLAttributes<HTMLParagraphElement>, "className" | "children">) {
  return (
    <p
      {...rest}
      className={cn("rounded-lg px-2.5 py-2 text-caption1", tone === "warn" ? "bg-warn-9/14 text-warn-11" : "bg-fill text-fg-muted", className)}
    >
      {children}
    </p>
  );
}
