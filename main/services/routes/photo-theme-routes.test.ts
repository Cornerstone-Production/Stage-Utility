// The photo theme routes: every input checked on the server before anything is
// looked up, every refusal a 4xx with the reason, and the OpenAI key in no
// answer, whatever was asked.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-photo-theme-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { photoThemeRoutes } = await import("./photo-theme-routes.js");
const { callRoute } = await import("./route-harness.js");
const { photoThemes } = await import("../photo-themes/service.js");
const { errorBody, fakeServer, pcoPhoto, startFakeOpenAi } = await import("../photo-themes/photo-themes-harness.js");

const KEY = "sk-canary-routes-".padEnd(40, "r");
const answers: string[] = [];
let fake: Awaited<ReturnType<typeof startFakeOpenAi>>;

async function call(p: string, method = "GET", body?: unknown) {
  const r = await callRoute(photoThemeRoutes, p, { method, ...(body !== undefined ? { body } : {}) });
  answers.push(r.body);
  return r;
}

before(async () => {
  fake = await startFakeOpenAi();
  process.env.STAGE_UTILITY_OPENAI_BASE_URL = fake.base;
  const srv = await fakeServer();
  srv.rosters.set("2001", [{ personId: "1001", name: "Alex R.", photoUrl: pcoPhoto("1001") }]);
  await photoThemes.start(srv.deps, { sweep: false });
});
after(async () => {
  photoThemes.stop();
  await fake.close();
  delete process.env.STAGE_UTILITY_OPENAI_BASE_URL;
});

describe("the OpenAI key", () => {
  it("refuses what cannot be a key", async () => {
    for (const apiKey of [undefined, 42, "", "sk-short", "sk-has a space in it 0123456789", "sk-0123456789abcdef\u0000ghijk", "x".repeat(600)]) {
      const r = await call("/api/openai/key", "PUT", { apiKey });
      assert.equal(r.status, 400, String(apiKey));
    }
    assert.equal((await call("/api/openai/key", "PUT", [KEY])).status, 400, "a body that is not an object");
    assert.deepEqual((await call("/api/openai")).json, { method: null, hint: null, state: "not-connected", reason: null, checkedAt: null });
  });

  it("saves one, answers with its hint, tests it and removes it", async () => {
    const saved = await call("/api/openai/key", "PUT", { apiKey: `  ${KEY}  ` });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { method: "api-key", hint: "sk-…rrrr", state: "unchecked", reason: null, checkedAt: null });
    fake.models = () => ({ status: 200, body: { data: [] } });
    assert.equal(((await call("/api/openai/test", "POST")).json as { state: string }).state, "connected");
    assert.equal(fake.requests.at(-1)!.authorization, `Bearer ${KEY}`, "trimmed before it was kept");
    fake.models = () => ({ status: 401, body: errorBody("invalid_api_key", null, KEY) });
    const failed = (await call("/api/openai/test", "POST")).json as { state: string; reason: string };
    assert.deepEqual([failed.state, failed.reason], ["invalid-key", "OpenAI rejected the API key"]);
    assert.equal(((await call("/api/openai/key", "DELETE")).json as { state: string }).state, "not-connected");
    await call("/api/openai/key", "PUT", { apiKey: KEY });
  });
});

describe("themes", () => {
  it("refuses a name or prompt that breaks a rule", async () => {
    const cases: [unknown, number][] = [
      [{ prompt: "x" }, 400],
      [{ name: "", prompt: "x" }, 400],
      [{ name: "   ", prompt: "x" }, 400],
      [{ name: "a".repeat(81), prompt: "x" }, 400],
      [{ name: "Two\nlines", prompt: "x" }, 400],
      [{ name: "Fine" }, 400],
      [{ name: "Fine", prompt: "p".repeat(2001) }, 400],
      [{ name: "Fine", prompt: "bell\u0007" }, 400],
      [{ name: "Fine", prompt: 7 }, 400],
    ];
    for (const [body, status] of cases) assert.equal((await call("/api/photo-themes/themes", "POST", body)).status, status, JSON.stringify(body));
  });

  it("creates, renames, keeps a prompt and deletes, checking every id first", async () => {
    const created = await call("/api/photo-themes/themes", "POST", { name: " Christmas 2026 ", prompt: "Warm\nlights" });
    assert.equal(created.status, 201);
    const id = (created.json as { id: string; name: string }).id;
    assert.match(id, /^th-[0-9a-f]{12}$/);
    assert.equal((created.json as { name: string }).name, "Christmas 2026");

    assert.equal((await call("/api/photo-themes/themes/nope", "PATCH", { name: "X" })).status, 400);
    assert.equal((await call("/api/photo-themes/themes/th-000000000000", "PATCH", { name: "X" })).status, 404);
    assert.equal((await call(`/api/photo-themes/themes/${id}`, "PATCH", {})).status, 400);
    assert.equal((await call(`/api/photo-themes/themes/${id}`, "PATCH", { name: "Advent" })).status, 200);
    assert.equal((await call(`/api/photo-themes/themes/${id}/keep-prompt`, "POST")).status, 200);
    assert.equal((await call("/api/photo-themes/themes/__proto__/keep-prompt", "POST")).status, 400);

    // People: a person id is digits; a target is a theme id.
    assert.equal((await call(`/api/photo-themes/themes/${id}/people/AC1001/approve`, "POST")).status, 400);
    assert.equal((await call(`/api/photo-themes/themes/${id}/people/1001/approve`, "POST", { file: "0123456789abcdef.webp" })).status, 404);
    assert.equal((await call(`/api/photo-themes/themes/${id}/people/1001/move`, "POST", { to: "elsewhere" })).status, 400);
    assert.equal((await call(`/api/photo-themes/themes/${id}/people/1001/redo`, "POST", { planId: "2001" })).status, 400);
    assert.equal((await call(`/api/photo-themes/themes/${id}/people/1001`, "DELETE")).status, 404);
    assert.equal((await call(`/api/photo-themes/themes/${id}`, "DELETE")).status, 200);
    assert.equal((await call(`/api/photo-themes/themes/${id}`, "DELETE")).status, 404);
  });
});

