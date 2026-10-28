// host-names-card.test.tsx — the Host names card's add field, through the real
// component with a stubbed fetch. A refused add (a full list, or a page opened
// by a name not on the list) once cleared what the operator typed along with
// the toast that said why. NOTHING BELOW PASSES A DOM NODE AS AN ASSERT
// OPERAND: see advanced-section-writes.test.tsx.
//
// Every name below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, unmountAndTeardown } from "../../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { HostNamesCard } = await import("./host-names-card.js");
const { TooltipProvider, Toaster } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

const VIEW = { enforce: false, automatic: [], accepted: [], waiting: [], dismissed: [] };
const seen = (name: string, firstSeen: string, lastSeen: string, count = 3) => ({ name, firstSeen, lastSeen, count, lastFrom: "10.0.0.7", client: "Chrome" });

let mountedClient: InstanceType<typeof QueryClient> | null = null;

function mount(addAnswer: () => unknown, view: Record<string, unknown> = VIEW) {
  const stub = stubFetchWithLog((url, init) => {
    if (url.includes("/api/security/host-names") && init?.method === "POST") return addAnswer();
    if (url.includes("/api/security/host-names")) return ok(view);
    return ok({});
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });
  mountedClient = queryClient;
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TooltipProvider, null, React.createElement(HostNamesCard), React.createElement(Toaster)),
    ),
  );
  return stub;
}

async function addName(name: string): Promise<HTMLInputElement> {
  const input = (await screen.findByLabelText("Add a host name")) as HTMLInputElement;
  await eventually(() => assert.equal(input.disabled, false));
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  return input;
}

test("a refused add keeps what was typed, and says why", async () => {
  const stub = mount(() => reply(400, { error: "The list is full (200 names); remove one first." }));
  try {
    const input = await addName("stage.example.org");
    await eventually(() => assert.ok((document.body.textContent ?? "").includes("The list is full"), "no toast said why"));
    assert.equal(input.value, "stage.example.org");
  } finally {
    stub.restore();
  }
});

test("control: an add the server takes clears the field", async () => {
  const stub = mount(() => ok({ ...VIEW, accepted: [{ name: "stage.example.org", source: "added", at: "" }] }));
  try {
    const input = await addName("stage.example.org");
    await eventually(() => assert.equal(input.value, ""));
  } finally {
    stub.restore();
  }
});

// Turning refusal on is a confirmation. The server takes exactly the names sent,
// so what these assert is what the operator's ticks put on the wire.

const CONFIRM_VIEW = {
  ...VIEW,
  automatic: [{ name: "stage-box.example.org", source: "public-address" }],
  accepted: [
    { name: "ha.example.org", source: "added", at: "2026-10-01T00:00:00Z" },
    { name: "old-panel.example.org", source: "accepted", at: "2026-10-02T00:00:00Z" },
  ],
  waiting: [
    seen("tablet.example.org", "2026-10-03T10:00:00Z", "2026-10-20T10:00:00Z", 12),
    seen("rebind-7f3a.attacker.example", "2026-10-05T10:00:00Z", "2026-10-21T10:00:00Z", 2),
  ],
};

/** Every POST to the host names route, as the body it carried. */
function recordPosts(answer: () => unknown = () => ok({ ...CONFIRM_VIEW, enforce: true }), view: Record<string, unknown> = CONFIRM_VIEW) {
  const bodies: Record<string, unknown>[] = [];
  const stub = mount(() => answer(), view);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/api/security/host-names") && init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
    return inner(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    bodies,
    restore: () => {
      globalThis.fetch = inner;
      stub.restore();
    },
  };
}

async function openConfirm() {
  const toggle = await screen.findByRole("switch", { name: "Refuse names not on the list" });
  await eventually(() => assert.equal((toggle as HTMLButtonElement).disabled, false));
  fireEvent.click(toggle);
  await screen.findByRole("dialog");
}

const keep = (name: string) => screen.getByRole("checkbox", { name: `Keep ${name}` }) as HTMLButtonElement;
const ticked = (name: string) => keep(name).getAttribute("aria-checked") === "true";

test("turning refusal on lists every candidate with first and last seen, and sends nothing yet", async () => {
  const rec = recordPosts();
  try {
    await openConfirm();
    for (const name of ["ha.example.org", "old-panel.example.org", "tablet.example.org", "rebind-7f3a.attacker.example", "stage-box.example.org"]) {
      assert.ok(screen.getAllByText(name).length > 0, `${name} is not offered`);
    }
    const dialogText = document.querySelector("[role=dialog]")?.textContent ?? "";
    assert.match(dialogText, /First seen/);
    assert.match(dialogText, /last seen/);
    assert.deepEqual(rec.bodies, [], "the switch alone posted a change");
  } finally {
    rec.restore();
  }
});

