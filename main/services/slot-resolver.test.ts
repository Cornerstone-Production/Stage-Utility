// resolveSlots is pure, so everything here is data in / data out — no devices.
//
// The load-bearing rule is claiming: slots with an IDENTICAL positions set compete
// for distinct people; slots that differ resolve independently. Get that backwards
// and either a guitarist appears in three slots at once, or the acoustic player
// vanishes from the slot holding their pack.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { readFileSync } from "node:fs";

import { resolveSlots, fitAvatarToColumn, normaliseAudioLevel, MIN_FACE_ASPECT } from "./slot-resolver.js";
import type { Slot, SlotLink, TeamMemberDTO } from "../types/stage.js";
import type { DeviceStatus } from "../types/devices.js";

const NO_DEVICES = new Map<string, DeviceStatus>();

function member(personId: string, name: string, teamPositionName: string, notes: string | null = null): TeamMemberDTO {
  return { personId, name, teamPositionName, notes, photoUrl: null } as unknown as TeamMemberDTO;
}

function slot(id: string, link: SlotLink, order = 0): Slot {
  return {
    id, order, link,
    displayName: null, photoUrl: null,
    deviceBinding: null, iemBinding: null,
    deviceLabel: null, iemLabel: null,
    chargeSource: "mic", chargeBayId: null, hideRf: false,
  } as unknown as Slot;
}

const pos = (...positions: Array<{ name?: string; notesStartsWith?: string }>): SlotLink =>
  ({ kind: "pco", matchBy: "position", positions });

const names = (out: Slot[]) => out.map((s) => s.displayName);

describe("matching one slot", () => {
  const team = [
    member("p1", "Sarah", "Vocals", "1"),
    member("p2", "Dana", "Vocals", "10"),
    member("p3", "Ali", "Acoustic"),
  ];

  test("a single position with a note behaves exactly as before", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "1" }))], team, NO_DEVICES)), ["Sarah"]);
  });

  test('an exact note wins so "1" does not grab "10"', () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "1" }))], team, NO_DEVICES)), ["Sarah"]);
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "10" }))], team, NO_DEVICES)), ["Dana"]);
  });

  test("a position with no note takes the first person in it", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Acoustic" }))], team, NO_DEVICES)), ["Ali"]);
  });

  test("a noted position never falls back to an arbitrary person", () => {
    // The HH-slot-shows-the-HS-pastor bug. A note that matches nobody = empty.
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "9" }))], team, NO_DEVICES)), [null]);
  });

  test("sub-variant positions group under their base", () => {
    const bgv = [member("p9", "Chris", "Vocals (BGVs)", "3")];
    assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "3" }))], bgv, NO_DEVICES)), ["Chris"]);
  });

  describe("a named sub-variant means THAT variant", () => {
    // Stripping the parenthetical made "Audio (MON)" and "Audio (FOH)" the same
    // query, so a lone MON slot took whichever engineer PCO listed first. Adding
    // the FOH slot only appeared to fix it: the two then competed for distinct
    // people and happened to land the right way round.
    const audio = [
      member("pF", "Foh Person", "Audio (FOH)"),
      member("pM", "Mon Person", "Audio (MON)"),
    ];

    test("a lone MON slot picks the MON engineer, not the first audio person", () => {
      assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Audio (MON)" }))], audio, NO_DEVICES)), ["Mon Person"]);
    });

    test("a lone FOH slot picks the FOH engineer", () => {
      assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Audio (FOH)" }))], audio, NO_DEVICES)), ["Foh Person"]);
    });

    test("both slots stay correct regardless of their order", () => {
      const monFirst = [slot("a", pos({ name: "Audio (MON)" }), 0), slot("b", pos({ name: "Audio (FOH)" }), 1)];
      const fohFirst = [slot("a", pos({ name: "Audio (FOH)" }), 0), slot("b", pos({ name: "Audio (MON)" }), 1)];
      assert.deepEqual(names(resolveSlots(monFirst, audio, NO_DEVICES)), ["Mon Person", "Foh Person"]);
      assert.deepEqual(names(resolveSlots(fohFirst, audio, NO_DEVICES)), ["Foh Person", "Mon Person"]);
    });

    test("a variant slot stays empty when nobody holds that variant", () => {
      // Better empty than confidently wrong: silently showing the FOH tech on the
      // MON slot is the failure this whole rule exists to stop.
      const fohOnly = [member("pF", "Foh Person", "Audio (FOH)")];
      assert.deepEqual(names(resolveSlots([slot("s", pos({ name: "Audio (MON)" }))], fohOnly, NO_DEVICES)), [null]);
    });

    test("the base name still covers every variant", () => {
      // The behaviour the stripping existed for, unchanged.
      assert.deepEqual(
        names(resolveSlots([slot("s", pos({ name: "Audio" }))], [member("pM", "Mon Person", "Audio (MON)")], NO_DEVICES)),
        ["Mon Person"],
      );
    });
  });

  test("entries are tried in order — first hit wins", () => {
    const link = pos({ name: "Vocals", notesStartsWith: "4" }, { name: "Acoustic" });
    // No vocalist noted 4, so it falls through to Acoustic.
    assert.deepEqual(names(resolveSlots([slot("s", link)], team, NO_DEVICES)), ["Ali"]);
  });

  test("a nameless entry matches on the note across every position", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos({ notesStartsWith: "10" }))], team, NO_DEVICES)), ["Dana"]);
  });

  test("an entry with neither name nor note matches nobody", () => {
    // Guard against a misconfigured slot silently claiming the first person on the team.
    assert.deepEqual(names(resolveSlots([slot("s", pos({}))], team, NO_DEVICES)), [null]);
  });

  test("an empty range is an unconfigured slot", () => {
    assert.deepEqual(names(resolveSlots([slot("s", pos())], team, NO_DEVICES)), [null]);
  });
});

