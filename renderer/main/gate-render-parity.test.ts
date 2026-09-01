// Every channel a widget DRAWS is a channel its layout SUBSCRIBES to.
//
// `useLayoutData` narrows: a clock-only wall screen opens no integration
// channel. The narrowing is a set of `want([...])` gates naming object types,
// and a widget that reads `ctx.<channel>` without being named in that channel's
// gate is handed `null` for ever. Not a wrong number — no number, on the layout
// the widget exists for.
//
// `record-status` shipped that way: it reads ctx.obs and ctx.reaper, no gate
// named it, and a wall whose only recorder widget was that one said NO RECORDER
// through the whole service. It is the object an operator picks INSTEAD of the
// gated pair, so the layout that hit the bug is the one the object exists for.
// `stream-status` and the three Home streaming cards had the same hole against
// ctx.obs, which is a streamer `streamingReadout` reads. Two more of this exact
// class were fixed earlier in the same release. embed-gate-descent.test.ts tests
// the embed DESCENT — whether the gate can SEE a nested widget — and never
// whether a widget it sees is named by the gate for what it reads, so all four
// holes were green.
//
// WHY IT READS SOURCE. The alternative is to render every arm against a probe
// context, but an arm reads a channel only down the branch its config selects
// (people-counter touches ctx.serviceLow only when metric === "min"), so a
// rendered probe UNDER-reports and goes green on a real hole. A source scan
// over-reports instead: a comment naming `ctx.obs` inside an arm adds a demand
// that is not real. That direction is a false RED — somebody deletes a stale
// comment or names the gate — and never a false green, which is the failure this
// repo keeps paying for.
//
// The scan is anchored EXACTLY, not by a count written down here: the set of
// types it finds arms for must equal the object registry's keys, both ways. A
// regex that stops matching finds fewer arms and fails; a new object type with
// no arm fails; a new gated channel appears in the gate table and is enforced
// from the moment it exists.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import { LAYOUT_OBJECTS } from "./layout-objects.js";

const here = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const RENDERER = here("./layout-renderer.tsx").split("\n");
const CARDS = here("../app/home/cards.tsx").split("\n");

/** A top-level `function name(` … `}` body, by exact column-0 bracing. */
function topLevelFunction(lines: string[], name: string): string {
  const head = lines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`export function ${name}(`),
  );
  assert.notEqual(head, -1, `function ${name} not found — the scan cannot run`);
  const end = lines.findIndex((l, i) => i > head && l === "}");
  assert.notEqual(end, -1, `function ${name} has no closing brace at column 0`);
  return lines.slice(head, end + 1).join("\n");
}

