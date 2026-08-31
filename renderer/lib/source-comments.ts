// source-comments.ts — blank the comments out of TypeScript source, for the
// guards that read source text.
//
// Several tests here assert on the SOURCE of a component or a handler, because
// what has to hold is the order of two writes or the absence of a colour token,
// and neither survives being mocked apart from the hook it lives in. Every one
// of those assertions has the same failure mode: a comment saying the thing the
// scan is looking for satisfies it. CLAUDE.md lists that twice among the guards
// in this repo that passed on the exact defect they were written for, and both
// renderer scans had it — one stripped comments in a single assertion out of
// four, the other never stripped `//` at all.
//
// Blanked rather than deleted, and character for character: line numbers,
// offsets and the boundaries a caller cut on all stay where they were.
//
// A scanner, not a regex. Stripping with a regex is how a scan in this repo
// swallowed real code and hid a route that exists: `//` inside a string —
// `"https://…"`, a `--color` token in a URL — is not a comment, and a regex that
// cannot tell the difference eats the rest of the line.

/**
 * `src` with every `//` and every `/* … *\/` replaced by spaces, leaving
 * newlines and every other character in place.
 *
 * Strings, template literals and `${…}` are respected, so a `//` inside one
 * survives. Division and regex literals are not distinguished — a lone `/` is
 * simply not the start of a comment, and only `//` or `/*` begins one, which no
 * division expression produces.
 */
export function withoutComments(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  // The literal we are inside, or "" in code. Template `${…}` pushes back to
  // code and its closing `}` pops, so a nested template is handled.
  const stack: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      if (c === "\\") i++;
      else if (c === top || c === "\n") stack.pop();
      continue;
    }
    if (top === "`") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && src[i + 1] === "{") {
        stack.push("${");
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      stack.push(c);
      continue;
    }
    if (c === "}" && top === "${") {
      stack.pop();
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end - 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop - 1;
      continue;
    }
  }
  return out.join("");
}
