// An imported bundle's manifest names its own directory. That name arrives over
// an unauthenticated POST from the LAN, so it is attacker-controlled and must
// never reach the filesystem as a path component. These cover the containment
// check that backs the recompute in archive-bundle's import.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as path from "node:path";

import { isInside, serviceDirName } from "./archive-paths.js";

describe("isInside", () => {
  const root = path.resolve("/data/archive");

  it("accepts a path under the root", () => {
    assert.ok(isInside(root, path.join(root, "2026-08-09_st1-p2-t3", "spl.csv")));
  });

  it("accepts the root itself", () => {
    assert.ok(isInside(root, root));
  });

  it("rejects a traversal out of the root", () => {
    // The exploit: a manifest dir of ../../../../home/pi/.ssh
    assert.equal(isInside(root, path.join(root, "../../home/pi/.ssh/authorized_keys")), false);
  });

  it("rejects a sibling that merely shares the prefix", () => {
    assert.equal(isInside(root, path.resolve("/data/archive-evil/x")), false);
  });

  it("rejects an unrelated absolute path", () => {
    assert.equal(isInside(root, path.resolve("/etc/passwd")), false);
  });
});

describe("serviceDirName", () => {
  it("strips traversal out of a crafted key or date", () => {
    const dir = serviceDirName("../../etc", "../..");
    assert.ok(!dir.includes(".."), `still traversable: ${dir}`);
    assert.ok(!dir.includes("/"), `still a path: ${dir}`);
  });

  it("keeps a real key readable and sortable by date", () => {
    assert.equal(serviceDirName("st1:p123:t9", "2026-08-09"), "2026-08-09_st1-p123-t9");
  });

  it("recomputing from a manifest's own fields lands under the root", () => {
    // The import path derives the destination this way instead of trusting
    // manifest.dir, so a crafted dir cannot escape however it is spelled.
    const root = path.resolve("/data/archive");
    const dest = path.join(root, serviceDirName("../../../../root", "../../.."), "spl.csv");
    assert.ok(isInside(root, dest));
  });
});
