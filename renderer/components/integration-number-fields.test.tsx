// What every `type: "number"` field in every integration card starts out holding.
//
// Two ways a numeric field can be wrong before an operator has touched it, and
// both shipped:
//
//   1. NaN. initialConfig() treats a field's `placeholder` as its shown default
//      and falls back to `Number(placeholder)`. A placeholder is free-form prose
//      — "500 (lower = snappier, more requests)" — so that is NaN, and the guard
//      that was meant to catch it was `fallback ?? ""`, which does not: `??`
//      only catches null and undefined. NaN went to the field, where
//      `String(NaN)` and `Number(value) || 0` both render 0, so a poll interval
//      and a switcher port whose stored value was genuinely ABSENT each showed a
//      bare 0 — and a focus-and-blur on that 0 committed it as a real number.
//
//   2. A number invented for a field that has none. A field with no default and
//      no numeric placeholder means "unset", and the form has to be able to say
//      so. Seeding "" is how it says it; `unsetHint` is how the descriptor
//      declares that blank is a real state rather than a missing value.
//
// This runs the REAL initialConfig over the REAL descriptors rather than
// reimplementing the fallback ladder, because a guard that reimplements it goes
// green on a bug living in the copy under test. The descriptors come from the
// fixture for the reason integration-descriptors.ts gives (importing the manager
// into a renderer test drags every provider and store along); the fixture is
// pinned field-for-field against the shipped descriptors by
// main/services/integration-descriptor-fixture.test.ts, so it cannot drift.

import { strict as assert } from "node:assert";
import { after, beforeEach, describe, test } from "node:test";

import { installDom, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
// React only act-wraps a render, and only warns when an update escapes one,
// once it is told it is in a test environment. Without this the file reads
// as clean while 1049 updates land outside act.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const { installFakeServer, withQueryClient, idle, integrationCard, until } = await import(
  "../test-fixtures/integrations-harness.js"
);
const { INTEGRATION_DESCRIPTOR_FIXTURE } = await import("../test-fixtures/integration-descriptors.js");
const { IntegrationsPanel } = await import("./integrations-panel.js");
const { initialConfig, numberFieldValue } = await import("./integration-number-fields.js");

/** Like settle(), but for a wait that needs a specific real-world duration. */
function settleFor(ms: number): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/**
 * Like until(), but safe for a condition that depends on React having
 * actually committed a render. Each wait is its OWN short act() scope,
 * closed before the condition is checked again: one continuous act() around
 * the whole poll would hold back the very update the condition is waiting
 * to see.
 */
