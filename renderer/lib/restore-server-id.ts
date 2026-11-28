// Whether a restore asks about the server id.
//
// Kiosks and Mac outputs bind to a server by its id, and a config carries the id
// of the server it was saved on. Taking that id is right for a box that replaces
// that server and wrong for a second box that also runs, so the restore dialog
// asks, with the box unticked, whenever the two differ. When they match, or the
// config names no server, there is nothing to choose and the dialog is as it was.

/** The server id a config bundle was saved with, or null. The bundle came from a
 *  file somebody picked, so nothing about its shape is assumed. */
export function configServerId(bundle: unknown): string | null {
  const files = (bundle as { files?: unknown } | null)?.files;
  const settings = (files as Record<string, unknown> | null | undefined)?.["settings.json"];
  const id = (settings as { serverId?: unknown } | null | undefined)?.serverId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Ask only when the config names a server and it is not this one. This server
 *  having no id yet still asks: a fresh box is exactly where a replacement starts. */
export function asksReplaces(configId: string | null | undefined, ownId: string | null | undefined): boolean {
  return !!configId && configId !== ownId;
}

/** What a restore dialog needs to know about the config and this server. */
export interface RestoreFacts {
  configId: string | null | undefined;
  ownId: string | null | undefined;
  /** The config brings screens (a settings.json), which replace this server's. */
  carriesScreens: boolean;
  /** The config brings screen bindings (a kiosk-devices.json) of its own. */
  carriesBindings: boolean;
  /** Screens set up on this server, or null when that could not be read: then it
   *  is said as though there are some, rather than promising there are none. */
  ownBindings: number | null;
}

/** Said whenever the restore will release this server's screen bindings. */
export const RELEASE_LINE = "Screens set up on this server will be released and need setting up again.";

/**
 * Whether the restore releases this server's bindings, the server's rule
 * (config-snapshot.ts writeSnapshot) seen from here: only when the config's
 * screens replace this server's, and then unless the config's own bindings
 * replace these, which happens only when its id is taken (this server's own
 * config, or ticked) and it carries them. Taking this server's own id with no
 * bindings in the config leaves these alone: same id, same screens.
 */
export function releasesBindings(f: RestoreFacts, ticked: boolean): boolean {
  if (f.ownBindings === 0 || !f.carriesScreens) return false;
  const configId = f.configId ?? null;
  const takes = configId !== null && (configId === f.ownId || ticked);
  if (!takes) return true;
  return configId !== f.ownId && !f.carriesBindings;
}

/**
 * The parts of the dialog this adds: the question when the config was saved on
 * another server, and the release line exactly when a release will happen, for
 * each answer to the question. Worded once for the upload and the recall dialog.
 */
export function restoreQuestion(f: RestoreFacts, confirmLabel: string) {
  const line = (ticked: boolean) => (releasesBindings(f, ticked) ? RELEASE_LINE : undefined);
  if (!asksReplaces(f.configId, f.ownId)) return { note: line(false) };
  return {
    note: "This config was saved on another server.",
    checkbox: {
      label: "Use the config's server id",
      detail:
        "Only when this box replaces that one: its screens and Mac outputs move here. Unticked, this server keeps its own id, and the screens set up on it are released to be set up again. If that box is still running, leave it unticked, or both will fight over the same screens.",
      confirmLabel,
      whenUnchecked: line(false),
      whenChecked: line(true),
    },
  };
}
