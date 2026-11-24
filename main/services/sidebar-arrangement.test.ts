// The sidebar's saved arrangement: how it is drawn, and what a save may hold.
//
// The resolver is the one function the server and the renderer both draw from,
// so these run the real thing over plain data rather than a rendered rail.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  DEFAULT_SIDEBAR,
  EMPTY_SIDEBAR,
  LOCKED_PAGE,
  resolveSidebar,
  keepKnownConsoles,
  readSidebarLeniently,
  toSavedSidebar,
  validateSidebarArrangement,
  type SidebarArrangement,
  type SidebarConsoles,
} from "./sidebar-arrangement.js";

const NO_CONSOLES: SidebarConsoles = { all: [], hidden: new Set() };
const CONSOLES: SidebarConsoles = {
  all: ["console:foh", "console:mon", "console:lobby"],
  hidden: new Set(["console:lobby"]),
};

/** The default arrangement as it would be saved: every section spelled out. */
function spelledOut(): SidebarArrangement {
  return { sections: DEFAULT_SIDEBAR.map((s) => ({ ...s, members: [...s.members] })), hidden: [] };
}

const membersOf = (r: { sections: { id: string; members: string[] }[] }, id: string) =>
  r.sections.find((s) => s.id === id)?.members;

describe("resolving the sidebar", () => {
  test("nothing saved is the default, with consoles in view order and hidden ones in the tray", () => {
    const r = resolveSidebar(EMPTY_SIDEBAR, CONSOLES);
    assert.deepEqual(r.sections.map((s) => s.id), DEFAULT_SIDEBAR.map((s) => s.id));
    assert.deepEqual(membersOf(r, "consoles"), ["console:foh", "console:mon"]);
    assert.deepEqual(r.hiddenConsoles, ["console:lobby"]);
    assert.deepEqual(r.hiddenPages, []);
    assert.deepEqual(r.dropped, []);
  });

  test("a page the saved arrangement has never seen lands at the end of its default section", () => {
    // Saved by a release that had no Stage plots page: Content holds the other two.
    const saved = spelledOut();
    saved.sections = saved.sections.map((s) =>
      s.id === "content" ? { ...s, members: ["patch", "servicecue"] } : s,
    );
    const r = resolveSidebar(saved, NO_CONSOLES);
    assert.deepEqual(membersOf(r, "content"), ["patch", "servicecue", "stageplots"]);
  });

  test("a page whose default section was removed lands in the last section of pages", () => {
    const saved = spelledOut();
    saved.sections = saved.sections.filter((s) => s.id !== "devices");
    const r = resolveSidebar(saved, NO_CONSOLES);
    // Devices held Automation and Q-SYS, both land at the end, in their default order.
    assert.deepEqual(membersOf(r, "settings")?.slice(-2), ["automation", "qsys"]);
  });

  test("a new console joins the end of Consoles", () => {
    const saved = spelledOut();
    saved.sections = saved.sections.map((s) =>
      s.kind === "consoles" ? { ...s, members: ["console:mon"] } : s,
    );
    const r = resolveSidebar(saved, CONSOLES);
    assert.deepEqual(membersOf(r, "consoles"), ["console:mon", "console:foh"]);
  });

  test("ids the app no longer has are dropped and reported", () => {
    const saved = spelledOut();
    saved.sections[2].members.push("gone");
    saved.sections[1].members.push("console:deleted");
    saved.hidden = ["also-gone"];
    const r = resolveSidebar(saved, NO_CONSOLES);
    assert.deepEqual([...r.dropped].sort(), ["also-gone", "console:deleted", "gone"]);
    assert.ok(!r.sections.some((s) => s.members.includes("gone")));
  });

  test("a hidden page stays out, and Advanced is never hidden", () => {
    const r = resolveSidebar({ sections: [], hidden: ["baptisms", LOCKED_PAGE] }, NO_CONSOLES);
    assert.deepEqual(r.hiddenPages, ["baptisms"]);
    assert.ok(membersOf(r, "settings")?.includes(LOCKED_PAGE));
    assert.ok(!membersOf(r, "services")?.includes("baptisms"));
  });

  test("Consoles holds consoles only, and a console never leaves it", () => {
    const saved = spelledOut();
    saved.sections[1].members = ["patch"];
    saved.sections[2].members = ["console:foh", "servicecue"];
    const r = resolveSidebar(saved, CONSOLES);
    assert.deepEqual(membersOf(r, "consoles"), ["console:foh", "console:mon"]);
    assert.ok(membersOf(r, "content")?.includes("patch"));
  });

  test("a console switched out of the sidebar stays out even where the arrangement lists it", () => {
    // Saved while it was listed; its own switch has since been turned off.
    const saved = spelledOut();
    saved.sections[1].members = ["console:lobby", "console:foh"];
    const r = resolveSidebar(saved, CONSOLES);
    assert.deepEqual(membersOf(r, "consoles"), ["console:foh", "console:mon"]);
    assert.deepEqual(r.hiddenConsoles, ["console:lobby"]);
  });

  test("the default arrangement is saved as nothing, and a change is saved whole", () => {
    assert.deepEqual(toSavedSidebar(resolveSidebar(EMPTY_SIDEBAR, CONSOLES), CONSOLES), EMPTY_SIDEBAR);
    const moved = resolveSidebar(EMPTY_SIDEBAR, CONSOLES);
    moved.sections[0].members.push("patch");
    moved.sections[2].members = moved.sections[2].members.filter((m) => m !== "patch");
    const saved = toSavedSidebar(moved, CONSOLES);
    assert.deepEqual(membersOf(saved, "top"), ["home", "patch"]);
  });
});

