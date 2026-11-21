// What each OpenAI failure means to an operator, read off a fake OpenAI over
// real HTTP. The error shapes are the ones OpenAI documents (the plans repo
// keeps the notes); every one carries the key back in its message, the way
// OpenAI's own 401 does, so a reason that repeated OpenAI's words would leak it.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { editImage, mapFailure, OPENAI_IMAGE_MODEL, retryAfterMs, testKey } from "./openai-client.js";
import { errorBody, jpegBytes, startFakeOpenAi, type FakeOpenAi } from "./photo-themes-harness.js";

const KEY = "sk-canary-client-".padEnd(40, "c");

let fake: FakeOpenAi;
let png: Buffer;

before(async () => {
  fake = await startFakeOpenAi();
  process.env.STAGE_UTILITY_OPENAI_BASE_URL = fake.base;
  png = await jpegBytes();
});
after(async () => {
  delete process.env.STAGE_UTILITY_OPENAI_BASE_URL;
  await fake.close();
});

/** Each documented failure, and what it must read as. */
const CASES: { name: string; status: number; body: unknown; headers?: Record<string, string>; kind: string; reason: RegExp }[] = [
  { name: "401", status: 401, body: errorBody("invalid_api_key", "invalid_request_error", KEY), kind: "invalid-key", reason: /^OpenAI rejected the API key$/ },
  { name: "429 credit_balance_exhausted", status: 429, body: errorBody("credit_balance_exhausted", "insufficient_quota", KEY), kind: "out-of-credits", reason: /^Out of API credits$/ },
  { name: "429 insufficient_quota", status: 429, body: errorBody("insufficient_quota", "insufficient_quota", KEY), kind: "out-of-credits", reason: /^Out of API credits$/ },
  { name: "429 rate limit", status: 429, body: errorBody("rate_limit_exceeded", "requests", KEY), headers: { "retry-after": "7" }, kind: "rate-limited", reason: /^Rate limited by OpenAI/ },
  {
    name: "moderation_blocked",
    status: 400,
    body: { error: { type: "image_generation_user_error", code: "moderation_blocked", message: `blocked ${KEY}`, moderation_details: { moderation_stage: "input", categories: ["harassment"] } } },
    kind: "refused",
    reason: /^Refused under OpenAI's content policy$/,
  },
  { name: "403", status: 403, body: errorBody(null, "invalid_request_error", KEY), kind: "forbidden", reason: /organization may need verifying/ },
  { name: "500", status: 500, body: errorBody(null, "server_error", KEY), kind: "server-error", reason: /^OpenAI had a problem \(HTTP 500\)$/ },
  { name: "400 other", status: 400, body: errorBody("invalid_size", "invalid_request_error", KEY), kind: "bad-request", reason: /^OpenAI refused the request \(HTTP 400, invalid_size\)$/ },
  // A code that is not an identifier is not repeated: it could be anything.
  { name: "400 odd code", status: 400, body: errorBody(`${KEY} <b>`, null, KEY), kind: "bad-request", reason: /^OpenAI refused the request \(HTTP 400\)$/ },
];

describe("an edit's failures", () => {
  for (const c of CASES) {
    it(`${c.name} reads as ${c.kind}, without the key`, async () => {
      fake.edit = () => ({ status: c.status, body: c.body, headers: c.headers });
      const r = await editImage({ apiKey: KEY, prompt: "x", png });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.kind, c.kind);
      assert.match(r.reason, c.reason);
      assert.ok(!JSON.stringify(r).includes(KEY), "the failure carries the key");
      assert.ok(!JSON.stringify(r).includes("Incorrect API key"), "the failure repeats OpenAI's words");
    });
  }

  it("a rate limit carries how long OpenAI asked us to wait", async () => {
    fake.edit = () => ({ status: 429, body: errorBody("rate_limit_exceeded", null), headers: { "retry-after": "7" } });
    const r = await editImage({ apiKey: KEY, prompt: "x", png });
    assert.ok(!r.ok && r.retryAfterMs === 7000);
  });

  it("no route to OpenAI reads as unreachable", async () => {
    const r = await editImage({
      apiKey: KEY,
      prompt: "x",
      png,
      fetchImpl: async () => {
        throw new TypeError(`fetch failed for ${KEY}`);
      },
    });
    assert.ok(!r.ok && r.kind === "unreachable" && r.reason === "Could not reach OpenAI");
    assert.ok(!JSON.stringify(r).includes(KEY));
  });

  it("a timeout reads as one", async () => {
    const r = await editImage({
      apiKey: KEY,
      prompt: "x",
      png,
      fetchImpl: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });
    assert.ok(!r.ok && r.kind === "timeout" && r.reason === "OpenAI did not answer in time");
  });

  it("a 200 with no image is a failure, not an empty photo", async () => {
    fake.edit = () => ({ status: 200, body: { data: [] } });
    const r = await editImage({ apiKey: KEY, prompt: "x", png });
    assert.ok(!r.ok && r.kind === "no-image");
  });
});

describe("a successful edit", () => {
  it("sends the model, prompt, size and image with the key in one header, and returns the bytes", async () => {
    fake.requests.length = 0;
    fake.edit = () => ({ status: 200, body: { data: [{ b64_json: Buffer.from("RIFF0000WEBPxxxx").toString("base64") }] } });
    const r = await editImage({ apiKey: KEY, prompt: "warm lights", png });
    assert.ok(r.ok);
    assert.equal(r.bytes.toString("latin1"), "RIFF0000WEBPxxxx");
    const req = fake.requests.at(-1)!;
    assert.equal(req.path, "/v1/images/edits");
    assert.equal(req.authorization, `Bearer ${KEY}`);
    assert.deepEqual(req.fields.sort(), ["image", "model", "n", "output_format", "prompt", "quality", "size"]);
    assert.equal(OPENAI_IMAGE_MODEL, "gpt-image-2.6-flare");
  });
});

describe("testing a key", () => {
  it("lists the models with the key", async () => {
    fake.models = () => ({ status: 200, body: { data: [] } });
    assert.deepEqual(await testKey({ apiKey: KEY }), { ok: true });
    assert.equal(fake.requests.at(-1)!.path, "/v1/models");
  });

  it("maps a 401 the same way an edit does", async () => {
    fake.models = () => ({ status: 401, body: errorBody("invalid_api_key", null, KEY) });
    const r = await testKey({ apiKey: KEY });
    assert.ok(!r.ok && r.kind === "invalid-key");
    assert.ok(!JSON.stringify(r).includes(KEY));
  });
});

describe("mapFailure and Retry-After", () => {
  it("reads the code whatever the status, for a refusal", () => {
    assert.equal(mapFailure(422, { error: { code: "moderation_blocked" } }, null).kind, "refused");
  });
  it("reads seconds and an HTTP date", () => {
    assert.equal(retryAfterMs("2.5"), 2500);
    assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6_000);
    assert.equal(retryAfterMs("soon"), null);
    assert.equal(retryAfterMs(null), null);
  });
});
