// Every channel the UI invokes must have a case in api.ts.
//
// A channel with no case throws at runtime, in the click handler, in front of an
// operator. The baptism trigger panel shipped that way and nobody noticed for
// months: its load path swallowed the throw, so saved triggers simply read as
// "none set", and only pressing Save surfaced `Unknown IPC channel`. The panel
// rendered, accepted input, and could not persist a thing.
//
// `invoke()` takes the IpcChannel union, so `tsc` is the first guard: a channel
// with no case does not compile, called directly or through a wrapper
// (IpcChannel's doc comment in api.ts names the ways around it). This file is the
// second, and the only check on the reverse direction, a channel that has lost
// its last caller. It asks the TypeScript checker which channels reach invoke()
// instead of reading source text, because text cannot tell a call from a query
// key or a comment spelled like a channel, and cannot follow a channel through a
// forwarder. test-fixtures/channel-walk.tsx pins what that walk follows and
// what it refuses.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const slash = (f: string) => f.replace(/\\/g, "/");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RENDERER = `${slash(path.join(ROOT, "renderer"))}/`;
const API_TS = slash(path.join(HERE, "api.ts"));
const FIXTURE = `${RENDERER}test-fixtures/channel-walk.tsx`;

interface Walk {
  /** Every channel with a `case` in invoke()'s switch, sorted. */
  cases: string[];
  /** Each dispatched channel, with the renderer files whose calls send it. */
  dispatched: Map<string, string[]>;
  /** Everything walk() could not follow, as `file:line  what`. */
  unresolved: string[];
}

const isRendererUi = (f: string) => {
  const s = slash(f);
  return s.startsWith(RENDERER) && !s.startsWith(`${RENDERER}test-fixtures/`) && !/\.test\.tsx?$/.test(s);
};
let rendererWalk: Walk | undefined;
let fixtureWalk: Walk | undefined;
/** The renderer's own UI, walked once per run: four or five seconds idle, longer under load. */
const walk = () => (rendererWalk ??= analyse(isRendererUi));
/** test-fixtures/channel-walk.tsx alone: the shapes analyse() must follow, and refuse. */
const walkFixture = () => (fixtureWalk ??= analyse((f) => slash(f) === FIXTURE));

/**
 * Which channels reach invoke(), and from which of the `isUi` files, as the
 * TypeScript checker resolves them.
 *
 * A channel is credited only where a string literal of it is WRITTEN in an
 * expression that flows into invoke(), never from a type: a type says what
 * could be sent, and a channel whose last call is deleted must stop counting.
 * Every call or `new` in a non-test renderer file whose resolved signature is
 * invoke's, through any import alias, contributes what its first argument can
 * hold, looking through a cast, a non-null assertion or `satisfies`, so
 * `"x:y" as IpcChannel` counts as "x:y" and meets the missing-case test:
 *  - a string literal;
 *  - each branch of a ternary, and each side of `??` or `||`;
 *  - a variable's initializer and every value assigned to it in its scope, or
 *    the items of the literal array a `for...of` binds it to.
 * When the argument is a PARAMETER of the enclosing function, that function is
 * a forwarder: its own calls contribute instead, to any depth and across files,
 * with an absent or `undefined` argument resolved through the parameter's
 * default, and a value assigned to the parameter counted too. That is how
 * useStageSettings's writeState() reaches invoke through writeTo() and ipc.
 *
 * Anything it cannot follow is listed in `unresolved`, and a test below fails
 * on it: an argument of any other shape, or one that sends no channel at all;
 * a variable destructured, looped over or compound-assigned; a spread over a
 * forwarder's channel; a forwarder nothing calls directly; a value whose type
 * is invoke or a forwarder, used other than by calling it; and a value handed
 * on whole (passed, assigned, returned, listed, spread or rendered, through
 * `!`, a cast, `?:`, `??`, `||` or `&&`) whose type is one, or is an object
 * declared here that holds one as a member. Counting any of those as every
 * channel would make the reverse check vacuous, and skipping them would hide
 * what they send. test-fixtures/channel-walk.tsx shows each shape.
 *
 * What it does not see: a forwarder nested deeper than one member; reachability,
 * so a call inside an exported function nothing imports still counts; and flow,
 * so a value counts wherever it is assigned, even where a later assignment
 * always replaces it.
 */
