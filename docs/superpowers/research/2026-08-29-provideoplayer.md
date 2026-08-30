# ProVideoPlayer (PVP) integration — research

Date: 2026-08-29
Status: research only. Nothing implemented, no decisions made.
Scope: what PVP's HTTP API can support — a custom layout object, a Home card,
and a full set of automation triggers, conditions and actions.

Every field, size and behaviour in sections 1 and 2 was **observed live** against
a real PVP instance running a real church workspace on 2026-08-29, over 702
polled samples while pre-service loops were playing. Where something comes from
the vendor's documentation rather than observation, it says so. Where I could not
verify, it is under [Unverified](#unverified).

The host address and API token are deliberately absent from this document — this
repository is public. Substitute `PVP_HOST` and `PVP_PORT` throughout.

---

## 1. Reaching the API

```
http://PVP_HOST:PVP_PORT/api/0/<path>
```

Enabled in PVP under **Preferences → Network → Network API**, which carries four
settings that matter to us: `Enable`, `Port`, `Use HTTPS Connection`, and
`Require Authentication` with a generated token.

Observed on the live instance:

- The **API port and the documentation port are different.** The bundled API
  reference is served on its own port under `/help/api/0/`; every `/api/0/*` path
  on that port returns **404**. Probing the documentation port for API endpoints
  and concluding "the API is off" is a wrong conclusion that costs an hour — the
  API port is the one in Preferences.
- `Require Authentication` was **off**, and requests with no `Authorization`
  header succeeded. With it on, the docs specify `Authorization: Bearer <token>`.
- `Use HTTPS Connection` was **off**; HTTPS on the API port did not connect at
  all. So the transport follows that checkbox exactly.
- A missing endpoint returns **404**, not 401 — so a 404 does not distinguish
  "wrong path" from "API disabled". Both look identical from outside.

**No WebSocket, no SSE, no subscribe.** The word does not appear anywhere in the
API reference and no such endpoint exists. **This integration must poll**, which
puts it in the same family as `reaper-service.ts` — the one existing HTTP-polling
integration in this repo and the model to copy.

**No thumbnail, preview, frame or screenshot endpoint.** I enumerated all 80
documented paths and grepped for every synonym. There is no way to show a picture
of what PVP is outputting. **Every surface this integration can offer is text,
state and progress — never a visual preview.** This is the single most important
constraint on "visualize current playing content" and it should be stated to the
operator rather than discovered.

---

## 2. The one endpoint that matters

```
GET /api/0/transportState/workspace     →  11,495 bytes, 11 layers
```

One request returns the transport state of **every** layer. There is also
`/transportState/layer/{id}`, but it is strictly worse for our purpose: it costs
one request per layer, and the vendor's documented example for it **omits
`playingMedia`** while the workspace example includes it. Use the workspace
endpoint.

Observed shape, per entry in `data[]`:

```jsonc
{ "transportState": {
    "isPlaying": true,
    "isScrubbing": false,
    "playbackRate": 1,
    "timeElapsed": 9.6,
    "timeRemaining": 10.4,
    "playingItem":  { "name": "SERIES GRAPHIC", "uuid": "…" },   // MAY BE ABSENT
    "playingMedia": { "name": "…LoopGraphic_1.mp4", "uuid": "…" },// MAY BE ABSENT
    "layer": {
      "name": "Graphics (1s)", "uuid": "…",
      "isHidden": false, "isMuted": false, "opacity": 1,
      "transitionDuration": 1,
      "transition": { "name": "Dissolve", "enabled": false, "duration": 1, "variables": [], "uuid": "…", "favoriteUUID": "…" },
      "layerBlend": { "type": "Standard", "base": { "name": "Normal", "modeIndex": 0, "opacity": 1 } },
      "effects": [], "effectPresetUUID": "null", "targetSetUUID": "…"
    }
} }
```

### 2.1 Three observed behaviours that a naive reading gets wrong

These are the findings this research exists for. Each was established by watching
the live workspace, not by reading the vendor docs — the docs contradict none of
them, they simply do not mention them.

**(a) `playingItem` is RESIDUAL. It is not "what is playing now."**

With pre-service loops running on one layer, four idle layers simultaneously
reported:

```
Exit Screen     playingItem="SERIES GRAPHIC"  playingMedia ABSENT  isPlaying=false  rate=0
Lyr. Srip Lyr.  playingItem="SERIES GRAPHIC"  playingMedia ABSENT  isPlaying=false  rate=0
Graphics Lyrcs  playingItem="SERIES GRAPHIC"  playingMedia ABSENT  isPlaying=false  rate=0
Lwr 3rd Lyrics  playingItem="SERIES GRAPHIC"  playingMedia ABSENT  isPlaying=false  rate=0
```

`playingItem` is the last cue that *touched* that layer and it never clears. A
widget that renders it as "now playing" would show five layers all claiming
SERIES GRAPHIC while four of them display nothing.

**The reliable "this layer has content" signal is the PRESENCE of
`playingMedia`.** The key is absent — not null, absent — when a layer holds
nothing. Two key sets were observed across 702 samples:

```
["isPlaying","isScrubbing","layer","playbackRate","playingItem","playingMedia","timeElapsed","timeRemaining"]
["isPlaying","isScrubbing","layer","playbackRate","playingItem",                "timeElapsed","timeRemaining"]
```

**(b) `isPlaying: true` does not mean a video is rolling.**

A layer holding a still image reported `isPlaying: true` with `playbackRate: 0`
and `timeRemaining: 0`:

```
Lyric Strip (1s)   media="YouthKickoff_LED.png"  isPlaying=true  rate=0  remaining=0
```

So `isPlaying` means "this layer is live", not "time is advancing". The
distinction the UI actually needs:

| State | Test |
|---|---|
| Nothing on this layer | `playingMedia` absent |
| A still graphic | `playingMedia` present and `playbackRate === 0` |
| A rolling video | `playbackRate > 0` |

**(c) Progress is given directly and needs no arithmetic.**

`timeElapsed` and `timeRemaining` are **both** present, so duration is their sum
and a progress bar needs no separate lookup. Observed counting down 19.97 → 1.43
across a 20-second loop, advancing to the next cue automatically. Seven distinct
media files cycled in about two minutes on one layer.

### 2.2 What a layer being "on screen" actually requires

`playingMedia` present is necessary but not sufficient. `isHidden`, `isMuted` and
`opacity` are all on the layer and all independently able to make live content
invisible. Every observed layer was `isHidden: false`, `isMuted: false`,
`opacity: 1`, so **the hidden and zero-opacity paths are unverified in practice**
— but they are the states the Hide/Unhide and Opacity endpoints exist to set, so
a renderer must handle them.

---

## 3. The rest of the read surface

```
GET /api/0/data/layers                        8,914 bytes — layers without transport state
GET /api/0/data/playlists                     9,059 bytes — the full playlist tree
GET /api/0/data/playlist/{id}                 one playlist
GET /api/0/data/playlist/{pid}/cue/{cid}      one cue
```

`data/layers` is a strict subset of `transportState/workspace` for our purposes
and should not be polled separately.

The live playlist tree, which is what an automation would target:

```
Root
  **MASTERS**                 8 cues
  PreService                 13 cues
  PreRoll                     2 cues
  Hosting                     7 cues
  Teaching                    8 cues
  Bene/Reflection/MS Post     3 cues
  HS PostService             13 cues
  Video Input                 3 cues
```

Cues carry only `{ uuid, name }`. Playlists nest via `children`, and the tree is
one level deep here but the format allows more. `Video Input` is addressable by
index `-1` as well as by UUID, per the vendor docs.

Every `{id}` accepts a **uuid, a name, or an index**, with one documented trap:
**a parameter that is only digits is always read as an index, never a name.** A
playlist named "2024" could not be addressed by name.

Control vocabularies, all read-only GETs, observed counts on the live instance:

| Endpoint | Entries |
|---|---|
| `/blendMode` | 27 |
| `/transition` | 39 |
| `/effects` | 37 |
| `/targetSet` | 7 |
| `/layerPreset` | 0 |
| `/effectsPreset` | 0 |

Presets are empty in this workspace. Anything built on them must handle an empty
list as normal, not as an error.

---

## 4. The write surface — and why none of it was tested

PVP exposes a substantial control API:

```
POST /trigger/cue/{id}
POST /trigger/playlist/{id}
POST /trigger/playlist/{pid}/cue/{cid}
POST /trigger/layer/{lid}/playlist/{pid}/cue/{cid}
POST /clear/workspace          POST /clear/layer/{id}
POST /mute/workspace           POST /mute/layer/{id}
POST /unmute/workspace         POST /unmute/layer/{id}
POST /hide/workspace           POST /hide/layer/{id}
POST /unhide/workspace         POST /unhide/layer/{id}
POST /select/layer/{id}        POST /select/playlist/{id}
POST /opacity/layer/{id}                     { "value": 0.5 }
POST /blendMode/layer/{id}     POST /blend/layer/{id}
POST /transition/workspace     POST /transition/layer/{id}
POST /transitionDuration/workspace           /transitionDuration/layer/{id}
POST /effects/workspace        POST /effects/layer/{id}
POST /effectsPreset/workspace  POST /effectsPreset/layer/{id}
POST /layerPreset/layer/{id}   POST /targetSet/layer/{id}
```

### 4.1 Verified live, and the results change the design

The operator authorised POST testing outside a service. State was snapshotted
first and every mutation restored. Findings:

**A 200 means "request received". It does NOT mean anything happened.**

Every POST returns **HTTP 200 with an entirely empty body** — no JSON, no
confirmation, no echo of the applied value. And several endpoints return 200
while doing nothing at all:

| Call | HTTP | Effect |
|---|---|---|
| `POST /hide/layer/4`, `/unhide`, `/mute`, `/unmute` | 200 | **Worked.** Confirmed by reading `transportState` back. |
| `POST /opacity/layer/4` `{"value":0.5}` | 200 | **Worked.** `GET /opacity/layer/4` → `{"opacity":{"value":0.5}}`. |
| `POST /opacity/layer/4` `{"value":5}` (out of range) | 200 | **Silently CLAMPED to 1.** Not rejected. |
| `POST /opacity/layer/4` `{"nope":1}` (malformed) | 400 | Correctly rejected. |
| `POST /hide/layer/99` (no such layer) | 400 | Correctly rejected. |
| all five `trigger` forms | 200 | **ALL FIRE.** See the correction below. |

### 4.2 CORRECTION — the trigger no-ops were MY measurement error

An earlier pass of this document claimed four of five trigger forms were proven
no-ops. **That was wrong, and the error was in how it was measured.**

It compared `transportState` immediately before and immediately after each POST,
within the same second, and read "identical `playingMedia`" as proof that
nothing happened. PVP has **apply latency**: the change lands a beat later. The
before/after reads were simply too close together to see it.

A second error compounded it. The retest asked "did the media change at all",
which is unanswerable while the pre-service playlist auto-advances every 20
seconds — a change may be the trigger or may be the loop. The right question is
**"did the media become the media of the cue I asked for"**.

Re-measured properly: move away to a known different cue, fire, then poll for
three seconds and check the landing cue by name.

| Form | Result |
|---|---|
| `/trigger/cue/{n}` (current playlist) | **FIRES** |
| `/trigger/playlist/{name}/cue/{n}` | **FIRES** |
| `/trigger/playlist/{uuid}/cue/{n}` | **FIRES** |
| `/trigger/playlist/{index}/cue/{n}` | **FIRES** |
| `/trigger/layer/{l}/playlist/{p}/cue/{c}` | **FIRES** |

Controlled against the obvious alternative — that any trigger merely resets to
the top of the playlist. Asked for cues 4, 9, 2 and 11 in turn; each landed on
exactly the cue requested:

```
asked cue 4  ("…LoopGraphic_5_Merch")    -> playing …LoopGraphic_5_Merch.mp4
asked cue 9  ("…LoopGraphic_10_Photos")  -> playing …LoopGraphic_10_Photos.mp4
asked cue 2  ("…LoopGraphic_3_Photos")   -> playing …LoopGraphic_3_Photos.mp4
asked cue 11 ("…LoopGraphic_12_Photos")  -> playing …LoopGraphic_12_Photos.mp4
```

**What still stands from the original finding, and it is the important half:**
a POST returns 200 with an empty body whether or not anything happened. That is
unchanged and remains the reason every action must verify by reading state back.
What changed is only that triggers are usable — the verify-then-report design
was built for the right reason and needs no revision.

**The one genuine no-op remains:** `/trigger/layer/4/playlist/…` did not put
content on the empty TAG layer. Whether the layer argument is ignored (the cue
firing onto its own layer instead) or TAG rejects that media is **unverified**.
Do not rely on the layer argument to redirect a cue until that is settled.

`/clear/layer/{id}` returned 200 on an already-empty layer; clearing a layer with
content was not tested.

---

## 5. How this maps onto the three asks

### 5.1 Custom layout object

One request feeds everything. Per layer: media name, cue name (labelled as the
*last* cue, never as "now playing" — see 2.1a), a progress bar when
`playbackRate > 0`, and badges for hidden / muted / opacity below 1.

An 11-layer stack does not fit a wall widget at wall-legible type. The object
needs a mode: **all layers**, or **only layers with content** (2 of 11 at the
moment observed), or **one named layer**. "Only layers with content" is the
useful default — it turns an 11-row list into a 2-row one and is exactly the
question an operator glancing at a screen is asking.

### 5.2 Home card

The compact form: what is on screen now and how long is left. With
`timeRemaining` given directly, a countdown to the end of the current loop item
is free and is genuinely useful pre-service.

### 5.3 Automations — the largest opportunity

This repo's automation tab currently exposes five action kinds
(`companion.signal-from-roster`, `display.refresh`, `log.message`, `osc.send`,
`rosstalk.command`). PVP roughly doubles that, and it would be **the first
integration in this app that can drive content rather than only report it**.

Natural triggers, all derivable from polled transport state:

| Trigger | Derivation |
|---|---|
| a cue starts on a layer | `playingMedia` uuid changes on that layer |
| a layer clears | `playingMedia` present → absent |
| playback reaches its end | `timeRemaining` crosses to 0 with `playbackRate > 0` |
| a layer is hidden / unhidden | `isHidden` transitions |
| a layer is muted / unmuted | `isMuted` transitions |
| PVP connects / disconnects | the standard connection triggers every integration gets free |

Natural conditions: layer N has content; layer N is playing a video; layer N is
hidden; layer N is muted; the workspace has anything on screen at all.

Natural actions, all from §4 and all unverified: trigger a cue, trigger a
playlist, trigger a cue onto a specific layer, clear the workspace, clear a
layer, hide/unhide, mute/unmute, set opacity, set transition.

The diff key for change detection is **layer uuid + `playingMedia` uuid**. Not
the layer index — layer order is presentation, and an operator reordering layers
would read as every layer changing at once. Not the media *name* — the observed
workspace has seven files whose names differ only by a trailing digit, and two
cues in different playlists can share a media file.

---

## 6. Polling cost

11.5 KB per poll for full workspace transport state. For a pre-service loop
advancing every 20 seconds, a 2-second cadence is comfortably enough to catch
every cue change; 1 second gives a smooth progress bar and costs 41 KB/s on the
LAN, which is nothing on a wired network and is the same order as the REAPER
integration's 1 Hz poll.

The house rules that apply, both of which the REAPER integration already
demonstrates:

- **Broadcast on change, not on poll.** `StatusIntegration.emitIfChanged` is a
  shallow compare, so a payload carrying a per-poll timestamp would broadcast
  every tick. `timeElapsed` and `timeRemaining` change on *every* poll during
  playback, so they cannot be part of the change comparison — otherwise a
  1 Hz poll becomes a 1 Hz SSE frame to every display. Either exclude them from
  the compared payload and let the client interpolate locally from a start
  timestamp, as the PCO countdown already does, or accept the frame rate
  deliberately and say so. **This is the single biggest efficiency decision in
  the integration and the plan must make it explicitly.**
- **Gate on `inDemand`, not `hasSubscribers`**, so automation rules still fire on
  an unattended appliance.

---

## Unverified

Stated plainly so none of it becomes a bug in a plan:

- **Whether the LAYER ARGUMENT of `/trigger/layer/{l}/playlist/{p}/cue/{c}`
  actually redirects a cue.** All five forms fire (§4.2), but the one attempt to
  send a cue to a specific empty layer did not put content there. Unknown whether
  the argument is ignored or the layer refused the media.
- **The untested POSTs**: blend mode, transitions, transition duration, effects,
  effects presets, layer presets, target sets, and the workspace-wide
  clear/mute/hide (not tested because they would blank every screen at once).
- **`/clear/layer/{id}` against a layer holding content.** Only tested empty.
- **Authentication.** `Require Authentication` was off. The `Bearer` header path,
  and what a wrong token returns, were not observed.
- **HTTPS.** `Use HTTPS Connection` was off and HTTPS did not connect. Certificate
  behaviour — PVP's docs use `curl -k` throughout, implying self-signed — is
  unverified, and a self-signed certificate would need explicit handling in
  `fetch`.
- **`isHidden`, `isMuted`, `opacity < 1`.** Every observed layer was visible,
  unmuted and fully opaque. The renderer must handle these states but they have
  not been seen.
- **Multi-machine.** Preferences show a "Slave Machines" list, empty here. Whether
  a master reports slave state through this API is unknown.
- **`isScrubbing`** was `false` in all 702 samples.
- **Negative or fractional `playbackRate`.** Only 0 and 1 were observed.
- **Deep playlist nesting.** The live tree is one level; the format allows more
  and the vendor example shows a nested group.
- **Behaviour when no workspace is open**, and whether the API returns an empty
  `data[]` or an error.
- **Whether `playingItem` ever clears.** It persisted across every idle sample,
  but a `clear` was never issued, so it is unknown whether clearing a layer
  removes it.
