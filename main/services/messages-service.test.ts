// The messages service: what a send accepts and refuses, how an alert is timed
// and ended, and what the thread does at midnight, past 200 and across a restart.
//
// Time is the whole difficulty, so the clock is the mock Date and setTimeout of
// node:test, set to instants that matter in Chicago. "What day is it" is the
// app time zone's answer and never the host's: the 19:00 case below is the
// service that stopped recording mid-evening on a UTC box, and the same shape
// would clear the thread under the band.
//
// Persistence is real. Every case runs against a real data directory, and the
// file is read back rather than trusted. Group ids are issued by the messaging
// store, so they are read back too.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messages-service-"));
process.env.STAGE_UTILITY_DATA = DATA;
process.env.HOME = path.join(DATA, "home");

// Captured BEFORE any case enables mock timers: the waits below are real.
const realSetTimeout = globalThis.setTimeout;

const { MessagesService, MessageRefused, checkSend } = await import("./messages-service.js");
const { messagesStore } = await import("./messages-store.js");
const { messagingStore } = await import("./messaging-store.js");
const { stageController } = await import("./stage-controller.js");
const { addBroadcastListener } = await import("./broadcaster.js");
const { setAppTimeZone } = await import("./app-timezone.js");
const { ALERT_MS, EVERYONE, MESSAGES_CAP, MESSAGES_CHANNEL } = await import("../types/messages.js");
type MessagesState = import("../types/messages.js").MessagesState;
type StageMessage = import("../types/messages.js").StageMessage;
type MessagesServiceT = InstanceType<typeof MessagesService>;

// ── Harness ──────────────────────────────────────────────────────────────

const frames: MessagesState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === MESSAGES_CHANNEL) frames.push(structuredClone(payload as MessagesState));
});

const lines: string[] = [];
const real = { log: console.log, warn: console.warn, error: console.error };
function captureConsole(): void {
  const grab = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
}
function restoreConsole(): void {
  Object.assign(console, real);
}
const logged = (prefix: string) => lines.filter((l) => l.startsWith(prefix));

/** Real time, for fs to finish. The mock clock does not move. */
const pause = (ms = 2) => new Promise<void>((r) => realSetTimeout(r, ms));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await pause();
  }
  assert.fail(`never happened: ${what}`);
}

/** 2026-10-07 10:00 in Chicago (CDT, UTC-5). */
const TEN_AM = Date.UTC(2026, 9, 7, 15, 0, 0);
const MIN = 60_000;

const FILE = path.join(DATA, "messages.json");
const onDisk = () => JSON.parse(fs.readFileSync(FILE, "utf8")) as { lastClearedDate: string | null; messages: StageMessage[] };

let green = "";
let stage = "";
let booth = "";
const services: MessagesServiceT[] = [];

/** A service over whatever messages.json holds, started or not. */
async function boot(file: { lastClearedDate: string | null; messages: StageMessage[] }, opts: { start?: boolean } = {}): Promise<MessagesServiceT> {
  await messagesStore.save(file);
  await messagesStore.reload();
  const svc = new MessagesService();
  services.push(svc);
  if (opts.start !== false) assert.equal(await svc.start(), null, "start() reported a failure");
  return svc;
}

function stored(over: Partial<StageMessage> & { id: string }): StageMessage {
  return {
    at: TEN_AM - 1000,
    to: [EVERYONE],
    text: "earlier",
    alert: false,
    alertUntil: null,
    clearedAt: null,
    from: "Operator",
    replies: [],
    ...over,
  };
}
const hex = (n: number) => n.toString(16).padStart(16, "0");

beforeEach(async () => {
  setAppTimeZone("America/Chicago");
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: TEN_AM });
  const { config } = await messagingStore.replace({
    groups: [{ name: "Green room" }, { name: "Stage" }, { name: "Booth" }],
    quickMessages: [],
    quickReplies: [],
  });
  [green, stage, booth] = config.groups.map((g) => g.id);
  frames.length = 0;
  lines.length = 0;
  captureConsole();
});

afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  restoreConsole();
  mock.timers.reset();
  setAppTimeZone(null);
});

// ── Sending ──────────────────────────────────────────────────────────────

