// "Shares people with N other slots": slots configured with the same positions
// compete for distinct people, and ticking one more position silently changes the
// grouping, so the inspector says so.

/** Canonical identity of a slot's positions set — mirrors positionSignature in
 *  main/services/slot-resolver.ts. null for slots that don't participate. */
function positionsSignature(slot: Slot): string | null {
  if (slot.link.kind !== "pco" || slot.link.matchBy !== "position") return null;
  if (slot.link.positions.length === 0) return null;
  return JSON.stringify(
    slot.link.positions
      .map((p) => [
        (p.name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase(),
        (p.notesStartsWith ?? "").trim().toLowerCase(),
      ] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
  );
}

/** A "how many other slots on this board share my set" lookup. */
export function makeSharesWith(slots: readonly Slot[]): (slot: Slot) => number {
  const counts = new Map<string, number>();
  for (const s of slots) {
    const sig = positionsSignature(s);
    if (sig) counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  return (slot: Slot) => {
    const sig = positionsSignature(slot);
    return sig ? (counts.get(sig) ?? 1) - 1 : 0;
  };
}
