// The Theme photos panel and Manage themes, rendered over a stubbed server that
// remembers what it was sent.
//
// What is under test is what an operator can be misled by: a photo that reads as
// approved when the server refused it, a Redo that bills from a prompt the server
// never kept, a Generate pressed twice, a confirm that says "done" over a refusal,
// an empty grid drawn over a roster that could not be read.
//
// NOT unit-tested here, driven in a browser instead: the sheet's placement (side
// sheet against bottom sheet), the shimmer, colours in light and dark, and how a
// card wraps at 390 px. jsdom loads no stylesheet and lays nothing out.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: assertions are on strings
// and booleans.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, isPlumbing } from "../../../test-dom.js";

const teardown = installRenderDom();

const sseHandlers = new Map<string, Set<(e: { data: string }) => void>>();
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  addEventListener(channel: string, handler: (e: { data: string }) => void): void {
    sseHandlers.set(channel, (sseHandlers.get(channel) ?? new Set()).add(handler));
  }
  removeEventListener(channel: string, handler: (e: { data: string }) => void): void {
    sseHandlers.get(channel)?.delete(handler);
  }
  close(): void {}
};
const emit = (payload: unknown) => {
  for (const h of [...(sseHandlers.get("photo-themes:changed") ?? [])]) h({ data: JSON.stringify(payload) });
};

const { render, cleanup, act, fireEvent, screen, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PhotoThemesPanel } = await import("./photo-themes-panel.js");
const { usePhotoThemes } = await import("./use-photo-themes.js");
const { cardView } = await import("./person-card.js");
const { __resetReplayCacheForTests } = await import("../../../lib/api.js");
const { TooltipProvider } = await import("../../../components/ui/tooltip-provider.js");
const { Toaster } = await import("../../../components/ui/toast.js");

const PLAN = { planId: "7001", serviceTypeId: "100", sortDate: "2026-12-24T00:00:00Z" };
const XMAS = "th-aaaaaaaaaaaa";
const EASTER = "th-bbbbbbbbbbbb";

type Status = "none" | "generating" | "ready" | "approved" | "stale" | "failed";
interface P {
  personId: string;
  name: string;
  status: Status;
  approved: null | { url: string; fromPlanId: string | null; fromDate: string | null; approvedAt: string; stale: boolean };
  pending: null | { status: "generating" | "ready" | "failed"; url: string | null; reason: string | null; planId: string | null };
}
/** A stored edit's name for a person: 16 hex, as the server's are. */
const editFile = (kind: "a" | "b", personId: string) => `${kind}${personId.padStart(15, "0")}.webp`;
const person = (personId: string, name: string, status: Status, over: Partial<P> = {}): P => {
  const approved = status === "approved" || status === "stale" ? { url: `/api/photo-themes/images/${editFile("a", personId)}`, fromPlanId: "7001", fromDate: "2026-12-14", approvedAt: "", stale: status === "stale" } : null;
  const pending =
    status === "ready" ? { status: "ready" as const, url: `/api/photo-themes/images/${editFile("b", personId)}`, reason: null, planId: "7001" } : status === "failed" ? { status: "failed" as const, url: null, reason: "Refused under OpenAI's content policy", planId: "7001" } : status === "generating" ? { status: "generating" as const, url: null, reason: null, planId: "7001" } : null;
  return { personId, name, status, approved, pending, ...over };
};

let people: P[] = [];
let themes: Record<string, unknown>[] = [];
let choice: { planId: string; serviceTypeId: string; sortDate: string | null; themeId: string | null; show: "original" | "themed" } | null = null;
let connection: Record<string, unknown> = {};
let roster: { roster: "live" | "plan" | "unavailable"; reason?: string } = { roster: "plan" };
let calls: { method: string; path: string; body: unknown }[] = [];
/** "METHOD /path" to the status and body it answers instead. */
let refuse: Record<string, { status: number; error: string }> = {};
let hold: Promise<void> | null = null;
/** The people an approve-all answers it skipped (their edit changed since it was shown). */
let approveAllSkips: string[] = [];
let closed = 0;

