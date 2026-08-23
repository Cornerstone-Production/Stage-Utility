// What each display plays, and why.
//
// Resolution is per OUTPUT, not per group, because an output can belong to
// several groups whose schedules disagree. The schedule LIST ORDER settles that
// and nothing else does — which is the property most of these tests exist to
// pin, because it is the one an operator has to be able to predict from looking
// at the screen.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { SignageHorizon, SignageHorizonEntry } from "../types/signage.js";
import { HORIZON_QUANTUM_MS, resolveSignage } from "./signage-resolve.js";

const TZ = "America/Chicago";
const NOW = Date.parse("2026-08-23T15:00:00Z"); // Sunday 10:00 CDT

const media = [
  { id: "m1", file: "aaaaaaaaaaaaaaaa.png", name: "a", mime: "image/png", bytes: 1, w: 1920, h: 1080, createdAt: "" },
  { id: "m2", file: "bbbbbbbbbbbbbbbb.png", name: "b", mime: "image/png", bytes: 1, w: 1920, h: 1080, createdAt: "" },
];

const pl = (id: string, mediaId = "m1") => ({
  id,
  name: id,
  items: [{ mediaId }],
  defaultDurationMs: 8000,
  fit: "contain" as const,
  transition: { kind: "cut" as const, ms: 0 },
  createdAt: "",
});

const SUNDAY_AM = { kind: "weekly" as const, days: [0], start: "05:00", end: "13:00" };
const ALL_DAY = { kind: "always" as const };
const MONDAY = { kind: "weekly" as const, days: [1], start: "05:00", end: "13:00" };

const sched = (id: string, playlistId: string, groupIds: string[], window: unknown) => ({
  id,
  name: id,
  enabled: true,
  groupIds,
  playlistId,
  window,
  createdAt: "",
});

const group = (id: string, outputIds: string[], defaultPlaylistId?: string) => ({
  id,
  name: id,
  outputIds,
  ...(defaultPlaylistId ? { defaultPlaylistId } : {}),
  createdAt: "",
});

const base = {
  now: NOW,
  tz: TZ,
  outputs: [{ id: "out-1", name: "Foyer", viewId: "v-sign" }],
  playlists: [pl("weekend"), pl("office", "m2"), pl("house")],
  media,
  pcoWindows: [],
  liveServiceTypeId: null,
  overrides: [],
  groups: [],
  schedules: [],
};

function run(over: Record<string, unknown>): Record<string, SignageHorizon> {
  return resolveSignage({ ...base, ...over } as never);
}

/** The entry covering NOW for an output. */
function now(r: Record<string, SignageHorizon>, out = "out-1"): SignageHorizonEntry {
  const e = (r[out] ?? []).find((x) => NOW >= x.from && NOW < x.until);
  assert.ok(e, `no horizon entry covers now for ${out}`);
  return e;
}

