// Shapes for renderer/lib/api-channels.test.ts: each one analyse() must follow,
// and each one it must refuse. A line marked `sends:` must credit exactly those
// channels, a line marked `flags:` must be listed as unresolved with exactly
// those reasons, and nothing unmarked may add either. Nothing imports this
// file; tsc and lint still check it.

import { useCallback } from "react";
import * as api from "../lib/api";
import { invoke, invoke as ipc, type IpcChannel } from "../lib/api";

declare const flag: boolean;

// ── Followed ─────────────────────────────────────────────────────────────────

export const literal = () => invoke("fixture:literal" as IpcChannel); // sends: fixture:literal
export const aliased = () => ipc("fixture:alias" as IpcChannel); // sends: fixture:alias
export const satisfied = () => invoke(("fixture:satisfies" as IpcChannel) satisfies IpcChannel); // sends: fixture:satisfies
export const ternary = () => invoke(flag ? ("fixture:yes" as IpcChannel) : ("fixture:no" as IpcChannel)); // sends: fixture:yes, fixture:no

const chosen = undefined as IpcChannel | undefined;
export const fallback = () => invoke(chosen ?? ("fixture:fallback" as IpcChannel)); // sends: fixture:fallback

export function branches() {
  let c: IpcChannel;
  if (flag) c = "fixture:branchA" as IpcChannel;
  else c = "fixture:branchB" as IpcChannel;
  return () => invoke(c); // sends: fixture:branchA, fixture:branchB
}

function inner(c: IpcChannel) { return invoke(c); }
function outer(c: IpcChannel) { return inner(c); }
export const chained = () => outer("fixture:chained" as IpcChannel); // sends: fixture:chained

function withDefault(c: IpcChannel = "fixture:default" as IpcChannel) { return invoke(c); } // sends: fixture:default
export const defaulted = () => [withDefault(), withDefault(undefined)];

function optional(c?: IpcChannel) { return c && invoke(c); }
export const omitted = () => [optional(), optional("fixture:optional" as IpcChannel)]; // sends: fixture:optional

const withThis = { send(this: unknown, c: IpcChannel) { return invoke(c); } };
export const thisParam = () => withThis.send("fixture:this" as IpcChannel); // sends: fixture:this

// Core no-redeclare does not know TypeScript overloads.
function overloaded(c: IpcChannel): Promise<unknown>;
// eslint-disable-next-line no-redeclare
function overloaded(c: IpcChannel, n: number): Promise<unknown>;
// eslint-disable-next-line no-redeclare
function overloaded(c: IpcChannel, n?: number) { void n; return invoke(c); }
export const overload = () => overloaded("fixture:overload" as IpcChannel); // sends: fixture:overload

class Direct { constructor(c: IpcChannel) { void invoke(c); } }
export const built = () => new Direct("fixture:new" as IpcChannel); // sends: fixture:new

function reassigned(c: IpcChannel) {
  c = flag ? c : ("fixture:reassigned" as IpcChannel); // sends: fixture:reassigned
  return invoke(c);
}
export const selfAssigned = () => reassigned("fixture:passed" as IpcChannel); // sends: fixture:passed

function relabelled(c: IpcChannel) { const d = c; return invoke(d); }
export const local = () => relabelled("fixture:relabelled" as IpcChannel); // sends: fixture:relabelled

const LISTED = ["fixture:listed" as IpcChannel] as const;
export const loops = () => {
  for (const c of ["fixture:inline" as IpcChannel]) void invoke(c); // sends: fixture:inline
  for (const c of LISTED) void invoke(c); // sends: fixture:listed
};

export function useDependencies() {
  const send = useCallback((c: IpcChannel) => invoke(c), []);
  return useCallback(() => send("fixture:dependency" as IpcChannel), [send]); // sends: fixture:dependency
}

const table = { send: (c: IpcChannel) => invoke(c) };
export const property = () => table.send("fixture:property" as IpcChannel); // sends: fixture:property

const { invoke: renamed } = api;
export const destructuredAlias = () => renamed("fixture:renamed" as IpcChannel); // sends: fixture:renamed

// ── Refused ──────────────────────────────────────────────────────────────────

export const castToAny = () => (invoke as any)("fixture:any"); // flags: invoke used as a value
export const called = () => invoke.call(null, "fixture:call" as IpcChannel); // flags: invoke used as a value
const slot: { send: (c: IpcChannel) => Promise<unknown> } = { send: invoke }; // flags: invoke used as a value
export const slotted = () => slot.send("fixture:slot" as IpcChannel);

function callback(c: IpcChannel) { return invoke(c); } // flags: a forwarder nothing calls directly
export const viaCallback = () => ["fixture:callback" as IpcChannel].forEach(callback); // flags: callback used as a value

function keyed(k: string, c: IpcChannel) { void k; return invoke(c); }
const pair = ["k", "fixture:spread" as IpcChannel] as const;
export const spread = () => keyed(...pair); // flags: a spread over the channel argument

export function destructured() {
  let c: IpcChannel;
  [c] = ["fixture:after" as IpcChannel];
  return invoke(c); // flags: c is destructured, looped or compound-assigned | sends no channel
}

