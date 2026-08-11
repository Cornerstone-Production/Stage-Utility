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
// Nothing here throws at the caller. The recorders run on the live tick, and a gap
// in the raw layer is recoverable where a crashed live service is not.

import { errorMessage } from "../errors.js";
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
    await fs.appendFile(path.join(this.dir, this.activeFile as string), encodeRow(row), "utf8");
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
      const existing = await readHeader(path.join(this.dir, name));
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

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The header row of an existing file, or null when it does not exist or is empty
 *  (a file holding only a partial first write has no complete row yet). */
async function readHeader(file: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null; // does not exist
  }
  return parseRows(text)[0] ?? null;
}
