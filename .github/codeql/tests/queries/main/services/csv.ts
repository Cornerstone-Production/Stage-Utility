// Stands in for main/services/csv.ts, the file the query's barrier names. The body
// does not matter to the barrier; it is the function's name and the file's path.
export function encodeRow(values: (string | number | null | undefined)[]): string {
  return values.map((v) => String(v ?? "")).join(",") + "\n";
}
