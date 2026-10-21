// publisher-harness.ts — a publisher, a fixture install behind it and a real receiver in front of it.
//
// The sender is driven through the real class and a real socket; nothing of the app is in the
// way but the broadcaster, and a test can hand the publisher a broadcast. Shared by the publisher's
// test files, which say what each is about; the hooks that stop every publisher and close every
// receiver are installed by the file that calls `installPublisherHooks()`.

import { afterEach, beforeEach, type TestContext } from "node:test";

import { captureConsole } from "./capture-console.js";
import { FakeReceiver } from "./publish-receiver.js";
import { fixtureSource, type FixtureSource } from "./publish-source.js";
import { ServiceCuePublisher, type PublisherTimings } from "../servicecue-publisher.js";
import type { ServiceCuePublishSettings } from "../servicecue-publish-store.js";

/** 38 characters: the page treats anything under 32 as no token at all. */
export const TOKEN = "tok-canary-".padEnd(40, "0");

/** Quick enough to wait for, and long enough between cycles that a test drives them by hand. */
export const MANUAL: Partial<PublisherTimings> = {
  cycleMs: 60_000,
  heartbeatMs: 60_000,
  slowEveryMs: 60_000,
  dormantSlowEveryMs: 3_600_000,
  dormantRefreshMs: 3_600_000,
  staggerMs: 0,
  failRetryMs: 60_000,
  frameMs: 30,
  backoffMinMs: 20,
  backoffMaxMs: 80,
  firstCycleMs: 60_000,
  nudgeMs: 60_000,
  reconcileMs: 3_600_000,
};

export interface Harness {
  page: FakeReceiver;
  source: FixtureSource;
  pub: ServiceCuePublisher;
  settings: ServiceCuePublishSettings;
  token: { value: string };
  /** Hand the publisher a broadcast, as the app's broadcaster would. */
  emit: (channel: string, payload?: unknown) => void;
}

let live: Harness[] = [];

export async function harness(timings: Partial<PublisherTimings> = {}, opts: { real?: boolean } = {}): Promise<Harness> {
  const page = await FakeReceiver.start();
  const source = fixtureSource();
  const settings: ServiceCuePublishSettings = { enabled: true, url: page.origin };
  const token = { value: TOKEN };
  let emit: (channel: string, payload: unknown) => void = () => {};
  const pub = new ServiceCuePublisher({
    source,
    loadSettings: async () => ({ ...settings }),
    loadToken: async () => token.value,
    version: () => "9.9.9",
    timings: { ...MANUAL, ...timings },
    ...(opts.real ? {} : { listen: (cb) => void (emit = cb) }),
  });
  const h = { page, source, pub, settings, token, emit: (c: string, p?: unknown) => emit(c, p) };
  live.push(h);
  return h;
}

/** Stop every publisher and close every receiver a test made. Called once, at the top of a test file. */
export function installPublisherHooks(): void {
  beforeEach(() => {
    live = [];
  });
  afterEach(async () => {
    for (const h of live) {
      h.pub.stop();
      await h.page.close();
    }
  });
}

/** Start, then run one full pass, the trickle behind it, and the frames it queued. */
export async function publishAll(h: Harness): Promise<void> {
  await h.pub.start();
  await h.pub.runCycle();
  await h.pub.trickle();
  await h.pub.flush();
}

/** What a channel's frames said, in order. */
export const framesOf = (h: Harness, channel: string) => h.page.frames().filter((f) => f.channel === channel);

/** The text of the last document PUT under `key`, or, for the three the page keeps from frames, what it holds. */
export const lastPut = (h: Harness, key: string) => h.page.puts().filter((p) => p.key === key).at(-1)?.body;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every log line a test's code wrote, from the three methods the publisher uses. */
export const logs = (t: TestContext) => captureConsole(t, "log", "warn", "error");