describe("what a display resolves to", () => {
  test("the schedule higher in the list wins", () => {
    // Both match. Nothing about the groups decides it — the order does.
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], SUNDAY_AM), sched("s2", "office", ["g1"], ALL_DAY)],
    });
    assert.equal(now(r).playlist?.id, "weekend");
    assert.equal(now(r).reason, "schedule");
  });

  test("reversing the list reverses the answer", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s2", "office", ["g1"], ALL_DAY), sched("s1", "weekend", ["g1"], SUNDAY_AM)],
    });
    assert.equal(now(r).playlist?.id, "office");
  });

  test("an output in two groups is still decided by schedule order", () => {
    const r = run({
      groups: [group("g1", ["out-1"]), group("g2", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g2"], SUNDAY_AM), sched("s2", "office", ["g1"], ALL_DAY)],
    });
    assert.equal(now(r).playlist?.id, "weekend");
  });

  test("a schedule targeting a group this output is not in does not apply", () => {
    const r = run({
      groups: [group("g1", ["out-1"]), group("g2", ["other"])],
      schedules: [sched("s1", "weekend", ["g2"], ALL_DAY)],
    });
    assert.equal(now(r).reason, "blank");
  });

  test("a disabled schedule does not match", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [{ ...sched("s1", "weekend", ["g1"], ALL_DAY), enabled: false }],
    });
    assert.equal(now(r).reason, "blank");
  });

  test("the group default takes over only when no schedule matches", () => {
    const r = run({
      groups: [group("g1", ["out-1"], "house")],
      schedules: [sched("s1", "weekend", ["g1"], MONDAY)],
    });
    assert.equal(now(r).playlist?.id, "house");
    assert.equal(now(r).reason, "default");
  });

  test("the FIRST group with a default wins when an output is in two", () => {
    const r = run({
      groups: [group("g1", ["out-1"]), group("g2", ["out-1"], "office"), group("g3", ["out-1"], "house")],
      schedules: [],
    });
    assert.equal(now(r).playlist?.id, "office");
  });

  test("with nothing at all it is blank", () => {
    const r = run({ groups: [group("g1", ["out-1"])], schedules: [] });
    assert.equal(now(r).reason, "blank");
    assert.equal(now(r).playlist, undefined);
  });

  test("an output in no group at all is blank rather than missing", () => {
    // It still needs a horizon: the display asks for one by id, and an absent
    // entry is indistinguishable from a server that has not answered.
    const r = run({ groups: [], schedules: [] });
    assert.ok(r["out-1"], "an ungrouped output got no horizon at all");
    assert.equal(now(r).reason, "blank");
  });
});

describe("overrides", () => {
  test("beat every schedule", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], SUNDAY_AM)],
      overrides: [{ groupId: "g1", playlistId: "house", startedAt: NOW - 1000 }],
    });
    assert.equal(now(r).playlist?.id, "house");
    assert.equal(now(r).reason, "override");
  });

  test("the most RECENT one wins when two groups both have one", () => {
    // "The last thing you pressed", which is the only rule an operator under
    // pressure can predict.
    const r = run({
      groups: [group("g1", ["out-1"]), group("g2", ["out-1"])],
      schedules: [],
      overrides: [
        { groupId: "g1", playlistId: "weekend", startedAt: NOW - 9000 },
        { groupId: "g2", playlistId: "office", startedAt: NOW - 1000 },
      ],
    });
    assert.equal(now(r).playlist?.id, "office");
  });

  test("a blank override really does blank it", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
      overrides: [{ groupId: "g1", blank: true, startedAt: NOW }],
    });
    assert.equal(now(r).playlist, undefined);
    assert.equal(now(r).reason, "override");
  });

  test("one on a group this output is not in is ignored", () => {
    const r = run({
      groups: [group("g1", ["out-1"]), group("g2", ["other"])],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
      overrides: [{ groupId: "g2", playlistId: "house", startedAt: NOW }],
    });
    assert.equal(now(r).playlist?.id, "weekend");
  });

  test("one naming a playlist that no longer exists falls through", () => {
    // Rather than blanking a wall because a playlist was deleted while an
    // override pointed at it.
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
      overrides: [{ groupId: "g1", playlistId: "deleted", startedAt: NOW }],
    });
    assert.equal(now(r).playlist?.id, "weekend");
  });
});

describe("a playlist that cannot play", () => {
  test("an EMPTY playlist falls through to the group default", () => {
    // Emitting it would give the display a zero-length cycle to divide by.
    const r = run({
      playlists: [{ ...pl("weekend"), items: [] }, pl("house")],
      groups: [group("g1", ["out-1"], "house")],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
    });
    assert.equal(now(r).playlist?.id, "house");
  });

  test("a playlist whose media is ALL missing also falls through", () => {
    const r = run({
      playlists: [{ ...pl("weekend"), items: [{ mediaId: "gone" }] }, pl("house")],
      groups: [group("g1", ["out-1"], "house")],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
    });
    assert.equal(now(r).playlist?.id, "house");
  });

  test("but ONE missing item just drops that item", () => {
    const r = run({
      playlists: [{ ...pl("weekend"), items: [{ mediaId: "gone" }, { mediaId: "m1" }] }],
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
    });
    assert.equal(now(r).playlist?.items.length, 1);
  });

  test("an empty playlist as the group default is blank, not a crash", () => {
    const r = run({
      playlists: [{ ...pl("house"), items: [] }],
      groups: [group("g1", ["out-1"], "house")],
      schedules: [],
    });
    assert.equal(now(r).reason, "blank");
  });
});

