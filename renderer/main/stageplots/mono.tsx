// mono.tsx — every numeral in IBM Plex Mono, within running text and within
// the text an SVG plot draws.

const DIGITS = /(\d+(?:[.,]\d+)*)/;

/** `text` with each run of digits (and the separators inside one, "2400 × 1600"
 *  aside) set in Plex Mono. */
export function Mono({ text }: { text: string }) {
  return (
    <>
      {text.split(DIGITS).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-mono tabular-nums">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** The same for SVG <text>: each run of digits a Plex Mono <tspan>. */
export function MonoTspans({ text }: { text: string }) {
  return (
    <>
      {text.split(DIGITS).map((part, i) =>
        i % 2 === 1 ? (
          <tspan key={i} className="font-mono">
            {part}
          </tspan>
        ) : (
          part
        ),
      )}
    </>
  );
}
