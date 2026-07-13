// Applies the themeable brand accent (from Branding → Accent color) to the
// root as `--brand-accent`. The whole accent ramp (hover/active/focus, both
// themes) derives from this via color-mix in styles.css, so setting one var
// re-themes the app. Null/invalid → remove the override → the CSS default wins.
export function applyAccentVar(accentColor: string | null | undefined): void {
  const el = document.documentElement;
  if (accentColor && /^#[0-9a-fA-F]{6}$/.test(accentColor)) {
    el.style.setProperty("--brand-accent", accentColor);
  } else {
    el.style.removeProperty("--brand-accent");
  }
}
