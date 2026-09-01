// Every list that IS an integration's setup ANNOUNCES when it changes.
//
// Four integrations answer "has the operator set this up?" from a list of their
// own rather than from `state.config`: wireless connections, OSC targets,
// RossTalk targets and followed teams. Three of them broadcast when their list
// changes, and integration-manager re-derives the summary and re-sends the
// states frame from that broadcast.
//
// Scores was the odd one out. Its poller was restarted by an explicit
// `refreshScores()` call from the one route that writes the list — so a SECOND
// writer of setFavourites that forgot the call would leave the poller stopped
// while the panel reported teams being followed, and nothing would say so. It
// now announces the change like the other three.
//
// Driven through the real store into a temp directory, with a real broadcast
// listener attached: the fact under test is that saving a list puts a message on
// the channel, and a test that called `broadcast` itself would prove nothing.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-scores-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { addBroadcastListener } = await import("./broadcaster.js");
const { scoresStore } = await import("./scores-store.js");

after(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const seen: { channel: string; payload: unknown }[] = [];
addBroadcastListener((channel, payload) => seen.push({ channel, payload }));

describe("the followed-teams list", () => {
  it("announces a change on its own channel, not only to the route that wrote it", async () => {
    await scoresStore.init();
    seen.length = 0;

    const favourites = [
      {
        league: "mlb" as const,
        teamId: "101",
        displayName: "Example Ballclub",
        abbreviation: "EXA",
        logo: null,
        color: "#123456",
      },
    ];
    await scoresStore.setFavourites(favourites);

    const announcements = seen.filter((m) => m.channel === "scores:favourites-changed");
    assert.equal(
      announcements.length,
      1,
      `saving the followed-teams list put ${announcements.length} messages on "scores:favourites-changed"`,
    );
    assert.deepEqual(
      (announcements[0].payload as { favourites: unknown }).favourites,
      favourites,
      "the announcement did not carry the list that was saved",
    );
  });

  it("announces an EMPTY list too, which is the case that stops the poller", async () => {
    seen.length = 0;
    await scoresStore.setFavourites([]);
    const announcements = seen.filter((m) => m.channel === "scores:favourites-changed");
    assert.equal(announcements.length, 1, "removing the last team said nothing");
    assert.deepEqual((announcements[0].payload as { favourites: unknown[] }).favourites, []);
  });
});
