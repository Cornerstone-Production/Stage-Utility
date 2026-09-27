// baptism-fuzz.test.ts — random press sequences through the REAL timer, held to
// the store, the replay and the lane at once.
//
// The scenario-by-scenario roundtrip suites (rebuild-baptism-roundtrip.test.ts,
// baptism-lane-roundtrip.test.ts) each hand-pick a sequence to prove one shape.
// This drives arbitrary sequences of every action instead — start, baptized,
// startBaptisms, next, advance, undo, finish, pause, resume, in both modes,
// several sessions per service — and checks, after every trial:
//
//  - the timer's own invariants never break (armed only in grouped baptism with
//    no clock, baptismIndex in range, personNumber = people.length + 1 while
//    running);
//  - rebuildBaptismSessions(), replaying the real archived rows, reproduces
//    exactly what the store holds (people, id, finishedAt);
//  - baptismLaneSpans(), derived from the same rows, sums back to each person's
//    testimonyMs/baptizeMs within a generous tolerance, never overlaps, and
//    leaves nothing running after a finish.
//
// What it catches is disagreement: a press that the timer, the raw rows and the
// lane record differently. It does not judge whether all three agree on the
// right answer (a person closed unbaptized everywhere passes), and it never
// nears the session cap or drops a row, so those have their own tests. A
// deliberately small, deterministic slice of seed and step space, not a stress
// test; seeds and step counts are fixed so a failure reproduces exactly.

