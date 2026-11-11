// What's new: the read-only release dialog, reopened from the Updates card.
//
// What this file pins:
//   - the button is on the card, and pressing it is the ONLY thing that reads
//     the notes. Mounting Advanced must not fetch them (on demand, not on load);
//   - the dialog is the after-update dialog's body under "What's new in
//     <version>", with Close rather than Dismiss;
//   - closing it sends nothing at all. The after-update dialog's acknowledgement
//     lives on the server, and a stray dismiss from here would spend it;
//   - every answer draws something: notes, commit subjects, or one line saying
//     the notes could not be loaded with the release link. Never an empty body;
//   - with an update waiting, the card's pending list is "Coming in <tag>", so
//     the card does not carry two "What's new" labels meaning different things.
//
// WHAT THIS FILE CANNOT SEE — browser-only, checked by hand against the
// production bundle on a local server, in both themes and two accent colours:
//   - that the soft accent variant reads as the accent at low strength, with
//     the lighter accent text in dark. jsdom loads no stylesheet, so the
//     `bg-accent-soft` class resolves to nothing here and proves nothing.
//   - that the button sits at the end of the status line and wraps under it on
//     a narrow card, and that the loading line appears only on a slow answer.
//     jsdom lays nothing out.
// Focus it does see: where it lands on open and where it goes on close are
// tested below.
//
// Every version, tag and change line below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installDom, isPlumbing, settle, unmountAndTeardown } from "../../test-dom.js";
import type { UpdateStatus } from "@main/types/state";

const teardown = installDom();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubEventSource {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** What GET /api/update/release-notes answers with; an Error makes the request fail. */
let notesReply: unknown = null;
/** Every request the panel made, as `METHOD path`, plumbing excluded. */
let sent: string[] = [];
/** What the panel reported to the server's log. */
let logged: { tag: string; message: string }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  if (isPlumbing(url)) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  sent.push(`${init?.method ?? "GET"} ${url}`);
  if (url === "/api/log/client") logged.push(JSON.parse((init as { body: string }).body));
  if (url.includes("/api/update/release-notes") && notesReply instanceof Error) throw notesReply;
  const payload = url.includes("/api/update/release-notes")
    ? notesReply
    : url.includes("/api/update/lock")
      ? { active: false, reasons: [] }
      : {};
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { UpdatesPanel } = await import("./advanced-section.js");
const { ConfirmHost, TooltipProvider } = await import("../../components/ui/index.js");

after(() => unmountAndTeardown(cleanup, teardown));
beforeEach(() => {
  cleanup();
  sent = [];
  logged = [];
  notesReply = null;
});
afterEach(async () => {
  cleanup();
  await settle();
});

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    isGitRepo: false,
    canUpdate: true,
    selfRecovers: true,
    branch: "main",
    tracks: ["beta", "main"],
    version: "9.8.1",
    currentSha: null,
    currentDate: null,
    behind: 0,
    behindUserFacing: 0,
    currentTag: "v9.8.1",
    targetTag: "v9.8.1",
    releasesBehind: 0,
    tagBased: true,
    latestSha: null,
    latestDate: null,
    changelog: [],
    lastCheckedAt: "2020-01-02T00:00:00.000Z",
    phase: "idle",
    step: null,
    restartPending: false,
    lastResult: null,
    error: null,
    ...over,
  };
}

const RELEASE_URL = "https://github.com/example/releases/tag/v9.8.1";
const okReply = (over: Record<string, unknown> = {}) => ({
  ok: true,
  version: "9.8.1",
  releaseUrl: RELEASE_URL,
  source: "kept",
  notes: [
    { section: "New", lines: ["a pinned stage message"], omitted: 0 },
    { section: "Fixed", lines: ["timers stop with their item"], omitted: 0 },
  ],
  lines: [],
  intro: "No manual steps.",
  ...over,
});