/** Every `ctx.<field>` named in a chunk of source. */
function ctxReads(text: string): Set<string> {
  return new Set([...text.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
}

/** The `case "type":` arms of a switch, each with the source up to the next arm. */
function switchArms(lines: string[], header: string): Map<string, string> {
  const start = lines.indexOf(header);
  assert.notEqual(start, -1, `switch header ${JSON.stringify(header)} not found`);
  const at: { type: string; line: number }[] = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^ {4}case "([a-z0-9-]+)":/.exec(lines[i]);
    if (m) at.push({ type: m[1], line: i });
  }
  const arms = new Map<string, string>();
  at.forEach((a, k) => {
    const text = lines.slice(a.line, k + 1 < at.length ? at[k + 1].line : lines.length - 1).join("\n");
    // A bodiless arm falls through to the next one, and attributing no reads to
    // it would hide exactly what this file looks for. None exist today; if one
    // appears, this says so rather than going quietly green.
    assert.match(text, /\breturn\b/, `case "${a.type}" falls through — the scan cannot attribute its reads`);
    arms.set(a.type, text);
  });
  return arms;
}

// ---------------------------------------------------------------- the gates

/**
 * Each gated `ctx` field, and the object types whose presence opens it.
 *
 * Read out of `useLayoutData`: `const spl = useSplState(want(["spl-meter"]))`
 * gates the local `spl`, and the `LayoutRenderCtx` literal maps that local onto
 * the ctx field a widget reads. A hook called with no `want()` is ungated —
 * always subscribed, so nothing has to name it.
 */
function gatedFields(): Map<string, Set<string>> {
  const useLayoutData = topLevelFunction(RENDERER, "useLayoutData");

  // Gates hoisted into a local first: `const peopleWanted = want([...])`.
  const named = new Map<string, string[]>();
  for (const m of useLayoutData.matchAll(/const (\w+) = want\(\[([^\]]*)\]\);/g)) {
    named.set(m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  }

  // `const <local> = useSomething(<gate expression>);`
  const byLocal = new Map<string, Set<string>>();
  for (const m of useLayoutData.matchAll(/const (\w+) = use\w+\(([^;]*)\);/g)) {
    const [, local, arg] = m;
    const types = new Set<string>();
    for (const w of arg.matchAll(/want\(\[([^\]]*)\]\)/g)) {
      for (const t of w[1].matchAll(/"([^"]+)"/g)) types.add(t[1]);
    }
    for (const [gate, list] of named) {
      if (new RegExp(`\\b${gate}\\b`).test(arg)) list.forEach((t) => types.add(t));
    }
    if (types.size > 0) byLocal.set(local, types);
  }

  // The context literal: `{ state, obs, servicePeak: servicePeaks.occupancy, … }`.
  const literal = RENDERER.find((l) => l.includes("const ctx: LayoutRenderCtx = {"));
  assert.ok(literal, "the LayoutRenderCtx literal was not found — the scan cannot run");
  const inner = literal.slice(literal.indexOf("{") + 1, literal.lastIndexOf("}"));
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);

  const out = new Map<string, Set<string>>();
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    const colon = t.indexOf(":");
    const field = colon < 0 ? t : t.slice(0, colon).trim();
    const local = colon < 0 ? t : /^[A-Za-z_$][\w$]*/.exec(t.slice(colon + 1).trim())?.[0] ?? "";
    const gate = byLocal.get(local);
    if (gate) out.set(field, gate);
  }
  return out;
}

// ---------------------------------------------------------------- the reads

/**
 * Each object type, and every `ctx` field its render path reads.
 *
 * Three indirections are followed, because each of them is where a read hides:
 *
 *  - closures declared at the top of `ObjectBody` that close over `ctx`
 *    (`streamingReadout` reads ctx.resi, ctx.youtube and ctx.obs — that last one
 *    is where `stream-status` was missing a gate);
 *  - components and helpers handed the whole `ctx` (`ctx={ctx}`, `f(ctx)`);
 *  - `HomeCard`, which is handed named props off `ctx`. A Home card's channels
 *    are decided in ITS switch, not in the shared branch that renders it — the
 *    branch passes `onlineOutputIds` for all fifteen types and only two use it.
 */
