// A word an operator marked sensitive in ProdCom must not reach a display, and
// the list of those words must not reach anything at all.
//
// ProdCom has a first-class keyword system, global and per channel, and each
// keyword carries `isSensitive`; ProdCom's own interface replaces the matched
// text with asterisks. This app rendered the same transcript verbatim on stage
// and lobby walls — screens in rooms full of people — so a word hidden on the
// operator's screen was shown in full to everybody else.
//
// Two separate things are guarded here, and they fail in opposite directions:
//
//   THE WORD must not leave the server inside a caption. Every outward path is
//   covered, not just the broadcast: `GET /api/prodcom/transcript` serves a
//   freshly-loaded display its backfill, and redacting one without the other
//   would paint the hidden word once on load and hide it from the next line on.
//
//   THE KEYWORD LIST must not leave the server at all. If the flagged words are
//   a person's name, a diagnosis or "resignation", the list is exactly as
//   sensitive as the transcript — so it is never broadcast, never serialised,
//   and never logged, including through an error message. That is why matching
//   happens here and not in the browser.
//
// Everything below drives the real code path: a real socket to a local stub that
// answers the same two keyword endpoints ProdCom does, then the real connect →
// fetchChannels → fetchKeywords → backfill → broadcast chain. The semantics
// block calls the same two functions the service calls, so a change to the
// matching rules fails here rather than on a wall.
//
// EVERY KEYWORD IN THIS FILE IS INVENTED. None came from the live box, which in
// fact has no keywords configured at all — global and all seventeen channel
// lists came back empty when this was written, which is also why the asterisk
// COUNT could not be probed and had to be read off the specification's wording.
//
// Matching semantics, from ProdCom's own OpenAPI document
// (`GET /api/v1/openapi.yaml`, `components.schemas.Keyword`):
//
//   text        "Substring to match (case-insensitive)"
//   isSensitive "When true, matched text is replaced with asterisks in the UI"
//
// Substring, not whole word — so a keyword matches inside a longer word, which
// is wider than a word match on purpose: too narrow leaks the word.

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { addBroadcastListener } from "./broadcaster.js";
import { ProdComService, redactText, sensitivePatterns } from "./prodcom-service.js";
import { startProdComStub, type ProdComStub, type StubEntry, type StubKeyword, type StubOptions } from "./fixtures/prodcom-stub.js";

/** A fixed "now" so the four-hour horizon and the stub's rows line up. */
const NOW = Date.parse("2026-09-11T12:00:00Z");

// ── Invented keywords ────────────────────────────────────────────────────────
//
// Nonsense words, so a real flagged word from any box can never be confused for
// one of these, and so a false negative here cannot be an accident of the word
// also appearing in ordinary speech.

/** Marked sensitive, GLOBAL — applies on every channel. */
const GLOBAL_WORD = "zarquon";
/** Marked sensitive, scoped to CH-A only. */
const SCOPED_WORD = "plimberton";
/** A keyword that is NOT sensitive. ProdCom highlights it; nothing is hidden. */
const HIGHLIGHT_ONLY = "sprockwell";

const kw = (id: string, text: string, isSensitive: boolean): StubKeyword => ({
  id,
  text,
  shouldHighlight: !isSensitive,
  highlightColor: isSensitive ? null : "#FFFF00",
  isSensitive,
});

const GLOBAL_KEYWORDS: StubKeyword[] = [kw("kw-g1", GLOBAL_WORD, true), kw("kw-g2", HIGHLIGHT_ONLY, false)];
const CHANNEL_KEYWORDS: Record<string, StubKeyword[]> = {
  "CH-A": [kw("kw-a1", SCOPED_WORD, true)],
  "CH-B": [],
};

const CHANNELS = [
  { id: "CH-A", name: "Lead TB", color: "#00F900" },
  { id: "CH-B", name: "Drum TB", color: "#0696C1" },
];

/** Every invented keyword string, for the "no word in any log line" sweep. */
const ALL_WORDS = [GLOBAL_WORD, SCOPED_WORD, HIGHLIGHT_ONLY];

