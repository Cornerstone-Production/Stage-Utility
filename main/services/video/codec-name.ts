// main/services/video/codec-name.ts — MediaMTX spells codecs "MPEG-4 Audio", "M-JPEG",
// "Opus"; every comparison here drops everything but letters and digits so a
// spelling change ("MJPEG") still counts.

export function normalizeCodecName(codec: string): string {
  return codec.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
