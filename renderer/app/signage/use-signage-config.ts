// use-signage-config.ts — the Signage tab's read/write access to the four stores.
//
// One hook rather than four, because every section needs more than its own
// store: the schedule list shows playlist and group names, the groups section
// picks a default playlist, and the media grid wants to know what uses a file.

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  SignageGroup,
  SignageMedia,
  SignagePlaylist,
  SignageSchedule,
} from "@main/types/signage";

import { errorMessage } from "@main/services/errors";
import { invoke } from "../../lib/api";
import { uploadHeadersFor } from "./upload-headers";

export interface SignageConfig {
  media: SignageMedia[];
  playlists: SignagePlaylist[];
  groups: SignageGroup[];
  schedules: SignageSchedule[];
}

/** One key, four requests. The sections are read together — the schedule list
 *  needs playlist and group names — so caching them apart would only mean four
 *  ways to be half-stale. */
export const SIGNAGE_CONFIG_KEY = ["signage:config"] as const;

const EMPTY: SignageConfig = { media: [], playlists: [], groups: [], schedules: [] };

async function fetchSignageConfig(): Promise<SignageConfig> {
  const [media, playlists, groups, schedules] = await Promise.all([
    invoke<{ media: SignageMedia[] }>("signage:listMedia"),
    invoke<{ playlists: SignagePlaylist[] }>("signage:listPlaylists"),
    invoke<{ groups: SignageGroup[] }>("signage:listGroups"),
    invoke<{ schedules: SignageSchedule[] }>("signage:listSchedules"),
  ]);
  return {
    media: media.media,
    playlists: playlists.playlists,
    groups: groups.groups,
    schedules: schedules.schedules,
  };
}

export function useSignageConfig(): {
  config: SignageConfig;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const client = useQueryClient();
  const q = useQuery({ queryKey: SIGNAGE_CONFIG_KEY, queryFn: fetchSignageConfig });

  const reload = useCallback(async () => {
    await client.invalidateQueries({ queryKey: SIGNAGE_CONFIG_KEY });
  }, [client]);

  return {
    config: q.data ?? EMPTY,
    loading: q.isLoading,
    // Surfaced, never swallowed: every section renders empty on a failure, and
    // an empty media library that is actually a failed fetch looks exactly like
    // an empty media library.
    error: q.error ? errorMessage(q.error) : null,
    reload,
  };
}

/**
 * Read a file's intrinsic size, and a video's length, in the browser.
 *
 * REJECTS rather than resolving defaults. The server range-checks these and will
 * refuse anything it cannot use, so inventing a value here would only move the
 * failure somewhere less informative.
 */
export function measureFile(file: File): Promise<{ w: number; h: number; durationMs?: number }> {
  const url = URL.createObjectURL(file);
  const done = <T,>(v: T) => {
    URL.revokeObjectURL(url);
    return v;
  };

  if (file.type.startsWith("video/")) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.onloadedmetadata = () => {
        const durationMs = Math.round(v.duration * 1000);
        // A live stream or a broken container reports Infinity or NaN. Both
        // would become an item that never advances.
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
          reject(done(new Error(`could not read the duration of ${file.name}`)));
          return;
        }
        resolve(done({ w: v.videoWidth, h: v.videoHeight, durationMs }));
      };
      v.onerror = () => reject(done(new Error(`could not read ${file.name}`)));
      v.src = url;
    });
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(done({ w: img.naturalWidth, h: img.naturalHeight }));
    img.onerror = () => reject(done(new Error(`could not read ${file.name}`)));
    img.src = url;
  });
}

/**
 * Upload one file.
 *
 * Deliberately raw `fetch` rather than the shared api helper: that one forces
 * `Content-Type: application/json`, and here the content type IS the file's and
 * the body IS the bytes.
 */
export async function uploadMedia(
  file: File,
  signal?: AbortSignal,
): Promise<{ media: SignageMedia; deduped: boolean }> {
  const measured = await measureFile(file);
  const headers = uploadHeadersFor({ name: file.name, mime: file.type, ...measured });

  const res = await fetch("/api/signage/media", {
    method: "POST",
    headers,
    body: file,
    signal,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body?.error === "string") msg = body.error;
    } catch {
      /* keep the status text */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { media: SignageMedia; deduped: boolean };
}
