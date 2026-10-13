# A console without chrome — design note

Date: 2026-08-30
Status: study only. Nothing implemented, no decisions made.
Follows: [Merging the page header into the context bar](./2026-08-30-header-context-bar-merge.md),
whose section 4 named this and did not scope it.

Question: *"I would be down to look at getting rid of the chrome, maybe either
just a hamburger menu or also implementing swipe from the left edge to open the
sidebar menu? … The side swipe would have to be incredibly good and smooth and
not buggy at all."*

---

## 0. The short version

A console on a phone pays **89px of 844** for chrome it does not use. Returning
it is worth doing, and the way back has to be a **floating hamburger that never
fades**, because it is the only exit that works in every container the app is
opened in.

The left-edge swipe should **not** be built. Not because it would be hard to
make smooth — the drag mechanics are about sixty lines and no dependency — but
because the edge is contested, the outcome differs by platform, and taking the
edge on the one platform where we can take it costs the operator their most
reliable way out. "Incredibly good and not buggy at all" is not reachable there.

What *is* reachable, and should be built: **drag-to-close on the open drawer**,
following the finger, interruptible, settling on velocity. That gesture starts
on our own overlay, contests nothing, and behaves identically everywhere.

There is also a live defect. The edge swipe **already ships** — it is not
aspirational — and in its current form it is precisely the thing he asked not to
build. Section 2 measures it.

---

## 1. Who owns the left edge

The premise this study set out to test was that on iOS Safari the left edge
belongs to the browser's back gesture and a page cannot preempt it, so an edge
swipe would only be possible in a home-screen PWA. **That is backwards.** The
edge is reclaimable in a plain Safari tab and is *not* reclaimable in a
standalone home-screen app, nor on Android at all.

### 1.1 What the page gets, measured in this app

