# ScriptView and Baptisms

Two operator-facing surfaces built on the PCO plan.

## ScriptView

A per-service-type PCO **rundown dashboard** at `/scriptview` — an in-app replacement
for ScriptViewer. The landing page lists the service types you enable; each opens a
**deep-linkable** rundown at a readable URL (`/scriptview/weekend/audio`) you can pin in
its own browser tab. **Layouts are global** column presets (Audio / Video / Lighting / …)
shared across every service type, each with per-element toggles (**clock, time, song
key / BPM / arrangement, item notes, total time**) and **department row coloring**. The
projected clock follows the **plan's timezone**; the current item highlights live only
while a service is actually running. Configured in **Settings → ScriptView** with a live
preview.

## Baptisms

A standalone **`/baptism` operator page** (also a Settings tab) with a **grouped
workflow** (all testimonies, then all baptisms). Sessions are named by service and
**cross-linked into Service History** with per-person splits + averages. An on-air
**"Baptism timer"** layout object shows the live count/timer on a display.
