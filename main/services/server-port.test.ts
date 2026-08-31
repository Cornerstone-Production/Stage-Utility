// The server and the dev proxy agree on one port, by construction.
//
// They used to disagree by construction instead: remote-server.ts read
// STAGE_UTILITY_PORT and vite.config.ts hard-coded 8788, so moving the server
// off the default left the dev UI talking to whatever else answered there. This
// asserts both that serverPort() behaves, and — reading the real config file —
// that no proxy target has drifted back to a literal.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { APP_ROOT } from "./app-root.js";
import { DEFAULT_SERVER_PORT, serverPort } from "./server-port.js";

describe("serverPort", () => {
  test("follows STAGE_UTILITY_PORT", () => {
    assert.equal(serverPort({ STAGE_UTILITY_PORT: "8799" } as NodeJS.ProcessEnv), 8799);
  });

  test("falls back when unset, blank or unparseable — never to port 0", () => {
    // Number("") is 0 and Number("nope") is NaN. Binding 0 means "any free
    // port", which would put the server somewhere nobody is looking rather than
    // failing loudly.
    for (const v of [undefined, "", "   ", "nope", "0"]) {
      const env = (v === undefined ? {} : { STAGE_UTILITY_PORT: v }) as NodeJS.ProcessEnv;
      assert.equal(serverPort(env), DEFAULT_SERVER_PORT, `"${v}" did not fall back`);
    }
  });
});

describe("the dev proxy and the server cannot disagree", () => {
  test("no proxy target hardcodes a port", () => {
    const config = readFileSync(`${APP_ROOT}/vite.config.ts`, "utf8");
    // Every `target:` in the proxy block must be the shared constant, not a URL.
    const targets = [...config.matchAll(/target:\s*(.+?),/g)].map((m) => m[1].trim());
    assert.ok(targets.length > 0, "found no proxy targets at all — this guard is reading nothing");
    assert.deepEqual(
      targets.filter((t) => t !== "API_TARGET"),
      [],
      "a dev proxy target is a literal again: move the server off 8788 and the UI still talks to 8788",
    );
  });

  test("and the shared constant is built from serverPort", () => {
    const config = readFileSync(`${APP_ROOT}/vite.config.ts`, "utf8");
    assert.match(
      config,
      /const API_TARGET = `http:\/\/localhost:\$\{serverPort\(\)\}`/,
      "API_TARGET stopped deriving from serverPort()",
    );
  });

  test("the server binds through the same function", () => {
    const server = readFileSync(`${APP_ROOT}/main/services/remote-server.ts`, "utf8");
    assert.match(server, /const PORT = serverPort\(\);/, "remote-server stopped using serverPort()");
    assert.doesNotMatch(
      server,
      /Number\(process\.env\.STAGE_UTILITY_PORT\)/,
      "remote-server re-derives the port itself, so the two can drift again",
    );
  });
});
