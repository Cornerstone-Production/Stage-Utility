// The public page's landing page: the entry landing.html loads. See landing-public-page.tsx
// for what it draws, and docs/ops/servicecue-on-the-web.md#the-landing-page.

import React from "react";
import ReactDOM from "react-dom/client";

import { LandingPublicPage } from "./landing-public-page";
import "../styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <LandingPublicPage />
  </React.StrictMode>,
);
