// fake-qrc-server.ts — an in-process Q-SYS Core speaking QRC, for tests only.
// Binds 127.0.0.1 on an ephemeral port; no real device is ever contacted.

import net from "node:net";
import type { QrcChange, QrcControl, QrcStatus } from "./qrc-types.js";

const MAX_CHANGE_GROUPS = 4;

interface Group {
  controls: Set<string>;
}

interface Session {
  socket: net.Socket;
  buffer: Buffer;
  loggedOn: boolean;
  groups: Map<string, Group>;
}

const key = (component: string, name: string): string => `${component}\u0000${name}`;

export class FakeQrcServer {
  components = new Map<string, QrcControl[]>();
  status: QrcStatus = {
    Platform: "Core 110f",
    State: "Active",
    DesignName: "Test Design",
    DesignCode: "design-1",
    IsRedundant: false,
    IsEmulator: true,
  };
  requireLogon?: { User: string; Password: string };
  received: { method: string; params: unknown }[] = [];
  /** When true, requests are recorded and held unanswered until releaseHeld(). */
  holdReplies = false;
  private held: { session: Session; text: string }[] = [];

  private server: net.Server | null = null;
  private sessions = new Set<Session>();
  private failures = new Map<string, number[]>();

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  async stop(): Promise<void> {
    await this.dropClients();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Close every client socket the fake has accepted and wait until they are gone.
   * A client whose connect() just resolved may not be accepted yet: do one round
   * trip before calling this if the test needs that client dropped.
   */
  async dropClients(): Promise<void> {
    const sockets = [...this.sessions].map((s) => s.socket);
    await Promise.all(
      sockets.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (s.destroyed) return resolve();
            s.once("close", () => resolve());
            s.destroy();
          }),
      ),
    );
  }

  /** The next call of `method` fails with this QRC error code. */
  failNext(method: string, code: number): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(code);
    this.failures.set(method, queue);
  }

  /** Answer every request held so far, in order. `holdReplies` is left as it is,
   *  so a test can let one step of a sequence through and hold the next. */
  releaseHeld(): void {
    const held = this.held;
    this.held = [];
    for (const h of held) this.answer(h.session, h.text);
  }

  /** Push EngineStatus with the current `status` to every connected client. */
  pushStatus(): void {
    for (const session of this.sessions) this.notify(session, "EngineStatus", { ...this.status });
  }

  private find(component: string, name: string): QrcControl | undefined {
    return this.components.get(component)?.find((c) => c.Name === name);
  }

  private change(component: string, c: QrcControl): QrcChange {
    return { Component: component, Name: c.Name, Value: c.Value, String: c.String, Position: c.Position };
  }

  private accept(socket: net.Socket): void {
    const session: Session = { socket, buffer: Buffer.alloc(0), loggedOn: false, groups: new Map() };
    this.sessions.add(session);
    socket.on("error", () => {});
    socket.on("close", () => this.sessions.delete(session));
    socket.on("data", (chunk) => {
      session.buffer = Buffer.concat([session.buffer, chunk]);
      let nul: number;
      while ((nul = session.buffer.indexOf(0)) !== -1) {
        const text = session.buffer.subarray(0, nul).toString();
        session.buffer = session.buffer.subarray(nul + 1);
        if (text) this.handle(session, text);
      }
    });
    this.notify(session, "EngineStatus", { ...this.status });
  }

  private write(session: Session, message: unknown): void {
    if (!session.socket.destroyed) session.socket.write(`${JSON.stringify(message)}\0`);
  }

  private notify(session: Session, method: string, params: unknown): void {
    this.write(session, { jsonrpc: "2.0", method, params });
  }

  private reply(session: Session, id: unknown, result: unknown): void {
    this.write(session, { jsonrpc: "2.0", id, result });
  }

  private fail(session: Session, id: unknown, code: number, message: string): void {
    this.write(session, { jsonrpc: "2.0", id, error: { code, message } });
  }

  private handle(session: Session, text: string): void {
    let msg: { id?: number; method: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      this.write(session, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    this.received.push({ method: msg.method, params: msg.params });
    if (this.holdReplies) {
      this.held.push({ session, text });
      return;
    }
    this.answer(session, text);
  }

  private answer(session: Session, text: string): void {
    const msg = JSON.parse(text) as { id?: number; method: string; params?: Record<string, unknown> };
    const queued = this.failures.get(msg.method);
    if (queued?.length) {
      this.fail(session, msg.id, queued.shift()!, `forced failure of ${msg.method}`);
      return;
    }
    if (this.requireLogon && !session.loggedOn && msg.method !== "Logon") {
      this.fail(session, msg.id, 10, "Logon required");
      return;
    }
    const p = msg.params ?? {};
    switch (msg.method) {
      case "Logon": {
        const want = this.requireLogon;
        if (want && (p.User !== want.User || p.Password !== want.Password)) {
          this.fail(session, msg.id, 10, "Logon failed");
          return;
        }
        session.loggedOn = true;
        this.reply(session, msg.id, true);
        return;
      }
      case "NoOp":
        this.reply(session, msg.id, true);
        return;
      case "StatusGet":
        this.reply(session, msg.id, { ...this.status, Status: { Code: 0, String: "OK" } });
        return;
      case "Component.GetComponents":
        this.reply(
          session,
          msg.id,
          [...this.components.keys()].map((Name) => ({ Name, Type: "component", Properties: [] })),
        );
        return;
      case "Component.GetControls": {
        const controls = this.components.get(String(p.Name));
        if (!controls) return this.fail(session, msg.id, 7, "Unknown component");
        this.reply(session, msg.id, { Name: p.Name, Controls: controls.map((c) => ({ ...c })) });
        return;
      }
      case "ChangeGroup.AddComponentControl":
        return this.groupAdd(session, msg.id, p);
      default:
        this.fail(session, msg.id, -32601, "Method not found");
    }
  }

  private groupAdd(session: Session, id: unknown, p: Record<string, unknown>): void {
    const gid = String(p.Id);
    // Validate before creating the group, so a refused add never consumes one of the four.
    const comp = p.Component as { Name: string; Controls: { Name: string }[] } | undefined;
    if (!comp) return this.fail(session, id, 7, "Unknown component");
    if (!this.components.has(comp.Name)) return this.fail(session, id, 7, "Unknown component");
    for (const c of comp.Controls) {
      if (!this.find(comp.Name, c.Name)) return this.fail(session, id, 8, "Unknown control");
    }
    let group = session.groups.get(gid);
    if (!group) {
      if (session.groups.size >= MAX_CHANGE_GROUPS) return this.fail(session, id, 5, "Change groups exhausted");
      group = { controls: new Set() };
      session.groups.set(gid, group);
    }
    const fresh: QrcChange[] = [];
    for (const c of comp.Controls) {
      group.controls.add(key(comp.Name, c.Name));
      fresh.push(this.change(comp.Name, this.find(comp.Name, c.Name)!));
    }
    this.reply(session, id, true);
    // Adding a control resends its current state.
    this.notify(session, "ChangeGroup.Poll", { Id: gid, Changes: fresh });
  }
}
