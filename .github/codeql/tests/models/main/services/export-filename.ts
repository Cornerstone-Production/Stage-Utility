export function filenameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
