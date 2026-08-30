// What the operator types must survive the card moving.
//
// The Integrations page keeps unused integrations in a "Not set up" group at the
// bottom and everything else in category groups above. Enabling one moves its
// descriptor from one group to the other — a different parent in the React tree
// — so React unmounts the card and mounts a new one. The reported bug: type an
// IP into an integration at the bottom of the page, flick the enable switch, and
// the card reappears at the top with the field EMPTY.
//
// Both halves of that are asserted here against the real IntegrationCard: a
// remount at a different position in the tree (a changed `key` on the wrapper is
// exactly what React does when a child moves parents), and the collapse/expand
// case, which unmounts the body the same way — Collapsible renders
// `{open && children}`.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { IntegrationCard } = await import("./integrations-panel.js");
const { integrationDrafts } = await import("./integration-drafts.js");

/** Radix and React both schedule work on later ticks; let it run while the DOM
 *  still exists, or it throws "window is not defined" after teardown. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

after(async () => {
  cleanup();
  await settle();
  teardown();
});

beforeEach(() => {
  cleanup();
  integrationDrafts.clearAll();
});

/** A dormant integration with a plain host field — the shape the operator hit. */
const DESCRIPTOR = {
  id: "obs",
  kind: "control",
  label: "OBS Studio",
  configSchema: [{ key: "host", label: "OBS Host", type: "text", placeholder: "192.168.1.50" }],
} as IntegrationDescriptor;

const DORMANT: IntegrationState = {
  id: "obs",
  enabled: false,
  connection: "disconnected",
  message: null,
  config: {},
  configured: false,
};

function card(state: IntegrationState) {
  return <IntegrationCard descriptor={DESCRIPTOR} state={state} onStateChange={() => {}} />;
}

const hostField = (c: { container: HTMLElement }): HTMLInputElement => {
  const el = c.container.querySelector<HTMLInputElement>('[data-config-field="host"] input');
  assert.ok(el, "no host field rendered");
  return el;
};

describe("a draft config survives the card moving between groups", () => {
  test("the typed host is still there after the card is remounted elsewhere", () => {
    // Position in the tree, modelled the way React sees it: a different key at
    // the same slot unmounts one card and mounts another, which is precisely what
    // moving from the "Not set up" group into a category group does.
    const c = render(<div key="not-set-up">{card(DORMANT)}</div>);
    fireEvent.change(hostField(c), { target: { value: "192.168.1.77" } });
    assert.equal(hostField(c).value, "192.168.1.77", "the field did not take the value at all");

    // The switch has been flicked: the integration is enabled, so it belongs to a
    // different group now.
    c.rerender(<div key="control">{card({ ...DORMANT, enabled: true })}</div>);

    assert.equal(
      hostField(c).value,
      "192.168.1.77",
      "the card came back empty — enabling an integration threw away what was typed",
    );
  });

  test("and after the card is collapsed and reopened", () => {
    // Collapsible renders {open && children}, so closing a card unmounts the form
    // mid-edit. Same defect, same fix.
    const c = render(<div>{card(DORMANT)}</div>);
    fireEvent.change(hostField(c), { target: { value: "10.0.0.4" } });

    c.rerender(<div>{null}</div>);
    c.rerender(<div>{card(DORMANT)}</div>);

    assert.equal(hostField(c).value, "10.0.0.4", "collapsing the card threw away what was typed");
  });

  test("focus goes back to the field that was being typed in", () => {
    const c = render(<div key="not-set-up">{card(DORMANT)}</div>);
    const before = hostField(c);
    fireEvent.focus(before);
    fireEvent.change(before, { target: { value: "192.168.1.77" } });

    c.rerender(<div key="control">{card({ ...DORMANT, enabled: true })}</div>);

    const after = hostField(c);
    // Compared as a boolean, not as two nodes: assert.equal renders a diff of
    // whatever it was given, and inspecting two jsdom elements takes long enough
    // that the file is killed on a timeout instead of reporting the failure.
    assert.equal(
      document.activeElement === after,
      true,
      "the operator was left with no caret anywhere after the card moved",
    );
    assert.equal(after.selectionStart, "192.168.1.77".length, "the caret was not left at the end");
  });

  test("a card with nothing typed is seeded from the saved state, not a stale draft", () => {
    // The store must not become a second source of truth: a clean form has no
    // draft, so a state change from the backend still shows through.
    const c = render(<div>{card(DORMANT)}</div>);
    assert.equal(hostField(c).value, "");
    assert.equal(integrationDrafts.get("obs"), undefined, "a clean form parked a draft");

    c.rerender(<div>{null}</div>);
    c.rerender(<div>{card({ ...DORMANT, config: { host: "192.168.1.9" } })}</div>);
    assert.equal(hostField(c).value, "192.168.1.9");
  });

  test("discarding an edit takes the draft with it", () => {
    const c = render(<div>{card(DORMANT)}</div>);
    fireEvent.change(hostField(c), { target: { value: "192.168.1.77" } });
    assert.ok(integrationDrafts.get("obs"), "an edited form parked no draft");

    // Back to what is saved — the Discard button's effect.
    fireEvent.change(hostField(c), { target: { value: "" } });
    assert.equal(
      integrationDrafts.get("obs"),
      undefined,
      "a form back in step with the saved config still held a draft",
    );
  });
});
