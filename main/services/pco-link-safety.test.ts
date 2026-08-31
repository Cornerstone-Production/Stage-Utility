// Two things this file guards, both about data that arrives from outside and is
// then trusted.
//
// 1. The Live action URL is read out of a PCO RESPONSE BODY and POSTed to with
//    the operator's App ID and secret in an Authorization header. Nothing
//    checked that it still pointed at PCO. The response comes from PCO over TLS,
//    so this was defence in depth rather than a live hole — but the safe
//    fallback URL already existed, which made the check free.
//
// 2. /log is a LAN-visible page, one record per line, and scrub() exists so a
//    newline in outside data cannot forge an entry. It was applied to four log
//    sites in pco-service.ts and skipped on two others in the same file — the
//    repeated-pattern drift CLAUDE.md calls this repo's most expensive recurring
//    mistake, and the same shape as `safe()` applied on write but not on read.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { sameOrigin, pcoUrlFrom, nextOffset, pcoService, withOffset, pinnedToPco } from "./pco-service.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PCO = "https://api.planningcenteronline.com/services/v2";

describe("following a URL out of a PCO response body", () => {
  // IMPORTED, not re-declared. This file used to carry its own copy of
  // sameOrigin and assert against that, which passes whether or not
  // pco-service.ts still uses it -- the same shape as the guard in this repo
  // that went green while nothing called the function it was written for.

  it("accepts a genuine PCO link", () => {
    assert.equal(sameOrigin("https://api.planningcenteronline.com/services/v2/x/live/go", PCO), true);
  });

  it("rejects a look-alike host a prefix check would accept", () => {
    // The reason this compares origins rather than testing startsWith.
    assert.equal(sameOrigin("https://api.planningcenteronline.com.evil.example/steal", PCO), false);
  });

  it("rejects other schemes, other hosts, and anything unparseable", () => {
    for (const bad of [
      "http://api.planningcenteronline.com/x", // downgraded scheme
      "https://evil.example/x",
      "file:///etc/passwd",
      "/services/v2/relative",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(sameOrigin(bad, PCO), false, `must reject ${String(bad)}`);
    }
  });
});

describe("the URL actually handed to fetch()", () => {
  // Checking the origin and then passing the ORIGINAL string on is correct, but
  // it leaves the value that carries the operator's credentials as the one that
  // came off the wire. pcoUrlFrom rebuilds it on the constant's origin, so the
  // host is never taken from the response at all.

  it("keeps the path and query", () => {
    const out = pcoUrlFrom(`${PCO}/service_types/1/plans?offset=25&per_page=25`, PCO);
    assert.equal(out, "https://api.planningcenteronline.com/services/v2/service_types/1/plans?offset=25&per_page=25");
  });

  it("takes its host from the constant, never from the candidate", () => {
    // The whole point. Even a candidate that PASSES the origin check contributes
    // only its path — there is no string an upstream can return that changes the
    // host, including through a parser disagreement.
    const out = pcoUrlFrom(`${PCO}/x`, PCO);
    assert.ok(out);
    assert.equal(new URL(out).origin, new URL(PCO).origin);
  });

  // THE GUARD: a pathname that begins with `//` must not move the origin.
  //
  // CodeQL flagged this as js/request-forgery (critical) plus two
  // js/file-access-to-http on PR #349. It is not theoretical. The candidates
  // below have a genuine PCO origin, so sameOrigin passes them, and their
  // pathname starts with `//`. The OLD implementation rebuilt with
  // `new URL(path, origin)`, whose first argument is RE-PARSED -- and `//host`
  // reads as a protocol-relative authority, not a path. It produced
  // https://attacker.example/steal, and pcoFetch attaches the operator's PCO
  // app id and secret to whatever URL it is handed.
  //
  // Built from PCO's ORIGIN, not from PCO: PCO carries a path, so
  // `${PCO}//host` yields a pathname of `/services/v2//host`, which does not
  // start with `//` and would not reproduce the bug at all.
  //
  // Proven red in the session that wrote it: restoring
  // `new URL(`${parsed.pathname}${parsed.search}`, new URL(base).origin)`
  // fails this with "walked off-origin to https://attacker.example/steal".
  // THE GUARD for the last line of defence.
  //
  // pcoFetch no longer trusts its callers: it re-pins the origin at the point
  // the app id and secret are attached. This asserts the pin holds even when a
  // caller hands over a host that is not PCO's -- the case the docblock above it
  // says can no longer matter.
  //
  // Proven red: return `url` unchanged from pinnedToPco and this fails with
  // "https://attacker.example/steal kept its own host".
  it("pins every fetched URL onto PCO's origin, whatever the caller passes", () => {
    const origin = new URL(PCO).origin;
    for (const rogue of [
      "https://attacker.example/steal",
      "http://attacker.example/steal?x=1",
      `${origin}//attacker.example/steal`,
    ]) {
      const out = pinnedToPco(rogue);
      assert.equal(new URL(out).origin, origin, `${rogue} kept its own host`);
    }
  });

  it("refuses a URL it cannot parse rather than fetching it", () => {
    // Not a silent fall back to the base: a caller that built a broken URL has a
    // bug, and a request that quietly went somewhere else carrying the operator's
    // credentials is not a failure to swallow.
    assert.throws(() => pinnedToPco("not a url at all"), /cannot parse/);
  });

  it("cannot be walked off-origin by a pathname that starts //", () => {
    const origin = new URL(PCO).origin;
    for (const hostile of [
      `${origin}//attacker.example/steal`,
      `${origin}//attacker.example/steal?x=1`,
      `${origin}///attacker.example/steal`,
    ]) {
      const out = pcoUrlFrom(hostile, PCO);
      if (out === null) continue; // rejected outright is also safe
      assert.equal(
        new URL(out).origin,
        origin,
        `${hostile} walked off-origin to ${out}`,
      );
    }
  });

  it("returns null for anything that is not PCO's", () => {
    for (const bad of [
      "https://api.planningcenteronline.com.evil.example/steal",
      "https://evil.example/x",
      "http://api.planningcenteronline.com/x",
      "file:///etc/passwd",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(pcoUrlFrom(bad, PCO), null, `must reject ${String(bad)}`);
    }
  });

});

/**
 * Every PCO client, not just the first one.
 *
 * These scans used to name pco-service.ts and nothing else. A second client
 * (/calendar/v2) arrived, and a copy of the rules arrived with it in that
 * client's own test file — with a comment-stripping regex and a line filter that
 * had already drifted from these, so the rule had two definitions and two
 * coverages on its first day. That is the repeated-pattern drift CLAUDE.md calls
 * this repo's most expensive recurring mistake, arriving inside a guard written
 * to prevent it. ONE definition, applied to a list; a third client is one
 * filename.
 */
const PCO_CLIENTS = ["pco-service.ts", "pco-calendar-service.ts"] as const;

/** A line that is only prose. Not a wholesale comment strip — stripping is how a
 *  scan in this repo once swallowed real code and hid a route that existed. */
const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);

function linesOf(file: string): string[] {
  return fs.readFileSync(path.join(HERE, file), "utf8").split("\n");
}

/**
 * One console call as SOURCE TEXT, however many lines it spans.
 *
 * This scan used to look at single lines, which meant a call written as
 *
 *   console.warn(
 *     `[pco] ... ${value} ...`,
 *   );
 *
 * was invisible to it: the line matching `console.warn(` holds no interpolation,
 * and the line holding the interpolation does not match. Both PCO clients
 * contain exactly such a call, so the rule had a shape it structurally could not
 * see -- found by breaking one on purpose and watching the guard stay green,
 * which is the only way any of these have ever been found here.
 *
 * The block runs to the first line containing `);`, capped. Over-inclusion is
 * deliberate: sweeping in an extra line can only ever ADD an interpolation to
 * check, so the error direction is a false FAILURE, which someone reads. Ending
 * the block early would drop one, which nobody does.
 */
function consoleCalls(lines: string[]): { line: number; text: string }[] {
  const calls: { line: number; text: string }[] = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (!/console\.(log|warn|error)\s*\(/.test(line)) return;
    const block: string[] = [];
    for (let j = i; j < lines.length && j < i + 10; j++) {
      block.push(lines[j]);
      if (lines[j].includes(");")) break;
    }
    calls.push({ line: i + 1, text: block.join("\n") });
  });
  return calls;
}