function analyse(isUi: (file: string) => boolean): Walk {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram({ rootNames: parsed.fileNames.filter(isUi), options: parsed.options });
  const checker = program.getTypeChecker();
  const ui = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && isUi(sf.fileName));

  const api = program.getSourceFile(API_TS);
  const apiModule = api && checker.getSymbolAtLocation(api);
  const invokeSymbol = apiModule && checker.getExportsOfModule(apiModule).find((s) => s.name === "invoke");
  const invokeDecl = invokeSymbol?.valueDeclaration;
  if (!invokeSymbol || !invokeDecl || !ts.isFunctionDeclaration(invokeDecl) || !invokeDecl.body) {
    throw new Error("walk: no exported invoke() function in renderer/lib/api.ts");
  }
  const dispatch = invokeDecl.body.statements.find(ts.isSwitchStatement);
  const cases = (dispatch?.caseBlock.clauses ?? [])
    .flatMap((c) => (ts.isCaseClause(c) && ts.isStringLiteral(c.expression) ? [c.expression.text] : []))
    .sort();
  if (cases.length === 0) throw new Error("walk: invoke()'s switch has no string cases");

  const fileOf = (n: ts.Node) => slash(n.getSourceFile().fileName).slice(RENDERER.length);
  const where = (n: ts.Node) =>
    `${fileOf(n)}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  /** The symbol a name refers to, through any import alias. */
  const symbolOf = (n: ts.Node): ts.Symbol | undefined => {
    const s = checker.getSymbolAtLocation(n);
    return s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  };

  /** The declaration with the body: an overload signature stands for its implementation. */
  const implementation = (d: ts.Node): ts.Node => {
    if (!(ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) || d.body || !d.name) return d;
    const decls = symbolOf(d.name)?.declarations ?? [];
    return decls.find((x) => (ts.isFunctionDeclaration(x) || ts.isMethodDeclaration(x)) && x.body) ?? d;
  };

  /** A parameter's position among a call's arguments: `this` takes none. */
  const argIndex = (p: ts.ParameterDeclaration) => {
    const params = (p.parent as ts.SignatureDeclaration).parameters;
    const first = params[0]?.name;
    return params.indexOf(p) - (first && ts.isIdentifier(first) && first.text === "this" ? 1 : 0);
  };
  const parameterAt = (fn: ts.Node, index: number) =>
    (fn as ts.SignatureDeclaration).parameters.find((p) => argIndex(p) === index);

  const unwrap = (arg: ts.Expression): ts.Expression => {
    let e = arg;
    while (
      ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) ||
      ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)
    ) e = e.expression;
    return e;
  };
  /** `undefined` or `void x`: an argument's absence, written out, which selects a parameter's default. */
  const isUndefined = (e: ts.Expression) => ts.isVoidExpression(e) || (ts.isIdentifier(e) && e.text === "undefined");
  /** A value that is no channel at all. */
  const isNullish = (e: ts.Expression) => isUndefined(e) || e.kind === ts.SyntaxKind.NullKeyword;

  /** Whether an assignment target writes `symbol` anywhere in its destructuring pattern. */
  const writes = (target: ts.Node, symbol: ts.Symbol): boolean => {
    if (ts.isIdentifier(target)) return symbolOf(target) === symbol;
    if (ts.isShorthandPropertyAssignment(target)) return checker.getShorthandAssignmentValueSymbol(target) === symbol;
    if (ts.isPropertyAssignment(target)) return writes(target.initializer, symbol);
    if (ts.isSpreadElement(target) || ts.isSpreadAssignment(target)) return writes(target.expression, symbol);
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return writes(target.left, symbol);
    }
    if (ts.isArrayLiteralExpression(target)) return target.elements.some((el) => writes(el, symbol));
    if (ts.isObjectLiteralExpression(target)) return target.properties.some((p) => writes(p, symbol));
    return false;
  };
  const ASSIGN = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ]);
  /** Every value assigned to `symbol` inside `scope`, or null when a pattern, a loop or `+=` also writes it. */
  const assignments = (symbol: ts.Symbol, scope: ts.Node): ts.Expression[] | null => {
    const out: ts.Expression[] = [];
    let opaque = false;
    const visit = (n: ts.Node): void => {
      const op = ts.isBinaryExpression(n) ? n.operatorToken.kind : undefined;
      if (ts.isBinaryExpression(n) && op !== undefined && ASSIGN.has(op)) {
        if (ts.isIdentifier(n.left)) {
          if (symbolOf(n.left) === symbol) out.push(n.right);
        } else if (writes(n.left, symbol)) opaque = true;
      } else if (
        ts.isBinaryExpression(n) && op !== undefined &&
        op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment &&
        writes(n.left, symbol)
      ) {
        // `channel += "Now"` builds a value no literal here spells.
        opaque = true;
      } else if (
        (ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
        !ts.isVariableDeclarationList(n.initializer) &&
        writes(n.initializer, symbol)
      ) opaque = true;
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return opaque ? null : out;
  };
  /**
   * The items of a literal array written in place, or held by a `const` whose
   * type is readonly (`as const`), since a mutable one can be pushed to; null for
   * anything else.
   */
  const items = (list: ts.Expression): readonly ts.Expression[] | null => {
    const e = unwrap(list);
    if (ts.isArrayLiteralExpression(e)) return e.elements;
    const d = ts.isIdentifier(e) ? symbolOf(e)?.valueDeclaration : undefined;
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer || !(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) return null;
    const t = checker.getTypeAtLocation(e);
    const readonly = checker.isTupleType(t)
      ? (t as ts.TupleTypeReference).target.readonly
      : t.getSymbol()?.name === "ReadonlyArray";
    return readonly ? items(d.initializer) : null;
  };

  const bucket = <K, V>(map: Map<K, Set<V>>, key: K): Set<V> => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    return set;
  };

  const sinks = new Map<ts.Node, Set<number>>([[invokeDecl, new Set([0])]]);
  const followed = new Map<ts.Node, Set<ts.Node>>();
  const dispatched = new Map<string, Set<string>>();
  const unresolved = new Set<string>();
  const visiting = new Set<ts.Symbol>();
  // Channels credited plus forwarders reached: an argument that adds neither sends nothing.
  let hits = 0;

  /** Records what `arg` sends from `call`; true when it found a new forwarder. */
  const resolve = (arg: ts.Expression, call: ts.Node): boolean => {
    const e = unwrap(arg);
    if (isNullish(e)) return false;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      hits++;
      bucket(dispatched, e.text).add(fileOf(call));
      return false;
    }
    // Every value runs for what it records, so none may short-circuit the rest.
    const all = (values: readonly ts.Expression[]) => values.map((v) => resolve(v, call)).some(Boolean);
    if (ts.isConditionalExpression(e)) return all([e.whenTrue, e.whenFalse]);
    if (
      ts.isBinaryExpression(e) &&
      (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) return all([e.left, e.right]);

    const symbol = ts.isIdentifier(e) ? symbolOf(e) : undefined;
    const decl = symbol?.valueDeclaration;
    const param = decl && ts.isParameter(decl) && ts.isFunctionLike(decl.parent) ? decl : undefined;
    const local = decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl : undefined;
    if (symbol && (param || local)) {
      // A value assigned from itself (`channel = channel ?? "x:y"`) is already being resolved.
      if (visiting.has(symbol)) return false;
      visiting.add(symbol);
      try {
        const scope = param
          ? implementation(param.parent)
          : ts.findAncestor(local, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n))!;
        const assigned = assignments(symbol, scope);
        if (!assigned) {
          unresolved.add(`${where(call)}  ${e.getText()} is destructured, looped or compound-assigned`);
          return false;
        }
        let grew = false;
        if (param) {
          hits++;
          const known = bucket(sinks, scope);
          grew = !known.has(argIndex(param));
          known.add(argIndex(param));
        } else if (ts.isForInStatement(local!.parent.parent)) {
          unresolved.add(`${where(call)}  ${e.getText()} iterates keys`);
          return false;
        } else if (ts.isForOfStatement(local!.parent.parent)) {
          const list = items(local!.parent.parent.expression);
          if (!list) {
            unresolved.add(`${where(call)}  ${e.getText()} iterates something walk() cannot read`);
            return false;
          }
          grew = all(list);
        } else if (local!.initializer) grew = all([local!.initializer]);
        return all(assigned) || grew;
      } finally {
        visiting.delete(symbol);
      }
    }

    unresolved.add(`${where(call)}  ${e.getText().slice(0, 80)}`);
    return false;
  };

  const calls: (ts.CallExpression | ts.NewExpression)[] = [];
  for (const sf of ui) {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) calls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // Until no new forwarder turns up: each one found makes its own calls count.
  for (let grew = true; grew; ) {
    grew = false;
    for (const call of calls) {
      const decl = checker.getResolvedSignature(call)?.declaration;
      const fn = decl && implementation(decl);
      const indexes = fn && sinks.get(fn);
      if (!fn || !indexes) continue;
      bucket(followed, fn).add(call);
      const args = call.arguments ?? ts.factory.createNodeArray<ts.Expression>();
      const spread = args.findIndex(ts.isSpreadElement);
      for (const i of indexes) {
        if (spread !== -1 && spread <= i) {
          unresolved.add(`${where(call)}  a spread over the channel argument`);
          continue;
        }
        const given = args[i] && !isUndefined(unwrap(args[i]!)) ? args[i] : undefined;
        const param = parameterAt(fn, i);
        const value = given ?? param?.initializer;
        // An optional channel left out sends nothing, which is the caller's choice.
        if (!value && param?.questionToken) continue;
        const before = hits;
        if (value) grew = resolve(value, call) || grew;
        if (hits === before) unresolved.add(`${where(call)}  sends no channel`);
      }
    }
  }

  // A forwarder is only followed through its direct calls, so any other way of
  // reaching one, or invoke, would send channels nothing here has seen.
  const forwarders = new Set(sinks.keys());
  for (const fn of forwarders) {
    if (fn !== invokeDecl && !followed.has(fn)) unresolved.add(`${where(fn)}  a forwarder nothing calls directly`);
  }
  /** The type a value has once `undefined` and `null` are set aside, and `this` or a type parameter resolved. */
  const concrete = (type: ts.Type) => {
    const t = checker.getNonNullableType(type);
    return t.flags & ts.TypeFlags.TypeParameter ? (checker.getBaseConstraintOfType(t) ?? t) : t;
  };
  /** Whether a type is invoke or a forwarder: a call or construct signature one declares. */
  const forwards = (type: ts.Type) => {
    const t = concrete(type);
    return [...t.getCallSignatures(), ...t.getConstructSignatures()].some(
      (s) => !!s.declaration && forwarders.has(implementation(s.declaration)),
    );
  };
  /** Whether an object type declared in this program's UI or api.ts holds invoke or a forwarder as a member. */
  const carries = (type: ts.Type, at: ts.Node): boolean => {
    const t = concrete(type);
    if (t.isUnion()) return t.types.some((m) => carries(m, at));
    const home = (t.isIntersection() ? t.types : [t]).some(
      (part) =>
        !!(part.flags & ts.TypeFlags.Object) &&
        !!part.getSymbol()?.declarations?.some((d) => d.getSourceFile() === api || isUi(d.getSourceFile().fileName)),
    );
    return home && checker.getPropertiesOfType(t).some((p) => forwards(checker.getTypeOfSymbolAtLocation(p, at)));
  };
  /** React's own hooks take a dependency list last; naming a forwarder there is not calling it. */
  const DEPS_HOOKS = new Set(["useCallback", "useEffect", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo"]);
  const isDependencyList = (list: ts.Node) => {
    if (!ts.isArrayLiteralExpression(list) || !ts.isCallExpression(list.parent)) return false;
    const hook = list.parent;
    const name = ts.isPropertyAccessExpression(hook.expression) ? hook.expression.name.text : hook.expression.getText();
    return DEPS_HOOKS.has(name) && hook.arguments[hook.arguments.length - 1] === list;
  };
  /** Whether `n` is the name a declaration gives the value, rather than a use of it. */
  const isName = (n: ts.Node) => {
    const d = n.parent;
    return (
      (ts.isFunctionDeclaration(d) || ts.isVariableDeclaration(d) || ts.isMethodDeclaration(d) ||
        ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d) || ts.isBindingElement(d) ||
        ts.isParameter(d) || ts.isClassDeclaration(d)) &&
      (d.name === n || (ts.isBindingElement(d) && d.propertyName === n))
    );
  };
  /**
   * The expressions `n` hands on whole: its arguments, and what it assigns,
   * returns, lists, spreads or renders. A declaration's initializer is not one;
   * the name it binds is checked wherever it goes next.
   */
  const handedOn = (n: ts.Node): readonly ts.Expression[] => {
    const whole = (e: ts.Expression) => (ts.isSpreadElement(e) ? e.expression : e);
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) return (n.arguments ?? []).map(whole);
    if (ts.isBinaryExpression(n) && ASSIGN.has(n.operatorToken.kind)) return [n.right];
    if (ts.isPropertyAssignment(n)) return [n.initializer];
    if (ts.isShorthandPropertyAssignment(n)) return [n.name];
    if (ts.isReturnStatement(n) || ts.isJsxExpression(n)) return n.expression ? [n.expression] : [];
    if (ts.isArrayLiteralExpression(n)) return isDependencyList(n) ? [] : n.elements.map(whole);
    if (ts.isSpreadAssignment(n) || ts.isJsxSpreadAttribute(n)) return [n.expression];
    if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) return [n.body];
    return [];
  };
  const LOGICAL = new Set([
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
  ]);
  /** What a handed-on expression can actually deliver: through `!`, a cast, `?:`, `??`, `||` or `&&`. */
  const delivered = (e: ts.Expression): ts.Expression[] => {
    const u = unwrap(e);
    if (ts.isConditionalExpression(u)) return [...delivered(u.whenTrue), ...delivered(u.whenFalse)];
    if (ts.isBinaryExpression(u) && LOGICAL.has(u.operatorToken.kind)) return [...delivered(u.left), ...delivered(u.right)];
    return [u];
  };
  const callees = new Set<ts.Node>([...followed.values()].flatMap((set) => [...set].map((c) => (c as ts.CallExpression).expression)));
  for (const sf of ui) {
    const visit = (n: ts.Node): void => {
      // Type annotations and JSX names are never a value that could be a forwarder.
      if (ts.isTypeNode(n) || ts.isJsxAttribute(n) || ts.isJsxOpeningElement(n) || ts.isJsxClosingElement(n) || ts.isJsxSelfClosingElement(n)) {
        if (ts.isTypeNode(n) || ts.isJsxAttribute(n)) {
          if (ts.isJsxAttribute(n) && n.initializer) visit(n.initializer);
          return;
        }
        const tag = n as ts.JsxOpeningElement | ts.JsxSelfClosingElement | ts.JsxClosingElement;
        ts.forEachChild(tag, (c) => {
          if (c !== tag.tagName) visit(c);
        });
        return;
      }

      // Anything handed on whole: invoke or a forwarder, or an object holding one,
      // would be called from somewhere nothing here follows.
      for (const handed of handedOn(n)) {
        for (const d of delivered(handed)) {
          // An inline function is followed through its own calls, or refused for having none.
          if (ts.isArrowFunction(d) || ts.isFunctionExpression(d)) continue;
          const t = checker.getTypeAtLocation(d);
          if (forwards(t)) unresolved.add(`${where(d)}  ${d.getText().slice(0, 60)} used as a value`);
          else if (carries(t, d)) unresolved.add(`${where(d)}  ${d.getText().slice(0, 60)} carries a forwarder`);
        }
      }

      // Any other use of a name for one that is not a direct call: `.call`, a cast callee.
      const value =
        (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) ||
        ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
      if (value && !isName(n)) {
        let use: ts.Node = n;
        while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
        const p = use.parent;
        const declarative = ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) ||
          ts.isNamespaceImport(p) || ts.isTypeQueryNode(p) || ts.isExportAssignment(p);
        if (!declarative && !callees.has(use) && !isDependencyList(use.parent) && forwards(checker.getTypeAtLocation(n))) {
          unresolved.add(`${where(n)}  ${n.getText().slice(0, 60)} used as a value`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  return {
    cases,
    dispatched: new Map([...dispatched].map(([c, files]) => [c, [...files].sort()])),
    unresolved: [...unresolved].sort(),
  };
}

describe("IPC channel wiring", () => {
  it("has a case for every channel the UI invokes", () => {
    const { cases, dispatched } = walk();
    const handled = new Set(cases);
    const missing = [...dispatched]
      .filter(([chan]) => !handled.has(chan))
      .map(([chan, files]) => `  ${chan}  <- ${files.join(", ")}`);
    assert.deepEqual(missing, [], `invoke() would throw "Unknown IPC channel" for:\n${missing.join("\n")}`);
  });

  it("can say which channels every call to invoke() sends", () => {
    // The walk's own guard. A call it cannot follow is a call whose channels
    // neither test here can account for, so it fails instead of guessing.
    assert.deepEqual(
      walk().unresolved,
      [],
      "walk() cannot tell which channels these send; call invoke() or the forwarder directly, " +
        "with a literal, a ternary of literals, or a variable only ever assigned literals",
    );
  });

  it("names every channel the UI no longer dispatches", () => {
    // The other direction, and the one that actually bit. Removing two settings
    // panels as unreachable dead code took the last callers of
    // spl:deleteHistory and attendance:deleteHistory with them — so History's
    // Delete, which calls only serviceTimeline:delete, quietly stopped removing
    // the SPL and attendance records. Nothing was broken at the call site; the
    // call site was gone. A channel losing its last caller is a fact worth
    // knowing at the moment it happens, not a Sunday later.
    //
    // An EXACT set, not a ceiling. A floor with slack is how three config
    // stores went missing from every backup with the suite green: the point is
    // that ADDING an entry has to be a deliberate edit here, with a reason.
    // Sorted, one per line, so two branches adding different channels touch
    // different lines.
    const expected = new Map([
      ["app:getInfo", "version info comes from /api/version"],
      ["attendance:deleteHistory", "History deletes all three records via serviceTimeline:delete; see deleteServiceRecords"],
      ["automation:settings", "the automation panel reads simulate and disarmed from automation:rules, and only LISTENS for the SSE event of the same name; the route stays as the documented GET /api/automation/settings"],
      ["outputs:openWindow", "Electron-era window opener; the web build navigates directly"],
      ["spl:deleteHistory", "History deletes all three records via serviceTimeline:delete"],
      ["spl:getTrendPrefs", "the Overview card these gated is gone from All services; the stored choice is the operator's own and is not deleted to tidy up, and the route stays for the documented HTTP API"],
      ["spl:listHistory", "superseded by the service-timeline list; route kept for the HTTP API"],
      ["spl:setTrendPrefs", "nothing writes the trend choice now; see spl:getTrendPrefs"],
      ["spl:setVisibleMetrics", "the History metric choice is a per-browser preference now (spl:visibleMetrics in localStorage); the server setting is READ once to seed it — spl:getVisibleMetrics still has a caller — and the route stays for the documented HTTP API"],
      ["stage:getRemoteUrl", "the remote URL is read from stage:getState instead"],
      ["stage:setNdiEnabled", "NDI schema is dormant on this branch; the UI ships with the native app"],
      ["views:reorder", "manual view ordering came out with the settings window; the route stays as the documented POST /api/views/reorder"],
      ["window:closeSettings", "Escape closed the settings WINDOW; Settings is routes inside the app now, so there is nothing to close to"],
    ]);
    const kept = [...expected.keys()];
    assert.deepEqual(kept, [...kept].sort(), "keep this list sorted");

    const { cases, dispatched } = walk();
    const gone = kept.filter((c) => !cases.includes(c));
    assert.deepEqual(gone, [], `these have no case any more — drop them from the list: ${gone}`);
    const appeared = cases.filter((c) => !dispatched.has(c) && !expected.has(c));
    assert.deepEqual(
      appeared,
      [],
      "these channels lost their last caller — either restore the caller, or add them " +
        "here with the reason they are kept:\n  " + appeared.join("\n  "),
    );

    const revived = kept.filter((c) => dispatched.has(c));
    assert.deepEqual(revived, [], `these are dispatched again — drop them from the list: ${revived}`);
  });

  it("follows every shape the UI dispatches through", () => {
    // Real channels and the real files that send them, one per shape, so a
    // change to walk() that stops following a shape names it here rather than
    // as a list of channels that look dead. The missing-case text scan this
    // replaced could not see the last three.
    const shapes: [channel: string, file: string, shape: string][] = [
      ["captions:setChannelColor", "components/caption-colors-panel.tsx", "a literal passed to invoke"],
      ["wireless:listProviders", "components/wireless-connections-panel.tsx", "an `ipc` alias of the import"],
      ["pco:liveNext", "main/live-controls.tsx", "the true branch of a ternary"],
      ["pco:livePrevious", "main/live-controls.tsx", "the false branch of the same ternary"],
      ["baptism:resume", "main/baptism-operator.tsx", "the true branch of a ternary passed to a forwarder, act()"],
      ["baptism:pause", "main/baptism-operator.tsx", "the false branch of that ternary"],
      ["youtube:connectCancel", "components/youtube-connect-row.tsx", "a forwarder nested in a component, run()"],
      ["stage:setPlan", "app/use-stage-settings.ts", "a forwarder of a forwarder, writeState() to writeTo() to ipc"],
      ["baptism:advance", "main/baptism-operator.tsx", "a local assigned in branches and read in a closure"],
      ["devices:list", "app/screens/use-devices.ts", "a type argument that nests a `>`"],
    ];
    const { dispatched } = walk();
    const lost = shapes
      .filter(([chan, file]) => !dispatched.get(chan)?.includes(file))
      .map(([chan, file, shape]) => `  ${chan} from ${file}: ${shape}`);
    assert.deepEqual(lost, [], `walk() no longer follows:\n${lost.join("\n")}`);
  });

  it("follows, and refuses, each shape in its fixture", () => {
    // analyse() is only as strict as the shapes it knows, and most of what it
    // refuses has no instance in the real UI to keep it honest: drop a check
    // from it and every test above stays green. Each marked line of
    // test-fixtures/channel-walk.tsx says what analyse() must make of it,
    // `sends:` the channels credited and `flags:` the reasons it is unresolved,
    // and nothing unmarked may add either.
    const lines = fs.readFileSync(FIXTURE, "utf8").split(/\r?\n/);
    const marks = (tag: string, separator: string) =>
      lines.flatMap((line, i) =>
        (new RegExp(`// ${tag}: (.+)$`).exec(line)?.[1]?.split(separator) ?? []).map((v) => [v, i + 1] as const),
      );
    const sends = marks("sends", ", ").map(([v]) => v).sort();
    const flags = marks("flags", " | ").map(([v, line]) => `test-fixtures/channel-walk.tsx:${line}  ${v}`).sort();
    assert.ok(sends.length > 0 && flags.length > 0, "the fixture lost its markers");

    const { dispatched, unresolved } = walkFixture();
    assert.deepEqual([...dispatched.keys()].sort(), sends, "channels credited in the fixture");
    assert.deepEqual(unresolved, flags, "calls and values refused in the fixture");
  });

  it("a channel with no case is reported unknown AT RUNTIME, not just absent from a string scan", async () => {
    // I5: a guard that matches error PROSE (`err.message.includes("Unknown IPC
    // channel")`) is one rewording away from vacuous — a reviewer deleted two
    // cases and reworded that exact throw, and a guard built that way stayed
    // green. This does not read the message at all: it proves invoke() still
    // rejects something with no case, which is the fact the missing-case test
    // above depends on walk() correctly reflecting. If a future rewrite makes
    // invoke() swallow an unknown channel instead of throwing, this fails
    // regardless of what the throw says.
    const { invoke } = await import("./api.js");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch;
    try {
      // @ts-expect-error not an IpcChannel, on purpose: this is the runtime throw
      // a caller cast past the type would hit. The directive also pins the type:
      // loosen invoke() back to `string` and tsc reports the directive unused.
      await assert.rejects(() => invoke("baptism:not-a-real-channel"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