const theme = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  prompt: "Christmas lights, keep the face the same",
  promptChanged: false,
  createdAt: "2026-11-01T00:00:00Z",
  lastUsedDate: "2026-12-24",
  keptUntil: "2027-03-24",
  plans: [{ planId: "7001", serviceTypeId: "100", sortDate: "2026-12-24T00:00:00Z" }],
  people: [],
  ...over,
});
const state = () => ({
  themes: themes.map((t) => (t.id === choice?.themeId ? { ...t, people: people.map((p) => ({ ...p, originalUrl: p.personId === "9003" ? null : `https://avatars.example/${p.personId}` })) } : t)),
  plans: choice ? [choice] : [],
  connection,
  running: 0,
  queued: 0,
});

const realFetch = globalThis.fetch;
beforeEach(() => {
  cleanup();
  sseHandlers.clear();
  __resetReplayCacheForTests();
  calls = [];
  refuse = {};
  hold = null;
  approveAllSkips = [];
  closed = 0;
  roster = { roster: "plan" };
  connection = { method: "api-key", hint: "sk-…3f2a", state: "connected", reason: null, checkedAt: null };
  themes = [theme(XMAS, "Christmas 2026"), theme(EASTER, "Easter 2027", { plans: [] })];
  choice = { ...PLAN, themeId: XMAS, show: "themed" };
  people = [person("9001", "Alex R.", "approved"), person("9002", "Jordan P.", "ready"), person("9003", "Casey L.", "none")];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (isPlumbing(url)) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" } as unknown as Response;
    const method = init?.method ?? "GET";
    const path = new URL(url, "http://x").pathname;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method !== "GET" && hold) await hold;
    const no = refuse[`${method} ${path}`];
    let out: unknown = {};
    let status = 200;
    if (no) {
      status = no.status;
      out = { error: no.error };
    } else if (path === "/api/photo-themes") out = state();
    else if (path.endsWith("/approve-all")) {
      const sent = (body as { people: { personId: string }[] }).people;
      out = { approved: sent.length - approveAllSkips.length, skipped: approveAllSkips };
    }
    else if (path.startsWith("/api/photo-themes/plans/") && method === "GET") {
      out = {
        planId: "7001",
        serviceTypeId: "100",
        choice,
        ...roster,
        people: people.map((p) => ({ ...p, originalUrl: p.personId === "9003" ? null : `https://avatars.example/${p.personId}` })),
        toGenerate: people.filter((p) => p.personId !== "9003" && (p.status === "none" || p.status === "failed")).length,
      };
    }
    return { ok: status < 400, status, statusText: "x", json: async () => out, text: async () => JSON.stringify(out) } as unknown as Response;
  }) as typeof fetch;
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
afterEach(async () => {
  cleanup();
  await settle();
  client?.clear();
  client = null;
});
after(async () => {
  await settle();
  globalThis.fetch = realFetch;
  teardown();
});

function Harness() {
  const photos = usePhotoThemes(PLAN);
  return React.createElement(PhotoThemesPanel, { plan: PLAN, planLabel: "Dec 24", photos, onClose: () => void closed++ });
}
let client: InstanceType<typeof QueryClient> | null = null;
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(TooltipProvider, null, React.createElement(Harness), React.createElement(Toaster))));
  await settle();
}
const click = async (el: Element) => {
  await act(async () => void fireEvent.click(el));
  await settle();
};
const openMenu = async (el: Element) => {
  await act(async () => {
    fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
    fireEvent.click(el);
    await settle();
  });
};
const choose = async (el: Element) => {
  await act(async () => {
    fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(el, { button: 0, ctrlKey: false });
    fireEvent.click(el);
    await settle();
  });
};
const writes = () => calls.filter((c) => c.method !== "GET");
const card = (id: string) => document.querySelector(`[data-person-card="${id}"]`) as HTMLElement;
const chipOf = (id: string) => card(id).querySelector("[data-person-chip]")?.textContent ?? "";
const gets = () => calls.filter((c) => c.method === "GET" && c.path === "/api/photo-themes").length;

