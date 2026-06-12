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
    return (
      // Liquid Glass pill — static height so backdrop-blur is safe (no height animation)
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded-full"
        style={{
          background: "rgba(255,255,255,0.08)",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.09)",
          backdropFilter: "blur(10px)",
        }}
      >
        <canvas ref={canvasRef} width={size} height={size} className="rounded shrink-0" />
        <span
          className="text-caption2 text-white/50 tabular-nums leading-tight"
          style={{ maxWidth: 110, wordBreak: "break-all" }}
        >
          {url}
        </span>
      </div>
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
