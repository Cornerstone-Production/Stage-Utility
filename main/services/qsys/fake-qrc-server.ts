// fake-qrc-server.ts — an in-process Q-SYS Core speaking QRC, for tests only.
// Binds 127.0.0.1 on an ephemeral port; no real device is ever contacted.

import net from "node:net";
import type { QrcChange, QrcControl, QrcStatus } from "./qrc-types.js";

const MAX_CHANGE_GROUPS = 4;

interface Group {
  controls: Set<string>;
  rate: number | null;
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
  /** When true, requests are recorded but never answered (timeout and drop tests). */
  holdReplies = false;

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

  /** Simulates a change made at the Core (a UCI, a script): updates and pushes to change groups. */
  setControl(component: string, name: string, value: number | boolean | string): void {
    const control = this.find(component, name);
    if (!control) throw new Error(`fake core has no ${component}/${name}`);
    this.apply(control, value);
    this.pushChange(component, control);
  }

  private find(component: string, name: string): QrcControl | undefined {
    return this.components.get(component)?.find((c) => c.Name === name);
  }

  private apply(control: QrcControl, value: number | boolean | string): void {
    control.Value = value;
    control.String = typeof value === "number" && control.ValueMin !== undefined ? `${value}dB` : String(value);
    if (typeof value === "number" && control.ValueMin !== undefined && control.ValueMax !== undefined) {
      const span = control.ValueMax - control.ValueMin;
      control.Position = span > 0 ? (value - control.ValueMin) / span : 0;
    } else if (typeof value === "boolean") control.Position = value ? 1 : 0;
    else if (typeof value === "number") control.Position = value;
  }

  private change(component: string, c: QrcControl): QrcChange {
    return { Component: component, Name: c.Name, Value: c.Value, String: c.String, Position: c.Position };
  }

  private pushChange(component: string, control: QrcControl): void {
    for (const s of this.sessions) {
      for (const [id, group] of s.groups) {
        if (group.controls.has(key(component, control.Name))) {
          this.notify(s, "ChangeGroup.Poll", { Id: id, Changes: [this.change(component, control)] });
        }
      }
    }
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
    const msg = JSON.parse(text) as { id?: number; method: string; params?: Record<string, unknown> };
    this.received.push({ method: msg.method, params: msg.params });
    if (this.holdReplies) return;

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
      case "Component.Set":
        return this.componentSet(session, msg.id, p);
      case "ChangeGroup.AddComponentControl":
        return this.groupAdd(session, msg.id, p);
      case "ChangeGroup.Remove":
        return this.groupRemove(session, msg.id, p);
      case "ChangeGroup.AutoPoll": {
        const group = session.groups.get(String(p.Id));
        if (group) group.rate = Number(p.Rate);
        this.reply(session, msg.id, true);
        return;
      }
      case "ChangeGroup.Clear": {
        const group = session.groups.get(String(p.Id));
        if (group) group.controls.clear();
        this.reply(session, msg.id, true);
        return;
      }
      case "ChangeGroup.Destroy":
        session.groups.delete(String(p.Id));
        this.reply(session, msg.id, true);
        return;
      case "ChangeGroup.Invalidate": {
        const group = session.groups.get(String(p.Id));
        this.reply(session, msg.id, true);
        if (group) this.pushGroup(session, String(p.Id), group);
        return;
      }
      default:
        this.fail(session, msg.id, -32601, "Method not found");
    }
  }

  private componentSet(session: Session, id: unknown, p: Record<string, unknown>): void {
    const name = String(p.Name);
    const controls = this.components.get(name);
    if (!controls) return this.fail(session, id, 7, "Unknown component");
    const requested = (p.Controls ?? []) as { Name: string; Value: number | boolean | string }[];
    const targets: QrcControl[] = [];
    for (const r of requested) {
      const control = controls.find((c) => c.Name === r.Name);
      if (!control) return this.fail(session, id, 8, "Unknown control");
      targets.push(control);
    }
    requested.forEach((r, i) => this.apply(targets[i], r.Value));
    this.reply(
      session,
      id,
      p.ResponseValues
        ? {
            Name: name,
            Controls: targets.map((c) => ({ Name: c.Name, Value: c.Value, String: c.String, Position: c.Position })),
          }
        : true,
    );
    for (const c of targets) this.pushChange(name, c);
  }

  private groupAdd(session: Session, id: unknown, p: Record<string, unknown>): void {
    const gid = String(p.Id);
    let group = session.groups.get(gid);
    if (!group) {
      if (session.groups.size >= MAX_CHANGE_GROUPS) return this.fail(session, id, 5, "Change groups exhausted");
      group = { controls: new Set(), rate: null };
      session.groups.set(gid, group);
    }
    const comp = p.Component as { Name: string; Controls: { Name: string }[] } | undefined;
    if (!comp) return this.fail(session, id, 7, "Unknown component");
    if (!this.components.has(comp.Name)) return this.fail(session, id, 7, "Unknown component");
    for (const c of comp.Controls) {
      if (!this.find(comp.Name, c.Name)) return this.fail(session, id, 8, "Unknown control");
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

  private groupRemove(session: Session, id: unknown, p: Record<string, unknown>): void {
    const group = session.groups.get(String(p.Id));
    const comp = p.Component as { Name: string; Controls: { Name: string }[] } | undefined;
    if (group && comp) for (const c of comp.Controls) group.controls.delete(key(comp.Name, c.Name));
    this.reply(session, id, true);
  }

  private pushGroup(session: Session, id: string, group: Group): void {
    const changes: QrcChange[] = [];
    for (const k of group.controls) {
      const [component, name] = k.split("\u0000");
      const control = this.find(component, name);
      if (control) changes.push(this.change(component, control));
    }
    this.notify(session, "ChangeGroup.Poll", { Id: id, Changes: changes });
  }
}
