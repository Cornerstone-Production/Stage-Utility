// fake-qrc-server.ts — an in-process Q-SYS Core speaking QRC, for tests only.
// Binds 127.0.0.1 on an ephemeral port; no real device is ever contacted.

import net from "node:net";
import { addressKey, isOn, isSelectorButton, parseAddressKey } from "../../types/qsys.js";
import { positionOf, taperFor } from "../../types/qsys-taper.js";
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

const key = (component: string, name: string): string => addressKey({ component, control: name });

export class FakeQrcServer {
  components = new Map<string, QrcControl[]>();
  /** Each component's Type as GetComponents reports it (`mixer`, `meter2`, ...); "component" when not set. */
  componentTypes = new Map<string, string>();
  /**
   * Components whose Position is NOT read from our measured tables: a square-law curve
   * instead, standing in for a Core whose taper the tables do not know, so a test can
   * tell the panel's table from the Core's own answer.
   */
  offTable = new Set<string>();
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
   * How change-group pushes reach the client. A Core sends `ChangeGroup.Poll`
   * notifications ("notify", Designer 10.0.1 Emulate), and answers the AutoPoll
   * request itself with one `true`. QSC's QRC Commands page shows AutoPoll
   * results as repeated replies carrying the AutoPoll request's id ("reply");
   * the client takes that form too.
   */
  autoPollForm: "notify" | "reply" = "notify";
  /**
   * When set, Component.Set lands what this returns instead of the value asked for:
   * a Core that limits or quantizes a write, so its read-back differs.
   */
  coerceSet: ((component: string, name: string, value: number | boolean | string) => number | boolean | string) | null = null;
  /**
   * The shape of a Component.Set reply with ResponseValues. A Core sends a bare
   * list ("array"); "object" is the `{ Name, Controls }` form QSC's page shows,
   * which the writer also takes.
   */
  setReplyForm: "array" | "object" = "array";
  /** The most change groups any one connection has held at once. */
  maxGroups = 0;
  /** When true, an Invalidate is answered but the values it resends are held until releaseInvalidatePushes(). */
  holdInvalidatePushes = false;
  private held: { session: Session; text: string }[] = [];
  private heldPushes: (() => void)[] = [];

