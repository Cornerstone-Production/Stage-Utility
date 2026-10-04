// The slot editor's "By position" picker, rendered, over a stubbed server.
//
// What is under test is what an operator can be misled by: which service type's
// positions the list shows (the one being EDITED, not the live one), whether a
// position the edited type lacks can still be seen and unticked, and whether a
// note survives the position being moved between groups.
//
// NOT unit-tested here, and driven in a browser instead: the pinned header, the
// tag colours and the list's scroll. jsdom loads no stylesheet and reports every
// offsetHeight as 0, so none of them is observable.
//
// Assertions are on strings and booleans, never a DOM node, because node:assert
// inspecting a live jsdom element does not terminate in useful time.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const LIVE = "st-live";
const EDITED = "st-edited";

/** Every positions URL the picker asked for. */
let urls: string[] = [];

const POSITIONS: Record<string, { teamId: string; teamName: string; positionName: string }[]> = {
  [LIVE]: [{ teamId: "t0", teamName: "Live Team", positionName: "Live Only Position" }],
  [EDITED]: [
    { teamId: "t1", teamName: "Band", positionName: "Drums" },
    { teamId: "t1", teamName: "Band", positionName: "Bass" },
    { teamId: "t2", teamName: "Vocals", positionName: "Lead Vocal" },
  ],
};
const ALL = {
  positions: [
    { serviceTypeId: EDITED, serviceTypeName: "Edited", teamId: "t1", teamName: "Band", positionName: "Drums" },
    { serviceTypeId: LIVE, serviceTypeName: "Live", teamId: "t0", teamName: "Live Team", positionName: "Live Only Position" },
    { serviceTypeId: "st-kick", serviceTypeName: "Kickoff", teamId: "t3", teamName: "Tech", positionName: "Click" },
    { serviceTypeId: "st-kick", serviceTypeName: "Kickoff", teamId: "t3", teamName: "Tech", positionName: "Playback" },
  ],
  failed: [] as string[],
};

const STATE = {
  appName: "Stage",
  hourCycle: "12h",
  pcoConfigured: true,
  serviceTypeId: LIVE,
  serviceTypeName: "Live",
  planId: "p1",
  timezone: "UTC",
  slotsByView: {},
  slotsByLayoutObject: {},
} as unknown as StageState;

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  if (url.includes("/api/events/subscribe")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  let body: unknown = {};
  if (url.includes("/api/team-positions")) {
    urls.push(url);
    const q = new URL(url, "http://localhost:8788").searchParams;
    body = q.get("all") === "1" ? ALL : (POSITIONS[q.get("serviceTypeId") ?? LIVE] ?? []);
  } else if (url.includes("/api/state")) {
    body = STATE;
  }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PositionRangeEditor } = await import("./position-picker.js");
const { __setEditingTargetForTests } = await import("./editing-target.js");
const { __resetForTests } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

/** Holds the slot's positions the way the editor does, and prints them. */
function Harness({ initial }: { initial: SlotPositionMatch[] }): React.ReactElement {
  const [positions, setPositions] = React.useState(initial);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(PositionRangeEditor, { positions, onChange: setPositions }),
    React.createElement("span", { "data-testid": "value" }, JSON.stringify(positions)),
  );
}

let client: InstanceType<typeof QueryClient> | null = null;

async function mount(initial: SlotPositionMatch[]) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(Harness, { initial })));
  await settle();
}

async function openPicker() {
  await act(async () => {
    fireEvent.click(document.querySelector("button[aria-haspopup='dialog']") as HTMLElement);
  });
  await settle();
}

/** The option rows, as text, in document order. */
const rows = () =>
  Array.from(document.querySelectorAll("[role='option']")).map((o) => {
    const label = (o.querySelector("span")?.textContent ?? "").replace(/\s+/g, " ").trim();
    const tag = o.querySelector("span[title]")?.textContent;
    return tag ? `${label} [${tag}]` : label;
  });
const option = (label: string) => {
  const hit = Array.from(document.querySelectorAll("[role='option']")).find((o) =>
    (o.textContent ?? "").trim().startsWith(label),
  );
  assert.ok(hit, `no option starting with ${label}; have ${JSON.stringify(rows())}`);
  return hit as HTMLElement;
};
const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
};
const flipSwitch = async () => {
  await click(screen.getByRole("switch"));
};
const type = async (text: string) => {
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText("Search positions…"), { target: { value: text } });
  });
  await settle();
};
const value = () => screen.getByTestId("value").textContent ?? "";

beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
  __setEditingTargetForTests({ serviceTypeId: EDITED, planId: null });
  urls = [];
});
afterEach(async () => {
  cleanup();
  await settle();
  client?.clear();
  client = null;
});
after(async () => {
  __setEditingTargetForTests(null);
  await settle();
  teardown();
});

