import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { Select, SelectTrigger, SelectContent, SelectItem, SelectValue, SelectGroup, SelectLabel } =
  await import("./select.js");

after(() => {
  cleanup();
  teardown();
});

// Select renders a native <select>, and its placeholder was a plain <option
// value="">. Nothing stopped an operator picking it, and picking it fired
// onValueChange("") — which every caller treats as a real value. On the Screens
// page that sent viewId:"" to the server and surfaced as
// "outputs:setView — view not found", with no clue what had gone wrong.
//
// This is a SHARED control, so the same trap sat behind every placeholder in the
// app.
describe("Select placeholder", () => {
  test("is present, so the control still reads as unset", () => {
    const { container } = render(
      <Select onValueChange={() => {}}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a view" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="v1">Mic board</SelectItem>
        </SelectContent>
      </Select>,
    );
    const options = [...container.querySelectorAll("option")];
    assert.ok(
      options.some((o) => o.textContent === "Pick a view"),
      "the placeholder must still be shown",
    );
    cleanup();
  });

  test("cannot be selected", () => {
    const { container } = render(
      <Select onValueChange={() => {}}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a view" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="v1">Mic board</SelectItem>
        </SelectContent>
      </Select>,
    );
    const placeholder = [...container.querySelectorAll("option")].find(
      (o) => o.textContent === "Pick a view",
    ) as HTMLOptionElement;
    assert.ok(placeholder, "placeholder option missing");
    assert.equal(placeholder.disabled, true, "the placeholder must not be selectable");
    assert.equal(placeholder.value, "", "the placeholder carries the empty value it must never emit");
    cleanup();
  });

  test("a caller that supplies its own empty-valued item keeps it selectable", () => {
    // Some callers DO want an explicit "none" choice. Those pass their own item
    // with an empty value, and it must stay pickable - the guard above is about
    // the placeholder the component adds on its own.
    const { container } = render(
      <Select onValueChange={() => {}}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a view" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">— None —</SelectItem>
          <SelectItem value="v1">Mic board</SelectItem>
        </SelectContent>
      </Select>,
    );
    const none = [...container.querySelectorAll("option")].find(
      (o) => o.textContent === "— None —",
    ) as HTMLOptionElement;
    assert.ok(none, "the caller's own empty item must render");
    assert.equal(none.disabled, false, "an explicit none option must stay selectable");
    cleanup();
  });
});

