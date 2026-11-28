// write-queue.ts — serialise writes to one file, and name temp files uniquely.
//
// Two stores had independently grown the same need and only one had solved it.
// DataStore serialises through a promise chain so concurrent callers cannot
// interleave a read-modify-write; secrets.ts had no such guard and, worse, wrote
// through a temp path fixed at `${file}.tmp`. Two overlapping saves then wrote
// the SAME temp file with different ciphertexts — a non-atomic writeFile, so the
// bytes could interleave — and the first rename promoted a blob whose AES-GCM
// auth tag no longer verified. Every integration credential and wireless
// password, gone, with the loser's rename failing ENOENT out of an HTTP handler.
//
// So this exists once, and both use it. A unique temp name per write means two
// writers can never share a scratch file even if they are never serialised; the
// queue means, for one store, they are.

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Serialises calls so a store's read-modify-write cannot interleave. */
export class WriteQueue {
  private chain: Promise<unknown> = Promise.resolve();

  /** Run `fn` after all prior queued work settles (success or failure). */
  enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const result = this.chain.then(fn, fn);
    // Keep the chain alive even if a write rejects.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Per-key WriteQueues: work under one key runs one at a time in the order it was
 *  queued, work under different keys does not wait for each other. A key's chain is
 *  dropped when its last piece of work settles, so keys that come and go (a venue)
 *  do not accumulate. A rejection never stops a chain. */
export class KeyedQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  /** Run `fn` after all prior work under `key` settles (success or failure). */
  enqueue<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** How many keys have work queued or running. */
  get busy(): number {
    return this.chains.size;
  }

  /** Resolves when the work queued under every key but `except` has settled. */
  async idle(except: readonly string[] = []): Promise<void> {
    await Promise.all([...this.chains].filter(([key]) => !except.includes(key)).map(([, tail]) => tail));
  }
}

let counter = 0;

/**
 * Write `data` to `filePath` atomically.
 *
 * rename(2) is atomic on a single filesystem, so a reader never sees a partial
 * file and an interrupted write leaves the previous file fully intact. The temp
 * name carries the pid and a counter so two processes or two concurrent writers
 * cannot collide on it.
 */
export async function atomicWrite(
  filePath: string,
  data: string | Uint8Array,
  opts: { mode?: number } = {},
): Promise<void> {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${++counter}.tmp`,
  );
  try {
    await fs.writeFile(tmp, data, opts.mode != null ? { mode: opts.mode } : undefined);
    await fs.rename(tmp, filePath);
  } catch (err) {
    // Never leave scratch behind on a failed write — on a full disk that is the
    // one thing that makes the next attempt fail too.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
