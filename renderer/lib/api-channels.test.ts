// Every channel the UI invokes must have a case in api.ts.
//
// A channel with no case throws at runtime, in the click handler, in front of an
// operator. The baptism trigger panel shipped that way and nobody noticed for
// months: its load path swallowed the throw, so saved triggers simply read as
// "none set", and only pressing Save surfaced `Unknown IPC channel`. The panel
// rendered, accepted input, and could not persist a thing.
//
// `invoke()` takes the IpcChannel union, so `tsc` is the first guard: a channel
// with no case does not compile, called directly or through a wrapper
// (IpcChannel's doc comment in api.ts names the ways around it). These scans are
// the second: a backstop for a literal cast past the type, at a call they
// recognise, and the only check on the reverse direction, a channel that has
// lost its last caller. That check reads raw text, so a comment quoting the
// channel satisfies it.

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
 * Scanning for `invoke("...")` alone missed roughly ninety call sites: the
 * panels that call it as `ipc`. Between them they cover the whole wireless,
 * integrations and settings surface — exactly where the failure this test
 * exists for lives. A guard blind to the code it guards is worse than none,
 * because it reads as covered.
 *
 * Resolved per file rather than by matching any callee: `onNotification` takes a
 * channel-shaped string too, but those are SSE event names with no case in
 * api.ts and never should have one.
 *
 * Not exhaustive over forwarders, so a green run does not mean every wrapper
 * was scanned. Names are resolved per file, and the `function` pattern walks
 * from a declaration's `{` to the first `}` looking for `invoke`, which misses:
 *  - a forwarder NESTED in another function when no `}` comes between the
 *    outer `{` and the inner `invoke`: the match starts at the outer
 *    `function`, records the outer name and swallows the inner declaration,
 *    so calls through the inner helper are never scanned;
 *  - a forwarder whose own body closes a brace before its `invoke`, or whose
 *    return type holds one (`Promise<{ ok: boolean }>`);
 *  - a forwarder whose type parameters nest a `>`
 *    (`<T extends Record<string, unknown>>`);
 *  - a forwarder of a forwarder: useStageSettings's writeTo() reaches invoke
 *    through ipc(), and writeState() through writeTo(); only ipc() is found;
 *  - a forwarder declared in one file and called from another;
 *  - an arrow function or a method.
 * Each shape, probed with an unwired channel, left these tests green. The type
 * is what covers them: invoke() takes IpcChannel, so a forwarder whose channel
 * is `string` does not compile, and one whose channel is IpcChannel gets every
 * call site checked by `tsc` (see IpcChannel in api.ts).
 */
