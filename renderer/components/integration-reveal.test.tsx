// A reveal names one integration and opens its settings.
//
// The context bar's "N disconnected" and Getting Started's "Connect Planning
// Center" both call flashTarget(). Before, the card it aimed at was inside a
// collapsed body inside a collapsed group, so two useRevealNonce call sites
// remounted both open first. Nothing on the page collapses now — every card is
// mounted on the first frame — so the nonce has no job and the id opens a
// dialog instead.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, idle, assertAbsent } = await import(
  "../test-fixtures/integrations-harness.js"
);
const flashModule = await import("../app/flash.js");
const { IntegrationsPanel, integrationFlashId } = await import("./integrations-panel.js");
const { GettingStarted } = await import("../settings/getting-started.js");
const { readinessChecks } = await import("../app/home/readiness.js");

let server = installFakeServer();

beforeEach(() => {
  cleanup();
  server.restore();
});

after(async () => {
  cleanup();
  await settle();
  server.restore();
  teardown();
});

/** Two animation frames before flashTarget's first look, then it clears. */
const RESOLVE_MS = 120;

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

async function panel() {
  server = installFakeServer();
  const c = render(withQueryClient(<IntegrationsPanel />));
  await idle();
  return c;
}

describe("a reveal opens the named integration", () => {
  test("flashTarget on a configured integration opens its dialog", async () => {
    await panel();
    flashModule.flashTarget(integrationFlashId("obs"));
    // Long enough for flashTarget's own retry loop to find the card and clear
    // its pending target. Left set, it seeds the NEXT panel this file mounts and
    // opens a dialog nobody asked for — which is the pending-seed path working
    // as designed, and a leak between tests.
    await settle(RESOLVE_MS);
    assert.match(dialog()?.textContent ?? "", /OBS Studio/);
  });

  test("the literal 'pco-credentials' opens Planning Center", async () => {
    // Three call sites hardcode this string rather than deriving it.
    await panel();
    flashModule.flashTarget("pco-credentials");
    await settle(RESOLVE_MS);
    assert.match(dialog()?.textContent ?? "", /Planning Center/);
  });

  test("a not-set-up integration needs no expanding first", async () => {
    // The case the nonce existed for: on a fresh install everything is dormant.
    // Its card is already in the DOM, so the highlight has something to land on
    // and the dialog opens with no reveal step at all.
    const c = await panel();
    const card = c.container.querySelector<HTMLElement>('[data-integration-card="reaper"]');
    assert.ok(card, "the dormant card is not in the DOM before the reveal");
    assert.equal(card.getAttribute("data-flash-id"), integrationFlashId("reaper"));

    flashModule.flashTarget(integrationFlashId("reaper"));
    await settle(RESOLVE_MS);
    assert.match(dialog()?.textContent ?? "", /REAPER/);
  });

  test("an unknown flash id opens nothing and does not throw", async () => {
    await panel();
    flashModule.flashTarget("something-else-entirely");
    await settle();
    assertAbsent(dialog(), "an unknown flash id opened a dialog");
    // flashTarget keeps looking for up to FIND_TIMEOUT_MS before giving up. Let
    // that run out while the DOM still exists: torn down underneath it, its next
    // frame throws "document is not defined" from a callback nothing is awaiting
    // and takes the whole file with it.
    await settle(1400);
  });
});

describe("the three call sites that hardcode 'pco-credentials'", () => {
  test("integrationFlashId derives it for planning-center", () => {
    assert.equal(integrationFlashId("planning-center"), "pco-credentials");
  });

  test("Getting Started's first step navigates with it", () => {
    // Driven, not read: the assertion is on what the button HANDS to onNavigate,
    // so deleting the `flash` line fails here. A source scan would be satisfied
    // by the string appearing in a comment.
    const navigated: [string, string | undefined][] = [];
    const c = render(
      withQueryClient(
        <GettingStarted
          stageState={{ pcoConfigured: false, views: [], outputs: [] } as unknown as StageState}
          onNavigate={(path: string, flash?: string) => navigated.push([path, flash])}
          onDismiss={() => {}}
        />,
      ),
    );
    const step = [...c.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Connect Planning Center"),
    );
    assert.ok(step, "the Connect Planning Center step is gone");
    fireEvent.click(step);
    assert.deepEqual(navigated, [["/settings/integrations", "pco-credentials"]]);
  });

  test("Home's readiness check carries it", () => {
    const pco = readinessChecks(
      { pcoConfigured: false, views: [], outputs: [] } as unknown as StageState,
      [],
    ).find((c) => c.id === "pco");
    assert.ok(pco, "the pco readiness check is gone");
    assert.equal(pco.flash, "pco-credentials");
    assert.equal(pco.route, "/settings/integrations");
  });
});

describe("useRevealNonce is gone", () => {
  test("the module does not export it", () => {
    // Asserted on the module's exports rather than on source text, so a
    // commented-out declaration cannot satisfy it. A dead export invites a new
    // caller, and its whole job was to re-key a collapsed section open.
    assert.equal("useRevealNonce" in flashModule, false);
    assert.equal(typeof flashModule.useRevealTarget, "function");
  });
});
