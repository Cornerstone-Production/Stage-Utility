// Toast system — module-level store + Radix UI Toast renderer.
// Usage: toast.success("msg")  /  toast.error("msg")

import * as React from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";
import { XIcon, CheckCircle2Icon, XCircleIcon } from "lucide-react";

// ── Store ─────────────────────────────────────────────────────────────────────

interface ToastEntry {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

type Listener = (toasts: ToastEntry[]) => void;

let _toasts: ToastEntry[] = [];
let _listeners: Listener[] = [];
let _nextId = 1;

function notify() {
  for (const l of _listeners) l([..._toasts]);
}

function addToast(type: ToastEntry["type"], message: string) {
  const id = String(_nextId++);
  _toasts = [..._toasts, { id, type, message }];
  notify();
  // Auto-dismiss after 4 s
  setTimeout(() => removeToast(id), 4000);
}

function removeToast(id: string) {
  _toasts = _toasts.filter((t) => t.id !== id);
  notify();
}

export const toast = {
  success: (message: string) => addToast("success", message),
  error: (message: string) => addToast("error", message),
  info: (message: string) => addToast("info", message),
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
          onOpenChange={(open) => {
            if (!open) removeToast(t.id);
          }}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-4 py-3 shadow-lg",
            "bg-surface border-line-strong text-fg",
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
          <ToastPrimitive.Description className="flex-1 text-[13px]">
            {t.message}
          </ToastPrimitive.Description>
          <ToastPrimitive.Close asChild>
            <button className="ml-1 rounded p-0.5 text-gray-9 hover:text-fg transition-colors">
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
