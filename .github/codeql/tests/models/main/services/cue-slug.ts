export function slugForCue(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
