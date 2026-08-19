import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

process.env.STAGE_UTILITY_DATA = await fs.mkdtemp(path.join(os.tmpdir(), "su-announce-"));

const { addBroadcastListener, setSubscriberCheck } = await import("../broadcaster.js");
const { updateNoticesStore } = await import("../update-notices-store.js");
const { announceIfNew, NOTICE_CHANNEL } = await import("./announce.js");
import type { UpdateStatus } from "../../types/state.js";

const sent: unknown[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === NOTICE_CHANNEL) sent.push(payload);
});

const listening = (yes: boolean) => setSubscriberCheck((c) => (c === NOTICE_CHANNEL ? yes : true));
const avail = (tag: string): UpdateStatus =>
  ({ tagBased: true, releasesBehind: 1, targetTag: tag }) as UpdateStatus;

beforeEach(async () => {
  sent.length = 0;
  await updateNoticesStore.save({ announcedTag: null, justUpdated: null });
});

describe("announcing an available update", () => {
  test("an update found with NOBODY connected is not announced", async () => {
    // The failure this design exists for: marking at detection spends the
    // announcement on an empty room, and a release found at 3am is never
    // mentioned again.
    listening(false);
    assert.equal(await announceIfNew(avail("v1.12.0")), false);
    assert.equal((await updateNoticesStore.load()).announcedTag, null, "it was marked with nobody there");
    assert.equal(sent.length, 0);
  });

  test("and is announced once somebody IS connected", async () => {
    listening(false);
    await announceIfNew(avail("v1.12.0"));
    listening(true);
    assert.equal(await announceIfNew(avail("v1.12.0")), true);
    assert.equal(sent.length, 1);
    assert.equal((await updateNoticesStore.load()).announcedTag, "v1.12.0");
  });

  test("the same tag is never announced twice", async () => {
    listening(true);
    await announceIfNew(avail("v1.12.0"));
    await announceIfNew(avail("v1.12.0"));
    await announceIfNew(avail("v1.12.0"));
    assert.equal(sent.length, 1, "the operator was hounded");
  });

  test("a NEWER release announces again", async () => {
    // "Once per available update", not "once ever".
    listening(true);
    await announceIfNew(avail("v1.12.0"));
    await announceIfNew(avail("v1.13.0"));
    assert.equal(sent.length, 2);
    assert.equal((await updateNoticesStore.load()).announcedTag, "v1.13.0");
  });

  test("an up-to-date box announces nothing", async () => {
    listening(true);
    assert.equal(
      await announceIfNew({ tagBased: true, releasesBehind: 0, targetTag: "v1.12.0" } as UpdateStatus),
      false,
    );
    assert.equal(sent.length, 0);
  });

  test("a status with no tag at all announces nothing", async () => {
    // Otherwise a box that cannot name its target would announce on every check.
    listening(true);
    assert.equal(
      await announceIfNew({ tagBased: false, behindUserFacing: 2 } as UpdateStatus),
      false,
    );
  });

  test("the payload names the version and how far behind", async () => {
    listening(true);
    await announceIfNew({ tagBased: true, releasesBehind: 3, targetTag: "v1.14.0" } as UpdateStatus);
    assert.deepEqual(sent[0], { tag: "v1.14.0", count: 3 });
  });
});
