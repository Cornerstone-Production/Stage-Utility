import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "../components/ui/tooltip-provider";
import { Toaster } from "../components/ui/toast";
import { router, queryClient } from "./router";
import "../styles.css";

// Auto-hide the mouse cursor on the kiosk after a few seconds idle — Raspberry
// Pi displays otherwise leave a stray pointer parked on screen. Any mouse
// movement brings it back, so a plugged-in mouse still works. Scoped to this
// (kiosk) entry only; the settings window keeps its normal cursor.
(() => {
  const style = document.createElement("style");
  style.textContent = "body.cursor-idle, body.cursor-idle * { cursor: none !important; }";
  document.head.appendChild(style);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => document.body.classList.add("cursor-idle");
  const wake = () => {
    document.body.classList.remove("cursor-idle");
    clearTimeout(timer);
    timer = setTimeout(hide, 3000);
  };
  window.addEventListener("mousemove", wake, { passive: true });
  window.addEventListener("mousedown", wake, { passive: true });
  wake(); // start idle countdown so a stray cursor hides shortly after load
})();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
