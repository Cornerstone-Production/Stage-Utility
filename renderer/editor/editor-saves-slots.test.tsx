// The editor's Save lands the mic slots too, and its pill knows they are unsaved.
//
// Reported: "in the layout editor if i have a mic slots config not saved I want
// the dialog at the top to also show unsaved changed and if i click that save
// button at the top i want it to also save the mic slots config."
//
// The editor's `dirty` compares the LAYOUT against what is saved. It cannot see
// the inline slots buffer, because those slots live on the server per service
// type rather than in the layout — so arranging mics and pressing the editor's
// Save saved the layout, cleared the pill, and silently left the arrangement
// behind. Exactly the shape the integration dialog's sub-panels already had, so
// this reports through the same registry rather than a second mechanism.
//
// jsdom cannot mount the whole editor — it needs the router, a dozen live query
// hooks and a canvas — so this drives the registry directly. That is the piece
// the fix is made of: the panel reports, the host folds it into `dirty`, and the
// host's save runs `saveAll()` first.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { renderHook, act } = await import("@testing-library/react");
const { useUnsavedWork } = await import("../components/unsaved-work.js");

const src = await (await import("node:fs/promises")).readFile(
  new URL("./layout-editor.tsx", import.meta.url),
  "utf8",
);

describe("a panel's unsaved work reaches the editor", () => {
  test("the host is not dirty until a panel says so", () => {
    const { result } = renderHook(() => useUnsavedWork());
    assert.equal(result.current.dirty, false);
  });

  test("a panel holding a buffer makes the host dirty", () => {
    const { result } = renderHook(() => useUnsavedWork());
    act(() => {
      result.current.registry.report("inline-slots:grid-1", { save: async () => true });
    });
    assert.equal(
      result.current.dirty,
      true,
      "the pill stayed down while the slots editor held an unsaved arrangement",
    );
  });

  test("saveAll lands every panel's buffer", async () => {
    const { result } = renderHook(() => useUnsavedWork());
    const landed: string[] = [];
    act(() => {
      result.current.registry.report("inline-slots:grid-1", {
        save: async () => { landed.push("grid-1"); return true; },
      });
    });
    let ok = false;
    await act(async () => { ok = await result.current.saveAll(); });
    assert.deepEqual(landed, ["grid-1"], "the editor's Save did not land the slots");
    assert.equal(ok, true);
  });

  test("a panel whose save FAILS reports false", async () => {
    // The editor turns this into a throw, so `saveThen` does not close over a
    // save that did not land. A false swallowed here is work thrown away with a
    // cleared pill and nothing left on screen to say so.
    const { result } = renderHook(() => useUnsavedWork());
    act(() => {
      result.current.registry.report("inline-slots:grid-1", { save: async () => false });
    });
    let ok = true;
    await act(async () => { ok = await result.current.saveAll(); });
    assert.equal(ok, false, "a refused slots save reported success to the editor");
  });

  test("a panel that deregisters stops holding the pill down", () => {
    // Selecting a different object unmounts the slots editor. If its
    // registration outlived it, the pill would be stuck on with nothing to save.
    const { result } = renderHook(() => useUnsavedWork());
    act(() => {
      result.current.registry.report("inline-slots:grid-1", { save: async () => true });
    });
    assert.equal(result.current.dirty, true);
    act(() => { result.current.registry.report("inline-slots:grid-1", null); });
    assert.equal(result.current.dirty, false, "the pill stayed up after the panel went away");
  });
});

describe("the editor wires it up", () => {
  test("the pill lights for a panel's work, not only the layout's", () => {
    assert.match(src, /\{\(dirty \|\| panels\.dirty\) && \(/, "the pill still reads only the layout's dirty flag");
  });

  test("Save lands the panels BEFORE the layout", () => {
    // Order matters: the layout save clears `dirty` and saveThen closes on a
    // resolved save, so a panel failure has to be known before either happens.
    const save = /async function save\(\)[\s\S]*?\n {2}\}/.exec(src)?.[0] ?? "";
    assert.match(save, /panels\.saveAll\(\)/, "the editor's Save does not land the panels");
    assert.ok(
      save.indexOf("panels.saveAll()") < save.indexOf("onSave("),
      "the layout is saved before the panels, so a panel failure arrives too late",
    );
    assert.match(save, /if \(!panelsOk\) throw/, "a refused panel save is swallowed");
  });

  test("leaving the editor is blocked by a panel's work too", () => {
    assert.match(src, /shouldBlockFn: \(\) => dirty \|\| panels\.dirty/);
    assert.match(src, /enableBeforeUnload: \(\) => dirty \|\| panels\.dirty/);
  });
});

process.on("exit", teardown);
