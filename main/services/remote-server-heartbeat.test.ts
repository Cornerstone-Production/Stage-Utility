// The event stream's heartbeat is an event a page can see.
//
// It was an SSE comment (`: ping`), which keeps the pipe warm and reaps a dead
// client on the server's side, but EventSource never surfaces a comment: to a page,
// a server that had stopped sending looked exactly like a quiet one, and a kept
// Screens preview on a frozen server said it was live for good. Each page now takes
// its stream as down after SSE_SILENCE_MS of hearing nothing (renderer/lib/api.ts,
// the shared worker), which only works if the heartbeat is something it hears.
//
// Through the real route, over a real socket, with the heartbeat written by the
// same function start() runs on its timer.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";
import { createSseReader } from "./sse-reader.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-heartbeat-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer, writeSseHeartbeats } = await import("./remote-server.js");
const { SSE_HEARTBEAT_EVENT } = await import("../types/sse.js");

let server: SocketServer;

before(async () => {
  server = await serveOnSocket(new RemoteServer().handle);
});

after(async () => {
  await server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

test("the heartbeat is a named event, which EventSource dispatches, not a comment it drops", async () => {
  const reader = createSseReader();
  const names: (string | null)[] = [];
  let req!: http.ClientRequest;
  await new Promise<void>((resolve, reject) => {
    req = http.get({ host: "127.0.0.1", port: server.port, path: "/api/events?cid=heartbeat-test" }, (res) => {
      res.setEncoding("utf8");
      let wrote = false;
      res.on("data", (chunk: string) => {
        for (const event of reader.push(chunk)) names.push(event.event);
        // The hello burst has arrived, so the stream is registered: send one beat.
        if (!wrote) {
          wrote = true;
          setImmediate(writeSseHeartbeats);
        }
        if (names.includes(SSE_HEARTBEAT_EVENT)) resolve();
      });
    });
    req.on("error", reject);
    setTimeout(() => reject(new Error(`no heartbeat event; saw ${JSON.stringify(names)}`)), 3000).unref();
  });
  req.destroy();
  assert.ok(names.includes(SSE_HEARTBEAT_EVENT));
});
