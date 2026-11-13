// mono.tsx — every numeral in IBM Plex Mono, within running text.

/** `text` with each run of digits (and the separators inside one, "2400 × 1600"
 *  aside) set in Plex Mono. */
export function Mono({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\d+(?:[.,]\d+)*)/).map((part, i) =>
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
