// History's Edit times mode, on individual items.
//
// Driven through the REAL renderer/lib/api.ts — fetch routed by URL, SSE via a
// fake EventSource, the same approach history-arriving.test.tsx uses — because
// what has to hold is that pressing Save actually POSTs the right ISO stamps to
// the right run. A stub of `invoke` would assert that the component called a
// function this file also wrote, which is not evidence about anything.
//
// The server applies the item-time overlay, so the fake here answers the record
// the server would: raw items plus `itemTimeEdits` produce a row carrying the
// EFFECTIVE stamps and an `editedFrom`. That is the contract
// main/services/history-item-times.ts is tested against separately.
//
// NOT asserted here, deliberately: jsdom lays nothing out and loads no
// stylesheet, so the grid template that has to gain a column for Started, the
// widths the two time fields need, and the `max-sm:hidden` that keeps them off
// a phone are all invisible to it — every offsetWidth is 0 and no class has any
// effect. Those were checked in a real browser instead. What is asserted is what
// rendered and what was sent.

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }
  close(): void {}
  push(channel: string, payload: unknown): void {
    for (const fn of this.listeners.get(channel) ?? []) fn({ data: JSON.stringify(payload) } as MessageEvent);
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const KEY = "weekend:plan-1:2026-09-17";
/** Local stamps, so the HH:MM:SS the fields show is predictable under any TZ. */
const iso = (hhmmss: string) => new Date(`2026-09-17T${hhmmss}`).toISOString();

const WINDOW_START = iso("20:15:00");
const WINDOW_END = iso("21:45:00");
const PREROLL_RECORDED_END = iso("20:26:22"); // 11:22
const PREROLL_FIXED_END = iso("20:17:00"); //    2:00

interface Item {
  itemId: string;
  title: string;
  sequence: number;
  plannedLengthSec: number | null;
  startedAt: string;
  endedAt: string | null;
  actualDurationSec: number | null;
  editedFrom?: { startedAt: string; endedAt: string | null; actualDurationSec: number | null };
}

function timeline(items: Item[]) {
  return {
    serviceKey: KEY,
    serviceTypeId: "weekend",
    serviceTypeName: "Weekend",
    planId: "plan-1",
    planTitle: "Evening",
    seriesTitle: null,
    serviceDate: "2026-09-17",
    serviceTimeId: "evening",
    serviceTimeStartsAt: WINDOW_START,
    startedAt: WINDOW_START,
    endedAt: WINDOW_END,
    items,
  };
}

/** As recorded: the pre-roll reads 11:22 against a 2:00 plan. */
const recorded = (): Item[] => [
  { itemId: "vid-1", title: "VIDEO: Pre-roll", sequence: 0, plannedLengthSec: 120, startedAt: WINDOW_START, endedAt: PREROLL_RECORDED_END, actualDurationSec: 682 },
  { itemId: "wel-1", title: "Welcome", sequence: 1, plannedLengthSec: 300, startedAt: PREROLL_RECORDED_END, endedAt: iso("20:31:22"), actualDurationSec: 300 },
];

/** What the server's overlay answers once the end has been corrected. */
const corrected = (): Item[] => [
  {
    ...recorded()[0],
    endedAt: PREROLL_FIXED_END,
    actualDurationSec: 120,
    editedFrom: { startedAt: WINDOW_START, endedAt: PREROLL_RECORDED_END, actualDurationSec: 682 },
  },
  recorded()[1],
];

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

function installFetch(state: { items: Item[]; posts: Posted[] }) {
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    input: unknown,
    init?: { method?: string; body?: string },
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (method === "POST") {
      state.posts.push({ url, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
      return ok({ ok: true });
    }
    if (url === "/api/service-timeline") return ok([timeline(state.items)]);
    if (url === "/api/attendance/history") return ok([]);
    if (url === "/api/spl/summary") return ok([]);
    if (url === "/api/spl/trend") return ok({ shown: false, metric: null });
    if (url === "/api/baptism/sessions") return ok([]);
    if (/^\/api\/service-timeline\/[^/]+$/.test(url)) return ok(timeline(state.items));
    if (/^\/api\/attendance\/history\/[^/]+$/.test(url)) return ok(null);
    if (/^\/api\/spl\/history\/[^/]+$/.test(url)) return ok(null);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
}

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider, ConfirmHost } = await import("../../components/ui/index.js");

function mountSection(Section: React.ComponentType) {
  return render(
    React.createElement(TooltipProvider, null, React.createElement(Section), React.createElement(ConfirmHost)),
  );
}

after(() => unmountAndTeardown(cleanup, teardown));

const text = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const buttonNamed = (view: { container: HTMLElement }, label: string) =>
  [...view.container.querySelectorAll("button")].find((b) => text(b as HTMLElement) === label) as
    | HTMLButtonElement
    | undefined;
/** A row's own control. Queried by aria-label, NOT by visible text: the service
 *  window form above the table has its own "Save", and matching on the word
 *  found that one instead — silently, on a row nobody had touched. */
const rowButton = (view: { container: HTMLElement }, label: string) =>
  view.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

/** Open the one service and press Edit times. */
async function openInEditMode(Section: React.ComponentType) {
  const view = mountSection(Section);
  await settle();
  await settle();
  const row = [...view.container.querySelectorAll("button")].find((b) => text(b as HTMLElement).includes("Evening"));
  assert.ok(row, "the service row never rendered");
  fireEvent.click(row!);
  await settle();
  await settle();
  const edit = buttonNamed(view, "Edit times");
  assert.ok(edit, "the Edit times button never rendered");
  fireEvent.click(edit!);
  await settle();
  return view;
}

describe("History: correcting one item's recorded times", () => {
  let ServiceHistorySection: typeof import("./service-history-section.js").ServiceHistorySection;
  let editedTooltipText: typeof import("./service-history-section.js").editedTooltip;

  before(async () => {
    ({ ServiceHistorySection, editedTooltip: editedTooltipText } = await import("./service-history-section.js"));
  });

  beforeEach(() => cleanup());

  test("the item table gains a Started column, and Edit times turns both stamps into fields", async (t) => {
    const state = { items: recorded(), posts: [] as Posted[] };
    installFetch(state);
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    fireEvent.click([...view.container.querySelectorAll("button")].find((b) => text(b as HTMLElement).includes("Evening"))!);
    await settle();
    await settle();

    // Scoped to the table's own header row. A first version matched "Started"
    // anywhere on the page and passed with the column deleted — the Started STAT
    // TILE above the table carries the same word.
    const header = view.container.querySelector<HTMLElement>('[data-testid="rundown-header"]');
    assert.ok(header, "the rundown table never rendered");
    assert.equal(text(header!), "#ItemPlanActualΔStartedEnded", "the rundown header's columns");
    assert.equal(
      view.container.querySelectorAll('input[type="time"]').length,
      0,
      "the item stamps must be plain text until Edit times is on",
    );

    fireEvent.click(buttonNamed(view, "Edit times")!);
    await settle();

    const fields = [...view.container.querySelectorAll('input[type="time"]')] as HTMLInputElement[];
    // 2 for the service window + 2 per item row.
    assert.equal(fields.length, 6, `expected the window pair plus a pair per item, got ${fields.length}`);
    const preroll = view.container.querySelector<HTMLInputElement>('input[aria-label="Ended — VIDEO: Pre-roll"]');
    assert.ok(preroll, "the pre-roll's Ended field never rendered");
    assert.equal(preroll!.value, "20:26:22", "the field must open on the recorded time, to the second");
    assert.equal(preroll!.step, "1", "a minute-resolution field cannot express a 2:00 item");
  });

  test("saving a row POSTs that run's ISO stamps and nothing else", async (t) => {
    const state = { items: recorded(), posts: [] as Posted[] };
    installFetch(state);
    const view = await openInEditMode(ServiceHistorySection);
    t.after(() => cleanup());

    assert.equal(
      rowButton(view, "Save times — VIDEO: Pre-roll") == null,
      true,
      "Save must not be offered on a row nobody has touched",
    );

    const ended = view.container.querySelector<HTMLInputElement>('input[aria-label="Ended — VIDEO: Pre-roll"]')!;
    fireEvent.change(ended, { target: { value: "20:17:00" } });
    await settle();

    const save = rowButton(view, "Save times — VIDEO: Pre-roll");
    assert.ok(save, "Save never appeared for the row that was edited");
    fireEvent.click(save!);
    await settle();
    await settle();

    const post = state.posts.find((p) => p.url === "/api/history/item-times");
    assert.ok(post, `nothing was POSTed to /api/history/item-times: ${JSON.stringify(state.posts)}`);
    assert.equal(post!.body.serviceKey, KEY);
    assert.equal(post!.body.itemId, "vid-1");
    assert.equal(post!.body.sequence, 0, "the RUN, not just the plan item");
    assert.equal(post!.body.endedAt, PREROLL_FIXED_END);
    assert.equal(
      post!.body.startedAt,
      null,
      "an untouched field must send null, not an override — the fields carry whole seconds and the " +
        "recorder writes milliseconds, so sending Started back marks the row edited for a field nobody touched",
    );
  });

  test("a field typed back to what was recorded clears that override", async (t) => {
    const state = { items: corrected(), posts: [] as Posted[] };
    installFetch(state);
    const view = await openInEditMode(ServiceHistorySection);
    t.after(() => cleanup());

    const ended = view.container.querySelector<HTMLInputElement>('input[aria-label="Ended — VIDEO: Pre-roll"]')!;
    assert.equal(ended.value, "20:17:00", "precondition: the field opens on the EFFECTIVE time");
    fireEvent.change(ended, { target: { value: "20:26:22" } }); // back to the recorded end
    await settle();
    fireEvent.click(rowButton(view, "Save times — VIDEO: Pre-roll")!);
    await settle();
    await settle();

    const post = state.posts.find((p) => p.url === "/api/history/item-times");
    assert.ok(post, "nothing was POSTed");
    assert.equal(post!.body.endedAt, null, "typing the recorded time back must CLEAR the override");
    assert.equal(post!.body.startedAt, null);
  });

  test("an edited row shows the marker, its recorded-vs-edited tooltip, and a Reset", async (t) => {
    const state = { items: corrected(), posts: [] as Posted[] };
    installFetch(state);
    const view = await openInEditMode(ServiceHistorySection);
    t.after(() => cleanup());

    const txt = text(view.container);
    assert.ok(txt.includes("edited"), `the edited marker never rendered: ${txt}`);

    const marker = [...view.container.querySelectorAll("span")].find((s) => text(s as HTMLElement) === "edited");
    assert.ok(marker, "no element carries the edited marker");
    // The tooltip's own text is only in the DOM while it is open, so what is
    // asserted here is the label the component computes for it — the same string
    // Tooltip renders. Opening a Radix tooltip needs a pointer this DOM does not
    // have; it was driven in a browser instead.
    assert.equal(
      editedTooltipText(corrected()[0]),
      "recorded 11:22, edited to 2:00",
      "the tooltip must name the recorded duration and the edited one",
    );

    const reset = rowButton(view, "Reset times — VIDEO: Pre-roll");
    assert.ok(reset, "no Reset on an edited row");
    fireEvent.click(reset!);
    await settle();
    await settle();

    const post = state.posts.find((p) => p.url === "/api/history/item-times");
    assert.ok(post, "Reset sent nothing");
    assert.equal(post!.body.startedAt, null, "Reset must CLEAR the override, not restate it");
    assert.equal(post!.body.endedAt, null);
  });

  test("the row shows the effective time from the ROUTE's answer, with no broadcast", async (t) => {
    // The panel used to discard the answer and wait for the SSE push. The answer
    // IS the authority — it is the record the server stored, overlay applied —
    // and waiting left the row on its old value for the round trip, and forever
    // on a client whose stream had dropped. No push is delivered in this test at
    // all; the row must still be right.
    const state = { items: recorded(), posts: [] as Posted[] };
    installFetch(state);
    // The route answers the corrected record, which is what the real one does.
    const previous = (globalThis as unknown as { fetch: (i: unknown, x?: unknown) => Promise<unknown> }).fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: string }) => {
      if ((init?.method ?? "GET") === "POST") {
        state.posts.push({ url: String(input), body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
        const body = timeline(corrected());
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      return previous(input, init);
    };

    const view = await openInEditMode(ServiceHistorySection);
    t.after(() => cleanup());

    const ended = view.container.querySelector<HTMLInputElement>('input[aria-label="Ended — VIDEO: Pre-roll"]')!;
    fireEvent.change(ended, { target: { value: "20:17:00" } });
    await settle();
    fireEvent.click(rowButton(view, "Save times — VIDEO: Pre-roll")!);
    await settle();
    await settle();

    assert.equal(FakeEventSource.last?.readyState, 1, "precondition: nothing was pushed over SSE in this test");
    const txt = text(view.container);
    assert.ok(txt.includes("edited"), `the row did not re-render from the answer: ${txt}`);
    assert.ok(txt.includes("2:00"), `the row still shows the old duration: ${txt}`);
    assert.ok(!txt.includes("11:22"), `the recorded duration is still on the page: ${txt}`);
  });

  test("Reset stays reachable while the row is being retyped", async (t) => {
    // Hidden while dirty, an operator who started retyping had no way back to the
    // recording without first undoing their own typing — and mid-edit is exactly
    // when "put it back" is wanted.
    const state = { items: corrected(), posts: [] as Posted[] };
    installFetch(state);
    const view = await openInEditMode(ServiceHistorySection);
    t.after(() => cleanup());

    assert.ok(rowButton(view, "Reset times — VIDEO: Pre-roll"), "precondition: Reset is offered on an edited row");
    const ended = view.container.querySelector<HTMLInputElement>('input[aria-label="Ended — VIDEO: Pre-roll"]')!;
    fireEvent.change(ended, { target: { value: "20:19:00" } });
    await settle();

    assert.ok(rowButton(view, "Save times — VIDEO: Pre-roll"), "precondition: the row is dirty");
    assert.ok(
      rowButton(view, "Reset times — VIDEO: Pre-roll"),
      "Reset vanished the moment the operator started typing",
    );
  });

  test("an OPEN item's Ended takes any typed value — there is no recorded end to match", async (t) => {
    // Compared against the START, as this used to be, typing the item's own start
    // time into its empty Ended field read as "unchanged" and silently cleared
    // it. An item with no recorded end has nothing for a typed value to match.
    const open: Item[] = [
      { ...recorded()[0], endedAt: null, actualDurationSec: null },
      recorded()[1],
    ];
    const state = { items: open, posts: [] as Posted[] };
    installFetch(state);
    const view = await openInEditMode(ServiceHistorySection);
    t.after(() => cleanup());

    const ended = view.container.querySelector<HTMLInputElement>('input[aria-label="Ended — VIDEO: Pre-roll"]')!;
    assert.equal(ended.value, "", "precondition: an open item's Ended field is empty");
    // The item's OWN start time, which the old comparison treated as a no-op.
    fireEvent.change(ended, { target: { value: "20:15:00" } });
    await settle();
    fireEvent.click(rowButton(view, "Save times — VIDEO: Pre-roll")!);
    await settle();
    await settle();

    const post = state.posts.find((p) => p.url === "/api/history/item-times");
    assert.ok(post, "nothing was POSTed");
    assert.equal(post!.body.endedAt, WINDOW_START, "the typed end must be SENT, not silently cleared");
  });

  test("Actual, delta and the service tiles all read the effective times", async (t) => {
    const state = { items: corrected(), posts: [] as Posted[] };
    installFetch(state);
    const view = mountSection(ServiceHistorySection);
    t.after(() => cleanup());
    await settle();
    await settle();
    fireEvent.click([...view.container.querySelectorAll("button")].find((b) => text(b as HTMLElement).includes("Evening"))!);
    await settle();
    await settle();

    const txt = text(view.container);
    assert.ok(txt.includes("2:00"), `the row's Actual still reads the recorded duration: ${txt}`);
    assert.ok(!txt.includes("11:22"), `the recorded 11:22 is still on the page outside the tooltip: ${txt}`);
    // Actual = 2:00 + 5:00 = 7:00 across the two counted items; on the recorded
    // times it would have been 16:22.
    assert.ok(txt.includes("7:00"), `the Actual tile does not follow the correction: ${txt}`);
    assert.ok(!txt.includes("16:22"), `the Actual tile still sums the recorded durations: ${txt}`);
  });
});
