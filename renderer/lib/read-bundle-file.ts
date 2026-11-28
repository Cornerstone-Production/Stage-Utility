/**
 * Read a picked export file and refuse, by name, one that is not the kind
 * wanted: picking the config snapshot where a view export belongs is the likely
 * mistake, and the operator should learn that without a round trip (the server
 * refuses it too). `what` finishes the sentence: "a video feeds export".
 * Throws an Error whose message is fit to show; a kind the file names is cut at
 * 60 characters so a hostile file cannot fill the screen.
 */
export async function readBundleFile<T extends { kind?: unknown }>(file: File, kind: string, what: string): Promise<T> {
  let bundle: T;
  try {
    bundle = JSON.parse(await file.text()) as T;
  } catch {
    throw new Error(`That file is not JSON, so it is not ${what}.`);
  }
  if (bundle?.kind !== kind) {
    throw new Error(`That is a "${String(bundle?.kind ?? "unknown").slice(0, 60)}" file, not ${what}.`);
  }
  return bundle;
}
