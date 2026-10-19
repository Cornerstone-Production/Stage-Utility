import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { CsvAppender } from "./csv-appender.js";
import { captureConsole } from "../fixtures/capture-console.js";
import { parseRows } from "../csv.js";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "archive-test-"));
}

async function rows(dir: string, name: string): Promise<string[][]> {
  return parseRows(await fs.readFile(path.join(dir, name), "utf8"));
}

test("writes the header once, then rows", async () => {
  const dir = await tmp();
  const a = new CsvAppender(dir, "spl");
  await a.append(["at", "db"], ["t1", 90]);
  await a.append(["at", "db"], ["t2", 91]);
  assert.deepEqual(await rows(dir, "spl.csv"), [
    ["at", "db"],
    ["t1", "90"],
    ["t2", "91"],
  ]);
});

test("serialises concurrent appends without splicing rows", async () => {
  const dir = await tmp();
  const a = new CsvAppender(dir, "spl");
  const headers = ["n"];
  await Promise.all(Array.from({ length: 200 }, (_, i) => a.append(headers, [i])));
  const r = await rows(dir, "spl.csv");
  assert.deepEqual(r[0], ["n"], "exactly one header row, first");
  assert.equal(r.length, 201, "header + 200 rows");
  const got = r
    .slice(1)
    .map((x) => Number(x[0]))
    .sort((x, y) => x - y);
  assert.deepEqual(got, Array.from({ length: 200 }, (_, i) => i));
});

test("a changed column set rolls to a new file rather than a ragged one", async () => {
  const dir = await tmp();
  const a = new CsvAppender(dir, "spl");
  await a.append(["at", "db"], ["t1", 90]);
  await a.append(["at", "db", "lceq"], ["t2", 91, 95]);
  await a.append(["at", "db", "lceq"], ["t3", 92, 96]);

  assert.deepEqual(await rows(dir, "spl.csv"), [
    ["at", "db"],
    ["t1", "90"],
  ]);
  assert.deepEqual(await rows(dir, "spl.2.csv"), [
    ["at", "db", "lceq"],
    ["t2", "91", "95"],
    ["t3", "92", "96"],
  ]);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["spl.2.csv", "spl.csv"]);
});

test("resumes an existing file without repeating the header", async () => {
  const dir = await tmp();
  await new CsvAppender(dir, "spl").append(["at", "db"], ["t1", 90]);
  await new CsvAppender(dir, "spl").append(["at", "db"], ["t2", 91]);
  assert.deepEqual(await rows(dir, "spl.csv"), [
    ["at", "db"],
    ["t1", "90"],
    ["t2", "91"],
  ]);
});

test("resuming with a different column set rolls rather than appending ragged rows", async () => {
  const dir = await tmp();
  await new CsvAppender(dir, "spl").append(["at", "db"], ["t1", 90]);
  await new CsvAppender(dir, "spl").append(["at", "db", "lceq"], ["t2", 91, 95]);
  assert.deepEqual(await rows(dir, "spl.csv"), [
    ["at", "db"],
    ["t1", "90"],
  ]);
  assert.deepEqual(await rows(dir, "spl.2.csv"), [
    ["at", "db", "lceq"],
    ["t2", "91", "95"],
  ]);
});

test("a third process resuming the rolled file appends to it, not a fourth", async () => {
  const dir = await tmp();
  await new CsvAppender(dir, "spl").append(["at", "db"], ["t1", 90]);
  await new CsvAppender(dir, "spl").append(["at", "db", "lceq"], ["t2", 91, 95]);
  await new CsvAppender(dir, "spl").append(["at", "db", "lceq"], ["t3", 92, 96]);
  assert.deepEqual(await rows(dir, "spl.2.csv"), [
    ["at", "db", "lceq"],
    ["t2", "91", "95"],
    ["t3", "92", "96"],
  ]);
  assert.ok(!(await fs.readdir(dir)).includes("spl.3.csv"), await fs.readdir(dir).then(String));
});

test("a write failure is logged rather than thrown at the recorder", async () => {
  const dir = await tmp();
  // A file where the directory should be: mkdir will fail on every append.
  const blocked = path.join(dir, "blocked");
  await fs.writeFile(blocked, "not a directory");
  const a = new CsvAppender(blocked, "spl");
  await a.append(["at"], ["t1"]); // must resolve, not reject
  await a.settled();
});

test("settled resolves once queued appends have landed", async () => {
  const dir = await tmp();
  const a = new CsvAppender(dir, "spl");
  void a.append(["n"], [1]);
  void a.append(["n"], [2]);
  await a.settled();
  assert.equal((await rows(dir, "spl.csv")).length, 3);
});

// ── A file that is there and cannot be used ──
//
// Taken for absent, an unreadable spl.csv got a second header written into the
// middle of the rows it already held (writable but not readable), or lost every
// row for the rest of the service (neither). Now it is passed over like a file
// with a different column set, and left exactly as it was.

/** File permissions do not stop root, so the permission cases skip there. */
const asRoot = process.getuid?.() === 0;

