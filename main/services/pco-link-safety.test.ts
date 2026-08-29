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

import { sameOrigin, pcoUrlFrom, nextOffset, withOffset } from "./pco-service.js";

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

  it("no URL from a response body is followed at all any more", () => {
    // The contract is stronger than "rebuilt on our origin": pagination carries
    // an integer, and the Live action URL is constructed, so there is no string
    // from a PCO body that reaches fetch(). pcoUrlFrom survives only to compare
    // against, for a log line.
    const src = fs.readFileSync(path.join(HERE, "pco-service.ts"), "utf8");
    const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
    const assignments = src
      .split("\n")
      .filter((l) => !isComment(l))
      .filter((l) => /\burl\s*=\s*/.test(l) && /\blinks\b|\bnext\b/.test(l));
    for (const line of assignments) {
      assert.match(
        line,
        /withOffset\(/,
        `a request URL is still built from a response body: ${line.trim()}`,
      );
    }
  });
});

describe("scrub coverage in pco-service.ts", () => {
  it("every console line interpolates only scrubbed values", () => {
    // Matched on the interpolation, not on the word "scrub": a comment saying the
    // right thing cannot satisfy this. An EXACT check over every log site, so a
    // newly-added unscrubbed one fails rather than riding along under a floor.
    const src = fs.readFileSync(path.join(HERE, "pco-service.ts"), "utf8");
    const lines = src.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/console\.(log|warn|error)\(/.test(line)) return;
      // Every `${...}` in the line must have scrub( inside it.
      for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
        if (!m[1].includes("scrub(")) offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(offenders, [], "these log sites interpolate unscrubbed values");
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

  it("pagination carries an integer, not a URL", () => {
    // An offset cannot carry a host, a path, or a scheme. This is what makes
    // following a page structurally safe rather than safe-because-checked.
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/\burl\s*=\s*/.test(line)) return;
      if (!/\bnext\b|\boffset\b/.test(line)) return;
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (!line.includes("withOffset(")) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], "these build a request URL out of a response body");
  });

  it("and there are exactly the three sites we know about", () => {
    // One live-action URL plus two pagination follows. A fourth appearing
    // without a guard fails the test above; a fourth appearing WITH one fails
    // this, so it has to be looked at either way.
    // Two pagination loops carrying an offset. The Live action URL is no longer
    // among them: it is constructed outright.
    const uses = lines.filter((l) => l.includes("withOffset(") && !l.includes("export function withOffset"));
    assert.equal(uses.length, 2, `expected 2 pagination sites, found ${uses.length}:\n  ${uses.join("\n  ")}`);
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
    const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
    const body = lines.filter((l) => !isComment(l));

    // `\bfetch\(` is case-sensitive, so `this.pcoFetch(` is not counted here.
    const fetches = body.filter((l) => /\bfetch\(/.test(l));
    assert.equal(fetches.length, 1, `expected exactly 1 raw fetch site (pcoFetch), found ${fetches.length}:\n  ${fetches.join("\n  ")}`);
    for (const f of fetches) {
      assert.match(f, /fetch\(url\b/, `fetch takes something other than the checked url: ${f.trim()}`);
    }

    const callers = body.filter((l) => /\bthis\.pcoFetch\(/.test(l));
    assert.equal(callers.length, 3, `expected 3 pcoFetch callers, found ${callers.length}:\n  ${callers.join("\n  ")}`);
    for (const c of callers) {
      assert.match(c, /pcoFetch\(url\b/, `pcoFetch takes something other than the checked url: ${c.trim()}`);
    }
  });
});
