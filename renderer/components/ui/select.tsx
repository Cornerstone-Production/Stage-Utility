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
//
// A `value` no option carries gets one synthesised for it, so the control shows
// what is stored rather than blanking or substituting a neighbour — see
// `missingValue` in `Select`. Call sites that can name the missing thing (a
// plan's date, a layer's state) still pass their own item for it; this is the
// floor, not a ceiling.

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

// Does the caller supply an item carrying this value? Traversed the same way the
// options themselves are — through SelectGroup and through fragments, so an item
// inside an optgroup or a `.map(...)` counts — but as a pure predicate: the option
// builder is a reusable closure, so counting from inside it would mutate render
// scope.
//
// Asked twice, for two different reasons: with "" to decide whether the caller
// already offers an empty choice (if so the placeholder option is skipped, or the
// list opens with two blank rows), and with the current `value` to decide whether
// that value still has an option to be selected in.
function hasItemWithValue(node: React.ReactNode, value: string): boolean {
  return React.Children.toArray(node).some((child) => {
    if (!React.isValidElement(child)) return false;
    if (child.type === SelectItem) return (child.props as ItemProps).value === value;
    const kids = (child.props as { children?: React.ReactNode })?.children;
    return kids != null ? hasItemWithValue(kids, value) : false;
  });
}

/**
 * Appended to a stored value the option list no longer offers.
 *
 * Wording follows the inspector's PVP layer picker, which reached the same
 * problem first; the MultiSelect equivalent (`pco-options.ts`) says "(not in
 * Planning Center)" because it knows where its list came from. This one does
 * not, so it says only that the value is not in the list it was handed.
 */
export const NOT_OFFERED = "· not found";

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
        // `className` reaches the <option>. Windows and Linux browsers paint an
        // option's own background in the open list, which is the only way a dark
        // kiosk header keeps its list readable — the prop was declared on
        // ItemProps and silently dropped, so a caller that set it got a white
        // list and no error.
        return (
          <option value={p.value} disabled={p.disabled} className={p.className}>
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
  const hasEmpty = hasItemWithValue(contentChildren, "");

  // A stored value with no option to live in.
  //
  // A native <select> cannot show a value that matches no <option>, and it does
  // one of two things instead — measured on this component, and both are what
  // React's `updateOptions` and the HTML "ask for a reset" algorithm specify:
  //
  //   list is EMPTY     → selectedIndex -1, and the trigger is BLANK. This is the
  //                       one the plan switcher and ScriptView comments describe,
  //                       and every settings page passes through it on mount
  //                       while its options are still in flight.
  //   list is NOT empty → the FIRST non-disabled option is selected, so the
  //                       control reads as a real, plausible, wrong value and the
  //                       stored one is gone from the DOM entirely.
  //
  // The second is the worse half: nothing on screen says anything is amiss, and
  // the next save writes the substitute back as though the operator chose it.
  //
  // So the value gets an option of its own, labelled, rather than being dropped:
  // an operator can only decide what to do about a choice they can still see, and
  // the thing it points at may well come back — an integration reconnects, a
  // plan loads, a device is re-added. Losing it because the list is momentarily
  // short would be the worse failure. Display only: it changes nothing the caller
  // stores and fires no onValueChange of its own.
  //
  // NOT disabled. Disabling would grey it out for free, but it would also make
  // the stored value unreachable the moment the operator browsed past it — one
  // stray keystroke and the thing this exists to preserve is gone. The label
  // carries the signal instead; a native <option> takes no styling worth having
  // across browsers anyway.
  //
  // "" is never missing. Many call sites bind value="" deliberately as "unset",
  // either against their own "None" item or against the placeholder option above,
  // and a synthetic "" option would give every one of them a second blank row.
  const missingValue =
    value !== undefined && value !== "" && !hasItemWithValue(contentChildren, value) ? value : null;

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
      {/* The placeholder is NOT selectable. As a plain option it could be
          chosen, and choosing it fired onValueChange("") — which every caller
          treats as a real value. On Screens that sent viewId:"" to the server
          and came back as "outputs:setView — view not found", with no way for
          the operator to tell what they had done wrong.
          `disabled` keeps it visible as a prompt while making it unpickable;
          `hidden` additionally drops it from the open list on most browsers
          once a real value is set. */}
      {placeholder != null && !hasEmpty && (
        <option value="" disabled hidden>
          {textOf(placeholder)}
        </option>
      )}
      {options}
      {/* Last, not first: the list is something to pick FROM, and a value it no
          longer offers is a footnote to it. Same ordering rule `pco-options.ts`
          states for the MultiSelect equivalent, and it leaves the real options
          exactly where the caller put them. */}
      {missingValue !== null && <option value={missingValue}>{`${missingValue} ${NOT_OFFERED}`}</option>}
    </select>
  );
}
