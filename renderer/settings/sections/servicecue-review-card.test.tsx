// servicecue-review-card.test.tsx — the design-review changes to an open layout card
// (Row color wording, empty roles, the address and Used by footer), driven through the
// real ServiceCue layouts page over the stateful settings server.
//
// NOT unit-tested here, and driven in a browser instead (jsdom loads no stylesheet and
// lays nothing out): the greyed, dotted look of an empty role's chip, where the footer
// wraps at 390px, and the popover that carries the reason on hover.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { serviceCueServer } from "../../test-fixtures/servicecue-server.js";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const React = await import("react");
const { ServiceCueSection } = await import("./servicecue-section.js");
const { TooltipProvider, ConfirmHost } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const TYPES = [{ id: "sun", name: "Sunday Morning" }, { id: "wed", name: "Wednesday Night" }];
const ROLES = [
  { id: "r-audio", name: "Audio", members: ["Audio", "Sound"] },
  { id: "r-light", name: "Lighting", members: ["Lighting"] },
  { id: "r-video", name: "Video", members: [] as string[] },
];
const LAYOUTS: ServiceCueLayout[] = [
  { id: "l-audio", name: "Audio", order: 0, columnRoles: ["r-audio"], slug: "audio", rowColor: "category", accentRole: "r-audio" },
  { id: "l-light", name: "Lighting", order: 1, columnRoles: ["r-light"], slug: "lighting" },
];

async function mount(): Promise<void> {
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
      React.createElement(TooltipProvider, null, React.createElement(ServiceCueSection), React.createElement(ConfirmHost)),
    ),
  );
  for (let i = 0; i < 5; i++) await settle();
}
async function openCard(name: string): Promise<void> {
  fireEvent.click(await eventually(() => screen.getByRole("button", { name: new RegExp(`^${name},`) })));
  await settle();
}
const optionTexts = (select: HTMLElement) => [...select.querySelectorAll("option")].map((o) => `${o.textContent}${(o as HTMLOptionElement).disabled ? " [disabled]" : ""}`);

// ── F3: Row color "By column" ───────────────────────────────────────────────

test("Row color says By column and Pick a column, and an empty role cannot be picked", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    const mode = screen.getByRole("combobox", { name: "Row color" });
    assert.deepEqual(optionTexts(mode), ["From PCO", "By column", "None"]);
    const pick = screen.getByRole("combobox", { name: "Row color column" });
    assert.deepEqual(optionTexts(pick), ["Pick a column…", "Audio", "Lighting", "Video (no categories yet) [disabled]"]);
    // The stored value is unchanged: a saved layout still reads "category" and its role.
    assert.equal((mode as HTMLSelectElement).value, "category");
    assert.equal((pick as HTMLSelectElement).value, "r-audio");
    fireEvent.change(pick, { target: { value: "r-light" } });
    await eventually(() => assert.equal(s.layouts()[0].accentRole, "r-light"));
    assert.equal(s.layouts()[0].rowColor, "category");
  } finally {
    s.restore();
  }
});
