import { cn } from "../../lib/cn";

/**
 * A device's color as a small square: beside a hop, a rack's name, a device in
 * the list. A device with no color gets the faint neutral.
 *
 * The color is also set as `--dot`, which is how the print stylesheet keeps it:
 * it forces every background white, and gives `.patch-dot` back its own.
 */
export function DeviceDot({ color, className }: { color: string | undefined; className?: string }) {
  return (
    <i
      className={cn("patch-dot shrink-0 rounded-[3px]", className)}
      style={{ ...(color ? { "--dot": color } : {}), background: "var(--dot, var(--color-fg-faint))" } as React.CSSProperties}
    />
  );
}