describe("send", () => {
  test("stamps the message from the server: id, time, trimmed text, the default sender", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const m = await svc.send({ to: [stage], text: "  Walk now  " });
    assert.match(m.id, /^[0-9a-f]{16}$/);
    assert.equal(m.at, TEN_AM);
    assert.equal(m.text, "Walk now");
    assert.equal(m.from, "Operator");
    assert.deepEqual(m.to, [stage]);
    assert.deepEqual([m.alert, m.alertUntil, m.clearedAt, m.replies], [false, null, null, []]);
  });

  test("sends to Everyone, and to several groups in the config's order, each once", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    assert.deepEqual((await svc.send({ to: [EVERYONE, EVERYONE], text: "hi" })).to, [EVERYONE]);
    assert.deepEqual((await svc.send({ to: [booth, green, booth], text: "hi" })).to, [green, booth]);
  });

  test("an alert runs for 30 seconds from the SERVER clock, whatever the body says", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const body = { to: [EVERYONE], text: "now", alert: true, at: 1, alertUntil: 999_999_999_999, clearedAt: 5, id: "mine" };
    const m = await svc.send(body);
    assert.equal(m.alertUntil, TEN_AM + ALERT_MS);
    assert.equal(m.at, TEN_AM);
    assert.equal(m.clearedAt, null);
    assert.notEqual(m.id, "mine");
    assert.equal(svc.state().alert?.id, m.id);
  });

  const refusals: [string, () => Parameters<MessagesServiceT["send"]>[0], RegExp][] = [
    ["no recipients", () => ({ to: [], text: "x" }), /at least one group/],
    ["to that is not a list", () => ({ to: "everyone", text: "x" }), /at least one group/],
    ["a recipient that is not text", () => ({ to: [5], text: "x" }), /list of group ids/],
    ["Everyone beside a group", () => ({ to: [EVERYONE, stage], text: "x" }), /cannot be combined/],
    ["an id that is not a group id", () => ({ to: ["__proto__"], text: "x" }), /not a group id/],
    ["a group that does not exist", () => ({ to: ["g-00000000"], text: "x" }), /no group has the id g-00000000/],
    ["text that is not text", () => ({ to: [EVERYONE], text: 5 }), /text must be text/],
    ["empty text", () => ({ to: [EVERYONE], text: "   " }), /cannot be empty/],
    ["text past 280 characters", () => ({ to: [EVERYONE], text: "x".repeat(281) }), /at most 280/],
    ["an alert flag that is not a boolean", () => ({ to: [EVERYONE], text: "x", alert: "yes" }), /true or false/],
    ["an empty sender", () => ({ to: [EVERYONE], text: "x", from: " " }), /from cannot be empty/],
    ["a sender past 60 characters", () => ({ to: [EVERYONE], text: "x", from: "f".repeat(61) }), /at most 60/],
    ["a sender that is not text", () => ({ to: [EVERYONE], text: "x", from: 4 }), /from must be text/],
  ];
  for (const [what, make, reason] of refusals) {
    test(`refuses ${what}, says why on /log, and records and sends nothing`, async () => {
      const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
      frames.length = 0;
      await assert.rejects(() => svc.send(make()), (err: Error) => err instanceof MessageRefused && reason.test(err.message));
      assert.deepEqual(svc.state().messages, []);
      assert.equal(frames.length, 0, "a refused send reached the screens");
      assert.equal(onDisk().messages.length, 0, "a refused send reached the file");
      const refused = logged("[messages] refused:");
      assert.equal(refused.length, 1, `expected one refusal line, got ${JSON.stringify(lines)}`);
      assert.match(refused[0], reason);
    });
  }

  test("the limits are inclusive: 280 characters of text, 60 of sender", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const m = await svc.send({ to: [EVERYONE], text: "x".repeat(280), from: "f".repeat(60) });
    assert.equal(m.text.length, 280);
    assert.equal(m.from.length, 60);
  });

  test("checkSend reads group ids through a Map, so a prototype key is just an unknown id", () => {
    assert.throws(() => checkSend({ to: ["constructor"], text: "x" }, []), MessageRefused);
    assert.throws(() => checkSend({ to: ["g-12345678"], text: "x" }, [{ id: "g-87654321", name: "A" }]), /no group has the id/);
  });
});

