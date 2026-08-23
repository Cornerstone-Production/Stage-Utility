// Confirm dialog — module-level store + a promise-based `confirm()` that
// replaces the native window.confirm. Usage:
//   if (await confirm({ title: "Delete recording?", destructive: true })) { ... }
// A single <ConfirmHost /> is mounted next to <Toaster /> in each entrypoint.

import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";
import { Button } from "./button";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * A THIRD answer, between confirming and cancelling — "Discard", to
   * "Save"/"Stay here".
   *
   * Some questions genuinely have three, and forcing them into two is not a
   * simplification: asked "save before leaving?" with only Save and Cancel,
   * every answer to "I clicked the wrong tab" costs you either the work or the
   * navigation. Absent, the dialog is exactly as it was.
   */
  denyLabel?: string;
  /** Style the confirm button red and treat it as a dangerous action. */
  destructive?: boolean;
}

/** What the operator chose. `cancel` also covers Escape and clicking away. */
export type ConfirmAnswer = "confirm" | "deny" | "cancel";

interface ConfirmState extends ConfirmOptions {
  id: number;
  resolve: (answer: ConfirmAnswer) => void;
}

let _state: ConfirmState | null = null;
let _listeners: Array<(s: ConfirmState | null) => void> = [];
let _nextId = 1;

function notify() {
  for (const l of _listeners) l(_state);
}

/** Open the confirm dialog; resolves true on confirm, false on cancel/dismiss. */
export function confirm(opts: Omit<ConfirmOptions, "denyLabel">): Promise<boolean> {
  return ask(opts).then((answer) => answer === "confirm");
}

/**
 * The same dialog, answering with WHICH button.
 *
 * Separate from `confirm` rather than changing what it returns: every existing
 * caller reads a boolean, and quietly turning that into a string would make
 * `if (await confirm(…))` true for "cancel".
 */
export function ask(opts: ConfirmOptions): Promise<ConfirmAnswer> {
  return new Promise((resolve) => {
    _state = { ...opts, id: _nextId++, resolve };
    notify();
  });
}

function settle(answer: ConfirmAnswer) {
  // Guard so the close-after-confirm onOpenChange doesn't double-resolve.
  if (_state) _state.resolve(answer);
  _state = null;
  notify();
}

export function ConfirmHost() {
  const [state, setState] = React.useState<ConfirmState | null>(null);
  React.useEffect(() => {
    _listeners.push(setState);
    return () => {
      _listeners = _listeners.filter((l) => l !== setState);
    };
  }, []);

  return (
    <AlertDialogPrimitive.Root open={state !== null} onOpenChange={(o) => { if (!o) settle("cancel"); }}>
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
          <div className="flex items-center justify-end gap-2 mt-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="transparent" size="small">{state?.cancelLabel ?? "Cancel"}</Button>
            </AlertDialogPrimitive.Cancel>
            {state?.denyLabel && (
              // Not an Action: Radix's Action closes the dialog itself, and the
              // close would settle as a cancel before this could answer.
              <Button variant="transparent" size="small" onClick={() => settle("deny")}>
                {state.denyLabel}
              </Button>
            )}
            <AlertDialogPrimitive.Action asChild>
              <Button
                variant="accent"
                size="small"
                className={state?.destructive ? "bg-red-9 hover:bg-red-10 active:bg-red-11" : undefined}
                onClick={() => settle("confirm")}
              >
                {state?.confirmLabel ?? "Confirm"}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