// A native <select> cannot show a `value` that matches no <option>, and what it
// does instead is measured, not assumed — the numbers below were read off this
// very component before the fix, and they are what React's `updateOptions` and
// the HTML "ask for a reset" algorithm specify, so a browser does the same:
//
//   stale value, list is EMPTY     → selectedIndex -1, value ""
//                                    the blank trigger the ScriptView and plan
//                                    pickers are commented about
//   stale value, list is NOT empty → selectedIndex 0 (first NON-DISABLED option),
//                                    value "preset-a"
//
// The second is the worse half and is the one nobody had written down: the
// control reads as a real, plausible, WRONG value, and the stored one is gone
// from the DOM the instant the list arrives. Every assertion here is therefore on
// `select.value` — what the control actually reads — and not on the JSX.
//
// Roughly fifteen call sites in this app feed a Select from a list fetched at
// runtime, so every one of them can reach this: a plan the list has not loaded,
// a ScriptView preset that was deleted, an OSC target that was removed. Several
// had grown their own copy of the same workaround, and the ones that had not were
// safe only because some delete path happened to clean the reference up. The
// behaviour lives in the primitive now, so a call site does not have to remember.
describe("Select keeps a value it was given", () => {
  /** The rendered <select>, and its options in list order. */
  const shown = (container: HTMLElement) => {
    const select = container.querySelector("select") as HTMLSelectElement;
    const options = [...select.querySelectorAll("option")];
    return {
      select,
      labels: options.map((o) => o.textContent ?? ""),
      values: options.map((o) => o.value),
    };
  };

  test("a value matching no item gets an option, and is what the control reads", () => {
    const { container } = render(
      <Select value="preset-deleted" onValueChange={() => {}}>
        <SelectTrigger><SelectValue placeholder="Pick a preset" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="preset-a">Audio</SelectItem>
          <SelectItem value="preset-b">Lighting</SelectItem>
        </SelectContent>
      </Select>,
    );
    const { select, labels, values } = shown(container);
    // Without the fix this reads "preset-a" — the first offered option, silently
    // standing in for a value the operator never chose.
    assert.equal(select.value, "preset-deleted", "the stored value must be what the control reads");
    assert.ok(values.includes("preset-deleted"), "no option carries the stored value");
    assert.ok(
      labels.some((l) => l.includes("preset-deleted") && l.includes("not found")),
      `the stored value must be labelled as no longer offered, got ${JSON.stringify(labels)}`,
    );
    cleanup();
  });

  test("a value survives a list that has not loaded yet", () => {
    // The empty-list half: nothing to fall back to, so the trigger goes blank and
    // `selectedIndex` to -1. A settings page mounts in this state every time —
    // the options arrive from the server one tick later — and an operator reading
    // it in that tick sees no stored value at all.
    const { container } = render(
      <Select value="preset-deleted" onValueChange={() => {}}>
        <SelectTrigger><SelectValue placeholder="Pick a preset" /></SelectTrigger>
        <SelectContent>{[]}</SelectContent>
      </Select>,
    );
    const { select } = shown(container);
    assert.notEqual(select.selectedIndex, -1, "the control renders blank — nothing is selected");
    assert.equal(select.value, "preset-deleted", "the stored value must survive an empty list");
    cleanup();
  });

  test("an empty value synthesises nothing", () => {
    // "" is an unset state, not a missing one. Call sites bind it deliberately,
    // against their own "None" item or against the placeholder; a synthetic ""
    // option would give every one of them a second blank row.
    const { container } = render(
      <Select value="" onValueChange={() => {}}>
        <SelectTrigger><SelectValue placeholder="Pick a preset" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="preset-a">Audio</SelectItem>
        </SelectContent>
      </Select>,
    );
    assert.deepEqual(shown(container).labels, ["Pick a preset", "Audio"], "an empty value must add no option");
    cleanup();
  });

  test("an empty value synthesises nothing against the caller's own none item either", () => {
    const { container } = render(
      <Select value="" onValueChange={() => {}}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="">— device —</SelectItem>
          <SelectItem value="dev-1">Rack 1</SelectItem>
        </SelectContent>
      </Select>,
    );
    const { select, labels } = shown(container);
    assert.deepEqual(labels, ["— device —", "Rack 1"], "an empty value must add no option");
    assert.equal(select.value, "", "the unset state still reads as the caller's own none item");
    cleanup();
  });

  test("a value matching an item synthesises nothing, and the order is unchanged", () => {
    const { container } = render(
      <Select value="preset-b" onValueChange={() => {}}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="preset-a">Audio</SelectItem>
          <SelectItem value="preset-b">Lighting</SelectItem>
          <SelectItem value="preset-c">Video</SelectItem>
        </SelectContent>
      </Select>,
    );
    const { select, labels } = shown(container);
    assert.deepEqual(labels, ["Audio", "Lighting", "Video"], "the real options must be untouched");
    assert.equal(select.value, "preset-b");
    cleanup();
  });

  test("a value matching an item inside a group synthesises nothing", () => {
    // The list is walked through <SelectGroup> to build <optgroup>, so the
    // presence check has to walk it the same way — a value only offered inside a
    // group is still offered. The plan switcher's "Defaults…" group is exactly
    // this shape.
    const { container } = render(
      <Select value="grouped" onValueChange={() => {}}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="loose">Loose</SelectItem>
          <SelectGroup>
            <SelectLabel>Defaults…</SelectLabel>
            <SelectItem value="grouped">In a group</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );
    const { select, labels } = shown(container);
    assert.deepEqual(labels, ["Loose", "In a group"], "a grouped item is an offered item");
    assert.equal(select.value, "grouped");
    cleanup();
  });

  test("a sentinel value that IS an item synthesises nothing", () => {
    // Several call sites carry "__none__" / "auto" / "any" style values that are
    // real entries in their own list. Nothing about the string makes them
    // missing; only the absence of an item does.
    for (const sentinel of ["__none__", "__offline__", "auto", "any", "__pvp-custom__"]) {
      const { container } = render(
        <Select value={sentinel} onValueChange={() => {}}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={sentinel}>Whatever this one means</SelectItem>
            <SelectItem value="real">A real one</SelectItem>
          </SelectContent>
        </Select>,
      );
      const { select, labels } = shown(container);
      assert.deepEqual(labels, ["Whatever this one means", "A real one"], `${sentinel} must add no option`);
      assert.equal(select.value, sentinel);
      cleanup();
    }
  });

  test("picking a real option reports the real value, and the synthetic option goes", () => {
    // The synthetic option is a passenger. Choosing past it has to behave exactly
    // as it would have if the stored value had been in the list all along, and
    // once the value is a real one the extra option is gone — it is not a
    // permanent entry that accumulates.
    const seen: string[] = [];
    let value = "preset-deleted";
    const List = () => (
      <Select value={value} onValueChange={(v: string) => seen.push(v)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="preset-a">Audio</SelectItem>
          <SelectItem value="preset-b">Lighting</SelectItem>
        </SelectContent>
      </Select>
    );
    const { container, rerender } = render(<List />);
    fireEvent.change(container.querySelector("select") as HTMLSelectElement, {
      target: { value: "preset-b" },
    });
    assert.deepEqual(seen, ["preset-b"], "the pick must report the real value, not the synthetic one");

    value = "preset-b";
    rerender(<List />);
    assert.deepEqual(
      shown(container).labels,
      ["Audio", "Lighting"],
      "the synthetic option must not outlive the stale value",
    );
    cleanup();
  });

  test("the component never fires onValueChange with the synthetic value itself", () => {
    // A synthetic option must not become state the caller never had. If it
    // reported itself on mount, a stale reference would be written straight back
    // to the server as a deliberate choice.
    const seen: string[] = [];
    const { container } = render(
      <Select value="target-removed" onValueChange={(v: string) => seen.push(v)}>
        <SelectTrigger><SelectValue placeholder="Target…" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="t1">Booth</SelectItem>
        </SelectContent>
      </Select>,
    );
    assert.deepEqual(seen, [], "rendering a stale value must report nothing");
    assert.equal(
      (container.querySelector("select") as HTMLSelectElement).value,
      "target-removed",
      "and the stale value is still what is shown",
    );
    cleanup();
  });

  test("the synthetic option stays selectable, so the operator can get back to it", () => {
    // Disabling it would grey it out for free, but it would also make the stored
    // value unreachable the moment the operator browsed past it — one stray
    // keystroke and the thing this exists to preserve is gone.
    const { container } = render(
      <Select value="gone" onValueChange={() => {}}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="here">Here</SelectItem>
        </SelectContent>
      </Select>,
    );
    const synthetic = [...container.querySelectorAll("option")].find((o) => o.value === "gone");
    assert.ok(synthetic, "the synthetic option must exist");
    assert.equal(synthetic.disabled, false, "the stored value must stay reachable");
    cleanup();
  });
});
