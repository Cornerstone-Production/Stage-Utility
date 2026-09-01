// Reading a plan's notes off PCO, with the one shape that is easy to get wrong.
//
// PCO documents PlanNote's `teams` relationship as to_one, but the plan editor
// lets a note be assigned to several teams and then sends an array. Code written
// from the documentation alone reads the object shape, finds an array, and
// silently produces a note with no teams — so a "Production" filter drops
// exactly the notes that were most deliberately addressed to a team. The array
// test below is the guard for that.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { pcoService } from "./pco-service.js";

type Requester = { request: (url: string, appId: string, secret: string) => Promise<unknown> };
const svc = pcoService as unknown as Requester;
const realRequest = svc.request;

const TEAMS = [
  { id: "t-prod", type: "Team", attributes: { name: "Production" } },
  { id: "t-band", type: "Team", attributes: { name: "Band" } },
];

/** One note as PCO returns it. `teams` takes whichever shape the caller passes. */
function noteNode(id: string, category: string, content: string, teams: unknown) {
  return {
    id,
    type: "PlanNote",
    attributes: { category_name: category, content },
    relationships: { teams: { data: teams } },
  };
}

let urls: string[] = [];

/** Stub PCO with a fixed payload; returns the urls it was asked for. */
function stub(data: unknown[], included: unknown[] = TEAMS) {
  urls = [];
  svc.request = async (url: string) => {
    urls.push(url);
    return { data, included };
  };
}

describe("a plan's notes", () => {
  beforeEach(() => {
    pcoService.clearCache();
  });

  it("reads content and category off the note's own attributes", async () => {
    stub([noteNode("n1", "Production", "- Batteries fresh", { id: "t-prod", type: "Team" })]);
    const notes = await pcoService.listPlanNotes("app", "secret", "st1", "p1");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].categoryName, "Production");
    assert.equal(notes[0].content, "- Batteries fresh");
  });

  it("resolves team names from the included nodes", async () => {
    stub([noteNode("n1", "Production", "x", { id: "t-prod", type: "Team" })]);
    const [note] = await pcoService.listPlanNotes("app", "secret", "st1", "p1");
    assert.deepEqual(note.teamNames, ["Production"]);
  });

  it("reads an ARRAY of teams, not only the documented single object", async () => {
    // The guard. Reading only the to_one shape yields [] here, and a note
    // addressed to two teams vanishes from both teams' checklists.
    stub([
      noteNode("n1", "Production", "x", [
        { id: "t-prod", type: "Team" },
        { id: "t-band", type: "Team" },
      ]),
    ]);
    const [note] = await pcoService.listPlanNotes("app", "secret", "st1", "p1");
    assert.deepEqual(note.teamNames, ["Production", "Band"]);
  });

  it("survives a note assigned to no team", async () => {
    stub([noteNode("n1", "General", "x", null)]);
    const [note] = await pcoService.listPlanNotes("app", "secret", "st1", "p1");
    assert.deepEqual(note.teamNames, []);
  });

  it("drops an empty note rather than making a blank row", async () => {
    stub([noteNode("n1", "Production", "   \n ", null), noteNode("n2", "Production", "- Real", null)]);
    const notes = await pcoService.listPlanNotes("app", "secret", "st1", "p1");
    assert.deepEqual(notes.map((n) => n.id), ["n2"]);
  });

  it("asks for the teams it needs, in one request", async () => {
    stub([]);
    await pcoService.listPlanNotes("app", "secret", "st1", "p1");
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("include=teams"), `no team include: ${urls[0]}`);
    assert.ok(urls[0].includes("/plans/p1/notes"), `wrong endpoint: ${urls[0]}`);
  });

  it("keys the cache by credentials as well as plan", async () => {
    // Two orgs must not share an entry: the plan id alone is not unique across
    // installs, and a shared cache would serve one church another's notes.
    stub([noteNode("n1", "Production", "- One", null)]);
    await pcoService.listPlanNotes("appA", "secret", "st1", "p1");
    stub([noteNode("n2", "Production", "- Two", null)]);
    const second = await pcoService.listPlanNotes("appB", "secret", "st1", "p1");
    assert.deepEqual(second.map((n) => n.id), ["n2"], "the second org was served the first org's notes");
  });

  it("serves a repeat reader from cache rather than PCO", async () => {
    stub([noteNode("n1", "Production", "- One", null)]);
    await pcoService.listPlanNotes("app", "secret", "st1", "p1");
    await pcoService.listPlanNotes("app", "secret", "st1", "p1");
    assert.equal(urls.length, 1, `notes were fetched ${urls.length} times`);
  });
});

// Put the real requester back, so a stub cannot leak into another test file
// sharing this module instance.
process.on("exit", () => {
  svc.request = realRequest;
});
