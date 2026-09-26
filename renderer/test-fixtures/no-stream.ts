// no-stream.ts — a no-op EventSource stand-in for a test whose subject reaches
// a hook that opens a stream on a branch the test does not exercise. Never
// delivers anything; give a test that needs an actual push FakeEventSource
// (fake-event-source.ts) instead.
//
// TEST-ONLY: no `.test.` in the filename on purpose, so `npm test`'s glob does
// not pick this up as a (zero-test) suite of its own. Imports nothing that
// binds to `document` at import time — see fetch-log.ts's own header comment.

export class NoStream {
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