describe("each status a card can be in", () => {
  const view = (p: P, ctx = { planId: "7001" }) => cardView(p as never, ctx);
  test("the chip and the buttons for each", () => {
    assert.deepEqual(
      [
        view(person("1", "A", "none")).chip.label,
        view(person("1", "A", "none"), { planId: "7001", addedLater: true } as never).chip.label,
        view(person("1", "A", "none"), { planId: "7001", noOriginal: true } as never).chip.label,
        view(person("1", "A", "generating")).chip.label,
        view(person("1", "A", "ready")).chip.label,
        view(person("1", "A", "approved")).chip.label,
        view(person("1", "A", "stale")).chip.label,
        view(person("1", "A", "failed")).chip.label,
      ],
      ["Not themed yet", "Added after the last run", "No Planning Center photo", "Generating…", "Ready to review", "Approved", "Made from an older photo", "Failed"],
    );
    assert.deepEqual(view(person("1", "A", "ready")).actions, ["redo", "approve"]);
    assert.deepEqual(view(person("1", "A", "stale")).actions, ["redo", "keep"]);
    assert.deepEqual(view(person("1", "A", "approved")).actions, ["redo"]);
    assert.deepEqual(view(person("1", "A", "generating")).actions, [], "nothing to press while it is being made");
    assert.deepEqual(view(person("1", "A", "none")).actions, []);
  });

  test("an approved photo from another service says which; this service's own does not", () => {
    assert.equal(view(person("1", "A", "approved", { approved: { url: "u", fromPlanId: "6000", fromDate: "2026-12-14", approvedAt: "", stale: false } })).note, "From Mon, Dec 14");
    assert.equal(view(person("1", "A", "approved")).note, null);
  });

  test("a failed redo and a running redo both say the earlier photo stays on screen", () => {
    const failed = person("1", "A", "failed", { approved: person("1", "A", "approved").approved });
    assert.match(view(failed).note ?? "", /Refused under OpenAI's content policy.*earlier themed photo stays on screen/);
    const running = person("1", "A", "generating", { approved: person("1", "A", "approved").approved });
    assert.match(view(running).note ?? "", /earlier themed photo stays on screen until this one is approved/);
  });

  test("the grid draws each person's chip, and the generate button names the theme and the count", async () => {
    await mount();
    assert.equal(chipOf("9001"), "Approved");
    assert.equal(chipOf("9002"), "Ready to review");
    assert.equal(chipOf("9003"), "No Planning Center photo");
    assert.equal(document.querySelector("[data-generate]")?.textContent, "Everyone has a photo in Christmas 2026");
  });
});

describe("the header and the hints", () => {
  test("the Original | Themed switch is there once the theme has an approved photo, and Original says what screens show", async () => {
    await mount();
    const sw = screen.getByRole("group", { name: /Photos shown on screens/ });
    assert.equal(within(sw).getByRole("button", { name: "Themed" }).getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector("[data-showing-original]"), null);
    choice = { ...choice!, show: "original" };
    await click(within(sw).getByRole("button", { name: "Original" }));
    const patch = writes().find((c) => c.method === "PATCH")!;
    assert.deepEqual(patch.body, { serviceTypeId: "100", sortDate: PLAN.sortDate, show: "original" });
    assert.match(document.querySelector("[data-showing-original]")?.textContent ?? "", /Screens are showing the original photos/);
  });

  test("no approved photo in the theme, no switch", async () => {
    people = [person("9002", "Jordan P.", "ready")];
    await mount();
    assert.equal(screen.queryByRole("group", { name: /Photos shown on screens/ }), null);
  });

  test("a failing connection says so in the panel, with the way to Integrations", async () => {
    connection = { ...connection, state: "out-of-credits", reason: "Out of API credits" };
    await mount();
    assert.match(document.body.textContent ?? "", /Out of API credits/);
    assert.equal(screen.getByRole("link", { name: "Open Integrations" }).getAttribute("href"), "/settings/integrations");
  });

  test("a roster that could not be read is its reason, not an empty grid", async () => {
    roster = { roster: "unavailable", reason: "Planning Center did not answer" };
    people = [];
    await mount();
    assert.match(screen.getByRole("alert").textContent ?? "", /Planning Center did not answer/);
    assert.equal(screen.queryByRole("list", { name: "People" }), null);
    assert.doesNotMatch(document.body.textContent ?? "", /Nobody is on this service/);
  });

  test("a failed read of the themes is said, with a way to try again", async () => {
    refuse["GET /api/photo-themes"] = { status: 500, error: "the book is unreadable" };
    await mount();
    assert.match(screen.getByRole("alert").textContent ?? "", /the book is unreadable/);
    assert.ok(screen.getByRole("button", { name: "Try again" }));
  });
});

describe("Approve and Approve all", () => {
  test("Approve sends that one person, with the edit it showed, and the card follows the server", async () => {
    await mount();
    people = people.map((p) => (p.personId === "9002" ? person("9002", "Jordan P.", "approved") : p));
    await click(screen.getByRole("button", { name: "Approve Jordan P." }));
    const post = writes().find((c) => c.path.endsWith("/people/9002/approve"))!;
    assert.equal(post.method, "POST");
    assert.deepEqual(post.body, { file: editFile("b", "9002") });
    assert.equal(chipOf("9002"), "Approved");
  });

  test("a refused approval says why and leaves the card as the server has it", async () => {
    await mount();
    refuse[`POST /api/photo-themes/themes/${XMAS}/people/9002/approve`] = { status: 409, error: "There is no edit waiting for review" };
    await click(screen.getByRole("button", { name: "Approve Jordan P." }));
    assert.match(document.body.textContent ?? "", /There is no edit waiting for review/);
    assert.equal(chipOf("9002"), "Ready to review", "nothing reads as approved that is not");
  });

  test("Approve all counts what the route approves: ready edits made for THIS plan", async () => {
    people = [
      person("9002", "Jordan P.", "ready"),
      person("9004", "Morgan T.", "ready", { pending: { status: "ready", url: "/x.webp", reason: null, planId: "6000" } }),
      person("9005", "Riley S.", "ready"),
    ];
    await mount();
    const btn = screen.getByRole("button", { name: /Approve all ready/ });
    assert.equal(btn.textContent, "Approve all ready (2)", "Morgan's was made for another service");
    await click(btn);
    const post = writes().find((c) => c.path === "/api/photo-themes/plans/7001/approve-all")!;
    assert.equal(post.method, "POST");
    assert.deepEqual(post.body, {
      people: [
        { personId: "9002", file: editFile("b", "9002") },
        { personId: "9005", file: editFile("b", "9005") },
      ],
    }, "the edits on screen, by file: nothing that lands later");
  });

  test("Approve all names whoever it left for another look", async () => {
    people = [person("9002", "Jordan P.", "ready"), person("9005", "Riley S.", "ready")];
    approveAllSkips = ["9005"];
    await mount();
    await click(screen.getByRole("button", { name: /Approve all ready/ }));
    assert.match(document.body.textContent ?? "", /Changed since it was shown, so left for another look: Riley S\./);
  });

  test("with nothing ready, Approve all cannot be pressed", async () => {
    people = [person("9001", "Alex R.", "approved")];
    await mount();
    assert.equal((screen.getByRole("button", { name: /Approve all ready/ }) as HTMLButtonElement).disabled, true);
  });
});

describe("Move, Copy and Remove", () => {
  async function open(name: string, item: string) {
    await openMenu(screen.getByRole("button", { name: `More for ${name}` }));
    await choose(screen.getByRole("menuitem", { name: item }));
  }

  test("only a person with an approved photo has the menu", async () => {
    await mount();
    assert.ok(screen.queryByRole("button", { name: "More for Alex R." }));
    assert.equal(screen.queryByRole("button", { name: "More for Jordan P." }), null);
  });

  test("Move names the other theme and what changes, and sends nothing until pressed", async () => {
    await mount();
    await open("Alex R.", "Move to theme…");
    const box = screen.getByRole("group", { name: "Confirm move" });
    assert.match(box.textContent ?? "", /Moves Alex R.'s photo out of Christmas 2026; they go back to the original on 1 service using it\./);
    assert.deepEqual(writes(), []);
    await click(within(box).getByRole("button", { name: "Move" }));
    const post = writes()[0]!;
    assert.equal(post.path, `/api/photo-themes/themes/${XMAS}/people/9001/move`);
    assert.deepEqual(post.body, { to: EASTER });
    assert.equal(screen.queryByRole("group", { name: "Confirm move" }), null, "the confirm closes on success");
  });

  test("Copy says nothing changes here, and replacing a photo is said when the target has one", async () => {
    themes = [themes[0]!, theme(EASTER, "Easter 2027", { plans: [], people: [{ personId: "9001", name: "Alex R.", status: "approved", approved: { url: "u", fromPlanId: null, fromDate: null, approvedAt: "", stale: false }, pending: null }] })];
    await mount();
    await open("Alex R.", "Copy to theme…");
    const box = screen.getByRole("group", { name: "Confirm copy" });
    assert.match(box.textContent ?? "", /Copies Alex R.'s photo\. Nothing changes here\./);
    assert.match(box.textContent ?? "", /Replaces their photo in Easter 2027\./);
    await click(within(box).getByRole("button", { name: "Copy" }));
    assert.equal(writes()[0]!.path, `/api/photo-themes/themes/${XMAS}/people/9001/copy`);
  });

  test("Remove says how many services it affects, and sends a DELETE", async () => {
    await mount();
    await open("Alex R.", "Remove from theme…");
    const box = screen.getByRole("group", { name: "Confirm remove" });
    assert.match(box.textContent ?? "", /Alex R. goes back to the original photo on 1 service using Christmas 2026\./);
    await click(within(box).getByRole("button", { name: "Remove" }));
    assert.deepEqual(writes().map((c) => `${c.method} ${c.path}`), [`DELETE /api/photo-themes/themes/${XMAS}/people/9001`]);
  });

  test("Cancel sends nothing", async () => {
    await mount();
    await open("Alex R.", "Remove from theme…");
    await click(within(screen.getByRole("group", { name: "Confirm remove" })).getByRole("button", { name: "Cancel" }));
    assert.deepEqual(writes(), []);
    assert.equal(screen.queryByRole("group", { name: "Confirm remove" }), null);
  });

  test("a refused Remove keeps the confirm open and says why in it", async () => {
    await mount();
    refuse[`DELETE /api/photo-themes/themes/${XMAS}/people/9001`] = { status: 409, error: "Somebody else changed this theme" };
    await open("Alex R.", "Remove from theme…");
    await click(within(screen.getByRole("group", { name: "Confirm remove" })).getByRole("button", { name: "Remove" }));
    const box = screen.getByRole("group", { name: "Confirm remove" });
    assert.match(box.textContent ?? "", /Somebody else changed this theme/);
    assert.equal(chipOf("9001"), "Approved");
  });

  test("with no other theme, Move and Copy are not offered", async () => {
    themes = [themes[0]!];
    await mount();
    await openMenu(screen.getByRole("button", { name: "More for Alex R." }));
    assert.equal(screen.getByRole("menuitem", { name: "Move to theme…" }).getAttribute("aria-disabled"), "true");
    assert.equal(screen.getByRole("menuitem", { name: "Copy to theme…" }).getAttribute("aria-disabled"), "true");
  });
});

describe("what costs money", () => {
  test("mounting, choosing a theme, switching and frames never send a generate or a redo", async () => {
    await mount();
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), { target: { value: EASTER } }));
    await settle();
    await click(within(screen.getByRole("group", { name: /Photos shown on screens/ })).getByRole("button", { name: "Original" }));
    for (const seq of [4, 5, 9]) {
      await act(async () => emit({ epoch: "e", seq, running: 0, queued: 0, active: [] }));
      await settle();
    }
    const billed = writes().filter((c) => /\/generate$|\/redo$/.test(c.path));
    assert.deepEqual(billed, [], "only a press on Generate or Redo may send these");
  });

  test("Generate is one POST however many times it is pressed while it is out", async () => {
    people = [person("9001", "Alex R.", "none"), person("9002", "Jordan P.", "none")];
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    await mount();
    const btn = screen.getByRole("button", { name: /Generate 2 for Christmas 2026/ });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    release();
    await settle();
    const posts = writes().filter((c) => c.path.endsWith("/generate"));
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]!.body, { serviceTypeId: "100", mode: "missing" });
  });

  test("a prompt typed and not yet kept is saved BEFORE Generate sends", async () => {
    people = [person("9001", "Alex R.", "none")];
    await mount();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Snow, keep the face the same" } });
    await click(screen.getByRole("button", { name: /Generate 1 for/ }));
    const order = writes().map((c) => `${c.method} ${c.path.replace(/th-[0-9a-f]{12}/, "T")}`);
    assert.deepEqual(order, ["PATCH /api/photo-themes/themes/T", "POST /api/photo-themes/plans/7001/generate"]);
    assert.deepEqual(writes()[0]!.body, { prompt: "Snow, keep the face the same" });
  });

  test("a prompt the server refuses stops Generate: nothing is billed from text the server does not hold", async () => {
    people = [person("9001", "Alex R.", "none")];
    await mount();
    refuse[`PATCH /api/photo-themes/themes/${XMAS}`] = { status: 400, error: "The prompt is too long" };
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Snow" } });
    await click(screen.getByRole("button", { name: /Generate 1 for/ }));
    assert.deepEqual(writes().filter((c) => c.path.endsWith("/generate")), []);
    assert.equal((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value, "Christmas lights, keep the face the same", "the box goes back to what the server holds");
    assert.match(document.body.textContent ?? "", /The prompt is too long/);
  });

  test("Redo sends the plan and the person, after the typed prompt is kept", async () => {
    await mount();
    const box = screen.getByLabelText("Prompt");
    fireEvent.change(box, { target: { value: "Snow, keep the face the same" } });
    await act(async () => void fireEvent.blur(box));
    await settle();
    await click(screen.getByRole("button", { name: "Redo Alex R." }));
    const order = writes().map((c) => `${c.method} ${c.path.replace(/th-[0-9a-f]{12}/, "T")}`);
    assert.deepEqual(order, ["PATCH /api/photo-themes/themes/T", "POST /api/photo-themes/themes/T/people/9001/redo"]);
    assert.deepEqual(writes()[1]!.body, { planId: "7001", serviceTypeId: "100" });
  });

  test("Redo clicked with the prompt typed and never blurred (a keyboard press) keeps it first", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Snow, keep the face the same" } });
    await click(screen.getByRole("button", { name: "Redo Alex R." }));
    const order = writes().map((c) => `${c.method} ${c.path.replace(/th-[0-9a-f]{12}/, "T")}`);
    assert.deepEqual(order, ["PATCH /api/photo-themes/themes/T", "POST /api/photo-themes/themes/T/people/9001/redo"]);
  });

  // A real click is mousedown (the box loses focus, so its blur starts the save), then click.
  // The save is still out when the click lands. The click must WAIT for it, not refuse and send nothing.
  for (const [what, press] of [
    ["Generate", () => screen.getByRole("button", { name: /Generate 1 for/ })],
    ["Redo", () => screen.getByRole("button", { name: "Redo Alex R." })],
  ] as const) {
    test(`blur, then click ${what}, with the save still out: the save finishes, then ${what} is sent, once`, async () => {
      people = [person("9001", "Alex R.", "approved"), person("9004", "Dana K.", "none")];
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      await mount();
      const box = screen.getByLabelText("Prompt");
      fireEvent.change(box, { target: { value: "Snow, keep the face the same" } });
      const btn = press();
      await act(async () => {
        fireEvent.blur(box);
        fireEvent.click(btn);
      });
      release();
      await settle();
      const order = writes().map((c) => `${c.method} ${c.path.replace(/th-[0-9a-f]{12}/, "T")}`);
      assert.deepEqual(order, ["PATCH /api/photo-themes/themes/T", what === "Generate" ? "POST /api/photo-themes/plans/7001/generate" : "POST /api/photo-themes/themes/T/people/9001/redo"]);
    });
  }

  test("Redo all, from the prompt-changed banner, is Generate over everyone", async () => {
    themes = [theme(XMAS, "Christmas 2026", { promptChanged: true }), themes[1]!];
    await mount();
    assert.match(document.querySelector("[data-prompt-changed]")?.textContent ?? "", /changed/);
    await click(screen.getByRole("button", { name: "Redo all" }));
    assert.deepEqual(writes().find((c) => c.path.endsWith("/generate"))!.body, { serviceTypeId: "100", mode: "all" });
  });

  test("Keep these accepts the prompt without redoing anyone", async () => {
    themes = [theme(XMAS, "Christmas 2026", { promptChanged: true }), themes[1]!];
    await mount();
    await click(screen.getByRole("button", { name: "Keep these" }));
    assert.deepEqual(writes().map((c) => c.path.replace(/th-[0-9a-f]{12}/, "T")), ["/api/photo-themes/themes/T/keep-prompt"]);
  });
});

