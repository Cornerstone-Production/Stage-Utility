// Applies the themeable brand accent (from Branding → Accent color) to the
// root as `--brand-accent`. The whole accent ramp (hover/active/focus, both
// themes) derives from this via color-mix in styles.css, so setting one var
// re-themes the app. Null/invalid → remove the override → the CSS default wins.
//
// `--brand-accent-set` carries the SAME value and exists only to be absent: the
// CSS default for --brand-accent differs by theme, and a kiosk surface embedded
// in the light app needs to know whether the operator picked a colour (use it,
// as the real kiosk does) or not (use the dark default, as the real kiosk does).
// A custom property cannot tell an inline value from a default, so this says so.
export function applyAccentVar(accentColor: string | null | undefined): void {
  const el = document.documentElement;
  if (accentColor && /^#[0-9a-fA-F]{6}$/.test(accentColor)) {
    el.style.setProperty("--brand-accent", accentColor);
    el.style.setProperty("--brand-accent-set", accentColor);
  } else {
    el.style.removeProperty("--brand-accent");
    el.style.removeProperty("--brand-accent-set");
  }
}
