// The `companion.press` action's editor: the picker, and the three numbers.
//
// Both halves of this write the STORED IDENTITY, and both were wired in a way
// that is invisible until a cue silently stops pressing:
//
//  - PICKING A BUTTON writes the fingerprint in the same save that clears the
//    status. Re-picking is what an operator does about a `button missing` cue,
//    and a pick that saved only the coordinates would leave `status: "missing"`
//    behind — so the action would go on refusing the press with the right button
//    now chosen on screen. Asserted on the patch the editor emits.
//  - TYPING A COORDINATE clears it. The `pageId`, `actionIds`, `label` and
//    `status` all describe a button the operator has just said is somewhere
//    else. Leaving them is the same refusal, arrived at from the other
//    direction: the numbers read as an escape hatch and were not one.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and was killed with no line number.
//
// NOT unit-tested here, and driven in a browser instead: that the picker's list
// scrolls, that its page headings stick, and that the dialog opens above the
// overlay rather than behind it. jsdom loads no stylesheet and reports every
// offsetHeight as 0, so none of the three is observable in it at all.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

interface StubButton {
  page: number;
  pageId: string;
  pageName: string;
  row: number;
  col: number;
  label: string;
  drives: string[];
  actionIds: string[];
}

let BUTTONS: StubButton[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  let body: unknown = {};
  if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: BUTTONS };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CompanionPressFields, typedCoordinate } = await import("./companion-cues.js");

/** Several macrotasks: the query, its re-render and the portal are separate turns. */
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

/** A cue whose button the last reconcile could not find. */
const MISSING_PARAMS: Record<string, string | number> = {
  page: 1,
  row: 0,
  col: 1,
  pageId: "page-one",
  label: "Projectors ON",
  actionIds: "a1,a2",
  status: "missing",
  lastSeenAt: "2026-09-01T09:00:00.000Z",
  movedFrom: "p1 r4 c6",
};

let client: InstanceType<typeof QueryClient> | null = null;
/** Every patch the fields asked their parent to merge. */
let patches: Record<string, string | number>[] = [];

async function mount(params = MISSING_PARAMS) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(CompanionPressFields, {
        params,
        onChange: (patch: Record<string, string | number>) => {
          patches.push(patch);
        },
      }),
    ),
  );
  await settle();
  return view;
}

beforeEach(() => {
  patches = [];
  BUTTONS = [
    {
      page: 3,
      pageId: "page-three",
      pageName: "Room A: Cameras",
      row: 2,
      col: 5,
      label: "Record Toggle",
      drives: ["generic-pjlink"],
      actionIds: ["b9", "b1"],
    },
  ];
});
afterEach(async () => {
  cleanup();
  client?.clear();
  await settle();
});
after(async () => {
  cleanup();
  await settle();
  teardown();
});

describe("picking a button", () => {
  test("writes the whole fingerprint, and clears the missing status with it", async () => {
    await mount();
    fireEvent.click(screen.getByText("Projectors ON"));
    await settle();
    fireEvent.click(screen.getByText("Record Toggle"));
    await settle();

    assert.equal(patches.length, 1, "picking a button emitted no patch");
    const p = patches[0]!;
    // The coordinates, so the press goes to the right key.
    assert.equal(p.page, 3);
    assert.equal(p.row, 2);
    assert.equal(p.col, 5);
    // The identity, so the next reconcile can FOLLOW it rather than adopt it.
    assert.equal(p.pageId, "page-three");
    assert.equal(p.actionIds, "b1,b9", "the action ids were not stored sorted");
    assert.equal(p.label, "Record Toggle");
    // And the refusal is lifted in the SAME patch. Without this the action goes
    // on failing with the right button chosen on screen.
    assert.equal(p.status, "in-place");
    assert.equal(p.movedFrom, "", "a stale 'moved from' survived the pick");
  });
});

describe("typing a coordinate", () => {
  /** Type into one of the three number fields. */
  function type(label: string, value: string): void {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }

  test("clears the identity it invalidates, so the next reconcile adopts it", async () => {
    await mount();
    type("Row", "4");
    await settle();

    assert.equal(patches.length, 1, "typing a row emitted no patch");
    const p = patches[0]!;
    assert.equal(p.row, 4);
    // Every field describing the button that is no longer there.
    assert.equal(p.pageId, "", "the old page id survived a hand-typed row");
    assert.equal(p.actionIds, "", "the old action ids survived a hand-typed row");
    assert.equal(p.status, "", "status: missing survived — the action still refuses");
    assert.equal(p.movedFrom, "", "a move nobody made survived a hand-typed row");
    assert.equal(p.label, "", "the old label survived, so the row names the wrong button");
    // The other two coordinates are untouched: this is one field, not a reset.
    assert.equal("page" in p, false);
    assert.equal("col" in p, false);
  });

  test("the page and the column clear it too — all three are the same hatch", async () => {
    await mount();
    type("Page", "7");
    type("Column", "9");
    await settle();

    assert.equal(patches.length, 2);
    assert.equal(patches[0]!.page, 7);
    assert.equal(patches[1]!.col, 9);
    for (const p of patches) {
      assert.equal(p.pageId, "");
      assert.equal(p.actionIds, "");
      assert.equal(p.status, "");
      assert.equal(p.movedFrom, "");
      assert.equal(p.label, "");
    }
  });

  test("typedCoordinate is the one copy of that list", () => {
    // PURE, and asserted directly as well as through the fields: three
    // NumberInputs each spelling the list out is how one of them drops a field.
    assert.deepEqual(typedCoordinate({ page: 2 }), {
      page: 2,
      pageId: "",
      actionIds: "",
      status: "",
      movedFrom: "",
      label: "",
    });
  });
});
