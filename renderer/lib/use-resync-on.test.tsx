// useResyncOn replaced `useEffect(() => setX(from), [from])` across the app, and
// an effect RUNS ON MOUNT. The first version of this hook did not: it seeded its
// "last seen" deps with the mount-time deps, so a component that mounted with
// its source already in hand never mirrored it. In prod that was the slot
// editor: opened from Screens with the stage state already cached, it showed no
// slots at all until a refresh — a refresh mounts while the state is still
// loading, so the deps change once it lands and the mirror fires.
//
// Both halves asserted: the reset runs on mount, and it still runs on change.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, act } = await import("@testing-library/react");
const { useState } = await import("react");
const { useResyncOn } = await import("./use-resync-on.js");

after(() => {
  cleanup();
  teardown();
});

/** Mirrors `source` into local state through the hook, exactly as the slot editor does. */
function Mirror({ source }: { source: string[] }) {
  const [local, setLocal] = useState<string[]>([]);
  useResyncOn([source], () => setLocal([...source]));
  return <div data-testid="out">{local.join(",")}</div>;
}

describe("useResyncOn", () => {
  test("mirrors a source that is already present when the component mounts", (t) => {
    const view = render(<Mirror source={["a", "b"]} />);
    t.after(() => cleanup());
    assert.equal(
      view.getByTestId("out").textContent,
      "a,b",
      "the reset did not run on mount — a source in hand at mount was never mirrored",
    );
  });

  test("and again when the source changes", (t) => {
    const view = render(<Mirror source={["a"]} />);
    t.after(() => cleanup());
    act(() => {
      view.rerender(<Mirror source={["a", "c"]} />);
    });
    assert.equal(view.getByTestId("out").textContent, "a,c");
  });
});
