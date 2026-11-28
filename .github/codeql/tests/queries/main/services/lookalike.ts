// An encodeRow that is not the one the query trusts: the barrier is that function in
// main/services/csv.ts, not any function of that name.
export function encodeRow(values: string[]): string {
  return values.join(",") + "\n";
}
