// Tests for the cross-origin guard on state-changing requests.
//
// The failure modes are asymmetric and both bad: too strict silently breaks the
// Companion module, the kiosk displays or the dev proxy (and it breaks them in
// production, not here), too loose leaves POST /api/update/apply reachable from
// any page the operator happens to visit. Both directions are pinned below.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { isCrossOrigin, handlerErrorStatus, handlerErrorCode } from "./remote-server.js";
import { ServiceIsLiveError, NoRawRowsError } from "./history-edit.js";

const HOST = "192.168.1.50:8788";

// The catch in startServer's own request handler — the ONE place these two
// functions' answers actually reach the wire — is untestable through
// callRoute (every route test stops at the route, before this catch ever
// runs) and untestable through the header/UI tests (they stub fetch
// entirely). These three real error shapes are what a route actually
// throws; testing the pure functions directly is what actually covers the
// line, not a route test that happens to also exercise it.
describe("what a thrown route error puts on the wire", () => {
  test("ServiceIsLiveError becomes a 409 carrying code 'live'", () => {
    const err = new ServiceIsLiveError("rebuilt");
    const status = handlerErrorStatus(err);
    assert.equal(status, 409);
    assert.equal(handlerErrorCode(err, status), "live");
  });

  test("NoRawRowsError becomes a 409 carrying code 'no-raw-rows' — tellable apart from ServiceIsLiveError's own 409", () => {
    const err = new NoRawRowsError();
    const status = handlerErrorStatus(err);
    assert.equal(status, 409);
    assert.equal(handlerErrorCode(err, status), "no-raw-rows");
  });

  test("an ordinary failure becomes a 500 with NO code — a Node errno must never reach the wire", () => {
    const err = Object.assign(new Error("ENOSPC: no space left on device"), { errno: -28, code: "ENOSPC" });
    const status = handlerErrorStatus(err);
    assert.equal(status, 500, "sanity: an undeclared status falls back to 500");
    assert.equal(
      handlerErrorCode(err, status),
      undefined,
      "the error's own Node errno code must not be forwarded just because the shape looks similar",
    );
  });
});

describe("isCrossOrigin — clients that must keep working", () => {
  test("a request with no Origin is allowed (Companion, curl, scripts)", () => {
    // Non-browser clients never send Origin. The Companion module is a Node
    // process; rejecting these would break it silently in the field.
    assert.equal(isCrossOrigin(undefined, HOST), false);
  });

  test("a same-origin request from a display is allowed", () => {
    assert.equal(isCrossOrigin("http://192.168.1.50:8788", HOST), false);
  });

  test("the friendly port 80 reaching the same host is allowed", () => {
    // The app binds :80 alongside :8788; a page served from one may call the other.
    assert.equal(isCrossOrigin("http://192.168.1.50", "192.168.1.50:8788"), false);
    assert.equal(isCrossOrigin("http://192.168.1.50:8788", "192.168.1.50"), false);
  });

  test("the Vite dev proxy (:3000 -> :8788) is allowed", () => {
    assert.equal(isCrossOrigin("http://localhost:3000", "localhost:8788"), false);
  });

  test("localhost and IPv6 loopback match themselves", () => {
    assert.equal(isCrossOrigin("http://localhost:8788", "localhost:8788"), false);
    assert.equal(isCrossOrigin("http://[::1]:8788", "[::1]:8788"), false);
  });

  test("hostname comparison is case-insensitive", () => {
    assert.equal(isCrossOrigin("http://Stage.local:8788", "stage.local:8788"), false);
  });

  test("an https origin on the same host is allowed", () => {
    // A reverse proxy terminating TLS in front of the appliance.
    assert.equal(isCrossOrigin("https://stage.local", "stage.local:8788"), false);
  });
});

describe("isCrossOrigin — requests that must be rejected", () => {
  test("a drive-by page on another domain is rejected", () => {
    assert.equal(isCrossOrigin("https://evil.example", HOST), true);
  });

  test("a DNS-rebinding page is rejected by its Origin, not its resolved address", () => {
    // The attacker's DNS points at the LAN IP, so Host looks legitimate — but the
    // page's origin is still their domain.
    assert.equal(isCrossOrigin("http://rebind.evil.example", HOST), true);
  });

  test("an opaque origin (sandboxed iframe) is rejected", () => {
    assert.equal(isCrossOrigin("null", HOST), true);
  });

  test("a malformed Origin is rejected rather than treated as same-origin", () => {
    assert.equal(isCrossOrigin("not a url", HOST), true);
  });

  test("a hostname that merely contains the host is rejected", () => {
    // Guards against a substring/prefix match creeping in later.
    assert.equal(isCrossOrigin("http://192.168.1.50.evil.example", HOST), true);
    assert.equal(isCrossOrigin("http://evil-192.168.1.50", HOST), true);
  });

  test("a different LAN host is rejected", () => {
    assert.equal(isCrossOrigin("http://192.168.1.99:8788", HOST), true);
  });

  test("a missing Host header with a present Origin is rejected", () => {
    assert.equal(isCrossOrigin("https://evil.example", undefined), true);
  });
});