class TestProdCom extends ProdComService {
  protected override now(): number {
    return NOW;
  }
  protected override get reconnectMs(): number {
    return 25;
  }
  /** Await the channel + keyword + backfill work the live connection started. */
  public settled(): Promise<void> {
    return this.priming;
  }
  /** What a display receives. */
  public captions(): { text: string; redactions: number | undefined; channel: string | null }[] {
    return this.getBuffer().map((l) => ({ text: l.text, redactions: l.redactions, channel: l.channel }));
  }
  /** What the token-gated route serves. */
  public rawCaptions(): string[] {
    return this.getRawBuffer().map((l) => l.text);
  }
  /** Re-read channels + keywords now, without waiting out the throttle. */
  public refreshMetadata(host: string, port: number): Promise<void> {
    return this.refreshChannelMetadata(host, port);
  }
  /** One finalised line through the real SSE entry point. */
  public feedFinal(entry: StubEntry): void {
    this.handleEvent(`data: ${JSON.stringify(entry)}`);
  }
}

const row = (id: string, channelId: string, text: string, minutesAgo = 2): StubEntry => ({
  id,
  channelId,
  channelName: channelId,
  text,
  source: "audio",
  inProgress: false,
  date: new Date(NOW - minutesAgo * 60_000).toISOString(),
});

/** A stub plus a service pointed at it, both torn down when the test ends. */
async function connected(
  t: TestContext,
  options: StubOptions = {},
): Promise<{ stub: ProdComStub; svc: TestProdCom }> {
  const stub = await startProdComStub({
    channels: CHANNELS,
    keywords: GLOBAL_KEYWORDS,
    channelKeywords: CHANNEL_KEYWORDS,
    ...options,
  });
  const svc = new TestProdCom();
  t.after(async () => {
    svc.stop();
    await stub.close();
  });
  svc.configure("127.0.0.1", stub.port, null);
  await stub.waitForUpgrades(1);
  // The transcript read is the LAST thing primeFromRest does, so waiting for it
  // proves onopen ran and `priming` is the real promise rather than the resolved
  // placeholder it starts as.
  await stub.waitForRequest((r) => r.url.startsWith("/api/v1/transcript?"));
  await svc.settled();
  return { stub, svc };
}

/** Collects every "prodcom:transcript" broadcast fired while a test runs. */
function spyOnTranscriptBroadcasts(): unknown[] {
  const seen: unknown[] = [];
  addBroadcastListener((channel, payload) => {
    if (channel === "prodcom:transcript") seen.push(payload);
  });
  return seen;
}

/**
 * Everything written to the console while `run` executes, as one string.
 *
 * All three levels, and the arguments stringified rather than only the format
 * string: a keyword handed to console.warn as a second argument would otherwise
 * slip past a check that only reads the first.
 */
