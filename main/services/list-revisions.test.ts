// The count of saves a browser tells its own echo from another browser's change by
// (StageState.listRevisions; renderer/app/use-saved-list.ts reads it).
//
// The real controller and the real broadcaster, against a temp data directory: the
// answer to a save and the broadcast of it must carry the same count, and each save
// a higher one than the last, or a browser holding the answer could not place a
// broadcast before or after it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "list-revisions-"));
process.env.STAGE_UTILITY_DATA = TMP;

import type { StageState } from "../types/state.js";

const { stageController } = await import("./stage-controller.js");
const { addBroadcastListener } = await import("./broadcaster.js");

type Revisions = { boot: string; sidebar: number; bar: number };
const frames: Revisions[] = [];
addBroadcastListener((channel, payload, serialized) => {
  if (channel !== "stage:state-changed") return;
  frames.push((JSON.parse(serialized ?? JSON.stringify(payload)) as { listRevisions: Revisions }).listRevisions);
});

const HIDE = (hidden: string[]) => ({ sections: [], hidden });

describe("the count of sidebar and bar saves", () => {
  it("is carried alike by a save's answer and its broadcast, and goes up with every save of its list", async () => {
    const start = stageController.getState().listRevisions;
    const steps: { answer: Revisions; sent: Revisions | undefined }[] = [];
    const run = async (save: () => Promise<StageState>) => {
      frames.length = 0;
      const answer = (await save()).listRevisions;
      assert.equal(frames.length, 1, "a save broadcast other than once");
      steps.push({ answer, sent: frames[0] });
    };
    await run(() => stageController.setSidebar(HIDE(["patch"])));
    await run(() => stageController.setBarItems({ items: ["clock"] }));
    await run(() => stageController.setSidebar(HIDE(["patch", "history"])));
    await run(() => stageController.setBarItems({ mobileItems: ["recording", "spacer"] }));
    // Saved again unchanged: still a save, still counted, so its echo is still its own.
    await run(() => stageController.setSidebar(HIDE(["patch", "history"])));

    for (const { answer, sent } of steps) assert.deepEqual(sent, answer, "the broadcast carried another count than the answer");
    assert.deepEqual(
      steps.map((s) => [s.answer.sidebar - start.sidebar, s.answer.bar - start.bar]),
      [
        [1, 0],
        [1, 1],
        [2, 1],
        [2, 2],
        [3, 2],
      ],
    );
    assert.ok(steps.every((s) => s.answer.boot === start.boot && start.boot.length > 0), "the boot mark changed, or is empty, within one run");
  });
});
