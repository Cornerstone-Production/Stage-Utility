// All sixteen integrations are on the page, always.
//
// They used to be split: the ones in use in category groups, the rest behind a
// collapsed "Not set up (11)" disclosure. The disclosure is gone at the
// operator's request — "they can be on the same page but just grayed out" — so
// what this file guards is that nothing put it back, in any form: no hidden
// cards, no expander, no card that renders only once something is clicked.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, settle, assertAbsent } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { INTEGRATION_DESCRIPTOR_FIXTURE } = await import(
  "../test-fixtures/integration-descriptors.js"
);
const { IntegrationsPanel } = await import("./integrations-panel.js");

const TOTAL = INTEGRATION_DESCRIPTOR_FIXTURE.length;

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

async function panel(overrides: Record<string, Partial<IntegrationState>> = {}) {
  server = installFakeServer(overrides);
  const c = render(withQueryClient(<IntegrationsPanel />));
  await settle();
  return c;
}

const tiles = (c: { container: HTMLElement }) =>
  [...c.container.querySelectorAll<HTMLElement>("[data-integration-card]")];

describe("every integration is visible, with nothing collapsed", () => {
  test(`all ${TOTAL} cards are in the document on the first render`, async () => {
    const c = await panel();
    // An exact count, not a floor. A floor is satisfied by a disclosure that
    // renders half the list, which is the state this change removed.
    assert.equal(tiles(c).length, TOTAL);
    assert.deepEqual(
      tiles(c).map((el) => el.getAttribute("data-integration-card")).sort(),
      INTEGRATION_DESCRIPTOR_FIXTURE.map((d) => d.id).sort(),
    );
  });

  test("there is no disclosure anywhere on the page", async () => {
    const c = await panel();
    assertAbsent(
      c.container.querySelector("[aria-expanded]"),
      "something on the page still expands and collapses",
    );
  });

  test("the 'Not set up' heading is a plain element, not a button", async () => {
    const c = await panel();
    const heading = [...c.container.querySelectorAll("*")].find(
      (el) => el.children.length === 0 && el.textContent === "Not set up",
    );
    assert.ok(heading, "no 'Not set up' heading rendered");
    assert.equal(heading.tagName, "SPAN");
    assertAbsent(heading.closest("button"), "the heading is inside a button");
  });

  test("every dormant card sorts after every card in use", async () => {
    const c = await panel({ obs: { enabled: true }, resi: { configured: true } });
    const order = tiles(c).map((el) => el.getAttribute("data-integration-card")!);
    const dormantStart = order.findIndex((id) => !["obs", "resi"].includes(id));
    assert.equal(order.slice(0, dormantStart).sort().join(), "obs,resi");
    assert.equal(order.length, TOTAL);
  });

  test("an erroring integration stays up with the live ones, never in 'Not set up'", async () => {
    // The one thing that keeps "not set up" and "broken" from reading alike now
    // that both halves are on screen. isInUse() counts connection === "error".
    const c = await panel({ obs: { connection: "error", message: "unreachable" } });
    const order = tiles(c).map((el) => el.getAttribute("data-integration-card")!);
    assert.equal(order[0], "obs", "an erroring integration fell into the dormant group");
  });

  test("a dormant card is quiet but never dim, and says so in words", async () => {
    const c = await panel({ resi: { enabled: true } });
    const obs = tiles(c).find((el) => el.getAttribute("data-integration-card") === "obs")!;
    const resi = tiles(c).find((el) => el.getAttribute("data-integration-card") === "resi")!;
    // Transparent ground, dashed border, no shadow — the signal is the treatment.
    assert.match(obs.className, /\bbg-transparent\b/);
    assert.match(obs.className, /\bborder-dashed\b/);
    assert.match(obs.textContent ?? "", /Not set up/);

    // The two treatments are ALTERNATIVES, never a base plus overrides.
    // `.su-card` lives in @layer utilities after Tailwind's own utilities, so at
    // equal specificity it wins on source order: `su-card bg-transparent
    // border-dashed shadow-none` painted a solid white card with a solid border
    // and a shadow while the class list claimed otherwise. jsdom runs no cascade
    // and cannot see that, so what is asserted here is the thing that broke —
    // that a dormant card does not carry su-card at all.
    assert.doesNotMatch(
      obs.className,
      /\bsu-card\b/,
      "a dormant card also carries su-card, whose solid ground, solid border and shadow win on source order",
    );
    assert.match(resi.className, /\bsu-card\b/, "a card in use lost its surface");
    // And never carried by unreadable text: fg-faint is 1.76:1 in light and
    // fg-subtle 2.45:1, both well under AA. Neither may appear on this page.
    assert.doesNotMatch(c.container.innerHTML, /text-fg-faint/);
    assert.doesNotMatch(c.container.innerHTML, /text-fg-subtle/);
    // The palette ALIAS too, or the same contrast walks straight back in under
    // another name: Radix gray-9 is 3.32:1 on the light surface and 3.34–3.58:1
    // on the dark one — the same failure the two lines above ban, spelled
    // differently. Measured against #ffffff, #151515 and #1c1c1c.
    //
    // Compared as a BOOLEAN with a short excerpt, never assert.doesNotMatch on
    // the html: assert renders whatever it is handed, and serialising this page
    // takes long enough that node:test reports the file rather than the line.
    const alias = /class="[^"]*\btext-gray-[89]\b[^"]*"[^>]*>[^<]{0,40}/.exec(c.container.innerHTML);
    assert.equal(
      alias === null,
      true,
      `sub-AA palette text on the page — ${alias?.[0].slice(0, 120)}`,
    );
  });

  test("with nothing set up, the summary is the sentence and not '0 of 16 connected'", async () => {
    const c = await panel();
    assert.match(c.container.textContent ?? "", /Nothing is set up yet — open any card to connect it\./);
    assert.doesNotMatch(c.container.textContent ?? "", /connected/);
    // The heading and every card are still there — a fresh install is a page of
    // sixteen quiet cards, not an empty state with the list hidden behind it.
    assert.equal(tiles(c).length, TOTAL);
    assert.match(c.container.textContent ?? "", /Not set up/);
  });

  test("with something in use, the count gains a denominator", async () => {
    const c = await panel({ obs: { enabled: true, connection: "connected" } });
    assert.match(c.container.textContent ?? "", new RegExp(`1 of ${TOTAL} connected`));
    assert.doesNotMatch(c.container.textContent ?? "", /to set up/);
  });

  test("nothing the page mounted asked the harness for a route it does not have", async () => {
    await panel();
    assert.deepEqual(server.unhandled, []);
  });
});
