# Ross Ultritouch

A Stage Utility console on a Ross Ultritouch panel, through DashBoard's Browser
component. Nothing on the panel is Stage Utility's own; the panel shows a web
page, and the page is a console sized to the panel's pixels.

## The panels

| Model | Display |
|---|---|
| Ultritouch-2 | 1366 x 203 |
| Ultritouch-2-HR | 1920 x 285 |
| Ultritouch-4 | 1366 x 485 |

From the Ultritouch User Guide (2201DR-304). PanelBuilder's own Ultritouch-2
template is 1304 wide, so the frame may take some width; the layout is
letterboxed, so a few pixels of background at the sides is the worst case.

## In Stage Utility

1. **Screens → New view → Custom Layout**, pick *A control surface you operate*,
   and start from the strip for your panel. The canvas is set to the panel's
   pixels with Letterbox fit locked: the layout keeps its shape and scales
   evenly wherever it is previewed, and never reflows.
2. **Edit** the console. Each starter button is a [cue button](../reference/widgets.md#control)
   with no cue yet; pick one in the inspector. Add, remove and resize as you like.
3. **Screens → New screen** for the panel, set its mode to **panel**, point it at
   the console, and turn on **Hide top bar**. Give it a slug, say `ultritouch`,
   so its address is `http://<server>/ultritouch`.

## In DashBoard

1. Open an existing `.grid` for the panel, or **File → New**, and turn on
   **Edit Mode**.
2. Choose the **Browser** tool and drag it across the whole canvas, edge to edge.
3. In its properties set **URL** to the screen's address, including `http://`,
   and **Type** to **CHROMIUM**.
4. Leave Edit Mode. The console shows in DashBoard on your computer at the
   panel's shape; that is what the panel will draw.
5. **File → Save As**, then on the Ultritouch's device page **Manage
   CustomPanels → Upload to Folder**, and open it from **Manage Open Views**.

## If the panel shows nothing

- A white frame with no text at all is usually the panel failing to reach the
  address, not the page failing to run. On the Ultritouch's own **Network
  Settings**, DHCP off leaves both DNS fields at `0.0.0.0`, so a hostname never
  resolves and the browser draws blank. Fill in a DNS server, or use the
  server's IP address in the URL. `http://<server>/api/health` is a plain line
  of text and tells reachability apart from a page problem.
- The Browser **Type**: if CHROMIUM shows blank on the panel but not on your
  computer, the panel's DashBoard lacks it; try DEFAULT.
- The URL needs its scheme: `http://`, not `http:`.
- The screen must be in **panel** mode. A console on a display-mode screen is
  refused by the server, and a wall layout on a panel draws buttons that do
  nothing.
- **Hide top bar** off leaves the brand, plan and QR bar taking a quarter of a
  203-pixel strip.
