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

  it("the day list's Delete stays gated too", async () => {
    // The other destructive control, and the one the header does not own: a
    // Delete per day-list row. This counted `{!readOnly &&` in the section's
    // source and asserted the number 2 — a bare count, which cannot tell an add
    // plus a remove from no change, and which says nothing about what actually
    // renders. The list is RENDERED, read-only and not, and the exact set of
    // controls is compared.
    const { installDom } = await import("../test-dom.js");
    const teardown = installDom();
    try {
      (globalThis as unknown as { EventSource: unknown }).EventSource = class {
        readyState = 1;
        addEventListener(): void {}
        removeEventListener(): void {}
        close(): void {}
      };
      const day = "2026-09-17";
      const rec = {
        serviceKey: "salt:plan-1:evening",
        serviceTypeId: "salt",
        planId: "plan-1",
        planTitle: "Evening",
        seriesTitle: null,
        serviceDate: day,
        serviceTimeId: "evening",
        serviceTimeStartsAt: `${day}T20:15:00.000Z`,
        startedAt: `${day}T20:15:00.000Z`,
        endedAt: `${day}T21:45:00.000Z`,
        items: [],
      };
      (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
        const url = String(input);
        const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
        if (url === "/api/service-timeline") return ok([rec]);
        if (url === "/api/attendance/history") return ok([]);
        if (url === "/api/spl/summary") return ok([]);
        if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
        if (url === "/api/baptism/sessions") return ok([]);
        return ok(null);
      };
      const { render, cleanup } = await import("@testing-library/react");
      const React = (await import("react")).default;
      const { TooltipProvider } = await import("../components/ui/index.js");
      const { ServiceHistorySection } = await import("../settings/sections/service-history-section.js");

      const rowControls = async (readOnly: boolean) => {
        const view = render(
          React.createElement(TooltipProvider, null, React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly })),
        );
        // Four turns, not two: the list and the attendance list settle first,
        // and only THEN does the selected day's row set kick off its per-row
        // SPL fetches (the rows' peak level is the service page's own figure).
        // Leaving those in flight tore the DOM down under them, and the pending
        // work surfaced as "window is not defined" after the test had passed.
        for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
        const labels = [...view.container.querySelectorAll("button[aria-label]")]
          .map((b) => b.getAttribute("aria-label")!)
          .filter((l) => /recording/i.test(l))
          .sort();
        cleanup();
        return labels;
      };

      // One entry per line, sorted — a list, not a number, so two branches
      // adding different controls conflict instead of merging silently.
      assert.deepEqual(
        await rowControls(false),
        [
          "Delete recording for Evening",
        ],
        "the operator's own list keeps its Delete",
      );
      assert.deepEqual(
        await rowControls(true),
        [],
        "the shared link's list must carry nothing that deletes a recording",
      );
    } finally {
      teardown();
    }
  });
});
