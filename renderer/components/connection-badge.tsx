// connection-badge.tsx — "is this thing talking to us", said the same way everywhere.
//
// One component, used by the integration tile, the integration dialog header,
// each ProPresenter instance row and each wireless receiver row. It was a local
// function inside integrations-panel.tsx while two of those four call sites
// lived in other files.
//
// THE MESSAGE IS NOT ONLY FOR ERRORS. This rendered `message` in the error state
// and nowhere else, so everything a row had to say while it was UP was written
// to a field nothing displayed. RossTalk appends " — simulate mode" to its
// connected message precisely because "a connected badge would otherwise imply
// commands are reaching the device when they are being swallowed" — and the
// suffix reached no screen at all. Companion's connection health had the same
// shape and needed a whole panel of its own to be seen.
//
// So a non-error message renders beside the state word, muted and truncated,
// with the full text on hover. Muted and beside, not instead of: "Disconnected"
// with "3 target(s)" after it says two things, where "3 target(s)" alone loses
// the one the colour is there to carry. The error state is unchanged — its
// message replaces the word, because "Error" on its own is not actionable.
//
// Truncation and the tooltip are CSS and hover, neither of which jsdom has, so
// connection-badge.test.tsx asserts the text is PRESENT and the widths were
// checked in a browser instead. See the note at the top of that file.

import { Tooltip } from "./ui/tooltip";
import { Status } from "./ui";
import { Loader2Icon, CheckCircle2Icon, XCircleIcon } from "lucide-react";
import { cn } from "../lib/cn";

export function ConnectionBadge({
  connection,
  message,
  inbound,
}: {
  connection: ConnectionState;
  message?: string | null;
  /** Nothing dials out, so "disconnected" would name a fault where there is
   *  only an empty room. A listener with no client yet is waiting, not down. */
  inbound?: boolean;
}) {
  // A message of spaces is not a message. Trimmed here rather than at each call
  // site, because four of them forward whatever the server last wrote.
  const text = message?.trim() || null;
  // In the error state the message IS the word — see the header.
  const detail = connection === "error" ? null : text;

  const face =
    connection === "connected"
      ? {
          icon: <CheckCircle2Icon className="size-3.5 text-green-10 shrink-0" />,
          word: "Connected",
          tone: "text-green-10",
        }
      : connection === "connecting"
        ? {
            icon: <Loader2Icon className="size-3.5 text-accent animate-spin shrink-0" />,
            word: "Connecting…",
            tone: "text-accent",
          }
        : connection === "error"
          ? {
              icon: <XCircleIcon className="size-3.5 text-red-10 shrink-0" />,
              word: text ?? "Error",
              tone: "text-red-10",
            }
          : {
              icon: <Status variant={inbound ? "neutral" : "warning"} />,
              word: inbound ? "No clients yet" : "Disconnected",
              tone: "text-fg-muted",
            };

  const full = detail ? `${face.word} — ${detail}` : face.word;
  // Only when something can actually be cut off. A tooltip that repeats the two
  // words already on screen is a floating box on every hover over every tile.
  const tooltip = connection === "error" || detail ? full : null;

  return (
    <Tooltip label={tooltip}>
      <span className="flex items-center gap-1 min-w-0 max-w-[9rem] sm:max-w-md" aria-label={full}>
        {face.icon}
        {/* The state word never truncates — it is two words and it is the part
            that must always be legible. The error message is the exception,
            because there it IS the word and can be a paragraph of ECONNREFUSED. */}
        <span
          className={cn(
            "text-caption1",
            face.tone,
            connection === "error" ? "truncate min-w-0" : "shrink-0",
          )}
        >
          {face.word}
        </span>
        {detail && <span className="text-caption1 text-fg-muted truncate min-w-0">{detail}</span>}
      </span>
    </Tooltip>
  );
}