export function compound() {
  let c = "fixture:plan";
  if (flag) c += "Now";
  return invoke(c as IpcChannel); // flags: c is destructured, looped or compound-assigned | sends no channel
}

const nothing = undefined as IpcChannel | undefined;
export const empty = () => invoke(nothing!); // flags: sends no channel

const pick = (): IpcChannel => "fixture:picked" as IpcChannel;
export const computed = () => invoke(pick()); // flags: pick() | sends no channel
const single = (): "stage:getState" => JSON.parse('"stage:refresh"');
export const typedOnly = () => invoke(single()); // flags: single() | sends no channel

function viaOptions(opts: { channel: IpcChannel }) { return invoke(opts.channel); } // flags: opts.channel | sends no channel
export const options = () => viaOptions({ channel: "fixture:options" as IpcChannel });

const TABLE = { a: { get: "fixture:tableA" }, b: { get: "fixture:tableB" } } as const;
function read<K extends keyof typeof TABLE>(k: K) { const { get } = TABLE[k]; return invoke(get as string as IpcChannel); } // flags: get | sends no channel
export const tabled = () => read("a");

const holder = { send: (c: IpcChannel) => invoke(c) }; // flags: a forwarder nothing calls directly
function deliver(s: { send: (c: IpcChannel) => unknown }) { return s.send("fixture:carried" as IpcChannel); }
export const carried = () => deliver(holder); // flags: holder carries a forwarder

function useRunAll(fns: ((c: IpcChannel) => unknown)[]) {
  return () => fns.forEach((f) => f("fixture:runAll" as IpcChannel));
}
export function useCustomDependencies() {
  const send = useCallback((c: IpcChannel) => invoke(c), []); // flags: a forwarder nothing calls directly
  return useRunAll([send]); // flags: send used as a value
}

class Handed { constructor(c: IpcChannel) { void invoke(c); } } // flags: a forwarder nothing calls directly
function make(C: new (c: IpcChannel) => unknown) { return new C("fixture:made" as IpcChannel); }
export const made = () => make(Handed); // flags: Handed used as a value

// Handed on as something other than a bare name. A class-typed parameter takes
// a method bivariantly, so each of these passes tsc.
class ClassSender { send(channel: string): Promise<unknown> { return Promise.resolve(channel); } }
class Api { send(channel: IpcChannel) { return invoke(channel); } }
export const apiDirect = () => new Api().send("fixture:api" as IpcChannel); // sends: fixture:api
function handTo(s: ClassSender) { return s.send("fixture:handed"); }
export const viaNew = () => handTo(new Api()); // flags: new Api() carries a forwarder
const maybeApi = flag ? new Api() : undefined;
export const viaBang = () => handTo(maybeApi!); // flags: maybeApi carries a forwarder
export const viaOr = () => handTo(maybeApi || new Api()); // flags: maybeApi carries a forwarder | new Api() carries a forwarder
const makeApi = () => new Api(); // flags: new Api() carries a forwarder
export const viaResult = () => handTo(makeApi()); // flags: makeApi() carries a forwarder
class SelfHanding {
  send(c: IpcChannel) { return invoke(c); }
  handOff() { return handTo(this); } // flags: this carries a forwarder
}
export const self = () => new SelfHanding().send("fixture:self" as IpcChannel); // sends: fixture:self
const registry: Record<string, unknown> = {};
const makeSender = () => (c: IpcChannel) => invoke(c); // flags: a forwarder nothing calls directly
export const viaFactory = () => { registry.run = makeSender(); }; // flags: makeSender() used as a value
const assigned = Object.assign({ id: 1 }, { send: (c: IpcChannel) => invoke(c) }); // flags: a forwarder nothing calls directly | { send: (c: IpcChannel) => invoke(c) } carries a forwarder
export const viaAssign = () => handTo(assigned); // flags: assigned carries a forwarder
const maybeTable = flag ? table : undefined;
export const viaOptional = () => { registry.run = maybeTable?.send; }; // flags: maybeTable?.send used as a value

// Where a value can be handed on, and what the walk reads.
function Panel(props: { api: unknown }) { void props; return null; }
export const rendered = () => <Panel api={holder} />; // flags: holder carries a forwarder
export const spreadRendered = () => <Panel api={null} {...holder} />; // flags: holder carries a forwarder
export const copied = { ...holder }; // flags: holder carries a forwarder
export const bundled = { holder }; // flags: holder carries a forwarder
export const wrapped = { h: holder }; // flags: holder carries a forwarder
export function giveBack() { return holder; } // flags: holder carries a forwarder
export const listedHolders = [holder]; // flags: holder carries a forwarder
export const viaIndex = () => table["send"].call(null, "fixture:index" as IpcChannel); // flags: table["send"] used as a value
function nullDefault(c: IpcChannel | null = "fixture:nullDefault" as IpcChannel) { return c && invoke(c); }
export const nulled = () => nullDefault(null); // flags: sends no channel
const MUTABLE = ["fixture:mutable" as IpcChannel];
MUTABLE.push("fixture:pushed" as IpcChannel);
export const mutable = () => { for (const c of MUTABLE) void invoke(c); }; // flags: c iterates something walk() cannot read | sends no channel
export const keysLoop = () => { for (const key in TABLE) void invoke(key as IpcChannel); }; // flags: key iterates keys | sends no channel