import assert from "node:assert/strict";
import { it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-baptism-fuzz-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { baptismTimerService: timer } = await import("../baptism-timer-service.js");
const { baptismStore } = await import("../baptism-store.js");
const { sampleArchive } = await import("./sample-archive.js");
const { rebuildBaptismSessions, readBaptismRows } = await import("./rebuild-baptism.js");
const { baptismLaneSpans } = await import("./baptism-lane.js");
const { freshCtx, openService, sleep } = await import("./baptism-roundtrip-harness.js");

const ACTIONS = ["start", "baptized", "startBaptisms", "next", "advance", "undo", "finish", "pause", "resume", "undo", "advance", "next"] as const;
const TRIALS = 10;
const STEPS = 12;
const SEEDS = [1, 2, 3];

/** A tiny deterministic PRNG so a failure names a seed that reproduces it. */
function rngFor(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function invariants(s: any, why: string): void {
  if (s.armed) {
    assert.equal(s.mode, "grouped", `${why}: armed only in grouped`);
    assert.equal(s.phase, "baptism", `${why}: armed only in baptism`);
    assert.equal(s.segmentStartedAt, null, `${why}: armed has no running clock`);
  }
  if (s.mode === "grouped" && s.phase === "baptism") {
    assert.ok(s.baptismIndex >= 0 && s.baptismIndex < s.people.length, `${why}: baptismIndex ${s.baptismIndex} in range of ${s.people.length}`);
  }
  if (s.mode === "grouped" && s.phase === "testimony") {
    assert.equal(s.personNumber, s.people.length + 1, `${why}: grouped testimony personNumber = people+1`);
  }
  if (s.mode === "per-person" && s.phase !== "idle") {
    assert.equal(s.personNumber, s.people.length + 1, `${why}: per-person personNumber = people+1`);
  }
}

const spanMs = (s: { startedAt: string; endedAt: string | null }) => Date.parse(s.endedAt ?? "") - Date.parse(s.startedAt);
const tol = (x: number, pieces: number) => Math.max(6 * pieces, 0.25 * x);

it("timer, replay and lane agree over random press sequences", async () => {
  const failures: string[] = [];

  for (const seed of SEEDS) {
    const rand = rngFor(seed);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;

    for (let t = 0; t < TRIALS; t++) {
      const ctx = freshCtx(`fz${seed}-`);
      openService(ctx);
      timer.reset();
      timer.setMode(rand() < 0.5 ? "grouped" : "per-person");
      const log: string[] = [`seed=${seed} mode=${timer.getState().mode}`];
      timer.start();
      log.push("start");
      await sleep(20 + Math.floor(rand() * 15));

      for (let k = 0; k < STEPS; k++) {
        const action = pick(ACTIONS);
        const before = timer.getState();
        try {
          (timer as any)[action]();
        } catch (e) {
          failures.push(`seed ${seed} trial ${t} threw on ${action}: ${e} :: ${log.join(" ")}`);
          break;
        }
        if (timer.getState() !== before) log.push(action);
        try {
          invariants(timer.getState(), `seed ${seed} trial ${t} after ${log.join(" ")}`);
        } catch (e) {
          failures.push(String(e));
          break;
        }
        await sleep(20 + Math.floor(rand() * 15));
      }
      if (timer.getState().phase !== "idle") {
        timer.finish();
        log.push("finish(end)");
      }
      await timer.flush();
      await sampleArchive.flush();

      const stored = (await baptismStore.listSessions()).filter((s) => s.serviceKey === ctx.serviceKey).reverse();
      const rows = await readBaptismRows(ctx.serviceKey, ctx.serviceDate);
      const replayed = rebuildBaptismSessions(rows ?? [], { serviceKey: ctx.serviceKey, title: null, serviceTypeId: null, planId: null });
      const seq = log.join(" ");

      if (replayed.length !== stored.length) {
        failures.push(`seed ${seed} trial ${t}: replay ${replayed.length} sessions, store ${stored.length} :: ${seq}`);
        continue;
      }
      replayed.forEach((r, i) => {
        const w = stored[i]!;
        if (JSON.stringify(r.people) !== JSON.stringify(w.people)) {
          failures.push(`seed ${seed} trial ${t}: replay people ${JSON.stringify(r.people)} != store ${JSON.stringify(w.people)} :: ${seq}`);
        }
        if (r.id !== w.id || r.finishedAt !== w.finishedAt) {
          failures.push(`seed ${seed} trial ${t}: id/finishedAt mismatch :: ${seq}`);
        }
      });

      const spans = baptismLaneSpans(rows ?? [], ctx.serviceKey);
      spans.forEach((s, i) => {
        if (s.endedAt === null) failures.push(`seed ${seed} trial ${t}: span ${i} still running after finish :: ${seq}`);
        if (i > 0 && Date.parse(s.startedAt) < Date.parse(spans[i - 1]!.endedAt ?? "")) {
          failures.push(`seed ${seed} trial ${t}: overlapping spans ${i} :: ${seq}`);
        }
      });

      let unowned = [...spans];
      for (const session of stored) {
        const from = Date.parse(session.startedAt);
        const to = Date.parse(session.finishedAt);
        const mine = spans.filter((s) => Date.parse(s.startedAt) >= from && Date.parse(s.endedAt ?? "") <= to);
        unowned = unowned.filter((s) => !mine.includes(s));
        for (const s of mine) {
          if (s.person < 1 || s.person > session.people.length) {
            failures.push(`seed ${seed} trial ${t}: span names person ${s.person} of ${session.people.length} :: ${seq}`);
          }
        }
        session.people.forEach((p, i) => {
          for (const [kind, rec] of [["testimony", p.testimonyMs], ["baptism", p.baptizeMs]] as const) {
            const pieces = mine.filter((s) => s.kind === kind && s.person === i + 1);
            const sum = pieces.reduce((a, s) => a + spanMs(s), 0);
            if (rec === 0 && pieces.length > 0 && sum > 6) {
              failures.push(`seed ${seed} trial ${t}: person ${i + 1} recorded no ${kind} but lane draws ${sum}ms :: ${seq}`);
            } else if (rec > 0 && Math.abs(sum - rec) > tol(rec, Math.max(1, pieces.length))) {
              failures.push(`seed ${seed} trial ${t}: person ${i + 1} ${kind} lane ${sum}ms vs store ${rec}ms (${pieces.length} pieces) :: ${seq}`);
            }
          }
        });
      }
      if (unowned.length) {
        failures.push(`seed ${seed} trial ${t}: ${unowned.length} span(s) outside any stored session: ${unowned.map((s) => s.kind + s.person).join(",")} :: ${seq}`);
      }
    }
  }

  if (failures.length) console.log(failures.slice(0, 20).join("\n"));
  assert.equal(failures.length, 0, `${failures.length} inconsistency(ies) — see the log above for the reproducing seed/sequence`);
});
