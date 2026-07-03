// Shared disk-cache pruning. The photo + attachment caches are content-addressed
// and never overwrite, so without pruning they grow without bound — a real
// concern on a Raspberry Pi running for months. This evicts by age first, then
// enforces a total-size cap (oldest-first) as a backstop. Pruned files are
// re-fetched on demand, so eviction is always safe.

import * as fs from "fs/promises";
import * as path from "path";

export interface PruneOptions {
  /** Delete files whose mtime is older than this many ms. */
  maxAgeMs: number;
  /** After the age pass, if the dir still exceeds this, delete oldest-first. */
  maxBytes: number;
}

export interface PruneResult {
  removed: number;
  freedBytes: number;
}

/** Prune one cache directory. Best-effort: missing dir / unlink errors are ignored. */
export async function pruneCacheDir(dir: string, opts: PruneOptions): Promise<PruneResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { removed: 0, freedBytes: 0 };
  }

  const now = Date.now();
  const files: { file: string; mtime: number; size: number }[] = [];
  for (const name of entries) {
    const fp = path.join(dir, name);
    try {
      const st = await fs.stat(fp);
      if (st.isFile()) files.push({ file: fp, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* vanished — ignore */
    }
  }

  let removed = 0;
  let freedBytes = 0;

  // 1. Age-based eviction.
  const survivors: typeof files = [];
  for (const f of files) {
    if (now - f.mtime > opts.maxAgeMs) {
      try {
        await fs.unlink(f.file);
        removed++;
        freedBytes += f.size;
      } catch {
        /* ignore */
      }
    } else {
      survivors.push(f);
    }
  }

  // 2. Size-cap backstop — delete oldest until under the cap.
  let total = survivors.reduce((n, f) => n + f.size, 0);
  if (total > opts.maxBytes) {
    survivors.sort((a, b) => a.mtime - b.mtime);
    for (const f of survivors) {
      if (total <= opts.maxBytes) break;
      try {
        await fs.unlink(f.file);
        removed++;
        freedBytes += f.size;
        total -= f.size;
      } catch {
        /* ignore */
      }
    }
  }

  return { removed, freedBytes };
}
