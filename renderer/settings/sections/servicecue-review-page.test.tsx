// servicecue-review-page.test.tsx — the design-review changes to the ServiceCue layouts page
// and its open card (Landing page first, Row color wording, empty roles, the address and
// Used by footer), driven through the real page over the stateful settings server.
//
// NOT unit-tested here, and driven in a browser instead (jsdom loads no stylesheet and
// lays nothing out): the greyed, dotted look of an empty role's chip, where the footer
// wraps at 390px, and the popover that carries the reason on hover.

// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: a failing assert inspects the node,
// and a jsdom node takes a minute to print. Assert on `!!node` or on text.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { serviceCueServer } from "../../test-fixtures/servicecue-server.js";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, screen, cleanup, fireEvent, within, act } = await import("@testing-library/react");
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

/** Every press, change and focus is made inside act, awaited, so what it sets going (a save, a tooltip, a copy)
 *  lands inside it. A bare fireEvent starts the work and leaves its updates outside, as an act() warning. */
const click = (el: Element) => act(async () => void fireEvent.click(el));
const change = (el: Element, value: string) => act(async () => void fireEvent.change(el, { target: { value } }));
const press = (el: Element, key: string) => act(async () => void fireEvent.keyDown(el, { key }));
const focus = (el: HTMLElement) => act(async () => el.focus());

async function mount(): Promise<void> {
  await act(async () => {
    render(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
        React.createElement(TooltipProvider, null, React.createElement(ServiceCueSection), React.createElement(ConfirmHost)),
      ),
    );
  });
  for (let i = 0; i < 5; i++) await settle();
}
async function openCard(name: string): Promise<void> {
  await click(await eventually(() => screen.getByRole("button", { name: new RegExp(`^${name},`) })));
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
    await change(pick, "r-light");
    await eventually(() => assert.equal(s.layouts()[0].accentRole, "r-light"));
    assert.equal(s.layouts()[0].rowColor, "category");
  } finally {
    s.restore();
  }
});

// ── F6: an empty role is shown, marked, and cannot be added ─────────────────

const trayOf = (id: string) => document.querySelector(`[data-tray="${id}"]`) as HTMLElement;

test("an empty role waits in the tray greyed and unaddable, with its reason, and is not a button", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await openCard("Audio");
    const tray = trayOf("l-audio");
    // A role with categories is still a button to click; the empty one is not.
    assert.equal(!!tray.querySelector('button[aria-label="Add Lighting"]'), true);
    assert.equal(!!tray.querySelector('button[aria-label="Add Video"]'), false, "an empty role is offered as a button");
    const chip = tray.querySelector("[data-empty-role]") as HTMLElement | null;
    assert.equal(chip === null, false, "the empty role has no chip of its own in the tray");
    assert.equal(chip!.tagName, "SPAN");
    assert.equal(chip!.getAttribute("aria-disabled"), "true");
    assert.equal(chip!.getAttribute("aria-label"), "Video, no categories yet. Give it a category under Category roles to add it.");
    assert.match(chip!.textContent ?? "", /Video\s*No categories yet/);
    const before = s.requests.length;
    await click(chip!);
    await press(chip!, "Enter");
    await press(chip!, " ");
    await settle();
    // Only the page's own saves: the event stream's subscribe is a POST too, and lands whenever it likes.
    assert.equal(s.requests.slice(before).filter((r) => r.method === "POST" && r.path.startsWith("/api/servicecue")).length, 0, "clicking an empty role saved something");
    assert.deepEqual(s.layouts()[0].columnRoles, ["r-audio"]);
    // Its reason is said on focus, where a keyboard operator finds it.
    await focus(chip!);
    await eventually(() => assert.match(document.body.textContent ?? "", /Video has no categories yet, so it would draw no column\. Give it one under Category roles\./));
  } finally {
    s.restore();
  }
});

test("the roles list tags an empty role, and giving it a category clears the tag and the greying", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, cats: { sun: ["Audio", "Lighting", "Video"] } });
  try {
    await mount();
    await openCard("Audio");
    const tags = () => [...document.querySelectorAll("[data-role-empty]")].map((t) => t.textContent);
    assert.deepEqual(tags(), ["Can't be added to a layout"]);
    assert.match((document.querySelector('[data-role="r-video"]') as HTMLElement).textContent ?? "", /No categories yet, so this column is empty\./);
    const add = (await eventually(() => screen.getByRole("combobox", { name: "Add a category to Video" }))) as HTMLSelectElement;
    const opt = [...add.querySelectorAll("option")].find((o) => o.textContent === "Video") as HTMLOptionElement;
    await change(add, opt.value);
    await eventually(() => assert.deepEqual(s.roles().find((r) => r.id === "r-video")?.members, ["Video"]));
    await eventually(() => assert.deepEqual(tags(), []));
    assert.equal(!!trayOf("l-audio").querySelector("[data-empty-role]"), false);
    assert.equal(!!trayOf("l-audio").querySelector('button[aria-label="Add Video"]'), true);
  } finally {
    s.restore();
  }
});

