// What a screen shows before anybody has claimed it.
//
// Server-rendered HTML rather than a route in the app: this is the first thing a
// brand-new device ever loads, and it must work before it knows anything — no
// bundle, no SSE, no state. It also has to be readable from across a room, which
// is the whole job. Four identical Pis on a wall are told apart by the id, the
// address and the MAC printed on them, so those are set large rather than in
// small print.
//
// Always near-black. A wall display has no light mode.

export interface HoldingScreenInfo {
  id: string | null;
  ip?: string;
  hostname?: string;
  mac?: string;
  reason: "unclaimed" | "no-device";
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

const field = (label: string, value: string | undefined): string =>
  value ? `<div class="f"><span>${esc(label)}</span><b>${esc(value)}</b></div>` : "";

export function holdingScreen(info: HoldingScreenInfo): string {
  const headline =
    info.reason === "no-device"
      ? "No device id"
      : "Waiting to be assigned";
  const sub =
    info.reason === "no-device"
      ? "This page is opened by an installed kiosk device, which supplies its own id."
      : "Open Devices in Stage Utility and give this screen an output.";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Stage Utility — ${esc(headline)}</title>
<style>
  :root { color-scheme: dark }
  html,body { height:100%; margin:0 }
  body {
    background:#0a0a0a; color:#fff; display:flex; align-items:center; justify-content:center;
    font-family:"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; text-align:center; padding:6vh 4vw;
  }
  .cap { font-size:clamp(11px,1.4vw,15px); font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:rgba(255,255,255,.55) }
  h1 { font-size:clamp(28px,5vw,64px); font-weight:600; margin:.25em 0 .15em; letter-spacing:-.01em }
  p  { color:rgba(255,255,255,.45); font-size:clamp(14px,1.7vw,22px); margin:0 }
  .ids { margin-top:clamp(24px,4vh,52px); padding-top:clamp(16px,2.5vh,28px); border-top:1px solid rgba(255,255,255,.09);
         display:flex; gap:clamp(18px,4vw,48px); justify-content:center; flex-wrap:wrap }
  .f { text-align:left }
  .f span { display:block; font-size:clamp(9px,1vw,12px); letter-spacing:.08em; text-transform:uppercase; color:rgba(255,255,255,.4) }
  .f b { font-family:"IBM Plex Mono", ui-monospace, Menlo, monospace; font-weight:400;
         font-size:clamp(14px,2vw,26px); color:rgba(255,255,255,.85) }
</style>
</head><body>
<main>
  <div class="cap">Stage Utility</div>
  <h1>${esc(headline)}</h1>
  <p>${esc(sub)}</p>
  <div class="ids">
    ${field("Device", info.id ?? undefined)}
    ${field("Address", info.ip)}
    ${field("Host", info.hostname)}
    ${field("MAC", info.mac)}
  </div>
</main>
<script>
  // Reload periodically so claiming it takes effect without anyone touching the
  // screen. The server also pushes a refresh on claim; this is the fallback for
  // when that missed, and it is why an operator never walks to the wall.
  setTimeout(function () { location.reload(); }, 15000);
</script>
</body></html>`;
}
