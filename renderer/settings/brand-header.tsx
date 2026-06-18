import { useLayoutEffect, useRef, useState } from "react";
import { BrandLogo } from "../components/brand-logo";

// The logo is the anchor; the name is fit to its height so the two feel
// balanced — large for short names, shrinking as the name gets longer.
const LOGO_PX = 44;
const MAX_FONT = 20;
const MIN_FONT = 10;

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
      // Shrink until the name fits the box BOTH ways: height (so it doesn't clip)
      // and width (so the longest word — e.g. "Cornerstone" — fits on its own line
      // and wraps at the space instead of breaking mid-word).
      while (size > MIN_FONT && (el.scrollHeight > box.clientHeight || el.scrollWidth > box.clientWidth)) {
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
    <div className="flex items-center gap-2.5 px-3.5 py-3">
      {logo ? (
        <BrandLogo
          logo={logo}
          monochrome={monochrome}
          className="rounded-md shrink-0 text-gray-12"
          style={{ width: LOGO_PX, height: LOGO_PX }}
        />
      ) : (
        <div className="rounded-md bg-blue-9 shrink-0" style={{ width: LOGO_PX, height: LOGO_PX }} />
      )}
      <div
        ref={boxRef}
        className="flex flex-col justify-center overflow-hidden min-w-0 flex-1"
        style={{ height: LOGO_PX }}
      >
        <span
          ref={textRef}
          className="block font-title text-gray-12 [overflow-wrap:normal] [word-break:normal] hyphens-none"
          style={{ fontSize, lineHeight: 1.1 }}
        >
          {name}
        </span>
      </div>
    </div>
  );
}
