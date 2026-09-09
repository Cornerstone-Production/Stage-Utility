// The plan switcher, rendered, over a stubbed server.
//
// What is under test is the part an operator can be misled by: which board the
// editor opens on, whether the badge tells the truth about it, whether the
// target survives anything it must not survive, and whether an unsaved buffer
// can be thrown away without being asked about.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and had to be killed, reporting no line number. Every assertion
// here is on a boolean or a string.
//
// NOT unit-tested here, and driven in a browser instead: that the grid below
// re-seeds from the new target and that the badge is green rather than amber.
// jsdom loads no stylesheet, so a colour is not observable at all, and the
// re-seed needs the whole settings hook — five query hooks, a live SSE state,
// confirm() and toast().

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const SUN = "st-sun";
const YOUTH = "st-youth";
const LIVE_PLAN = "s1";

let mode: PlanSwitcherMode = "upcoming";
let unavailable: string | undefined;

/** Every slot-targets URL the components asked for, so a test can prove the
 *  editor's read followed the switcher rather than the machine. */
let slotTargetUrls: string[] = [];

/** EVERY request the stub was handed, method and body included.
 *
 *  The switcher moves the editor and must write NOTHING — not the plan, not the
 *  service type, not the mode. Recording only slot-target URLs could not see a
 *  `void ipc("stage:setPlan", …)` added to the arrows, which would point every
 *  screen in the building at whatever week the operator was reading. */
let requests: { url: string; method: string; body: string | null }[] = [];

/** Does the stubbed server know this plan's date?
 *
 *  The real one does for any plan in its upcoming cache, and does not for one
 *  that has aged out. Both matter: the date has to travel with a save (or the
 *  override can never be pruned), and its absence must not be papered over with
 *  the LIVE plan's date. Default false, which is the case the older tests here
 *  were written against. */
let datesKnown = false;

const PLANS: UpcomingPlan[] = [
  { serviceTypeId: YOUTH, serviceTypeName: "Youth", planId: "y1", title: "Youth night", sortDate: "2026-09-09T23:00:00Z", dates: "September 9, 2026", isCurrent: false },
  { serviceTypeId: SUN, serviceTypeName: "Sunday", planId: LIVE_PLAN, title: "Sunday", sortDate: "2026-09-13T14:00:00Z", dates: "September 13, 2026", isCurrent: true },
  { serviceTypeId: SUN, serviceTypeName: "Sunday", planId: "s2", title: "Sunday", sortDate: "2026-09-20T14:00:00Z", dates: "September 20, 2026", isCurrent: false },
];

const STATE = {
  appName: "Stage",
  accentColor: null,
  hourCycle: "12h",
  serviceTypeId: SUN,
  serviceTypeName: "Sunday",
  planId: LIVE_PLAN,
  planTitle: "Sunday",
  planDates: "September 13, 2026",
  timezone: "UTC",
  slotsByView: {},
  slotsByLayoutObject: {},
} as unknown as StageState;

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  requests.push({
    url,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : null,
  });
  let body: unknown = {};
  if (url.includes("/api/plans/upcoming")) {
    body = { plans: unavailable ? [] : PLANS, cacheAgeMs: 0, ...(unavailable ? { unavailable } : {}) };
  } else if (url.includes("/slot-targets")) {
    slotTargetUrls.push(url);
    const q = new URL(url, "http://localhost:8788").searchParams;
    const row = datesKnown ? PLANS.find((p) => p.planId === q.get("planId")) : undefined;
    body = {
      scope: "view",
      key: "v1",
      serviceTypeId: q.get("serviceTypeId"),
      serviceTypeName: q.get("serviceTypeId") === SUN ? "Sunday" : "Youth",
      planId: q.get("planId"),
      planDates: row?.dates ?? null,
      planSortDate: row?.sortDate ?? null,
      defaultSlots: [],
      overrideSlots: null,
    };
  } else if (url.includes("/api/state")) {
    body = { ...STATE, planSwitcherMode: mode };
  }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PlanSwitcher } = await import("./plan-switcher.js");
const { useSlotsTarget } = await import("./slots-target-pill.js");
const { registerTargetGuard, __setEditingTargetForTests } = await import("./editing-target.js");
const { __resetForTests } = await import("../../main/use-stage-state.js");
const { invoke: ipc, __resetReplayCacheForTests } = await import("../../lib/api.js");
const { encodeTarget } = await import("./plan-switcher-step.js");
const { toast } = await import("../../components/ui/toast.js");

/** Several macrotasks: the state hydrate, the two queries and the re-renders
 *  they cause are separate turns, and one tick left the result order-dependent. */
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

