// first-free.ts — "base, else base-2, base-3 … until nothing answers to it".

/**
 * `base` when `isTaken` refuses it, else the first `join(base, n)` for n = 2, 3 …
 * that it refuses. `join` is where a caller keeps its own rule for where the
 * suffix goes (a hyphen, an underscore, a space, or trimming `base` to fit a
 * length limit first).
 */
export function firstFree(base: string, isTaken: (candidate: string) => boolean, join: (base: string, n: number) => string = (b, n) => `${b}-${n}`): string {
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = join(base, n);
    if (!isTaken(candidate)) return candidate;
  }
}
