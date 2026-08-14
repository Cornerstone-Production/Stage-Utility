// Every channel the UI invokes must have a case in api.ts.
//
// `invoke()` takes `channel: string`, so a channel with no case is not a compile
// error — it throws at runtime, in the click handler, in front of an operator.
// The baptism trigger panel shipped that way and nobody noticed for months: its
// load path swallowed the throw, so saved triggers simply read as "none set",
// and only pressing Save surfaced `Unknown IPC channel`. The panel rendered,
// accepted input, and could not persist a thing.
//
// This is the cheap structural guard until `invoke` takes a channel union: scan
// what the UI actually calls and check every one is wired.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(HERE, "..");
const API_TS = path.join(HERE, "api.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Channels api.ts can actually dispatch. */
function handledChannels(): Set<string> {
  const src = fs.readFileSync(API_TS, "utf8");
  return new Set([...src.matchAll(/case\s+"([^"]+)"\s*:/g)].map((m) => m[1]!));
}

/**
 * The names that dispatch an IPC channel in this file.
 *
 * Scanning for `invoke("...")` alone missed roughly ninety call sites: four
 * panels define a local `ipc()` that forwards to invoke, and one aliases the
 * import. Between them they cover the whole wireless, integrations and settings
 * surface — exactly where the failure this test exists for lives. A guard blind
 * to the code it guards is worse than none, because it reads as covered.
 *
 * Resolved per file rather than by matching any callee: `onNotification` takes a
 * channel-shaped string too, but those are SSE event names with no case in
 * api.ts and never should have one.
 */
function dispatcherNames(src: string): string[] {
  const names = new Set(["invoke"]);
  for (const m of src.matchAll(/\bimport\s*\{[^}]*\binvoke\s+as\s+([\w$]+)/g)) names.add(m[1]!);
  for (const m of src.matchAll(/\bconst\s+([\w$]+)\s*=\s*invoke\b/g)) names.add(m[1]!);
  // A local forwarder: `function ipc<T>(channel, ...) { return invoke<T>(...) }`.
  for (const m of src.matchAll(/\bfunction\s+([\w$]+)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{]*\{[^}]*\binvoke\b/g)) {
    names.add(m[1]!);
  }
  return [...names];
}

/** Every channel the UI dispatches, with the file that does it. */
function invokedChannels(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(RENDERER)) {
    if (path.resolve(file) === API_TS) continue;
    const src = fs.readFileSync(file, "utf8");
    const callee = dispatcherNames(src).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    // The colon is required: every one of api.ts's 174 cases is namespaced
    // `area:action`, and demanding it keeps an over-eager wrapper match from
    // dragging in ordinary string arguments like useState<Target>("app").
    const re = new RegExp(`\\b(?:${callee})\\s*(?:<[^>()]*>)?\\s*\\(\\s*"([\\w-]+:[\\w-]+)"`, "g");
    for (const m of src.matchAll(re)) {
      const chan = m[1]!;
      const where = path.relative(RENDERER, file);
      const list = found.get(chan);
      if (list) { if (!list.includes(where)) list.push(where); } else found.set(chan, [where]);
    }
  }
  return found;
}

describe("IPC channel wiring", () => {
  it("has a case for every channel the UI invokes", () => {
    const handled = handledChannels();
    const missing = [...invokedChannels()]
      .filter(([chan]) => !handled.has(chan))
      .map(([chan, files]) => `  ${chan}  <- ${files.join(", ")}`);

    assert.equal(
      missing.length,
      0,
      `invoke() would throw "Unknown IPC channel" for:\n${missing.join("\n")}`,
    );
  });

  it("finds the channels at all, so a broken scan cannot pass silently", () => {
    // If the scan stops matching (invoke renamed, call sites reshaped), the test
    // above passes vacuously. The floor is set well above what the old
    // invoke-only regex found, so narrowing back to it fails here rather than
    // quietly reducing coverage — that narrowing is the bug this pair replaces.
    const invoked = invokedChannels();
    assert.ok(invoked.size >= 90, `only found ${invoked.size} dispatched channels — scan looks broken`);
    assert.ok(invoked.has("stage:getState"), "expected stage:getState among them");
  });

  it("names every channel the UI no longer dispatches", () => {
    // The other direction, and the one that actually bit. Removing two settings
    // panels as unreachable dead code took the last callers of
    // spl:deleteHistory and attendance:deleteHistory with them — so History's
    // Delete, which calls only serviceTimeline:delete, quietly stopped removing
    // the SPL and attendance records. Nothing was broken at the call site; the
    // call site was gone. A channel losing its last caller is a fact worth
    // knowing at the moment it happens, not a Sunday later.
    //
    // An EXACT set, not a ceiling. A floor with slack is how three config
    // stores went missing from every backup with the suite green: the point is
    // that ADDING an entry has to be a deliberate edit here, with a reason.
    const expected = new Map([
      ["spl:listHistory", "superseded by the service-timeline list; route kept for the HTTP API"],
      ["spl:deleteHistory", "History deletes all three records via serviceTimeline:delete"],
      ["attendance:deleteHistory", "same — see deleteServiceRecords"],
      ["stage:setNdiEnabled", "NDI schema is dormant on this branch; the UI ships with the native app"],
      ["stage:getRemoteUrl", "the remote URL is read from stage:getState instead"],
      ["outputs:openWindow", "Electron-era window opener; the web build navigates directly"],
      ["app:getInfo", "version info comes from /api/version"],
    ]);

    // A deliberately LOOSER scan than invokedChannels(): any mention of the
    // name anywhere in the renderer counts. The strict dispatcher scan answers
    // "is this reached through a call shape we recognise", which is the right
    // question for the missing-case test above and the wrong one here — the UI
    // reaches channels through a ternary, through a variable, and through
    // onNotification, and none of those are dead.
    const referenced = new Set<string>();
    for (const file of walk(RENDERER)) {
      if (path.resolve(file) === API_TS) continue;
      for (const m of fs.readFileSync(file, "utf8").matchAll(/"([\w-]+:[\w-]+)"/g)) referenced.add(m[1]!);
    }
    const undispatched = [...handledChannels()].filter((c) => !referenced.has(c)).sort();

    const appeared = undispatched.filter((c) => !expected.has(c));
    assert.deepEqual(
      appeared,
      [],
      "these channels lost their last caller — either restore the caller, or add them " +
        "here with the reason they are kept:\n  " + appeared.join("\n  "),
    );

    const revived = [...expected.keys()].filter((c) => referenced.has(c)).sort();
    assert.deepEqual(revived, [], `these are dispatched again — drop them from the list: ${revived}`);
  });

  it("sees channels dispatched through a local ipc() wrapper", () => {
    // The specific blind spot: four panels forward through a local `ipc()` and one
    // aliases the import, covering the entire wireless, integrations and settings
    // surface. Naming one here means a future scan cannot lose them silently.
    const invoked = invokedChannels();
    const viaWrapper = [...invoked].filter(([, files]) =>
      files.some((f) => f.endsWith("wireless-connections-panel.tsx")),
    );
    assert.ok(viaWrapper.length > 0, "found no channels in wireless-connections-panel.tsx");
  });
});