  private server: net.Server | null = null;
  private sessions = new Set<Session>();
  private failures = new Map<string, number[]>();

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ noDelay: true }, (socket) => this.accept(socket));
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
    for (const c of this.land(component, control, value)) this.pushChange(component, c);
  }

  /** Answer every request held so far, in order. `holdReplies` is left as it is,
   *  so a test can let one step of a sequence through and hold the next. */
  releaseHeld(): void {
    const held = this.held;
    this.held = [];
    for (const h of held) this.answer(h.session, h.text);
  }

  /** Send the values held back from every Invalidate so far, in order. */
  releaseInvalidatePushes(): void {
    for (const push of this.heldPushes.splice(0)) push();
  }

  /**
   * One AutoPoll tick with nothing changed: a Core sends every polling group an
   * empty `Changes: []` on every tick (about every 30 ms at the fastest rate).
   * The fake sends changes the moment they happen instead of on a timer, so a
   * test calls this to send the empty ticks between them.
   */
  tick(): void {
    for (const session of this.sessions) {
      for (const [id, group] of session.groups) if (group.rate !== null) this.push(session, id, group, []);
    }
  }

  /** Push EngineStatus with the current `status` to every connected client. */
  pushStatus(): void {
    for (const session of this.sessions) this.notify(session, "EngineStatus", { ...this.status });
  }

  private find(component: string, name: string): QrcControl | undefined {
    return this.components.get(component)?.find((c) => c.Name === name);
  }

  /**
   * Land `value` on `control` as a Core does, answering every control it changed:
   * a selector plugin's Button N is a radio, so turning one on turns its siblings off.
   */
  private land(component: string, control: QrcControl, value: number | boolean | string): QrcControl[] {
    this.apply(component, control, value);
    if (!isSelectorButton(control.Name) || !isOn(control.Value)) return [control];
    const cleared = (this.components.get(component) ?? []).filter((c) => c !== control && isSelectorButton(c.Name) && isOn(c.Value));
    for (const c of cleared) this.apply(component, c, false);
    return [control, ...cleared];
  }

  private apply(component: string, control: QrcControl, value: number | boolean | string): void {
    control.Value = value;
    control.String = typeof value === "number" && control.ValueMin !== undefined ? `${value}dB` : String(value);
    if (typeof value === "number" && control.ValueMin !== undefined && control.ValueMax !== undefined) {
      // A component kind and range a Core's taper was measured on gets that taper's Position, as a Core reports it; any other, linear.
      const taper = taperFor(this.componentTypes.get(component) ?? null, { min: control.ValueMin, max: control.ValueMax });
      const span = control.ValueMax - control.ValueMin;
      const linear = span > 0 ? Math.min(1, Math.max(0, (value - control.ValueMin) / span)) : 0;
      control.Position = this.offTable.has(component) ? linear ** 2 : taper ? positionOf(taper, value) : linear;
    } else if (typeof value === "boolean") control.Position = value ? 1 : 0;
    else if (typeof value === "number") control.Position = value;
  }

  /**
   * A control as a change group, Component.Get and a Set read-back carry it. A Core
   * sends a Boolean there as 1 or 0 (String "true"/"false" as it was), though
   * GetControls reports the same control as true/false.
   */
  private change(component: string, c: QrcControl): QrcChange {
    const Value = typeof c.Value === "boolean" ? (c.Value ? 1 : 0) : c.Value;
    return { Component: component, Name: c.Name, Value, String: c.String, Position: c.Position };
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
          [...this.components.keys()].map((Name) => ({ Name, Type: this.componentTypes.get(Name) ?? "component", Properties: [] })),
        );
        return;
      case "Component.GetControls": {
        const controls = this.components.get(String(p.Name));
        if (!controls) return this.fail(session, msg.id, 7, "Unknown component");
        // GetControls carries no Legend; a Core says a button's name only to Component.Get.
        this.reply(session, msg.id, { Name: p.Name, Controls: controls.map(({ Legend: _legend, ...c }) => ({ ...c })) });
        return;
      }
      case "Component.Get":
        return this.componentGet(session, msg.id, p);
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
        if (!group) return;
        if (this.holdInvalidatePushes) this.heldPushes.push(() => this.pushGroup(session, String(p.Id), group));
        else this.pushGroup(session, String(p.Id), group);
        return;
      }
      default:
        this.fail(session, msg.id, -32601, "Method not found");
    }
  }

  /** `{ Name, Controls: [{ Name }] }` answers `{ Name, Controls: [{ Name, Value, String, Position, Legend? }] }`, Booleans as numbers. */
  private componentGet(session: Session, id: unknown, p: Record<string, unknown>): void {
    const name = String(p.Name);
    const controls = this.components.get(name);
    if (!controls) return this.fail(session, id, 7, "Unknown component");
    if (!Array.isArray(p.Controls)) return this.fail(session, id, -32602, "Invalid params: Controls is not a list");
    const out: Record<string, unknown>[] = [];
    for (const r of p.Controls as { Name?: unknown }[]) {
      const control = controls.find((c) => c.Name === r?.Name);
      if (!control) return this.fail(session, id, 8, "Unknown control");
      const { Component: _c, ...rest } = this.change(name, control);
      out.push(control.Legend === undefined ? rest : { ...rest, Legend: control.Legend });
    }
    this.reply(session, id, { Name: name, Controls: out });
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
    const changed = new Set<QrcControl>();
    requested.forEach((r, i) => {
      for (const c of this.land(name, targets[i], this.coerceSet ? this.coerceSet(name, r.Name, r.Value) : r.Value)) changed.add(c);
    });
    // A Core answers ResponseValues with a bare list, one entry per control set,
    // each naming its component (Designer 10.0.1 Emulate); without it, `true`.
    const values = targets.map((c) => this.change(name, c));
    this.reply(session, id, !p.ResponseValues ? true : this.setReplyForm === "array" ? values : { Name: name, Controls: values });
    for (const c of changed) this.pushChange(name, c);
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
      const { component, control: name } = parseAddressKey(k);
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