Measured in the real app (this branch's build, served from a temp data dir),
driving synthetic touches through CDP `Input.dispatchTouchEvent` and reading the
listener table back through `DOMDebugger.getEventListeners`.

**React registers the gesture's only cancellable event passively.** On the app's
React root container, both capture and bubble phases:

| Event | `passive` |
|---|---|
| `touchstart` | **true** |
| `touchmove` | **true** |
| `touchend` | false |
| `touchcancel` | false |

This is deliberate on React's part and has been since React 17
([facebook/react#19654](https://github.com/facebook/react/pull/19654), merged
August 2020, still the behaviour in the 19.2.8 this app pins): "`e.preventDefault()`
in them stays broken." A passive listener cannot cancel an event, so
**`preventDefault()` inside the `onTouchStart` in `split-view.tsx` is a no-op.**
The app cannot claim the gesture today in any browser, on any platform. Nothing
about that is iOS-specific.

**And the page gets exactly one chance.** Tracing `cancelable` across a real
left-edge drag from x=8:

```
touchstart@8    cancelable=true
touchmove@32    cancelable=true
touchmove@44    cancelable=false
touchmove@56    cancelable=false     ← and every move after
touchend@152    cancelable=false
```

Once the first move goes uncancelled, the compositor commits the gesture and the
page is a spectator. Claiming the edge therefore requires a **non-passive
listener attached natively through a ref** — React's synthetic handler cannot do
it, whatever it is written to do.

### 1.2 What each container allows

| Container | Left-edge gesture | Can the page take it? |
|---|---|---|
| **iOS Safari, plain tab** | Back / forward navigation | **Yes** — non-passive `touchstart` + `preventDefault`, iOS 13.4+ |
| **iOS home-screen app** (`display: standalone`) | Back / forward navigation, present since iOS 12.2 | **No** |
| **Android Chrome, gesture nav** (Android 10+) | System Back — the OS, above the browser | **No** |

Two things follow, and both cut against the original plan.

**A standalone PWA does not remove the gesture; it removes the escape.** iOS
12.2 added edge back/forward swipe to home-screen web apps, and there is no way
to opt out of it —
[w3c/pointerevents#358](https://github.com/w3c/pointerevents/issues/358) is open
precisely because installed apps cannot, and it is still labelled for a future
spec version with no implementation. So moving to standalone would leave the
gesture in place, take away the address bar and the browser's back button, and
leave the operator with strictly fewer routes out than they have now.

**Android never yields the edge.** With gesture navigation the back swipe is
intercepted by the system before Chrome sees it. The only opt-out,
`View.setSystemGestureExclusionRects()`, is a native Android API with no web
surface. An edge swipe would work on his iPhone and do nothing on any Android
phone — in a tab or installed, either way.

### 1.3 So it is available in a tab. It still should not be taken.

He is in a plain Safari tab today (the screenshot shows Safari's bottom bar), so
section 1.2 says the edge is technically ours for the taking. Three reasons not
to:

- **It costs the escape hatch.** In a tab with the chrome hidden, the browser's
  back gesture is the operator's guaranteed way out. Spending it to install a
  drawer-opening gesture trades a reliable exit for a less reliable one, on the
  one surface where being stranded matters most.
- **It cannot be consistent.** Working on iOS and silently doing nothing on
  Android is the definition of the buggy feel he asked to avoid. A gesture that
  half-exists is worse than one that does not.
- **Nothing advertises it.** With the chrome gone there is no visual hint the
  edge is live, so the gesture is only ever found by someone who already knows.
  A hamburger is its own instruction.

**Recommendation: hamburger everywhere as the way in; no edge-swipe-to-open, in
any container.** If that is ever revisited, it should be revisited as a per-view
opt-in for an operator who has confirmed it on their own device — not as a
default.

---

## 2. The edge swipe already ships, and it is the bad version

`renderer/components/ui/split-view.tsx` line 38 describes a "slide-over drawer;
swipe left to close". Both halves exist — lines 65-79 and the 16px strip at lines
100-106. They are not aspirational, and they are not good.

Measured, at 390×844, against the running app:

- The edge strip is `fixed left-0 top-0 z-30 h-full w-4` — **16px wide**, sitting
  inside iOS Safari's back-gesture zone, with **`touch-action: auto`**, so it
  does not even declare an intent to own the axis.
- The drawer is **absent for the entire drag**. Probing at x=8, 40, 90 and 140
  returns `absent` every time; 20ms after `touchend` it is present at `x=0,
  w=256, transform=none`. It does not follow the finger by a single pixel — it
  is a threshold that fires a state change.
- Under the 48px threshold (`SWIPE_MIN`), a 44px drag does **nothing at all** —
  no movement, no snap-back, no feedback that anything was attempted.

So on his phone today, an edge drag races Safari's back gesture and loses
non-deterministically: sometimes the page navigates back, sometimes a drawer
appears from nowhere with no transition. That is the exact failure mode he
described wanting to avoid, and it is live.

**This should be removed** whether or not the rest of this note is built. It is
16px of permanently-mounted contested surface buying a gesture that cannot work
as written. Removing it is strictly an improvement: the hamburger is unaffected,
and the browser gets its edge back cleanly.

---

## 3. The floating hamburger

The reliable answer, and the thing that makes hiding chrome safe at all. Hiding
the only navigation on a phone strands the operator on that console — section 5
shows the hamburger is the *only* route out that survives every container.

**It is persistent. It never fades, and it never dims.** Two temptations to
refuse:

- *Fade after inactivity, return on tap.* On a console the first tap would land
  on the reveal rather than on the button underneath it. Swallowing an
  operator's press during a live service to show them a menu they did not ask
  for is not a trade worth making.
- *Fade to a low opacity and stay pressable.* Better, but it makes the one
  guaranteed exit the least visible thing on screen, and an operator who needs
  it needs it under pressure.

44×44px is 0.6% of a 390×844 screen. The chrome it replaces is 10.5%. There is
no pressure to shrink it further.

**Placement: bottom-left by default, operator-choosable to any corner.**

- *Bottom*, not top: the top of an 844-tall phone is the hardest place to reach
  one-handed, and the top is exactly the band this whole change is reclaiming —
  putting a button back up there re-establishes the thing being removed.
- *Left*: the drawer comes from the left, so the control and the panel it opens
  agree about direction.
- Inset above `env(safe-area-inset-bottom)` so Safari's bottom bar and the home
  indicator do not sit under it.

**On overlapping a control** — a console *is* buttons, so any fixed position
overlaps something on some layout, and the app cannot know which. Two honest
answers, and the note takes both:

1. Let the operator pick the corner. They are the only one who knows where their
   layout is empty. Four choices, stored with the console.
2. Give the button a scrim disc so it is legible over whatever it lands on, and
   never let it grow past its own footprint.

What is deliberately *not* proposed: reserving a lane for it. A 44px band across
the bottom gives back half of what was just won.

---

## 4. The drawer drag, done properly

Scoped to **closing** an already-open drawer. That gesture starts on our own
overlay, well inside the screen and away from the browser's edge zone, and moves
left — away from the direction the back gesture travels. It contests nothing, and
it behaves the same on every platform.

It also answers the question "what happens to a swipe that starts on a console
control": **nothing ever does.** With no edge-swipe-to-open, no gesture in this
design ever begins on a console. That is a direct benefit of the scoping
decision, not a coincidence.

Requirements, all of them his:

**Follows the finger.** A single `x` in a ref, written on every `pointermove`,
applied as `transform: translate3d(-x, 0, 0)` on the drawer and an interpolated
`opacity` on the scrim. Both are compositor properties. Never `left`, never
`width`, never `margin` — animating layout is what makes a drag feel like it is
being reported rather than performed.

**Interruptible.** The settle is a transition on the same `transform`. A new
`pointerdown` during it reads the current computed matrix, clears the transition,
and adopts that value as the new origin. Because there is only ever one number,
there is no state to reconcile — grabbing a drawer mid-flight is the same code
path as grabbing a still one.

**Settles on velocity as well as distance.** Keep the last two move samples;
close if velocity exceeds roughly 0.5 px/ms in the closing direction *or* travel
passes ~40% of the drawer width, otherwise spring back. Velocity alone strands a
slow deliberate drag; distance alone ignores a fast flick that only travelled
30px. Both, or it feels wrong in one of the two ways.

**Does not fight the scroller.** The drawer's contents scroll vertically. Set
`touch-action: pan-y` on the drawer so the browser keeps vertical scrolling
native and hands us the horizontal axis, then lock the axis on the first move and
do not change it for the rest of the gesture. Axis-switching mid-drag is a
distinct kind of jank from dropped frames and is more annoying.

**Respects `prefers-reduced-motion`.** The drag itself still tracks the finger —
direct manipulation is not the unrequested motion the setting is about. The
*settle* becomes instant instead of eased. Same rule the progress rule already
follows (`c629b00`).

**`will-change: transform` only while dragging**, cleared on release. Permanent
`will-change` keeps a compositor layer alive for a gesture that happens a few
times a service.

### No dependency

This is a `pointerdown`/`pointermove`/`pointerup` triple, one ref, one rAF, and a
transition class — call it sixty lines. A gesture library is the obvious
temptation here and it is not justified: it would import a general solution to
drag-and-fling for one drawer with one axis and two resting states, and the repo
has a standing rule against adding a dependency that a small amount of local code
covers. **No new npm dependency is proposed.**

The one piece that genuinely cannot be done through React is attaching
`touchmove` non-passively — and this design does not need to, because
drag-to-close never has to cancel anything the browser wanted. `touch-action:
pan-y` does the whole job declaratively. That is another dividend of dropping the
edge swipe.

---

## 5. Every route back, and which ones survive

A console at `/consoles/<viewId>` renders inside `Shell` → `SplitView`, in the
`app.html` document. With its chrome hidden, these are all the ways out.

| Route | Plain Safari tab | iOS home-screen app | Android Chrome tab | Android installed |
|---|---|---|---|---|
| **Floating hamburger → drawer → rail** | **yes** | **yes** | **yes** | **yes** |
| Browser back button / toolbar | yes | absent | yes | absent |
| Browser edge-swipe back | yes, if history | yes, if history | — | — |
| Android system Back | — | — | yes | yes |
| Address bar / tab switcher | yes | absent | yes | absent |

Two things to read off it.

**The hamburger is the only row that is true everywhere.** Everything else is
absent in at least one container. That is not a nice-to-have argument for keeping
it visible — it is the reason it may never fade, and the reason a chrome-free
console cannot ship without it.

**"Back" is conditional even where it exists.** It depends on there being history
to go back to. A console reached by navigating inside the app has some; a console
opened from a bookmark or a home-screen icon is the first entry, and back leaves
the app or does nothing. So the browser's own controls answer the question in
*his* container today, but they cannot be the design's answer.

**In a plain tab specifically** — the container he is actually in — at least two
routes always work: the hamburger, and the browser toolbar (which a tab always
has, even with no history). The requirement is met with one to spare.

---

## 6. Which surfaces lose chrome, and how the operator chooses

### 6.1 It is not the same mechanism as #368, and it should not pretend to be

`Output.hideTopBar` (`main/types/views.ts:993`, shipped in #368) is per **Output**
— a physical screen — and it hides `KioskTopBar` in the *kiosk* document
(`renderer/main/stage-view.tsx:225`). It has no effect on the operator app: it
touches neither the 45px mobile top bar in `split-view.tsx:87` nor the 44px
`ContextBar`.

A console is a different thing on a different surface. It is a `View` with
`surface: "console"`, rendered by `ConsoleRoute` at `/consoles/$viewId`, inside
the operator shell. It has no `Output` row at all, so `hideTopBar` has nothing to
hang on.

So this is **the same idea on a second surface, not an extension of the same
switch.** The right move is to reuse the vocabulary and the shape — an optional
boolean, defaulted off, stored with the thing it describes — without pretending
one field can serve both. Note that a display already gets the full viewport for
free, and not through a flag: it is served by a *different document*
(`index.html`, `RootView`) that has no shell in it. A console cannot borrow that.

### 6.2 Where the flag lives

**On the `View`, as an optional boolean, alongside `slotsLayout` and the other
per-view options.** Not per-Output (a console has none), and not `localStorage`
(the operator sets a console up once; it should not have to be re-hidden on every
phone that opens it).

It hides **both bands** — the 45px top bar and the 44px context bar — because 89px
is the number that makes this worth doing and 45px alone is the merge the prior
study already rejected. An operator who wants some live context back has a better
tool already: #381 gave a phone its own context-bar item set, so the bar can be
trimmed to two items without hiding it. That is why this is one flag and not two,
and it is the specific thing to watch in beta — if operators reach for "top bar
gone, context bar kept", the item set is where to look before adding a state.

**Honoured at every width, not phone-only.** A setting that does nothing on the
device you set it on is worse than one that is occasionally unnecessary, and an
operator running a console full-screen on a booth monitor wants exactly this.

`View` already carries a retired per-view boolean — `showLiveControls`, deprecated
at `main/types/views.ts:172` — which is the closest precedent in shape and a fair
caution: a per-view flag is cheap to add and awkward to remove.

### 6.3 Not automatic

Not "automatic on a phone". The operator chose to put a context bar on their
phone (#381 exists because they wanted that choice); silently overriding it on
one route would undo a decision they made deliberately.

---

## 7. What the manifest says today

Not load-bearing for this design, since section 1.3 recommends against standalone
— recorded because the question was asked and the answers are not what the
install test implies.

`public/manifest.webmanifest`, in full: `display: standalone`, `start_url: "/"`,
one 512px icon, `#0e0e0e` for both colours. No service worker anywhere in the
tree. No `display-mode` or `navigator.standalone` detection anywhere in the
renderer. `renderer/install-metadata.test.ts` asserts the iOS meta tags, the
theme colours and the R=G=B rule — and **nothing** about `start_url`, `scope`,
`display` or `icons`.

Two gaps, if standalone is ever pursued:

- **`start_url` is `/`,** so an install made from a console launches at Home, not
  at that console. Making a console its own installed app needs a per-console
  manifest with its own `start_url` and `id`, plus a per-route `<link
  rel="manifest">`. Neither exists.
- **`scope` is absent.** It defaults to `/`, which is wide enough in principle,
  but omitting it on iOS is widely reported to send every in-app link out to
  Safari. Worth setting explicitly regardless of this design.

---

## 8. Summary of what is proposed

| | |
|---|---|
| **Build** | A persistent floating hamburger on a chrome-free console; corner-choosable, never fading. |
| **Build** | Drag-to-close on the drawer: follows the finger, interruptible, velocity + distance, `transform` only, `touch-action: pan-y`, reduced-motion aware. |
| **Build** | An optional per-`View` boolean that hides both bands on a console, off by default, honoured at every width. |
| **Remove** | The 16px left-edge strip and the threshold swipe in `split-view.tsx`. It contests iOS Safari's back gesture, cannot win deterministically, and does not follow the finger. |
| **Do not build** | Edge-swipe-to-open, in any container. |
| **Do not build** | A per-console PWA install path. It removes escape routes rather than adding them. |
| **No** | New npm dependencies. |
