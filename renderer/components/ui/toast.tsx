// Toast system — module-level store + Radix UI Toast renderer.
// Usage: toast.success("msg")  /  toast.error("msg")
//        toast.info("msg", { action: { label: "Undo", onSelect } })

import * as React from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";
import { XIcon, CheckCircle2Icon, XCircleIcon } from "lucide-react";

// ── Store ─────────────────────────────────────────────────────────────────────

/** One button on a toast, such as Undo. Pressing it also closes the toast. */
interface ToastAction {
  label: string;
  onSelect: () => void;
}

interface ToastEntry {
  id: string;
  type: "success" | "error" | "info";
  message: string;
  action?: ToastAction;
}

type Listener = (toasts: ToastEntry[]) => void;

/** How long a toast is shown. One that carries a button is given time to be read
 *  and reached for. */
const SHOW_MS = 4000;
const SHOW_WITH_ACTION_MS = 8000;
/** The most toasts the store holds. The visible ones leave it when Radix closes
 *  them; this only keeps a store that no Toaster is mounted to show from growing. */
const MAX_HELD = 8;

let _toasts: ToastEntry[] = [];
let _listeners: Listener[] = [];
let _nextId = 1;

function notify() {
  for (const l of _listeners) l([..._toasts]);
}

function addToast(type: ToastEntry["type"], message: string, opts?: { action?: ToastAction }) {
  const id = String(_nextId++);
  _toasts = [..._toasts, { id, type, message, action: opts?.action }].slice(-MAX_HELD);
  notify();
  // No timer of our own: the countdown is Radix's (the `duration` on the Root
  // below), which stops while the pointer is over the toasts or focus is in them.
  // A timer here ran on regardless and took an Undo out from under the pointer.
}

function removeToast(id: string) {
  _toasts = _toasts.filter((t) => t.id !== id);
  notify();
}

export const toast = {
  success: (message: string) => addToast("success", message),
  error: (message: string) => addToast("error", message),
  info: (message: string, opts?: { action?: ToastAction }) => addToast("info", message, opts),
};

// ── Toaster component ─────────────────────────────────────────────────────────

export function Toaster() {
  const [toasts, setToasts] = React.useState<ToastEntry[]>([]);

  React.useEffect(() => {
    _listeners.push(setToasts);
    return () => {
      _listeners = _listeners.filter((l) => l !== setToasts);
    };
  }, []);

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((t) => (
        <ToastPrimitive.Root
          key={t.id}
          open
          duration={t.action ? SHOW_WITH_ACTION_MS : SHOW_MS}
          onOpenChange={(open) => {
            if (!open) removeToast(t.id);
          }}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-4 py-3 shadow-lg",
            "bg-popover border-line-strong text-fg backdrop-blur-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-bottom-full",
            "data-[state=closed]:fade-out-80",
          )}
        >
          {t.type === "success" && (
            <CheckCircle2Icon className="size-4 shrink-0 text-green-10" />
          )}
          {t.type === "error" && (
            <XCircleIcon className="size-4 shrink-0 text-red-10" />
          )}
          <ToastPrimitive.Description className="flex-1 text-footnote">
            {t.message}
          </ToastPrimitive.Description>
          {t.action && (
            <ToastPrimitive.Action altText={t.action.label} asChild>
              <button
                type="button"
                onClick={t.action.onSelect}
                className="shrink-0 rounded px-1 text-footnote font-semibold text-accent underline hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {t.action.label}
              </button>
            </ToastPrimitive.Action>
          )}
          <ToastPrimitive.Close asChild>
            <button className="touch-target ml-1 rounded p-0.5 text-gray-9 hover:text-fg transition-colors">
              <XIcon className="size-3.5" />
            </button>
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80"
      />
    </ToastPrimitive.Provider>
  );
}