/** Prints what the editor's hook resolved to, beside the switcher itself. */
function Probe(): React.ReactElement {
  const t = useSlotsTarget("view", "v1");
  return React.createElement(
    "div",
    null,
    React.createElement(PlanSwitcher, null),
    React.createElement(
      "span",
      { "data-testid": "editing" },
      `${t.editing.target.serviceTypeId}/${t.editing.target.planId}`,
    ),
    React.createElement("span", { "data-testid": "label" }, t.label),
    // The exact wire target a save would carry. A string, never an object — see
    // the note at the top about node:assert inspecting a DOM node.
    React.createElement("span", { "data-testid": "wire" }, JSON.stringify(t.wireTarget() ?? null)),
    React.createElement("button", { "data-testid": "announce", onClick: () => t.announceSaved() }, "save"),
    React.createElement(
      "button",
      { "data-testid": "default-side", onClick: () => t.setSide("default") },
      "default side",
    ),
    // The real save path: the same channel the slots editor calls, through the
    // real api.ts, so the recorded request body is what the server would get.
    React.createElement(
      "button",
      {
        "data-testid": "real-save",
        onClick: () => {
          void ipc("views:setSlots", { id: "v1", slots: [], target: t.wireTarget() }).catch(() => {});
        },
      },
      "real save",
    ),
  );
}

let client: InstanceType<typeof QueryClient> | null = null;

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    React.createElement(QueryClientProvider, { client }, React.createElement(Probe, null)),
  );
}

const badge = () =>
  document.querySelector("[data-plan-switcher-badge]")?.getAttribute("data-plan-switcher-badge") ?? "none";
const editingTarget = () => screen.getByTestId("editing").textContent ?? "";
const disabled = (label: string) => (screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled;
const press = async (label: string) => {
  await act(async () => {
    screen.getByRole("button", { name: label }).click();
  });
  await settle();
};
const wire = () => screen.getByTestId("wire").textContent ?? "";
/** Pick from the switcher's middle control. It renders a native <select>, so a
 *  change event on it is exactly what an operator's pick does. */
const pick = async (value: string) => {
  const select = document.querySelector("[data-plan-switcher] select") as HTMLSelectElement;
  assert.ok(select, "the switcher's middle control is a native select");
  await act(async () => {
    fireEvent.change(select, { target: { value } });
  });
  await settle();
};

beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
  __setEditingTargetForTests(null);
  registerTargetGuard("test", null);
  slotTargetUrls = [];
  requests = [];
  mode = "upcoming";
  unavailable = undefined;
  datesKnown = false;
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

describe("what the editor opens on", () => {
  test("the plan the machine is following, with a live badge and Now dead", async () => {
    mount();
    await settle();
    assert.equal(editingTarget(), `${SUN}/${LIVE_PLAN}`);
    assert.equal(badge(), "live");
    assert.equal(disabled("Now"), true, "Now with nowhere to go is a button that does nothing");
  });

  test("and the editor's own read asked the server for that target", async () => {
    mount();
    await settle();
    assert.equal(
      slotTargetUrls.some((u) => u.includes(`planId=${LIVE_PLAN}`)),
      true,
      "without the target in the request the server answers for its own plan, and the grid shows the wrong week's rows",
    );
  });
});

describe("stepping", () => {
  test("the next arrow moves the editor and the badge says so", async () => {
    mount();
    await settle();
    await press("Next plan");
    assert.equal(editingTarget(), `${SUN}/s2`);
    assert.equal(
      badge(),
      "editing",
      "a save landing on a board no screen is showing must not look the same as one that changed the wall",
    );
    assert.equal(
      slotTargetUrls.some((u) => u.includes("planId=s2")),
      true,
      "the grid re-reads for the new target",
    );
  });

  test("the previous arrow crosses service types in date order", async () => {
    mount();
    await settle();
    await press("Previous plan");
    assert.equal(editingTarget(), `${YOUTH}/y1`);
  });

  test("and stops at the ends rather than wrapping", async () => {
    mount();
    await settle();
    await press("Previous plan");
    assert.equal(disabled("Previous plan"), true);
    await press("Next plan");
    await press("Next plan");
    assert.equal(editingTarget(), `${SUN}/s2`);
    assert.equal(disabled("Next plan"), true);
  });

  test("Now comes back to the machine's plan", async () => {
    mount();
    await settle();
    await press("Next plan");
    assert.equal(disabled("Now"), false);
    await press("Now");
    assert.equal(editingTarget(), `${SUN}/${LIVE_PLAN}`);
    assert.equal(badge(), "live");
    assert.equal(disabled("Now"), true);
  });
});

// The switcher moves the EDITOR. Adding `void ipc("stage:setPlan", …)` to its
// go() left every test in this file green, and would have repointed every screen
// in the building at whatever week the operator was reading — silently, from a
// control whose whole promise is that it changes nothing on the wall.
//
// So this asserts the negative directly, over the real api.ts: every request the
// switcher causes is a GET, and none of them touches a route that decides what
// the machine follows.
describe("the switcher writes nothing", () => {
  /** The ONLY endpoints the switcher and the editor's read may touch, ever.
   *
   *  Everything the machine follows is set through /api/plan, /api/plan/mode,
   *  /api/plan/next, /api/service-type, /api/allowed-service-types or
   *  /api/plan-switcher-mode. None of them is on this list, and neither is
   *  anything else — a new endpoint of any kind, by any method, fails here and
   *  has to be justified. */
  const READS = ["/api/plans/upcoming", "/api/state", "/api/views/v1/slot-targets"];

  /** Distinct request paths, sorted, so the assertion is order-independent. */
  const paths = () =>
    [...new Set(requests.map((r) => new URL(r.url, "http://localhost:8788").pathname))].sort();

  test("stepping, picking and Now issue reads only", async () => {
    // Recorded from MOUNT, not from after it: /api/state and the plan list are
    // fetched once and cached, so a window that starts after mount would leave
    // the allowlist naming routes the test never sees and passing on an empty set.
    mount();
    await settle();

    await press("Next plan");
    await press("Previous plan");
    await press("Previous plan");
    await pick(encodeTarget({ serviceTypeId: SUN, planId: "s2" }));
    await press("Now");

    assert.equal(editingTarget(), `${SUN}/${LIVE_PLAN}`, "the controls really were driven");
    assert.ok(requests.length > 0, "and they really did talk to the server, so this is not vacuously green");

    const written = requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`);
    assert.deepEqual(
      written,
      [],
      "a write from the switcher changes what every screen in the building is showing",
    );

    assert.deepEqual(
      paths(),
      READS,
      "an ALLOWLIST, not a list of forbidden routes: the plan for this guard named /api/plan-mode, which is not a route at all (it is /api/plan/mode), and a denylist entry that can never match is a scan looking for nothing",
    );
  });

  test("and the dropdown in within-type mode is the same", async () => {
    mode = "within-type";
    mount();
    await settle();

    await pick(YOUTH);
    await press("Next plan");

    assert.equal(editingTarget(), `${YOUTH}/y1`, "the type dropdown really moved the editor");
    assert.deepEqual(
      requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.url}`),
      [],
      "the type dropdown moves the EDITOR — the Plan page is what changes the machine's service type",
    );
    assert.deepEqual(paths(), READS);
  });
});