async function actUntil(ok: () => boolean, say: () => string, capMs = 5000): Promise<void> {
  const deadline = Date.now() + capMs;
  for (;;) {
    if (ok()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    if (ok()) return;
    if (Date.now() >= deadline) assert.fail(`${say()} (gave up after ${capMs}ms)`);
  }
}

let server = installFakeServer();

beforeEach(() => {
  cleanup();
  server.restore();
});

after(() =>
  unmountAndTeardown(cleanup, () => {
    server.restore();
    teardown();
  }),
);

/** One number field, and what the form seeds it with on a fresh install. */
interface Seeded {
  id: string;
  key: string;
  /** What initialConfig() put in the form for it, with nothing saved. */
  seed: unknown;
}

/** Every number field the app ships, run through the real seeding path with an
 *  empty saved config — a fresh install, every card opened. */
const seeded: Seeded[] = INTEGRATION_DESCRIPTOR_FIXTURE.flatMap((d) => {
  const form = initialConfig(d, {
    id: d.id,
    enabled: false,
    connection: "disconnected",
    message: null,
    config: {},
  });
  return d.configSchema
    .filter((f) => f.type === "number")
    .map((f) => ({ id: d.id, key: f.key, seed: form[f.key] }));
});

const where = (s: Seeded) => `${s.id}.${s.key}`;

describe("what a number field starts out holding", () => {
  test("there are exactly thirteen of them", () => {
    // EXACT, not a floor. A fourteenth number field is a field nobody has
    // decided the unset behaviour of, and the whole point of this file is that
    // the decision is made per field rather than defaulted into. Update this
    // number in the same change that adds the field, having read the rest of
    // this file first.
    assert.equal(
      seeded.length,
      13,
      `the app ships ${seeded.length} number fields, not 13: ${seeded.map(where).join(", ")}`,
    );
  });

  test("not one of them seeds NaN", () => {
    // The bug this file exists for. NaN is indistinguishable from a real value
    // to every reader downstream — it renders as 0, it is truthy to
    // configuredFor(), and JSON.stringify turns it into `null` on the way to the
    // server, so it lands on disk as a key nobody set.
    const nan = seeded.filter((s) => typeof s.seed === "number" && !Number.isFinite(s.seed));
    assert.deepEqual(nan.map(where), [], `these number fields seed NaN: ${nan.map(where).join(", ")}`);
  });

  test("a field that seeds a number seeds a usable one", () => {
    // A seeded number is SAVED the next time the card is saved for any other
    // reason, so it has to be a number the service would really run at — never
    // 0, never negative, and inside whatever bounds the field declares.
    const numeric = seeded.filter((s) => typeof s.seed === "number");
    const bad = numeric.filter((s) => !(Number.isFinite(s.seed as number) && (s.seed as number) > 0));
    assert.deepEqual(bad.map(where), [], `these seed a number no service would run at: ${bad.map(where).join(", ")}`);
  });

  test("exactly three of them seed blank, and these three", () => {
    // Blank means "no value" — the field resolves at runtime from something
    // else (the ProPresenter poller's own 1000ms, the Vea poll interval) or is
    // simply not configured yet (the Ross TSL port). Named exactly, because a
    // fourth field arriving here is either a new deliberate unset field or a
    // default somebody forgot, and those need different fixes.
    const blank = seeded.filter((s) => s.seed === "").map(where).sort();
    assert.deepEqual(blank, ["propresenter.pollMs", "ross-tsl.port", "sensource.attendancePollSeconds"]);
  });

  test("a field seeds either a number or blank, and nothing else", () => {
    const odd = seeded.filter((s) => typeof s.seed !== "number" && s.seed !== "");
    assert.deepEqual(
      odd.map((s) => `${where(s)}=${JSON.stringify(s.seed)}`),
      [],
      "a number field seeded something that is neither a number nor blank",
    );
  });
});

/** Every number field again, this time paired with its own descriptor entry. */
const fields = INTEGRATION_DESCRIPTOR_FIXTURE.flatMap((d) =>
  d.configSchema.filter((f) => f.type === "number").map((f) => ({ id: d.id, field: f })),
);

describe("which number fields say blank is a setting", () => {
  test("exactly three declare unsetHint, and these three", () => {
    const opted = fields.filter((f) => f.field.unsetHint != null).map((f) => `${f.id}.${f.field.key}`).sort();
    assert.deepEqual(opted, ["propresenter.pollMs", "ross-tsl.port", "sensource.attendancePollSeconds"]);
  });

  test("no unsetHint is long enough to be clipped by its own box", () => {
    // A PROXY for the real measurement, and it says so. jsdom loads no
    // stylesheet and reports every width as 0, so nothing here can ask whether
    // the string fits. What CAN be pinned is the length, and the ceiling below
    // is not a guess: measured in headless Chrome against the shipped
    // stylesheet, the field gives 105px of room at 13px IBM Plex Sans, where
    //
    //   "1000"                  31.2px
    //   "Not set"               42.1px
    //   "Same as above"         87.5px
    //   "Same as poll interval" 121.2px  — CLIPPED by 16.2px, and what this
    //                                      field shipped with until it was
    //                                      looked at in a browser
    //
    // 16 characters of ordinary mixed-case prose comes to about 92px, which
    // leaves room. A hint that trips this has not necessarily overflowed —
    // go and measure it rather than raising the number.
    const tooLong = fields
      .filter((f) => (f.field.unsetHint?.length ?? 0) > 16)
      .map((f) => `${f.id}.${f.field.key} = ${JSON.stringify(f.field.unsetHint)} (${f.field.unsetHint?.length} chars)`);
    assert.deepEqual(tooLong, [], "an unset hint is too long for the 176px field it renders in");
  });

  test("a field seeds blank if and only if it declares unsetHint", () => {
    // THE BICONDITIONAL, and the reason this file is worth having. Either half
    // failing is a real defect with a different fix:
    //
    //   seeds blank, no unsetHint — the form cannot say what blank means, so
    //     the field renders 0 and a click in and out commits it. Either give it
    //     an unsetHint or give it a default.
    //   unsetHint, seeds a number — the hint is dead text nobody will ever see,
    //     because the field is prefilled. The default and the hint disagree.
    //
    // A fourteenth number field added with neither lands in the first half.
    const seedOf = new Map(seeded.map((s) => [`${s.id}.${s.key}`, s.seed]));
    const mismatched = fields
      .map((f) => ({ at: `${f.id}.${f.field.key}`, hint: f.field.unsetHint != null, blank: seedOf.get(`${f.id}.${f.field.key}`) === "" }))
      .filter((f) => f.hint !== f.blank)
      .map((f) => `${f.at} (unsetHint=${f.hint}, seeds blank=${f.blank})`);
    assert.deepEqual(mismatched, []);
  });

  test("only those three reach NumberInput as 'no value'", () => {
    // initialConfig is half the path; this is the other half. The bug an
    // operator SAW lived here — the render site turned "" into 0 with
    // `Number(value) || 0` — so a guard over the seeding alone was green on it.
    const asShown = fields.map((f) => {
      const seed = seeded.find((s) => s.id === f.id && s.key === f.field.key)!.seed;
      return { at: `${f.id}.${f.field.key}`, shown: numberFieldValue(f.field, seed) };
    });
    const blank = asShown.filter((f) => f.shown === null).map((f) => f.at).sort();
    assert.deepEqual(blank, ["propresenter.pollMs", "ross-tsl.port", "sensource.attendancePollSeconds"]);

    const rest = asShown.filter((f) => f.shown !== null);
    const bad = rest.filter((f) => !(typeof f.shown === "number" && Number.isFinite(f.shown) && f.shown > 0));
    assert.deepEqual(bad.map((f) => `${f.at}=${f.shown}`), [], "a number field reached the input as 0");
  });

  test("all ten fields with no unsetHint are still handed 0 for an empty value", () => {
    // The opt-in, at the render site. Without the `unsetHint` test in
    // numberFieldValue this would blank every number field in the app whose
    // value happened to be missing.
    //
    // ALL of them, and an exact count. This used to check `fields.find(...)` —
    // one field, whichever came first, which is companion.port — so nine of the
    // ten were covered by nothing, and a descriptor that gave one of them an
    // unsetHint by accident would not have shown up here.
    const plain = fields.filter((f) => f.field.unsetHint == null);
    assert.equal(
      plain.length,
      10,
      `${plain.length} number fields declare no unsetHint, not 10: ${plain.map((f) => `${f.id}.${f.field.key}`).join(", ")}`,
    );
    for (const f of plain) {
      const at = `${f.id}.${f.field.key}`;
      assert.equal(numberFieldValue(f.field, ""), 0, `${at} rendered blank for ""`);
      assert.equal(numberFieldValue(f.field, null), 0, `${at} rendered blank for null`);
      assert.equal(numberFieldValue(f.field, undefined), 0, `${at} rendered blank for undefined`);
      assert.equal(numberFieldValue(f.field, NaN), 0, `${at} rendered blank for NaN`);
    }
  });

  test("a saved number still reaches the input for an unsettable field", () => {
    // Unsettable is about the ABSENCE of a value, not about ignoring one.
    for (const f of fields.filter((f) => f.field.unsetHint != null)) {
      assert.equal(numberFieldValue(f.field, 900), 900, `${f.id}.${f.field.key} dropped a saved value`);
      assert.equal(numberFieldValue(f.field, "900"), 900, `${f.id}.${f.field.key} dropped a saved string value`);
    }
  });
});

// ── The round trip, through the real dialog ──────────────────────────────────
//
// Not the helpers: the DIALOG, mounted, with `fetch` pointed at the in-memory
// server from integrations-harness. Everything above proves what a function
// returns. This proves what the POST body actually carries — which is the
// failure that costs something, because an invented number is only expensive
// once it is on disk.
//
// The three integrations here are all left DISABLED and no credential is
// entered, and nothing in this file reaches a network: the harness replaces
// `fetch` and `EventSource` outright.

const UNSET: { id: string; key: string; dirtyKey: string; dirtyValue: string }[] = [
  // `dirtyKey` is a field OTHER than the one under test — the point is a save
  // the operator makes for some unrelated reason, with the unset field never
  // touched. That is exactly when a prefilled number gets written to disk.
  { id: "propresenter", key: "pollMs", dirtyKey: "host", dirtyValue: "192.168.1.100" },
  { id: "ross-tsl", key: "port", dirtyKey: "host", dirtyValue: "192.168.1.60" },
  { id: "sensource", key: "attendancePollSeconds", dirtyKey: "pollSeconds", dirtyValue: "30" },
];

/** The dialog as it is RIGHT NOW. Queried fresh every time rather than held in
 *  a variable: a save re-seeds the form, React re-renders, and a node captured
 *  before that is detached — which reads as "the dialog has no Save button"
 *  rather than as anything to do with the field under test. */
function dialogNow(): HTMLElement {
  const d = document.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(d, "no dialog is open");
  return d;
}

async function openCard(id: string, config: Record<string, unknown> = {}): Promise<void> {
  server = installFakeServer(Object.keys(config).length ? { [id]: { config } } : {});
  const c = render(withQueryClient(<IntegrationsPanel />));
  // act()-wrapped: idle() polls the query cache with a plain setTimeout loop,
  // and sixteen cards' worth of Switch primitives settle their own state
  // while that loop runs, outside any wrapper otherwise. No deadlock risk —
  // idle()'s condition reads react-query's cache, not anything React holds
  // back.
  await act(async () => {
    await idle();
  });
  fireEvent.click(await integrationCard(c.container, id));
  await settleFor(60);
  assert.ok(document.querySelector('[role="dialog"]'), `the ${id} dialog did not open`);
}

function box(key: string): HTMLInputElement {
  const el = dialogNow().querySelector<HTMLInputElement>(`[data-config-field="${key}"] input`);
  assert.ok(el, `the dialog rendered no field for ${key}`);
  return el;
}

/** The footer's Save button, whichever of its two labels it is wearing.
 *
 *  `"Save"` alone misses it for the whole of a save in flight, when it reads
 *  "Saving…" — which is precisely when the second half of a round-trip test
 *  goes looking for it, and reads as "the dialog has no Save button". */
function saveButton(): HTMLButtonElement | undefined {
  return [...dialogNow().querySelectorAll("button")].find((b) => /^Sav(e|ing…)$/.test(b.textContent?.trim() ?? ""));
}

/** Click Save and return the config the dialog actually POSTed.
 *
 *  Asserts the button is ENABLED first: a disabled Save is the exact failure
 *  mode that made reporting a clearing only on blur wrong, and a click on it is
 *  a silent no-op the `until` below would then blame on the network.
 *
 *  Waits for the save to COMPLETE, not merely for the request to go out. The
 *  dialog re-seeds its form from the state the server answered with, and until
 *  that lands a caller reading the field back is reading what it typed rather
 *  than what was stored. Save going disabled again is that signal: it means
 *  `localConfig` and a fresh `initialConfig(state)` now agree. */
async function save(id: string): Promise<Record<string, unknown>> {
  const button = saveButton();
  assert.ok(button, "the dialog has no Save button");
  assert.equal(button.disabled, false, "Save is disabled — the form never registered the edit");
  const before = server.posts.length;
  fireEvent.click(button);
  await until(
    () => server.posts.some((p, i) => i >= before && p.path === `/api/integrations/${id}/config`),
    () => `no config POST for ${id}; saw ${server.posts.map((p) => p.path).join(", ") || "nothing"}`,
  );
  // BOTH, and the label is the half that matters. `disabled` alone is true for
  // the whole of a save in flight as well (`disabled={!schemaDirty || isSaving}`),
  // so waiting on it returned the instant the request went out — and the next
  // edit the test made was then overwritten by handleSave's own re-seed landing
  // late. The label going back to "Save" says isSaving is false; `disabled`
  // saying so too says the form and the state the server answered with agree.
  await actUntil(
    () => saveButton()?.disabled === true && saveButton()?.textContent?.trim() === "Save",
    () => `${id} never finished saving — Save reads "${saveButton()?.textContent?.trim()}"`,
  );
  const post = server.posts.filter((p) => p.path === `/api/integrations/${id}/config`).at(-1)!;
  return (post.body as { config: Record<string, unknown> }).config;
}

describe("an unset number field, opened and saved", () => {
  for (const { id, key, dirtyKey, dirtyValue } of UNSET) {
    test(`${id}: ${key} opens EMPTY, not 0`, async () => {
      await openCard(id);
      assert.equal(box(key).value, "", `${id}.${key} rendered a number nobody set`);
      cleanup();
    });

    test(`${id}: saving for another reason invents no ${key}`, async () => {
      // The one that costs money. SenSource took 3,527 vendor-side failures in
      // five days; a poll interval invented by a click in and a click out is a
      // request rate nobody chose, against exactly that API.
      await openCard(id);
      fireEvent.change(box(dirtyKey), { target: { value: dirtyValue } });
      const config = await save(id);
      assert.equal(
        typeof config[key] === "number",
        false,
        `${id}.${key} was saved as the number ${JSON.stringify(config[key])} without the operator ever touching it`,
      );
      assert.equal(config[key], "", `${id}.${key} saved as ${JSON.stringify(config[key])} rather than blank`);
      cleanup();
    });

    test(`${id}: a click in and a click out of ${key} invents no number`, async () => {
      await openCard(id);
      fireEvent.focus(box(key));
      fireEvent.blur(box(key));
      assert.equal(box(key).value, "", `${id}.${key} filled itself in on a focus and a blur`);
      assert.equal(saveButton()?.disabled, true, `a focus and a blur on ${id}.${key} made the form dirty`);
      cleanup();
    });

    test(`${id}: a typed ${key} is saved, and clearing it takes it back out`, async () => {
      await openCard(id);
      fireEvent.change(box(key), { target: { value: "900" } });
      const saved = await save(id);
      assert.equal(saved[key], 900, `${id}.${key} did not store a typed value`);

      // And back out again. The dialog re-seeds from what the server returned,
      // so this is the operator reopening a field that now HAS a value and
      // emptying it — the path that used to be impossible, because the box
      // sprang back to a number on blur.
      await actUntil(() => box(key).value === "900", () => `${id}.${key} never showed the saved value`);
      fireEvent.change(box(key), { target: { value: "" } });
      fireEvent.blur(box(key));
      const cleared = await save(id);
      assert.equal(cleared[key], "", `${id}.${key} could not be cleared: saved ${JSON.stringify(cleared[key])}`);
      cleanup();
    });
  }
});

// ── A stored value the field's own bounds now reject ─────────────────────────
//
// Bounds are declared on the descriptor and enforced by NumberInput's clamp, and
// a field can be given one AFTER an operator has already stored a value outside
// it — which is exactly what happened on this branch: propresenter.pollMs gained
// `min: 200` and ross-tsl.port gained `min: 1, max: 65535`, with installs
// already holding 100 and whatever else. The blur used to clamp whatever the box
// held whether or not anything had been typed into it, so opening the card,
// looking at the field and closing it rewrote the stored number: pollMs 100 ->
// 200 is a five-fold request-rate increase from a gesture that changed nothing,
// committed to disk by the next save made for any other reason.
//
// Driven through the real dialog rather than over NumberInput alone, because the
// dialog is where "did this make the form dirty" is answered, and a Save button
// that goes live is what turns a display change into a stored one.

/** Every number field that declares a bound, and a stored value outside it that
 *  the form will really SHOW.
 *
 *  `min - 1` only where `min > 1`, because initialConfig reads any stored number
 *  not `> 0` as ABSENT and prefills the default in its place — so for a field
 *  whose floor is 1 there is no below-the-floor value that ever reaches the box,
 *  and a case seeded with 0 would be testing the prefill rather than the clamp.
 *  Above `max` is always reachable. */
const OUT_OF_BOUNDS: { id: string; key: string; stored: number; why: string }[] = fields.flatMap((f) => {
  const out: { id: string; key: string; stored: number; why: string }[] = [];
  if (typeof f.field.min === "number" && f.field.min > 1) {
    out.push({ id: f.id, key: f.field.key, stored: f.field.min - 1, why: `below min ${f.field.min}` });
  }
  if (typeof f.field.max === "number") {
    out.push({ id: f.id, key: f.field.key, stored: f.field.max + 1, why: `above max ${f.field.max}` });
  }
  return out;
});

describe("a stored number outside the field's bounds", () => {
  test("nine reachable cases, across six bounded fields", () => {
    // EXACT, like the counts above it. A new bound on a number field is a new
    // way for an already-stored value to be outside it, and it should arrive
    // here rather than be covered by luck. Six of the thirteen number fields
    // declare a bound: five declare both a floor and a ceiling, one
    // (propresenter.pollMs) declares only a floor. Nine rather than eleven
    // because companion.port and ross-tsl.port floor at 1, and nothing below
    // that survives initialConfig — see OUT_OF_BOUNDS.
    const bounded = [...new Set(OUT_OF_BOUNDS.map((o) => `${o.id}.${o.key}`))].sort();
    assert.deepEqual(bounded, [
      "companion.port",
      "propresenter.pollMs",
      "ross-tsl.port",
      "sensource.attendancePollSeconds",
      "sensource.pollSeconds",
      "sensource.safeSpacePollSeconds",
    ]);
    assert.equal(
      OUT_OF_BOUNDS.length,
      9,
      `out-of-bounds cases: ${OUT_OF_BOUNDS.map((o) => `${o.id}.${o.key} ${o.why}`).join(", ")}`,
    );
  });

  for (const { id, key, stored, why } of OUT_OF_BOUNDS) {
    test(`${id}: ${key} stored ${stored} (${why}) survives a click in and a click out`, async () => {
      await openCard(id, { [key]: stored });
      assert.equal(box(key).value, String(stored), `${id}.${key} did not open showing its stored value`);
      fireEvent.focus(box(key));
      fireEvent.blur(box(key));
      assert.equal(
        box(key).value,
        String(stored),
        `${id}.${key} rewrote a stored ${stored} that the operator only looked at`,
      );
      assert.equal(saveButton()?.disabled, true, `a focus and a blur on ${id}.${key} made the form dirty`);
      cleanup();
    });
  }
});

describe("oauth-device is masked the same way password is", () => {
  // A unit test on initialConfig() directly, with a synthetic descriptor —
  // the real YouTube descriptor is exercised end-to-end in
  // integration-youtube-connect-field.test.tsx, but that only proves the SAVE
  // path skips a mask. This is the seed path: what the form starts out
  // holding before the operator touches anything.
  const descriptor: IntegrationDescriptor = {
    id: "fixture",
    kind: "control",
    label: "Fixture",
    docs: "fixture",
    configSchema: [{ key: "refreshToken", label: "Connection", type: "oauth-device" }],
  };

  test("a stored secret seeds the FORM's own mask, not the server's transport mask", () => {
    const state = { id: "fixture", enabled: true, connection: "connected", message: null, config: { refreshToken: "••••" } } as IntegrationState;
    const seeded = initialConfig(descriptor, state);
    // FORM_MASK is 8 bullets; the server's own MASK (what state.config carries)
    // is 4. Asserting the length, not just "some bullets", is what tells apart
    // "masked like every other secret field" from "passed the raw value
    // through unmasked because oauth-device is not in the password branch".
    assert.equal(seeded.refreshToken, "••••••••");
  });

  test("no stored secret seeds blank, same as an unset password field", () => {
    const state = { id: "fixture", enabled: true, connection: "disconnected", message: null, config: { refreshToken: "" } } as IntegrationState;
    const seeded = initialConfig(descriptor, state);
    assert.equal(seeded.refreshToken, "");
  });
});