async function captureConsole<T>(run: () => Promise<T>): Promise<{ output: string; value: T }> {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const sink =
    (level: string) =>
    (...args: unknown[]) =>
      lines.push(`${level} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
  console.log = sink("log");
  console.warn = sink("warn");
  console.error = sink("error");
  try {
    const value = await run();
    return { output: lines.join("\n"), value };
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
}

// ── Matching semantics ───────────────────────────────────────────────────────

describe("matching follows ProdCom's specification, not an invented rule", () => {
  const patterns = (...rows: StubKeyword[]) => sensitivePatterns(rows);

  it("is case-insensitive, as the spec's `text` description says", () => {
    const p = patterns(kw("k", GLOBAL_WORD, true));
    for (const said of [GLOBAL_WORD, GLOBAL_WORD.toUpperCase(), "Zarquon", "ZaRqUoN"]) {
      const out = redactText(`we need ${said} now`, p);
      assert.equal(out.text, `we need ${"*".repeat(said.length)} now`, said);
      assert.equal(out.redactions, 1);
    }
  });

  it("matches a SUBSTRING, so a keyword inside a longer word is still hidden", () => {
    // The spec says "Substring to match". Whole-word matching would leave
    // "zarquonite" readable, which is the leak this direction guards against.
    const p = patterns(kw("k", GLOBAL_WORD, true));
    assert.equal(redactText("a zarquonite arrived", p).text, "a *******ite arrived");
    assert.equal(redactText("prezarquon", p).text, "pre*******");
  });

  it("leaves a word that does not match completely alone", () => {
    const p = patterns(kw("k", GLOBAL_WORD, true));
    const said = "the quartet will play before the sermon";
    assert.deepEqual(redactText(said, p), { text: said, redactions: 0 });
  });

  it("ignores a keyword that is not marked sensitive", () => {
    // ProdCom highlights this one in its own UI; nothing about it is hidden.
    const p = patterns(kw("k", HIGHLIGHT_ONLY, false));
    assert.equal(p.length, 0);
    const said = `call ${HIGHLIGHT_ONLY} when ready`;
    assert.deepEqual(redactText(said, p), { text: said, redactions: 0 });
  });

  it("treats a missing isSensitive as not sensitive", () => {
    assert.equal(sensitivePatterns([{ id: "k", text: GLOBAL_WORD }]).length, 0);
  });

  it("replaces one asterisk per matched character, so the line keeps its shape", () => {
    const p = patterns(kw("k", GLOBAL_WORD, true));
    const out = redactText(`${GLOBAL_WORD} and ${GLOBAL_WORD}`, p);
    assert.equal(out.text.length, `${GLOBAL_WORD} and ${GLOBAL_WORD}`.length);
    assert.equal(out.text, `${"*".repeat(7)} and ${"*".repeat(7)}`);
  });

  it("hides EVERY occurrence, not just the first", () => {
    const p = patterns(kw("k", "ab", true));
    assert.deepEqual(redactText("ab cd ab ef ab", p), { text: "** cd ** ef **", redactions: 3 });
  });

  it("merges overlapping and touching matches into one run, whatever the list order", () => {
    // Same words, opposite order: the answer must not depend on which keyword
    // ProdCom happened to list first.
    const forwards = patterns(kw("k1", "abcd", true), kw("k2", "cdef", true));
    const backwards = patterns(kw("k1", "cdef", true), kw("k2", "abcd", true));
    assert.deepEqual(redactText("xxabcdefxx", forwards), { text: "xx******xx", redactions: 1 });
    assert.deepEqual(redactText("xxabcdefxx", backwards), { text: "xx******xx", redactions: 1 });

    // Touching, not overlapping: one run of asterisks on screen, so one count.
    const touching = patterns(kw("k1", "ab", true), kw("k2", "cd", true));
    assert.deepEqual(redactText("abcd", touching), { text: "****", redactions: 1 });
  });

  it("treats regex metacharacters in a keyword as literal text", () => {
    // A keyword is a substring, not a pattern. Unescaped, "a.c" would hide
    // "abc" — a word the operator never flagged.
    const p = patterns(kw("k", "a.c", true));
    assert.equal(redactText("abc", p).text, "abc");
    assert.equal(redactText("a.c", p).text, "***");
  });

  it("is not thrown off by a character whose lower-case form is a different length", () => {
    // U+0130 lower-cases to two code units. Lower-casing the haystack and using
    // indexOf would shift every index after it and asterisk the wrong span.
    const p = patterns(kw("k", GLOBAL_WORD, true));
    const said = `İstanbul ${GLOBAL_WORD} end`;
    assert.equal(redactText(said, p).text, `İstanbul ${"*".repeat(7)} end`);
  });

  it("ignores a blank keyword rather than asterisking the whole line", () => {
    assert.equal(sensitivePatterns([kw("k", "   ", true)]).length, 0);
    assert.equal(sensitivePatterns([kw("k", "", true)]).length, 0);
  });
});

// ── The word must not leave the server ───────────────────────────────────────

describe("a sensitive keyword never reaches a display", () => {
  it("is asterisked in the broadcast payload, on the real connect path", async (t) => {
    const seen = spyOnTranscriptBroadcasts();
    const { stub, svc } = await connected(t, {
      entries: [row("l1", "CH-A", `please page ${GLOBAL_WORD} to the green room`)],
    });
    await stub.waitForRequest((r) => r.url.startsWith("/api/v1/keywords"));

    const captions = svc.captions();
    assert.equal(captions.length, 1);
    assert.equal(captions[0]!.text, `please page ${"*".repeat(7)} to the green room`);
    assert.equal(captions[0]!.redactions, 1);

    // The broadcast payload itself, which is what actually crosses the wire.
    const payloads = JSON.stringify(seen);
    assert.ok(payloads.includes("*******"), "the broadcast carried no redacted line at all");
    assert.ok(
      !payloads.toLowerCase().includes(GLOBAL_WORD),
      `a sensitive keyword reached the broadcast payload: ${payloads}`,
    );
  });

  it("is asterisked on a line that arrives live over the websocket", async (t) => {
    const { stub, svc } = await connected(t);
    stub.wsTranscript(row("live1", "CH-A", `${GLOBAL_WORD} is in the lobby`));
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      ["******* is in the lobby"],
    );
  });

  it("scopes a channel keyword to its own channel, the way ProdCom does", async (t) => {
    const { svc } = await connected(t, {
      entries: [
        row("a", "CH-A", `${SCOPED_WORD} on A`),
        row("b", "CH-B", `${SCOPED_WORD} on B`),
      ],
    });
    const byChannel = new Map(svc.captions().map((c) => [c.channel, c.text]));
    assert.equal(byChannel.get("CH-A"), `${"*".repeat(10)} on A`);
    assert.equal(byChannel.get("CH-B"), `${SCOPED_WORD} on B`, "a CH-A keyword must not redact CH-B");
  });

  it("applies a global keyword on every channel", async (t) => {
    const { svc } = await connected(t, {
      entries: [row("a", "CH-A", `${GLOBAL_WORD} A`), row("b", "CH-B", `${GLOBAL_WORD} B`)],
    });
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      ["******* A", "******* B"],
    );
  });

  it("leaves a highlight-only keyword visible", async (t) => {
    const { svc } = await connected(t, { entries: [row("a", "CH-A", `${HIGHLIGHT_ONLY} please`)] });
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      [`${HIGHLIGHT_ONLY} please`],
    );
  });

  it("carries no redactions field on a line where nothing was hidden", async (t) => {
    const { svc } = await connected(t, { entries: [row("a", "CH-A", "nothing to hide here")] });
    assert.equal(svc.captions()[0]!.redactions, undefined);
  });

  it("keeps the raw line in the buffer, so redaction is not destructive", async (t) => {
    const said = `${GLOBAL_WORD} and ${SCOPED_WORD}`;
    const { svc } = await connected(t, { entries: [row("a", "CH-A", said)] });
    assert.deepEqual(svc.rawCaptions(), [said]);
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      [`${"*".repeat(7)} and ${"*".repeat(10)}`],
    );
  });

  it("reads keywords off the channel row when a box sends them there", async (t) => {
    // The spec's Channel schema declares a `keywords` array; ProdCom 2.3.2 does
    // not send one. A box that does must redact identically and must not need
    // the per-channel request.
    const { stub, svc } = await connected(t, {
      embedKeywordsInChannels: true,
      entries: [row("a", "CH-A", `${SCOPED_WORD} on A`)],
    });
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      [`${"*".repeat(10)} on A`],
    );
    assert.equal(
      stub.requests.filter((r) => /\/api\/v1\/channels\/[^/]+\/keywords/.test(r.url)).length,
      0,
      "asked per channel for keywords the channel row already carried",
    );
  });

  it("asks both keyword endpoints on a box that sends neither embedded", async (t) => {
    const { stub } = await connected(t);
    assert.equal(stub.requests.filter((r) => r.url === "/api/v1/keywords").length, 1);
    assert.deepEqual(
      stub.requests.filter((r) => /\/api\/v1\/channels\/[^/]+\/keywords$/.test(r.url)).map((r) => r.url).sort(),
      ["/api/v1/channels/CH-A/keywords", "/api/v1/channels/CH-B/keywords"],
    );
  });
});

// ── The keyword list must not leave the server at all ────────────────────────

describe("the keyword list itself never reaches a log line", () => {
  it("logs counts on load, and no word, over the whole connect path", async (t) => {
    const { output } = await captureConsole(async () => {
      const c = await connected(t, {
        entries: [row("a", "CH-A", `${GLOBAL_WORD} ${SCOPED_WORD} ${HIGHLIGHT_ONLY}`)],
      });
      // Drive the redaction path too, so its log line is inside the capture.
      c.svc.captions();
    });

    for (const word of ALL_WORDS) {
      assert.ok(
        !output.toLowerCase().includes(word),
        `a keyword reached a log line:\n${output}`,
      );
    }
    // And the counts an operator does need are there.
    assert.match(output, /\[prodcom\] keywords loaded: 2 global \(1 sensitive\), 1 channel-scoped/);
    assert.match(output, /\[prodcom\] hiding text that matches a keyword marked sensitive/);
  });

  it("logs no word when the keyword read fails, only what the consequence is", async (t) => {
    const { output } = await captureConsole(async () => {
      await connected(t, { failKeywords: true, entries: [row("a", "CH-A", `${GLOBAL_WORD} said`)] });
    });
    for (const word of ALL_WORDS) {
      assert.ok(!output.toLowerCase().includes(word), `a keyword reached a log line:\n${output}`);
    }
    assert.match(output, /\[prodcom\] keyword list unavailable \(HTTP 500\)/);
    assert.match(output, /nothing is being hidden on displays/);
  });

  it("keeps the words it already has when a LATER keyword read fails", async (t) => {
    // A transient failure mid-service must not silently un-redact every display.
    //
    // The channel list has to keep answering for this to mean anything: a
    // failure there returns before the keyword read is even attempted, so a test
    // that just kills the box proves nothing about what fetchKeywords does with
    // the list it already has. That is what an earlier version of this did, and
    // it stayed green with the words being thrown away.
    const { stub, svc } = await connected(t);
    stub.setFailKeywords(true);

    const { output } = await captureConsole(async () => {
      await svc.refreshMetadata("127.0.0.1", stub.port);
    });
    assert.match(output, /keyword list unavailable \(HTTP 500\)/);
    assert.match(output, /still hiding 2 sensitive keyword\(s\) from the last successful read/);
    for (const word of ALL_WORDS) {
      assert.ok(!output.toLowerCase().includes(word), `a keyword reached a log line:\n${output}`);
    }

    // And they are still actually applied, not merely counted in a log line.
    svc.feedFinal(row("late", "CH-A", `${GLOBAL_WORD} and ${SCOPED_WORD} still hidden`));
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      [`${"*".repeat(7)} and ${"*".repeat(10)} still hidden`],
    );
  });

  it("says nothing is hidden when the channel list itself is gone", async (t) => {
    // No channel list means no channels to ask about, so the keyword read never
    // runs — and on a fresh connection that leaves nothing loaded. An operator
    // has to be told that, not just that a list was "unavailable".
    const { output } = await captureConsole(async () => {
      await connected(t, { failChannels: true });
    });
    assert.match(output, /channel list unavailable \(HTTP 500\)/);
    assert.match(output, /keyword list unavailable \(HTTP 500\)/);
    assert.match(output, /nothing is being hidden on displays/);
  });
});

// ── The toggle ───────────────────────────────────────────────────────────────

describe("the redaction toggle decides what crosses the wire", () => {
  it("is ON by default, matching ProdCom's own interface", async (t) => {
    const { svc } = await connected(t, { entries: [row("a", "CH-A", `${GLOBAL_WORD} here`)] });
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      ["******* here"],
    );
  });

  it("sends the raw text once turned off, and hides it again when turned back on", async (t) => {
    const seen = spyOnTranscriptBroadcasts();
    const { svc } = await connected(t, { entries: [row("a", "CH-A", `${GLOBAL_WORD} here`)] });

    const before = seen.length;
    svc.setRedactSensitive(false);
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      [`${GLOBAL_WORD} here`],
      "turning the toggle off must show the transcript in full",
    );
    assert.ok(seen.length > before, "flipping the toggle must re-broadcast, not wait for the next line");

    svc.setRedactSensitive(true);
    assert.deepEqual(
      svc.captions().map((c) => c.text),
      ["******* here"],
      "turning the toggle back on must hide it again",
    );
  });

  it("still serves the raw buffer to the gated read whichever way the toggle sits", async (t) => {
    const said = `${GLOBAL_WORD} here`;
    const { svc } = await connected(t, { entries: [row("a", "CH-A", said)] });
    assert.deepEqual(svc.rawCaptions(), [said]);
    svc.setRedactSensitive(false);
    assert.deepEqual(svc.rawCaptions(), [said]);
  });

  it("says which way it was moved, without naming a word", async (t) => {
    const { svc } = await connected(t);
    const { output } = await captureConsole(async () => {
      svc.setRedactSensitive(false);
      svc.setRedactSensitive(true);
    });
    assert.match(output, /redaction turned OFF/);
    assert.match(output, /sensitive keywords will be hidden on displays/);
    for (const word of ALL_WORDS) {
      assert.ok(!output.toLowerCase().includes(word), `a keyword reached a log line:\n${output}`);
    }
  });
});