describe("what a send tells the screens and /log", () => {
  test("one frame per send, rev rising, carrying the groups and the message", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    frames.length = 0;
    const a = await svc.send({ to: [stage], text: "a" });
    const b = await svc.send({ to: [stage], text: "b" });
    assert.equal(frames.length, 2);
    assert.ok(frames[1].rev > frames[0].rev, "rev did not rise");
    assert.deepEqual(frames[1].messages.map((m) => m.id), [a.id, b.id]);
    assert.deepEqual(frames[1].groups.map((g) => g.name), ["Green room", "Stage", "Booth"]);
    assert.equal(svc.state().rev, frames[1].rev, "GET and the last frame disagree about rev");
  });

  test("logs who it went to, whether it was an alert, who sent it, and the text cut to 120", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    await svc.send({ to: [stage, green], text: "Walk now", alert: true, from: "FOH" });
    assert.deepEqual(logged("[messages] sent"), ['[messages] sent to Green room, Stage (alert) by FOH: "Walk now"']);
    await svc.send({ to: [EVERYONE], text: "y".repeat(250) });
    const long = logged("[messages] sent").at(-1) ?? "";
    assert.equal(long, `[messages] sent to Everyone by Operator: "${"y".repeat(120)}…"`);
  });

  test("a newline in the text or sender cannot forge a log line", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    await svc.send({ to: [EVERYONE], text: "ok\n[messages] nightly clear removed 99 message(s)", from: "A\nB" });
    assert.equal(lines.length, 1, `the log took more than one record: ${JSON.stringify(lines)}`);
    assert.ok(lines[0].includes("ok\\n[messages]"));
    assert.ok(lines[0].includes("by A\\nB"));
  });

  test("a group is named in the log by its name, not its id", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    await svc.send({ to: [booth], text: "x" });
    assert.match(lines[0], /sent to Booth by/);
  });

  test("concurrent sends all land, in order, and each is on disk", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const sent = await Promise.all(Array.from({ length: 6 }, (_, i) => svc.send({ to: [EVERYONE], text: `m${i}` })));
    assert.deepEqual(svc.state().messages.map((m) => m.text), ["m0", "m1", "m2", "m3", "m4", "m5"]);
    assert.deepEqual(onDisk().messages.map((m) => m.id), sent.map((m) => m.id));
  });

  test("a save that fails fails the send, leaves the thread as it was, and says so on /log", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    await svc.send({ to: [EVERYONE], text: "kept" });
    frames.length = 0;
    const realSave = messagesStore.save.bind(messagesStore);
    messagesStore.save = (async () => {
      throw new Error("ENOSPC: no space left on device");
    }) as typeof messagesStore.save;
    try {
      await assert.rejects(() => svc.send({ to: [EVERYONE], text: "lost" }), /ENOSPC/);
    } finally {
      messagesStore.save = realSave;
    }
    assert.deepEqual(svc.state().messages.map((m) => m.text), ["kept"], "an unsaved message is on the screens");
    assert.equal(frames.length, 0, "an unsaved message was broadcast");
    assert.equal(logged("[messages] could not save, NOT recorded:").length, 1);
  });
});

// ── Alerts ───────────────────────────────────────────────────────────────

