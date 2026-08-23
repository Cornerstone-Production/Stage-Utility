// media-thumb.tsx — one media item, small.
//
// Written out three times before this: in the library grid, in the picker and in
// a playlist's item rows. Two of them carried `#t=0.1` with a comment explaining
// that a video element shows nothing until it has decoded a frame, and the third
// did not — so every clip in a playlist's item list rendered as a black
// rectangle. That is the drift this repo's rules are about: the same shape in
// three places, and the copy that matters least is the one that goes wrong
// quietly.

import { isSignageVideo } from "@main/types/signage";

import { cn } from "../../lib/cn";

/** The url a stored file is served from. */
export function mediaUrl(file: string): string {
  return `/signage-media/${file}`;
}

export function MediaThumb({
  media,
  className,
  fit = "contain",
}: {
  media: { file: string; mime: string; name?: string };
  className?: string;
  fit?: "contain" | "cover";
}) {
  const cls = cn("size-full", fit === "cover" ? "object-cover" : "object-contain", className);

  if (isSignageVideo(media.mime)) {
    return (
      <video
        // `#t=0.1` is the whole point: a video element renders nothing until it
        // has decoded a frame, and with no fragment it decodes none until it is
        // played. Seeking a tenth of a second in gives it one to show.
        src={`${mediaUrl(media.file)}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        className={cls}
      />
    );
  }
  return <img src={mediaUrl(media.file)} alt={media.name ?? ""} className={cls} loading="lazy" />;
}
