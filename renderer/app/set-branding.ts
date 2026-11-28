// Saving Branding: the app's name, logo, icon, images and accent.
//
// Its own module because two surfaces write it: the Branding page, and the
// sidebar's name field and logo menu in Customize mode. One handler, so the name
// typed in the sidebar is the same setting, saved the same way, as the one typed
// on Branding.

import type { QueryClient } from "@tanstack/react-query";
import type { AppIconInput } from "@main/services/app-icon";

import { invoke } from "../lib/api";
import { QUERY_KEYS } from "./queries";
import { writeTo } from "../lib/optimistic";

/** Where a logo, empty-slot image or avatar is cropped from its upload. */
export interface LogoCrop {
  scale: number;
  x: number;
  y: number;
}

export interface BrandingPatch {
  name?: string;
  accentColor?: string | null;
  logo?: string | null;
  monochrome?: boolean;
  logoOriginal?: string | null;
  logoCrop?: LogoCrop | null;
  emptyLogo?: string | null;
  emptyLogoOriginal?: string | null;
  emptyLogoCrop?: LogoCrop | null;
  avatar?: string | null;
  avatarOriginal?: string | null;
  avatarCrop?: LogoCrop | null;
  /** The tab and home-screen icon, set as a whole; `null` removes it. */
  icon?: AppIconInput | null;
}

/**
 * Write part of Branding. Resolves whether the server took it: a dialog that
 * closes on success must not close on a refusal, and the toast alone says
 * nothing to the dialog.
 */
export async function setBranding(queryClient: QueryClient, partial: BrandingPatch): Promise<boolean> {
  const next = await writeTo<StageState>(queryClient, QUERY_KEYS.stageState, () => invoke<StageState>("stage:setBranding", { ...partial }), {
    fail: "Failed to update branding",
    ok: "Branding updated.",
  });
  return next != null;
}
