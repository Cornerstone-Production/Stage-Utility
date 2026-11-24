// usePhotoThemes over a stubbed server, counting what goes out.
//
// The policy is photo-themes-sync.test.ts as a function. What this proves is the
// wiring: that a frame on the real channel makes the real query fetch again, that
// a replayed one and a repeat do not, and that mounting, choosing and switching
// never send a photo to OpenAI. The last matters because generate and redo bill.

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
function emit(payload: unknown): void {
  for (const h of [...(sseHandlers.get("photo-themes:changed") ?? [])]) h({ data: JSON.stringify(payload) });
}

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { usePhotoThemes } = await import("./use-photo-themes.js");
const { __resetReplayCacheForTests } = await import("../../../lib/api.js");

const PLAN = { planId: "7001", serviceTypeId: "100", sortDate: "2026-12-20T00:00:00Z" };
const STATE = {
  themes: [{ id: "th-aaaaaaaaaaaa", name: "Christmas", prompt: "p", promptChanged: false, createdAt: "", lastUsedDate: null, keptUntil: "2027-03-20", plans: [], people: [] }],
  plans: [{ planId: "7001", serviceTypeId: "100", sortDate: null, themeId: "th-aaaaaaaaaaaa", show: "themed" }],
  connection: { method: "api-key", hint: "sk-…3f2a", state: "connected", reason: null, checkedAt: null },
  running: 0,
  queued: 0,
};

let calls: { method: string; url: string }[] = [];
const realFetch = globalThis.fetch;
const gets = () => calls.filter((c) => c.method === "GET" && c.url === "/api/photo-themes").length;
const posts = () => calls.filter((c) => c.method !== "GET");

const frame = (seq: number, epoch = "e1") => ({ epoch, seq, running: 0, queued: 0, active: [] });

/** Renders of every Probe: a frame that changes nothing must not re-render the page the hook is in. */
let renders = 0;
function Probe({ label }: { label: string }) {
  renders++;
  const photos = usePhotoThemes(PLAN);
  return React.createElement("p", { "data-probe": label }, `${photos.choice?.show ?? "none"}|${photos.theme?.name ?? "no theme"}|${photos.hasApproved}`);
}

let client: InstanceType<typeof QueryClient> | null = null;
async function mount(...labels: string[]) {
  client ??= new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } });
  render(React.createElement(QueryClientProvider, { client }, ...labels.map((l) => React.createElement(Probe, { key: l, label: l }))));
  await settle();
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

beforeEach(() => {
  cleanup();
  calls = [];
  sseHandlers.clear();
  __resetReplayCacheForTests();
  client = null;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (isPlumbing(url)) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" } as unknown as Response;
    calls.push({ method: init?.method ?? "GET", url });
    return { ok: true, status: 200, statusText: "OK", json: async () => STATE } as unknown as Response;
  }) as typeof fetch;
});
afterEach(async () => {
  cleanup();
  await settle();
  client?.clear();
});
after(async () => {
  await settle();
  globalThis.fetch = realFetch;
  teardown();
});

describe("what a photo-themes:changed frame makes the page read", () => {
  test("mounting reads the themes once, and the plan's theme comes out of it", async () => {
    await mount("a");
    assert.equal(gets(), 1);
    assert.equal(document.querySelector("[data-probe=a]")?.textContent, "themed|Christmas|false");
  });

  test("the next frame reads again; the same frame twice reads once", async () => {
    await mount("a");
    await act(async () => emit(frame(10)));
    await settle();
    assert.equal(gets(), 2, "the first live frame has nothing to compare against, so it reads");
    await act(async () => emit(frame(11)));
    await settle();
    assert.equal(gets(), 3, "seq 11 follows 10: a finished edit is only ever a new seq");
    await act(async () => emit(frame(11)));
    await settle();
    assert.equal(gets(), 3, "the same seq again is nothing new");
  });

  test("a frame that changes nothing renders nothing: the whole Mic slots page sits on this hook", async () => {
    await mount("a");
    await act(async () => emit(frame(10)));
    await settle();
    const before = renders;
    await act(async () => emit(frame(10)));
    await settle();
    assert.equal(renders - before, 0);
  });

  test("a gap reads again and says a frame was missed", async () => {
    await mount("a");
    await act(async () => emit(frame(10)));
    await settle();
    const before = gets();
    const logged: string[] = [];
    const info = console.info;
    console.info = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await act(async () => emit(frame(14)));
      await settle();
    } finally {
      console.info = info;
    }
    assert.equal(gets(), before + 1);
    assert.ok(logged.some((l) => l.startsWith("[photo-themes]") && /missed/.test(l)), `logged: ${logged.join(" | ")}`);
  });

  test("a new epoch reads again whatever its seq", async () => {
    await mount("a");
    await act(async () => emit(frame(10)));
    await settle();
    const before = gets();
    await act(async () => emit(frame(11, "e2")));
    await settle();
    assert.equal(gets(), before + 1);
    // And when the restarted server's first frame repeats the seq this page last saw.
    await act(async () => emit(frame(11, "e3")));
    await settle();
    assert.equal(gets(), before + 2, "a new epoch is a restart even when its seq is the one already seen");
  });

  test("a replayed frame, from the cache a later page mounts onto, reads nothing", async () => {
    await mount("a");
    await act(async () => emit(frame(10)));
    await settle();
    const before = gets();
    // A second page mounting later is handed the cached last frame as a replay.
    await mount("a", "b");
    const afterMount = gets();
    // The query already holds data and is fresh, so mounting reads nothing, and
    // the replay adds no read of its own.
    assert.equal(afterMount - before, 0, "a replayed frame must not read");
    await act(async () => emit(frame(11)));
    await settle();
    assert.ok(gets() > afterMount, "and a live frame after the replay still reads: the replay was its baseline");
  });

  test("nothing a page does on mount or a frame sends a write", async () => {
    await mount("a");
    for (const seq of [10, 11, 15]) {
      await act(async () => emit(frame(seq)));
      await settle();
    }
    assert.deepEqual(posts(), [], "mount and frames are reads; generate and redo bill, and only a press sends them");
  });
});
