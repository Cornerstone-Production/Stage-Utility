// console-scan.ts — read console calls out of TypeScript source, for the guards
// that hold log sites to scrub().
//
// It lives here, once, because the same scan was written twice — in
// log-injection.test.ts and in pco-link-safety.test.ts — and the two copies
// immediately drifted. The sibling gained block capture and an argument rule and
// the original kept neither, which is how a scan over a file with 22 unscrubbed
// interpolations reported zero. That is the repeated-pattern drift CLAUDE.md
// calls this repo's most expensive recurring mistake, so there is one copy.
//
// Two things the scan has to survive, both of which broke an earlier version:
//
//   - a call wrapped over several lines. `console.warn(` is on one line and the
//     `${…}` on the next, and a per-LINE scan sees neither as an offender.
//   - a nested template, `${x ? `a` : "b"}`. A scanner that treats the second
//     backtick as the closing one loses the rest of the call.
//
// Deliberately a scanner rather than a parser: it is small enough to read, and
// console-scan.test.ts feeds it the shapes it has to get right.

/**
 * The console methods that reach the operator.
 *
 * log-buffer.ts patches log/info/warn/error, so those four are what `/log`
 * shows. `debug` is included because it still reaches a terminal someone is
 * tailing, and because over-inclusion here can only ever ADD a site to check.
 */
export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

const HEAD = new RegExp(`console\\.(?:${CONSOLE_LEVELS.join("|")})\\s*\\(`, "g");

/** A line that is only prose. Not a wholesale comment strip — stripping is how a
 *  scan in this repo once swallowed real code and hid a route that exists. */
const isComment = (l: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(l);

/**
 * Walk `source` from the `(` at `open` to its matching `)`, and return that
 * index.
 *
 * Tracks strings, templates and `${…}` on one stack, so a template holding
 * another template — or a `)` inside a string — cannot end the call early.
 * Returns `source.length - 1` for an unbalanced call, which over-includes rather
 * than truncating: a scan that sweeps in extra text can only fail loudly, where
 * one that stops early passes silently.
 */
function matchingParen(source: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      if (c === "\\") i++;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === "`") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && source[i + 1] === "{") {
        stack.push("${");
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") stack.push(c);
    else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return source.length - 1;
}

/** One console call as source text, however many lines it spans, with the line
 *  its `console.` starts on. */
export interface ConsoleCall {
  line: number;
  /** From the call's own `(` through its matching `)`, inclusive. */
  text: string;
}

/** Every console call in `source`, whole. */
export function consoleCalls(source: string): ConsoleCall[] {
  const calls: ConsoleCall[] = [];
  let offset = 0;
  source.split("\n").forEach((line, i) => {
    const start = offset;
    offset += line.length + 1;
    if (isComment(line)) return;
    const re = new RegExp(HEAD.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const open = start + m.index + m[0].length - 1;
      calls.push({ line: i + 1, text: source.slice(open, matchingParen(source, open) + 1) });
    }
  });
  return calls;
}

/**
 * The TOP-LEVEL arguments of one captured call, as source text.
 *
 * Split on the commas that are actually separators: not the ones inside a
 * nested call, an array, an object, a quoted string or a template's `${…}`. A
 * splitter that cut on every comma would read `scrub(a, b)` as two arguments and
 * excuse the second for not starting with `scrub(`.
 */
export function consoleArguments(callText: string): string[] {
  const args: string[] = [];
  const stack: string[] = [];
  let current = "";
  for (let i = 1; i < callText.length; i++) {
    const c = callText[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      current += c;
      if (c === "\\") current += callText[++i] ?? "";
      else if (c === top) stack.pop();
      continue;
    }
    if (top === "`") {
      current += c;
      if (c === "\\") current += callText[++i] ?? "";
      else if (c === "`") stack.pop();
      else if (c === "$" && callText[i + 1] === "{") {
        stack.push("${");
        current += callText[++i];
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") stack.push(c);
    else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      if (c === ")" && stack.length === 0) break; // the call's own closing paren
      stack.pop();
    } else if (c === "," && stack.length === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "") args.push(current);
  return args.map((a) => a.trim());
}

/**
 * True when `text` is nothing but string and template literals joined by `+`.
 *
 * The rule this replaces was `/^[`'"]/`, which asked only how the argument
 * STARTS — so `console.error("[pco] failed: " + err)` satisfied it and put a
 * provider's own text, newlines and all, on `/log`. Interpolations inside the
 * literals are a separate rule's problem; this one only asks whether anything
 * that is not a literal has been concatenated in.
 */
export function isLiteralExpression(text: string): boolean {
  const stack: string[] = [];
  let outsideLiterals = "";
  let sawLiteral = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      if (c === "\\") i++;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === "`") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && text[i + 1] === "{") {
        stack.push("${");
        i++;
      }
      continue;
    }
    // Inside a `${…}`, or at the top level: both are code.
    if (c === '"' || c === "'" || c === "`") {
      stack.push(c);
      if (stack.length === 1) sawLiteral = true;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push(c);
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      stack.pop();
      continue;
    }
    if (stack.length === 0) outsideLiterals += c;
  }
  return stack.length === 0 && sawLiteral && /^[\s+]*$/.test(outsideLiterals);
}

