// The boot migration onto slot boards, killed after each of its writes and booted
// again. Every state a crash can leave on disk must lose nothing: no column
// width, no board name, and no two boards merged that the operator kept apart.
//
// Each boot is its own node process, and the crash is a real SIGKILL right
// after a write lands. Nothing short of a new process is a restart: an
// in-process boot shares the stores' caches with the one before it, so what it
// reads is not what a crash left on disk.
//
// The screens are built so a lost width shows: "Right Display" has the same
// rows as "Left Display" and differs only in its column width, so a boot that
// lost the widths merges the two. "Left Confidence" is identical to "Left
// Display" in width too, so the migration does merge it, which is what makes
// the third write. Every id and name is invented.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CONTROLLER = path.join(REPO, "main/services/stage-controller.js");
const SLOTS_STORE = path.join(REPO, "main/services/slots-store.js");
const VIEWS_STORE = path.join(REPO, "main/services/views-store.js");

const TYPE = "st-weekend";
const row = (id: string, label: string) => ({ id, channel: "1", order: 0, link: { kind: "static", label, color: "#2E6691" } });

const VIEWS = [
  { id: "display-1", name: "Left Display", kind: "slots", surface: "display", createdAt: "", slotsLayout: { displayWidthIn: 32.25, columnWidthIn: 3.49 } },
  { id: "display-2", name: "Right Display", kind: "slots", surface: "display", createdAt: "", slotsLayout: { displayWidthIn: 32.25, columnWidthIn: 4.1 } },
  { id: "display-3", name: "Left Confidence", kind: "slots", surface: "display", createdAt: "", slotsLayout: { displayWidthIn: 20, columnWidthIn: 3.49 } },
  {
    id: "view-4", name: "Stage Layout", kind: "custom", surface: "display", createdAt: "",
    layout: { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [
      { id: "g-in", x: 0, y: 0, w: 1, h: 1, z: 0, config: { type: "slots-grid", source: "inline", sourceViewId: null, slotsLayout: { displayWidthIn: 18, columnWidthIn: 2.5 } } },
    ] },
  },
];
const SLOTS = {
  version: 3,
  defaults: {
    "display-1": { [TYPE]: [row("a1", "Pastor")] },
    "display-2": { [TYPE]: [row("b1", "Pastor")] },
    "display-3": { [TYPE]: [row("c1", "Pastor")] },
    "g-in": { [TYPE]: [row("g1", "Drums")] },
  },
  overrides: {},
};
const SETTINGS = {
  appName: "Stage Utility",
  layoutDefaultsCleaned: true,
  cardHairlineRaised: true,
  screenRolesFromView: true,
  serviceTypeId: TYPE,
  planId: null,
  outputs: [
    { id: "display-1", name: "Left", viewId: "display-1" },
    { id: "display-2", name: "Right", viewId: "display-2" },
  ],
};

/** What every boot after the migration must draw, whichever write it died after. */
const WANT = {
  boards: [
    ["display-1", "Left Display", 3.49],
    ["display-2", "Right Display", 4.1],
    ["g-in", "Stage Layout · widget", 2.5],
  ],
  layouts: {
    "display-1": { displayWidthIn: 32.25, columnWidthIn: 3.49 },
    "display-2": { displayWidthIn: 32.25, columnWidthIn: 4.1 },
    "display-3": { displayWidthIn: 20, columnWidthIn: 3.49 },
    "g-in": { displayWidthIn: 18, columnWidthIn: 2.5 },
  },
  rows: { "display-1": ["Pastor"], "display-2": ["Pastor"], "display-3": ["Pastor"], "g-in": ["Drums"] },
  pointers: { "display-1": "display-1", "display-2": "display-2", "display-3": "display-1" },
};

interface Seen {
  boards: [string, string, number | null][];
  layouts: Record<string, unknown>;
  rows: Record<string, string[]>;
  pointers: Record<string, string | null | undefined>;
  log: string[];
}

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

/**
 * One boot in its own process. With `killAfter`, the process SIGKILLs itself
 * the moment the migration's write number `killAfter` has landed on disk.
 */