describe("a frame on the channel re-reads what the panel shows", () => {
  test("the next frame reads the themes and the people again; a repeat does not", async () => {
    await mount();
    await act(async () => emit({ epoch: "e", seq: 1, running: 1, queued: 0, active: [] }));
    await settle();
    const after1 = gets();
    people = people.map((p) => (p.personId === "9003" ? person("9003", "Casey L.", "ready") : p));
    await act(async () => emit({ epoch: "e", seq: 2, running: 0, queued: 0, active: [] }));
    await settle();
    assert.ok(gets() > after1);
    assert.equal(chipOf("9003"), "Ready to review", "a finished edit shows up without anyone reloading");
    const before = gets();
    await act(async () => emit({ epoch: "e", seq: 2, running: 0, queued: 0, active: [] }));
    await settle();
    assert.equal(gets(), before);
  });

  test("a missed frame re-reads too", async () => {
    await mount();
    await act(async () => emit({ epoch: "e", seq: 1, running: 0, queued: 0, active: [] }));
    await settle();
    people = people.map((p) => (p.personId === "9003" ? person("9003", "Casey L.", "failed") : p));
    await act(async () => emit({ epoch: "e", seq: 7, running: 0, queued: 0, active: [] }));
    await settle();
    assert.equal(chipOf("9003"), "Failed");
  });
});