test("a directory where spl.csv should be is passed over, and the rows go to spl.2.csv", async (t) => {
  const lines = captureConsole(t, "error");
  const dir = await tmp();
  await fs.mkdir(path.join(dir, "spl.csv"));
  const a = new CsvAppender(dir, "spl");
  await a.append(["at", "db"], ["t1", 90]);
  await a.append(["at", "db"], ["t2", 91]);
  assert.ok((await fs.stat(path.join(dir, "spl.csv"))).isDirectory(), "spl.csv was touched");
  assert.deepEqual(await rows(dir, "spl.2.csv"), [
    ["at", "db"],
    ["t1", "90"],
    ["t2", "91"],
  ]);
  assert.equal(lines.length, 1, `logged ${lines.length} times, not once:\n${lines.join("\n")}`);
  assert.match(lines[0], /^\[archive\] \S+\/spl\.csv could not be read \(EISDIR\)\. Recording spl into the next file/);
});

test("an spl.csv that can be written but not read is left as it was", { skip: asRoot }, async (t) => {
  captureConsole(t, "error");
  const dir = await tmp();
  const file = path.join(dir, "spl.csv");
  const before = "at,db\nt0,80\n";
  await fs.writeFile(file, before);
  await fs.chmod(file, 0o200);
  try {
    await new CsvAppender(dir, "spl").append(["at", "db"], ["t1", 90]);
  } finally {
    await fs.chmod(file, 0o644);
  }
  assert.equal(await fs.readFile(file, "utf8"), before, "a second header was written into the recorded file");
  assert.deepEqual(await rows(dir, "spl.2.csv"), [
    ["at", "db"],
    ["t1", "90"],
  ]);
});

test("a file that stops taking appends mid-service hands the same row to the next file", { skip: asRoot }, async (t) => {
  const lines = captureConsole(t, "error");
  const dir = await tmp();
  const file = path.join(dir, "spl.csv");
  const a = new CsvAppender(dir, "spl");
  await a.append(["at", "db"], ["t1", 90]);
  await fs.chmod(file, 0o444);
  try {
    await a.append(["at", "db"], ["t2", 91]);
    await a.append(["at", "db"], ["t3", 92]);
  } finally {
    await fs.chmod(file, 0o644);
  }
  assert.equal(lines.length, 1, `logged ${lines.length} times, not once:\n${lines.join("\n")}`);
  assert.match(lines[0], /spl\.csv could not be appended to \(EACCES\)/);
  assert.deepEqual(await rows(dir, "spl.csv"), [
    ["at", "db"],
    ["t1", "90"],
  ]);
  assert.deepEqual(
    await rows(dir, "spl.2.csv"),
    [
      ["at", "db"],
      ["t2", "91"],
      ["t3", "92"],
    ],
    "a row was lost",
  );
  assert.deepEqual((await fs.readdir(dir)).sort(), ["spl.2.csv", "spl.csv"]);
});

test("a read failure that is not about the file passes nothing over, and the appender recovers", { skip: asRoot }, async (t) => {
  // Every name fails to read (here: the folder cannot be searched, as with
  // EMFILE or an EIO across the disk), including names with no file. Passing
  // those over walked all of them to the roll limit, logged each, and ended
  // this appender's archive until a restart.
  const lines = captureConsole(t, "error");
  const dir = await tmp();
  const a = new CsvAppender(dir, "spl");
  await fs.chmod(dir, 0o200);
  try {
    await a.append(["at", "db"], ["t1", 90]);
  } finally {
    await fs.chmod(dir, 0o755);
  }
  assert.equal(lines.length, 1, `logged ${lines.length} lines for one row`);
  await a.append(["at", "db"], ["t2", 91]);
  assert.deepEqual(await rows(dir, "spl.csv"), [
    ["at", "db"],
    ["t2", "91"],
  ]);
});

test("running out of file handles passes no file over, on a read or an append", async (t) => {
  // EMFILE is the machine, not the file: lstat still finds the file, and
  // passing it over rolled it to a new one on every blip. That row is lost
  // and the next one goes on in the same file.
  captureConsole(t, "error");
  const { syncBuiltinESMExports } = await import("node:module");
  const fsp = (await import("node:fs/promises")).default;
  const dir = await tmp();
  await new CsvAppender(dir, "spl").append(["at", "db"], ["t1", 90]);
  const emfile = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
  const fail = <F extends (...a: never[]) => unknown>(name: "readFile" | "appendFile") => {
    const real = fsp[name] as unknown as F;
    let once = true;
    t.mock.method(fsp, name, (async (...args: Parameters<F>) => {
      if (once) {
        once = false;
        throw emfile;
      }
      return real(...args);
    }) as never);
    syncBuiltinESMExports();
  };

  const reopened = new CsvAppender(dir, "spl"); // reads the header first
  fail("readFile");
  await reopened.append(["at", "db"], ["t2", 91]); // lost
  await reopened.append(["at", "db"], ["t3", 92]);
  fail("appendFile");
  await reopened.append(["at", "db"], ["t4", 93]); // lost
  await reopened.append(["at", "db"], ["t5", 94]);
  t.mock.restoreAll();
  syncBuiltinESMExports();

  assert.deepEqual(await fs.readdir(dir), ["spl.csv"], "a file was rolled for a machine failure");
  assert.deepEqual(await rows(dir, "spl.csv"), [
    ["at", "db"],
    ["t1", "90"],
    ["t3", "92"],
    ["t5", "94"],
  ]);
});
