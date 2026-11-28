// The two update-notice routes What's new depends on, as a client calls them.
//
// What the read answers, and when it goes to GitHub, is running-notes.test.ts.
// This file is the wiring only: Dismiss answers 200 and keeps the notes, the
// read answers 200 even when it has no notes (the dialog draws that answer,
// so an error status would be a second failure path), and reading before
// Dismiss leaves the after-update notice waiting.
//
// Every version and change line below is INVENTED except the running version,
// which is whatever package.json says. This is a public repository.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "su-release-notes-route-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { systemRoutes } = await import("./system-routes.js");
const { callRoute } = await import("./route-harness.js");
const { updateNoticesStore } = await import("../update-notices-store.js");
const { clearReleaseCache } = await import("../update/release-check.js");
const { pkgVersion } = await import("../updater.js");

const RUNNING = `v${pkgVersion()}`;
const realFetch = globalThis.fetch;
const realWarn = console.warn;

const notice = {
  version: RUNNING,
  fromVersion: "0.9.0",
  notes: [{ section: "New" as const, lines: ["a line captured at update time"], omitted: 0 }],
  lines: [],
  intro: "The opening words.",
  at: "2026-01-01T00:00:00.000Z",
};

const notices = async () =>
  ((await callRoute(systemRoutes, "/api/update/notices")).json as { justUpdated: unknown }).justUpdated;
const whatsNew = async () => {
  const out = await callRoute(systemRoutes, "/api/update/release-notes");
  assert.equal(out.status, 200, `a failed read must still answer 200 with ok:false: ${out.body}`);
  return out.json as { ok: boolean; version: string; notes?: { lines: string[] }[]; releaseUrl: string };
};

beforeEach(async () => {
  clearReleaseCache();
  // GitHub is never reachable here: every answer below comes from the store.
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as typeof fetch;
  console.warn = () => {};
  await updateNoticesStore.save({ announcedTag: null, justUpdated: null, releaseNotes: null });
});
afterEach(() => {
  console.warn = realWarn;
  globalThis.fetch = realFetch;
});
after(() => fs.rm(TMP, { recursive: true, force: true }).catch(() => {}));

describe("the update-notice routes What's new uses", () => {
  it("POST dismiss answers 200, clears the notice and leaves its notes for the read", async () => {
    await updateNoticesStore.save({ announcedTag: null, justUpdated: notice, releaseNotes: null });
    const dismissed = await callRoute(systemRoutes, "/api/update/notices/dismiss", { method: "POST", body: {} });
    assert.equal(dismissed.status, 200);
    assert.equal(await notices(), null);
    const r = await whatsNew();
    assert.ok(r.ok, `the notes went with the dismissal: ${JSON.stringify(r)}`);
    assert.deepEqual(r.notes?.[0].lines, ["a line captured at update time"]);
  });

  it("GET release-notes before Dismiss does not acknowledge the notice", async () => {
    await updateNoticesStore.save({ announcedTag: null, justUpdated: notice, releaseNotes: null });
    assert.ok((await whatsNew()).ok);
    assert.ok(await notices(), "What's new spent the after-update dialog");
  });

  it("GET release-notes answers 200 with ok:false when there are no notes to be had", async () => {
    const r = await whatsNew();
    assert.equal(r.ok, false);
    assert.equal(r.version, pkgVersion());
    assert.ok(r.releaseUrl.endsWith(`/releases/tag/${RUNNING}`), r.releaseUrl);
  });
});