test("a role already a column keeps its place after losing its categories, and nothing is removed", async () => {
  const roles = [{ id: "r-audio", name: "Audio", members: [] as string[] }];
  const s = serviceCueServer({ layouts: LAYOUTS, roles, shown: ["sun"], types: TYPES });
  try {
    await mount();
    await eventually(() => screen.getByRole("button", { name: "Audio, Clock · Time · Item · Audio" }));
    await openCard("Audio");
    assert.deepEqual(roleRow("l-audio"), ["Audio"]);
    assert.equal(s.requests.filter((r) => r.method === "POST" && r.path === "/api/servicecue/layouts").length, 0, "opening the card rewrote the layout");
    assert.deepEqual(s.layouts()[0].columnRoles, ["r-audio"]);
  } finally {
    s.restore();
  }
});
const roleRow = (layoutId: string) =>
  [...(document.querySelector(`[data-cols="${layoutId}"]`)?.querySelectorAll("[data-sort-id]") ?? [])].map((c) => c.textContent ?? "");

// ── F5: Landing page leads, and is open on a first run ──────────────────────

const landingRow = () => screen.getByRole("button", { name: /^Landing page/ });
const headingsInOrder = () =>
  [...document.querySelectorAll("h1, h2, button[aria-expanded]")]
    .map((n) => (n.tagName === "BUTTON" ? (/^Landing page/.test(n.textContent ?? "") ? "Landing page" : "") : (n.textContent ?? "")))
    .filter(Boolean);

test("Landing page is the first section, above Layouts, and open while no type is ticked", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: [], types: TYPES });
  try {
    await mount();
    assert.deepEqual(headingsInOrder().slice(0, 4), ["ServiceCue layouts", "Landing page", "Layouts", "Category roles"]);
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "true"));
    assert.equal(!!screen.queryByRole("checkbox", { name: "Sunday Morning" }), true);
    // Landing page leads now, so its layouts are below it, not above.
    assert.match(document.body.textContent ?? "", /each with the layouts below, in that order, then All columns\./);
    // Ticking the first type does not shut it under the pointer.
    await click(screen.getByRole("checkbox", { name: "Sunday Morning" }));
    await eventually(() => assert.deepEqual(s.shown(), ["sun"]));
    assert.equal(landingRow().getAttribute("aria-expanded"), "true");
  } finally {
    s.restore();
  }
});

/** The address as a reload finds it: set before the page mounts, with replaceState, which fires no
 *  hashchange, so only the read made at mount can open the row. */
const addressIs = (hash: string) => window.history.replaceState(null, "", `${window.location.pathname}${hash}`);

test("Landing page is shut when a type is ticked and the address has no hash", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    addressIs("");
    await mount();
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "false"));
  } finally {
    s.restore();
  }
});

test("a page loaded at #landing opens Landing page even with a type ticked: the read at mount, no event", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    addressIs("#landing");
    await mount();
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "true"));
  } finally {
    addressIs("");
    s.restore();
  }
});

test("#landing arriving while the page is already open opens Landing page: hashchange alone", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    addressIs("");
    await mount();
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "false"));
    addressIs("#landing"); // no event of its own
    await act(async () => void window.dispatchEvent(new window.HashChangeEvent("hashchange")));
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "true"));
  } finally {
    addressIs("");
    s.restore();
  }
});

test("without Planning Center the open Landing page links to Integrations; the other Connect sentences stay text", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: [], types: [], pcoConfigured: false });
  try {
    await mount();
    await eventually(() => assert.equal(landingRow().getAttribute("aria-expanded"), "true"));
    assert.equal(screen.getByRole("link", { name: "Connect Planning Center" }).getAttribute("href"), "/settings/integrations");
    assert.equal(screen.getAllByRole("link", { name: /Connect Planning Center/ }).length, 1);
    // The mockup shows the link alone: no sentence about ticks while there is nothing to tick.
    assert.doesNotMatch(document.body.textContent ?? "", /Only these service types appear on the ServiceCue landing page/);
    // And the link is the app's one inline-link style.
    const { INLINE_LINK } = await import("../../lib/link-classes.js");
    for (const cls of INLINE_LINK.split(" ")) assert.equal(screen.getByRole("link", { name: "Connect Planning Center" }).classList.contains(cls), true, cls);
  } finally {
    s.restore();
  }
});

