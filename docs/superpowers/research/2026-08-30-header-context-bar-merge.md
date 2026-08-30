# Merging the page header into the context bar — design note

Date: 2026-08-30
Status: study only. Nothing implemented, no decisions made.
Question: *"what would it look like to move and combine the context bar with
this bar to utilize all of that empty space and create more space for the
console?"*

Every pixel below was measured in a browser against a real server on a build of
`beta` — band heights from `getBoundingClientRect`, strip widths by binary-search
on the fit level the strip actually lands on. Nothing here is estimated except
where it says so.

---

## 1. What the chrome costs today

Three bands can sit above a page. Measured heights:

| Band | Height | Where it shows |
|---|---|---|
| Mobile top bar | **45px** (44 + 1px rule) | Under 640px only. Hamburger, page name, page actions. |
| Context bar | **44px** | Every page, every width. |
| Page header | **48px** with a title alone, **70px** with a title and a description | 640px and up only. |

They never all three show at once: the page header is `max-sm:hidden` and the
mobile top bar is mobile-only. So the real stack is two bands, whichever surface
you are on.

| Surface | Chrome | Of the viewport |
|---|---|---|
| Phone 390 × 844, console | 45 + 44 = **89px** | 10.5% |
| Phone 320 × 690, console | 45 + 44 = **89px** | 12.9% |
| Desktop 1440 × 900, console | 44 + 48 = **92px** | 10.2% |
| Desktop 1440 × 900, Home | 44 + 70 = **114px** | 12.7% |
| Desktop 1024 × 768, Home | 44 + 70 = **114px** | 14.8% |

A perfect merge leaves one 44px band, so the ceiling on what this can win is
**45px on a phone (5.3% of an 844-tall screen) and 48–70px on a desktop
(5.3–7.8% of a 900-tall one)**. That is the whole prize. It is not nothing, and
it is not the "all of that empty space" the screenshot suggests — the empty
space on a console's top bar is horizontal, and horizontal is exactly what the
context bar has none of.

## 2. What the merge costs

The context bar never scrolls and never wraps at any width from 320px up. When
it runs out of room it gives things up in four fixed rungs — full, qualifiers,
compact, floor — and four things it may never do: remove a number, remove a
state colour, drop an item the operator chose, scroll or wrap. See
[the context bar](../../features/context-bar.md) and `renderer/app/bar-fit.ts`.

Measured natural widths, per rung, for two arrangements:

| Arrangement | full | qualifiers | compact | floor |
|---|---|---|---|---|
| Default 3 items (service + plan, current item, live state and timer) | 380px | 269px | 166px | 78px |
| Maxed 7 items (adds clock, integration health, streaming, recording) | 709px | 575px | 279px | 191px |

What a merge takes off the row, measured on a console named "Monitor World":

- hamburger button **24px**, row gaps **16px**, page name **92px** → **132px** on a phone
- page name **92px**, gaps **16px**, page actions **32px** measured on Home (an
  icon button); a labelled button is nearer 120px → **140px**, or **228px** with
  a label, on a desktop

Put those together and the phone case decides itself:

| Case | Available now | Rung now | Available merged | Rung merged |
|---|---|---|---|---|
| 320, default set | 320 | qualifiers | 188 | compact |
| 320, maxed set | 320 | **compact, with 0px to spare** | 188 | **floor, 3px over — clipped** |
| 390, default set | 390 | full | 258 | compact |
| 390, maxed set | 390 | compact | 258 | floor |
| 1024 desktop, default set | 800 | full | 660 | full |
| 1024 desktop, maxed set | 800 | full | 660 | qualifiers (**572 with a labelled action → compact**) |
| 1440 desktop, default set | 1216 | full | 1076 | full |
| 1440 desktop, maxed set | 1216 | full | 1076 | full |

The number that ends the phone argument: **a maxed set at 320 fits today with
exactly 0px to spare, and a merged row puts it 3px past the floor.** Past the
floor there is nothing left to give — the floor works by ellipsising prose, and
an arrangement of numbers and marks has no prose to ellipsise. `useBarFit`
reports that as `over`, and `overflow: hidden` keeps it off the page, but a
clipped reading is the one failure this strip is built never to have quietly.

## 3. Recommendation

**Do not merge on a phone.** It buys 45px, 5.3% of an 844-tall screen, and pays
for it by breaking the invariant that #381 shipped a four-rung ladder to
protect. Even the default set drops two rungs at 390. The phone already carries
the merge that matters — its top bar holds the page name and the page's own
actions, which is why nobody has ever asked for a page header on a phone.

**Merge on a desktop.** It removes a whole 48–70px band, 5.3–7.8% of a 900-tall
screen, and the width is there: with the default arrangement the merged strip
stays on the full rung at every desktop width, and with a maxed arrangement it
stays there down to about **1290px of viewport** (1076px of strip: 709 for the
items, 92 for the name, 120 for a labelled action, 16 of gaps, 224 for the rail
and gutter). Below that it drops a rung — visibly, in the way the ladder was
designed to.

That split is not a fudge. The two bands answer different questions and the
answer differs by surface because the surfaces differ: a desktop has horizontal
room and no top bar, a phone has a top bar and no horizontal room.

Three details, if it is built:

- **The page name joins the ladder; the configured items do not.** "Never drop
  an item the operator chose" stays intact because the name is not one they
  chose — it is the shell's. It should be the first thing on the row to
  shorten, and it needs a floor of its own (about 14 characters) or the merge
  reintroduces the bug this branch just fixed.
- **The description goes.** It is already absent on a phone and on a console; a
  merged row has no line for it. Losing it is the cost of the merge, and it is
  the least-read thing on the page.
- **The strip stops being global.** Today it is the same on every page; merged,
  it carries a per-route name and per-route actions. That is a real change of
  scope, and it is acceptable only because the phone's top bar has always worked
  this way — the merged desktop bar is that pattern extended upward, not a new
  idea.

## 4. If the console needs more height on a phone

The merge is the wrong tool for it. A console at 390 × 844 gets 755px of
content; a merge would make that 800px. **Letting a console hide its chrome
outright returns all 89px and touches no invariant** — the same 844px a display
gets, with an explicit way back. That is a bigger win than the merge, on the one
surface where the merge is a bad trade.

Not proposed here, and not scoped. Named so the next study starts from it.