describe("PositionRangeEditor", () => {
  test("lists the EDITED service type's positions, asking for that type, not the live one", async () => {
    await mount([]);
    await openPicker();
    assert.ok(
      urls.some((u) => u.includes(`serviceTypeId=${EDITED}`)),
      `the request must name the edited type; asked ${JSON.stringify(urls)}`,
    );
    assert.ok(
      !urls.some((u) => u.includes(`serviceTypeId=${LIVE}`) || !u.includes("serviceTypeId=")),
      `no request may fall back to the live type; asked ${JSON.stringify(urls)}`,
    );
    const r = rows();
    assert.ok(r.includes("Drums"), JSON.stringify(r));
    assert.ok(!r.some((x) => x.startsWith("Live Only Position")), "the live type's positions must not be listed");
  });

  test("a ticked position the edited type lacks appears in Selected, tagged, and can be unticked", async () => {
    await mount([{ name: "Vocals (BGVs)" }, { name: "Drums" }]);
    await openPicker();
    const r = rows();
    assert.equal(r[0], "Vocals (BGVs) [not in this service type]", JSON.stringify(r));
    assert.equal(r[1], "Drums · Band", JSON.stringify(r));
    await click(option("Vocals (BGVs)"));
    assert.equal(value(), JSON.stringify([{ name: "Drums" }]));
  });

  test("Selected is pinned above Any position and the teams, in tick order", async () => {
    await mount([]);
    await openPicker();
    await click(option("Lead Vocal"));
    await click(option("Drums"));
    const r = rows();
    assert.deepEqual(r.slice(0, 2), ["Lead Vocal · Vocals", "Drums · Band"], JSON.stringify(r));
    assert.equal(r[2], "Any position");
    assert.deepEqual(r.slice(3), ["Bass"], "ticked positions leave the team list");
    assert.match(document.body.textContent ?? "", /Selected\s*2 · tick to remove/);
    assert.equal(value(), JSON.stringify([{ name: "Lead Vocal" }, { name: "Drums" }]));
  });

  test("the switch is off by default, loads other types on, and tags each row with its type", async () => {
    await mount([]);
    await openPicker();
    assert.equal(screen.getByRole("switch").getAttribute("aria-checked"), "false");
    assert.ok(!urls.some((u) => u.includes("all=1")), "other types must not be read until asked for");
    await flipSwitch();
    assert.ok(urls.some((u) => u.includes("all=1")));
    const r = rows();
    assert.ok(r.includes("Live Only Position · Live Team [Live]"), JSON.stringify(r));
    assert.ok(r.includes("Click · Tech [Kickoff]"), JSON.stringify(r));
    assert.ok(!r.some((x) => x.startsWith("Drums") && x.endsWith("[Edited]")), "a position this type has is not repeated under its own type");
    assert.match(document.body.textContent ?? "", /Kickoff\s*other service type/);
  });

  test("a ticked position knows its type once other types are read: 'Kickoff only'", async () => {
    await mount([{ name: "Click" }]);
    await openPicker();
    assert.equal(rows()[0], "Click [not in this service type]");
    await flipSwitch();
    assert.equal(rows()[0], "Click [Kickoff only]", JSON.stringify(rows()));
  });

  test("ticking another type's position adds a plain { name } and moves it into Selected", async () => {
    await mount([]);
    await openPicker();
    await flipSwitch();
    await click(option("Playback"));
    assert.equal(value(), JSON.stringify([{ name: "Playback" }]));
    assert.equal(rows()[0], "Playback [Kickoff only]", JSON.stringify(rows()));
  });

  test("search covers Selected, and Any position stays when it matches", async () => {
    await mount([{ name: "Vocals (BGVs)" }, { name: "Drums" }]);
    await openPicker();
    await type("vocals");
    const r = rows();
    assert.equal(r[0], "Vocals (BGVs) [not in this service type]", JSON.stringify(r));
    assert.ok(!r.some((x) => x.startsWith("Drums")), "Selected is filtered too");
    assert.ok(!r.includes("Any position"), "Any position does not match 'vocals'");
    await type("any");
    assert.deepEqual(rows(), ["Any position"]);
  });

  test("a note survives moving between groups, and unticking removes it with the entry", async () => {
    await mount([{ name: "Drums", notesStartsWith: "2" }]);
    await openPicker();
    assert.equal(rows()[0], "Drums · Band");
    assert.equal(value(), JSON.stringify([{ name: "Drums", notesStartsWith: "2" }]));
    await click(option("Lead Vocal"));
    assert.equal(
      value(),
      JSON.stringify([{ name: "Drums", notesStartsWith: "2" }, { name: "Lead Vocal" }]),
      "ticking another position must not disturb the first one's note",
    );
    await click(option("Drums"));
    assert.equal(value(), JSON.stringify([{ name: "Lead Vocal" }]));
  });

  test("a type that could not be read is named, and the types that could still list", async () => {
    ALL.failed = ["Wednesday"];
    try {
      await mount([]);
      await openPicker();
      await flipSwitch();
      assert.match(document.body.textContent ?? "", /Couldn't load: Wednesday\./);
      assert.ok(rows().includes("Click · Tech [Kickoff]"));
    } finally {
      ALL.failed = [];
    }
  });

  test("the trigger lists every ticked name", async () => {
    await mount([{ name: "Vocals (BGVs)" }, {}, { name: "Drums" }]);
    const trigger = document.querySelector("button[aria-haspopup='dialog']") as HTMLElement;
    assert.equal(trigger.textContent, "Vocals (BGVs) · Any position · Drums");
  });
});
