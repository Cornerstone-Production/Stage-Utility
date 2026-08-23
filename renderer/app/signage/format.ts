// format.ts — how signage writes a size, in one place.
//
// It was written twice, in the media library and in "Prepare for offline", and
// the two had already drifted: one rendered 14.3 MB and the other 14 MB for the
// same file. An operator comparing what the library says with what the Pi
// reports it is holding is exactly the person that inconsistency confuses.

/** Bytes as something readable at a glance. */
export function size(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  // Never "0 KB" for a file that exists — a real graphic reading as nothing is
  // the kind of thing an operator deletes by mistake.
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
