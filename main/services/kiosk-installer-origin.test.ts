// The macOS installer is told which server it came from, by the server, from the
// request's Host header, and then runs as root. What may be stamped in is the
// whole question.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ORIGIN_MARKER, WINDOWS_ORIGIN_MARKER, originFromHost, stampOrigin } from "./kiosk-installer-origin.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(path.join(HERE, "..", "..", "scripts", "kiosk", "install-macos.sh"), "utf8");

describe("originFromHost", () => {
  it("accepts the addresses a server is reached by", () => {
    assert.equal(originFromHost("192.0.2.10:8788", false), "http://192.0.2.10:8788");
    assert.equal(originFromHost("stage.local", false), "http://stage.local");
    assert.equal(originFromHost("stage-utility.example.org:80", false), "http://stage-utility.example.org:80");
    assert.equal(originFromHost("[fd00::1]:8788", false), "http://[fd00::1]:8788");
    assert.equal(originFromHost("stage.local", true), "https://stage.local");
  });

  it("refuses anything a shell would read as syntax", () => {
    for (const h of [
      'x"; rm -rf /; "',
      "a b",
      "host\nFETCHED_FROM=evil",
      "$(id)",
      "`id`",
      "a;b",
      "a|b",
      "host:80/path",
      "host:port",
      "host:123456",
      "-leading-dash.example",
      "a".repeat(300),
      "",
    ]) {
      assert.equal(originFromHost(h, false), null, JSON.stringify(h));
    }
    assert.equal(originFromHost(undefined, false), null);
  });
});

describe("stampOrigin on the real installer", () => {
  it("finds its marker exactly once, as a whole line", () => {
    assert.equal(SCRIPT.split("\n").filter((l) => l === ORIGIN_MARKER).length, 1);
  });

  it("puts the address on that line and nowhere else", () => {
    const stamped = stampOrigin(SCRIPT, "http://192.0.2.10:8788", "install-macos.sh");
    assert.ok(stamped.split("\n").includes('FETCHED_FROM="http://192.0.2.10:8788"'));
    assert.ok(!stamped.split("\n").includes(ORIGIN_MARKER));
    assert.equal(stamped.length, SCRIPT.length + "http://192.0.2.10:8788".length);
  });

  it("leaves the script as it is when there is no usable address", () => {
    assert.equal(stampOrigin(SCRIPT, null, "install-macos.sh"), SCRIPT);
  });

  it("refuses to pass through a script it cannot stamp", () => {
    assert.throws(() => stampOrigin(SCRIPT.replace(ORIGIN_MARKER, "FETCHED_FROM=${X:-}"), "http://a", "install-macos.sh"), /no FETCHED_FROM/);
  });
});

describe("stampOrigin on the Windows installer", () => {
  const WIN = readFileSync(path.join(HERE, "..", "..", "scripts", "kiosk", "install-windows.ps1"), "utf8");

  it("finds its marker exactly once, as a whole line", () => {
    assert.equal(WIN.split("\n").filter((l) => l.replace(/\r$/, "") === WINDOWS_ORIGIN_MARKER).length, 1);
  });

  it("puts the address in single quotes on that line", () => {
    const stamped = stampOrigin(WIN, "http://192.0.2.10:8788", "install-windows.ps1");
    assert.ok(stamped.split("\n").includes("$FetchedFrom = 'http://192.0.2.10:8788'"));
    assert.ok(!stamped.split("\n").includes(WINDOWS_ORIGIN_MARKER));
  });

  it("keeps a CRLF script's line ends", () => {
    const crlf = `a\r\n${WINDOWS_ORIGIN_MARKER}\r\nb\r\n`;
    assert.equal(stampOrigin(crlf, "http://h", "install-windows.ps1"), "a\r\n$FetchedFrom = 'http://h'\r\nb\r\n");
  });

  it("stamps a marker on the last line, with no newline after it", () => {
    assert.equal(stampOrigin(`a\n${WINDOWS_ORIGIN_MARKER}`, "http://h", "install-windows.ps1"), "a\n$FetchedFrom = 'http://h'");
  });

  it("refuses an installer it does not stamp", () => {
    assert.throws(() => stampOrigin("x", "http://h", "install-linux.sh"), /not an installer the server stamps/);
  });
});