describe("claiming between slots", () => {
  test("identical sets compete — two guitarists fill two of three slots", () => {
    const team = [member("g1", "Ali", "Acoustic"), member("g2", "Bo", "Electric")];
    const link = pos({ name: "Acoustic" }, { name: "Electric" });
    const out = resolveSlots([slot("a", link, 0), slot("b", link, 1), slot("c", link, 2)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Bo", null]);
  });

  test("different sets do NOT compete — the pack slot still shows the player", () => {
    // The operator's case: slot 4 accepts Vocals-4 or Acoustic; a separate slot
    // holds that player's acoustic pack. Both must show them.
    const team = [member("g1", "Ali", "Acoustic")];
    const slot4 = pos({ name: "Vocals", notesStartsWith: "4" }, { name: "Acoustic" });
    const packSlot = pos({ name: "Acoustic" });
    const out = resolveSlots([slot("s4", slot4, 0), slot("pack", packSlot, 1)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Ali"]);
  });

  test("competing slots claim in board order", () => {
    const team = [member("g1", "Ali", "Acoustic"), member("g2", "Bo", "Acoustic")];
    const link = pos({ name: "Acoustic" });
    const out = resolveSlots([slot("a", link, 0), slot("b", link, 1)], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Ali", "Bo"]);
  });

  test("entry order does not change whether two slots compete", () => {
    // Identical means the same SET, so [Acoustic, Electric] == [Electric, Acoustic].
    const team = [member("g1", "Ali", "Acoustic")];
    const a = pos({ name: "Acoustic" }, { name: "Electric" });
    const b = pos({ name: "Electric" }, { name: "Acoustic" });
    assert.deepEqual(names(resolveSlots([slot("a", a, 0), slot("b", b, 1)], team, NO_DEVICES)), ["Ali", null]);
  });

  test("notes are part of the identity — same position, different notes never compete", () => {
    const team = [member("p1", "Sarah", "Vocals", "1"), member("p2", "Dana", "Vocals", "2")];
    const out = resolveSlots(
      [slot("a", pos({ name: "Vocals", notesStartsWith: "1" }), 0), slot("b", pos({ name: "Vocals", notesStartsWith: "2" }), 1)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), ["Sarah", "Dana"]);
  });

  test("a person-linked slot is unaffected by claiming", () => {
    const team = [member("p1", "Sarah", "Vocals", "1")];
    const out = resolveSlots(
      [slot("a", { kind: "pco", matchBy: "person", personId: "p1" }, 0), slot("b", pos({ name: "Vocals" }), 1)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), ["Sarah", "Sarah"]);
  });

  test("spacer and empty slots resolve to nothing and claim nobody", () => {
    const team = [member("p1", "Sarah", "Vocals")];
    const out = resolveSlots(
      [slot("sp", { kind: "spacer" }, 0), slot("e", { kind: "empty" }, 1), slot("v", pos({ name: "Vocals" }), 2)],
      team, NO_DEVICES,
    );
    assert.deepEqual(names(out), [null, null, "Sarah"]);
  });
});

describe("which positions the cell names", () => {
  const shown = (out: Slot[]) => out.map((s) => s.shownPositions);

  // A guitarist scheduled only on EG Ghost was told he was also on EG Shadow,
  // because the cell printed the whole range the slot would accept.
  test("a range names only what the person is actually scheduled for", () => {
    const team = [member("p1", "Corey", "EG Ghost")];
    const out = resolveSlots([slot("s", pos({ name: "EG Ghost" }, { name: "EG Shadow" }))], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Corey"]);
    assert.deepEqual(shown(out), [["EG Ghost"]]);
  });

  test("someone genuinely scheduled twice still lists both", () => {
    // Two team memberships, one person — the acoustic player who also sings.
    const team = [member("p1", "Jacob", "Vocals", "4"), member("p1", "Jacob", "AG")];
    const out = resolveSlots([slot("s", pos({ name: "Vocals", notesStartsWith: "4" }, { name: "AG" }))], team, NO_DEVICES);
    assert.deepEqual(names(out), ["Jacob"]);
    assert.deepEqual(shown(out), [["Vocals", "AG"]]);
  });

  test("a sub-variant counts as its base position", () => {
    // "Vocals (BGVs)" normalises to "Vocals", the same way matching does.
    const team = [member("p1", "Sam", "Vocals (BGVs)")];
    const out = resolveSlots([slot("s", pos({ name: "Vocals" }, { name: "AG" }))], team, NO_DEVICES);
    assert.deepEqual(shown(out), [["Vocals"]]);
  });

  test("an unfilled slot names nothing", () => {
    const out = resolveSlots([slot("s", pos({ name: "EG Ghost" }))], [], NO_DEVICES);
    assert.equal(out[0]!.displayName, null);
    assert.equal(out[0]!.shownPositions, undefined);
  });

  test("someone matched by note alone is named by what PCO says they play", () => {
    // The slot accepts anyone whose note starts with "7". Printing a configured
    // position here would claim a job this person is not on.
    const team = [member("p1", "Pat", "Keys", "7")];
    const out = resolveSlots([slot("s", pos({ notesStartsWith: "7" }))], team, NO_DEVICES);
    assert.equal(out[0]!.displayName, "Pat");
    assert.deepEqual(out[0]!.shownPositions, ["Keys"]);
  });
});

// ── Avatar geometry ────────────────────────────────────────────────────────
// Slots are tall and drawn with object-fit: cover, so a square source is scaled to
// fill the height and cropped hard horizontally. Matching the request to the column
// keeps only the pixels that get drawn.

test("a narrow column asks for a narrow crop, at full height", () => {
  const out = fitAvatarToColumn("https://x/avatar.png?g=1000x1000%23", 13);
  assert.match(out!, /[?&]g=\d+x1000%23$/, out!);
  const w = Number(/g=(\d+)x/.exec(out!)![1]);
  assert.ok(w < 250, `13 columns should be narrow, got ${w}`);
});

test("fewer columns means a wider crop", () => {
  const wide = Number(/g=(\d+)x/.exec(fitAvatarToColumn("https://x/a.png", 4)!)![1]);
  const narrow = Number(/g=(\d+)x/.exec(fitAvatarToColumn("https://x/a.png", 13)!)![1]);
  assert.ok(wide > narrow, `${wide} should exceed ${narrow}`);
});

test("a single-slot view never asks for more than the source has", () => {
  for (const columns of [1, 2]) {
    const w = Number(/g=(\d+)x/.exec(fitAvatarToColumn("https://x/a.png", columns)!)![1]);
    assert.equal(w, 1000, `${columns} column(s) should cap at the source ceiling`);
  }
});

test("vertical resolution never drops below what was requested before", () => {
  // The whole point is to cut wasted width, not to make anything softer.
  for (const columns of [1, 2, 4, 8, 13, 30]) {
    const h = Number(/g=\d+x(\d+)/.exec(fitAvatarToColumn("https://x/a.png", columns)!)![1]);
    assert.equal(h, 1000, `columns=${columns}`);
  }
});

test("an existing geometry is rewritten, not appended to", () => {
  const out = fitAvatarToColumn("https://x/a.png?g=1000x1000%23&z=1", 8);
  assert.equal((out!.match(/g=/g) ?? []).length, 1, out!);
  assert.match(out!, /z=1/, "other params survive");
});

test("a url with no geometry gets one, with the right separator", () => {
  assert.match(fitAvatarToColumn("https://x/a.png", 8)!, /\?g=\d+x1000%23$/);
  assert.match(fitAvatarToColumn("https://x/a.png?v=2", 8)!, /&g=\d+x1000%23$/);
});

test("no photo stays no photo", () => {
  assert.equal(fitAvatarToColumn(null, 8), null);
});

test("an absurd column count still yields a usable width", () => {
  const w = Number(/g=(\d+)x/.exec(fitAvatarToColumn("https://x/a.png", 500)!)![1]);
  assert.ok(w >= 120, `floor keeps it legible, got ${w}`);
});

// ── Audio level normalisation ──────────────────────────────────────────────
// Receivers disagree on the unit; the resolver is where it becomes one thing.

test("an already-normalised level passes through (Shure)", () => {
  assert.equal(normaliseAudioLevel(0), 0);
  assert.equal(normaliseAudioLevel(0.73), 0.73);
  assert.equal(normaliseAudioLevel(1), 1);
});

test("a dBFS level is normalised against a -60..0 range (Sennheiser raw)", () => {
  assert.equal(normaliseAudioLevel(-60), 0);
  assert.equal(normaliseAudioLevel(-30), 0.5);
  assert.ok(Math.abs(normaliseAudioLevel(-6)! - 0.9) < 1e-9);
});

test("a level below the floor clamps rather than going negative", () => {
  assert.equal(normaliseAudioLevel(-120), 0);
});

test("a percentage is scaled down", () => {
  assert.equal(normaliseAudioLevel(50), 0.5);
  assert.equal(normaliseAudioLevel(100), 1);
});

test("absent or nonsensical values become null, not NaN", () => {
  assert.equal(normaliseAudioLevel(null), null);
  assert.equal(normaliseAudioLevel(undefined), null);
  assert.equal(normaliseAudioLevel(NaN), null);
  assert.equal(normaliseAudioLevel(Infinity), null);
  assert.equal(normaliseAudioLevel(5000), null);
});

test("every output is renderable as a percentage", () => {
  for (const v of [0, 0.5, 1, -60, -30, -120, 50, 100]) {
    const out = normaliseAudioLevel(v);
    assert.ok(out !== null && out >= 0 && out <= 1, `${v} -> ${out}`);
  }
});

describe("avatar crop matches the shape the slot is drawn at", () => {
  const geom = (url: string | null) => (url?.match(/g=(\d+x\d+)/) ?? [])[1] ?? null;
  const pcoSlot = (id: string, over: Partial<Slot> = {}): Slot =>
    ({ id, channel: id, order: Number(id), link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] }, ...over }) as unknown as Slot;

  test("asks for a shorter crop for a stacked slot than a full-height one", () => {
    // The bug: every slot got a full-height crop, so a half-height stacked slot
    // was handed twice the image it could draw. object-fit: cover then threw the
    // bottom half away and object-position: top left only foreheads visible.
    const full = fitAvatarToColumn("http://x/a.jpg", 4, 1);
    const stacked = fitAvatarToColumn("http://x/a.jpg", 4, 2);
    const [, fullH] = geom(full)!.split("x").map(Number);
    const [, stackedH] = geom(stacked)!.split("x").map(Number);
    assert.ok(stackedH < fullH, `stacked (${stackedH}) must be shorter than full (${fullH})`);
    // Less than HALF, not exactly half: the info card is sized by width, so it
    // costs the same pixels in a half-height slot and eats into the photo's share.
    assert.ok(stackedH < fullH / 2, `expected under half of ${fullH}, got ${stackedH}`);
    assert.ok(stackedH > fullH / 3, `but not a sliver: got ${stackedH}`);
  });

  test("keeps the width, which is set by the column and does not change when stacked", () => {
    const a = geom(fitAvatarToColumn("http://x/a.jpg", 6, 1))!.split("x")[0];
    const b = geom(fitAvatarToColumn("http://x/a.jpg", 6, 2))!.split("x")[0];
    assert.equal(a, b, "a stacked slot is the same width, only shorter");
  });

  test("crops a stacked slot no harder than a full-height one", () => {
    // The point of the whole fix. Boxes measured on a real display.
    const visible = (geometry: string, w: number, h: number) => {
      const [iw, ih] = geometry.split("x").map(Number);
      const scale = Math.max(w / iw, h / ih);
      return (w * h) / (iw * scale * ih * scale);
    };
    const full = visible(geom(fitAvatarToColumn("http://x/a.jpg", 13, 1))!, 194, 915);
    const stacked = visible(geom(fitAvatarToColumn("http://x/a.jpg", 13, 2))!, 194, 396);
    assert.ok(
      Math.abs(full - stacked) < 0.1,
      `stacked (${(stacked * 100).toFixed(1)}%) should waste about as little as full (${(full * 100).toFixed(1)}%)`,
    );
  });

  test("floors the height so a deep stack cannot ask for a sliver", () => {
    const [, h] = geom(fitAvatarToColumn("http://x/a.jpg", 4, 12))!.split("x").map(Number);
    assert.ok(h >= 240, `expected a sensible floor, got ${h}`);
  });

  test("gives stacked slots in a resolved board the shorter crop", () => {
    // End to end: the second slot stacks onto the first, so BOTH are half-height.
    const resolved = resolveSlots(
      [pcoSlot("1"), pcoSlot("2", { stackWithPrevious: true }), pcoSlot("3")],
      [
        { id: "m1", name: "A", personId: "p1", photoUrl: "http://x/a.jpg", teamPositionName: "Vocals", teamName: "B", status: "C", notes: null },
        { id: "m2", name: "B", personId: "p2", photoUrl: "http://x/b.jpg", teamPositionName: "Vocals", teamName: "B", status: "C", notes: null },
        { id: "m3", name: "C", personId: "p3", photoUrl: "http://x/c.jpg", teamPositionName: "Vocals", teamName: "B", status: "C", notes: null },
      ],
      new Map(),
    );
    const heights = resolved.map((s) => Number(geom(s.photoUrl ?? null)?.split("x")[1] ?? 0));
    assert.ok(heights[0] < heights[2], "a stacked slot gets a shorter crop than a lone one");
    assert.equal(heights[0], heights[1], "both halves of a stack match");
  });
});

// ── The face the crop throws away ──────────────────────────────────────────
// An inline slots-grid on a custom layout draws a far squarer cell than a
// display column of the same slot count: measured 71x143 in a browser, an
// aspect of 0.50, against the 0.16 the column model assumes for 14 slots.
//
// PCO's crop is centred and irreversible. Asking it for 0.16 and then drawing
// 0.50 does not show more of the face, it shows a stretched sliver of the
// middle of it. Measured end to end against a 600x800 headshot whose face spans
// columns 170..430: PCO returned 126x800, keeping columns 237..363 — 51% of the
// face's width, gone before the browser saw the file.
//
// The floor is expressed against the requested HEIGHT rather than as a pixel
// count, because a stacked slot asks for a shorter crop and a fixed width would
// mean a different shape at every depth.

describe("the crop an inline slots-grid asks for", () => {
  const geometry = (url: string | null) => {
    const m = /[?&]g=(\d+)x(\d+)/.exec(url!);
    return { w: Number(m![1]), h: Number(m![2]), aspect: Number(m![1]) / Number(m![2]) };
  };

  test("keeps the whole of a face, where the column alone would not", () => {
    const g = geometry(fitAvatarToColumn("http://x/a.jpg", 14, 1, MIN_FACE_ASPECT));
    // A face spans the middle ~43% of a 3:4 frame; below (0.43 x 3)/4 the crop
    // starts eating it. The column model alone asks for 0.158 here.
    assert.ok(g.aspect >= 0.32, `aspect ${g.aspect.toFixed(3)} cuts into the face`);
  });

  test("is the SHAPE that is floored, not the pixel width", () => {
    // Same rule, two stack depths. A pixel floor would give the shorter crop a
    // different shape and re-introduce the bug for stacked slots only.
    for (const depth of [1, 2, 3]) {
      const g = geometry(fitAvatarToColumn("http://x/a.jpg", 30, depth, MIN_FACE_ASPECT));
      assert.ok(g.aspect >= 0.32, `depth ${depth}: aspect ${g.aspect.toFixed(3)}`);
    }
  });

  test("costs a display nothing, because a display does not ask for it", () => {
    // The column model is right for a display column, and a floor there would
    // only ship pixels the browser crops off again.
    //
    // EXACT geometries, not a comparison against another call of this function:
    // written that way, moving the DEFAULT moves both sides together and the
    // regression this test is named for sails straight through. It did, once.
    const expected: Record<number, string> = {
      4: "550x1000",
      9: "245x1000",
      13: "170x1000",
      14: "158x1000",
    };
    for (const [columns, want] of Object.entries(expected)) {
      const got = /[?&]g=(\d+x\d+)/.exec(fitAvatarToColumn("http://x/a.jpg", Number(columns))!)![1];
      assert.equal(got, want, `columns=${columns}`);
    }
  });

  test("never asks for more than the source has", () => {
    const g = geometry(fitAvatarToColumn("http://x/a.jpg", 1, 1, MIN_FACE_ASPECT));
    assert.ok(g.w <= 1000, `got ${g.w}`);
  });

  test("a wide-enough column is left alone — the floor only ever raises", () => {
    for (const columns of [1, 2, 3, 4, 5, 6]) {
      const floored = geometry(fitAvatarToColumn("http://x/a.jpg", columns, 1, MIN_FACE_ASPECT));
      const plain = geometry(fitAvatarToColumn("http://x/a.jpg", columns));
      assert.equal(floored.w, plain.w, `columns=${columns} should be untouched`);
    }
  });
});

describe("the inline-grid path is actually wired to it", () => {
  // Without this, deleting the argument at the call site leaves every test above
  // green while every inline grid goes back to cutting faces.
  test("stage-controller resolves inline slots with the face floor", () => {
    const src = readFileSync(new URL("./stage-controller.ts", import.meta.url), "utf8");
    const call = /slotsByLayoutObject\[oid\]\s*=\s*resolveSlots\(([^;]*)\)/.exec(src);
    assert.ok(call, "could not find the inline slots resolution in stage-controller.ts");
    assert.match(call[1], /MIN_FACE_ASPECT/, "inline grids are resolved without the face floor");
  });

  test("and the display path is still left without one", () => {
    const src = readFileSync(new URL("./stage-controller.ts", import.meta.url), "utf8");
    const call = /slotsByView\[view\.id\]\s*=\s*resolveSlots\(([^;]*)\)/.exec(src);
    assert.ok(call, "could not find the view slots resolution in stage-controller.ts");
    assert.doesNotMatch(call[1], /MIN_FACE_ASPECT/, "a display should not pay for the floor");
  });
});