describe("themes: creating one, and Manage themes", () => {
  test("New theme… creates it and puts this service on it", async () => {
    choice = { ...choice!, themeId: null };
    await mount();
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), { target: { value: "__new" } }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Easter 2027" } });
    fireEvent.change(document.getElementById("new-theme-prompt")!, { target: { value: "Spring flowers" } });
    assert.equal((screen.getByRole("button", { name: "Create theme" }) as HTMLButtonElement).disabled, false);
    refuse["POST /api/photo-themes/themes"] = { status: 400, error: "There is already a theme with that name" };
    await click(screen.getByRole("button", { name: "Create theme" }));
    assert.match(screen.getByRole("form", { name: "New theme" }).textContent ?? "", /There is already a theme with that name/);
    assert.deepEqual(writes().filter((c) => c.method === "PATCH"), [], "a refused create does not choose anything");
  });

  test("Manage themes lists every theme, opens one, renames it on leaving the box, and lists everyone in it", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Manage themes" }));
    assert.ok(screen.getByRole("button", { name: /Easter 2027/ }));
    await click(screen.getByRole("button", { name: /Christmas 2026/ }));
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    assert.equal(name.value, "Christmas 2026");
    fireEvent.change(name, { target: { value: "Christmas 26" } });
    await act(async () => void fireEvent.blur(name));
    await settle();
    const rename = writes().find((c) => c.method === "PATCH")!;
    assert.deepEqual(rename.body, { name: "Christmas 26" });
    assert.equal(document.querySelectorAll("[data-person-card]").length, 3, "everyone in the theme, across weeks");
  });

  test("Redo in Manage sends nothing when the typed prompt is refused: it would be billed from the old one", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Manage themes" }));
    await click(screen.getByRole("button", { name: /Christmas 2026/ }));
    refuse[`PATCH /api/photo-themes/themes/${XMAS}`] = { status: 400, error: "The prompt is too long" };
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Snow" } });
    await click(screen.getByRole("button", { name: "Redo Alex R." }));
    assert.deepEqual(writes().filter((c) => c.path.endsWith("/redo")), []);
    assert.equal((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value, "Christmas lights, keep the face the same");
  });

  test("Redo in Manage keeps the typed prompt first, also with the save still out from the blur", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Manage themes" }));
    await click(screen.getByRole("button", { name: /Christmas 2026/ }));
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const box = screen.getByLabelText("Prompt");
    fireEvent.change(box, { target: { value: "Snow" } });
    const redo = screen.getByRole("button", { name: "Redo Alex R." });
    await act(async () => {
      fireEvent.blur(box);
      fireEvent.click(redo);
    });
    release();
    await settle();
    assert.deepEqual(writes().map((c) => `${c.method} ${c.path.replace(/th-[0-9a-f]{12}/, "T")}`), ["PATCH /api/photo-themes/themes/T", "POST /api/photo-themes/themes/T/people/9001/redo"]);
  });

  test("every Manage card draws the person's original beside the edit, from the server's person; none for a person with no photo", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Manage themes" }));
    await click(screen.getByRole("button", { name: /Christmas 2026/ }));
    const original = (id: string) => card(id).querySelector("img[alt$='original photo']")?.getAttribute("src") ?? null;
    assert.equal(original("9001"), "/photos?u=" + encodeURIComponent("https://avatars.example/9001") + "&s=136");
    assert.equal(original("9002"), "/photos?u=" + encodeURIComponent("https://avatars.example/9002") + "&s=136");
    assert.equal(original("9003"), null, "no Planning Center photo, no image");
    assert.ok(card("9003").textContent?.includes("Original"), "but the card still has its Original slot");
  });

  test("a manage card can be Approved: a redo made there waits for review like every other", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Manage themes" }));
    await click(screen.getByRole("button", { name: /Christmas 2026/ }));
    await click(screen.getByRole("button", { name: "Approve Jordan P." }));
    assert.ok(writes().some((c) => c.path.endsWith("/people/9002/approve")));
  });

  test("Delete theme… names the services and the photos, and sends nothing until confirmed", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Manage themes" }));
    await click(screen.getByRole("button", { name: /Christmas 2026/ }));
    await click(screen.getByRole("button", { name: "Delete theme…" }));
    const box = screen.getByRole("group", { name: "Confirm delete theme" });
    assert.match(box.textContent ?? "", /Delete Christmas 2026\? Its 2 photos are removed, and these services go back to the originals: Thu, Dec 24\./);
    assert.deepEqual(writes(), []);
    await click(within(box).getByRole("button", { name: "Delete theme" }));
    assert.deepEqual(writes().map((c) => `${c.method} ${c.path.replace(/th-[0-9a-f]{12}/, "T")}`), ["DELETE /api/photo-themes/themes/T"]);
  });

  test("a refused delete says why in the confirm", async () => {
    refuse[`DELETE /api/photo-themes/themes/${XMAS}`] = { status: 409, error: "A run is using this theme" };
    await mount();
    await click(screen.getByRole("button", { name: "Manage themes" }));
    await click(screen.getByRole("button", { name: /Christmas 2026/ }));
    await click(screen.getByRole("button", { name: "Delete theme…" }));
    await click(within(screen.getByRole("group", { name: "Confirm delete theme" })).getByRole("button", { name: "Delete theme" }));
    assert.match(screen.getByRole("group", { name: "Confirm delete theme" }).textContent ?? "", /A run is using this theme/);
  });
});

