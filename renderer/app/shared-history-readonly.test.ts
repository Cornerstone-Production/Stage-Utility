// The shared history link never carries destructive controls.
//
// /history is handed to people outside Production: it is tiled on the display
// picker, listed under Connect → Tools, and documented as such in
// docs/display-urls.md. The page that owned it rendered
// `<ServiceHistorySection readOnly />` and said why.
//
// When the settings window was folded into the app, the EDITABLE History tab
// took that URL and the read-only page was deleted. `readOnly` defaults to
// false, so the shared link silently gained Edit times, Merge and Delete, and
// the prop went from "the point of the page" to zero callers anywhere. Nothing
// failed; there was simply no longer a read-only surface.
//
// Asserted on the ROUTING, not on markup: the defect was which component a path
// resolves to and with what prop, and a markup assertion would break on every
// restyle while missing exactly this.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ALL_DESTINATIONS, NESTED_ROUTES } from "./destinations.js";

const DEST = readFileSync(new URL("./destinations.tsx", import.meta.url), "utf8");

describe("the shared /history link", () => {
  it("is a route, and is not one of the rail destinations", () => {
    // A rail destination is the operator's own page. If /history ever becomes
    // one again, it has taken the shared link's URL a second time.
    assert.ok(
      NESTED_ROUTES.some((r) => r.path === "/history"),
      "/history must be routed, or the link handed to volunteers 404s",
    );
    assert.equal(
      ALL_DESTINATIONS.find((d) => d.path === "/history"),
      undefined,
      "/history is the shared read-only link; the operator's page lives elsewhere",
    );
  });

  it("renders the history section with readOnly set", () => {
    // Matches on the JSX prop, which prose in a comment cannot satisfy.
    assert.match(
      DEST,
      /<ServiceHistorySection\s+readOnly\s*\/>/,
      "the component behind /history must pass readOnly, or the shared link " +
        "carries Edit times, Merge and Delete",
    );
  });

  it("the operator still has an editable history page", () => {
    // The other half: read-only must not be achieved by removing the operator's
    // controls from the app entirely. That would be a feature deleted, not fixed.
    const editable = ALL_DESTINATIONS.find((d) => d.path === "/history/manage");
    assert.ok(editable, "the operator's editable history must remain a rail destination");
    assert.equal(editable.label, "History");
  });

  it("readOnly actually hides the destructive controls", () => {
    // The prop being passed is worth nothing if it stopped gating anything.
    const section = readFileSync(
      new URL("../settings/sections/service-history-section.tsx", import.meta.url),
      "utf8",
    );
    const gated = [...section.matchAll(/\{!readOnly &&/g)];
    assert.ok(
      gated.length >= 3,
      `only ${gated.length} controls are gated on readOnly — Edit times, Merge and Delete were`,
    );
  });
});