test("listed names start ticked, the Public address is ticked and fixed, waiting names start unticked", async () => {
  const rec = recordPosts();
  try {
    await openConfirm();
    assert.equal(ticked("ha.example.org"), true);
    assert.equal(ticked("old-panel.example.org"), true);
    assert.equal(ticked("stage-box.example.org"), true);
    assert.equal(keep("stage-box.example.org").disabled, true);
    assert.equal(ticked("tablet.example.org"), false);
    assert.equal(ticked("rebind-7f3a.attacker.example"), false);
  } finally {
    rec.restore();
  }
});

test("confirm posts exactly the ticked names: the defaults, then a waiting one added and a listed one dropped", async () => {
  const rec = recordPosts();
  try {
    await openConfirm();
    fireEvent.click(keep("tablet.example.org"));
    fireEvent.click(keep("old-panel.example.org"));
    fireEvent.click(screen.getByRole("button", { name: "Turn on refusal" }));
    await eventually(() => assert.equal(rec.bodies.length, 1));
    assert.deepEqual(rec.bodies[0], { enforce: true, names: ["ha.example.org", "tablet.example.org"] });
  } finally {
    rec.restore();
  }
});

test("confirm with the defaults alone never sends a waiting name", async () => {
  const rec = recordPosts();
  try {
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Turn on refusal" }));
    await eventually(() => assert.equal(rec.bodies.length, 1));
    assert.deepEqual(rec.bodies[0], { enforce: true, names: ["ha.example.org", "old-panel.example.org"] });
  } finally {
    rec.restore();
  }
});

test("cancel closes the dialog and changes nothing", async () => {
  const rec = recordPosts();
  try {
    await openConfirm();
    fireEvent.click(keep("tablet.example.org"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await eventually(() => assert.equal(document.querySelector("[role=dialog]") === null, true));
    assert.deepEqual(rec.bodies, []);
    const toggle = screen.getByRole("switch", { name: "Refuse names not on the list" });
    assert.equal(toggle.getAttribute("aria-checked"), "false");
  } finally {
    rec.restore();
  }
});

test("a refusal from the server keeps the dialog open and says why", async () => {
  const rec = recordPosts(() => reply(400, { error: 'You are using this server as "ha.example.org": keep it on the list, or turning refusal on would lock you out.' }));
  try {
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Turn on refusal" }));
    await eventually(() => assert.ok((document.body.textContent ?? "").includes("lock you out"), "no toast said why"));
    assert.equal(document.querySelector("[role=dialog]") !== null, true);
  } finally {
    rec.restore();
  }
});

test("turning refusal off posts at once, with no confirmation", async () => {
  const rec = recordPosts(() => ok(VIEW), { ...CONFIRM_VIEW, enforce: true });
  try {
    const toggle = await screen.findByRole("switch", { name: "Refuse names not on the list" });
    await eventually(() => assert.equal((toggle as HTMLButtonElement).disabled, false));
    fireEvent.click(toggle);
    await eventually(() => assert.deepEqual(rec.bodies, [{ enforce: false }]));
    assert.equal(document.querySelector("[role=dialog]") === null, true);
  } finally {
    rec.restore();
  }
});

test("a name that left the card's lists while the dialog was open is not sent", async () => {
  const live = { ...CONFIRM_VIEW, accepted: [...CONFIRM_VIEW.accepted], waiting: [...CONFIRM_VIEW.waiting] };
  const rec = recordPosts(undefined, live);
  try {
    await openConfirm();
    fireEvent.click(keep("tablet.example.org"));
    assert.equal(ticked("tablet.example.org"), true);
    live.waiting = live.waiting.filter((w) => w.name !== "tablet.example.org");
    live.accepted = live.accepted.filter((a) => a.name !== "old-panel.example.org");
    void mountedClient?.invalidateQueries({ queryKey: ["security:host-names"] });
    await eventually(() => assert.equal(screen.queryByRole("checkbox", { name: "Keep tablet.example.org" }) === null, true, "the card still offers the name"));
    fireEvent.click(screen.getByRole("button", { name: "Turn on refusal" }));
    await eventually(() => assert.equal(rec.bodies.length, 1));
    assert.deepEqual(rec.bodies[0], { enforce: true, names: ["ha.example.org"] });
  } finally {
    rec.restore();
  }
});
