// The reads behind the note-categories row: when they are made, when they are not, and
// what a failure leaves. Driven through the real hook over a stubbed server that keeps a
// log of every request, so "reads nothing" and "reads once more" are counted, not assumed.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { useNoteCategories } = await import("./use-note-categories.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

type Input = ReturnType<typeof useNoteCategories>;

const ROLES = [{ id: "r1", name: "Audio", members: ["Audio"] }];
const readsOf = (urls: string[], part: string) => urls.filter((u) => u.includes(part)).length;

function server(setup: { landing: string[]; failRoles?: boolean; categories502?: boolean }) {
  const urls: string[] = [];
  const f = stubFetchWithLog((url) => {
    urls.push(url);
    if (url.includes("/api/servicecue/config")) return ok({ serviceTypeIds: setup.landing });
    if (url.includes("/api/servicecue/roles")) {
      if (setup.failRoles) throw new TypeError("fetch failed");
      return ok(ROLES);
    }
    if (url.includes("/api/servicecue/note-categories")) return setup.categories502 ? reply(502, { error: "Planning Center is down" }) : ok(["Audio", "Prayer"]);
    return ok({});
  });
  return { ...f, urls };
}

/** The hook's answer, held for the test; `set` re-renders it with new arguments. */
function probe(first: { pcoConfigured: boolean; planId: string | null }) {
  const box: { input: Input | null } = { input: null };
  function Probe(props: typeof first): React.ReactElement {
    box.input = useNoteCategories(props);
    return React.createElement("output", null, "x");
  }
  const view = render(React.createElement(Probe, first));
  return { box, set: (next: typeof first) => view.rerender(React.createElement(Probe, next)) };
}

test("reads the roles and each ticked type's categories, and answers known", async () => {
  const s = server({ landing: ["wk", "mid"] });
  try {
    const p = probe({ pcoConfigured: true, planId: "p1" });
    await eventually(() => assert.equal(p.box.input?.known, true));
    assert.deepEqual(p.box.input?.landingTypeIds, ["wk", "mid"]);
    assert.deepEqual(p.box.input?.roles, ROLES);
    assert.deepEqual([...(p.box.input?.catsByType.keys() ?? [])], ["wk", "mid"]);
    assert.equal(readsOf(s.urls, "/note-categories"), 2);
  } finally {
    s.restore();
  }
});

test("without Planning Center it reads nothing at all", async () => {
  const s = server({ landing: ["wk"] });
  try {
    const p = probe({ pcoConfigured: false, planId: null });
    await settle();
    await settle();
    assert.deepEqual(s.urls.filter((u) => u.startsWith("/api/servicecue")), []);
    assert.equal(p.box.input?.known, false);
  } finally {
    s.restore();
  }
});

test("with no landing type ticked it asks Planning Center nothing: no roles, no categories", async () => {
  const s = server({ landing: [] });
  try {
    const p = probe({ pcoConfigured: true, planId: "p1" });
    await eventually(() => assert.equal(p.box.input?.known, true));
    assert.equal(readsOf(s.urls, "/api/servicecue/roles"), 0);
    assert.equal(readsOf(s.urls, "/note-categories"), 0);
  } finally {
    s.restore();
  }
});

test("reads again when the live plan changes, and not otherwise, and never on a timer", async () => {
  const s = server({ landing: ["wk"] });
  try {
    const p = probe({ pcoConfigured: true, planId: "p1" });
    await eventually(() => assert.equal(p.box.input?.known, true));
    const settled = s.urls.length;
    p.set({ pcoConfigured: true, planId: "p1" });
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(s.urls.length, settled, "a re-render with the same plan read again");
    p.set({ pcoConfigured: true, planId: "p2" });
    await eventually(() => assert.equal(s.urls.length > settled, true));
    for (let i = 0; i < 5; i++) await settle();
    const afterChange = s.urls.length;
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(s.urls.length, afterChange, "something reads on its own");
  } finally {
    s.restore();
  }
});

test("a failed read leaves it unknown, and says so in the log; it is not an empty answer", async () => {
  const s = server({ landing: ["wk"], failRoles: true });
  try {
    const p = probe({ pcoConfigured: true, planId: "p1" });
    await eventually(() => assert.ok(s.logs.some((l) => l.tag === "home" && /note categories/.test(l.message)), JSON.stringify(s.logs)));
    assert.equal(p.box.input?.known, false);
  } finally {
    s.restore();
  }
});

test("Planning Center answering 502 for the categories leaves it unknown and logs [home]; it is not an empty answer", async () => {
  const s = server({ landing: ["wk"], categories502: true });
  try {
    const p = probe({ pcoConfigured: true, planId: "p1" });
    await eventually(() => assert.ok(s.logs.some((l) => l.tag === "home" && /note categories/.test(l.message)), JSON.stringify(s.logs)));
    assert.equal(p.box.input?.known, false, "a failed read said it knew, with nothing uncovered");
  } finally {
    s.restore();
  }
});
