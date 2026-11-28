// What an operator reads when Planning Center refuses a request: the status and a short
// reason. The refusal's whole body is on a [pco] log line and nowhere in the message,
// because the message becomes a toast ("Refresh failed: …").

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { pcoService } from "./pco-service.js";

type Internals = {
  pcoFetch: (url: string) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
};
const svc = pcoService as unknown as Internals;
const real = { pcoFetch: svc.pcoFetch, sleep: svc.sleep };

const BODY = JSON.stringify({
  errors: [{ status: "503", title: "Service Unavailable", meta: { trace: "abc123" }, detail: "x".repeat(400) }],
});

function answer(status: number, body: string, statusText = "") {
  svc.pcoFetch = async () => new Response(body, { status, statusText });
  svc.sleep = async () => {};
}

describe("a refused Planning Center answer", () => {
  let warned: string[] = [];
  let logged: string[] = [];
  beforeEach(() => {
    pcoService.clearCache();
    warned = [];
    logged = [];
    mock.method(console, "warn", (line: unknown) => warned.push(String(line)));
    mock.method(console, "log", (line: unknown) => logged.push(String(line)));
  });
  afterEach(() => {
    mock.restoreAll();
    Object.assign(svc, real);
  });

  it("says the status and PCO's short title, not the JSON body", async () => {
    answer(503, BODY);
    await assert.rejects(
      () => pcoService.getPerson("app", "secret", "100000001"),
      (err: Error) => {
        assert.equal(err.message, "PCO API error 503: Service Unavailable");
        return true;
      },
    );
  });

  it("keeps the whole body on a tagged log line", async () => {
    answer(403, BODY);
    await assert.rejects(() => pcoService.getPerson("app", "secret", "100000001"));
    assert.equal(warned.filter((l) => l.startsWith("[pco] 403 from ") && l.includes("abc123")).length, 1, JSON.stringify(warned));
  });

  it("falls back to the status text for a body that is not JSON, and caps a long reason", async () => {
    answer(502, "<html>Bad gateway</html>", "Bad Gateway");
    await assert.rejects(() => pcoService.getPerson("app", "secret", "100000001"), /^Error: PCO API error 502: Bad Gateway$/);
    answer(403, JSON.stringify({ errors: [{ detail: "y".repeat(500) }] }));
    await assert.rejects(
      () => pcoService.getPerson("app", "secret", "100000001"),
      (err: Error) => err.message.length < 160 && err.message.endsWith("…"),
    );
  });

  it("logs a 404 with its body too, as information: a 404 is often an answer, not a fault", async () => {
    answer(404, JSON.stringify({ errors: [{ title: "Not Found", meta: { trace: "def456" } }] }));
    await assert.rejects(
      () => pcoService.listPlanTimes("app", "secret", "1", "2"),
      (err: Error) => err.name === "PcoNotFoundError" && err.message === "PCO API error 404: Not Found",
    );
    assert.equal(logged.filter((l) => l.startsWith("[pco] 404 from ") && l.includes("def456")).length, 1, JSON.stringify(logged));
    assert.equal(warned.length, 0, JSON.stringify(warned));
  });

  it("keeps a title with a line break in it on one line", async () => {
    answer(403, JSON.stringify({ errors: [{ title: "Forbidden\r\nfor this app\n" }] }));
    await assert.rejects(() => pcoService.getPerson("app", "secret", "100000001"), (err: Error) => {
      assert.equal(err.message, "PCO API error 403: Forbidden for this app");
      return true;
    });
  });
});