function dispatcherNames(src: string): string[] {
  const names = new Set(["invoke"]);
  for (const m of src.matchAll(/\bimport\s*\{[^}]*\binvoke\s+as\s+([\w$]+)/g)) names.add(m[1]!);
  for (const m of src.matchAll(/\bconst\s+([\w$]+)\s*=\s*invoke\b/g)) names.add(m[1]!);
  // A local forwarder: `function run(channel) { ... invoke(channel) ... }`.
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
    // The colon is required: every one of api.ts's cases is namespaced
    // `area:action`, and demanding it keeps an over-eager wrapper match from
    // dragging in ordinary string arguments like useState<Target>("app").
    //
    // The optional `(?:[^()]*?\?\s*)?` before the literal, and the optional
    // `(?:\s*:\s*"...")?` after it, resolve a two-way ternary as the call's
    // first argument — `act(paused ? "baptism:resume" : "baptism:pause")` and
    // `invoke(dir === "next" ? "pco:liveNext" : "pco:livePrevious")` both shipped
    // with exactly this shape, and a scan that only accepted a literal
    // IMMEDIATELY after `(` could not see either channel as invoked at all — not
    // "invoked with no case", just invisible to this function, so the
    // missing-case check below never had a reason to complain. `[^()]*?` allows
    // the ternary's own condition to contain quotes (`dir === "next"`) as long as
    // it contains no parens — true of every condition this closes today, but not
    // a property of ternaries in general. This scan is still blind to: a
    // three-way ternary (only the first `?`/`:` pair resolves); a parenthesised
    // condition (`(a || b) ? "x:y" : "x:z"` — the paren exclusion in `[^()]*?`
    // stops at it); a channel assembled in a variable before the call, however
    // it got its value (see IpcChannel in api.ts for the typed answer to that
    // one); and a channel built from a template literal. Widen it again, or
    // reach for typing, when one of those actually ships unwired — do not
    // assume this list is exhaustive of what a future call site can do.
    const re = new RegExp(
      `\\b(?:${callee})\\s*(?:<[^>()]*>)?\\s*\\(\\s*(?:[^()]*?\\?\\s*)?"([\\w-]+:[\\w-]+)"(?:\\s*:\\s*"([\\w-]+:[\\w-]+)")?`,
      "g",
    );
    for (const m of src.matchAll(re)) {
      for (const chan of [m[1], m[2]]) {
        if (!chan) continue;
        const where = path.relative(RENDERER, file);
        const list = found.get(chan);
        if (list) { if (!list.includes(where)) list.push(where); } else found.set(chan, [where]);
      }
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
      ["spl:setVisibleMetrics", "the History metric choice is a per-browser preference now (spl:visibleMetrics in localStorage); the server setting is READ once to seed it — spl:getVisibleMetrics still has a caller — and the route stays for the documented HTTP API"],
      ["spl:deleteHistory", "History deletes all three records via serviceTimeline:delete"],
      ["spl:getTrendPrefs", "the Overview card these gated is gone from All services; the stored choice is the operator's own and is not deleted to tidy up, and the route stays for the documented HTTP API"],
      ["spl:setTrendPrefs", "same — nothing writes it now; see spl:getTrendPrefs"],
      ["attendance:deleteHistory", "same — see deleteServiceRecords"],
      ["stage:setNdiEnabled", "NDI schema is dormant on this branch; the UI ships with the native app"],
      ["stage:getRemoteUrl", "the remote URL is read from stage:getState instead"],
      ["outputs:openWindow", "Electron-era window opener; the web build navigates directly"],
      ["window:closeSettings", "Escape closed the settings WINDOW; Settings is routes inside the app now, so there is nothing to close to"],
      ["app:getInfo", "version info comes from /api/version"],
      ["views:reorder", "manual view ordering came out with the settings window; the route stays as the documented POST /api/views/reorder"],
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

  it("sees channels dispatched through an ipc alias of invoke", () => {
    // The specific blind spot: these panels import invoke as `ipc`, covering the
    // entire wireless, integrations and settings surface. Naming one here means
    // a future scan cannot lose them silently.
    const invoked = invokedChannels();
    const viaWrapper = [...invoked].filter(([, files]) =>
      files.some((f) => f.endsWith("wireless-connections-panel.tsx")),
    );
    assert.ok(viaWrapper.length > 0, "found no channels in wireless-connections-panel.tsx");
  });

  it("sees a channel dispatched through a ternary", () => {
    // The other specific blind spot, closed alongside the wrapper one above:
    // baptism-operator.tsx's Pause button is `act(paused ? "baptism:resume" :
    // "baptism:pause")`, and shipped with no case for either channel in api.ts
    // for a full round — this test finding both is what would have caught it.
    // Named for real channels rather than a synthetic fixture, so a rewrite of
    // invokedChannels() that quietly drops ternary support fails on the actual
    // shape that bit, not on a string nobody's code contains.
    const invoked = invokedChannels();
    assert.ok(invoked.has("baptism:pause"), "expected the ternary in baptism-operator.tsx's Pause button to be found");
    assert.ok(invoked.has("baptism:resume"), "expected the other branch of that same ternary to be found");
  });

  it("a channel with no case is reported unknown AT RUNTIME, not just absent from a string scan", async () => {
    // I5: a guard that matches error PROSE (`err.message.includes("Unknown IPC
    // channel")`) is one rewording away from vacuous — a reviewer deleted two
    // cases and reworded that exact throw, and a guard built that way stayed
    // green. This does not read the message at all: it proves invoke() still
    // rejects something with no case, which is the fact the missing-case test
    // above depends on `handledChannels()`/`invokedChannels()` correctly
    // reflecting. If a future rewrite makes invoke() swallow an unknown channel
    // instead of throwing, this fails regardless of what the throw says.
    const { invoke } = await import("./api.js");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      // @ts-expect-error not an IpcChannel, on purpose: this is the runtime throw
      // a caller cast past the type would hit. The directive also pins the type:
      // loosen invoke() back to `string` and tsc reports the directive unused.
      await assert.rejects(() => invoke("baptism:not-a-real-channel"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