describe("clear-alert", () => {
  test("ends a running alert, keeps the message, and says who did it", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const m = await svc.send({ to: [EVERYONE], text: "now", alert: true });
    frames.length = 0;
    mock.timers.tick(5_000);
    assert.equal(await svc.clearAlert(m.id, "Booth"), "cleared");
    assert.equal(svc.state().alert, null);
    const kept = svc.state().messages.find((x) => x.id === m.id);
    assert.equal(kept?.clearedAt, TEN_AM + 5_000, "the message must stay, with the time it was cleared");
    assert.equal(frames.length, 1);
    assert.equal(frames[0].alert, null);
    assert.deepEqual(logged("[messages] alert"), [`[messages] alert ${m.id} cleared by Booth`]);
    assert.equal(onDisk().messages[0].clearedAt, TEN_AM + 5_000);
  });

  test("is a no-op for an alert that is already over, and for a message that was never one", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const alert = await svc.send({ to: [EVERYONE], text: "a", alert: true });
    const plain = await svc.send({ to: [EVERYONE], text: "p" });
    assert.equal(await svc.clearAlert(alert.id), "cleared");
    frames.length = 0;
    lines.length = 0;
    assert.equal(await svc.clearAlert(alert.id), "not-running");
    assert.equal(await svc.clearAlert(plain.id), "not-running");
    assert.equal(frames.length, 0, "a no-op was broadcast");
    assert.equal(lines.length, 0, "a no-op was logged");
  });

  test("an alert that ran out is over too", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const m = await svc.send({ to: [EVERYONE], text: "a", alert: true });
    mock.timers.setTime(TEN_AM + ALERT_MS);
    assert.equal(await svc.clearAlert(m.id), "not-running");
  });

  test("an id nobody issued is not found, and a malformed one never reaches the lookup", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    assert.equal(await svc.clearAlert("0000000000000000"), "not-found");
    assert.equal(await svc.clearAlert("__proto__"), "not-found");
    assert.equal(await svc.clearAlert("constructor"), "not-found");
  });

  test("a sender it cannot name is refused", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const m = await svc.send({ to: [EVERYONE], text: "a", alert: true });
    await assert.rejects(() => svc.clearAlert(m.id, ""), MessageRefused);
    assert.notEqual(svc.state().alert, null, "a refused clear ended the alert");
  });
});

describe("the alert expiring", () => {
  test("is broadcast once, at alertUntil, so a screen with no timer of its own sees alert go to null", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const m = await svc.send({ to: [EVERYONE], text: "now", alert: true });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].alert?.id, m.id);

    mock.timers.tick(ALERT_MS - 1);
    assert.equal(frames.length, 1, "announced the end of an alert that had a millisecond left");
    mock.timers.tick(1);
    assert.equal(frames.length, 2, "the alert ran out and nobody was told");
    assert.equal(frames[1].alert, null);
    assert.ok(frames[1].rev > frames[0].rev);

    mock.timers.tick(5 * MIN);
    assert.equal(frames.length, 2, "the end of the alert was announced more than once");
  });

  test("a message that is not an alert arms nothing", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    await svc.send({ to: [EVERYONE], text: "plain" });
    mock.timers.tick(5 * MIN);
    assert.equal(frames.length, 1);
  });

  test("a cleared alert is not announced a second time when its 30 seconds are up", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const m = await svc.send({ to: [EVERYONE], text: "now", alert: true });
    await svc.clearAlert(m.id);
    assert.equal(frames.length, 2);
    mock.timers.tick(ALERT_MS * 2);
    assert.equal(frames.length, 2, "the timer outlived the alert it was armed for");
  });

  test("a newer alert takes over the state, and the timer follows it", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const first = await svc.send({ to: [green], text: "first", alert: true });
    mock.timers.tick(10_000);
    const second = await svc.send({ to: [stage], text: "second", alert: true });
    assert.equal(svc.state().alert?.id, second.id, "alert is the newest running one");
    assert.equal(first.alertUntil, TEN_AM + ALERT_MS, "the older alert keeps its own end");
    frames.length = 0;
    // The first runs out at +30 s, while the second is the one the state names.
    mock.timers.tick(20_000);
    assert.equal(frames.length, 0, "the older alert ending changed nothing the state shows");
    mock.timers.tick(10_000);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].alert, null);
  });

  test("a restart mid-alert re-arms the timer for the time left", async () => {
    const first = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const m = await first.send({ to: [EVERYONE], text: "now", alert: true });
    first.stop();
    mock.timers.tick(10_000);
    await messagesStore.reload();
    const again = new MessagesService();
    services.push(again);
    await again.start();
    assert.equal(again.state().alert?.id, m.id);
    frames.length = 0;
    mock.timers.tick(ALERT_MS - 10_000);
    assert.equal(frames.length, 1, "the restarted server never announced the end of the alert");
    assert.equal(frames[0].alert, null);
  });

  test("a stopped service arms nothing", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    await svc.send({ to: [EVERYONE], text: "now", alert: true });
    svc.stop();
    frames.length = 0;
    mock.timers.tick(5 * MIN);
    assert.equal(frames.length, 0);
  });
});

// ── The nightly clear ────────────────────────────────────────────────────

