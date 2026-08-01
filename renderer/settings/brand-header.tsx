import { useLayoutEffect, useRef, useState } from "react";
import { BrandLogo } from "../components/brand-logo";

// The name sits on a SINGLE line next to a compact logo (matches the mockup).
// It shrinks by width only (never wraps), down to a floor, so long church names
// stay on one line and truncate rather than stacking.
const LOGO_PX = 28;
const MAX_FONT = 16;
const MIN_FONT = 11;

export function BrandHeader({
  name,
  logo,
  monochrome,
}: {
  name: string;
  logo: string | null;
  monochrome: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(MAX_FONT);

  // Shrink the font until the (wrapped) name fits within the logo's height.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const el = textRef.current;
    if (!box || !el) return;

    const fit = () => {
      let size = MAX_FONT;
      el.style.fontSize = `${size}px`;
      // Single line: shrink by WIDTH only until it fits, then truncate at the floor.
      while (size > MIN_FONT && el.scrollWidth > box.clientWidth) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
      setFontSize(size);
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [name]);

  return (
    <div className="flex items-center gap-2.5 px-3 py-3">
      {logo ? (
        <BrandLogo
          logo={logo}
          monochrome={monochrome}
          className="rounded-md shrink-0 text-fg"
          style={{ width: LOGO_PX, height: LOGO_PX }}
        />
      ) : (
        <div className="rounded-md bg-accent shrink-0" style={{ width: LOGO_PX, height: LOGO_PX }} />
      )}
      <div ref={boxRef} className="min-w-0 flex-1 overflow-hidden">
        <span
          ref={textRef}
          className="block font-title font-semibold text-fg whitespace-nowrap truncate"
          style={{ fontSize, lineHeight: 1.15, letterSpacing: "-0.01em" }}
        >
          {name}
        </span>
      </div>
    </div>
  );
}
