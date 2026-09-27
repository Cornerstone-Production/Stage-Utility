// fake-event-source.ts — the fake SSE EventSource most renderer tests that
// stub a live push need: enough of the real interface (addEventListener,
// removeEventListener, close) that code opening one does not throw, plus
// `push(channel, payload)` to fire a channel's listeners on demand and
// `static last` so a test can reach whichever instance the code under test
// most recently constructed (there is exactly one live at a time in these
// tests, so `.last` is unambiguous).
//
//   (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
//   …
//   FakeEventSource.last!.push("baptism:state", { … });
//
// TEST-ONLY: no `.test.` in the filename on purpose, so `npm test`'s glob does
// not pick this up as a (zero-test) suite of its own. Imports nothing from
// Testing Library or anything else that binds to `document` at import time —
// see fetch-log.ts's own header comment for why that matters here too.

export class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 1;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.listeners.get(name)?.delete(fn);
  }
  close(): void {}
  push(channel: string, payload: unknown): void {
    for (const fn of this.listeners.get(channel) ?? []) fn({ data: JSON.stringify(payload) } as MessageEvent);
  }
}
