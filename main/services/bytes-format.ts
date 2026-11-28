// bytes-format.ts — a byte count as "412 KB" / "3.1 MB".
//
// Binary (1 MB = 1024 * 1024), because every limit in the app is written that
// way ("12 * 1024 * 1024" is the 12 MB image cap) and the label has to agree
// with the cap it is quoted beside. Written out nine times before, some decimal
// and some binary. Importable from the renderer too, like clamp.ts.

export interface BytesOptions {
  /** Whole megabytes ("64 MB") for a limit, not "64.0 MB". */
  whole?: boolean;
  /** 1 MB = 1,000,000 bytes, for a size a vendor publishes that way and the
   *  page quotes back to the operator (the relay download in mediamtx-pin.ts). */
  decimal?: boolean;
}

export function formatBytes(bytes: number, opts: BytesOptions = {}): string {
  const kb = opts.decimal ? 1000 : 1024;
  const mb = kb * kb;
  if (bytes < mb) return `${bytes > 0 ? Math.max(1, Math.round(bytes / kb)) : 0} KB`;
  return opts.whole ? `${Math.round(bytes / mb)} MB` : `${(bytes / mb).toFixed(1)} MB`;
}
