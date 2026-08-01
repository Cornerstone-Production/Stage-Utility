import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

interface QrHintProps {
  url: string;
  /** compact=true renders a smaller QR for the top bar (no URL text) */
  compact?: boolean;
  /** Override the on-screen size with any CSS length (e.g. a responsive clamp()).
   *  The backing bitmap is generated larger so it stays crisp when scaled up. */
  sizeCss?: string;
}

export function QrHint({ url, compact = false, sizeCss }: QrHintProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Generate at a generous backing resolution so the QR stays sharp even when the
  // top bar scales it up on a 4K panel; the on-screen size is set via CSS below.
  const backing = compact ? 160 : 132;
  const display = sizeCss ?? `${compact ? 28 : 132}px`;

  // The non-compact QR lives in Settings (light or dark) with no backdrop box, so
  // its modules must follow the theme foreground. Re-tint when the .dark class on
  // the root toggles. The compact kiosk QR is always white on its dark bar.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    if (compact) return;
    const obs = new MutationObserver(() => setThemeTick((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, [compact]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !url) return;
    const moduleColor = compact
      ? "#ffffff"
      : getComputedStyle(document.documentElement).getPropertyValue("--su-fg").trim() || "#ededf0";
    QRCode.toCanvas(canvas, url, {
      width: backing,
      margin: 1,
      color: {
        dark: moduleColor,
        light: "#00000000",
      },
    })
      .then(() => {
        // qrcode sets the canvas's intrinsic size AND inline style to the actual
        // module pixel size, which for a long URL (e.g. a DNS public address)
        // exceeds the target and overflows the layout. Pin the *display* size back
        // (the larger backing store just downscales crisply).
        canvas.style.width = display;
        canvas.style.height = display;
      })
      .catch((err: unknown) => {
        console.error("[QrHint] QR generation error", err);
      });
  }, [url, backing, display, compact, themeTick]);

  if (!url) return null;

  if (compact) {
    // Bare QR (no pill/circle) on the kiosk top bar — matches the plain text.
    // The CSS width/height cap the *display* size: for a long URL (e.g. a DNS
    // public address) qrcode needs more modules than fit at the requested px and
    // renders the canvas larger, overwriting the width attr — without this cap it
    // overflows the top bar.
    return (
      <canvas
        ref={canvasRef}
        width={backing}
        height={backing}
        style={{ width: display, height: display }}
        className="rounded shrink-0 select-none"
      />
    );
  }

  // No backdrop box: the modules are tinted with the theme foreground (near-black
  // on light, near-white on dark) so the QR reads on either theme. No caption —
  // the one place this variant is used already shows the address beside it.
  return <canvas ref={canvasRef} width={backing} height={backing} className="rounded" />;
}
