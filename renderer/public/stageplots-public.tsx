// The published stage plots page: the entry stageplots.html loads. See
// stageplots-public-page.tsx for what it draws, and docs/features/stageplots.md#publishing.

import React from "react";
import ReactDOM from "react-dom/client";

import { StagePlotsPublicPage } from "./stageplots-public-page";
import "../styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <StagePlotsPublicPage path={window.location.pathname} />
  </React.StrictMode>,
);
