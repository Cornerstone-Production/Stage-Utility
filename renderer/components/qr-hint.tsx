import { useEffect, useRef } from "react";
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !url) return;
    QRCode.toCanvas(canvas, url, {
      width: backing,
      margin: 1,
      color: {
        dark: "#ffffff",
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
  }, [url, backing, display]);

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

  // Solid dark backdrop (theme-independent) so the white QR modules stay
  // high-contrast and scannable even on the light Settings window.
  return (
    <div className="inline-flex flex-col items-center gap-1.5 p-3 bg-[#18181b] rounded-xl">
      <canvas ref={canvasRef} width={backing} height={backing} className="rounded" />
      <span
        className="text-caption1 text-white/80 tabular-nums text-center leading-tight"
        style={{ maxWidth: 140, wordBreak: "break-all" }}
      >
        {url}
      </span>
    </div>
  );
}
