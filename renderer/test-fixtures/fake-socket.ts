// fake-socket.ts — a WebSocket that a test drives.
//
// Assign the class to `globalThis.WebSocket` before the code under test makes one, and
// the test holds what the code holds: `FakeSocket.last` is the socket it opened, `open()`
// is the server accepting, `say()` the server sending, `drop()` the connection going.
//
//   g.WebSocket = FakeSocket;
//   FakeSocket.last.open();
//   FakeSocket.last.say({ channel: "pco:live", data: {} });

export class FakeSocket {
  static instances: FakeSocket[] = [];

  /** The newest socket the code under test has opened. */
  static get last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1]!;
  }

  readyState = 0;
  /** Everything the code under test sent. */
  sent: string[] = [];
  /** Make `send` throw, as a socket that is closing does. */
  throwOnSend = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.throwOnSend) throw new Error("socket is not open");
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** The server accepts. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The server sends a message: a string as it is, anything else as JSON. */
  say(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  /** The connection goes. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}
