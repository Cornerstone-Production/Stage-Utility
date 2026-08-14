import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } = await import("./select.js");

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
