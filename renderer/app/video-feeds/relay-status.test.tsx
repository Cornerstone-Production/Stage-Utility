// relay-status.test.tsx — the Video feeds page's own switch and relay status
// line: the pill, the per-state detail text, and "Change ports in Advanced"
// showing while the relay is running OR failing (item 17: it is most useful
// exactly where a busy port shows up).
//
// NOT tested here: the switch's real visual state (CSS), and the progress
// bar's width as a rendered pixel value — jsdom loads no stylesheet, so
// every width/offset reads as whatever the inline `style` attribute says
// rather than anything a browser would paint. The style attribute itself
// (the string used to compute `width`) is asserted instead. Also not tested:
// the merged header row's real layout (gaps, wrapping) against the design —
// driven in a real browser instead, screenshotted against mockup-v2.html.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent, screen } = await import("@testing-library/react");
const { RelayPill, RelaySwitch, RelayDetailRow } = await import("./relay-status.js");

type RelayStatus = import("@main/types/video").RelayStatus;

after(() => teardown());
afterEach(() => cleanup());

const PORTS = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };

function renderRow(
  relay: RelayStatus,
  overrides: {
    enabled?: boolean;
    binaryPresent?: boolean;
    toggling?: boolean;
    onToggle?: (v: boolean) => void;
    onChangePorts?: () => void;
  } = {},
) {
  const enabled = overrides.enabled ?? false;
  return render(
    <>
      <RelayPill relay={relay} />
      <RelaySwitch enabled={enabled} toggling={overrides.toggling ?? false} onToggle={overrides.onToggle ?? (() => {})} />
      <RelayDetailRow
        relay={relay}
        enabled={enabled}
        binaryPresent={overrides.binaryPresent ?? false}
        onChangePorts={overrides.onChangePorts ?? (() => {})}
      />
    </>,
  );
}

describe("the header pill and switch", () => {
  test("the switch reflects `enabled` and forwards a flip, independent of the relay's own state", () => {
    const seen: boolean[] = [];
    renderRow({ state: "off" }, { enabled: true, onToggle: (v) => seen.push(v) });
    const sw = screen.getByRole("switch", { name: "Video feeds on" });
    assert.equal(sw.getAttribute("aria-checked"), "true");
    fireEvent.click(sw);
    assert.deepEqual(seen, [false], "clicking an ON switch must ask to turn it off");
  });

  test("running shows the design's \"Relay running\" pill", () => {
    renderRow({ state: "running", version: "1.21.1", ports: PORTS });
    assert.ok(screen.getByText("Relay running"));
  });

  for (const [relay, label] of [
    [{ state: "off" }, "Relay off"],
    [{ state: "starting", version: null }, "Relay starting"],
    [{ state: "downloading", receivedBytes: 0, totalBytes: 100 }, "Downloading the relay"],
    [{ state: "failing", reason: "x", retryAt: null }, "Relay error"],
  ] as [RelayStatus, string][]) {
    test(`${relay.state} shows the "${label}" pill`, () => {
      renderRow(relay);
      assert.ok(screen.getByText(label));
    });
  }
});

describe("the off-state detail — item 6: enabled and binaryPresent both change it", () => {
  test("switched off, never downloaded: names the download size", () => {
    renderRow({ state: "off" }, { enabled: false, binaryPresent: false });
    const text = document.body.textContent ?? "";
    assert.match(text, /downloads MediaMTX v1\.21\.1/);
    assert.match(text, /27 MB download/);
    assert.match(text, /55 MB on disk/);
  });

  test("switched off, binary already present: says nothing at all", () => {
    const { container } = renderRow({ state: "off" }, { enabled: false, binaryPresent: true });
    assert.equal((container.textContent ?? "").trim(), "Relay off", "only the pill should render — no stray sentence");
  });

  test("switched on with no relay feed yet: says the relay is waiting for one, never the download line", () => {
    renderRow({ state: "off" }, { enabled: true, binaryPresent: false });
    const text = document.body.textContent ?? "";
    assert.match(text, /Video is on\. The relay starts when a feed pulls from a device or a device pushes to it\./);
    assert.equal(text.includes("downloads MediaMTX"), false);
  });
});