/**
 * True when `text` is a scrub() or scrubError() call AND NOTHING ELSE.
 *
 * The rule was `/^scrub(Error)?\(/`, which asks only how the argument STARTS —
 * the same mistake as the `/^[`'"]/` it replaced. `scrub(id) + err` satisfied
 * it, with `err` outside the barrier.
 */
export function isScrubCall(text: string): boolean {
  const head = /^scrub(?:Error)?\s*\(/.exec(text);
  if (!head) return false;
  const open = head[0].length - 1;
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === '"' || top === "'") {
      if (c === "\\") i++;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === "`") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && text[i + 1] === "{") {
        stack.push("${");
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") stack.push(c);
    else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      stack.pop();
      // The scrub call has closed. Anything after it is concatenated on.
      if (stack.length === 0) return text.slice(i + 1).trim() === "";
    }
  }
  return false;
}

/**
 * True when this call hands console a FORMAT STRING it did not write itself.
 *
 * `console.log(fmt, ...rest)` treats `fmt` as a format string: a `%s`, `%d`,
 * `%i`, `%f`, `%j`, `%o`, `%O` or `%c` in it consumes one of the arguments that
 * follow. When outside data is interpolated into `fmt`, the data chooses.
 * "Batteries 100% charged" is a checklist row somebody will type, and
 *
 *   console.error(`[x] row ${scrub(label)} failed:`, scrubError(err))
 *
 * then prints the row and swallows the error — the operator is told that
 * something failed and not told why, and the eaten value can be replayed inside
 * the message.
 *
 * Orthogonal to the other two rules, which are about the VALUE. scrub() cannot
 * help here: `%` is an ordinary character and survives it untouched. This is
 * about the POSITION the value occupies, so the fix is to move it out of the
 * first argument and leave the format string a literal.
 *
 * With no further arguments there is nothing to consume and the shape is
 * harmless, which is why the count is part of the rule.
 */
function formatStringOffender(args: string[]): boolean {
  return args.length > 1 && args[0].includes("${");
}

/** Something in `source` that reaches a log line unsafely. */
export interface LogOffender {
  line: number;
  /** Which of the three rules it broke. */
  kind: "interpolation" | "argument" | "format-string";
  text: string;
}

/**
 * Every value in `source` that reaches console unsafely.
 *
 * Three rules, because a value can go wrong three ways and each of the first two
 * was written here believing it was the whole story:
 *
 *   1. every `${…}` inside a console call contains `scrub(`;
 *   2. every top-level ARGUMENT is a literal expression or a scrub() call —
 *      `console.warn("… status:", status)` was written in this repo with a
 *      comment explaining that rule 1 did not apply to it;
 *   3. no call interpolates into its FORMAT STRING while further arguments
 *      follow — rules 1 and 2 both pass on a perfectly scrubbed value that eats
 *      the error standing next to it.
 *
 * Matched on the interpolation, the argument and the call's shape, never on the
 * word "scrub" appearing in the file, so a comment saying the right thing cannot
 * satisfy any of them.
 */
export function logOffenders(source: string): LogOffender[] {
  const out: LogOffender[] = [];
  for (const call of consoleCalls(source)) {
    for (const m of call.text.matchAll(/\$\{([^}]*)\}/g)) {
      if (!m[1].includes("scrub(")) {
        out.push({ line: call.line, kind: "interpolation", text: m[0].replace(/\s+/g, " ") });
      }
    }
    const args = consoleArguments(call.text);
    for (const argument of args) {
      if (argument === "") continue;
      if (isLiteralExpression(argument) || isScrubCall(argument)) continue;
      out.push({ line: call.line, kind: "argument", text: argument.replace(/\s+/g, " ").slice(0, 120) });
    }
    if (formatStringOffender(args)) {
      out.push({
        line: call.line,
        kind: "format-string",
        text: `${args[0].replace(/\s+/g, " ").slice(0, 100)} … + ${args.length - 1} more argument(s)`,
      });
    }
  }
  return out;
}

/** Just the format-string rule, for the tree-wide sweep — the only one of the
 *  three that needs no judgement about where a value came from. */
export function formatStringOffenders(source: string): LogOffender[] {
  return logOffenders(source).filter((o) => o.kind === "format-string");
}

/** `file:line  kind  text`, the form both guards report offenders in. */
export function describeOffender(file: string, o: LogOffender): string {
  return `${file}:${o.line}  ${o.kind}  ${o.text}`;
}
