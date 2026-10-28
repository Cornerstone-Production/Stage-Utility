// video-relay-ffmpeg.test.tsx — Advanced's ffmpeg row: the status read from
// GET /api/video/ffmpeg, a missing ffmpeg naming its install command, and Save
// PATCHing the path and showing the fresh status.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, fireEvent, screen } = await import("@testing-library/react");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { VideoRelayFfmpegPanel } = await import("./video-relay-ffmpeg.js");

type FfmpegStatus = import("@main/types/video").FfmpegStatus;

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

const MISSING: FfmpegStatus = { ok: false, reason: "ffmpeg is not installed on this server", hint: "brew install ffmpeg" };
const FOUND: FfmpegStatus = { ok: true, version: "9.0", source: "configured" };

function respond(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => "" } as unknown as Response;
}

async function renderPanel(initial: FfmpegStatus, afterSave: FfmpegStatus, opts: { failFirstReads?: number } = {}) {
  let readsToFail = opts.failFirstReads ?? 0;
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });
    if (method === "GET" && url.endsWith("/api/video/ffmpeg")) {
      if (readsToFail-- > 0) return respond({ error: "server is busy" }, 500);
      return respond({ path: "", status: initial });
    }
    if (method === "PATCH" && url.endsWith("/api/video/ffmpeg")) return respond({ status: afterSave });
    return respond({});
  }) as typeof fetch;
  render(<VideoRelayFfmpegPanel />);
  await settle();
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test("a missing ffmpeg says so and names the install command", async () => {
  const c = await renderPanel(MISSING, FOUND);
  try {
    await eventually(() => {
      const line = screen.getByRole("status").textContent ?? "";
      assert.match(line, /ffmpeg is not installed on this server/);
      assert.match(line, /brew install ffmpeg/);
    });
  } finally {
    c.restore();
  }
});

test("Save PATCHes the path and shows the status it answers with", async () => {
  const c = await renderPanel(MISSING, FOUND);
  try {
    await eventually(() => assert.equal(screen.getByRole("textbox", { name: "ffmpeg path" }).hasAttribute("disabled"), false));
    fireEvent.change(screen.getByRole("textbox", { name: "ffmpeg path" }), { target: { value: "/opt/x/ffmpeg" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check again" }));
    await settle();
    await eventually(() => assert.equal(screen.getByRole("status").textContent, "ffmpeg 9.0, at the path set above"));
    const patched = c.calls.find((call) => call.method === "PATCH");
    assert.deepEqual(patched?.body, { path: "/opt/x/ffmpeg" });
  } finally {
    c.restore();
  }
});

test("a failed first read shows the error with Retry, leaves the path editable, and Retry reads again", async () => {
  const c = await renderPanel(MISSING, FOUND, { failFirstReads: 1 });
  try {
    await eventually(() => assert.match(screen.getByRole("alert").textContent ?? "", /busy|500|failed/i));
    assert.equal(screen.getByRole("textbox", { name: "ffmpeg path" }).hasAttribute("disabled"), false, "the controls are not left disabled");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    await eventually(() => assert.match(screen.getByRole("status").textContent ?? "", /not installed/));
    assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
    assert.equal(c.calls.filter((call) => call.method === "GET").length, 2);
  } finally {
    c.restore();
  }
});

test("a found ffmpeg says how it was found, and no folder", async () => {
  for (const [source, words] of [["automatic", "found automatically"], ["homebrew", "found in a Homebrew folder"]] as const) {
    const c = await renderPanel({ ok: true, version: "9.0", source }, FOUND);
    try {
      await eventually(() => assert.equal(screen.getByRole("status").textContent, `ffmpeg 9.0, ${words}`));
    } finally {
      c.restore();
      cleanup();
    }
  }
});
