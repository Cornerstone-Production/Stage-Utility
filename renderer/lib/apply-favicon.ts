// Points the browser tab icon at the logo uploaded in Branding → Logo, and back
// at the stock icon when there is none. Called from the one place every surface
// adopts a StageState (use-stage-state.ts), exactly as applyAccentVar is, so the
// operator app and every kiosk display follow a logo change without a reload.
//
// The stored logo is already a square PNG: the Branding cropper always exports a
// square region, so there is nothing to letterbox. It is used as it is, with no
// recolouring — "Recolor to match theme" is a CSS mask over the image, which has
// no raster form to hand a tab.

/** The icon both HTML documents ship. apply-favicon.test.ts keeps them in step. */
export const STOCK_FAVICON = "/app-icon.png";

/** The `<link rel="icon">` in the document head, created if a document has none. */
function iconLink(): HTMLLinkElement {
  const existing = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.appendChild(link);
  return link;
}

export function applyFavicon(appLogo: string | null | undefined): void {
  const link = iconLink();
  const href = appLogo || STOCK_FAVICON;
  // Called on every state broadcast. Re-assigning an identical href is not free:
  // some browsers refetch and repaint the tab icon for it.
  if (link.getAttribute("href") === href) return;
  // The HTML declares image/png, which is right for the stock icon and for the
  // cropper's output, but a logo set through the API may be another format, and a
  // declared type that disagrees with the bytes makes a browser skip the icon.
  // Dropping it lets the browser read the response.
  if (appLogo) link.removeAttribute("type");
  else link.setAttribute("type", "image/png");
  link.setAttribute("href", href);
}
