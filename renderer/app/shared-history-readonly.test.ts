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
import { settle, unmountAndTeardown } from "../test-dom.js";

// Without this React neither act-wraps a render nor warns about an update
// outside act — which is why this file reported no undrained work while
// carrying the crash recorded at `rowControls` below.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    // After installDom, which puts the globals Testing Library reads on load,
    // and before the try, so `cleanup` is in scope for the finally.
    const { render, cleanup } = await import("@testing-library/react");
    try {
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
    } finally {
      await unmountAndTeardown(cleanup, teardown);
    }
  });

  it("the day list carries no recording control on either side of the gate", async () => {
    // A list row is a summary that opens the service page; Delete lives on that
    // page's header (guarded above) and nowhere on the list, matching the
    // mockup. This once counted `{!readOnly &&` in the section's source and
    // asserted the number 2 — a bare count, which cannot tell an add plus a
    // remove from no change, and which says nothing about what actually
    // renders. The list is RENDERED, read-only and not, and the exact set of
    // controls is compared: a Delete that grows back on a row shows up here
    // as a named entry, not as a changed number.
    const { installDom } = await import("../test-dom.js");
    const teardown = installDom();
    // As above: after installDom, before the try.
    const { render, cleanup } = await import("@testing-library/react");
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
      const React = (await import("react")).default;
      const { TooltipProvider } = await import("../components/ui/index.js");
      const { ServiceHistorySection } = await import("../settings/sections/service-history-section.js");

      const rowControls = async (readOnly: boolean) => {
        const view = render(
          React.createElement(TooltipProvider, null, React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly })),
        );
        // Four turns, not one: the list and the attendance list settle first,
        // and only THEN does the selected day's row set kick off its per-row
        // SPL fetches (the rows' peak level is the service page's own figure).
        // One fetch starting another genuinely needs another turn — act drains
        // React's queue, not the network.
        //
        // What act does fix is the other half of the crash this comment used to
        // describe: turns alone left React's passive-effect flush queued, the
        // DOM went away under it, and "window is not defined" failed the file
        // after every test in it had passed. Four MORE turns was the same guess
        // with a bigger number.
        for (let i = 0; i < 4; i++) await settle();
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
        [],
        "a list row must not carry Delete; it lives on the service page header",
      );
      assert.deepEqual(
        await rowControls(true),
        [],
        "the shared link's list must carry nothing that deletes a recording",
      );
    } finally {
      await unmountAndTeardown(cleanup, teardown);
    }
  });

  it("a service's Baptisms card offers no way into the operator app, read-only or not", async () => {
    // docs/display-urls.md's own contract for this link: handed to people
    // outside Production, and "shows nothing else of the app". The card's own
    // "Open in Baptisms" link is real navigation INTO the operator app — the
    // live timer's Start testimonies, Undo, Reset, Rebuild from raw and the
    // Workflow toggle — which the shared page must never offer a way to.
    const { installDom } = await import("../test-dom.js");
    const teardown = installDom();
    const { render, cleanup } = await import("@testing-library/react");
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
      const session = {
        id: "b1",
        startedAt: `${day}T20:45:00.000Z`,
        finishedAt: `${day}T20:52:00.000Z`,
        title: "Evening",
        serviceTypeId: "salt",
        planId: "plan-1",
        serviceKey: rec.serviceKey,
        people: [{ testimonyMs: 120_000, baptizeMs: 60_000 }],
      };
      (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
        const url = String(input);
        const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
        if (url === "/api/service-timeline") return ok([rec]);
        if (url === "/api/attendance/history") return ok([]);
        if (url === "/api/spl/summary") return ok([]);
        if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
        if (url === "/api/baptism/sessions") return ok([session]);
        if (/^\/api\/baptism\/lane\?/.test(url)) return ok({ spans: [] });
        if (/^\/api\/service-timeline\/[^/]+$/.test(url)) return ok(rec);
        if (/^\/api\/attendance\/history\/[^/]+$/.test(url)) return ok(null);
        if (/^\/api\/spl\/history\/[^/]+$/.test(url)) return ok(null);
        return ok(null);
      };
      const React = (await import("react")).default;
      const { TooltipProvider } = await import("../components/ui/index.js");
      const { ServiceHistorySection } = await import("../settings/sections/service-history-section.js");

      const view = render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(ServiceHistorySection as React.ComponentType<{ readOnly: boolean }>, { readOnly: true }),
        ),
      );
      for (let i = 0; i < 4; i++) await settle();
      const row = [...view.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Evening"));
      assert.ok(row, "the service row never rendered");
      row!.click();
      for (let i = 0; i < 4; i++) await settle();

      const card = [...view.container.querySelectorAll("section")].find((s) => s.getAttribute("aria-label") === "Baptisms");
      assert.ok(card, "expected the Baptisms card to render for a linked session even read-only");
      assert.equal(
        view.container.querySelector('a[href="/baptism"]'),
        null,
        "the shared read-only page must not link into the operator app",
      );
      cleanup();
    } finally {
      await unmountAndTeardown(cleanup, teardown);
    }
  });
});
