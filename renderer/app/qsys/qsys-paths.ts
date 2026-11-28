// Where Q-SYS panels live. One spelling of each path, imported by the route table,
// the shell's matchers and the pages, so none of them can drift from the others.
//
//   /qsys/<slug>          the panel full screen, no app chrome: what an iPad opens
//   /qsys/manage          every panel, the connection, the allowlist, the binding check
//   /qsys/manage/<slug>   a panel inside the shell, with in-place Edit
//
// No imports: active-page.ts imports this, and the route table imports both.

export const QSYS_MANAGE_PATH = "/qsys/manage";

/** The chrome-free panel. */
export function qsysPanelPath(slug: string): string {
  return `/qsys/${slug}`;
}

/** The panel inside the shell. */
export function qsysManagePanelPath(slug: string): string {
  return `${QSYS_MANAGE_PATH}/${slug}`;
}

/** The slug of a chrome-free panel path (`/qsys/<slug>`, one trailing slash forgiven), or null. */
export function qsysPanelSlugOf(pathname: string): string | null {
  const m = /^\/qsys\/([^/]+)\/?$/.exec(pathname);
  return m && m[1] !== "manage" ? m[1] : null;
}

/** The slug of a panel in the shell (`/qsys/manage/<slug>`), or null. */
export function qsysManagedSlugOf(pathname: string): string | null {
  const m = /^\/qsys\/manage\/([^/]+)\/?$/.exec(pathname);
  return m ? m[1] : null;
}