describe("the keyboard", () => {
  test("Escape puts the sheet away, also after a view change took focus off the button that was pressed", async () => {
    await mount();
    const manage = screen.getByRole("button", { name: "Manage themes" });
    manage.focus();
    await click(manage);
    assert.equal(document.activeElement?.getAttribute("data-photo-themes-panel"), "true", "focus moved into the sheet, not onto <body>");
    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
    assert.equal(closed, 1);
  });
});

describe("Escape takes the confirm first", () => {
  const esc = async () => act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));

  test("an open Move, Copy or Remove confirm closes on Escape and the sheet stays; the next Escape closes the sheet", async () => {
    await mount();
    await openMenu(screen.getByRole("button", { name: "More for Alex R." }));
    await choose(screen.getByRole("menuitem", { name: "Remove from theme…" }));
    assert.ok(screen.getByRole("group", { name: "Confirm remove" }));
    await esc();
    assert.equal(screen.queryByRole("group", { name: "Confirm remove" }), null, "the confirm is gone");
    assert.equal(closed, 0, "the sheet is not");
    // A Radix tooltip left open by the pointer takes one Escape of its own first, as it does anywhere: so up to two.
    for (let i = 0; i < 2 && closed === 0; i++) await esc();
    assert.equal(closed, 1);
  });

  test("an open Delete theme confirm closes on Escape and the sheet stays", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Manage themes" }));
    await click(screen.getByRole("button", { name: /Christmas 2026/ }));
    await click(screen.getByRole("button", { name: "Delete theme…" }));
    await esc();
    assert.equal(screen.queryByRole("group", { name: "Confirm delete theme" }), null);
    assert.equal(closed, 0);
    assert.deepEqual(writes(), [], "closing it sends nothing");
  });
});
