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
    if (!canvasRef.current || !url) return;
    QRCode.toCanvas(canvasRef.current, url, {
      width: size,
      margin: 1,
      color: {
        dark: "#ffffff",
        light: "#00000000",
      },
    }).catch((err: unknown) => {
      console.error("[QrHint] QR generation error", err);
    });
  }, [url, size]);

  if (!url) return null;

  if (compact) {
    // Bare QR (no pill/circle) on the kiosk top bar — matches the plain text.
    return <canvas ref={canvasRef} width={size} height={size} className="rounded shrink-0 select-none" />;
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