describe("validating a saved sidebar", () => {
  const refuses = (raw: unknown, pattern: RegExp) => assert.throws(() => validateSidebarArrangement(raw), pattern);

  test("the default, an empty object and a spelled-out arrangement are accepted", () => {
    assert.deepEqual(validateSidebarArrangement({}), EMPTY_SIDEBAR);
    assert.deepEqual(validateSidebarArrangement(spelledOut()), spelledOut());
  });

  test("a heading is trimmed, and an unknown page is kept for the resolver to drop", () => {
    const s = spelledOut();
    s.sections[2].label = "  Content  ";
    s.sections[2].members.push("a-page-from-a-later-release");
    const v = validateSidebarArrangement(s);
    assert.equal(v.sections[2].label, "Content");
    assert.ok(v.sections[2].members.includes("a-page-from-a-later-release"));
  });

  test("refuses an unknown section kind", () => {
    const s = spelledOut();
    (s.sections[2] as { kind: string }).kind = "widgets";
    refuses(s, /unknown kind/);
  });

  test("refuses two sections with one id, and one id listed twice", () => {
    const s = spelledOut();
    s.sections[3].id = s.sections[2].id;
    refuses(s, /two sections with the id/);
    const t = spelledOut();
    t.sections[3].members.push("patch");
    refuses(t, /more than once/);
    refuses({ sections: [], hidden: ["patch", "patch"] }, /more than once/);
  });

  test("refuses a page inside Consoles and a console outside it", () => {
    const s = spelledOut();
    s.sections[1].members.push("patch");
    s.sections[2].members = s.sections[2].members.filter((m) => m !== "patch");
    refuses(s, /Consoles holds consoles only/);
    const t = spelledOut();
    t.sections[2].members.push("console:foh");
    refuses(t, /a console stays in Consoles/);
  });

  test("refuses Advanced, or a console, in the hidden list", () => {
    refuses({ sections: [], hidden: [LOCKED_PAGE] }, /Advanced can't be hidden/);
    refuses({ sections: [], hidden: ["console:foh"] }, /Show in the sidebar/);
  });

  test("refuses a second Consoles section, and an arrangement without one", () => {
    const s = spelledOut();
    s.sections.push({ id: "more", label: "More", kind: "consoles", members: [] });
    refuses(s, /only one Consoles section/);
    const t = spelledOut();
    t.sections = t.sections.filter((x) => x.kind !== "consoles");
    refuses(t, /keep its top group and its Consoles section/);
  });

  test("refuses an empty heading and one that is too long", () => {
    const s = spelledOut();
    s.sections[2].label = "   ";
    refuses(s, /needs a name/);
    const t = spelledOut();
    t.sections[2].label = "x".repeat(41);
    refuses(t, /longer than 40 characters/);
  });

  test("refuses a page named by its path: a route can be renamed, an id cannot", () => {
    refuses({ sections: [], hidden: ["/patch"] }, /page id or console:<view id>/);
  });

  test("refuses a second top group, and a top group that is not first", () => {
    const s = spelledOut();
    s.sections.push({ id: "top2", label: "", kind: "top", members: [] });
    refuses(s, /only one top group/);
    const t = spelledOut();
    t.sections = [t.sections[1], t.sections[0], ...t.sections.slice(2)];
    refuses(t, /top group must come first/);
  });

  test("refuses a heading with a newline, a control character or a text-direction override", () => {
    for (const bad of ["Show\nTime", "Show\u0007", "Show\u202Ewoh"]) {
      const s = spelledOut();
      s.sections[2].label = bad;
      refuses(s, /control or text-direction/);
    }
  });

  test("takes a console by its prefix, whatever its view id, and the route drops one that is not a console", () => {
    const s = spelledOut();
    s.sections[1].members = ["console:View 7 (old)", "console:foh"];
    const v = validateSidebarArrangement(s);
    assert.deepEqual(v.sections[1].members, ["console:View 7 (old)", "console:foh"]);
    const kept = keepKnownConsoles(v, { all: ["console:foh"], hidden: new Set() });
    assert.deepEqual(kept.arrangement.sections[1].members, ["console:foh"]);
    assert.deepEqual(kept.dropped, ["console:View 7 (old)"]);
  });

  test("a file that breaks the rules is still drawn from what in it has the right shape", () => {
    const raw = { sections: [{ id: "top", kind: "top", label: "", members: ["home", "patch"] }, { id: "x", kind: "widgets", members: [] }, 5], hidden: ["baptisms", 3] };
    assert.deepEqual(readSidebarLeniently(raw), {
      sections: [{ id: "top", label: "", kind: "top", members: ["home", "patch"] }],
      hidden: ["baptisms"],
    });
    assert.deepEqual(readSidebarLeniently("nonsense"), EMPTY_SIDEBAR);
  });

  test("refuses a section id that is not a plain token", () => {
    const s = spelledOut();
    s.sections[2].id = "__proto__ x";
    refuses(s, /id must be/);
  });
});