/**
 * The TOP-LEVEL arguments of one captured console call, as source text.
 *
 * Split on commas that are actually separators: not the ones inside a nested
 * call, an array, an object, a quoted string or a template's `${…}`. A splitter
 * that cut on every comma would read `scrub(a, b)` as two arguments and excuse
 * the second one for not starting with `scrub(`.
 *
 * Deliberately a scanner rather than a parser. It is small enough to read, and
 * the test below feeds it the three shapes it has to get right.
 */
function consoleArguments(callText: string): string[] {
  // The console call's OWN paren, not the first one on the line: these are
  // routinely written `if (DEBUG_PCO) console.log(...)`, and starting at the
  // `if (` would report the guard as an argument.
  const head = /console\.(?:log|warn|error)\s*\(/.exec(callText);
  if (!head) return [];
  const open = head.index + head[0].length - 1;
  const args: string[] = [];
  let current = "";
  let depth = 0;
  // The quote character we are inside, or "" when we are not.
  let quote = "";
  for (let i = open + 1; i < callText.length; i++) {
    const c = callText[i];
    // Inside a literal, EVERYTHING runs to the closing quote — a comma in there
    // is never a separator, in a template's `${…}` or anywhere else.
    if (quote) {
      current += c;
      if (c === "\\") current += callText[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (c === ")" && depth === 0) break; // the call's own closing paren
      depth--;
    } else if (c === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") args.push(current);
  return args.map((a) => a.trim());
}

describe("scrub coverage in every PCO client", () => {
  for (const file of PCO_CLIENTS) {
    it(`${file}: every console call interpolates only scrubbed values`, () => {
      // Matched on the interpolation, not on the word "scrub": a comment saying
      // the right thing cannot satisfy this. An EXACT check over every log site,
      // so a newly-added unscrubbed one fails rather than riding along under a
      // floor.
      const offenders: string[] = [];
      for (const call of consoleCalls(linesOf(file))) {
        // Every `${...}` in the call must have scrub( inside it.
        for (const m of call.text.matchAll(/\$\{([^}]*)\}/g)) {
          if (!m[1].includes("scrub(")) offenders.push(`${call.line}: ${m[0]}`);
        }
      }
      assert.deepEqual(offenders, [], `${file}: these log sites interpolate unscrubbed values`);
    });

    it(`${file}: every console ARGUMENT is a literal or scrubbed`, () => {
      // The interpolation scan above only ever looked inside `${...}`, so
      //
      //   console.error("[pco] failed:", err)
      //
      // passed it without being examined at all — the value never touches a
      // template, and a newline in it forges a line on the LAN-visible /log page
      // exactly the same way. Latent rather than live when found; widened here
      // so it stays that way.
      //
      // The rule: each top-level argument is either a string/template literal
      // (whose interpolations the scan above has already checked) or a scrub()
      // call. Nothing else reaches console.
      const offenders: string[] = [];
      for (const call of consoleCalls(linesOf(file))) {
        for (const argument of consoleArguments(call.text)) {
          const a = argument.trim();
          if (a === "") continue;
          if (/^[`'"]/.test(a) || a.startsWith("scrub(")) continue;
          offenders.push(`${call.line}: ${a}`);
        }
      }
      assert.deepEqual(offenders, [], `${file}: these log arguments reach /log unscrubbed`);
    });
  }

  it("and the scan can actually SEE a call that spans several lines", () => {
    // The guard on the guard. Both clients contain a multi-line console.warn; a
    // line-based scan reports zero interpolations for it and passes on anything.
    const seen = PCO_CLIENTS.map((f) => consoleCalls(linesOf(f)))
      .flat()
      .filter((c) => c.text.includes("\n"));
    assert.ok(seen.length >= 2, `found ${seen.length} multi-line console calls; expected at least 2`);
    for (const c of seen) {
      assert.match(c.text, /\$\{/, `a multi-line call was captured without its body: ${c.text}`);
    }
  });

  it("and the argument split survives commas that are not separators", () => {
    // The guard on that guard. A splitter that cut on every comma would read
    // `scrub(a, b)` as two arguments and `${x ? "a," : "b"}` as three, and would
    // then flag or excuse the wrong halves.
    assert.deepEqual(consoleArguments('console.warn("a, b", scrub(c, 2), `${d}, e`)'), [
      '"a, b"',
      "scrub(c, 2)",
      "`${d}, e`",
    ]);
    // And it catches the shape this rule exists for.
    assert.deepEqual(consoleArguments('console.error("[pco] failed:", err)'), ['"[pco] failed:"', "err"]);
  });
});

/** Every non-test .ts under main/services, walked recursively, as file paths
 *  relative to this directory. */
function serviceSources(dir = HERE, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...serviceSources(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

/**
 * Every `url = …` that is choosing a NEXT PAGE, as source text, however many
 * lines it spans.
 *
 * Block-capturing for the same reason consoleCalls is: the two scans this
 * replaces were single-line, and the assignment they were written for is
 * routinely wrapped. The block runs to the first line containing `;`, capped;
 * over-inclusion can only ADD text to check, which fails loudly, where ending
 * early drops one silently.
 */
function pageAssignments(lines: string[]): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (!/\burl\s*=\s*/.test(line)) return;
    const block: string[] = [];
    for (let j = i; j < lines.length && j < i + 6; j++) {
      block.push(lines[j]);
      if (lines[j].includes(";")) break;
    }
    const text = block.join("\n");
    // Only the pagination ones. A url built from PCO_BASE and an id is not this.
    if (!/\blinks\b|\bnext\b|\boffset\b/.test(text)) return;
    found.push({ line: i + 1, text });
  });
  return found;
}

describe("pagination", () => {
  it("is written ONCE, and carries an integer rather than a URL from the body", () => {
    // Two things at once, because they are the same fact.
    //
    // EXACTLY ONE. This loop was three verbatim copies — two in pco-service.ts
    // and a third in pco-calendar-service.ts — and a rule that holds in one of
    // three places is the failure mode CLAUDE.md names as this repo's most
    // expensive. A floor would let a fourth copy ride along; an exact count
    // fails the moment one appears, which is the point at which it is cheap to
    // remove.
    //
    // AN INTEGER. `links.next` arrives in a response BODY and every request it
    // would feed carries the operator's App ID and secret. An offset cannot
    // carry a host, a path or a scheme, so following a page is structurally
    // safe rather than safe-because-checked.
    //
    // The whole services tree, not a hand-kept list of clients: a third PCO
    // client would otherwise arrive with its own copy and its own coverage, the
    // way the second one did.
    const found = serviceSources().flatMap((file) =>
      pageAssignments(fs.readFileSync(path.join(HERE, file), "utf8").split("\n")).map((a) => ({
        ...a,
        where: `${file}:${a.line}`,
      })),
    );
    // Files, not line numbers: a line number here would break on any edit above
    // it, and the fact under test is where the loop lives, not what line.
    assert.deepEqual(
      found.map((f) => f.where.replace(/:\d+$/, "")),
      ["pco-service.ts"],
      `the paging loop is no longer in exactly one place: ${found.map((f) => f.where).join(", ")}`,
    );
    assert.match(
      found[0].text,
      /withOffset\(/,
      `a request URL is built from a response body: ${found[0].text}`,
    );
  });

  it("and the scan can actually SEE a wrapped assignment", () => {
    // The guard on the guard. A line-based version reports nothing for the
    // wrapped form below, and then passes on anything.
    const wrapped = [
      "      url =",
      "        offset === null || offset <= seenOffset",
      "          ? null",
      "          : somethingElse(url, offset);",
    ];
    const seen = pageAssignments(wrapped);
    assert.equal(seen.length, 1, "a wrapped pagination assignment was invisible to the scan");
    assert.doesNotMatch(seen[0].text, /withOffset\(/, "the block was captured without its body");
  });
});

/**
 * Candidates whose ORIGIN genuinely is PCO's, and whose PATH then tries to be a
 * host.
 *
 * `sameOrigin` passes every one of these honestly. The hole was downstream:
 * pcoUrlFrom used to splice pathname + search into a STRING and hand it to
 * `new URL(path, origin)`, and a "path" beginning `//` is not a path to that
 * constructor -- it is a protocol-relative URL, so the origin argument is
 * ignored and the credentials follow the attacker's host.
 *
 * The list is deliberately wider than the one bug. The guard this replaces
 * covered a look-alike host, an off-origin host, a scheme downgrade and a
 * non-URL, and its author plainly believed that was exhaustive -- it was the
 * tenth guard in this repo to pass on the exact defect it was written for. Four
 * of the ten below got through before the fix. The other six never did, and are
 * kept precisely because "we tried it and it was already safe" is the part that
 * is otherwise lost the moment the session ends.
 */
const PATH_THAT_WANTS_TO_BE_A_HOST = [
  // Leaked before the fix.
  "//attacker.test/x",
  "///attacker.test/x",
  "//user:pw@attacker.test/x",
  // Leaked before the fix, and no check on the RAW string would have caught it:
  // WHATWG folds a backslash to a slash for a special scheme, so this ARRIVES as
  // a `//` path however it was written.
  "/\\\\attacker.test/x",
  // Did not leak, before or after. Kept as evidence they were tried.
  "/@attacker.test/x",
  "/%2f%2fattacker.test/x",
  "/%5c%5cattacker.test/x",
  "/%0a//attacker.test/x",
  "/../../attacker.test/x",
  "/.//attacker.test/x",
] as const;

describe("a path that tries to be a host", () => {
  it("never leaves PCO's origin, whatever the path looks like", () => {
    for (const path of PATH_THAT_WANTS_TO_BE_A_HOST) {
      const out = pcoUrlFrom(`https://api.planningcenteronline.com${path}`, PCO);
      assert.ok(out, `pcoUrlFrom returned null for ${path}`);
      assert.equal(
        new URL(out).origin,
        "https://api.planningcenteronline.com",
        `credentials would go off-origin for ${path}: ${out}`,
      );
    }
  });

  it("and the whole way through requestProduct, to the URL fetch is handed", async () => {
    // Asserted at the SINK. The unit test above pins the helper; this pins that
    // nothing between it and fetch() undoes the work -- the helper was correct
    // for two years by inspection and wrong in practice.
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      for (const path of PATH_THAT_WANTS_TO_BE_A_HOST) {
        await pcoService.requestProduct(
          `https://api.planningcenteronline.com${path}`,
          "app",
          "secret",
          "2018-11-01",
        );
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(asked.length, PATH_THAT_WANTS_TO_BE_A_HOST.length);
    for (const url of asked) {
      assert.equal(
        new URL(url).origin,
        "https://api.planningcenteronline.com",
        `a credentialed request went to ${new URL(url).origin}`,
      );
    }
  });
});

describe("requestProduct, the one PUBLIC way into a credentialed fetch", () => {
  // Until a second PCO product needed the transport, "no outside string reaches
  // a credentialed fetch" held because `request` was private and every URL in
  // pco-service.ts was built from PCO_BASE. requestProduct is public on an
  // exported singleton and takes a url, so the invariant has to be enforced
  // rather than assumed: it rebuilds the host from the constant, exactly as
  // pcoUrlFrom does, and refuses anything that is not PCO's.
  //
  // Driven for real. A docstring asking callers to behave would pass a source
  // scan and protect nothing.

  it("refuses to send credentials to a look-alike host", async () => {
    const realFetch = globalThis.fetch;
    let reached = false;
    globalThis.fetch = (async () => {
      reached = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      for (const bad of [
        "https://api.planningcenteronline.com.evil.example/calendar/v2/event_instances",
        "https://evil.example/calendar/v2/event_instances",
        "http://api.planningcenteronline.com/calendar/v2/event_instances",
        "not a url",
      ]) {
        await assert.rejects(
          () => pcoService.requestProduct(bad, "app", "secret", "2018-11-01"),
          /refusing to send credentials/,
          `credentials were sent to ${bad}`,
        );
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(reached, false, "a request went out to a non-PCO host");
  });

  it("takes the host from the constant, not from the caller's string", async () => {
    const realFetch = globalThis.fetch;
    let asked = "";
    globalThis.fetch = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await pcoService.requestProduct(
        "https://api.planningcenteronline.com/calendar/v2/calendars?per_page=100",
        "app",
        "secret",
        "2018-11-01",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(new URL(asked).origin, "https://api.planningcenteronline.com");
    assert.equal(new URL(asked).pathname, "/calendar/v2/calendars");
  });
});

describe("the calendar client owns no transport of its own", () => {
  it("calls fetch() nowhere", () => {
    // The gate, the retry budget and the backoff live in pco-service.ts and are
    // shared, not copied — PCO's rate limit is per APP, so a second ungated
    // request path would spend one budget twice as fast and the cap would stop
    // capping anything. A direct fetch here is how that happens quietly.
    const offenders: string[] = [];
    linesOf("pco-calendar-service.ts").forEach((line, i) => {
      if (isComment(line)) return;
      if (/\bfetch\s*\(/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], "these bypass the shared PCO transport");
  });
});

// The check above passes whether or not anybody CALLS it, which is how it came
// to be applied at one of three sites and missed at the other two. CodeQL found
// them as two critical js/request-forgery alerts: `links.next` from a response
// body, handed straight to request(), which attaches the operator's App ID and
// secret.
//
// So this asserts APPLICATION, not existence, and matches on the assignment
// rather than the word — prose cannot satisfy it. Counts are EXACT: a new
// follow-the-link site fails here until it is guarded, rather than riding along
// under a floor.
describe("the pagination cursor", () => {
  const PAGE = "https://api.planningcenteronline.com/services/v2/service_types/1/plans?per_page=25";

  it("takes the offset out of a next link", () => {
    assert.equal(nextOffset(`${PAGE}&offset=50`), 50);
    assert.equal(nextOffset(`${PAGE}&offset=0`), 0);
  });

  it("refuses anything that is not a plain non-negative integer", () => {
    for (const bad of [
      `${PAGE}&offset=-1`,
      `${PAGE}&offset=1.5`,
      `${PAGE}&offset=abc`,
      `${PAGE}&offset=`,
      PAGE, // no offset at all — the last page
      "not a url",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(nextOffset(bad), null, `must refuse ${String(bad)}`);
    }
  });

  it("builds the next URL from OUR url, keeping its other parameters", () => {
    const out = withOffset(`${PAGE}&include=items`, 75);
    const u = new URL(out);
    assert.equal(u.origin, "https://api.planningcenteronline.com");
    assert.equal(u.searchParams.get("offset"), "75");
    assert.equal(u.searchParams.get("per_page"), "25", "our other parameters survive");
    assert.equal(u.searchParams.get("include"), "items");
  });

  it("replaces an existing offset rather than appending a second", () => {
    const u = new URL(withOffset(`${PAGE}&offset=25`, 50));
    assert.deepEqual(u.searchParams.getAll("offset"), ["50"]);
  });
});

describe("no response-body URL is followed", () => {
  const src = fs.readFileSync(path.join(HERE, "pco-service.ts"), "utf8");
  const lines = src.split("\n");

  it("and there is exactly the ONE site we know about", () => {
    // ONE pagination follow, in readPcoPages. It was two here and a third in
    // pco-calendar-service.ts; all three readers now share the loop. A second
    // appearing without a guard fails the exact-count scan above; a second
    // appearing WITH one fails this, so it has to be looked at either way.
    //
    // The Live action URL is not among them: it is constructed outright.
    const uses = lines.filter((l) => l.includes("withOffset(") && !l.includes("export function withOffset"));
    assert.equal(uses.length, 1, `expected 1 pagination site, found ${uses.length}:\n  ${uses.join("\n  ")}`);
  });

  it("no fetch in this file takes a URL that skipped the guard", () => {
    // The sinks: requestInner, postAction and postJson. All three take a `url`
    // PARAMETER, so the origin check has to happen in the callers above — this
    // pins that no sink has grown a form that builds its own URL out of response
    // data where the guard could not reach it.
    //
    // postJson is the one worth naming: it is only ever called with a URL built
    // from PCO_BASE, but it exists to open an attachment, whose RESPONSE is a
    // temporary link. If that link ever becomes something this server fetches
    // rather than something it hands to the browser, it needs the guard too.
    //
    // All three now go through the single private pcoFetch, which is the only
    // thing in the file that calls fetch — that is what makes the API-version and
    // Authorization headers unskippable (see pco-api-version.test.ts, which pins
    // the same count for that reason). So there are two shapes to count: the one
    // real sink, and the three callers that reach it.
    //
    // Comment lines excluded. This counted every line containing "fetch(",
    // including prose — a docblock that mentions fetch() moved the count and
    // failed the test, which is the mirror image of the trap CLAUDE.md names:
    // there, a comment SATISFIED a scan. Dropping comment lines rather than
    // stripping comments wholesale, because stripping is how a scan in this repo
    // once swallowed real code and hid a route that existed.
    const body = lines.filter((l) => !isComment(l));

    // `\bfetch\(` is case-sensitive, so `this.pcoFetch(` is not counted here.
    const fetches = body.filter((l) => /\bfetch\(/.test(l));
    assert.equal(fetches.length, 1, `expected exactly 1 raw fetch site (pcoFetch), found ${fetches.length}:\n  ${fetches.join("\n  ")}`);
    for (const f of fetches) {
      // STRICTER than it was. It used to accept `fetch(url`, which passed the
      // caller's string through untouched. The one fetch must now go through
      // pinnedToPco, so the origin is forced at the point the credentials are
      // attached rather than trusted from every call site.
      assert.match(
        f,
        /fetch\(pinnedToPco\(url\)/,
        `the one fetch must pin its origin, and does not: ${f.trim()}`,
      );
    }

    const callers = body.filter((l) => /\bthis\.pcoFetch\(/.test(l));
    assert.equal(callers.length, 3, `expected 3 pcoFetch callers, found ${callers.length}:\n  ${callers.join("\n  ")}`);
    for (const c of callers) {
      assert.match(c, /pcoFetch\(url\b/, `pcoFetch takes something other than the checked url: ${c.trim()}`);
    }
  });
});
