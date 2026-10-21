// The public ServiceCue viewer: the entry servicecue.html loads.
//
// ServiceCue as it is in the building, for anyone with the link and no login, served by
// a Cloudflare Worker (publish/servicecue/) that holds what the church's server sent
// out. What it mounts is public-router.tsx's to say; what makes the shared code behave
// as the public page is the `data-servicecue-public` attribute servicecue.html carries
// (renderer/lib/public-mode.ts).

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { TooltipProvider } from "../components/ui/tooltip-provider";
import { createPublicRouter } from "./public-router";
import "../styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// The same defaults the operator app's client has.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const router = createPublicRouter();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