describe("the detail line, per other state", () => {
  test("downloading shows a progress bar sized to the fraction received", () => {
    const { container } = renderRow({ state: "downloading", receivedBytes: 25, totalBytes: 100 });
    assert.match(container.textContent ?? "", /25%/);
    const fill = container.querySelector<HTMLElement>('[style*="width"]');
    assert.ok(fill, "no element carries the progress bar's width style");
    assert.equal(fill!.style.width, "25%");
  });

  test("starting says so, with no numbers to show yet", () => {
    renderRow({ state: "starting", version: null });
    assert.match(document.body.textContent ?? "", /Starting the relay/);
  });

  test("running names the version, the inputs (no RTSP) and the screens port, and shows Change ports in Advanced", () => {
    const { container } = renderRow({ state: "running", version: "1.21.1", ports: PORTS });
    const text = container.textContent ?? "";
    assert.match(text, /MediaMTX 1\.21\.1/);
    assert.match(text, /RTMP 1935/);
    assert.match(text, /SRT 8890/);
    assert.match(text, /UDP 8189/);
    assert.equal(text.includes("RTSP"), false, "no push kind uses RTSP, and pulling it needs no listener");
    assert.ok(screen.getByRole("button", { name: "Change ports in Advanced" }));
  });

  test("failing ALSO shows Change ports in Advanced — item 17: most useful exactly on a busy port", () => {
    renderRow({ state: "failing", reason: "Port 1935 is in use by OBS Studio.", retryAt: null });
    assert.ok(screen.getByRole("button", { name: "Change ports in Advanced" }));
  });

  test("Change ports in Advanced is absent for off, starting and downloading", () => {
    for (const relay of [
      { state: "off" },
      { state: "starting", version: null },
      { state: "downloading", receivedBytes: 1, totalBytes: 2 },
    ] as RelayStatus[]) {
      const { container, unmount } = renderRow(relay);
      assert.equal(container.querySelector("button")?.textContent?.includes("Change ports"), false, relay.state);
      unmount();
    }
  });

  test("failing shows the reason, the next retry time, and where to hand-place a failed download, as three SEPARATE sentences", () => {
    const retryAt = Date.UTC(2026, 8, 28, 12, 0, 0);
    renderRow({
      state: "failing",
      reason: "checksum mismatch for mediamtx_v1.21.1_linux_amd64.tar.gz: expected a, got b",
      retryAt,
      placeArchiveAt: "/data/video-relay/downloads/mediamtx_v1.21.1_linux_amd64.tar.gz",
      assetName: "mediamtx_v1.21.1_linux_amd64.tar.gz",
    });
    const text = document.body.textContent ?? "";
    assert.match(text, /checksum mismatch for mediamtx_v1\.21\.1_linux_amd64\.tar\.gz: expected a, got b/);
    assert.match(text, /Next try at/);
    assert.match(text, /Or place mediamtx_v1\.21\.1_linux_amd64\.tar\.gz at \/data\/video-relay\/downloads\/mediamtx_v1\.21\.1_linux_amd64\.tar\.gz by hand\./);
    // Not run together on one sentence — "… Or place …" immediately after
    // the retry time, with no separating punctuation, reads as one run-on.
    assert.equal(/Next try at [\d:]+ Or place/.test(text), false, "the retry time and the hand-place line ran together");
  });

  test("no pinned asset for this platform: names it directly, never invents a hand-place sentence by splitting a bare directory", () => {
    // The real shape acquire.ts returns for an unsupported platform/arch:
    // `assetName: undefined`, `placeArchiveAt` a bare DOWNLOADS DIRECTORY
    // with no file name in it at all — splitting that on "/" (the bug this
    // guards) would have produced "Or place downloads at … by hand.",
    // naming a folder as if it were the missing binary.
    renderRow({
      state: "failing",
      reason: "Video relay is not available for win32 arm64.",
      retryAt: null,
      placeArchiveAt: "/data/video-relay/downloads",
    });
    const text = document.body.textContent ?? "";
    assert.match(text, /Video relay is not available for win32 arm64\./);
    assert.equal(text.includes("Or place"), false);
    assert.equal(text.includes("downloads"), false, "a bare directory must never be shown as though it were the asset");
  });
});
