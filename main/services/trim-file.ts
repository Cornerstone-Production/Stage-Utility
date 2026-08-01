// trim-file.ts — cap a log file at a byte budget without a check-then-use gap.
//
// Both persisted logs (the server log and the update log) grow forever and get
// trimmed to their last N bytes. The obvious way to write that is
//
//   const size = fs.statSync(p).size;
//   if (size <= MAX) return;
//   const buf = fs.readFileSync(p);
//   fs.writeFileSync(p, buf.subarray(...));
//
// which reopens the path three times. Between the stat and the read, the file
// can be appended to, rotated, or replaced — so the bytes measured are not the
// bytes read, and the write can clobber lines logged in between. In this app
// the writers are the log appender, the updater, and the recorder, all in one
// process but interleaved across async turns, so the window is real rather than
// theoretical.
//
// Opening once and working through that single descriptor closes it: fstat,
// read, and truncate all address the same open file, whatever happens to the
// path meanwhile.

import fs from "node:fs";

/**
 * Keep only the last `maxBytes` of `path`, cut at a line boundary.
 *
 * Returns true if the file was trimmed, false if it was already small enough or
 * could not be opened. Never throws — trimming is housekeeping, and a failure to
 * tidy a log must not take down the thing doing the logging.
 */
export function trimFileToLastBytes(path: string, maxBytes: number): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(path, "r+");
    const size = fs.fstatSync(fd).size;
    if (size <= maxBytes) return false;

    const buf = Buffer.allocUnsafe(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const slice = buf.subarray(0, read);

    // Start at the next line so a partial first line never survives.
    const nl = slice.indexOf(0x0a);
    const keep = nl >= 0 ? slice.subarray(nl + 1) : slice;

    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, keep, 0, keep.length, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}