// wireTarget() decides which board a save lands on, and returning undefined from
// it left every test green: the server then falls back to the plan the MACHINE is
// on, so an operator editing next Sunday pressed Save and overwrote this Sunday
// under a success toast.
describe("the board a save lands on", () => {
  test("is the plan the switcher is pointed at, with that plan's date", async () => {
    datesKnown = true;
    mount();
    await settle();
    await press("Next plan");

    assert.equal(editingTarget(), `${SUN}/s2`);
    assert.equal(
      wire(),
      JSON.stringify({
        kind: "plan",
        planId: "s2",
        serviceTypeId: SUN,
        sortDate: "2026-09-20T14:00:00Z",
      }),
      "no target means the server writes the LIVE plan's override while the editor shows another week",
    );
  });

  test("and that exact target travels on the save request", async () => {
    datesKnown = true;
    mount();
    await settle();
    await press("Next plan");
    requests = [];
    await press("real save");

    const save = requests.find((r) => r.url.includes("/api/views/v1/slots"));
    assert.equal(!!save, true, "the save request was made");
    assert.equal(save?.method, "POST");
    assert.equal(
      JSON.stringify(JSON.parse(save?.body ?? "{}").target ?? null),
      JSON.stringify({
        kind: "plan",
        planId: "s2",
        serviceTypeId: SUN,
        sortDate: "2026-09-20T14:00:00Z",
      }),
      "an omitted target is not an error the server can see — it just writes the wrong week",
    );
  });

  test("is the type's default on the Default side of a type the machine is not on", async () => {
    datesKnown = true;
    mount();
    await settle();
    await press("Previous plan");
    assert.equal(editingTarget(), `${YOUTH}/y1`);

    await press("default side");
    assert.equal(
      wire(),
      JSON.stringify({ kind: "default", serviceTypeId: YOUTH }),
      "the Default side writes the board that service type comes back to, never a plan override",
    );

    requests = [];
    await press("real save");
    const save = requests.find((r) => r.url.includes("/api/views/v1/slots"));
    assert.equal(
      JSON.stringify(JSON.parse(save?.body ?? "{}").target ?? null),
      JSON.stringify({ kind: "default", serviceTypeId: YOUTH }),
    );
  });
});

