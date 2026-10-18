// csv-appender.ts — append-only writer for one source within one service.
//
// Two things this has to get right:
//
//   Serialisation. Samples arrive at 1 Hz and a second append can begin before the
//   first resolves. fs.appendFile makes no interleaving promise at that
//   granularity, and a spliced line is a corrupt row, so every write chains onto
//   the one before it.
//
//   Ragged files. A meter that starts reporting a new metric mid-service changes
//   the column set. Widening the file in place would leave earlier rows short and
//   silently misaligned against the header, so a changed set moves to `spl.2.csv`
//   and both files go in the manifest.
//
//   A file it cannot use. One that is there and cannot be read, or stops taking
//   appends mid-service, is passed over the same way: the rows go on into the
//   next file beside it, and the one passed over is left exactly as it was.
//   Taking it for absent wrote a second header into the middle of a file this
//   service had already recorded, or dropped every row for the rest of it.
//
// Nothing here throws at the caller. The recorders run on the live tick, and a gap
// in the raw layer is recoverable where a crashed live service is not.

import { errnoCode, errorMessage, isNotFound } from "../errors.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { encodeRow, parseRows } from "../csv.js";

/** Guard against an unbounded scan if a directory somehow fills with rolled files. */
export const MAX_ROLL = 1000;

export class CsvAppender {
  private chain: Promise<void> = Promise.resolve();
  private written: string[] = [];
  private activeHeaders: string[] | null = null;
  private activeFile: string | null = null;
  /** Files this appender could not read or append to. Not tried again until
   *  the server restarts: one that fails on every row would log on every row. */
  private passedOver = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly base: string,
  ) {}

  /** Basenames written by this appender, in order — for the manifest. */
  files(): string[] {
    return [...this.written];
  }

  /** Queue a row. Resolves when it has landed; never rejects. */
  append(headers: string[], row: (string | number | null)[]): Promise<void> {
    this.chain = this.chain.then(() => this.write(headers, row)).catch((err: unknown) => {
      console.error(`[archive] ${this.base}: ${errorMessage(err)}`);
    });
    return this.chain;
  }

  /** Resolves when every queued append has landed. */
  settled(): Promise<void> {
    return this.chain;
  }

  private async write(headers: string[], row: (string | number | null)[]): Promise<void> {
    if (!this.activeHeaders || !sameColumns(this.activeHeaders, headers)) await this.open(headers);
    const file = this.activeFile as string;
    try {
      await fs.appendFile(path.join(this.dir, file), encodeRow(row), "utf8");
    } catch (err) {
      // The file this service has been appending to stopped taking rows. The
      // same row goes into the next file rather than every row after it being
      // lost; if that fails too, the chain logs it.
      this.passOver(file, err, "could not be appended to");
      await this.open(headers);
      await fs.appendFile(path.join(this.dir, this.activeFile as string), encodeRow(row), "utf8");
    }
  }

  private passOver(name: string, err: unknown, what: string): void {
    this.passedOver.add(name);
    this.activeHeaders = null;
    this.activeFile = null;
    console.error(
      `[archive] ${path.basename(this.dir)}/${name} ${what} (${errnoCode(err) ?? errorMessage(err)}). ` +
        `Recording ${this.base} into the next file beside it, and leaving this one as it is.`,
    );
  }

  /**
   * Point at the file these headers belong in.
   *
   * Walks `spl.csv`, `spl.2.csv`, … and takes the first that either does not exist
   * (creating it with the header) or already carries exactly this header. That one
   * rule covers a fresh start, a restart mid-service resuming its file, and a
   * restart after a roll resuming the rolled file rather than making another.
   */
  private async open(headers: string[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (let i = 1; i <= MAX_ROLL; i++) {
      const name = i === 1 ? `${this.base}.csv` : `${this.base}.${i}.csv`;
      if (this.passedOver.has(name)) continue;
      let existing: string[] | null;
      try {
        existing = await readHeader(path.join(this.dir, name));
      } catch (err) {
        // Passed over only when the file is there. A read that failed for a
        // reason that is not about this file (EMFILE, an EIO across the disk)
        // says nothing about the name: passing it over anyway walked every
        // name to the roll limit, ending the archive until a restart, and a
        // name skipped without a file left a gap in the roll.
        if (!(await isThere(path.join(this.dir, name)))) throw err;
        this.passOver(name, err, "could not be read");
        continue;
      }
      if (existing == null) {
        await fs.appendFile(path.join(this.dir, name), encodeRow(headers), "utf8");
      } else if (!sameColumns(existing, headers)) {
        continue; // a different column set lives here — try the next
      }
      this.activeHeaders = headers;
      this.activeFile = name;
      if (!this.written.includes(name)) this.written.push(name);
      return;
    }
    throw new Error(`${this.base}: more than ${MAX_ROLL} rolled files`);
  }
}

/** Whether something is at this path. False when that cannot be told either. */
async function isThere(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The header row of an existing file, or null when it does not exist or is empty
 *  (a file holding only a partial first write has no complete row yet). Throws
 *  for a file that is there and cannot be read. */
async function readHeader(file: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  return parseRows(text)[0] ?? null;
}
