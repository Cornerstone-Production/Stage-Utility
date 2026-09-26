// A route's error screen says what went wrong, whatever was thrown.
//
// TanStack Router hands `errorComponent` whatever the route threw, and a throw
// is not always an Error: a loader can reject with a string, a fetch helper with
// a plain object. Reading `.message` off those rendered "Something went wrong"
// over a blank line, the one place the operator needed the reason.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { ErrorBoundaryView } = await import("./error-boundary-view.js");

afterEach(() => cleanup());
after(() => teardown());

describe("the route error screen", () => {
  test("an Error shows its message", () => {
    const view = render(<ErrorBoundaryView error={new Error("disk full")} reset={() => {}} />);
    assert.ok(view.getByText("disk full"));
  });

  test("a thrown string shows the string", () => {
    const view = render(<ErrorBoundaryView error="plan 77003344 not found" reset={() => {}} />);
    assert.ok(view.getByText("plan 77003344 not found"));
  });
});
