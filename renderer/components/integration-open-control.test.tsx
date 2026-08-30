// Who owns "which dialog is open".
//
// The panel holds it itself unless it is told otherwise. The route tells it, so
// the open dialog is URL state — /settings/integrations?integration=obs — and
// the browser's Back button closes the dialog instead of leaving the page,
// which on a wall-mounted console is often the only navigation there is.
//
// The controlled half is what breaks silently: a panel that ignored `open`, or
// kept its own copy alongside it, would look right in every screenshot and
// answer the URL wrongly. So it is driven here, against the real component, with
// the parent as the only source of truth. The URL half itself lives in
// settings/sections/integrations-section.tsx and needs a router; it is verified
// in a browser rather than mocked into a shape that proves nothing.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const React = await import("react");
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, assertAbsent } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { IntegrationsPanel, integrationFlashId } = await import("./integrations-panel.js");

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

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]');

/** Everything the panel has asked its parent to open or close. */
const seen: (string | null)[] = [];

/** A parent that owns `open`, the way the route does. */
function Controlled({ initial }: { initial: string | null }) {
  const [open, setOpen] = React.useState<string | null>(initial);
  return (
    <IntegrationsPanel
      open={open}
      onOpenChange={(next) => {
        seen.push(next);
        setOpen(next);
      }}
    />
  );
}

async function controlled(initial: string | null) {
  server = installFakeServer();
  // Reset here, not in the render body: a render body runs again on every state
  // change, so clearing it there wiped the very call under test.
  seen.length = 0;
  const c = render(withQueryClient(<Controlled initial={initial} />));
  await settle(60);
  return c;
}

describe("the panel opens whatever it is told to", () => {
  test("an id in `open` shows that integration's dialog on the first render", async () => {
    await controlled("obs");
    assert.match(dialog()?.textContent ?? "", /OBS Studio/);
  });

  test("a flash id works too, so a deep link can carry either", async () => {
    await controlled(integrationFlashId("planning-center"));
    assert.match(dialog()?.textContent ?? "", /Planning Center/);
  });

  test("an id nobody owns opens nothing and does not throw", async () => {
    const c = await controlled("not-a-thing");
    assertAbsent(dialog(), "an unknown id opened a dialog");
    assert.equal(c.container.querySelectorAll("[data-integration-card]").length, 16);
  });

  test("null opens nothing", async () => {
    const c = await controlled(null);
    assertAbsent(dialog(), "a null open value opened a dialog");
    assert.equal(c.container.querySelectorAll("[data-integration-card]").length, 16);
  });

  test("clicking a card reports the id up rather than opening on its own", async () => {
    const c = await controlled(null);
    fireEvent.click(c.container.querySelector<HTMLElement>('[data-integration-card="reaper"]')!);
    await settle(60);
    assert.deepEqual(seen, ["reaper"], "the panel did not tell its parent which card was clicked");
    assert.match(dialog()?.textContent ?? "", /REAPER/);
  });

  test("closing reports null up", async () => {
    await controlled("reaper");
    fireEvent.keyDown(dialog()!, { key: "Escape" });
    await settle(60);
    assert.deepEqual(seen, [null]);
    assertAbsent(dialog(), "the dialog stayed open after the parent was told to close it");
  });

  test("uncontrolled still works, and is what every other caller gets", async () => {
    server = installFakeServer();
    const c = render(withQueryClient(<IntegrationsPanel />));
    await settle(60);
    fireEvent.click(c.container.querySelector<HTMLElement>('[data-integration-card="reaper"]')!);
    await settle(60);
    assert.match(dialog()?.textContent ?? "", /REAPER/);
  });
});