function readsByType(): Map<string, Set<string>> {
  const objectBody = topLevelFunction(RENDERER, "ObjectBody");
  const bodyLines = objectBody.split("\n");

  // `const name = (…) => …;` at the top of ObjectBody, taken to its balanced end.
  const closures = new Map<string, string>();
  for (let i = 0; i < bodyLines.length; i++) {
    const m = /^ {2}const (\w+) = [(<]/.exec(bodyLines[i]);
    if (!m) continue;
    let depth = 0;
    let text = "";
    for (let k = i; k < bodyLines.length; k++) {
      for (const ch of bodyLines[k]) {
        if ("([{".includes(ch)) depth++;
        if (")]}".includes(ch)) depth--;
      }
      text += bodyLines[k] + "\n";
      if (depth === 0 && /;\s*$/.test(bodyLines[k])) break;
    }
    closures.set(m[1], text);
  }

  /** A chunk's own reads, plus those of everything it hands `ctx` to. */
  const expand = (text: string): Set<string> => {
    const found = ctxReads(text);
    for (const [name, source] of closures) {
      if (new RegExp(`\\b${name}\\(`).test(text)) ctxReads(source).forEach((f) => found.add(f));
    }
    const handed = new Set<string>();
    for (const m of text.matchAll(/<(\w+)[^>]*\bctx=\{ctx\}/gs)) handed.add(m[1]);
    for (const m of text.matchAll(/\b(\w+)\(ctx\)/g)) handed.add(m[1]);
    for (const name of handed) ctxReads(topLevelFunction(RENDERER, name)).forEach((f) => found.add(f));
    return found;
  };

  const byType = new Map<string, Set<string>>();
  for (const [type, text] of switchArms(bodyLines, "  switch (c.type) {")) byType.set(type, expand(text));

  // The Home branch, which sits above the switch and covers every home card.
  const branchStart = bodyLines.indexOf("  if (isHomeCard(c)) {");
  assert.notEqual(branchStart, -1, "the isHomeCard branch was not found — home cards would go unscanned");
  const branch = bodyLines.slice(branchStart, bodyLines.indexOf("  switch (c.type) {")).join("\n");
  const element = /<HomeCard[\s\S]*?\/>/.exec(branch);
  assert.ok(element, "the <HomeCard> element was not found — its props could not be mapped");
  // What the branch reads OUTSIDE the HomeCard element applies to every home
  // card... except the wall-twin path, which only the WALL_TWIN types take.
  const twinStart = RENDERER.findIndex((l) => l.startsWith("const WALL_TWIN = {"));
  assert.notEqual(twinStart, -1, "WALL_TWIN was not found — the wall-twin path would go unscanned");
  const twinEnd = RENDERER.findIndex((l, i) => i > twinStart && l.startsWith("}"));
  const wallTwins = new Set<string>();
  for (const m of RENDERER.slice(twinStart, twinEnd).join("\n").matchAll(/^ {2}"([a-z0-9-]+)":/gm)) {
    wallTwins.add(m[1]);
  }
  assert.ok(wallTwins.size > 0, "WALL_TWIN listed no types — the wall-twin path would go unscanned");

  const outsideCard = branch.replace(element[0], "");
  const twinReads = expand(outsideCard);
  const propToField = new Map<string, string>();
  for (const m of element[0].matchAll(/(\w+)=\{ctx\.(\w+)\}/g)) propToField.set(m[1], m[2]);
  assert.ok(propToField.size > 0, "no <HomeCard> prop was traced back to ctx — the mapping broke");

  for (const [type, text] of switchArms(CARDS, "  switch (c.type) {")) {
    const found = new Set<string>();
    // A home card is drawn on Home through HomeCard, and off Home — for the
    // three with a wall twin — through streamingReadout.
    if (wallTwins.has(type)) twinReads.forEach((f) => found.add(f));
    for (const [prop, field] of propToField) {
      if (new RegExp(`\\b${prop}\\b`).test(text)) found.add(field);
    }
    byType.set(type, found);
  }
  return byType;
}

// ---------------------------------------------------------------- the guard

const GATED = gatedFields();
const READS = readsByType();

describe("every channel a widget draws is one its layout subscribes to", () => {
  test("the scan covers exactly the object registry, both ways", () => {
    // The anchor. Nothing below means anything if the scan quietly found
    // nothing, and a floor ("at least forty arms") is how that goes unnoticed.
    assert.deepEqual(
      [...READS.keys()].sort(),
      Object.keys(LAYOUT_OBJECTS).sort(),
      "the render arms found do not match the object registry — a type has no arm, or the scan missed one",
    );
  });

  test("the gates were actually parsed", () => {
    // A regex that stops matching would leave GATED empty and pass every parity
    // check below by having nothing to check. These four are the channels the
    // holes were found in; naming them means the parse is provably alive.
    for (const field of ["obs", "reaper", "resi", "onlineOutputIds"]) {
      assert.ok(GATED.has(field), `ctx.${field} is gated in useLayoutData but the scan did not see it`);
    }
    assert.ok(GATED.size >= 4);
  });

  test("no arm reads a channel its type is not gated for", () => {
    const holes: string[] = [];
    for (const [type, fields] of READS) {
      for (const field of fields) {
        const gate = GATED.get(field);
        if (gate && !gate.has(type)) {
          holes.push(
            `${type} draws ctx.${field}, but that channel is opened only for [${[...gate].sort().join(", ")}] — ` +
              `a layout whose only such widget is a ${type} subscribes to nothing and shows the offline state for ever`,
          );
        }
      }
    }
    assert.deepEqual(holes, [], holes.join("\n"));
  });
});
