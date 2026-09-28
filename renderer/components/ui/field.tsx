import * as React from "react";
import { cn } from "../../lib/cn";

// ── FieldSet ──────────────────────────────────────────────────────────────────

interface FieldSetProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Render without the card material — for a FieldSet nested inside another
   *  card (e.g. an integration row), so we never stack cards within cards. */
  flat?: boolean;
}

export function FieldSet({ className, flat, children, ...props }: FieldSetProps) {
  return (
    <div
      className={cn(
        "overflow-hidden",
        flat ? "" : "rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

// ── FieldGroup ────────────────────────────────────────────────────────────────

interface FieldGroupProps extends React.HTMLAttributes<HTMLDivElement> {}

export function FieldGroup({ className, children, ...props }: FieldGroupProps) {
  return (
    <div className={cn("divide-y divide-gray-a4", className)} {...props}>
      {children}
    </div>
  );
}

// ── Field ─────────────────────────────────────────────────────────────────────

interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
}

export function Field({ className, orientation = "horizontal", children, ...props }: FieldProps) {
  return (
    <div
      className={cn(
        "flex px-4 py-3 bg-transparent",
        // Horizontal fields stack (label above control) on phones, go side-by-side at ≥sm.
        orientation === "horizontal" && "flex-col items-stretch gap-1.5 sm:flex-row sm:items-center sm:gap-3",
        orientation === "vertical" && "flex-col gap-1.5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

// ── FieldContent ──────────────────────────────────────────────────────────────

interface FieldContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export function FieldContent({ className, children, ...props }: FieldContentProps) {
  return (
    <div className={cn("flex flex-col flex-1 min-w-0", className)} {...props}>
      {children}
    </div>
  );
}

// ── FieldLabel ────────────────────────────────────────────────────────────────

interface FieldLabelProps extends React.HTMLAttributes<HTMLSpanElement> {}

export function FieldLabel({ className, children, ...props }: FieldLabelProps) {
  return (
    <span className={cn("text-footnote font-medium text-fg leading-tight", className)} {...props}>
      {children}
    </span>
  );
}

// ── FieldDescription ──────────────────────────────────────────────────────────

interface FieldDescriptionProps extends React.HTMLAttributes<HTMLSpanElement> {}

export function FieldDescription({ className, children, ...props }: FieldDescriptionProps) {
  return (
    <span className={cn("text-caption2 text-fg-subtle leading-tight mt-0.5", className)} {...props}>
      {children}
    </span>
  );
}

// ── StackedField ──────────────────────────────────────────────────────────────

interface StackedFieldProps {
  label: string;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/**
 * The label above its control, the control at full width, and the description
 * in full under it. For a narrow pane — the Video feeds editor, the layout
 * inspector — where a label-left row squeezes the label, the control or the
 * description into a column too narrow to read.
 */
export function StackedField({ label, description, className, children }: StackedFieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {description && <FieldDescription className="mt-0">{description}</FieldDescription>}
    </div>
  );
}