describe("the horizon itself", () => {
  test("is contiguous, ordered, and covers at least 24 hours", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], SUNDAY_AM)],
    });
    // No group default here, so no trailing fallback entry.
    const h = r["out-1"];
    assert.equal(h[0].from, NOW);
    for (let i = 1; i < h.length; i++) {
      assert.equal(h[i].from, h[i - 1].until, "the horizon has a gap or an overlap");
    }
    // AT LEAST 24 hours, and snapped to the quantum. The end is an artifact of
    // how far ahead we compute rather than an instant anything happens at, so it
    // is pinned to a grid: left moving with the clock it changed on every safety
    // tick, and every screen was sent the whole plan once a minute forever.
    const end = h[h.length - 1].until;
    assert.ok(end >= NOW + 24 * 3600_000, `horizon only reaches ${end - NOW}ms`);
    assert.equal(end % HORIZON_QUANTUM_MS, 0, "the end is not on the grid, so it will move again");
    assert.ok(end < NOW + 48 * 3600_000, "the horizon grew unboundedly");
  });

  test("splits at the boundary a schedule actually ends", () => {
    // Sunday 05:00-13:00, resolved at 10:00 local: one entry until 13:00, then
    // blank. A horizon that did not split here would leave a display believing
    // the morning playlist ran all day.
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], SUNDAY_AM)],
    });
    const h = r["out-1"];
    assert.equal(h[0].playlist?.id, "weekend");
    assert.equal(h[0].until, Date.parse("2026-08-23T18:00:00Z")); // 13:00 CDT
    assert.equal(h[1].reason, "blank");
  });

  test("ends with the group's DEFAULT, so a cold boot has something to play", () => {
    // A display that boots with no server plays its group's default, and the
    // persisted horizon is the only place it can find one. Without this a screen
    // whose schedule covers the whole day boots to black - which is what a real
    // reboot test showed.
    const r = run({
      groups: [group("g1", ["out-1"], "house")],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
    });
    const h = r["out-1"];
    const last = h[h.length - 1];
    assert.equal(last.reason, "default");
    assert.equal(last.playlist?.id, "house");
    // Beyond the horizon proper, so it is never selected in normal play.
    assert.ok(last.from >= NOW + 24 * 3600_000, "the fallback overlaps the real horizon");
  });

  test("has no trailing default when the group has none", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
    });
    assert.ok(!r["out-1"].some((e) => e.reason === "default"));
  });

  test("carries the winning schedule's ID, so the board marks the right row", () => {
    // Two schedules may share a name, and marking the winning row by name would
    // light both. The id is what the board matches on.
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [
        { ...sched("s1", "weekend", ["g1"], MONDAY), name: "Same name" },
        { ...sched("s2", "office", ["g1"], ALL_DAY), name: "Same name" },
      ],
    });
    assert.equal(now(r).reasonId, "s2");
  });

  test("names the group when a default or an override decided it", () => {
    const byDefault = run({ groups: [group("g1", ["out-1"], "house")], schedules: [] });
    assert.equal(byDefault["out-1"][0].reasonId, "g1");
    const byOverride = run({
      groups: [group("g1", ["out-1"])],
      schedules: [],
      overrides: [{ groupId: "g1", playlistId: "house", startedAt: NOW }],
    });
    assert.equal(now(byOverride).reasonId, "g1");
  });

  test("carries the winning schedule's NAME, so the board can say why", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [{ ...sched("s1", "weekend", ["g1"], ALL_DAY), name: "Weekend mornings" }],
    });
    assert.equal(now(r).reasonLabel, "Weekend mornings");
  });

  test("resolves every output, not just the first", () => {
    const r = run({
      outputs: [
        { id: "out-1", name: "Foyer", viewId: "v" },
        { id: "out-2", name: "Hall", viewId: "v" },
      ],
      groups: [group("g1", ["out-1"]), group("g2", ["out-2"])],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY), sched("s2", "office", ["g2"], ALL_DAY)],
    });
    assert.equal(now(r, "out-1").playlist?.id, "weekend");
    assert.equal(now(r, "out-2").playlist?.id, "office");
  });

  test("startedAt does NOT move when a recompute changes nothing", () => {
    // Otherwise every unrelated config edit restarts the loop on every wall.
    const input = {
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], SUNDAY_AM)],
    };
    assert.equal(now(run(input)).playlist?.startedAt, now(run(input)).playlist?.startedAt);
  });

  test("items carry resolved urls, so the display joins nothing", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      schedules: [sched("s1", "weekend", ["g1"], ALL_DAY)],
    });
    assert.equal(now(r).playlist?.items[0].url, "/signage-media/aaaaaaaaaaaaaaaa.png");
    assert.equal(now(r).playlist?.items[0].durationMs, 8000);
  });

  test("a record missing the list it is built on does not stop the world", () => {
    // A playlist with no `items`, a group with no `outputIds`, a schedule with
    // no `groupIds`. Found by POSTing `{"playlist":{"id":"x"}}` to the live
    // server: the route stored it, the resolver threw "playlist.items is not
    // iterable" inside the scheduler's catch, and the horizon FROZE at its last
    // good value — every wall in the building stuck on stale content, forever,
    // with one line in the log.
    //
    // The route now refuses such a record, but a store can already hold one from
    // a hand edit or an older build, so the resolver must survive it too. The
    // right behaviour is the one unplayable playlists already get: fall through.
    const r = run({
      groups: [group("g1", ["out-1"], "empty"), { id: "g2", name: "g2", createdAt: "" }],
      schedules: [
        { id: "s0", name: "s0", enabled: true, playlistId: "weekend", window: ALL_DAY, createdAt: "" },
        sched("s1", "empty", ["g1"], ALL_DAY),
        sched("s2", "house", ["g1"], ALL_DAY),
      ],
      playlists: [{ id: "empty", name: "empty", defaultDurationMs: 8000, fit: "contain", transition: { kind: "cut", ms: 0 }, createdAt: "" }, pl("house")],
    });
    assert.equal(now(r).playlist?.id, "house", "the malformed records should have been skipped");
    assert.equal(now(r).reason, "schedule");
  });

  test("a playlist that is the default for a tag plays when nothing else does", () => {
    // The new shape: the fallback lives on the PLAYLIST, named by tag, because
    // that is where the operator is standing when they decide it.
    const r = run({
      groups: [group("g1", ["out-1"])],
      playlists: [{ ...pl("house"), defaultForGroupIds: ["g1"] }],
      schedules: [],
    });
    assert.equal(now(r).playlist?.id, "house");
    assert.equal(now(r).reason, "default");
    assert.equal(now(r).reasonId, "g1", "the entry should name the tag that decided it");
  });

  test("two playlists claiming one tag: the first in the list wins", () => {
    // A weekend loop and a youth loop on the same foyer screens is a real thing
    // an operator wants, so this is allowed rather than refused. Order is the
    // whole tie-break, because order is something they can see and change.
    const r = run({
      groups: [group("g1", ["out-1"])],
      playlists: [
        { ...pl("weekend"), defaultForGroupIds: ["g1"] },
        { ...pl("office", "m2"), defaultForGroupIds: ["g1"] },
      ],
      schedules: [],
    });
    assert.equal(now(r).playlist?.id, "weekend");
  });

  test("and reordering them reverses the answer", () => {
    const r = run({
      groups: [group("g1", ["out-1"])],
      playlists: [
        { ...pl("office", "m2"), defaultForGroupIds: ["g1"] },
        { ...pl("weekend"), defaultForGroupIds: ["g1"] },
      ],
      schedules: [],
    });
    assert.equal(now(r).playlist?.id, "office");
  });

  test("an unplayable default falls through to the next claimant", () => {
    // Exactly what an unplayable schedule does. Blanking the screen because the
    // first claimant lost its media would be a wall going dark over tidying up.
    const r = run({
      groups: [group("g1", ["out-1"])],
      playlists: [
        { ...pl("weekend"), items: [{ mediaId: "deleted" }], defaultForGroupIds: ["g1"] },
        { ...pl("office", "m2"), defaultForGroupIds: ["g1"] },
      ],
      schedules: [],
    });
    assert.equal(now(r).playlist?.id, "office");
  });

  test("a default for a tag this screen does not carry does not reach it", () => {
    const r = run({
      groups: [group("g1", ["out-1"]), group("g2", ["somewhere-else"])],
      playlists: [{ ...pl("house"), defaultForGroupIds: ["g2"] }],
      schedules: [],
    });
    assert.equal(now(r).reason, "blank");
  });

  test("a group's old defaultPlaylistId still works, unmigrated on disk", () => {
    // The operator's existing setup. Dropping this silently would take every
    // screen that relies on a group default to black — including offline, where
    // the default is the ONLY thing a booting display has.
    const r = run({
      groups: [group("g1", ["out-1"], "house")],
      playlists: [pl("house")],
      schedules: [],
    });
    assert.equal(now(r).playlist?.id, "house");
    assert.equal(now(r).reason, "default");
  });

  test("removing a tag STICKS, even with the old group field still pointing here", () => {
    // The report: "tried unselecting one and saving and it kept reverting to
    // selecting all three". The save worked; the migration merged the old field
    // back in on the next read, so the edit could never take. An explicit list —
    // even an empty one — is now the answer.
    const r = run({
      groups: [group("g1", ["out-1"], "house")],
      playlists: [{ ...pl("house"), defaultForGroupIds: [] }, pl("office", "m2")],
      schedules: [],
    });
    assert.equal(now(r).reason, "blank", "the tag the operator removed came back");
  });

  test("but a playlist that has never been edited still inherits", () => {
    const r = run({
      groups: [group("g1", ["out-1"], "house")],
      playlists: [pl("house")],
      schedules: [],
    });
    assert.equal(now(r).playlist?.id, "house");
  });

  test("and the playlist's own list wins over a stale group field", () => {
    // Once someone has edited this on the new screen, a leftover field on the
    // old record must not put back a tag they took off.
    const r = run({
      groups: [group("g1", ["out-1"], "weekend"), group("g2", ["out-1"])],
      playlists: [
        { ...pl("weekend"), defaultForGroupIds: ["g1"] },
        { ...pl("office", "m2"), defaultForGroupIds: ["g2"] },
      ],
      schedules: [],
    });
    // Both are claimants; list order decides, and the migration must not have
    // reordered anything.
    assert.equal(now(r).playlist?.id, "weekend");
  });

  test("does not run away on a pathological schedule set", () => {
    // Twenty schedules whose windows all flip constantly must still produce a
    // bounded horizon rather than looping.
    const groups = [group("g1", ["out-1"])];
    const schedules = Array.from({ length: 20 }, (_, i) =>
      sched(`s${i}`, "weekend", ["g1"], {
        kind: "weekly" as const,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: `${String(i % 24).padStart(2, "0")}:00`,
        end: `${String((i + 1) % 24).padStart(2, "0")}:00`,
      }),
    );
    const h = run({ groups, schedules })["out-1"];
    assert.ok(h.length > 0 && h.length <= 200, `horizon had ${h.length} entries`);
  });
});
