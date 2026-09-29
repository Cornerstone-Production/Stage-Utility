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
// item 8 (findings-t15-r3.md): sibling files set this so React act-wraps a
// render and WARNS the moment an update escapes one — without it a file
// reads as clean while updates land outside act, silently.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, fireEvent, screen } = await import("@testing-library/react");
const { RelayPill, RelaySwitch, RelayDetailRow } = await import("./relay-status.js");
const { assertAbsent } = await import("../../test-fixtures/integrations-harness.js");

type RelayStatus = import("@main/types/video").RelayStatus;

after(() => teardown());
afterEach(() => cleanup());

const PORTS = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };

function renderRow(
  relay: RelayStatus,
  overrides: {
    enabled?: boolean;
    binaryPresent?: boolean;
    archivePresent?: boolean;
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
        archivePresent={overrides.archivePresent ?? false}
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
    [{ state: "failing", reason: "x", kind: "port-conflict", retryAt: null }, "Relay error"],
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

  // An archive placed by hand in video-relay/downloads is used as it is: no
  // download happens, so the line must not promise one.
  test("switched off, archive placed by hand but not extracted: sets up from it, no download named", () => {
    renderRow({ state: "off" }, { enabled: false, binaryPresent: false, archivePresent: true });
    const text = document.body.textContent ?? "";
    assert.match(text, /Turning this on sets up MediaMTX v1\.21\.1 from the archive already in place\./);
    assert.equal(/download/.test(text), false, `the line still names a download: ${text}`);
  });

  test("switched off, binary already present: says nothing at all, and renders no empty strip", () => {
    const { container } = renderRow({ state: "off" }, { enabled: false, binaryPresent: true });
    assert.equal((container.textContent ?? "").trim(), "Relay off", "only the pill should render — no stray sentence");
    // item 5: RelayDetailRow used to render its bordered/padded wrapper div
    // unconditionally, so this exact case (off, binary present) produced a
    // strip with nothing in it — a border and padding around empty space.
    // A boolean, never the raw node: item 8 (findings-t15-r3.md) — passing
    // a DOM Element straight to assert.equal() makes a FAILURE hang for
    // ~23 s with no message at all, node's assert trying to diff/serialize
    // a circular object (the element's own React fiber, attached as an
    // expando property) rather than reporting anything useful.
    assert.equal(container.querySelector(".border-b") !== null, false, "an empty strip is still rendering");
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

  test("failing on a port conflict shows Change ports in Advanced — item 17: most useful exactly there", () => {
    renderRow({ state: "failing", reason: "Port 1935 is in use by OBS Studio.", kind: "port-conflict", retryAt: null });
    assert.ok(screen.getByRole("button", { name: "Change ports in Advanced" }));
  });

  test("item 8: failing for any OTHER reason does not show Change ports in Advanced — nothing there would fix it", () => {
    for (const relay of [
      { state: "failing", reason: "checksum mismatch", kind: "download", retryAt: null },
      { state: "failing", reason: "could not write the relay's config: EACCES", kind: "config-write", retryAt: null },
      { state: "failing", reason: "could not start the relay: ENOENT", kind: "spawn", retryAt: null },
      { state: "failing", reason: "Video relay is not available for win32 arm64.", kind: "unsupported", retryAt: null },
      { state: "failing", reason: "exit code 1", kind: "crash-loop", retryAt: null },
      { state: "failing", reason: "The relay is not answering", kind: "not-answering", retryAt: null },
    ] as RelayStatus[]) {
      renderRow(relay);
      // NOT container.querySelector("button") — renderRow() puts the Radix
      // switch's own <button role="switch"> first in the DOM, which never
      // has "Change ports" text, so that check passed no matter what the
      // rest of the row showed. queryByRole with the link's own name finds
      // it specifically, wherever it sits.
      assertAbsent(
        screen.queryByRole("button", { name: "Change ports in Advanced" }),
        `Change ports in Advanced showed for ${(relay as { kind: string }).kind}`,
      );
      cleanup();
    }
  });

  test("Change ports in Advanced is absent for off, starting and downloading", () => {
    for (const relay of [
      { state: "off" },
      { state: "starting", version: null },
      { state: "downloading", receivedBytes: 1, totalBytes: 2 },
    ] as RelayStatus[]) {
      renderRow(relay);
      assertAbsent(
        screen.queryByRole("button", { name: "Change ports in Advanced" }),
        `Change ports in Advanced showed for ${relay.state}`,
      );
      cleanup();
    }
  });

  test("failing shows the reason, the next retry time, and where to hand-place a failed download, as three SEPARATE sentences", () => {
    const retryAt = Date.UTC(2026, 8, 28, 12, 0, 0);
    renderRow({
      state: "failing",
      reason: "checksum mismatch for mediamtx_v1.21.1_linux_amd64.tar.gz: expected a, got b",
      kind: "download",
      retryAt,
      // A folder relative to the data folder, as the server sends it: the
      // full path never reaches a LAN client.
      placeArchiveAt: "video-relay/downloads",
      assetName: "mediamtx_v1.21.1_linux_amd64.tar.gz",
    });
    const text = document.body.textContent ?? "";
    assert.match(text, /checksum mismatch for mediamtx_v1\.21\.1_linux_amd64\.tar\.gz: expected a, got b/);
    assert.match(text, /Next try at/);
    assert.match(
      text,
      /Or place mediamtx_v1\.21\.1_linux_amd64\.tar\.gz in video-relay\/downloads in Stage Utility's data folder by hand\./,
    );
    // Not run together on one sentence — "… Or place …" immediately after
    // the retry time, with no separating punctuation, reads as one run-on.
    assert.equal(/Next try at [\d:]+ Or place/.test(text), false, "the retry time and the hand-place line ran together");
  });

  test("no pinned asset for this platform: names it directly, never invents a hand-place sentence by splitting a bare directory, and never retries — item 16", () => {
    // The real shape acquire.ts returns for an unsupported platform/arch:
    // `assetName: undefined`, `placeArchiveAt` a bare DOWNLOADS DIRECTORY
    // with no file name in it at all — splitting that on "/" (the bug this
    // guards) would have produced "Or place downloads at … by hand.",
    // naming a folder as if it were the missing binary.
    renderRow({
      state: "failing",
      reason: "Video relay is not available for win32 arm64.",
      kind: "unsupported",
      retryAt: null,
      placeArchiveAt: "video-relay/downloads",
    });
    const text = document.body.textContent ?? "";
    assert.match(text, /Video relay is not available for win32 arm64\./);
    assert.equal(text.includes("Or place"), false);
    assert.equal(text.includes("downloads"), false, "a bare directory must never be shown as though it were the asset");
    // item 16: nothing will ever fix this by waiting, so no "Next try at".
    assert.equal(text.includes("Next try at"), false);
  });
});
