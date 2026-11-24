// fake-qrc-server.ts — an in-process Q-SYS Core speaking QRC, for tests only.
// Binds 127.0.0.1 on an ephemeral port; no real device is ever contacted.

import net from "node:net";
import type { QrcChange, QrcControl, QrcStatus } from "./qrc-types.js";

const MAX_CHANGE_GROUPS = 4;

interface Group {
  controls: Set<string>;
  rate: number | null;
  /** Reply form: the AutoPoll request id every push repeats, once AutoPoll has run. */
  pollId?: unknown;
  /** Reply form: changes waiting for the group's AutoPoll to start. */
  pending: QrcChange[];
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
  /**
   * How change-group pushes reach the client. QSC's QRC Commands page shows
   * AutoPoll results as repeated replies carrying the AutoPoll request's id
   * ("reply"); community modules handle `ChangeGroup.Poll` notifications
   * ("notify"). Which one a Core sends is unverified, so the client takes both.
   */
  autoPollForm: "notify" | "reply" = "notify";
  /**
   * When set, Component.Set lands what this returns instead of the value asked for:
   * a Core that limits or quantizes a write, so its read-back differs.
   */
  coerceSet: ((component: string, name: string, value: number | boolean | string) => number | boolean | string) | null = null;
  /** The most change groups any one connection has held at once. */
  maxGroups = 0;
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

  /** Simulates a change made at the Core (a UCI, a script): updates and pushes to change groups. */
  setControl(component: string, name: string, value: number | boolean | string): void {
    const control = this.find(component, name);
    if (!control) throw new Error(`fake core has no ${component}/${name}`);
    this.apply(control, value);
    this.pushChange(component, control);
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
        if (group.controls.has(key(component, control.Name))) this.push(s, id, group, [this.change(component, control)]);
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
      case "Component.Set":
        return this.componentSet(session, msg.id, p);
      case "ChangeGroup.AddComponentControl":
        return this.groupAdd(session, msg.id, p);
      case "ChangeGroup.Remove":
        return this.groupRemove(session, msg.id, p);
      case "ChangeGroup.AutoPoll": {
        const group = session.groups.get(String(p.Id));
        if (group) group.rate = Number(p.Rate);
        if (group && this.autoPollForm === "reply") {
          group.pollId = msg.id;
          this.reply(session, msg.id, { Id: String(p.Id), Changes: group.pending.splice(0) });
        } else this.reply(session, msg.id, true);
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
    if (!Array.isArray(p.Controls)) return this.fail(session, id, -32602, "Invalid params: Controls is not a list");
    const requested = p.Controls as { Name: string; Value: number | boolean | string }[];
    const targets: QrcControl[] = [];
    for (const r of requested) {
      const control = controls.find((c) => c.Name === r.Name);
      if (!control) return this.fail(session, id, 8, "Unknown control");
      targets.push(control);
    }
    requested.forEach((r, i) => this.apply(targets[i], this.coerceSet ? this.coerceSet(name, r.Name, r.Value) : r.Value));
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
    // Validate before creating the group, so a refused add never consumes one of the four.
    const comp = p.Component as { Name: string; Controls?: unknown } | undefined;
    if (!comp) return this.fail(session, id, 7, "Unknown component");
    if (!Array.isArray(comp.Controls)) return this.fail(session, id, -32602, "Invalid params: Component.Controls is not a list");
    const controls = comp.Controls as { Name: string }[];
    if (!this.components.has(comp.Name)) return this.fail(session, id, 7, "Unknown component");
    for (const c of controls) {
      if (!this.find(comp.Name, c.Name)) return this.fail(session, id, 8, "Unknown control");
    }
    let group = session.groups.get(gid);
    if (!group) {
      if (session.groups.size >= MAX_CHANGE_GROUPS) return this.fail(session, id, 5, "Change groups exhausted");
      group = { controls: new Set(), rate: null, pending: [] };
      session.groups.set(gid, group);
      this.maxGroups = Math.max(this.maxGroups, session.groups.size);
    }
    const fresh: QrcChange[] = [];
    for (const c of controls) {
      group.controls.add(key(comp.Name, c.Name));
      fresh.push(this.change(comp.Name, this.find(comp.Name, c.Name)!));
    }
    this.reply(session, id, true);
    // Adding a control resends its current state.
    this.push(session, gid, group, fresh);
  }

  /**
   * QRC's Remove takes `{ Id, Controls: [names] }` and works on Named Controls
   * only; there is no Component form. The fake has no Named Controls, so every
   * name is unknown and nothing leaves the group. A component control leaves a
   * group only through Clear (or Destroy) and a re-add.
   */
  private groupRemove(session: Session, id: unknown, p: Record<string, unknown>): void {
    const names = Array.isArray(p.Controls) ? p.Controls.map(String) : [];
    this.reply(session, id, names);
  }

  private pushGroup(session: Session, id: string, group: Group): void {
    const changes: QrcChange[] = [];
    for (const k of group.controls) {
      const [component, name] = k.split("\u0000");
      const control = this.find(component, name);
      if (control) changes.push(this.change(component, control));
    }
    this.push(session, id, group, changes);
  }

  /** Deliver a group's changes in the configured form. */
  private push(session: Session, id: string, group: Group, changes: QrcChange[]): void {
    if (this.autoPollForm === "notify") return this.notify(session, "ChangeGroup.Poll", { Id: id, Changes: changes });
    if (group.pollId === undefined) group.pending.push(...changes);
    else this.reply(session, group.pollId, { Id: id, Changes: changes });
  }
}
