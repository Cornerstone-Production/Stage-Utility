// relay-status.test.tsx — the Video feeds page's own switch and relay status
// line: the pill, the per-state detail text, and "Change ports in Advanced"
// showing only while the relay is actually running.
//
// NOT tested here: the switch's real visual state (CSS), and the progress
// bar's width as a rendered pixel value — jsdom loads no stylesheet, so
// every width/offset reads as whatever the inline `style` attribute says
// rather than anything a browser would paint. The style attribute itself
// (the string used to compute `width`) is asserted instead.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent, screen } = await import("@testing-library/react");
const { RelayStatusHeader } = await import("./relay-status.js");

type RelayStatus = import("@main/types/video").RelayStatus;

after(() => teardown());
afterEach(() => cleanup());

const PORTS = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };

function renderHeader(
  relay: RelayStatus,
  overrides: { enabled?: boolean; toggling?: boolean; onToggle?: (v: boolean) => void; onChangePorts?: () => void } = {},
) {
  return render(
    <RelayStatusHeader
      relay={relay}
      enabled={overrides.enabled ?? false}
      toggling={overrides.toggling ?? false}
      onToggle={overrides.onToggle ?? (() => {})}
      onChangePorts={overrides.onChangePorts ?? (() => {})}
    />,
  );
}

describe("the header pill and switch", () => {
  test("the switch reflects `enabled` and forwards a flip, independent of the relay's own state", () => {
    const seen: boolean[] = [];
    renderHeader({ state: "off" }, { enabled: true, onToggle: (v) => seen.push(v) });
    const sw = screen.getByRole("switch", { name: "Video feeds on" });
    assert.equal(sw.getAttribute("aria-checked"), "true");
    fireEvent.click(sw);
    assert.deepEqual(seen, [false], "clicking an ON switch must ask to turn it off");
  });

  test("running shows the design's \"Relay running\" pill", () => {
    renderHeader({ state: "running", version: "1.21.1", ports: PORTS });
    assert.ok(screen.getByText("Relay running"));
  });

  for (const [relay, label] of [
    [{ state: "off" }, "Relay off"],
    [{ state: "starting", version: null }, "Relay starting"],
    [{ state: "downloading", receivedBytes: 0, totalBytes: 100 }, "Downloading the relay"],
    [{ state: "failing", reason: "x", retryAt: null }, "Relay error"],
  ] as [RelayStatus, string][]) {
    test(`${relay.state} shows the "${label}" pill`, () => {
      renderHeader(relay);
      assert.ok(screen.getByText(label));
    });
  }
});

describe("the detail line, per state", () => {
  test("off names the download size before anything has ever run", () => {
    renderHeader({ state: "off" });
    const text = document.body.textContent ?? "";
    assert.match(text, /downloads MediaMTX v1\.21\.1/);
    assert.match(text, /27 MB download/);
    assert.match(text, /55 MB on disk/);
  });

  test("downloading shows a progress bar sized to the fraction received", () => {
    const { container } = renderHeader({ state: "downloading", receivedBytes: 25, totalBytes: 100 });
    assert.match(container.textContent ?? "", /25%/);
    const fill = container.querySelector<HTMLElement>('[style*="width"]');
    assert.ok(fill, "no element carries the progress bar's width style");
    assert.equal(fill!.style.width, "25%");
  });

  test("starting says so, with no numbers to show yet", () => {
    renderHeader({ state: "starting", version: null });
    assert.match(document.body.textContent ?? "", /Starting the relay/);
  });

  test("running names the version, the inputs (no RTSP) and the screens port, and shows Change ports in Advanced", () => {
    const { container } = renderHeader({ state: "running", version: "1.21.1", ports: PORTS });
    const text = container.textContent ?? "";
    assert.match(text, /MediaMTX 1\.21\.1/);
    assert.match(text, /RTMP 1935/);
    assert.match(text, /SRT 8890/);
    assert.match(text, /UDP 8189/);
    assert.equal(text.includes("RTSP"), false, "no push kind uses RTSP, and pulling it needs no listener");
    assert.ok(screen.getByRole("button", { name: "Change ports in Advanced" }));
  });

  test("Change ports in Advanced is absent for every other state", () => {
    for (const relay of [
      { state: "off" },
      { state: "starting", version: null },
      { state: "downloading", receivedBytes: 1, totalBytes: 2 },
      { state: "failing", reason: "x", retryAt: null },
    ] as RelayStatus[]) {
      const { container, unmount } = renderHeader(relay);
      assert.equal(container.querySelector("button")?.textContent?.includes("Change ports"), false, relay.state);
      unmount();
    }
  });

  test("failing shows the reason, the next retry time, and where to hand-place a failed download", () => {
    const retryAt = Date.UTC(2026, 8, 28, 12, 0, 0);
    renderHeader({
      state: "failing",
      reason: "Port 1935 is in use by OBS Studio.",
      retryAt,
      placeArchiveAt: "/data/video-relay/downloads/mediamtx_v1.21.1_linux_amd64.tar.gz",
    });
    const text = document.body.textContent ?? "";
    assert.match(text, /Port 1935 is in use by OBS Studio\./);
    assert.match(text, /next try at/);
    assert.match(text, /Or place mediamtx_v1\.21\.1_linux_amd64\.tar\.gz at \/data\/video-relay\/downloads\/mediamtx_v1\.21\.1_linux_amd64\.tar\.gz by hand\./);
  });

  test("failing with no placeArchiveAt (an unsupported platform) never invents a hand-place sentence", () => {
    renderHeader({ state: "failing", reason: "Video relay is not available for win32 arm64.", retryAt: null });
    assert.equal((document.body.textContent ?? "").includes("Or place"), false);
  });
});