describe("the nightly clear", () => {
  const two = () => [stored({ id: hex(1) }), stored({ id: hex(2) })];

  test("clears when the date has changed in the app time zone, and logs how many", async () => {
    // 00:30 on 8 Oct in Chicago.
    mock.timers.setTime(Date.UTC(2026, 9, 8, 5, 30));
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: two() }, { start: false });
    frames.length = 0;
    assert.equal(await svc.start(), null);
    assert.deepEqual(svc.state().messages, []);
    assert.deepEqual(logged("[messages] nightly"), ["[messages] nightly clear removed 2 message(s)"]);
    assert.equal(frames.length, 1, "the screens kept the old day's thread");
    assert.deepEqual(onDisk(), { lastClearedDate: "2026-10-08", messages: [] });
  });

  test("a UTC host at 19:00 in Chicago does NOT clear: the UTC date has rolled, the app's has not", async () => {
    // 19:30 on 7 Oct in Chicago is 00:30 on 8 Oct in UTC. A check against the
    // host's own date sees a new day here and sweeps the thread under a service.
    mock.timers.setTime(Date.UTC(2026, 9, 8, 0, 30));
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: two() });
    mock.timers.tick(5 * MIN);
    await pause(20);
    assert.equal(svc.state().messages.length, 2, "the thread was cleared at 19:30 local time");
    assert.deepEqual(logged("[messages] nightly"), []);
    assert.equal(onDisk().lastClearedDate, "2026-10-07");
  });

  test("a server that was off at midnight clears the stale day when it boots", async () => {
    mock.timers.setTime(Date.UTC(2026, 9, 10, 15, 0));
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: two() });
    assert.deepEqual(svc.state().messages, []);
    assert.equal(logged("[messages] nightly").length, 1);
    assert.equal(onDisk().lastClearedDate, "2026-10-10");
  });

  test("a store with no date yet only records today's, and keeps what is there", async () => {
    const svc = await boot({ lastClearedDate: null, messages: two() });
    assert.equal(svc.state().messages.length, 2);
    assert.deepEqual(logged("[messages] nightly"), []);
    assert.equal(onDisk().lastClearedDate, "2026-10-07");
  });

  test("the once-a-minute check clears at midnight with the server up", async () => {
    // 23:59:30 on 7 Oct in Chicago.
    mock.timers.setTime(Date.UTC(2026, 9, 8, 4, 59, 30));
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: two() });
    assert.equal(svc.state().messages.length, 2);
    mock.timers.tick(MIN);
    await until(() => svc.state().messages.length === 0, "the minute check clearing the thread");
    assert.deepEqual(onDisk(), { lastClearedDate: "2026-10-08", messages: [] });
    assert.equal(logged("[messages] nightly").length, 1);
  });

  test("keeps checking: the next midnight clears too", async () => {
    mock.timers.setTime(Date.UTC(2026, 9, 8, 4, 59, 30));
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    mock.timers.tick(MIN);
    await until(() => onDisk().lastClearedDate === "2026-10-08", "the first midnight");
    await svc.send({ to: [EVERYONE], text: "day two" });
    mock.timers.setTime(Date.UTC(2026, 9, 9, 4, 59, 30));
    mock.timers.tick(MIN);
    await until(() => svc.state().messages.length === 0, "the second midnight");
  });

  test("a message sent after midnight but before the minute check is the new day's, and survives it", async () => {
    mock.timers.setTime(Date.UTC(2026, 9, 8, 4, 59, 30));
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: two() });
    mock.timers.setTime(Date.UTC(2026, 9, 8, 5, 0, 20));
    const fresh = await svc.send({ to: [EVERYONE], text: "00:00:20" });
    assert.deepEqual(svc.state().messages.map((m) => m.id), [fresh.id], "yesterday's thread outlived midnight");
    mock.timers.tick(MIN);
    await pause(20);
    assert.deepEqual(svc.state().messages.map((m) => m.id), [fresh.id], "the minute check swept the new day's message");
  });

  test("a date that moved BACK (the time zone was changed) keeps today's messages, and says so", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-09", messages: two() });
    assert.equal(svc.state().messages.length, 2);
    assert.equal(onDisk().lastClearedDate, "2026-10-07");
    assert.equal(logged("[messages] the date moved back").length, 1);
  });

  test("a clear that finds nothing says so but sends the screens nothing", async () => {
    mock.timers.setTime(Date.UTC(2026, 9, 8, 15, 0));
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] }, { start: false });
    frames.length = 0;
    await svc.start();
    assert.deepEqual(logged("[messages] nightly"), ["[messages] nightly clear removed 0 message(s)"]);
    assert.equal(frames.length, 0);
  });

  test("a failed save on boot is returned, not thrown, so the server still comes up", async () => {
    mock.timers.setTime(Date.UTC(2026, 9, 8, 15, 0));
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: two() }, { start: false });
    const realSave = messagesStore.save.bind(messagesStore);
    messagesStore.save = (async () => {
      throw new Error("EROFS: read-only file system");
    }) as typeof messagesStore.save;
    try {
      const failure = await svc.start();
      assert.match(failure?.message ?? "", /EROFS/);
    } finally {
      messagesStore.save = realSave;
    }
    assert.equal(svc.state().messages.length, 2, "an unsaved clear was applied");
  });
});

