// Stand-in for the real scrub.ts: it escapes control characters, but never uses the
// replace(/\n/g, "") shape the stock query recognises, so the barrier model is the
// only thing that can make a call to it safe.
export function scrub(value: unknown): string {
  return String(value).replace(/[^ -~]/g, "?");
}

export function scrubError(value: unknown): string {
  return String(value).replace(/[^ -~]/g, "?");
}
