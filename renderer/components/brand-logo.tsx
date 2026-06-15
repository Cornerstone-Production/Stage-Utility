import type { CSSProperties } from "react";

interface BrandLogoProps {
  /** Logo data URL, or null. */
  logo: string | null;
  /** When true, recolor the (single-color) logo to the current text color. */
  monochrome: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Renders the brand logo. When `monochrome` is set, the logo is drawn as a CSS
 * mask filled with `currentColor`, so a single-color logo adapts to the theme
 * (it inherits the surrounding text color — e.g. `text-gray-12` flips
 * black↔white between light/dark; the kiosk uses its gray). When off, the
 * logo is shown exactly as uploaded (preserving full-color artwork).
 */
export function BrandLogo({ logo, monochrome, className, style }: BrandLogoProps) {
  if (!logo) return null;

  if (monochrome) {
    return (
      <span
        aria-hidden="true"
        className={className}
        style={{
          ...style,
          display: "inline-block",
          backgroundColor: "currentColor",
          WebkitMaskImage: `url("${logo}")`,
          maskImage: `url("${logo}")`,
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskSize: "contain",
          maskSize: "contain",
        }}
      />
    );
  }

  return <img src={logo} alt="" className={className} style={{ objectFit: "contain", ...style }} />;
}
