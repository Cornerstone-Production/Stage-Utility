import * as React from "react";

import { cn } from "../../lib/cn";

// Native-<select> implementation of the app's dropdown, behind the same compound
// API the app already uses (Select / SelectTrigger / SelectValue / SelectContent /
// SelectItem / SelectGroup / SelectLabel). The OS renders the open list (native
// picker, per product decision); the closed control keeps the app's field styling.
//
// The sub-components render nothing — they're markers whose props `Select` reads
// from the element tree to build <option>/<optgroup>. This lets every existing
// call site convert to native without edits.

interface ItemProps {
  value: string;
  children?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}
export function SelectItem(_props: ItemProps): React.ReactNode {
  return null;
}
export function SelectGroup(_props: { children?: React.ReactNode; className?: string }): React.ReactNode {
  return null;
}
export function SelectLabel(_props: { children?: React.ReactNode; className?: string }): React.ReactNode {
  return null;
}
export function SelectContent(_props: { children?: React.ReactNode; className?: string; position?: string }): React.ReactNode {
  return null;
}
export function SelectValue(_props: { placeholder?: React.ReactNode; className?: string }): React.ReactNode {
  return null;
}
export function SelectTrigger(_props: { children?: React.ReactNode; className?: string; [k: string]: unknown }): React.ReactNode {
  return null;
}

/** Flatten a React node to plain text — native <option>s can only show text. */
function textOf(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children);
  return "";
}

// Does the caller already supply an empty-valued item? If so the placeholder
// option is skipped, or the list opens with two blank rows. Traversed the same
// way the options themselves are, but as a pure predicate — the option builder is
// a reusable closure, so counting from inside it would mutate render scope.
function hasEmptyItem(node: React.ReactNode): boolean {
  return React.Children.toArray(node).some((child) => {
    if (!React.isValidElement(child)) return false;
    if (child.type === SelectItem) return (child.props as ItemProps).value === "";
    const kids = (child.props as { children?: React.ReactNode })?.children;
    return kids != null ? hasEmptyItem(kids) : false;
  });
}

// Field styling for the closed control; the OS renders the arrow + open list
// (native picker), matching the patch sheet's native <select>s. Call-site trigger
// classes (widths etc.) apply directly to the <select> — no wrapper needed.
//
// NB: this renders a NATIVE <select>, so arbitrary children of <SelectTrigger> are
// dropped — only <SelectValue placeholder> survives, as a leading empty <option>.
// A trigger built from an icon + text renders as nothing, and the browser then shows
// the first real option, which reads as a selected value rather than a prompt.
const BASE =
  "h-7 max-w-full rounded-md border border-line-strong bg-field px-2.5 py-1 " +
  "text-footnote text-fg focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export function Select({
  value,
  defaultValue,
  onValueChange,
  disabled,
  name,
  required,
  children,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  name?: string;
  required?: boolean;
  children?: React.ReactNode;
}) {
  let triggerClassName: string | undefined;
  let ariaLabel: string | undefined;
  let placeholder: React.ReactNode = null;
  let contentChildren: React.ReactNode = null;

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === SelectTrigger) {
      const p = child.props as { className?: string; "aria-label"?: string; children?: React.ReactNode };
      triggerClassName = p.className;
      ariaLabel = p["aria-label"];
      React.Children.forEach(p.children, (t) => {
        if (React.isValidElement(t) && t.type === SelectValue) placeholder = (t.props as { placeholder?: React.ReactNode }).placeholder;
      });
    } else if (child.type === SelectContent) {
      contentChildren = (child.props as { children?: React.ReactNode }).children;
    }
  });

  const toOptions = (node: React.ReactNode): React.ReactNode =>
    React.Children.map(node, (child) => {
      if (!React.isValidElement(child)) return null;
      if (child.type === SelectItem) {
        const p = child.props as ItemProps;
        return (
          <option value={p.value} disabled={p.disabled}>
            {textOf(p.children)}
          </option>
        );
      }
      if (child.type === SelectGroup) {
        let label = "";
        const items: React.ReactNode[] = [];
        React.Children.forEach((child.props as { children?: React.ReactNode }).children, (g) => {
          if (!React.isValidElement(g)) return;
          if (g.type === SelectLabel) label = textOf((g.props as { children?: React.ReactNode }).children);
          else items.push(g);
        });
        return <optgroup label={label}>{toOptions(items)}</optgroup>;
      }
      // Fragments / nested arrays (e.g. .map(...) results).
      const kids = (child.props as { children?: React.ReactNode })?.children;
      return kids != null ? toOptions(kids) : null;
    });

  const options = toOptions(contentChildren);
  const hasEmpty = hasEmptyItem(contentChildren);

  return (
    <select
      value={value}
      defaultValue={value === undefined ? defaultValue : undefined}
      onChange={(e) => onValueChange?.(e.target.value)}
      disabled={disabled}
      name={name}
      required={required}
      aria-label={ariaLabel}
      className={cn(BASE, triggerClassName)}
    >
      {placeholder != null && !hasEmpty && <option value="">{textOf(placeholder)}</option>}
      {options}
    </select>
  );
}
