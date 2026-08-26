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

import { sameOrigin, pcoUrlFrom } from "./pco-service.js";

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

  it("is what pco-service calls at every following site", () => {
    // The wiring. The rebuild is worth nothing if a site still passes the raw
    // string, and there are three: the Live action link and two pagination loops.
    const src = fs.readFileSync(path.join(HERE, "pco-service.ts"), "utf8");
    const follows = [...src.matchAll(/pcoUrlFrom\(/g)];
    assert.equal(
      follows.length,
      4,
      `expected three call sites plus the definition, found ${follows.length}`,
    );
    assert.doesNotMatch(
      src,
      /url = sameOrigin\([^)]*\) \? \w+ : null/,
      "a site is still handing fetch() the string that arrived in the body",
    );
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
describe("pcoUrlFrom is applied wherever a body URL is followed", () => {
  const src = fs.readFileSync(path.join(HERE, "pco-service.ts"), "utf8");
  const lines = src.split("\n");

  it("every URL taken from links.next is guarded", () => {
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      // The assignment that decides what the next request goes to.
      if (!/\burl\s*=\s*/.test(line)) return;
      if (!/\bnext\b/.test(line)) return;
      // pcoUrlFrom, not sameOrigin: checking the origin and passing the original
      // string on left the value that carries the credentials as the one that
      // came off the wire. The rebuild is what the sites must use now.
      if (!line.includes("pcoUrlFrom(")) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], "these follow a response-body URL without checking its origin");
  });

  it("and there are exactly the three sites we know about", () => {
    // One live-action URL plus two pagination follows. A fourth appearing
    // without a guard fails the test above; a fourth appearing WITH one fails
    // this, so it has to be looked at either way.
    const uses = lines.filter(
      (l) => l.includes("pcoUrlFrom(") && !l.includes("export function pcoUrlFrom"),
    );
    assert.equal(uses.length, 3, `expected 3 guarded sites, found ${uses.length}:\n  ${uses.join("\n  ")}`);
  });

  it("no fetch in this file takes a URL that skipped the guard", () => {
    // The sinks themselves: requestInner, postAction and postJson. All three
    // take a `url` PARAMETER, so the origin check has to happen in the callers
    // above — this pins that no sink has grown a form that builds its own URL
    // out of response data where the guard could not reach it.
    //
    // postJson is the one worth naming: it is only ever called with a URL built
    // from PCO_BASE, but it exists to open an attachment, whose RESPONSE is a
    // temporary link. If that link ever becomes something this server fetches
    // rather than something it hands to the browser, it needs the guard too.
    // Comment lines excluded. This counted every line containing "fetch(",
    // including prose — a docblock that mentions fetch() moved the count and
    // failed the test, which is the mirror image of the trap CLAUDE.md names:
    // there, a comment SATISFIED a scan. Dropping comment lines rather than
    // stripping comments wholesale, because stripping is how a scan in this repo
    // once swallowed real code and hid a route that existed.
    const isComment = (l: string) => /^\s*(\/\/|\*|\/\*)/.test(l);
    const fetches = lines.filter((l) => !isComment(l) && /\bfetch\(/.test(l));
    assert.equal(fetches.length, 3, `expected 3 fetch sites, found ${fetches.length}`);
    for (const f of fetches) assert.match(f, /fetch\(url\b/, `fetch takes something other than the checked url: ${f.trim()}`);
  });
});
