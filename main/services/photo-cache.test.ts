// /photos?u= is reachable unauthenticated from the LAN and returns the fetched
// body to the caller. Without a host check it is an open proxy into the church
// network: the appliance fetches an internal host on the caller's behalf and
// hands back the response. Every real photo URL comes from a PCO Person record.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isAllowedPhotoUrl } from "./photo-cache.js";

describe("photo proxy host allowlist", () => {
  it("allows the avatars production actually serves", () => {
    // Taken from a live /api/state.
    assert.ok(
      isAllowedPhotoUrl(
        "https://avatars.planningcenteronline.com/uploads/person/36097057-1522778894/avatar.3.png?g=220x1000%23",
      ),
    );
  });

  it("allows other planningcenteronline.com subdomains", () => {
    assert.ok(isAllowedPhotoUrl("https://api.planningcenteronline.com/x.jpg"));
    assert.ok(isAllowedPhotoUrl("https://planningcenteronline.com/x.jpg"));
  });

  it("refuses internal and loopback hosts", () => {
    for (const u of [
      "http://127.0.0.1:9090/metrics",
      "http://192.168.1.1/admin/config",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/",
      "https://192.168.16.61:8788/api/log",
    ]) {
      assert.equal(isAllowedPhotoUrl(u), false, u);
    }
  });

  it("refuses plain http, which could reach an internal host on port 80", () => {
    assert.equal(isAllowedPhotoUrl("http://avatars.planningcenteronline.com/x.jpg"), false);
  });

  it("refuses a lookalike host that merely ends with the domain text", () => {
    assert.equal(isAllowedPhotoUrl("https://planningcenteronline.com.evil.test/x.jpg"), false);
    assert.equal(isAllowedPhotoUrl("https://notplanningcenteronline.com/x.jpg"), false);
    assert.equal(isAllowedPhotoUrl("https://evil.test/?planningcenteronline.com"), false);
  });

  it("refuses non-http schemes and junk", () => {
    for (const u of ["file:///etc/passwd", "gopher://x/", "not a url", ""]) {
      assert.equal(isAllowedPhotoUrl(u), false, u);
    }
  });

  it("is not fooled by userinfo pointing at another host", () => {
    // https://allowed@evil.test/ has hostname evil.test, not the allowed domain.
    assert.equal(isAllowedPhotoUrl("https://avatars.planningcenteronline.com@evil.test/x.jpg"), false);
  });
});