describe("plans", () => {
  it("refuses a plan id, service type, theme, show or date that is not one", async () => {
    const theme = (await call("/api/photo-themes/themes", "POST", { name: "Easter", prompt: "Spring" })).json as { id: string };
    const cases: [string, unknown, number][] = [
      ["/api/photo-themes/plans/abc", { serviceTypeId: "100", themeId: theme.id }, 400],
      ["/api/photo-themes/plans/2001", { themeId: theme.id }, 400],
      ["/api/photo-themes/plans/2001", { serviceTypeId: "100" }, 400],
      ["/api/photo-themes/plans/2001", { serviceTypeId: "100", themeId: "x" }, 400],
      ["/api/photo-themes/plans/2001", { serviceTypeId: "100", show: "sometimes" }, 400],
      ["/api/photo-themes/plans/2001", { serviceTypeId: "100", themeId: theme.id, sortDate: "next week" }, 400],
      ["/api/photo-themes/plans/2001", { serviceTypeId: "100", themeId: "th-000000000000" }, 404],
      ["/api/photo-themes/plans/2001", { serviceTypeId: "100", themeId: theme.id, sortDate: "2026-12-24T16:00:00Z" }, 200],
    ];
    for (const [p, body, status] of cases) assert.equal((await call(p, "PATCH", body)).status, status, `${p} ${JSON.stringify(body)}`);

    assert.equal((await call("/api/photo-themes/plans/2001")).status, 400, "no serviceTypeId");
    const people = await call("/api/photo-themes/plans/2001?serviceTypeId=100");
    assert.equal(people.status, 200);
    assert.equal((people.json as { toGenerate: number }).toGenerate, 1);

    assert.equal((await call("/api/photo-themes/plans/2001/generate", "POST", { serviceTypeId: "100", mode: "everything" })).status, 400);
    assert.equal((await call("/api/photo-themes/plans/2001/generate", "POST", {})).status, 400);
    assert.equal((await call("/api/photo-themes/plans/2002/generate", "POST", { serviceTypeId: "100" })).status, 409, "no theme on that plan");
    const shown = [{ personId: "1001", file: "0123456789abcdef.webp" }];
    assert.equal((await call("/api/photo-themes/plans/2002/approve-all", "POST", { people: shown })).status, 409);
  });

  it("generates, approves and serves the edit", async () => {
    const r = await call("/api/photo-themes/plans/2001/generate", "POST", { serviceTypeId: "100" });
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { queued: 1, reused: 0, skipped: [] });
    await photoThemes.idle();
    const ready = (await call("/api/photo-themes")).json as { themes: { id: string; people: { personId: string; pending: { url: string } | null }[] }[] };
    const themeId = ready.themes.find((t) => t.people.length > 0)!.id;
    const file = ready.themes.flatMap((t) => t.people).find((p) => p.pending)!.pending!.url.split("/").pop()!;
    const approvePath = `/api/photo-themes/themes/${themeId}/people/1001/approve`;
    // Each names the edit it was shown, checked for shape before anything is looked up.
    const refused: [string, unknown][] = [
      [approvePath, {}],
      [approvePath, { file: "../secrets.webp" }],
      ["/api/photo-themes/plans/2001/approve-all", {}],
      ["/api/photo-themes/plans/2001/approve-all", { people: [] }],
      ["/api/photo-themes/plans/2001/approve-all", { people: [{ personId: "1001" }] }],
      ["/api/photo-themes/plans/2001/approve-all", { people: [{ personId: "x", file }] }],
      ["/api/photo-themes/plans/2001/approve-all", { people: [{ personId: "1001", file }, { personId: "1001", file }] }],
      ["/api/photo-themes/plans/2001/approve-all", { people: Array.from({ length: 501 }, (_, i) => ({ personId: String(1 + i), file })) }],
    ];
    for (const [p, body] of refused) assert.equal((await call(p, "POST", body)).status, 400, `${p} ${JSON.stringify(body).slice(0, 80)}`);
    assert.equal((await call(approvePath, "POST", { file: "0123456789abcdef.webp" })).status, 409, "an edit other than the one waiting");
    assert.deepEqual((await call("/api/photo-themes/plans/2001/approve-all", "POST", { people: [{ personId: "1001", file }] })).json, { approved: 1, skipped: [] });
    const state = (await call("/api/photo-themes")).json as { themes: { people: { approved: { url: string } | null }[] }[] };
    const url = state.themes.flatMap((t) => t.people).find((p) => p.approved)!.approved!.url;
    const image = await call(url);
    assert.equal(image.status, 200);
    assert.equal(image.headers["Content-Type"], "image/webp");
    for (const bad of ["/api/photo-themes/images/..%2Fsecrets.bin", "/api/photo-themes/images/0123456789abcdef.webp", "/api/photo-themes/images/x.svg"]) {
      assert.equal((await call(bad)).status, 404, bad);
    }
  });
});

describe("the key in answers", () => {
  it("appears in none of them", () => {
    assert.ok(answers.length > 40);
    for (const a of answers) assert.ok(!a.includes(KEY) && !a.includes(KEY.slice(10)), `an answer carried the key: ${a.slice(0, 200)}`);
  });
});
