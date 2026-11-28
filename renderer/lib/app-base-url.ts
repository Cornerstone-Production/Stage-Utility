// app-base-url.ts — the address an operator copies, or a screen is pointed at.
//
// The Public address (Settings > Advanced > Network) when one is set, else the
// origin this browser reached the app by. Every "copy the address" control and
// every screen link reads it here, so an operator on the server's IP who copies a
// ServiceCue or StagePlots address gets the same name the Screens page gives out.
// Before, the Screens page used the Public address and those two cards used the
// browser's origin.

import { useStageState } from "../main/use-stage-state";

/** The Public address when one is set, else this page's origin. No trailing slash
 *  either way (the server stores the Public address without one). */
export function appBaseUrl(publicUrl: string | null | undefined): string {
  return publicUrl || window.location.origin;
}

/** appBaseUrl from the live stage state, for a component that has none in hand. */
export function useAppBaseUrl(): string {
  return appBaseUrl(useStageState().state?.publicUrl);
}
