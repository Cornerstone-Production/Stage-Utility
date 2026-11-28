// An encodeRow under main/services/archive: the barrier is the one in main/services/csv.ts,
// not any encodeRow near it, so a call to this one must not be covered.
export function encodeRow(values: string[]): string {
  return values.join(",") + "\n";
}