// ── F8: the open card's address and who uses it ─────────────────────────────

const VIEWS = [
  { id: "v1", name: "Stage left", kind: "script", serviceCueLayoutId: "l-audio" },
  { id: "v2", name: "Mic wall", kind: "slots", serviceCueLayoutId: "l-audio" }, // kept its id after a kind change: draws nothing of it
  { id: "v3", name: "Lighting tablet", kind: "script", serviceCueLayoutId: "l-light" },
  { id: "v4", name: "Audio tablet", kind: "script", serviceCueLayoutId: "l-audio" },
];
const footer = () => document.querySelector("[data-layout-foot]") as HTMLElement;
const footText = () => footer()?.textContent ?? "";

test("the open card ends in its address and the views that use it", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun", "wed"], types: TYPES, views: VIEWS });
  try {
    await mount();
    await openCard("Audio");
    await eventually(() => assert.match(footText(), /Address\s*\/servicecue\/sunday-morning\/audio/));
    assert.match(footText(), /Used by:\s*Audio tablet, Stage left/);
    // The address follows Preview with: it needs a service type.
    await change(screen.getByRole("combobox", { name: "Preview with" }), "wed");
    await eventually(() => assert.match(footText(), /\/servicecue\/wednesday-night\/audio/));
  } finally {
    s.restore();
  }
});

test("Used by is what the Delete confirm names, from the same list", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, views: VIEWS });
  try {
    await mount();
    await openCard("Audio");
    await eventually(() => assert.match(footText(), /Used by:\s*Audio tablet, Stage left/));
    await click(screen.getByRole("button", { name: "Delete Audio" }));
    await eventually(() => assert.match(document.body.textContent ?? "", /Audio tablet and Stage left use this layout\./));
    assert.doesNotMatch(document.body.textContent ?? "", /Mic wall/, "a view of another kind is not a user");
  } finally {
    s.restore();
  }
});

test("Used by is in the order Screens lists a view in: by name, whatever order the state holds them", async () => {
  const views = [
    { id: "v1", name: "Zeta wall", kind: "script", serviceCueLayoutId: "l-audio" },
    { id: "v2", name: "alpha tablet", kind: "script", serviceCueLayoutId: "l-audio" },
    { id: "v3", name: "Mid", kind: "script", serviceCueLayoutId: "l-audio" },
  ];
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, views });
  try {
    await mount();
    await openCard("Audio");
    await eventually(() => assert.match(footText(), /Used by:\s*alpha tablet, Mid, Zeta wall/));
    const { screenPickerViews } = await import("./outputs-section.js");
    const asScreens = screenPickerViews(views as never).map((v) => v.name).join(", ");
    assert.equal(asScreens, "alpha tablet, Mid, Zeta wall", "Screens' own order is no longer by name");
  } finally {
    s.restore();
  }
});

test("a layout no view uses says so", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, views: [] });
  try {
    await mount();
    await openCard("Lighting");
    await eventually(() => assert.match(footText(), /Used by:\s*no views yet/));
  } finally {
    s.restore();
  }
});

test("without Planning Center the address is the template and Copy is disabled", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: [], types: [], pcoConfigured: false, views: VIEWS });
  try {
    await mount();
    await openCard("Audio");
    await eventually(() => assert.match(footText(), /\/servicecue\/<service type>\/audio/));
    assert.equal((within(footer()).getByRole("button", { name: /Copy/ }) as HTMLButtonElement).disabled, true);
  } finally {
    s.restore();
  }
});

