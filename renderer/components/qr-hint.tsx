import { useEffect, useRef } from "react";
import QRCode from "qrcode";

interface QrHintProps {
  url: string;
  /** compact=true renders a smaller QR for the top bar (no URL text) */
  compact?: boolean;
}

export function QrHint({ url, compact = false }: QrHintProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = compact ? 28 : 132;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !url) return;
    QRCode.toCanvas(canvas, url, {
      width: size,
      margin: 1,
      color: {
        dark: "#ffffff",
        light: "#00000000",
      },
    })
      .then(() => {
        // qrcode sets the canvas's intrinsic size AND inline style to the actual
        // module pixel size, which for a long URL (e.g. a DNS public address)
        // exceeds `size` and overflows the layout. Pin the *display* size back to
        // `size` after render (the larger backing store just downscales crisply).
        canvas.style.width = `${size}px`;
        canvas.style.height = `${size}px`;
      })
      .catch((err: unknown) => {
        console.error("[QrHint] QR generation error", err);
      });
  }, [url, size]);

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
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="rounded shrink-0 select-none"
      />
    );
  }

  // Solid dark backdrop (theme-independent) so the white QR modules stay
  // high-contrast and scannable even on the light Settings window.
  return (
    <div className="inline-flex flex-col items-center gap-1.5 p-3 bg-[#18181b] rounded-xl">
      <canvas ref={canvasRef} width={size} height={size} className="rounded" />
      <span
        className="text-caption1 text-white/80 tabular-nums text-center leading-tight"
        style={{ maxWidth: size + 8, wordBreak: "break-all" }}
      >
        {url}
      </span>
    </div>
  );
}