// ── The cap ──────────────────────────────────────────────────────────────

describe("the cap", () => {
  test("keeps the newest 200, and says so ONCE per day, not once per message", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const sent: StageMessage[] = [];
    for (let i = 0; i < MESSAGES_CAP + 5; i++) sent.push(await svc.send({ to: [EVERYONE], text: `m${i}` }));
    const kept = svc.state().messages;
    assert.equal(kept.length, MESSAGES_CAP);
    assert.equal(kept[0].id, sent[5].id, "the oldest five should be gone, and only they");
    assert.equal(kept.at(-1)?.id, sent.at(-1)?.id);
    assert.equal(onDisk().messages.length, MESSAGES_CAP);
    assert.deepEqual(logged("[messages] over"), ["[messages] over 200 today; dropping the oldest"]);

    // The next day it is said again.
    mock.timers.setTime(Date.UTC(2026, 9, 8, 15, 0));
    for (let i = 0; i < MESSAGES_CAP + 3; i++) await svc.send({ to: [EVERYONE], text: `d${i}` });
    assert.equal(logged("[messages] over").length, 2, "the cap should be mentioned once a day");
  });
});

// ── Persistence ──────────────────────────────────────────────────────────

describe("persistence", () => {
  test("the day's thread survives a restart, replies and cleared alerts included", async () => {
    const first = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const a = await first.send({ to: [stage], text: "one", alert: true, from: "FOH" });
    const b = await first.send({ to: [EVERYONE], text: "two" });
    await first.clearAlert(a.id);
    first.stop();

    await messagesStore.reload(); // from disk, not from the store's memory
    const second = new MessagesService();
    services.push(second);
    await second.start();
    assert.deepEqual(
      second.state().messages.map((m) => [m.id, m.text, m.from, m.alert, m.clearedAt]),
      [[a.id, "one", "FOH", true, TEN_AM], [b.id, "two", "Operator", false, null]],
    );
    assert.equal(second.state().alert, null);
  });

  test("an entry the file holds that cannot be read is left out and named, not served to every screen", async () => {
    const good = stored({ id: hex(7), text: "fine" });
    await messagesStore.save({
      lastClearedDate: "2026-10-07",
      messages: [good, { id: "nope" }, "junk", stored({ id: hex(8), to: ["g-xyz"] })] as unknown as StageMessage[],
    });
    await messagesStore.reload();
    const svc = new MessagesService();
    services.push(svc);
    await svc.start();
    assert.deepEqual(svc.state().messages.map((m) => m.id), [good.id]);
    assert.equal(logged("[messages] messages.json: left out 3").length, 1);
  });

  test("the groups ride in the state, from the messaging config", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    assert.deepEqual(svc.state().groups.map((g) => g.id), [green, stage, booth]);
  });
});

// ── Changing the groups ──────────────────────────────────────────────────

