// app-paths.ts — Portable userData path accessor.
//
// In Glaze mode, index.ts calls setUserDataPath(await app.getPath("userData"))
// before any service initialises.  In standalone mode, server.ts calls it
// with a path from an env var or a sensible OS default.

let _userDataPath: string | null = null;

/** Set the user-data directory.  Must be called before any store is first used. */
export function setUserDataPath(p: string): void {
  _userDataPath = p;
}

/**
 * Return the user-data directory.  Throws if not yet set — this means
 * setUserDataPath() was not called before the first store operation.
 */
export function getUserDataPath(): string {
  if (!_userDataPath) {
    throw new Error(
      "[app-paths] getUserDataPath() called before setUserDataPath(). " +
        "Call setUserDataPath() in the entry point (index.ts or server.ts) before initialising any store.",
    );
  }
  return _userDataPath;
}
