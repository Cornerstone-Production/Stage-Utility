// main/services/video/ffmpeg-path-store.ts — where ffmpeg is, when the operator
// says so. "" means find it automatically.
//
// Runtime, not config: the path names a file on THIS machine, so a backup
// restored onto another server must never carry it there. It is a program the
// server will run; it has to be chosen on the box it runs on.

import { DataStore } from "../data-store.js";

export interface FfmpegPathFile {
  path: string;
}

export const ffmpegPathStore = new DataStore<FfmpegPathFile>("video-ffmpeg.json", { path: "" }, "runtime");

/** The saved path, "" when none is set or the file holds anything else. */
export async function loadFfmpegPath(): Promise<string> {
  const raw = (await ffmpegPathStore.load()) as Partial<FfmpegPathFile> | null;
  return typeof raw?.path === "string" ? raw.path : "";
}