describe("updateConfig", () => {
  type Ctl = { state: { outputs: Output[]; views: View[]; [k: string]: unknown }; broadcast: () => void };
  const ctl = stageController as unknown as Ctl;

  beforeEach(async () => {
    ctl.broadcast = () => {};
    ctl.state = {
      ...ctl.state,
      views: [{ id: "v1", name: "Mic board", kind: "slots", createdAt: "" }] as View[],
      outputs: [
        { id: "wall", name: "Stage wall", viewId: "v1", groups: [green, stage] },
        { id: "lobby", name: "Lobby", viewId: "v1", groups: [stage] },
        { id: "foh", name: "FOH", viewId: "v1", groups: [booth] },
      ] as Output[],
    };
    (stageController as unknown as { recomputeResolved: () => void }).recomputeResolved();
  });

  const keep = (...ids: string[]) => ({
    groups: ids.map((id, i) => ({ id, name: ["Green room", "Stage", "Booth"][[green, stage, booth].indexOf(id)] ?? `G${i}` })),
    quickMessages: [],
    quickReplies: [],
  });

  test("deleting a group takes it off every screen, logs how many, and re-sends the state", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    const sentToIt = await svc.send({ to: [stage], text: "before" });
    frames.length = 0;
    lines.length = 0;
    await svc.updateConfig(keep(green, booth));
    assert.deepEqual(
      stageController.getState().outputs.map((o) => [o.id, o.groups]),
      [["wall", [green]], ["lobby", []], ["foh", [booth]]],
    );
    assert.deepEqual(logged("[messages] group"), ['[messages] group "Stage" deleted; removed from 2 screen(s)']);
    assert.equal(frames.length, 1, "the screens still draw the deleted group");
    assert.deepEqual(frames[0].groups.map((g) => g.id), [green, booth]);
    assert.deepEqual(
      svc.state().messages.map((m) => [m.id, m.to]),
      [[sentToIt.id, [stage]]],
      "messages already sent to a deleted group are left alone",
    );
  });

  test("a deleted group is logged with how many screens held it, including none", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    await svc.updateConfig(keep(green, stage));
    assert.deepEqual(logged("[messages] group"), ['[messages] group "Booth" deleted; removed from 1 screen(s)']);
    ctl.state = { ...ctl.state, outputs: ctl.state.outputs.map((o) => ({ ...o, groups: [] })) };
    await svc.updateConfig(keep(green));
    assert.equal(logged("[messages] group").at(-1), '[messages] group "Stage" deleted; removed from 0 screen(s)');
  });

  test("editing only the quick lists, or renaming a group, removes nothing from any screen", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    frames.length = 0;
    await svc.updateConfig({
      groups: [{ id: green, name: "Greenroom" }, { id: stage, name: "Stage" }, { id: booth, name: "Booth" }],
      quickMessages: ["Go"],
      quickReplies: ["Ok"],
    });
    assert.deepEqual(stageController.getState().outputs.map((o) => o.groups), [[green, stage], [stage], [booth]]);
    assert.deepEqual(logged("[messages] group"), []);
    assert.equal(frames.length, 1, "a rename must reach the screens: the state carries the names");
    frames.length = 0;
    await svc.updateConfig({
      groups: [{ id: green, name: "Greenroom" }, { id: stage, name: "Stage" }, { id: booth, name: "Booth" }],
      quickMessages: ["Go", "Stop"],
      quickReplies: ["Ok"],
    });
    assert.equal(frames.length, 0, "a change the state does not carry was broadcast");
  });

  test("a refused config changes nothing", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    frames.length = 0;
    await assert.rejects(() => svc.updateConfig({ groups: [{ id: green, name: "" }], quickMessages: [], quickReplies: [] }), /cannot be empty/);
    assert.deepEqual(stageController.getState().outputs.map((o) => o.groups), [[green, stage], [stage], [booth]]);
    assert.equal(frames.length, 0);
  });

  test("when taking the group off the screens fails, the screens are still told it is gone", async () => {
    const svc = await boot({ lastClearedDate: "2026-10-07", messages: [] });
    frames.length = 0;
    const real = stageController.stripOutputGroups.bind(stageController);
    stageController.stripOutputGroups = async () => {
      throw new Error("EROFS");
    };
    try {
      await assert.rejects(() => svc.updateConfig(keep(green, booth)), /EROFS/);
    } finally {
      stageController.stripOutputGroups = real;
    }
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].groups.map((g) => g.id), [green, booth]);
  });
});
