# ProVideoPlayer integration

Shows what ProVideoPlayer has on each layer — the media, the last cue, how long is
left, and whether a layer is hidden, muted or faded — on a stage display, on Home,
and to automation rules. Rules can also drive PVP: fire a cue, clear a layer,
hide, unhide, mute, unmute, and set a layer's opacity.

**There is no preview image, and there cannot be one.** ProVideoPlayer's network
API exposes no thumbnail, preview, frame or screenshot endpoint of any kind, so
everything here is a name, a state or a time — never a picture of what is on
screen.

## How it works

PVP has no WebSocket, no SSE and no subscribe endpoint, so the integration polls
its **Network API** over HTTP:

- `GET http://<host>:<port>/api/0/transportState/workspace` returns every layer in
  one request (~11 KB for eleven layers).
- The poll runs ~1 s while a display or an automation rule is using the
  `pvp:status` channel, drops to ~5 s when nothing is, and backs off
  exponentially while PVP is unreachable.
- It broadcasts **on change**, not on poll: the time codes are excluded from the
  comparison and the client ticks the progress bar itself from an anchor. With a
  video rolling that is around five frames per thirty seconds rather than thirty.
- The API token, if you use one, is stored encrypted with the other secrets and
  never appears in a log line.

## Setup

**In ProVideoPlayer:** Preferences → Network → **Network API** → enable it and
note the **port shown there**. Leave *Use HTTPS Connection* off (see below). If
*Require Authentication* is on, copy the generated token.

**In Stage:** Settings → Integrations → **Control & output → ProVideoPlayer** →
enter the **Host** and the **Network API Port**, paste the **API Token** if you
use one, enable it, and **Test connection**. A successful test names how many
layers PVP has and how many are showing something.

**On a layout:** add object → **ProVideoPlayer → ProVideoPlayer layers**. Options:
which layers to show (all, only the ones holding something, or one by name), show
progress, and hide when nothing is on screen. **ProVideoPlayer** is the Home card
version — up to three layers with content, no options.

## Three things that will otherwise surprise you

**The Network API port is not the documentation port.** PVP serves its API
reference on a different port, and every `/api/0/…` path on that one returns 404.
A 404 does not distinguish a wrong path from a disabled API, so probing the wrong
port looks exactly like "the API is off". The port in the Network API preferences
pane is the one to enter.

**The cue name is the last cue that TOUCHED the layer, not what is playing.** It
is the only thing PVP reports and it never clears — four idle layers were observed
simultaneously naming the same cue while displaying nothing. Stage draws it only
on a layer that actually holds something, which is why the widget looks different
from PVP's own UI. "Has content" is decided by whether the layer holds media, and
by nothing else.

**HTTPS is not supported against a self-signed certificate.** PVP's own
documentation uses `curl -k` throughout, which implies one, and this app will not
accept it. Leave *Use HTTPS Connection* off unless you have installed a
certificate this machine trusts; if you turn it on and the connection fails, the
test says so explicitly rather than reporting PVP as down.

## Rules

Triggers: a cue starts on a layer, a layer clears, a clip stops rolling, a layer
is hidden or unhidden, a layer is muted or unmuted, and PVP connects or
disconnects. Conditions: a layer has content, is playing a video, is hidden or is
muted, PVP has something on screen at all, and PVP is connected.

A cue starting means the layer began showing **different** media. The same clip
looping round is not a new cue and does not fire.

Layers, playlists and cues are matched **by name, not by id** — an id is opaque
and changes when a workspace is rebuilt from a template. **Renaming a layer in
ProVideoPlayer stops the rule**, silently. Nothing else will tell you. A name that
is only digits cannot be used at all: PVP reads an all-digits value as a position
rather than a name, and Stage refuses it rather than firing at the wrong thing.

## What is verified, and what is not

**ProVideoPlayer answers every command with "OK" whether or not it acted on it,
and applies the change a moment later.** So every ProVideoPlayer action reads
PVP's state back to confirm what it did, retrying briefly. A command that was
accepted and ignored is recorded as a **failure** in the Activity log, not a
success — which is the opposite of what the log would otherwise show.

Confirmed working against a live instance: hide, unhide, mute, unmute, set
opacity, and clearing a layer that was already empty. Confirmed too that an
out-of-range opacity is silently clamped rather than rejected, which is why Stage
refuses one before sending it.

**Cues are addressed through a playlist.** `POST /trigger/playlist/{playlist}/cue/{cue}`
takes either names or positions and works with both. The bare
`POST /trigger/cue/{cue}` form takes a **position only** — a cue name there is
rejected outright with HTTP 400. An earlier reading that most addressing forms
did nothing was a measurement error: the state was read back within the same
second as the request, before PVP had applied it.

**Firing a cue confirms that the cue MOVED, not just that it is named.** The cue
name PVP reports is residual, so a cue that has already played on a layer stays
named there forever — a check that only asked "is the cue there" would confirm a
repeat trigger instantly, against a PVP that did nothing, even on a layer since
cleared to black. Stage takes a reading before the command and requires something
to have changed: a different cue, different media, or the clip restarting. The one
case it cannot confirm is re-firing a still that is already the last cue on its
layer, and it says so in the failure rather than guessing.

**A cue always plays on its own layer, and nothing here can change that.**
ProVideoPlayer's layer-addressed trigger endpoint accepts a layer and ignores it:
three different empty layers were each sent a different cue and all three cues
appeared on the cue's own configured layer, leaving the named layers empty. Three
targets rather than one rules out the alternative that one layer happened to
refuse one piece of media. So Stage offers no "fire this cue onto that layer"
action — it would change what is on screen and then correctly report that it had
not done what was asked. Which layer a cue plays on is set in ProVideoPlayer.

Two more things ship unverified against a real instance, both safe because they
confirm themselves: clearing a layer that is holding content, and clearing the
whole workspace. So does reading a hidden, muted or part-faded layer back — every
layer observed live was visible, unmuted and fully opaque.

Clearing a layer that is already empty reports success. That is deliberate: the
action's promise is "this layer now holds nothing", not "I removed something".

**Test connection checks the SHAPE of the answer, not just that one came back.**
The documentation port answers 200 with JSON, so a check that only looked for a
200 would confirm the wrong port as working — the one control that exists to
catch that mistake. A response that is not a workspace is reported as such, and
names the likely cause.

One limit that cannot be closed through this API: on a layer whose playlist
auto-advances, the cue can change on its own between the command and the
read-back, so a trigger that did nothing could be confirmed by an advance that
would have happened anyway. The confirmation is strong on a layer that does not
auto-advance and only suggestive on one that does.
