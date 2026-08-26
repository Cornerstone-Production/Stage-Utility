# The layout editor

The canvas an operator designs a custom View on. Object *rendering* is not here —
it comes from `renderer/main/layout-renderer.tsx`, which the kiosk uses too, so
what you see while editing is what a screen shows. Everything here is the chrome
around that: palette, inspector, selection, drag and resize.

## Behaviour inventory

Written by reading the file before splitting it, and checked after. A split is
where behaviour goes missing without anything failing, so this list is the thing
that gets driven by hand at the end — not the type checker, which cannot tell
that a callback stopped being passed.

### Selection
- click to select; click empty canvas to clear
- shift-click to add or remove from the selection
- marquee drag on empty canvas to select a region
- selection survives a re-render (keyed by object id)

### Moving and resizing
- drag an object to move it; drag a handle to resize
- multi-select drag moves every selected object together
- drop into a container re-parents, to `MAX_DEPTH` (2)
- dragging out of a container re-parents to the canvas

### Keyboard
- `Delete` / `Backspace` — remove the selection
- `Cmd/Ctrl-C` — copy, `Cmd/Ctrl-V` — paste with fresh ids, `Cmd/Ctrl-D` — duplicate
- paste and duplicate deep-clone children, giving every nested object a new id

There is **no arrow-key nudge**. The first draft of this list claimed one, from
habit rather than from reading — the editor's key handlers are exactly the five
above. Worth a note because "the inventory said so" is how a split gets blamed
for losing something that was never there, and equally how a real gap gets
waved through.

### Context menu
- Copy, Paste, Duplicate, Delete, each labelled for a multi-selection
- layer order within the object's own sibling scope

### Inspector
- per-object-type config editors (one per layout object type)
- style: surface preset, elevation, font size/weight, italic, uppercase,
  letter spacing, alignment, colour, radius, padding, line clamp
- position and size in pixels as well as fractions
- lock (no move/resize/delete, including anything nested inside a container)
- hidden
- "hide unconfigured" toggle, persisted in `localStorage`

### Canvas
- canvas size presets (16:9, 9:16, 4:3, 16:10, 21:9, 32:9, 1:1, 3:2, 5:4)
- background colour, or inherit the shared kiosk surface
- fit: letterbox, or responsive (Phase 4)

### Saving
- explicit save; dirty state tracked
- conflict detection via `View.rev` — the editor returns the revision it opened,
  so a save built on a layout someone else has since replaced is refused rather
  than silently overwriting their work

## Structure

| File | Holds |
|---|---|
| `layout-editor.tsx` | the shell: state, saving, composition |
| `editor-canvas.tsx` | canvas, drag/resize/marquee, drop targets |
| `inspector.tsx` | the right-hand panel and per-type config |
| `inspector-rows.tsx` | shared form primitives |
| `palette.tsx` | the object palette |
| `layout-templates.ts` | starting layouts and canvas presets |
