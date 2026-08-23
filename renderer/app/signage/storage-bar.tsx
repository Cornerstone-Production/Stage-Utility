// storage-bar.tsx — what is on the disk, and how much is left.
//
// Signage is the only part of this app that can fill a disk. Everything else
// writes JSON measured in kilobytes; a media library is video measured in
// hundreds of megabytes, on a Pi with a 32 GB card — and when that card fills,
// what stops working is not just uploading. The server cannot write the stores
// that hold the schedules either.
//
// So this is not decoration. It is the warning an operator gets before they are
// three files from that, and it says the number rather than only drawing it: a
// bar shows proportion, and "how much room is left" is a quantity.

import { useQuery } from "@tanstack/react-query";

import { invoke } from "../../lib/api";
import { size } from "./format";

interface Storage {
  images: number;
  video: number;
  other: number;
  free: number;
  total: number;
  orphanBytes: number;
}

/** Matches the server's thresholds — see signage-storage. */
const LOW = 2 * 1024 * 1024 * 1024;
const CRITICAL = 512 * 1024 * 1024;

const SEGMENTS = [
  { key: "images", label: "Graphics", className: "bg-accent" },
  { key: "video", label: "Video", className: "bg-live-9" },
  { key: "orphanBytes", label: "Waiting to be cleared", className: "bg-amber-9" },
  { key: "other", label: "Everything else", className: "bg-fill-active" },
] as const;

export function StorageBar() {
  const { data } = useQuery({
    queryKey: ["signage:storage"],
    queryFn: () => invoke<Storage>("signage:storage"),
    // A minute. Reading it is a statfs and a directory walk, and nobody is
    // watching a disk fill in real time.
    refetchInterval: 60_000,
  });

  if (!data || data.total <= 0) return null;

  const pressure = data.free <= CRITICAL ? "critical" : data.free <= LOW ? "low" : "ok";
  const used = data.total - data.free;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-footnote font-medium text-fg">Storage</span>
        <span
          className={
            pressure === "critical"
              ? "text-caption1 font-medium text-red-11"
              : pressure === "low"
                ? "text-caption1 font-medium text-amber-11"
                : "text-caption1 text-fg-subtle"
          }
        >
          {size(used)} of {size(data.total)} used · {size(data.free)} free
        </span>
      </div>

      {/* One track, segments in order. `flex` with proportional grow rather than
          percentage widths, so rounding cannot leave a hairline gap between two
          segments that are meant to touch. */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-fill">
        {SEGMENTS.map((seg) => {
          const bytes = data[seg.key];
          if (bytes <= 0) return null;
          return (
            <span
              key={seg.key}
              className={seg.className}
              style={{ flexGrow: bytes, flexBasis: 0 }}
              // A segment too thin to see still has to be reachable by pointer
              // and by a screen reader.
              title={`${seg.label} — ${size(bytes)}`}
              aria-label={`${seg.label}: ${size(bytes)}`}
            />
          );
        })}
        <span style={{ flexGrow: Math.max(0, data.free), flexBasis: 0 }} aria-label={`Free: ${size(data.free)}`} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {SEGMENTS.filter((s) => data[s.key] > 0).map((seg) => (
          <span key={seg.key} className="flex items-center gap-1.5 text-caption2 text-fg-subtle">
            <span className={`size-2 shrink-0 rounded-full ${seg.className}`} />
            {seg.label}
            <span className="text-fg-faint">{size(data[seg.key])}</span>
          </span>
        ))}
      </div>

      {pressure !== "ok" ? (
        <p
          className={
            pressure === "critical"
              ? "text-caption2 text-red-11"
              : "text-caption2 text-amber-11"
          }
        >
          {pressure === "critical"
            ? "Almost full. Uploads will start failing, and the server may not be able to save settings either."
            : "Getting full. Delete some video, or a large upload may not fit."}
        </p>
      ) : null}
    </div>
  );
}