async function mount(over: Partial<UpdateStatus> = {}) {
  const handlers = {
    handleCheckUpdates: async () => {},
    handleApplyUpdate: async () => {},
    handleSetAutoUpdate: async () => {},
  };
  const view = render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(UpdatesPanel, {
        updateStatus: status(over),
        autoUpdate: { mode: "manual", dayOfWeek: null, hour: 3 },
        handlers: handlers as unknown as Parameters<typeof UpdatesPanel>[0]["handlers"],
      }),
      React.createElement(ConfirmHost, null),
    ),
  );
  await settle();
  await settle();
  return view;
}

const notesReads = () => sent.filter((r) => r.includes("/api/update/release-notes"));

async function open() {
  fireEvent.click(screen.getByRole("button", { name: "What's new" }));
  // The answer resolves on microtasks after the click's own act() has closed;
  // let it land inside one, or React reports the update as escaping act.
  await settle();
  return eventually(() => screen.getByRole("dialog"));
}

describe("the What's new button", () => {
  test("sits on the Updates card and reads nothing until it is pressed", async () => {
    await mount();
    assert.ok(screen.getByRole("button", { name: "What's new" }));
    assert.deepEqual(notesReads(), [], "the notes were fetched on page load, not on demand");
  });

  test("is there when this install cannot update in place, too", async () => {
    // The early return for an install with no usable updater still prints the
    // running version, and the notes for it are no less readable.
    await mount({ canUpdate: false, updateBlockedReason: "Update from the command line." });
    assert.ok(screen.getByRole("button", { name: "What's new" }));
  });

  test("opens the release dialog read-only: the version in the title, Close at the foot", async () => {
    notesReply = okReply();
    await mount();
    const dialog = await open();
    await eventually(() => within(dialog).getByText("a pinned stage message"));
    assert.equal(within(dialog).getByRole("heading").textContent, "What's new in 9.8.1");
    assert.ok(within(dialog).getByText("No manual steps."), "the opening words are missing");
    assert.ok(within(dialog).getByText("timers stop with their item"));
    // Exact: the foot button and the corner X are the only buttons.
    assert.deepEqual(
      within(dialog).getAllByRole("button").map((b) => b.textContent?.trim()),
      ["Close", "Close"],
    );
    assert.deepEqual(notesReads(), ["GET /api/update/release-notes"]);
  });

  test("closing it, by either button or Escape, sends nothing to the server", async () => {
    notesReply = okReply();
    await mount();
    for (const how of ["foot", "corner", "escape"] as const) {
      const dialog = await open();
      await eventually(() => within(dialog).getByText("a pinned stage message"));
      const before = sent.length;
      if (how === "escape") fireEvent.keyDown(dialog, { key: "Escape" });
      else {
        const [foot, corner] = within(dialog).getAllByRole("button", { name: "Close" });
        fireEvent.click(how === "foot" ? foot : corner);
      }
      await eventually(() => assert.equal(screen.queryByRole("dialog"), null, `${how} did not close it`));
      await settle();
      assert.deepEqual(sent.slice(before), [], `closing by ${how} sent a request`);
    }
    assert.ok(!sent.some((r) => r.startsWith("POST")), `What's new wrote to the server:\n${sent.join("\n")}`);
  });

  test("a git checkout's commit subjects are drawn as a plain list", async () => {
    notesReply = okReply({ notes: [], lines: ["fix: a subject", "feat: another"], intro: null });
    await mount();
    const dialog = await open();
    await eventually(() => within(dialog).getByText("fix: a subject"));
    assert.ok(within(dialog).getByText("feat: another"));
  });

  test("notes that could not be loaded say so, with the release link, never an empty body", async () => {
    notesReply = { ok: false, version: "9.8.1", releaseUrl: RELEASE_URL, reason: "ENOTFOUND" };
    await mount();
    const dialog = await open();
    await eventually(() => within(dialog).getByText(/The release notes could not be loaded\./));
    assert.equal(within(dialog).getByRole("heading").textContent, "What's new in 9.8.1");
    const link = within(dialog).getByRole("link", { name: "Release page" });
    assert.equal(link.getAttribute("href"), RELEASE_URL);
    assert.equal(link.getAttribute("target"), "_blank");
    assert.ok(!within(dialog).queryByText(/ENOTFOUND/), "the log's reason leaked into the dialog");
  });

  test("a request that fails outright draws the same line, linking the running release, and logs it", async () => {
    notesReply = new Error("socket hang up");
    await mount();
    const dialog = await open();
    await eventually(() => within(dialog).getByText(/The release notes could not be loaded\./));
    const link = within(dialog).getByRole("link", { name: "Release page" });
    assert.match(link.getAttribute("href") ?? "", /\/releases\/tag\/v9\.8\.1$/);
    // The server never saw a failure it could log, so the browser reports it.
    await eventually(() => assert.ok(logged.some((l) => l.tag === "updater" && /release notes.*socket hang up/.test(l.message)), JSON.stringify(logged)));
  });

  test("a failed request on a version that names no release links the release list", async () => {
    notesReply = new Error("socket hang up");
    await mount({ version: "0.0.0", currentTag: null });
    const dialog = await open();
    const link = await eventually(() => within(dialog).getByRole("link", { name: "Release page" }));
    assert.match(link.getAttribute("href") ?? "", /\/releases$/, "a tag link for 0.0.0 is a 404");
  });

  test("focus lands on the foot Close on open, loaded or not, and goes back to the button on close", async () => {
    for (const reply of [okReply(), { ok: false, version: "9.8.1", releaseUrl: RELEASE_URL, reason: "offline" }]) {
      cleanup();
      notesReply = reply;
      await mount();
      const trigger = screen.getByRole("button", { name: "What's new" });
      const dialog = await open();
      await eventually(() => within(dialog).getByText(reply.ok ? "a pinned stage message" : /could not be loaded/));
      const [foot] = within(dialog).getAllByRole("button", { name: "Close" });
      // Booleans, not nodes: node:assert inspecting a jsdom node does not finish.
      assert.equal(document.activeElement === foot, true, `focus is on ${document.activeElement?.outerHTML.slice(0, 80)}`);
      fireEvent.click(foot);
      await eventually(() => assert.equal(screen.queryByRole("dialog"), null));
      await eventually(() => assert.equal(document.activeElement === trigger, true, "focus did not return to What's new"));
    }
  });

  test("each press asks again, so a failure is not stuck on screen", async () => {
    notesReply = { ok: false, version: "9.8.1", releaseUrl: RELEASE_URL, reason: "offline" };
    await mount();
    let dialog = await open();
    await eventually(() => within(dialog).getByText(/could not be loaded/));
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    await eventually(() => assert.equal(screen.queryByRole("dialog"), null));

    notesReply = okReply();
    dialog = await open();
    await eventually(() => within(dialog).getByText("a pinned stage message"));
    assert.equal(notesReads().length, 2);
  });
});

describe("the pending list beside it", () => {
  test("with an update waiting it is 'Coming in <tag>', and the card has one What's new", async () => {
    await mount({
      targetTag: "v9.9.0",
      releasesBehind: 1,
      behind: 1,
      behindUserFacing: 1,
      changelog: ["feat: video feeds report their delay"],
    });
    // Whole-line text: the tag sits in its own mono span.
    assert.ok(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "Coming in v9.9.0"));
    assert.ok(screen.getByText("feat: video feeds report their delay"));
    assert.equal(screen.getAllByText("What's new").length, 1, "two What's new labels on one card");
  });

  test("a track with no tags names no version it cannot know", async () => {
    await mount({
      tagBased: false,
      targetTag: null,
      currentTag: null,
      releasesBehind: 0,
      behind: 2,
      behindUserFacing: 2,
      changelog: ["fix: a tip commit"],
    });
    assert.ok(screen.getByText("Coming in the next update"));
  });
});
