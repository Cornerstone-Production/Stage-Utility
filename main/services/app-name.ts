// The app's name: Branding's App name, also edited in the sidebar's Customize
// mode. One rule for every way in: the Branding route (which both surfaces save
// through) and a config restore.

/** Longest name. It is drawn on one line in the sidebar, every display's top bar
 *  and the browser tab; past this it is a sentence, not a name. */
export const MAX_APP_NAME = 80;

/** Why a name would be refused, or null when it is fine. */
export function appNameProblem(name: string): string | null {
  return name.trim().length > MAX_APP_NAME ? `the app name is longer than ${MAX_APP_NAME} characters` : null;
}