async function boot(dataDir: string, killAfter?: number): Promise<Seen | null> {
  const script = path.join(dataDir, `boot-${Math.random().toString(36).slice(2)}.mts`);
  await fs.writeFile(
    script,
    `const { stageController } = await import(${JSON.stringify(CONTROLLER)});
const { slotsStore } = await import(${JSON.stringify(SLOTS_STORE)});
const { viewsStore } = await import(${JSON.stringify(VIEWS_STORE)});
const ctl = stageController as any;
ctl.broadcast = () => {};
ctl.startUpdateChecks = () => {};
const killAfter = ${killAfter === undefined ? "null" : String(killAfter)};
let armed = false;
let writes = 0;
const landed = () => {
  if (armed && ++writes === killAfter) process.kill(process.pid, "SIGKILL");
};
const migrate = ctl.migrateSlotBoards.bind(ctl);
ctl.migrateSlotBoards = async (views: unknown) => {
  armed = true;
  try { return await migrate(views); } finally { armed = false; }
};
const replaceFile = slotsStore.replaceFile.bind(slotsStore);
slotsStore.replaceFile = async (f: unknown) => { await replaceFile(f); landed(); };
const save = viewsStore.save.bind(viewsStore);
viewsStore.save = async (d: unknown) => { await save(d); landed(); };
const log: string[] = [];
const real = console.log;
console.log = (...a: unknown[]) => { log.push(a.map(String).join(" ")); };
console.error = console.log;
await stageController.init();
console.log = real;
ctl.stopSlotsPruning();
const s = stageController.getState();
const labels = (rows: any[] | undefined) => (rows ?? []).map((r) => r.link.label);
const boards = [...(await slotsStore.listBoards())].map(([id, b]: [string, any]) => [id, b.name, b.columnWidthIn]).sort();
const views = s.views as any[];
process.stdout.write("RESULT:" + JSON.stringify({
  boards,
  layouts: { ...Object.fromEntries(["display-1", "display-2", "display-3"].map((id) => [id, s.slotsLayoutByView[id]])), "g-in": s.slotsLayoutByLayoutObject["g-in"] },
  rows: { ...Object.fromEntries(["display-1", "display-2", "display-3"].map((id) => [id, labels(s.slotsByView[id])])), "g-in": labels(s.slotsByLayoutObject["g-in"]) },
  pointers: Object.fromEntries(["display-1", "display-2", "display-3"].map((id) => [id, views.find((v) => v.id === id)?.boardId])),
  log: log.filter((l) => l.startsWith("[slots-store]")),
}) + "\\n");
process.exit(0);
`,
    "utf8",
  );
  const { code, signal, stdout, stderr } = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("npx", ["tsx", script], {
      cwd: REPO,
      env: { ...process.env, STAGE_UTILITY_DATA: dataDir, HOME: path.join(dataDir, "home") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (c, sig) => resolve({ code: c, signal: sig, stdout: out, stderr: err }));
  });
  const match = /RESULT:(.*)/.exec(stdout);
  if (killAfter !== undefined) {
    // npx relays the child's death as a non-zero exit; what matters is that it
    // never reached the end.
    if (match) throw new Error(`the boot was to die after write ${killAfter}, and finished: it made fewer writes`);
    return null;
  }
  if (!match || code !== 0) throw new Error(`boot exited ${code ?? signal}\n${stderr}\n${stdout}`);
  return JSON.parse(match[1]!) as Seen;
}

async function freshDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage-boards-crash-"));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(SETTINGS), "utf8");
  await fs.writeFile(path.join(dir, "views.json"), JSON.stringify(VIEWS), "utf8");
  await fs.writeFile(path.join(dir, "slots.json"), JSON.stringify(SLOTS), "utf8");
  return dir;
}

function assertWhole(seen: Seen, when: string): void {
  assert.deepEqual(seen.boards, WANT.boards, `${when}: the boards (id, name, column width) are not what the migration makes`);
  assert.deepEqual(seen.layouts, WANT.layouts, `${when}: a screen or widget lost its alignment`);
  assert.deepEqual(seen.rows, WANT.rows, `${when}: a screen or widget lost its rows`);
  assert.deepEqual(seen.pointers, WANT.pointers, `${when}: a screen points at the wrong board`);
}

describe("the slot boards migration, uninterrupted", () => {
  let first: Seen;
  let second: Seen;
  before(async () => {
    const dir = await freshDir();
    first = (await boot(dir))!;
    second = (await boot(dir))!;
  });
  it("makes the boards, merging only the identical pair", () => assertWhole(first, "first boot"));
  it("changes nothing on the next boot", () => {
    assertWhole(second, "second boot");
    assert.deepEqual(second.log, []);
  });
});

for (const killAfter of [1, 2, 3]) {
  describe(`a boot killed after the migration's write ${killAfter}`, () => {
    let next: Seen;
    let third: Seen;
    let rawSlots: { pendingMerges?: unknown };
    before(async () => {
      const dir = await freshDir();
      await boot(dir, killAfter);
      next = (await boot(dir))!;
      third = (await boot(dir))!;
      rawSlots = JSON.parse(await fs.readFile(path.join(dir, "slots.json"), "utf8"));
    });
    it("is finished by the next boot with every width, name and board kept apart", () => assertWhole(next, "the boot after the crash"));
    it("stays that way, with nothing left pending", () => {
      assertWhole(third, "the boot after that");
      assert.equal(rawSlots.pendingMerges, undefined);
      assert.deepEqual(third.log, []);
    });
  });
}
