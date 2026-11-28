// The auto-start lines name the live PCO item, and an item's title is whatever a
// producer typed into Planning Center: a newline in it must not forge a second
// line on /log. The recorders already scrub the same field.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-autostart-log-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService } = await import("./baptism-timer-service.js");
const { settingsStore } = await import("./settings-store.js");
const { captureConsole } = await import("./fixtures/capture-console.js");

test("an item title with a newline cannot forge a second line when it starts the timer", async (t) => {
  await settingsStore.patch({ baptismAutoStart: { enabled: true, testimonyKeyword: "stories" } });
  const lines = captureConsole(t, "log", "warn");
  await baptismTimerService.onLiveTick({
    mode: "item",
    currentItemId: "item-1",
    label: "Baptism stories\n[stage-controller] plan switched to 12345",
    lengthSec: null,
    liveStartAt: null,
    targetAt: null,
    serverNow: new Date().toISOString(),
    currentItemTitle: null,
    nextItemTitle: null,
    serviceTimeId: null,
  } as Parameters<typeof baptismTimerService.onLiveTick>[0]);
  const said = lines.filter((l) => l.includes("[baptism] auto-start"));
  assert.equal(said.length, 1, lines.join(" | "));
  assert.ok(!said[0]!.includes("\n"), `the item title reached the log unescaped: ${JSON.stringify(said[0])}`);
  assert.match(said[0]!, /stories\\n\[stage-controller\]/);
  baptismTimerService.reset();
});