/** Run `body` with the page's clipboard as given: a secure-context API, or none (plain HTTP). */
async function withClipboard(kind: "api" | "http", body: (copied: string[]) => Promise<void>): Promise<void> {
  const copied: string[] = [];
  const nav = navigator as unknown as { clipboard?: unknown };
  const win = window as unknown as { isSecureContext: boolean };
  const doc = document as unknown as { execCommand?: unknown };
  const had = { clipboard: Object.getOwnPropertyDescriptor(nav, "clipboard"), secure: win.isSecureContext, exec: doc.execCommand };
  if (kind === "api") {
    Object.defineProperty(nav, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    win.isSecureContext = true;
  } else {
    // Plain HTTP on a LAN address: no navigator.clipboard at all. The legacy path copies
    // the selected textarea, so what it was holding when told to copy is what is recorded.
    delete nav.clipboard;
    win.isSecureContext = false;
    doc.execCommand = () => {
      const ta = document.activeElement as HTMLTextAreaElement | null;
      if (ta?.tagName === "TEXTAREA") copied.push(ta.value);
      return true;
    };
  }
  try {
    await body(copied);
  } finally {
    if (had.clipboard) Object.defineProperty(nav, "clipboard", had.clipboard);
    else delete nav.clipboard;
    win.isSecureContext = had.secure;
    doc.execCommand = had.exec;
  }
}

for (const kind of ["api", "http"] as const) {
  test(`Copy writes this app's full address (${kind === "api" ? "clipboard API" : "plain HTTP fallback"}) and says Copied`, async () => {
    await withClipboard(kind, async (copied) => {
      const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, views: VIEWS });
      try {
        await mount();
        await openCard("Audio");
        await click(await eventually(() => within(footer()).getByRole("button", { name: "Copy" })));
        await eventually(() => assert.deepEqual(copied, [`${window.location.origin}/servicecue/sunday-morning/audio`]));
        await eventually(() => assert.match(footText(), /Copied/));
      } finally {
        s.restore();
      }
    });
  });
}

test("Copy uses the Public address when one is set", async () => {
  // As every screen link does: the address a volunteer is handed is the one the
  // operator set, not whichever the operator's browser happens to use.
  await withClipboard("api", async (copied) => {
    const s = serviceCueServer({
      layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, views: VIEWS,
      override: (url) =>
        new URL(url, "http://x").pathname === "/api/state"
          ? new Response(JSON.stringify({ pcoConfigured: true, views: VIEWS, publicUrl: "http://stage.example.org" }), { status: 200, headers: { "Content-Type": "application/json" } })
          : undefined,
    });
    try {
      await mount();
      await openCard("Audio");
      await click(await eventually(() => within(footer()).getByRole("button", { name: "Copy" })));
      await eventually(() => assert.deepEqual(copied, ["http://stage.example.org/servicecue/sunday-morning/audio"]));
    } finally {
      s.restore();
    }
  });
});

test("a copy the browser refuses says so instead of reading Copied", async () => {
  const win = window as unknown as { isSecureContext: boolean };
  const doc = document as unknown as { execCommand?: unknown };
  const was = { secure: win.isSecureContext, exec: doc.execCommand };
  win.isSecureContext = false;
  doc.execCommand = () => false;
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES, views: VIEWS });
  try {
    await mount();
    await openCard("Audio");
    await click(await eventually(() => within(footer()).getByRole("button", { name: "Copy" })));
    await eventually(() => assert.match(footText(), /Couldn't copy/));
    assert.doesNotMatch(footText(), /Copied/);
  } finally {
    win.isSecureContext = was.secure;
    doc.execCommand = was.exec;
    s.restore();
  }
});

// ── F7: Home's Open roles lands on the roles section ────────────────────────

test("the Category roles section carries the id Home's Open roles flashes", async () => {
  const s = serviceCueServer({ layouts: LAYOUTS, roles: ROLES, shown: ["sun"], types: TYPES });
  try {
    await mount();
    const { ROLES_FLASH_ID } = await import("../../app/flash.js");
    const section = await eventually(() => document.querySelector(`[data-flash-id="${ROLES_FLASH_ID}"]`) as HTMLElement);
    assert.match(section.querySelector("h2")?.textContent ?? "", /^Category roles$/);
  } finally {
    s.restore();
  }
});

// ── F7: a note-category read that fails is said, not shown as nothing ───────

test("the notice says so when a landing type's categories could not be read (a 502), instead of showing nothing", async () => {
  const { reply } = await import("../../test-fixtures/fetch-log.js");
  const s = serviceCueServer({
    layouts: LAYOUTS,
    roles: ROLES,
    shown: ["sun"],
    types: TYPES,
    cats: { sun: ["Audio", "Prayer"] },
    override: (url) => (url.includes("/api/servicecue/note-categories") ? reply(502, { error: "Planning Center is down" }) : undefined),
  });
  try {
    await mount();
    await eventually(() => assert.match(document.body.textContent ?? "", /Couldn't load the note categories for Sunday Morning, so this page can't say which are in no role\./));
    assert.equal(!!document.querySelector("[data-notice]"), false, "a notice was drawn from categories that were never read");
  } finally {
    s.restore();
  }
});