describe("when Planning Center cannot be reached", () => {
  test("both arrows are dead and the editor stays on the machine's plan", async () => {
    unavailable = "connect ECONNREFUSED";
    mount();
    await settle();
    assert.equal(editingTarget(), `${SUN}/${LIVE_PLAN}`);
    assert.equal(disabled("Next plan"), true);
    assert.equal(
      disabled("Previous plan"),
      true,
      "an arrow with no list behind it must be dead, not silently moving nowhere",
    );
  });

  test("and it says why", async () => {
    unavailable = "connect ECONNREFUSED";
    mount();
    await settle();
    assert.equal(!!screen.queryByText("Planning Center unreachable"), true);
  });
});

describe("the target is written to no storage, ever", () => {
  test("a reload must open on the live plan, so nothing is stored", async () => {
    mount();
    await settle();
    await press("Next plan");
    assert.equal(editingTarget(), `${SUN}/s2`, "the step happened");
    assert.equal(
      localStorage.length + sessionStorage.length,
      0,
      "a target restored from a previous session is how somebody edits last week's board believing it is this week's",
    );
  });

  test("and a target somebody left in storage is ignored", async () => {
    // The other half of the pair. The write test above catches a store that
    // rehydrates at module load; this one catches a store that reads per mount.
    // Between them every persistence a reasonable person would write is caught,
    // and neither is satisfied by prose about not persisting.
    sessionStorage.setItem("stage-utility.editing-target", JSON.stringify({ serviceTypeId: SUN, planId: "s2" }));
    localStorage.setItem("stage-utility.editing-target", JSON.stringify({ serviceTypeId: SUN, planId: "s2" }));
    try {
      mount();
      await settle();
      assert.equal(
        editingTarget(),
        `${SUN}/${LIVE_PLAN}`,
        "a fresh tab decides its target from stage state and nothing else",
      );
      assert.equal(badge(), "live");
    } finally {
      sessionStorage.clear();
      localStorage.clear();
    }
  });
});

describe("unsaved slot edits", () => {
  test("a guard that refuses keeps the editor where it was", async () => {
    let asked = 0;
    registerTargetGuard("test", async () => {
      asked++;
      return false;
    });
    mount();
    await settle();
    await press("Next plan");
    assert.equal(asked, 1, "the question has to be asked before the buffer is re-read away");
    assert.equal(editingTarget(), `${SUN}/${LIVE_PLAN}`);
    assert.equal(badge(), "live");
  });

  test("a guard that accepts lets it through", async () => {
    registerTargetGuard("test", async () => true);
    mount();
    await settle();
    await press("Next plan");
    assert.equal(editingTarget(), `${SUN}/s2`);
  });

  test("Now asks too", async () => {
    registerTargetGuard("test", async () => false);
    mount();
    await settle();
    await act(async () => {
      __setEditingTargetForTests({ serviceTypeId: SUN, planId: "s2" });
    });
    await settle();
    await press("Now");
    assert.equal(editingTarget(), `${SUN}/s2`, "Now discards a buffer exactly as an arrow does");
  });
});

describe("the pill's date label", () => {
  // Found in a browser, not here: stepping to another week left the LIVE plan's
  // date on the pill, and on a Default target — which has no plan at all — it
  // named a date beside a disabled button. The stub answers null for planDates
  // and planSortDate, exactly as the server does for a plan its cache has not got.
  test("does not fall back to the machine's plan once the editor has left it", async () => {
    mount();
    await settle();
    assert.equal(screen.getByTestId("label").textContent, "September 13, 2026", "on the live plan, stage state is the right fallback");
    await press("Next plan");
    assert.equal(
      screen.getByTestId("label").textContent,
      "This plan",
      "naming the live plan's date while another week is being edited points a save at the wrong week in the operator's head",
    );
  });
});

describe("the save toast", () => {
  /** Which toast variant the last announceSaved() raised. */
  let raised: string[] = [];
  const realSuccess = toast.success;
  const realInfo = toast.info;

  beforeEach(() => {
    raised = [];
    toast.success = () => void raised.push("success");
    toast.info = () => void raised.push("info");
  });
  after(() => {
    toast.success = realSuccess;
    toast.info = realInfo;
  });

  test("is ordinary while the editor is on the machine's plan", async () => {
    mount();
    await settle();
    await press("save");
    assert.deepEqual(raised, ["success"]);
  });

  test("is the off-target variant once it is not", async () => {
    mount();
    await settle();
    await press("Next plan");
    await press("save");
    assert.deepEqual(
      raised,
      ["info"],
      "a save that changed nothing on any screen must not read the same as one that changed the wall",
    );
  });
});
