// osc-codec.ts — Open Sound Control 1.0 wire format (encode + decode).
//
// OSC is a compact binary format: an address pattern, a type-tag string, then
// the arguments, each section padded to a 4-byte boundary. We encode the common
// argument types (int32 `i`, float32 `f`, string `s`, booleans `T`/`F`) and
// decode those plus a few more we might receive back from gear (float64 `d`,
// int64 `h`, null `N`, impulse `I`, blob `b`). Bundles (`#bundle`) are unpacked
// recursively. Pure functions — no sockets — so they're trivially unit-testable.

import type { OscArg } from "../types/osc.js";

/** A decoded OSC message: address + primitive argument values. */
export interface OscMessage {
  address: string;
  args: (number | string | boolean | null)[];
}

function padLen(len: number): number {
  return (4 - (len % 4)) % 4;
}

/** Encode an OSC-string: UTF-8 bytes + at least one NUL, padded to 4 bytes. */
function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, "utf8");
  const total = raw.length + 1 + padLen(raw.length + 1);
  const out = Buffer.alloc(total); // alloc zero-fills → NUL terminator + padding
  raw.copy(out, 0);
  return out;
}

/** Encode one OSC message to a Buffer ready to send over UDP. */
export function encodeMessage(address: string, args: OscArg[] = []): Buffer {
  let tags = ",";
  const argBufs: Buffer[] = [];
  for (const arg of args) {
    switch (arg.type) {
      case "i": {
        tags += "i";
        const b = Buffer.alloc(4);
        b.writeInt32BE(Number(arg.value) | 0, 0); // `| 0` coerces to a signed int32
        argBufs.push(b);
        break;
      }
      case "f": {
        tags += "f";
        const b = Buffer.alloc(4);
        b.writeFloatBE(Number(arg.value) || 0, 0);
        argBufs.push(b);
        break;
      }
      case "s": {
        tags += "s";
        argBufs.push(encodeString(String(arg.value ?? "")));
        break;
      }
      case "T":
        tags += "T";
        break;
      case "F":
        tags += "F";
        break;
    }
  }
  return Buffer.concat([encodeString(address), encodeString(tags), ...argBufs]);
}

/** Read an OSC-string starting at `off`; returns the value + next offset. */
function readString(buf: Buffer, off: number): { value: string; next: number } {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.toString("utf8", off, end);
  // Advance past the NUL and the 4-byte alignment padding.
  const consumed = end - off + 1;
  return { value, next: off + consumed + padLen(consumed) };
}

const BUNDLE_PREFIX = Buffer.from("#bundle\0", "ascii");

/**
 * Decode an OSC packet (a single message OR a #bundle) into a flat list of
 * messages. Malformed input yields an empty list rather than throwing.
 */
export function decodePacket(buf: Buffer): OscMessage[] {
  try {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(BUNDLE_PREFIX)) {
      const out: OscMessage[] = [];
      let p = 16; // skip "#bundle\0" (8) + timetag (8)
      while (p + 4 <= buf.length) {
        const size = buf.readInt32BE(p);
        p += 4;
        if (size <= 0 || p + size > buf.length) break;
        out.push(...decodePacket(buf.subarray(p, p + size)));
        p += size;
      }
      return out;
    }
    return [decodeMessage(buf)].filter((m): m is OscMessage => m !== null);
  } catch {
    return [];
  }
}

function decodeMessage(buf: Buffer): OscMessage | null {
  const addr = readString(buf, 0);
  if (!addr.value.startsWith("/")) return null;
  const tagsRead = readString(buf, addr.next);
  if (!tagsRead.value.startsWith(",")) return { address: addr.value, args: [] };
  const tags = tagsRead.value.slice(1);
  let p = tagsRead.next;
  const args: (number | string | boolean | null)[] = [];
  for (const tag of tags) {
    switch (tag) {
      case "i":
        args.push(buf.readInt32BE(p));
        p += 4;
        break;
      case "f":
        args.push(buf.readFloatBE(p));
        p += 4;
        break;
      case "d":
        args.push(buf.readDoubleBE(p));
        p += 8;
        break;
      case "h":
        args.push(Number(buf.readBigInt64BE(p)));
        p += 8;
        break;
      case "s":
      case "S": {
        const r = readString(buf, p);
        args.push(r.value);
        p = r.next;
        break;
      }
      case "b": {
        const size = buf.readInt32BE(p);
        p += 4 + size + padLen(size);
        args.push(null); // blob contents not surfaced
        break;
      }
      case "T":
        args.push(true);
        break;
      case "F":
        args.push(false);
        break;
      case "N":
        args.push(null);
        break;
      case "I":
        args.push(true); // impulse/bang → treat as truthy
        break;
      default:
        // Unknown tag — stop parsing args to avoid misalignment.
        return { address: addr.value, args };
    }
  }
  return { address: addr.value, args };
}
