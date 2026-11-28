/** `item` moved to `index` of the list without it (clamped to the ends). An item not in the list is inserted. */
export function moveTo<T>(list: readonly T[], item: T, index: number): T[] {
  const out = list.filter((x) => x !== item);
  out.splice(Math.max(0, Math.min(index, out.length)), 0, item);
  return out;
}
