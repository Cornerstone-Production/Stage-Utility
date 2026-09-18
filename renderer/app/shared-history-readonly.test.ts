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

  it("readOnly actually hides the destructive controls", async () => {
    // RENDERED, not scanned. This used to count `{!readOnly &&` in
    // service-history-section.tsx and assert a FLOOR of three — a source-text
    // check with slack, which went red the moment the service page's actions
    // moved into their own component without one of them changing behaviour.
    // A floor with slack is also green when two of the three gates go away.
    //
    // The header is where Edit times, Merge, Rebuild from raw and Delete live,
    // so the page the shared link resolves to is asked directly what it offers.
    const { installDom } = await import("../test-dom.js");
    const teardown = installDom();
    try {
      const { render, cleanup } = await import("@testing-library/react");
      const React = (await import("react")).default;
      const { TooltipProvider } = await import("../components/ui/index.js");
      const { ServiceHeader } = await import("../settings/sections/history-service-header.js");
      const view = render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(ServiceHeader, {
            timeline: {
              serviceKey: "k",
              planTitle: "Evening",
              serviceDate: "2026-09-17",
              serviceTimeStartsAt: null,
              startedAt: "2026-09-17T20:15:00.000Z",
              endedAt: "2026-09-17T21:45:00.000Z",
              items: [],
            } as unknown as ServiceTimeline,
            attendance: null,
            spl: null,
            readOnly: true,
            meta: "Evening",
            onBack: () => {},
            onEditTimes: () => {},
            onCopyReport: () => {},
            onMerge: () => {},
            onRebuild: () => {},
            onDelete: () => {},
            onResetPacing: () => {},
          }),
        ),
      );
      const labels = [...view.container.querySelectorAll('[data-testid="history-actions"] button')]
        .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
      assert.deepEqual(
        labels,
        ["Copy report"],
        "the shared link must offer nothing that changes or deletes a recording",
      );
      cleanup();
    } finally {
      teardown();
    }
  });

  it("the day list's Delete stays gated too", () => {
    // The other destructive control on the page, and the one the header does
    // not own: one Delete per day-list row, in each of the two row shapes (a
    // normal recording and an attendance-only arrival ramp). An EXACT count,
    // not a floor — a floor is how a gate goes missing with the suite green.
    const section = readFileSync(
      new URL("../settings/sections/service-history-section.tsx", import.meta.url),
      "utf8",
    );
    assert.equal(
      [...section.matchAll(/\{!readOnly &&/g)].length,
      2,
      "the two day-list Delete buttons must each be gated on readOnly",
    );
  });
});
