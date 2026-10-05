// The person directory reads a by-person slot's person from Planning Center when
// the roster does not have them. Resolution asks on every broadcast, so these pin
// that asking is cheap: one read per ID, a back-off after a failure, and a 404
// remembered rather than asked again.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PersonDirectory, RETRY_MS } from "./person-directory.js";
import type { PersonCardDTO } from "../types/stage.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A reader whose answers the test controls, plus a clock and a landing count. */
function rig(opts: { creds?: boolean } = {}) {
  const calls: { id: string; resolve: (c: PersonCardDTO | null) => void; reject: (e: Error) => void }[] = [];
  let now = 1_000_000;
  let landed = 0;
  const dir = new PersonDirectory(
    () =>
      opts.creds === false
        ? null
        : (id) =>
            new Promise<PersonCardDTO | null>((resolve, reject) => {
              calls.push({ id, resolve, reject });
            }),
    () => {
      landed++;
    },
    () => now,
  );
  return {
    dir,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    landed: () => landed,
  };
}

const quiet = async (fn: () => Promise<void>) => {
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return lines;
};

describe("the person directory", () => {
  it("reads an unknown ID once, however often it is asked", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.dir.want(["113920177"]);
    assert.equal(r.calls.length, 1, "more than one read for one ID");
  });

  it("keeps a person once read, and tells the controller to re-resolve", async () => {
    const r = rig();
    r.dir.want(["113920177"]);
    r.calls[0]?.resolve({ name: "Ethan Matthews", photoUrl: null });
    await tick();
    assert.equal(r.dir.people.get("113920177")?.name, "Ethan Matthews");
    assert.equal(r.landed(), 1, "a landed person never re-resolved the slots");
    r.dir.want(["113920177"]);
    assert.equal(r.calls.length, 1, "a known person was read again");
  });

  it("does not retry a failure inside the back-off, and does after it", async () => {
    const r = rig();
    const lines = await quiet(async () => {
      r.dir.want(["1"]);
      r.calls[0]?.reject(new Error("PCO API error 500"));
      await tick();
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /\[pco\] could not read Planning Center person 1/);
    r.advance(RETRY_MS - 1);
    r.dir.want(["1"]);
    assert.equal(r.calls.length, 1, "retried inside the back-off");
    r.advance(1);
    r.dir.want(["1"]);
    assert.equal(r.calls.length, 2, "never retried after the back-off");
  });

  it("remembers a person PCO does not have and does not ask again", async () => {
    const r = rig();
    const lines = await quiet(async () => {
      r.dir.want(["999"]);
      r.calls[0]?.resolve(null);
      await tick();
      r.advance(RETRY_MS * 10);
      r.dir.want(["999"]);
    });
    assert.equal(r.calls.length, 1, "a missing person was asked for again");
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /no Planning Center person 999/);
    assert.equal(r.landed(), 0);
  });

  it("reads nothing without Planning Center credentials", () => {
    const r = rig({ creds: false });
    r.dir.want(["113920177"]);
    assert.equal(r.calls.length, 0);
  });

  it("discards a read that lands after a reset", async () => {
    const r = rig();
    r.dir.want(["113920177"]);
    r.dir.reset();
    r.calls[0]?.resolve({ name: "Old Account", photoUrl: null });
    await tick();
    assert.equal(r.dir.people.size, 0, "a read from before the reset was kept");
    assert.equal(r.landed(), 0);
    r.dir.want(["113920177"]);
    assert.equal(r.calls.length, 2, "the reset ID was not read again");
  });
});
