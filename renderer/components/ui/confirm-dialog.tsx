// Confirm dialog — module-level store + a promise-based `confirm()` that
// replaces the native window.confirm. Usage:
//   if (await confirm({ title: "Delete recording?", destructive: true })) { ... }
// A single <ConfirmHost /> is mounted next to <Toaster /> in each entrypoint.
//
// A dialog that has to ask one more thing (remove the screen, and ALSO delete its
// view?) takes a `checkbox` and is read with confirmWith(), which answers both the
// button and the box. confirm() is confirmWith() reduced to the button, so there is
// one dialog and one store.

import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";
import { useResyncOn } from "../../lib/use-resync-on";
import { Button } from "./button";
import { Checkbox } from "./checkbox";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button red and treat it as a dangerous action. */
  destructive?: boolean;
  /** A line set off under the message: who else the action touches. */
  note?: string;
  /** One more question, answered with the dialog. Read it with confirmWith(). */
  checkbox?: {
    label: string;
    detail?: string;
    defaultChecked?: boolean;
    /** The confirm button's label while the box is ticked. */
    confirmLabel?: string;
  };
}

/** What the operator answered: the button, and the box if there was one. */
export interface ConfirmResult {
  ok: boolean;
  /** Always false for a dialog with no checkbox, and for a dismissal. */
  checked: boolean;
}

interface ConfirmState extends ConfirmOptions {
  id: number;
  resolve: (result: ConfirmResult) => void;
}

let _state: ConfirmState | null = null;
let _listeners: Array<(s: ConfirmState | null) => void> = [];
let _nextId = 1;

function notify() {
  for (const l of _listeners) l(_state);
}

/** Open the confirm dialog; resolves the button and the checkbox. */
export function confirmWith(opts: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    _state = { ...opts, id: _nextId++, resolve };
    notify();
  });
}

/** Open the confirm dialog; resolves true on confirm, false on cancel/dismiss. */
export async function confirm(opts: ConfirmOptions): Promise<boolean> {
  return (await confirmWith(opts)).ok;
}

function settle(ok: boolean, checked = false) {
  // Guard so the close-after-confirm onOpenChange doesn't double-resolve.
  if (_state) _state.resolve({ ok, checked: ok && checked });
  _state = null;
  notify();
}

export function ConfirmHost() {
  const [state, setState] = React.useState<ConfirmState | null>(null);
  // Per dialog, not per host: the next one starts from its own default.
  const [checked, setChecked] = React.useState(false);
  useResyncOn([state?.id], () => setChecked(state?.checkbox?.defaultChecked ?? false));
  React.useEffect(() => {
    _listeners.push(setState);
    return () => {
      _listeners = _listeners.filter((l) => l !== setState);
    };
  }, []);

  return (
    <AlertDialogPrimitive.Root open={state !== null} onOpenChange={(o) => { if (!o) settle(false); }}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <AlertDialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-full max-w-sm rounded-xl border border-line-strong bg-bg p-6 shadow-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          <AlertDialogPrimitive.Title className="text-subheadline font-semibold text-fg mb-1">
            {state?.title}
          </AlertDialogPrimitive.Title>
          {state?.message && (
            <AlertDialogPrimitive.Description className="text-caption1 text-fg-subtle mb-4 whitespace-pre-line">
              {state.message}
            </AlertDialogPrimitive.Description>
          )}
          {state?.note && (
            <p className="mb-3 border-l-2 border-line-strong pl-2.5 text-caption1 text-fg-muted">{state.note}</p>
          )}
          {state?.checkbox && (
            <label
              className={cn(
                "mb-3 mt-1 flex cursor-pointer items-start gap-2.5 rounded-[10px] border p-2.5",
                checked ? "border-danger-9/45 bg-danger-9/8" : "border-line-strong",
              )}
            >
              <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-footnote font-semibold text-fg">{state.checkbox.label}</span>
                {state.checkbox.detail && <span className="block text-caption1 text-fg-muted">{state.checkbox.detail}</span>}
              </span>
            </label>
          )}
          <div className="flex items-center justify-end gap-2 mt-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="transparent" size="small">{state?.cancelLabel ?? "Cancel"}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button
                variant="accent"
                size="small"
                className={state?.destructive ? "bg-red-9 hover:bg-red-10 active:bg-red-11" : undefined}
                onClick={() => settle(true, checked)}
              >
                {(checked && state?.checkbox?.confirmLabel) || state?.confirmLabel || "Confirm"}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
